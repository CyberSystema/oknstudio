"""
OKN Analytics Pipeline — TikTok Data Ingestion
================================================
Parses TikTok Studio CSV exports.

Key challenges handled:
- Dates in Greek (e.g., "15 Ιανουαρίου", "3 Μαρτίου")
- Content-level data (Content.csv) — per-video metrics
- Account-level data (Overview, Viewers, FollowerHistory, etc.)
- "undefined" values in some rows
- Country codes (GR, US, KR) → full English names

Files:
  Content-level:
    Content.csv → Individual video performance (normalizes to unified schema)

  Account-level:
    Overview.csv         → Daily views, profile views, likes, comments, shares
    Viewers.csv          → Daily total/new/returning viewers
    FollowerHistory.csv  → Daily follower count and delta
    FollowerActivity.csv → Hourly active followers (best time to post)
    FollowerGender.csv   → Gender distribution
    FollowerTopTerritories.csv → Country distribution (ISO codes)
"""

import pandas as pd
import numpy as np
import logging
import json
import re
from pathlib import Path
from typing import Dict, Any, Optional, Tuple
from datetime import datetime

logger = logging.getLogger("okn.ingest_tiktok")


# ══════════════════════════════════════════════
# GREEK DATE PARSING
# ══════════════════════════════════════════════

GREEK_MONTHS = {
    "ιανουαρίου": 1, "ιανουάριου": 1,
    "φεβρουαρίου": 2, "φεβρουάριου": 2,
    "μαρτίου": 3, "μάρτιου": 3,
    "απριλίου": 4, "απρίλιου": 4,
    "μαΐου": 5, "μαίου": 5,
    "ιουνίου": 6, "ιούνιου": 6,
    "ιουλίου": 7, "ιούλιου": 7,
    "αυγούστου": 8,
    "σεπτεμβρίου": 9, "σεπτέμβριου": 9,
    "οκτωβρίου": 10, "οκτώβριου": 10,
    "νοεμβρίου": 11, "νοέμβριου": 11,
    "δεκεμβρίου": 12, "δεκέμβριου": 12,
}

# Country code → English name mapping
COUNTRY_CODES = {
    "GR": "Greece", "KR": "South Korea", "US": "United States",
    "RO": "Romania", "CY": "Cyprus", "DE": "Germany",
    "AU": "Australia", "GB": "United Kingdom", "CA": "Canada",
    "JP": "Japan", "FR": "France", "IT": "Italy", "ES": "Spain",
    "NL": "Netherlands", "BR": "Brazil", "IN": "India",
    "RS": "Serbia", "BG": "Bulgaria", "ET": "Ethiopia",
    "PH": "Philippines", "EG": "Egypt", "ZA": "South Africa",
    "RU": "Russia", "UA": "Ukraine", "PL": "Poland",
    "GE": "Georgia", "LB": "Lebanon", "Others": "Others",
}


def parse_greek_date(date_str: str, fallback_year: int = None) -> Optional[pd.Timestamp]:
    """
    Parse a Greek date string like '15 Ιανουαρίου' or '3 Μαρτίου'.
    Since TikTok exports don't include year, we infer it.
    """
    if not isinstance(date_str, str):
        return None

    date_str = date_str.strip()

    # Try ISO format first (in case some fields use it)
    try:
        return pd.Timestamp(date_str)
    except Exception:
        pass

    # Parse Greek format: "DD MonthName"
    parts = date_str.split()
    if len(parts) < 2:
        return None

    try:
        day = int(parts[0])
    except ValueError:
        return None

    month_str = parts[1].lower().strip()
    month = GREEK_MONTHS.get(month_str)

    if month is None:
        # Try partial matching
        for key, val in GREEK_MONTHS.items():
            if month_str.startswith(key[:4]) or key.startswith(month_str[:4]):
                month = val
                break

    if month is None:
        return None

    # Infer year — TikTok exports cover ~60 days
    if fallback_year:
        year = fallback_year
    else:
        now = datetime.now()
        year = now.year
        # If month is far in the future, it's probably last year
        if month > now.month + 2:
            year -= 1

    try:
        return pd.Timestamp(year=year, month=month, day=day)
    except ValueError:
        return None


def parse_greek_dates_series(series: pd.Series, fallback_year: int = None) -> pd.Series:
    """
    Parse an entire Series of Greek date strings with smart year inference.
    
    Two modes:
    - SHORT series (<60 rows, e.g. Content.csv): dates are NOT chronological,
      all from recent months. Use simple year inference per-date.
    - LONG series (60+ rows, e.g. Viewers.csv): dates ARE chronological and
      may wrap across years (March 2025 → March 2026). Walk the sequence
      and detect year boundaries.
    """
    if series.empty:
        return series

    # First pass: parse all dates as (month, day) tuples without year
    parsed_md = []
    for val in series:
        if not isinstance(val, str):
            parsed_md.append(None)
            continue
        val = val.strip().strip('"')
        try:
            ts = pd.Timestamp(val)
            parsed_md.append((ts.month, ts.day, ts.year))
            continue
        except Exception:
            pass
        parts = val.split()
        if len(parts) < 2:
            parsed_md.append(None)
            continue
        try:
            day = int(parts[0])
        except ValueError:
            parsed_md.append(None)
            continue
        month_str = parts[1].lower().strip()
        month = GREEK_MONTHS.get(month_str)
        if month is None:
            for key, m_val in GREEK_MONTHS.items():
                if month_str.startswith(key[:4]) or key.startswith(month_str[:4]):
                    month = m_val
                    break
        if month is None:
            parsed_md.append(None)
            continue
        parsed_md.append((month, day, None))

    valid_entries = [(i, m, d, y) for i, md in enumerate(parsed_md)
                     if md is not None for m, d, y in [md]]

    if not valid_entries:
        return pd.Series([None] * len(series), index=series.index)

    now = datetime.now()
    end_year = fallback_year or now.year

    # Decide mode based on series length
    is_long_chronological = len(valid_entries) >= 60

    results = [None] * len(series)

    if is_long_chronological:
        # LONG MODE: Walk sequence, detect year wraps (Dec→Jan)
        year_wraps = 0
        for j in range(len(valid_entries) - 1, 0, -1):
            curr_month = valid_entries[j][1]
            prev_month = valid_entries[j - 1][1]
            if curr_month < prev_month - 1:
                year_wraps += 1

        start_year = end_year - year_wraps
        current_year = start_year
        prev_month = None

        for idx, month, day, explicit_year in valid_entries:
            if explicit_year is not None:
                try:
                    results[idx] = pd.Timestamp(year=explicit_year, month=month, day=day)
                except ValueError:
                    pass
                prev_month = month
                continue
            if prev_month is not None and month < prev_month - 1:
                current_year += 1
            try:
                results[idx] = pd.Timestamp(year=current_year, month=month, day=day)
            except ValueError:
                pass
            prev_month = month
    else:
        # SHORT MODE: All dates are recent. Assign year per-date individually.
        # If month is far ahead of current month, it's from last year.
        for idx, month, day, explicit_year in valid_entries:
            if explicit_year is not None:
                try:
                    results[idx] = pd.Timestamp(year=explicit_year, month=month, day=day)
                except ValueError:
                    pass
                continue
            year = end_year
            if month > now.month + 2:
                year -= 1
            try:
                results[idx] = pd.Timestamp(year=year, month=month, day=day)
            except ValueError:
                pass

    result = pd.Series(results, index=series.index)
    result = result.apply(lambda x: x.tz_localize("Asia/Seoul") if x is not None and not pd.isna(x) and x.tzinfo is None else x)
    return result


# ══════════════════════════════════════════════
# CONTENT-LEVEL INGESTION (Content.csv)
# ══════════════════════════════════════════════

def ingest_tiktok_content(tiktok_dir: Path) -> Optional[pd.DataFrame]:
    """
    Parse Content.csv into the unified post-level schema.

    TikTok Content.csv columns:
    Time, Video title, Video link, Post time, Total likes,
    Total comments, Total shares, Total views
    """
    content_path = None
    for name in ["Content.csv", "content.csv"]:
        p = tiktok_dir / name
        if p.exists():
            content_path = p
            break

    if content_path is None:
        return None

    df = _read_csv_safe(content_path)
    if df is None or df.empty:
        return None

    logger.info(f"   📄 TikTok Content: {len(df)} videos found")

    result = pd.DataFrame()

    # Map columns
    col_map = {
        "post_id": _find_col(df, ["video link", "video_link"]),
        "title": _find_col(df, ["video title", "video_title"]),
        "permalink": _find_col(df, ["video link", "video_link"]),
        "published_at": _find_col(df, ["post time", "post_time"]),
        "likes": _find_col(df, ["total likes", "total_likes"]),
        "comments": _find_col(df, ["total comments", "total_comments"]),
        "shares": _find_col(df, ["total shares", "total_shares"]),
        "views": _find_col(df, ["total views", "total_views"]),
    }

    for field, col in col_map.items():
        if col and col in df.columns:
            result[field] = df[col]

    # Set platform and content type
    result["platform"] = "tiktok"
    result["content_type"] = "short_video"

    # Generate post_id from video link if available
    if "post_id" in result.columns:
        result["post_id"] = result["post_id"].astype(str).apply(
            lambda x: x.split("/")[-1] if "/" in str(x) else x
        )
    else:
        result["post_id"] = [f"tt_{i:04d}" for i in range(len(result))]

    # Parse Greek dates — returns KST-localized timestamps
    if "published_at" in result.columns:
        result["published_at"] = parse_greek_dates_series(result["published_at"])
        result["published_at"] = pd.to_datetime(result["published_at"], errors="coerce", utc=True)
        # Convert to KST (already KST from parser, but ensure consistency)
        if result["published_at"].notna().any():
            from config import to_kst
            result["published_at"] = to_kst(result["published_at"])

    # Numeric columns
    for col in ["likes", "comments", "shares", "views"]:
        if col in result.columns:
            result[col] = pd.to_numeric(result[col], errors="coerce").fillna(0).astype(int)

    # TikTok uses views as both reach and views
    result["reach"] = result.get("views", pd.Series(0, index=result.index))

    # Fill missing columns
    for col in ["saves", "watch_time_sec", "avg_watch_sec", "followers_gained",
                "link_clicks", "duration_sec"]:
        result[col] = 0

    # Engagement
    result["engagement_total"] = (
        result.get("likes", 0) + result.get("comments", 0)
        + result.get("shares", 0) + result.get("saves", 0)
    )
    result["engagement_rate"] = np.where(
        result["reach"] > 0,
        result["engagement_total"] / result["reach"],
        0.0,
    )

    # Title: truncate
    if "title" in result.columns:
        result["title"] = result["title"].fillna("").astype(str).str[:200]

    return result


# ══════════════════════════════════════════════
# ACCOUNT-LEVEL INGESTION
# ══════════════════════════════════════════════

def ingest_tiktok_account(tiktok_dir: Path) -> Dict[str, Any]:
    """
    Parse TikTok account-level CSVs (Overview, Viewers, FollowerHistory,
    FollowerActivity, FollowerGender, FollowerTopTerritories).

    Returns same structure as ingest_account_data():
        {"daily": DataFrame, "demographics": dict}
    """
    daily_frames = {}
    demographics = {}

    # ── Overview.csv → daily views, profile views, likes, comments, shares ──
    overview = _load_tiktok_timeseries(tiktok_dir, ["Overview.csv", "overview.csv"])
    if overview is not None:
        col_map = {
            "views": _find_col(overview, ["video views", "video_views"]),
            "visits": _find_col(overview, ["profile views", "profile_views"]),
            "likes": _find_col(overview, ["likes"]),
            "comments": _find_col(overview, ["comments"]),
            "shares": _find_col(overview, ["shares"]),
        }
        for metric, col in col_map.items():
            if col and col in overview.columns:
                series = pd.to_numeric(overview[col], errors="coerce").fillna(0).astype(int)
                series.index = overview["_date"]
                series.name = metric
                daily_frames[metric] = series
        # Create interactions as sum
        if all(k in daily_frames for k in ["likes", "comments", "shares"]):
            interactions = daily_frames["likes"] + daily_frames["comments"] + daily_frames["shares"]
            interactions.name = "interactions"
            daily_frames["interactions"] = interactions
        logger.info(f"   📈 TikTok Overview: {len(overview)} days")

    # ── Viewers.csv → daily viewers ──
    viewers = _load_tiktok_timeseries(tiktok_dir, ["Viewers.csv", "viewers.csv"])
    if viewers is not None:
        for src_col, dest in [
            (["total viewers", "total_viewers"], "total_viewers"),
            (["new viewers", "new_viewers"], "new_viewers"),
            (["returning viewers", "returning_viewers"], "returning_viewers"),
        ]:
            col = _find_col(viewers, src_col)
            if col and col in viewers.columns:
                series = pd.to_numeric(viewers[col], errors="coerce").fillna(0).astype(int)
                series.index = viewers["_date"]
                series.name = dest
                daily_frames[dest] = series
        logger.info(f"   📈 TikTok Viewers: {len(viewers)} days")

    # ── FollowerHistory.csv → daily followers ──
    fh = _load_tiktok_timeseries(tiktok_dir, ["FollowerHistory.csv", "followerhistory.csv"])
    if fh is not None:
        fol_col = _find_col(fh, ["followers"])
        delta_col = _find_col(fh, ["difference in followers from previous day",
                                    "difference", "diff"])
        if fol_col and fol_col in fh.columns:
            series = pd.to_numeric(fh[fol_col], errors="coerce").fillna(0).astype(int)
            series.index = fh["_date"]
            series.name = "follower_count"
            daily_frames["follower_count"] = series

        if delta_col and delta_col in fh.columns:
            series = pd.to_numeric(fh[delta_col], errors="coerce").fillna(0).astype(int)
            series.index = fh["_date"]
            series.name = "follows"
            daily_frames["follows"] = series
        logger.info(f"   📈 TikTok Followers: {len(fh)} days (10 → 3,117)")

    # ── FollowerGender.csv → demographics ──
    gender = _read_csv_from_dir(tiktok_dir, ["FollowerGender.csv", "followergender.csv"])
    if gender is not None:
        gender_col = _find_col(gender, ["gender"])
        dist_col = _find_col(gender, ["distribution"])
        if gender_col and dist_col:
            demographics["gender"] = [
                {
                    "gender": str(row[gender_col]),
                    "percentage": round(float(row[dist_col]) * 100, 1),
                }
                for _, row in gender.iterrows()
                if pd.notna(row.get(dist_col))
            ]
            logger.info(f"   👤 TikTok Gender: {len(demographics['gender'])} groups")

    # ── FollowerTopTerritories.csv → demographics ──
    terr = _read_csv_from_dir(tiktok_dir, ["FollowerTopTerritories.csv",
                                            "followertopterritories.csv"])
    if terr is not None:
        terr_col = _find_col(terr, ["top territories", "top_territories", "territory"])
        dist_col = _find_col(terr, ["distribution"])
        if terr_col and dist_col:
            demographics["countries"] = [
                {
                    "country": COUNTRY_CODES.get(str(row[terr_col]).strip(),
                                                  str(row[terr_col]).strip()),
                    "code": str(row[terr_col]).strip(),
                    "percentage": round(float(row[dist_col]) * 100, 1),
                }
                for _, row in terr.iterrows()
                if pd.notna(row.get(dist_col))
            ]
            logger.info(f"   🌍 TikTok Territories: {len(demographics['countries'])} regions")

    # ── FollowerActivity.csv → best posting times ──
    activity = _read_csv_from_dir(tiktok_dir, ["FollowerActivity.csv",
                                                "followeractivity.csv"])
    if activity is not None:
        hour_col = _find_col(activity, ["hour"])
        active_col = _find_col(activity, ["active followers", "active_followers"])
        if hour_col and active_col:
            # Aggregate average active followers by hour across all days
            activity["_hour"] = pd.to_numeric(activity[hour_col], errors="coerce")
            activity["_active"] = pd.to_numeric(activity[active_col], errors="coerce")
            hourly_avg = activity.groupby("_hour")["_active"].mean().round(0).astype(int)
            demographics["active_hours"] = {
                int(h): int(v) for h, v in hourly_avg.items() if v > 0
            }
            # Find peak hours
            top_hours = hourly_avg.nlargest(3)
            demographics["peak_hours"] = [
                {"hour": int(h), "avg_active": int(v)}
                for h, v in top_hours.items()
            ]
            logger.info(f"   🕐 TikTok Activity: peak hours = {[h['hour'] for h in demographics['peak_hours']]}")

    # ── Build unified daily DataFrame ──
    daily = pd.DataFrame()
    if daily_frames:
        all_dates = set()
        for s in daily_frames.values():
            all_dates.update(s.dropna().index)

        if all_dates:
            valid_dates = [d for d in all_dates if pd.notna(d)]
            if valid_dates:
                date_range = pd.date_range(min(valid_dates), max(valid_dates), freq="D")
                daily = pd.DataFrame(index=date_range)
                daily.index.name = "date"

                for metric, series in daily_frames.items():
                    daily[metric] = series.reindex(daily.index).fillna(0).astype(int)

                # Rolling averages
                for col in ["views", "follows", "interactions", "visits"]:
                    if col in daily.columns:
                        daily[f"{col}_7d_avg"] = daily[col].rolling(7, min_periods=1).mean().round(1)

    return {
        "daily": daily,
        "demographics": demographics,
    }


# ══════════════════════════════════════════════
# HELPERS
# ══════════════════════════════════════════════

def _read_csv_safe(filepath: Path) -> Optional[pd.DataFrame]:
    """Read a CSV with multiple encoding fallbacks."""
    for enc in ["utf-8-sig", "utf-8", "utf-16", "cp1253", "latin-1"]:
        try:
            return pd.read_csv(filepath, encoding=enc)
        except Exception:
            continue
    logger.warning(f"   Could not read {filepath.name}")
    return None


def _read_csv_from_dir(directory: Path, filenames: list) -> Optional[pd.DataFrame]:
    """Try to read a CSV from a list of possible filenames."""
    for name in filenames:
        p = directory / name
        if p.exists():
            return _read_csv_safe(p)
    return None


def _load_tiktok_timeseries(directory: Path, filenames: list) -> Optional[pd.DataFrame]:
    """Load a TikTok timeseries CSV and parse Greek dates."""
    df = _read_csv_from_dir(directory, filenames)
    if df is None or df.empty:
        return None

    date_col = _find_col(df, ["date"])
    if date_col and date_col in df.columns:
        df["_date"] = parse_greek_dates_series(df[date_col])
        df = df.dropna(subset=["_date"])
        df["_date"] = pd.to_datetime(df["_date"])
    else:
        return None

    return df


def _find_col(df: pd.DataFrame, candidates: list) -> Optional[str]:
    """Find a column by name (case-insensitive)."""
    lower_map = {c.lower().strip(): c for c in df.columns}
    for candidate in candidates:
        if candidate.lower().strip() in lower_map:
            return lower_map[candidate.lower().strip()]
    return None
