"""
OKN Analytics Pipeline — Main Orchestrator
===========================================
Runs the full pipeline: Ingest → Analyze → Model → Report

Usage:
    python scripts/main.py                 # Full pipeline
    python scripts/main.py --ingest-only   # Just ingest data
    python scripts/main.py --report-only   # Re-generate report from existing data
"""

import sys
import json
import logging
import argparse
import warnings
import pandas as pd
from pathlib import Path
from datetime import datetime

# Suppress noisy warnings
warnings.filterwarnings("ignore", message="Converting to PeriodArray")
warnings.filterwarnings("ignore", message="Glyph .* missing from font")

# Add scripts dir and pipeline root to path
# scripts/ — for config, ingest, analyze, report
# analytics-pipeline/ — for models package
sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))

from config import ROOT_DIR, REPORTS_DIR, HISTORY_DIR, PLATFORM_DIRS, ensure_dirs
from ingest import ingest_all
from ingest_account import ingest_account_data, load_account_history, save_account_history
from ingest_tiktok import ingest_tiktok_account
from analyze import OKNAnalyzer
from models.timing import PostingTimeModel
from models.scoring import ContentScorer, score_content
from models.forecast import GrowthForecaster
from report import generate_report

# ──────────────────────────────────────────────
# LOGGING SETUP
# ──────────────────────────────────────────────

def setup_logging():
    """Configure pretty logging."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(message)s",
        handlers=[
            logging.StreamHandler(sys.stdout),
            logging.FileHandler(ROOT_DIR / "pipeline.log", mode="a"),
        ],
    )


# ──────────────────────────────────────────────
# PIPELINE
# ──────────────────────────────────────────────

def run_pipeline(ingest_only=False, report_only=False):
    """Execute the full analytics pipeline."""
    ensure_dirs()
    setup_logging()

    logger = logging.getLogger("okn.main")

    logger.info("=" * 60)
    logger.info(f"☦️  OKN ANALYTICS PIPELINE")
    logger.info(f"   Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    logger.info("=" * 60)

    # ── STEP 1: INGEST ──
    logger.info("\n📥 STEP 1: Data Ingestion")
    logger.info("-" * 40)

    if report_only:
        # Load from history
        history_file = HISTORY_DIR / "unified_history.parquet"
        csv_backup = HISTORY_DIR / "unified_history.csv"

        if history_file.exists():
            df = pd.read_parquet(history_file)
        elif csv_backup.exists():
            df = pd.read_csv(csv_backup)
        else:
            logger.error("❌ No historical data found. Run full pipeline first.")
            sys.exit(1)
        logger.info(f"📂 Loaded {len(df)} records from history")
    else:
        df = ingest_all()

    if df.empty:
        logger.warning("\n⚠️  No data available for analysis.")
        logger.info("   Add CSV exports to the data/ folders and try again.")
        logger.info("   See README.md for export instructions.")
        _write_empty_report()
        sys.exit(0)

    logger.info(f"\n✅ Dataset: {len(df)} posts across {df['platform'].nunique()} platforms")

    # ── STEP 1b: ACCOUNT-LEVEL DATA ──
    logger.info("\n📥 STEP 1b: Account-Level Data")
    logger.info("-" * 40)

    account_data = {"daily": pd.DataFrame(), "demographics": {}}
    all_account_data = []  # Collect from all platforms

    if not report_only:
        for platform, pdir in PLATFORM_DIRS.items():
            csv_files = [f.name.lower() for f in pdir.iterdir() if f.suffix.lower() == ".csv"]

            # Instagram account files
            ig_account_files = [f for f in csv_files if f in [
                "follows.csv", "reach.csv", "views.csv", "visits.csv",
                "interactions.csv", "link_clicks.csv", "audience.csv",
            ]]
            if ig_account_files:
                logger.info(f"   📈 Found Instagram account data: {', '.join(ig_account_files)}")
                ig_data = ingest_account_data(pdir)
                all_account_data.append(("instagram", ig_data))

            # TikTok account files
            tt_account_files = [f for f in csv_files if f in [
                "overview.csv", "viewers.csv", "followerhistory.csv",
                "followeractivity.csv", "followergender.csv",
                "followertopterritories.csv",
            ]]
            if tt_account_files:
                logger.info(f"   📈 Found TikTok account data: {', '.join(tt_account_files)}")
                tt_data = ingest_tiktok_account(pdir)
                all_account_data.append(("tiktok", tt_data))

        # Merge account data — keep per-platform in a dict
        if all_account_data:
            account_data = {
                "daily": all_account_data[0][1]["daily"],
                "demographics": all_account_data[0][1]["demographics"],
                "platforms": {p: d for p, d in all_account_data},
            }
            # Save each platform's account data to history
            for plat_name, plat_data in all_account_data:
                if not plat_data["daily"].empty or plat_data["demographics"]:
                    save_account_history(
                        plat_data["daily"],
                        plat_data["demographics"],
                        platform=plat_name,
                    )
    else:
        # Load from history
        daily_hist, demo_hist = load_account_history()
        account_data = {"daily": daily_hist, "demographics": demo_hist}
        if not daily_hist.empty:
            logger.info(f"   📂 Loaded {len(daily_hist)} days of account history")

    if not account_data["daily"].empty:
        logger.info(f"   ✅ Account daily data: {len(account_data['daily'])} days")
    if account_data["demographics"]:
        logger.info(f"   ✅ Demographics data loaded")

    if ingest_only:
        logger.info("\n✅ Ingestion complete (--ingest-only mode)")
        sys.exit(0)

    # ── STEP 2: ANALYZE ──
    logger.info("\n🔬 STEP 2: Core Analysis")
    logger.info("-" * 40)

    # Add recency weights to main df (used by analyzer, ML, and scoring)
    from config import compute_recency_weights
    df["weight"] = compute_recency_weights(df["published_at"])

    analyzer = OKNAnalyzer(df)
    analysis = analyzer.run_all()

    # ── STEP 3: MODELS ──
    logger.info("\n🤖 STEP 3: Predictive Models")
    logger.info("-" * 40)

    # Timing model
    logger.info("   ⏰ Optimal posting times...")
    try:
        timing_model = PostingTimeModel(df)
        timing_results = timing_model.get_optimal_schedule()

        # Per-platform timing
        for platform in df["platform"].unique():
            pt = timing_model.get_optimal_schedule(platform)
            timing_results[f"{platform}_schedule"] = pt
    except Exception as e:
        logger.warning(f"   Timing model error: {e}")
        timing_results = {}

    # Content scoring
    logger.info("   📊 Content scoring...")
    try:
        scoring_results = score_content(df)
    except Exception as e:
        logger.warning(f"   Scoring error: {e}")
        scoring_results = {}

    # Growth forecasting
    logger.info("   📈 Growth forecasting...")
    try:
        forecaster = GrowthForecaster(df)
        forecast_results = forecaster.forecast_all()

        # Per-platform forecast
        for platform in df["platform"].unique():
            pf = forecaster.forecast_platform(platform)
            forecast_results[f"{platform}_forecast"] = pf
    except Exception as e:
        logger.warning(f"   Forecast error: {e}")
        forecast_results = {}

    # ML & Neural Networks (per-platform)
    logger.info("   🧠 ML & Neural Network analysis...")
    from models.ml_engine import run_ml
    ml_results = {}
    for platform in df["platform"].unique():
        try:
            pdata = df[df["platform"] == platform]
            ml_results[platform] = run_ml(pdata, platform)
            status = ml_results[platform].get("status", "unknown")
            if status == "ok":
                nn = ml_results[platform].get("engagement_prediction", {})
                r2 = nn.get("r2_score", "N/A")
                logger.info(f"      {platform}: NN R²={r2}, "
                            f"features={len(ml_results[platform].get('feature_importance', {}).get('top_features', []))}, "
                            f"clusters={ml_results[platform].get('content_clusters', {}).get('n_clusters', 0)}")
            else:
                logger.info(f"      {platform}: {ml_results[platform].get('message', status)}")
        except Exception as e:
            logger.warning(f"      {platform} ML failed: {e}")
            ml_results[platform] = {"status": "failed", "error": str(e)}

    # ── STEP 4: REPORT ──
    logger.info("\n📝 STEP 4: Report Generation")
    logger.info("-" * 40)

    try:
        report_path = generate_report(
            df=df,
            analysis=analysis,
            scores=scoring_results,
            timing=timing_results,
            forecast=forecast_results,
            account_data=account_data,
            ml_results=ml_results,
        )
        logger.info(f"   ✅ HTML Report: {report_path}")
    except Exception as e:
        logger.error(f"   ❌ HTML report generation failed: {e}")
        import traceback
        traceback.print_exc()

    # Save full results as JSON
    try:
        platforms = sorted(df['platform'].dropna().unique().tolist())
        recommendations = analysis.get("recommendations", []) if isinstance(analysis, dict) else []
        health = analysis.get("health", {}) if isinstance(analysis, dict) else {}

        full_results = {
            "generated_at": datetime.now().isoformat(),
            "meta": {
                "total_posts": int(len(df)),
                "platforms": platforms,
            },
            "health": _serialize(health),
            "recommendations": _serialize(recommendations),
            "analysis": _serialize(analysis),
            "timing": _serialize(timing_results),
            "scoring": _serialize(scoring_results),
            "forecast": _serialize(forecast_results),
        }
        results_path = REPORTS_DIR / "full_results.json"
        results_path.write_text(json.dumps(full_results, indent=2, default=str))
        logger.info(f"   📄 Full results: {results_path}")
    except Exception as e:
        logger.warning(f"   Could not save full results: {e}")

    # ── DONE ──
    logger.info("\n" + "=" * 60)
    logger.info("✅ PIPELINE COMPLETE")
    logger.info(f"   Finished: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    logger.info(f"   Posts analyzed: {len(df)}")
    logger.info(f"   Platforms: {', '.join(df['platform'].unique())}")
    logger.info(f"   Report: site/analytics/report.html")
    logger.info("=" * 60)

    # Print key recommendations to console
    recs = analysis.get("recommendations", [])
    if recs:
        logger.info("\n💡 KEY RECOMMENDATIONS:")
        for rec in recs[:5]:
            icon = {"high": "🔴", "medium": "🟡", "low": "🟢"}.get(rec["priority"], "⚪")
            logger.info(f"   {icon} {rec['message']}")

    return analysis, timing_results, scoring_results, forecast_results


def _write_empty_report():
    """Write a placeholder report when no data is available."""
    ensure_dirs()
    html = """<!DOCTYPE html>
<html><head><title>OKN Analytics — No Data</title></head>
<body style="font-family: sans-serif; max-width: 600px; margin: 60px auto; text-align: center;">
<h1>☦️ OKN Analytics</h1>
<p>No data available yet.</p>
<p>Add CSV exports from your social media platforms to the <code>analytics-pipeline/data/</code> folders and push to trigger the pipeline.</p>
<p>See <code>README.md</code> for export instructions.</p>
</body></html>"""
    (REPORTS_DIR / "report.html").write_text(html)


def _serialize(obj):
    """Make an object JSON-serializable."""
    if isinstance(obj, dict):
        return {k: _serialize(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [_serialize(v) for v in obj]
    elif isinstance(obj, (int, float, str, bool, type(None))):
        return obj
    else:
        return str(obj)


# ──────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="OKN Analytics Pipeline")
    parser.add_argument("--ingest-only", action="store_true",
                        help="Only ingest data, skip analysis and reporting")
    parser.add_argument("--report-only", action="store_true",
                        help="Re-generate report from existing historical data")
    args = parser.parse_args()

    run_pipeline(
        ingest_only=args.ingest_only,
        report_only=args.report_only,
    )


if __name__ == "__main__":
    main()
