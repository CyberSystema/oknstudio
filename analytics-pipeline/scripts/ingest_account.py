"""
OKN Analytics Pipeline — Account-Level Data Ingestion
=====================================================
Parses Instagram account-level CSV exports from Meta Business Suite.

These files have a specific format:
- Encoding: UTF-16 with BOM
- Line 1: "sep=," (Excel hint — we skip it)
- Line 2: Metric title (e.g., "Instagram follows")
- Line 3: Header row: Date,"Primary"
- Lines 4+: Data rows: 2025-12-16T00:00:00,"1"

Audience.csv has a different multi-section format with demographics.

Files handled:
- Follows.csv       → Daily new followers
- Interactions.csv  → Daily content interactions (likes+comments+shares+saves)
- Link_clicks.csv   → Daily external link clicks
- Reach.csv         → Daily accounts reached
- Views.csv         → Daily content views (impressions)
- Visits.csv        → Daily profile visits
- Audience.csv      → Demographics (countries, age/gender, cities) + follows
"""

import pandas as pd
import numpy as np
import logging
import io
from pathlib import Path
from typing import Dict, Any, Optional, Tuple

from config import HISTORY_DIR, ensure_dirs

logger = logging.getLogger("okn.ingest_account")


# ══════════════════════════════════════════════
# MAIN ENTRY POINT
# ══════════════════════════════════════════════

def ingest_account_data(platform_dir: Path) -> Dict[str, Any]:
    """
    Ingest all account-level CSV files from an Instagram data directory.

    Returns a dict with:
        "daily"       → pd.DataFrame with columns: date, follows, interactions,
                         link_clicks, reach, views, visits
        "demographics" → dict with countries, age_gender, cities
    """
    ensure_dirs()

    # ── Parse time-series files ──
    metric_files = {
        "follows":      ["Follows.csv", "follows.csv"],
        "interactions":  ["Interactions.csv", "interactions.csv"],
        "link_clicks":   ["Link_clicks.csv", "link_clicks.csv", "Link Clicks.csv", "Link clicks.csv"],
        "reach":         ["Reach.csv", "reach.csv"],
        "views":         ["Views.csv", "views.csv"],
        "visits":        ["Visits.csv", "visits.csv"],
    }

    daily_frames = {}
    for metric, filenames in metric_files.items():
        for fname in filenames:
            fpath = platform_dir / fname
            if fpath.exists():
                series = parse_timeseries_csv(fpath, metric)
                if series is not None and not series.empty:
                    daily_frames[metric] = series
                    logger.info(f"   📈 {metric}: {len(series)} days loaded")
                break

    # Build unified daily DataFrame
    if daily_frames:
        daily = build_daily_dataframe(daily_frames)
    else:
        daily = pd.DataFrame()

    # ── Parse demographics (Audience.csv) ──
    demographics = {}
    for fname in ["Audience.csv", "audience.csv"]:
        fpath = platform_dir / fname
        if fpath.exists():
            demographics = parse_audience_csv(fpath)
            if demographics:
                logger.info(f"   👥 Audience demographics loaded")
            break

    # ── Save to history ──
    if not daily.empty:
        save_account_history(daily, demographics)

    return {
        "daily": daily,
        "demographics": demographics,
    }


# ══════════════════════════════════════════════
# TIME-SERIES CSV PARSER
# ══════════════════════════════════════════════

def read_meta_utf16_csv(filepath: Path) -> Optional[str]:
    """
    Read a Meta Business Suite CSV that uses UTF-16 encoding.
    Returns the decoded text content.
    """
    for encoding in ["utf-16", "utf-16-le", "utf-16-be", "utf-8-sig", "utf-8"]:
        try:
            with open(filepath, "r", encoding=encoding) as f:
                content = f.read()
            return content
        except (UnicodeDecodeError, UnicodeError):
            continue

    logger.warning(f"   Could not decode {filepath.name}")
    return None


def parse_timeseries_csv(filepath: Path, metric_name: str) -> Optional[pd.Series]:
    """
    Parse a Meta Business Suite time-series CSV into a pandas Series.

    Format:
        sep=,
        <Metric Title>
        Date,"Primary"
        2025-12-16T00:00:00,"1"
        ...
    """
    content = read_meta_utf16_csv(filepath)
    if content is None:
        return None

    lines = content.strip().split("\n")

    # Find the header row (Date,"Primary")
    header_idx = None
    for i, line in enumerate(lines):
        stripped = line.strip().replace('"', '')
        if stripped.lower().startswith("date,"):
            header_idx = i
            break

    if header_idx is None:
        logger.warning(f"   Could not find header in {filepath.name}")
        return None

    # Parse from header onwards
    data_text = "\n".join(lines[header_idx:])
    try:
        df = pd.read_csv(io.StringIO(data_text), quotechar='"')
    except Exception as e:
        logger.warning(f"   Parse error in {filepath.name}: {e}")
        return None

    if df.empty or len(df.columns) < 2:
        return None

    # Rename columns
    date_col = df.columns[0]
    value_col = df.columns[1]

    df["date"] = pd.to_datetime(df[date_col], errors="coerce")
    df["value"] = pd.to_numeric(df[value_col], errors="coerce").fillna(0).astype(int)

    df = df.dropna(subset=["date"])
    df = df.set_index("date")["value"]
    df.name = metric_name

    return df.sort_index()


# ══════════════════════════════════════════════
# AUDIENCE / DEMOGRAPHICS PARSER
# ══════════════════════════════════════════════

def parse_audience_csv(filepath: Path) -> Dict[str, Any]:
    """
    Parse the Audience.csv multi-section file.

    Sections:
    - "Top countries" → country names + percentages
    - "Age & gender"  → age ranges × Men/Women percentages
    - "Top cities"    → city names + percentages
    - "Follows"       → daily follows (subset, overlaps with Follows.csv)
    """
    content = read_meta_utf16_csv(filepath)
    if content is None:
        return {}

    lines = content.strip().split("\n")
    # Skip "sep=," line if present
    if lines and lines[0].strip().startswith("sep="):
        lines = lines[1:]

    demographics = {}

    try:
        i = 0
        while i < len(lines):
            line = lines[i].strip().strip('"')

            # ── Top countries ──
            if line.lower() == "top countries" and i + 2 < len(lines):
                countries_raw = _parse_csv_row(lines[i + 1])
                pcts_raw = _parse_csv_row(lines[i + 2])

                demographics["countries"] = [
                    {"country": c.strip().strip('"'), "percentage": _to_float(p)}
                    for c, p in zip(countries_raw, pcts_raw)
                    if c.strip().strip('"')
                ]
                i += 3
                continue

            # ── Age & gender ──
            if line.lower() == "age & gender" and i + 1 < len(lines):
                # Next line is header: ,"Men","Women"
                i += 1  # skip header row
                i += 1  # move to first data row
                age_gender = []
                while i < len(lines):
                    row = _parse_csv_row(lines[i])
                    if not row or not row[0].strip().strip('"'):
                        break
                    first_val = row[0].strip().strip('"')
                    if not any(c.isdigit() for c in first_val):
                        break
                    age_range = first_val
                    men_pct = _to_float(row[1]) if len(row) > 1 else 0
                    women_pct = _to_float(row[2]) if len(row) > 2 else 0
                    age_gender.append({
                        "range": age_range,
                        "men": men_pct,
                        "women": women_pct,
                        "total": round(men_pct + women_pct, 1),
                    })
                    i += 1
                demographics["age_gender"] = age_gender
                continue

            # ── Top cities ──
            if line.lower() == "top cities" and i + 2 < len(lines):
                cities_raw = _parse_csv_row(lines[i + 1])
                pcts_raw = _parse_csv_row(lines[i + 2])

                demographics["cities"] = [
                    {"city": c.strip().strip('"'), "percentage": _to_float(p)}
                    for c, p in zip(cities_raw, pcts_raw)
                    if c.strip().strip('"')
                ]
                i += 3
                continue

            i += 1

    except Exception as e:
        logger.warning(f"   Demographics parsing error: {e}")

    return demographics


def _parse_csv_row(line: str) -> list:
    """Parse a CSV row handling quoted fields with commas."""
    import csv
    reader = csv.reader(io.StringIO(line.strip()))
    for row in reader:
        return row
    return []


def _to_float(val) -> float:
    """Safely convert a value to float."""
    try:
        return float(str(val).strip().replace('"', ''))
    except (ValueError, TypeError):
        return 0.0


# ══════════════════════════════════════════════
# BUILD UNIFIED DAILY DATAFRAME
# ══════════════════════════════════════════════

def build_daily_dataframe(frames: Dict[str, pd.Series]) -> pd.DataFrame:
    """
    Combine individual metric Series into a unified daily DataFrame.
    Missing dates are filled with 0.
    """
    # Find the full date range across all series
    all_dates = set()
    for series in frames.values():
        all_dates.update(series.index)

    if not all_dates:
        return pd.DataFrame()

    date_range = pd.date_range(min(all_dates), max(all_dates), freq="D")

    daily = pd.DataFrame(index=date_range)
    daily.index.name = "date"

    for metric, series in frames.items():
        daily[metric] = series.reindex(daily.index).fillna(0).astype(int)

    # Add derived columns
    daily["engagement_rate_daily"] = np.where(
        daily.get("reach", pd.Series(0, index=daily.index)) > 0,
        daily.get("interactions", pd.Series(0, index=daily.index))
        / daily.get("reach", pd.Series(1, index=daily.index)),
        0.0,
    ).round(4)

    # Rolling averages (7-day)
    for col in ["follows", "reach", "views", "interactions", "visits"]:
        if col in daily.columns:
            daily[f"{col}_7d_avg"] = daily[col].rolling(7, min_periods=1).mean().round(1)

    # Weekly aggregates
    daily["week"] = daily.index.isocalendar().week.fillna(0).astype(int)
    daily["year_week"] = daily.index.strftime("%Y-W%U")

    daily = daily.sort_index()
    return daily


# ══════════════════════════════════════════════
# HISTORY MANAGEMENT
# ══════════════════════════════════════════════

def save_account_history(daily: pd.DataFrame, demographics: Dict, platform: str = "instagram"):
    """Save account-level data to history, merging with existing."""
    import json

    HISTORY_DIR.mkdir(parents=True, exist_ok=True)

    # Save daily time-series (per-platform)
    daily_path = HISTORY_DIR / f"account_daily_{platform}.csv"
    if daily_path.exists():
        existing = pd.read_csv(daily_path, index_col="date", parse_dates=True)
        combined = pd.concat([existing, daily])
        combined = combined[~combined.index.duplicated(keep="last")]
        combined = combined.sort_index()
        combined.to_csv(daily_path)
        logger.info(f"   💾 Account daily ({platform}): merged → {len(combined)} days")
    else:
        daily.to_csv(daily_path)
        logger.info(f"   💾 Account daily ({platform}): {len(daily)} days saved")

    # Also save combined account_daily.csv for backward compatibility
    all_daily_files = list(HISTORY_DIR.glob("account_daily_*.csv"))
    if all_daily_files:
        frames = []
        for f in all_daily_files:
            d = pd.read_csv(f, index_col="date", parse_dates=True)
            # Normalize timezone — strip tz for compatibility
            if d.index.tz is not None:
                d.index = d.index.tz_localize(None)
            frames.append(d)
        if frames:
            combined_all = frames[0]
            for f in frames[1:]:
                combined_all = combined_all.combine_first(f)
            combined_all.to_csv(HISTORY_DIR / "account_daily.csv")

    # Save demographics with versioning
    if demographics:
        # Current snapshot
        demo_path = HISTORY_DIR / f"demographics_{platform}.json"
        snapshot = {
            "snapshot_date": pd.Timestamp.now().isoformat(),
            "platform": platform,
            **demographics,
        }
        with open(demo_path, "w", encoding="utf-8") as f:
            json.dump(snapshot, f, indent=2, ensure_ascii=False)

        # Append to history (track audience changes over time)
        demo_history_path = HISTORY_DIR / f"demographics_history_{platform}.jsonl"
        with open(demo_history_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(snapshot, ensure_ascii=False) + "\n")

        # Backward compatibility
        demo_compat = HISTORY_DIR / "demographics.json"
        with open(demo_compat, "w", encoding="utf-8") as f:
            json.dump(snapshot, f, indent=2, ensure_ascii=False)

        logger.info(f"   💾 Demographics ({platform}): saved + versioned")


def load_account_history() -> Tuple[pd.DataFrame, Dict]:
    """Load account-level historical data."""
    import json

    daily = pd.DataFrame()
    demographics = {}

    daily_path = HISTORY_DIR / "account_daily.csv"
    if daily_path.exists():
        daily = pd.read_csv(daily_path, index_col="date", parse_dates=True)

    demo_path = HISTORY_DIR / "demographics.json"
    if demo_path.exists():
        with open(demo_path, "r", encoding="utf-8") as f:
            demographics = json.load(f)

    return daily, demographics


if __name__ == "__main__":
    """Test with real data."""
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    from config import PLATFORM_DIRS

    ig_dir = PLATFORM_DIRS["instagram"]
    result = ingest_account_data(ig_dir)

    daily = result["daily"]
    demo = result["demographics"]

    if not daily.empty:
        print(f"\n📊 Daily data: {len(daily)} days")
        print(f"   Date range: {daily.index.min()} → {daily.index.max()}")
        print(f"   Columns: {daily.columns.tolist()}")
        print(f"\n   Totals:")
        for col in ["follows", "reach", "views", "interactions", "visits", "link_clicks"]:
            if col in daily.columns:
                print(f"     {col}: {daily[col].sum():,}")

    if demo:
        print(f"\n👥 Demographics:")
        if "countries" in demo:
            top_c = [c['country'] + ' (' + str(c['percentage']) + '%)' for c in demo['countries'][:5]]
            print(f"   Top countries: {', '.join(top_c)}")
        if "age_gender" in demo:
            print(f"   Age groups: {len(demo['age_gender'])}")
        if "cities" in demo:
            print(f"   Top cities: {', '.join(c['city'] for c in demo['cities'][:5])}")
