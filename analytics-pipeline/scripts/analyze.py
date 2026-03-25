"""
OKN Analytics Pipeline — Core Analysis Engine
==============================================
Takes the unified DataFrame and produces actionable insights.

Analysis modules:
1. Platform Overview — KPIs per platform
2. Content Performance — Which content types win
3. Engagement Deep-Dive — What drives interaction
4. Temporal Patterns — When to post
5. Growth Analysis — Follower trajectory
6. Anomaly Detection — Viral hits and flops
7. Cross-Platform Intelligence — Content-platform fit
8. Composite Scoring — Unified content score
"""

import pandas as pd
import numpy as np
import logging
from datetime import datetime, timedelta
from typing import Dict, Any, Optional

from config import PLATFORMS, ANALYSIS, CONTENT_CATEGORIES, TIMEZONE, TIMELINE, compute_recency_weights

logger = logging.getLogger("okn.analyze")


def _friendly_type(name):
    """Convert content_type slugs to readable labels."""
    return {
        "short_video": "Short Video", "long_video": "Long Video", "image": "Image",
        "carousel": "Carousel", "story": "Story", "live": "Live Stream",
        "text_post": "Text Post", "link_post": "Link Post", "other": "Other",
    }.get(name, name.replace("_", " ").title())


def _safe_weighted_avg(values, weights):
    """Compute weighted average, safe against empty/zero weights/NaN."""
    values = np.asarray(values, dtype=float)
    weights = np.asarray(weights, dtype=float)
    mask = np.isfinite(values) & np.isfinite(weights)
    values, weights = values[mask], weights[mask]
    if len(values) == 0 or float(np.sum(weights)) < 1e-10:
        return 0.0
    return float(np.average(values, weights=weights))


class OKNAnalyzer:
    """Core analytics engine for OKN social media data."""

    def __init__(self, df: pd.DataFrame):
        self.df = df.copy()
        self.results: Dict[str, Any] = {}
        self._prepare_data()

    def _prepare_data(self):
        """Pre-process data for analysis."""
        # Ensure datetime — normalize everything to UTC for safe comparison
        self.df["published_at"] = pd.to_datetime(
            self.df["published_at"], errors="coerce", utc=True
        )

        # Add derived time columns (only for rows with valid dates)
        valid_mask = self.df["published_at"].notna()

        if valid_mask.any():
            # Extract time features in KST (Korean Standard Time)
            kst_times = self.df.loc[valid_mask, "published_at"].dt.tz_convert("Asia/Seoul")
            self.df.loc[valid_mask, "day_of_week"] = kst_times.dt.day_name()
            self.df.loc[valid_mask, "hour"] = kst_times.dt.hour

            # isocalendar — use KST dates so week boundaries align with Korean calendar
            iso = kst_times.dt.isocalendar()
            self.df.loc[valid_mask, "week"] = iso["week"].values
            self.df["week"] = self.df["week"].fillna(0).astype(int)

            self.df.loc[valid_mask, "year_week"] = kst_times.dt.strftime("%Y-W%U")
            self.df.loc[valid_mask, "month"] = kst_times.dt.to_period("M").astype(str)
        else:
            for col in ["day_of_week", "hour", "week", "year_week", "month"]:
                self.df[col] = None

        # Fill NaN in derived columns for rows with bad dates
        self.df["day_of_week"] = self.df["day_of_week"].fillna("Unknown")
        self.df["hour"] = pd.to_numeric(self.df["hour"], errors="coerce").fillna(0).astype(int)
        self.df["year_week"] = self.df["year_week"].fillna("Unknown")
        self.df["month"] = self.df["month"].fillna("Unknown")

        # Current week data — anchored to the most recent date in the data
        now = self.df["published_at"].max()
        if pd.isna(now):
            now = pd.Timestamp.now(tz="UTC")
        self.now = now
        week_ago = now - timedelta(days=7)
        two_weeks_ago = now - timedelta(days=14)

        self.df_this_week = self.df[self.df["published_at"] >= week_ago]
        self.df_last_week = self.df[
            (self.df["published_at"] >= two_weeks_ago) &
            (self.df["published_at"] < week_ago)
        ]

        # Recency weights — last 90 days get full weight, older data gets less
        self.df["weight"] = compute_recency_weights(self.df["published_at"], reference_date=now)

    def run_all(self) -> Dict[str, Any]:
        """Run all analysis modules and return results."""
        logger.info("\U0001f52c Running full analysis pipeline...")

        self.results["meta"] = {
            "generated_at": datetime.now().isoformat(),
            "total_posts": len(self.df),
            "platforms": self.df["platform"].unique().tolist(),
            "date_range": {
                "earliest": str(self.df["published_at"].min()),
                "latest": str(self.df["published_at"].max()),
            },
        }

        self.results["platform_overview"] = self.analyze_platforms()
        self.results["content_performance"] = self.analyze_content()
        self.results["engagement"] = self.analyze_engagement()
        self.results["temporal"] = self.analyze_temporal()
        self.results["growth"] = self.analyze_growth()
        self.results["anomalies"] = self.detect_anomalies()
        self.results["cross_platform"] = self.analyze_cross_platform()
        self.results["recommendations"] = self.generate_recommendations()

        logger.info("\u2705 Analysis complete.")
        return self.results

    # ──────────────────────────────────────────
    # 1. PLATFORM OVERVIEW
    # ──────────────────────────────────────────

    def analyze_platforms(self) -> Dict:
        """KPI summary for each platform."""
        logger.info("   \U0001f4ca Platform overview...")
        overview = {}

        for platform in self.df["platform"].unique():
            pdf = self.df[self.df["platform"] == platform]
            pw = self.df_this_week[self.df_this_week["platform"] == platform]
            plw = self.df_last_week[self.df_last_week["platform"] == platform]

            wow_reach = self._wow_change(pw["reach"].sum(), plw["reach"].sum())
            wow_engagement = self._wow_change(
                pw["engagement_total"].sum(), plw["engagement_total"].sum()
            )

            benchmark = ANALYSIS["engagement_benchmarks"].get(platform, 0.03)
            weighted_rate = _safe_weighted_avg(pdf["engagement_rate"].values, pdf["weight"].values)

            overview[platform] = {
                "total_posts": len(pdf),
                "posts_this_week": len(pw),
                "total_reach": int(pdf["reach"].sum()),
                "total_engagement": int(pdf["engagement_total"].sum()),
                "avg_engagement_rate": round(weighted_rate, 4),
                "median_engagement_rate": round(float(pdf["engagement_rate"].median()), 4),
                "benchmark_engagement": benchmark,
                "vs_benchmark": round(weighted_rate - benchmark, 4),
                "total_followers_gained": int(pdf["followers_gained"].sum()),
                "wow_reach_change": wow_reach,
                "wow_engagement_change": wow_engagement,
                "top_post": self._top_post(pdf),
            }

        return overview

    # ──────────────────────────────────────────
    # 2. CONTENT PERFORMANCE
    # ──────────────────────────────────────────

    def analyze_content(self) -> Dict:
        """Performance breakdown by content type."""
        logger.info("   \U0001f3ac Content performance...")
        content = {}

        for ctype in self.df["content_type"].unique():
            cdf = self.df[self.df["content_type"] == ctype]
            if len(cdf) < ANALYSIS["min_posts_for_analysis"]:
                continue

            w = cdf["weight"].values
            content[ctype] = {
                "count": len(cdf),
                "avg_reach": int(_safe_weighted_avg(cdf["reach"].values, w)),
                "avg_engagement": int(_safe_weighted_avg(cdf["engagement_total"].values, w)),
                "avg_engagement_rate": round(_safe_weighted_avg(cdf["engagement_rate"].values, w), 4),
                "avg_likes": int(_safe_weighted_avg(cdf["likes"].values, w)),
                "avg_comments": int(_safe_weighted_avg(cdf["comments"].values, w)),
                "avg_shares": int(_safe_weighted_avg(cdf["shares"].values, w)),
                "avg_saves": int(_safe_weighted_avg(cdf["saves"].values, w)),
                "total_reach": int(cdf["reach"].sum()),
                "platforms": cdf["platform"].unique().tolist(),
            }

        # Per-platform content ranking
        platform_rankings = {}
        for platform in self.df["platform"].unique():
            pdf = self.df[self.df["platform"] == platform]
            p_ranked = []
            for ctype in pdf["content_type"].unique():
                cdf = pdf[pdf["content_type"] == ctype]
                if len(cdf) >= max(2, ANALYSIS["min_posts_for_analysis"] // 2):
                    cw = cdf["weight"].values
                    p_ranked.append({
                        "type": ctype,
                        "engagement_rate": round(_safe_weighted_avg(cdf["engagement_rate"].values, cw), 4),
                        "count": len(cdf),
                        "avg_engagement": int(_safe_weighted_avg(cdf["engagement_total"].values, cw)),
                    })
            p_ranked.sort(key=lambda x: x["engagement_rate"], reverse=True)
            if p_ranked:
                platform_rankings[platform] = p_ranked

        content["_platform_rankings"] = platform_rankings

        if content:
            ranked = sorted(
                [(k, v) for k, v in content.items() if not k.startswith("_")],
                key=lambda x: x[1]["avg_engagement_rate"],
                reverse=True,
            )
            content["_ranking"] = [
                {"type": k, "engagement_rate": v["avg_engagement_rate"], "platforms": v["platforms"]}
                for k, v in ranked
            ]

        return content

    # ──────────────────────────────────────────
    # 3. ENGAGEMENT DEEP-DIVE
    # ──────────────────────────────────────────

    def analyze_engagement(self) -> Dict:
        """Detailed engagement analysis."""
        logger.info("   \U0001f4ac Engagement analysis...")

        total = {
            "likes": int(self.df["likes"].sum()),
            "comments": int(self.df["comments"].sum()),
            "shares": int(self.df["shares"].sum()),
            "saves": int(self.df["saves"].sum()),
        }
        grand_total = sum(total.values()) or 1

        composition = {k: round(v / grand_total, 4) for k, v in total.items()}

        quality_weights = {"likes": 1, "comments": 3, "shares": 5, "saves": 4}
        quality_score = sum(total[k] * quality_weights[k] for k in quality_weights) / (self.df["reach"].sum() or 1)

        ctl_ratio = total["comments"] / (total["likes"] or 1)
        ste_ratio = total["shares"] / (grand_total or 1)

        platform_engagement = {}
        for platform in self.df["platform"].unique():
            pdf = self.df[self.df["platform"] == platform]
            eng_sum = pdf["engagement_total"].sum() or 1
            platform_engagement[platform] = {
                "likes_pct": round(float(pdf["likes"].sum() / eng_sum), 4),
                "comments_pct": round(float(pdf["comments"].sum() / eng_sum), 4),
                "shares_pct": round(float(pdf["shares"].sum() / eng_sum), 4),
                "saves_pct": round(float(pdf["saves"].sum() / eng_sum), 4),
            }

        return {
            "totals": total,
            "composition": composition,
            "quality_score": round(quality_score, 6),
            "conversation_ratio": round(ctl_ratio, 4),
            "virality_ratio": round(ste_ratio, 4),
            "platform_breakdown": platform_engagement,
        }

    # ──────────────────────────────────────────
    # 4. TEMPORAL PATTERNS
    # ──────────────────────────────────────────

    def analyze_temporal(self) -> Dict:
        """When should OKN post for maximum impact?"""
        logger.info("   \U0001f550 Temporal patterns...")

        valid = self.df.dropna(subset=["published_at"])
        if valid.empty:
            return {"error": "No valid timestamp data"}

        # Exclude platforms where ALL posts have hour=0 (no real time data)
        platforms_with_hours = []
        for platform in valid["platform"].unique():
            pdata = valid[valid["platform"] == platform]
            if pdata["hour"].nunique() > 1:
                platforms_with_hours.append(platform)

        if not platforms_with_hours:
            return {"error": "No platforms with posting time data"}

        valid = valid[valid["platform"].isin(platforms_with_hours)]

        def _weighted_agg(group):
            w = group["weight"].values
            eng = group["engagement_rate"].values
            reach = group["reach"].values
            return pd.Series({
                "avg_engagement": _safe_weighted_avg(eng, w),
                "avg_reach": _safe_weighted_avg(reach, w),
                "post_count": float(len(group)),
            })

        try:
            hourly = valid.groupby("hour", group_keys=False).apply(_weighted_agg).round(4)
            best_hours = hourly.nlargest(3, "avg_engagement")

            daily = valid.groupby("day_of_week", group_keys=False).apply(_weighted_agg).round(4)
            day_order = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
            daily = daily.reindex([d for d in day_order if d in daily.index])
            best_days = daily.nlargest(3, "avg_engagement")
        except Exception as e:
            logger.warning(f"   Temporal aggregation error: {e}")
            return {"error": str(e)}

        # Per-platform best times
        platform_timing = {}
        for platform in valid["platform"].unique():
            pdata = valid[valid["platform"] == platform]
            if len(pdata) >= ANALYSIS["min_posts_for_analysis"]:
                try:
                    p_hourly = pdata.groupby("hour", group_keys=False).apply(_weighted_agg)
                    p_daily = pdata.groupby("day_of_week", group_keys=False).apply(_weighted_agg)
                    best_h = p_hourly.nlargest(3, "avg_engagement").index.tolist()
                    best_d = p_daily.nlargest(2, "avg_engagement").index.tolist()
                    platform_timing[platform] = {"best_hours": best_h, "best_days": best_d}
                except Exception:
                    pass

        # Heatmap — safe version
        try:
            heatmap_data = valid.groupby(["day_of_week", "hour"], group_keys=False).apply(
                lambda g: pd.Series({"engagement_rate": _safe_weighted_avg(g["engagement_rate"].values, g["weight"].values)})
            ).reset_index()
            heatmap = heatmap_data.pivot_table(values="engagement_rate", index="day_of_week", columns="hour").round(4)
        except Exception:
            heatmap = pd.DataFrame()

        return {
            "best_hours_overall": best_hours.to_dict("index"),
            "best_days_overall": best_days.to_dict("index"),
            "hourly_data": hourly.to_dict("index"),
            "daily_data": daily.to_dict("index"),
            "platform_timing": platform_timing,
            "heatmap": heatmap.to_dict("index") if not heatmap.empty else {},
        }

    # ──────────────────────────────────────────
    # 5. GROWTH ANALYSIS
    # ──────────────────────────────────────────

    def analyze_growth(self) -> Dict:
        """Follower/reach growth trajectory."""
        logger.info("   \U0001f4c8 Growth analysis...")

        valid = self.df.dropna(subset=["published_at"])
        valid = valid[valid["year_week"] != "Unknown"]
        if valid.empty:
            return {"error": "No valid data for growth analysis"}

        weekly = valid.groupby("year_week").agg(
            total_reach=("reach", "sum"),
            total_engagement=("engagement_total", "sum"),
            total_followers=("followers_gained", "sum"),
            post_count=("post_id", "count"),
            avg_engagement_rate=("engagement_rate", "mean"),
        ).round(4)

        # Growth rates — replace inf with 0
        for col_name in ["total_reach", "total_engagement", "total_followers"]:
            growth_col = col_name.replace("total_", "") + "_growth"
            weekly[growth_col] = weekly[col_name].pct_change().replace([np.inf, -np.inf], np.nan).fillna(0).round(4)

        recent = weekly.tail(4)
        trajectory = {
            "avg_weekly_reach": int(recent["total_reach"].mean()) if not recent.empty else 0,
            "avg_weekly_engagement": int(recent["total_engagement"].mean()) if not recent.empty else 0,
            "avg_weekly_followers": int(recent["total_followers"].mean()) if not recent.empty else 0,
            "avg_weekly_posts": round(float(recent["post_count"].mean()), 1) if not recent.empty else 0,
            "reach_trend": self._trend_direction(recent["total_reach"]),
            "engagement_trend": self._trend_direction(recent["total_engagement"]),
            "follower_trend": self._trend_direction(recent["total_followers"]),
        }

        platform_growth = {}
        for platform in valid["platform"].unique():
            pdata = valid[valid["platform"] == platform]
            pw = pdata.groupby("year_week").agg(
                reach=("reach", "sum"),
                engagement=("engagement_total", "sum"),
                followers=("followers_gained", "sum"),
            )
            if len(pw) >= 2:
                platform_growth[platform] = {
                    "latest_week_reach": int(pw["reach"].iloc[-1]),
                    "reach_trend": self._trend_direction(pw["reach"].tail(4)),
                    "total_followers_gained": int(pw["followers"].sum()),
                }

        return {
            "weekly_data": weekly.to_dict("index"),
            "trajectory": trajectory,
            "platform_growth": platform_growth,
        }

    # ──────────────────────────────────────────
    # 6. ANOMALY DETECTION
    # ──────────────────────────────────────────

    def detect_anomalies(self) -> Dict:
        """Identify viral hits and unexpected flops."""
        logger.info("   \U0001f525 Anomaly detection...")

        anomalies = {"viral": [], "underperformers": []}

        for platform in self.df["platform"].unique():
            pdf = self.df[self.df["platform"] == platform]
            if len(pdf) < ANALYSIS["min_posts_for_analysis"]:
                continue

            mean_eng = pdf["engagement_total"].mean()
            if pd.isna(mean_eng) or mean_eng == 0:
                continue
            mean_reach = pdf["reach"].mean()

            viral_threshold = mean_eng * ANALYSIS["viral_multiplier"]
            flop_threshold = mean_eng * ANALYSIS["underperform_threshold"]

            viral = pdf[pdf["engagement_total"] >= viral_threshold].head(ANALYSIS["top_n_posts"])
            for _, row in viral.iterrows():
                title = row.get("title", "") or ""
                anomalies["viral"].append({
                    "platform": platform,
                    "post_id": row["post_id"],
                    "title": str(title)[:100],
                    "content_type": row["content_type"],
                    "engagement": int(row["engagement_total"]),
                    "reach": int(row["reach"]),
                    "multiplier": round(float(row["engagement_total"] / mean_eng), 1),
                    "published_at": str(row["published_at"]),
                    "permalink": row.get("permalink", ""),
                })

            if mean_reach > 0:
                underperformers = pdf[
                    (pdf["engagement_total"] <= flop_threshold) &
                    (pdf["reach"] >= mean_reach * 0.5)
                ].head(ANALYSIS["top_n_posts"])

                for _, row in underperformers.iterrows():
                    title = row.get("title", "") or ""
                    anomalies["underperformers"].append({
                        "platform": platform,
                        "post_id": row["post_id"],
                        "title": str(title)[:100],
                        "content_type": row["content_type"],
                        "engagement": int(row["engagement_total"]),
                        "reach": int(row["reach"]),
                        "engagement_rate": round(float(row["engagement_rate"]), 4),
                        "published_at": str(row["published_at"]),
                    })

        anomalies["viral"].sort(key=lambda x: x["multiplier"], reverse=True)
        return anomalies

    # ──────────────────────────────────────────
    # 7. CROSS-PLATFORM INTELLIGENCE
    # ──────────────────────────────────────────

    def analyze_cross_platform(self) -> Dict:
        """Compare performance across platforms to find content-platform fit."""
        logger.info("   \U0001f504 Cross-platform analysis...")

        platforms = self.df["platform"].unique()
        if len(platforms) < 2:
            return {"note": "Need data from 2+ platforms for comparison"}

        platform_avgs = {}
        for platform in platforms:
            pdf = self.df[self.df["platform"] == platform]
            w = pdf["weight"].values
            platform_avgs[platform] = {
                "avg_reach": int(_safe_weighted_avg(pdf["reach"].values, w)),
                "avg_engagement_rate": round(_safe_weighted_avg(pdf["engagement_rate"].values, w), 4),
                "avg_likes": int(_safe_weighted_avg(pdf["likes"].values, w)),
                "avg_comments": int(_safe_weighted_avg(pdf["comments"].values, w)),
                "avg_shares": int(_safe_weighted_avg(pdf["shares"].values, w)),
                "dominant_content_type": pdf["content_type"].mode().iloc[0] if not pdf["content_type"].mode().empty else "unknown",
            }

        content_platform = {}
        for ctype in self.df["content_type"].unique():
            cdf = self.df[self.df["content_type"] == ctype]
            if len(cdf) < ANALYSIS["min_posts_for_analysis"]:
                continue

            cp_data = {}
            for platform in cdf["platform"].unique():
                cpdf = cdf[cdf["platform"] == platform]
                if len(cpdf) >= 2:
                    cpw = cpdf["weight"].values
                    cp_data[platform] = {
                        "avg_engagement_rate": round(_safe_weighted_avg(cpdf["engagement_rate"].values, cpw), 4),
                        "avg_reach": int(_safe_weighted_avg(cpdf["reach"].values, cpw)),
                        "count": len(cpdf),
                    }

            if len(cp_data) >= 2:
                best = max(cp_data.items(), key=lambda x: x[1]["avg_engagement_rate"])
                content_platform[ctype] = {
                    "platforms": cp_data,
                    "best_platform": best[0],
                    "best_rate": best[1]["avg_engagement_rate"],
                }

        return {
            "platform_averages": platform_avgs,
            "content_platform_fit": content_platform,
        }

    # ──────────────────────────────────────────
    # 8. RECOMMENDATIONS ENGINE
    # ──────────────────────────────────────────

    def generate_recommendations(self) -> list:
        """Generate actionable recommendations based on all analysis."""
        logger.info("   \U0001f4a1 Generating recommendations...")
        recs = []

        if len(self.df) < 10:
            recs.append({
                "priority": "high",
                "category": "data",
                "message": "Not enough data for deep analysis yet. Keep adding weekly exports! At least 4 weeks of data is ideal.",
            })
            return recs

        # Content recommendations
        content = self.results.get("content_performance", {})
        platform_rankings = content.get("_platform_rankings", {})
        for platform, rankings in platform_rankings.items():
            if rankings:
                best = rankings[0]
                pname = PLATFORMS.get(platform, {}).get("name", platform)
                recs.append({
                    "priority": "high",
                    "category": "content",
                    "message": f"On {pname}, your best content type is '{_friendly_type(best['type'])}' with {best['engagement_rate']:.1%} avg engagement ({best['count']} posts). Create more of this.",
                })

        # Timing recommendations
        temporal = self.results.get("temporal", {})
        best_hours = temporal.get("best_hours_overall", {})
        if best_hours:
            top_hour = list(best_hours.keys())[0]
            top_data = best_hours[top_hour]
            pc = top_data.get("post_count", 0)
            if pc >= 3:
                recs.append({
                    "priority": "high",
                    "category": "timing",
                    "message": f"Your best posting hour is {int(top_hour)}:00 KST (based on {pc:.0f} posts). Schedule high-priority content around this time.",
                })
            else:
                for h, d in best_hours.items():
                    if d.get("post_count", 0) >= 3:
                        recs.append({
                            "priority": "medium",
                            "category": "timing",
                            "message": f"Hour {int(h)}:00 KST shows strong engagement ({d['post_count']:.0f} posts). Consider posting around this time.",
                        })
                        break
                else:
                    recs.append({
                        "priority": "low",
                        "category": "timing",
                        "message": "Not enough data per time slot to recommend posting hours yet. Keep adding weekly exports.",
                    })

        best_days = temporal.get("best_days_overall", {})
        if best_days:
            top_day = list(best_days.keys())[0]
            top_day_data = best_days[top_day]
            if top_day_data.get("post_count", 0) >= 3:
                recs.append({
                    "priority": "medium",
                    "category": "timing",
                    "message": f"Best performing day is {top_day}. Consider making this your primary posting day.",
                })

        # Engagement quality
        engagement = self.results.get("engagement", {})
        conversation = engagement.get("conversation_ratio", 0)
        if conversation < 0.05:
            recs.append({
                "priority": "medium",
                "category": "engagement",
                "message": "Comments-to-likes ratio is low. Try asking questions, running polls, or creating discussion-worthy content.",
            })

        # Platform benchmarks
        overview = self.results.get("platform_overview", {})
        for platform, data in overview.items():
            vs = data.get("vs_benchmark", 0)
            pname = PLATFORMS.get(platform, {}).get("name", platform)
            if vs < -0.02:
                recs.append({
                    "priority": "medium",
                    "category": "platform",
                    "message": f"{pname} engagement is below industry benchmark. Review content strategy for this platform.",
                })
            elif vs > 0.02:
                recs.append({
                    "priority": "low",
                    "category": "platform",
                    "message": f"{pname} is outperforming industry benchmark by {vs:.1%}! Keep up the great work.",
                })

        # Per-platform growth alerts
        growth = self.results.get("growth", {})
        platform_growth = growth.get("platform_growth", {})
        for platform, pg in platform_growth.items():
            pname = PLATFORMS.get(platform, {}).get("name", platform)
            trend = pg.get("reach_trend", "stable")
            if trend == "declining":
                recs.append({
                    "priority": "high",
                    "category": "growth",
                    "message": f"{pname} reach is declining. Consider boosting posting frequency or trying new content formats on this platform.",
                })
            elif trend == "growing":
                recs.append({
                    "priority": "low",
                    "category": "growth",
                    "message": f"{pname} reach is growing! Keep up the momentum.",
                })

        # Anomaly-based recommendations
        anomalies = self.results.get("anomalies", {})
        viral = anomalies.get("viral", [])
        if viral:
            for platform in self.df["platform"].unique():
                pname = PLATFORMS.get(platform, {}).get("name", platform)
                p_viral = [v for v in viral if v["platform"] == platform]
                if p_viral:
                    viral_types = set(_friendly_type(v["content_type"]) for v in p_viral)
                    recs.append({
                        "priority": "high",
                        "category": "content",
                        "message": f"Viral content on {pname}: {', '.join(viral_types)}. Create more content in these formats.",
                    })

        # Methodology note
        if len(self.df["platform"].unique()) > 1:
            recs.append({
                "priority": "low",
                "category": "methodology",
                "message": "Note: Instagram engagement rate uses reach as denominator; TikTok uses views. Direct rate comparison between platforms should be interpreted with this in mind.",
            })

        priority_order = {"high": 0, "medium": 1, "low": 2}
        recs.sort(key=lambda x: priority_order.get(x["priority"], 3))
        return recs

    # ──────────────────────────────────────────
    # UTILITY METHODS
    # ──────────────────────────────────────────

    @staticmethod
    def _wow_change(current: float, previous: float) -> Optional[float]:
        """Calculate week-over-week percentage change."""
        if previous == 0:
            return None
        return round((current - previous) / previous, 4)

    @staticmethod
    def _top_post(df: pd.DataFrame) -> Optional[Dict]:
        """Get the top performing post."""
        if df.empty:
            return None
        top = df.nlargest(1, "engagement_total").iloc[0]
        title = top.get("title", "") or ""
        return {
            "title": str(title)[:100],
            "engagement": int(top["engagement_total"]),
            "reach": int(top["reach"]),
            "type": top["content_type"],
            "date": str(top["published_at"]),
            "permalink": top.get("permalink", ""),
        }

    @staticmethod
    def _trend_direction(series: pd.Series) -> str:
        """Determine if a metric is growing, stable, or declining."""
        if len(series) < 2:
            return "insufficient_data"

        values = series.dropna().values
        try:
            values = values.astype(float)
        except (ValueError, TypeError):
            return "insufficient_data"

        if len(values) < 2:
            return "insufficient_data"

        # Check for constant values (polyfit would fail)
        if float(np.std(values)) < 1e-10:
            return "stable"

        try:
            x = np.arange(len(values))
            slope = float(np.polyfit(x, values, 1)[0])
            mean_val = float(np.mean(values))
            if abs(mean_val) < 1e-10:
                mean_val = 1.0
            normalized_slope = slope / abs(mean_val)

            if normalized_slope > 0.05:
                return "growing"
            elif normalized_slope < -0.05:
                return "declining"
            else:
                return "stable"
        except (np.linalg.LinAlgError, ValueError, TypeError):
            return "insufficient_data"


def analyze(df: pd.DataFrame) -> Dict[str, Any]:
    """Convenience function to run full analysis."""
    analyzer = OKNAnalyzer(df)
    return analyzer.run_all()
