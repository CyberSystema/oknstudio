"""
OKN Analytics Pipeline — Data Ingestion Layer
==============================================
Normalizes CSV/JSON exports from all platforms into a unified DataFrame.

Each platform has its own export format. This module handles:
1. Auto-detecting file format and platform
2. Parsing platform-specific column names
3. Normalizing to the unified schema (see config.UNIFIED_SCHEMA)
4. Merging with historical data
5. Deduplication
"""

import pandas as pd
import numpy as np
import json
import logging
from pathlib import Path
from datetime import datetime
from typing import Optional

from config import (
    PLATFORM_DIRS, HISTORY_DIR, CONTENT_TYPE_MAP,
    UNIFIED_SCHEMA, TIMEZONE, TIMELINE, to_kst, ensure_dirs,
)

logger = logging.getLogger("okn.ingest")


# ══════════════════════════════════════════════
# MAIN INGESTION FUNCTION
# ══════════════════════════════════════════════

def ingest_all() -> pd.DataFrame:
    """
    Ingest data from all platforms, normalize, merge with history,
    and return a unified DataFrame.
    """
    ensure_dirs()
    frames = []

    for platform, data_dir in PLATFORM_DIRS.items():
        logger.info(f"📥 Ingesting {platform} data from {data_dir}")
        try:
            df = ingest_platform(platform, data_dir)
            if df is not None and not df.empty:
                frames.append(df)
                logger.info(f"   ✅ {platform}: {len(df)} posts ingested")
            else:
                logger.warning(f"   ⚠️  {platform}: No new data found")
        except Exception as e:
            logger.error(f"   ❌ {platform}: Ingestion failed — {e}")

    if not frames:
        logger.warning("No data ingested from any platform.")
        return pd.DataFrame()

    # Combine all platforms
    unified = pd.concat(frames, ignore_index=True)

    # Merge with historical data
    unified = merge_with_history(unified)

    # Final cleanup
    unified = cleanup(unified)

    # Save updated history
    save_history(unified)

    logger.info(f"📊 Total unified dataset: {len(unified)} posts across {unified['platform'].nunique()} platforms")
    return unified


def ingest_platform(platform: str, data_dir: Path) -> Optional[pd.DataFrame]:
    """Ingest all CSV/JSON files from a platform directory."""
    files = list(data_dir.glob("*.csv")) + list(data_dir.glob("*.json")) + list(data_dir.glob("*.xlsx"))

    if not files:
        return None

    # Account-level files to skip (handled by ingest_account.py / ingest_tiktok.py)
    ACCOUNT_FILES = {
        # Instagram account exports
        "follows.csv", "reach.csv", "views.csv", "visits.csv",
        "interactions.csv", "link_clicks.csv", "link clicks.csv", "audience.csv",
        # TikTok account exports
        "overview.csv", "viewers.csv", "followerhistory.csv",
        "followeractivity.csv", "followergender.csv",
        "followertopterritories.csv",
    }

    frames = []
    for f in files:
        if f.name.startswith(".") or f.name == "template.csv":
            continue
        if f.name.lower() in ACCOUNT_FILES:
            continue  # Handled by account-level ingester
        try:
            df = parse_file(f, platform)
            if df is not None and not df.empty:
                frames.append(df)
        except Exception as e:
            logger.warning(f"   Could not parse {f.name}: {e}")

    if not frames:
        return None

    return pd.concat(frames, ignore_index=True)


def parse_file(filepath: Path, platform: str) -> Optional[pd.DataFrame]:
    """Parse a single file based on its extension."""
    ext = filepath.suffix.lower()

    if ext == ".csv":
        # Try different encodings
        for encoding in ["utf-8", "utf-8-sig", "cp949", "euc-kr", "latin-1"]:
            try:
                df = pd.read_csv(filepath, encoding=encoding)
                break
            except (UnicodeDecodeError, pd.errors.ParserError):
                continue
        else:
            logger.warning(f"   Could not decode {filepath.name}")
            return None
    elif ext == ".json":
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
        df = pd.json_normalize(data) if isinstance(data, (list, dict)) else None
        if df is None:
            return None
    elif ext == ".xlsx":
        df = pd.read_excel(filepath, engine="openpyxl")
    else:
        return None

    # Route to platform-specific normalizer
    normalizer = NORMALIZERS.get(platform)
    if normalizer:
        return normalizer(df, filepath)
    else:
        logger.warning(f"   No normalizer for platform: {platform}")
        return None


# ══════════════════════════════════════════════
# PLATFORM-SPECIFIC NORMALIZERS
# ══════════════════════════════════════════════

def normalize_instagram(df: pd.DataFrame, filepath: Path) -> pd.DataFrame:
    """
    Normalize Instagram export from Meta Business Suite.
    
    Real Meta Business Suite CSV export columns (verified):
    Post ID, Account ID, Account username, Account name, Description,
    Duration (sec), Publish time, Permalink, Post type, Data comment,
    Date, Views, Reach, Likes, Shares, Follows, Comments, Saves
    
    Post types: "IG carousel", "IG reel", "IG image", "IG story"
    Publish time format: "MM/DD/YYYY HH:MM"
    Date column always says "Lifetime" for aggregate stats
    Encoding: UTF-8 BOM (utf-8-sig)
    """
    col_map = build_column_map(df.columns, {
        "post_id":         ["post id", "post_id", "id", "content id"],
        "content_type":    ["post type", "type", "content type", "media type", "media_type"],
        "published_at":    ["publish time", "published", "publish date", "created",
                            "date posted", "post date"],
        "title":           ["description", "caption", "title", "post caption", "text"],
        "permalink":       ["permalink", "post url", "url", "link"],
        "duration_sec":    ["duration (sec)", "duration", "video duration",
                            "duration (seconds)", "duration_sec"],
        "reach":           ["reach", "accounts reached"],
        "views":           ["views", "video views", "plays", "video plays", "impressions"],
        "likes":           ["likes", "like count", "reactions"],
        "comments":        ["comments", "comment count"],
        "shares":          ["shares", "share count", "sends"],
        "saves":           ["saves", "save count", "bookmarks"],
        "followers_gained": ["follows", "new followers", "follows from post",
                             "profile follows", "followers gained"],
        "link_clicks":     ["link clicks", "website clicks", "tap link",
                            "website taps", "external link taps"],
    })

    return apply_column_map(df, col_map, "instagram")


def normalize_youtube(df: pd.DataFrame, filepath: Path) -> pd.DataFrame:
    """
    Normalize YouTube Studio export.
    
    YouTube Studio Advanced Mode exports include:
    - Content tab: Video title, Published, Views, Watch time, Impressions, CTR
    - Engagement: Likes, Comments, Shares, Subscribers gained
    """
    col_map = build_column_map(df.columns, {
        "post_id":         ["video id", "video_id", "id", "content"],
        "content_type":    ["type", "content type", "video type"],
        "published_at":    ["published", "publish date", "date", "upload date",
                            "video publish time"],
        "title":           ["video title", "title", "content", "video"],
        "reach":           ["impressions", "reach"],
        "views":           ["views", "video views", "view count"],
        "likes":           ["likes", "like count"],
        "comments":        ["comments", "comment count"],
        "shares":          ["shares", "share count"],
        "saves":           ["saves", "added to playlists"],
        "watch_time_sec":  ["watch time (hours)", "watch time", "total watch time"],
        "avg_watch_sec":   ["average view duration", "avg view duration",
                            "average watch time"],
        "followers_gained": ["subscribers", "subscribers gained", "subs gained"],
        "link_clicks":     ["card clicks", "end screen clicks"],
    })

    result = apply_column_map(df, col_map, "youtube")

    # YouTube exports watch time in hours — convert to seconds
    if "watch_time_sec" in result.columns:
        # Check if values seem like hours (small numbers) vs seconds (large)
        mean_val = result["watch_time_sec"].mean()
        if mean_val < 1000:  # Likely in hours
            result["watch_time_sec"] = (result["watch_time_sec"] * 3600).astype(int)

    return result


def normalize_facebook(df: pd.DataFrame, filepath: Path) -> pd.DataFrame:
    """
    Normalize Facebook Page Insights export from Meta Business Suite.
    """
    col_map = build_column_map(df.columns, {
        "post_id":         ["post id", "post_id", "id"],
        "content_type":    ["type", "post type", "content type"],
        "published_at":    ["date", "published", "created", "post date",
                            "publish time"],
        "title":           ["post message", "message", "title", "description",
                            "caption"],
        "reach":           ["reach", "post reach", "impressions",
                            "lifetime post total reach"],
        "views":           ["video views", "views"],
        "likes":           ["reactions", "likes", "like count",
                            "lifetime post total reactions"],
        "comments":        ["comments", "comment count",
                            "lifetime post total comments"],
        "shares":          ["shares", "share count",
                            "lifetime post total shares"],
        "link_clicks":     ["link clicks", "post clicks",
                            "lifetime post total clicks"],
    })

    return apply_column_map(df, col_map, "facebook")


def normalize_tiktok(df: pd.DataFrame, filepath: Path) -> pd.DataFrame:
    """
    Normalize TikTok content export (Content.csv).
    
    Delegates to the dedicated TikTok ingestion module for proper
    Greek date handling and TikTok-specific column mapping.
    Also supports manual template CSV as a fallback.
    """
    # Check if this is a real TikTok Content.csv (has "Video title" or "Video link")
    cols_lower = [c.lower().strip() for c in df.columns]
    is_content_csv = any(c in cols_lower for c in ["video title", "video link", "total views"])

    if is_content_csv:
        # Use the dedicated TikTok content ingester
        from ingest_tiktok import ingest_tiktok_content
        result = ingest_tiktok_content(filepath.parent)
        return result if result is not None else pd.DataFrame()

    # Fallback: manual template format
    col_map = build_column_map(df.columns, {
        "post_id":         ["video id", "id", "post_id", "video_id"],
        "content_type":    ["type"],
        "published_at":    ["date", "post date", "published", "created",
                            "date posted"],
        "title":           ["caption", "title", "description", "video description"],
        "reach":           ["total views", "views", "video views", "reach"],
        "views":           ["total views", "views", "video views"],
        "likes":           ["likes", "like count", "diggs"],
        "comments":        ["comments", "comment count"],
        "shares":          ["shares", "share count"],
        "saves":           ["saves", "favorites", "bookmarks"],
        "watch_time_sec":  ["total play time", "total watch time"],
        "avg_watch_sec":   ["average watch time", "avg watch time"],
        "followers_gained": ["new followers", "followers gained"],
    })

    result = apply_column_map(df, col_map, "tiktok")

    # Default content type for TikTok
    if "content_type" in result.columns:
        result["content_type"] = result["content_type"].fillna("short_video")
    else:
        result["content_type"] = "short_video"

    return result


# Register normalizers
NORMALIZERS = {
    "instagram": normalize_instagram,
    "youtube": normalize_youtube,
    "facebook": normalize_facebook,
    "tiktok": normalize_tiktok,
}


# ══════════════════════════════════════════════
# COLUMN MAPPING ENGINE
# ══════════════════════════════════════════════

def build_column_map(actual_columns: pd.Index, field_candidates: dict) -> dict:
    """
    Fuzzy-match actual CSV columns to our unified schema fields.
    
    field_candidates: {unified_field: [list of possible column names]}
    Returns: {unified_field: actual_column_name} for matched fields
    """
    actual_lower = {col.lower().strip(): col for col in actual_columns}
    col_map = {}

    for field, candidates in field_candidates.items():
        for candidate in candidates:
            candidate_lower = candidate.lower().strip()
            if candidate_lower in actual_lower:
                col_map[field] = actual_lower[candidate_lower]
                break

    return col_map


def apply_column_map(df: pd.DataFrame, col_map: dict, platform: str) -> pd.DataFrame:
    """
    Apply column mapping to create a unified DataFrame.
    """
    result = pd.DataFrame()

    # Map found columns
    for unified_field, actual_col in col_map.items():
        result[unified_field] = df[actual_col]

    # Set platform
    result["platform"] = platform

    # Generate post_id if not found
    if "post_id" not in result.columns or result["post_id"].isna().all():
        result["post_id"] = [
            f"{platform}_{i}_{datetime.now().strftime('%Y%m%d')}"
            for i in range(len(result))
        ]

    # Ensure post_id is string (Meta exports use large integers)
    result["post_id"] = result["post_id"].astype(str)

    # Normalize content type
    if "content_type" in result.columns:
        result["content_type"] = (
            result["content_type"]
            .astype(str)
            .str.lower()
            .str.strip()
            .map(CONTENT_TYPE_MAP)
            .fillna("other")
        )
    else:
        result["content_type"] = "other"

    # Parse dates — handle multiple formats including Meta's "MM/DD/YYYY HH:MM"
    if "published_at" in result.columns:
        # Try Meta Business Suite format first (MM/DD/YYYY HH:MM)
        parsed = pd.to_datetime(
            result["published_at"],
            format="%m/%d/%Y %H:%M",
            errors="coerce",
        )
        # Fall back to general parsing for anything that didn't match
        mask_failed = parsed.isna() & result["published_at"].notna()
        if mask_failed.any():
            parsed[mask_failed] = pd.to_datetime(
                result.loc[mask_failed, "published_at"],
                errors="coerce",
            )
        # Instagram exports from Meta Business Suite are in PST (America/Los_Angeles)
        result["published_at"] = parsed.dt.tz_localize("America/Los_Angeles", ambiguous="NaT", nonexistent="NaT")
        result["published_at"] = to_kst(result["published_at"])
    else:
        result["published_at"] = pd.NaT

    # Handle permalink (keep as-is, fill missing)
    if "permalink" not in result.columns:
        result["permalink"] = ""
    result["permalink"] = result["permalink"].fillna("").astype(str)

    # Handle duration
    if "duration_sec" not in result.columns:
        result["duration_sec"] = 0
    result["duration_sec"] = pd.to_numeric(result["duration_sec"], errors="coerce").fillna(0).astype(int)

    # Fill missing numeric columns with 0
    numeric_fields = [
        "reach", "views", "likes", "comments", "shares", "saves",
        "watch_time_sec", "avg_watch_sec", "followers_gained", "link_clicks",
    ]
    for field in numeric_fields:
        if field not in result.columns:
            result[field] = 0
        else:
            result[field] = pd.to_numeric(result[field], errors="coerce").fillna(0).astype(int)

    # Calculate engagement
    result["engagement_total"] = (
        result["likes"] + result["comments"] + result["shares"] + result["saves"]
    )
    result["engagement_rate"] = np.where(
        result["reach"] > 0,
        result["engagement_total"] / result["reach"],
        0.0,
    )

    # Fill title
    if "title" not in result.columns:
        result["title"] = ""
    result["title"] = result["title"].fillna("").astype(str).str[:200]

    return result


# ══════════════════════════════════════════════
# HISTORY MANAGEMENT
# ══════════════════════════════════════════════

def merge_with_history(new_data: pd.DataFrame) -> pd.DataFrame:
    """Merge new data with historical data. Keeps latest metrics for each post."""
    history_file = HISTORY_DIR / "unified_history.parquet"
    csv_fallback = HISTORY_DIR / "unified_history.csv"

    history = None
    if history_file.exists():
        try:
            history = pd.read_parquet(history_file)
            logger.info(f"📂 Loaded {len(history)} historical records (parquet)")
        except Exception as e:
            logger.warning(f"Could not load parquet: {e}")
    
    if history is None and csv_fallback.exists():
        try:
            history = pd.read_csv(csv_fallback)
            # CSV loads published_at as strings — convert to datetime
            if "published_at" in history.columns:
                history["published_at"] = pd.to_datetime(
                    history["published_at"], errors="coerce", utc=True
                )
            logger.info(f"📂 Loaded {len(history)} historical records (csv fallback)")
        except Exception as e:
            logger.warning(f"Could not load CSV fallback: {e}")

    if history is not None:
        # Tag new data with ingestion timestamp so dedup always picks the freshest
        new_data = new_data.copy()
        new_data["_ingested_at"] = pd.Timestamp.now(tz="UTC")
        if "_ingested_at" not in history.columns:
            history["_ingested_at"] = pd.Timestamp("2020-01-01", tz="UTC")

        combined = pd.concat([history, new_data], ignore_index=True)
    else:
        combined = new_data.copy()
        combined["_ingested_at"] = pd.Timestamp.now(tz="UTC")

    # Deduplicate — keep the LATEST ingested version of each post (freshest metrics)
    before = len(combined)
    combined = combined.sort_values("_ingested_at", ascending=True)
    combined = combined.drop_duplicates(
        subset=["post_id", "platform"],
        keep="last",
    )
    dupes = before - len(combined)
    if dupes > 0:
        logger.info(f"   Merged: {dupes} older records updated with fresh metrics")

    # Drop the internal column before returning
    combined = combined.drop(columns=["_ingested_at"], errors="ignore")

    return combined


def save_history(df: pd.DataFrame):
    """Save the unified dataset as historical data."""
    history_file = HISTORY_DIR / "unified_history.parquet"
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)

    # Also save a CSV backup for easy inspection
    csv_backup = HISTORY_DIR / "unified_history.csv"

    try:
        df.to_parquet(history_file, index=False)
        df.to_csv(csv_backup, index=False)
        logger.info(f"💾 History saved: {len(df)} records → {history_file}")
    except Exception as e:
        # If parquet fails (e.g., missing pyarrow), fall back to CSV only
        logger.warning(f"Parquet save failed ({e}), saving CSV only")
        df.to_csv(csv_backup, index=False)


# ══════════════════════════════════════════════
# CLEANUP & VALIDATION
# ══════════════════════════════════════════════

def cleanup(df: pd.DataFrame) -> pd.DataFrame:
    """Final data cleanup and validation."""
    # Sort by date
    df = df.sort_values("published_at", ascending=False).reset_index(drop=True)

    # Filter by platform start dates (e.g., TikTok created Jan 6, 2026)
    start_dates = TIMELINE.get("platform_start", {})
    for platform, start_str in start_dates.items():
        start_ts = pd.Timestamp(start_str, tz="Asia/Seoul")
        mask = (df["platform"] == platform) & (df["published_at"] < start_ts)
        n_removed = mask.sum()
        if n_removed > 0:
            logger.info(f"   🗑️  Removed {n_removed} {platform} posts before {start_str}")
            df = df[~mask]

    # Ensure no negative values in metrics
    numeric_cols = ["reach", "views", "likes", "comments", "shares",
                    "saves", "engagement_total", "watch_time_sec"]
    for col in numeric_cols:
        if col in df.columns:
            df[col] = df[col].clip(lower=0)

    # Recalculate engagement rate
    df["engagement_rate"] = np.where(
        df["reach"] > 0,
        df["engagement_total"] / df["reach"],
        0.0,
    )

    # Cap engagement rate at 1.0 (100%) — anything higher is likely a data error
    df["engagement_rate"] = df["engagement_rate"].clip(upper=1.0)

    # Strip problematic Unicode characters from captions (breaks WeasyPrint)
    if "title" in df.columns:
        df["title"] = df["title"].fillna("").str.replace("\u2028", " ").str.replace("\u2029", " ")

    return df


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    df = ingest_all()
    if not df.empty:
        print(f"\n✅ Ingestion complete: {len(df)} posts")
        print(df.groupby("platform").size())
    else:
        print("\n⚠️  No data to ingest. Add CSV exports to data/ folders.")
