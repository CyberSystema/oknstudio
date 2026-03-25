"""
OKN Analytics — Optimal Posting Time Model
===========================================
Uses historical performance data to recommend the best
days and hours to post on each platform.

Method: Weighted scoring based on engagement rate,
adjusted for sample size confidence.
"""

import pandas as pd
import numpy as np
import logging
from typing import Dict, Any, List, Tuple

from config import compute_recency_weights

logger = logging.getLogger("okn.models.timing")


class PostingTimeModel:
    """Determines optimal posting times per platform."""

    # Days ordered for analysis
    DAY_ORDER = [
        "Monday", "Tuesday", "Wednesday", "Thursday",
        "Friday", "Saturday", "Sunday",
    ]

    def __init__(self, df: pd.DataFrame):
        self.df = df.copy()
        self.df["published_at"] = pd.to_datetime(self.df["published_at"], errors="coerce", utc=True)
        self.df = self.df.dropna(subset=["published_at"])
        # Always extract time features in KST
        kst = self.df["published_at"].dt.tz_convert("Asia/Seoul")
        self.df["hour"] = kst.dt.hour
        self.df["day_of_week"] = kst.dt.day_name()
        # Recency weights
        if "weight" not in self.df.columns:
            self.df["weight"] = compute_recency_weights(self.df["published_at"])

    def get_optimal_schedule(self, platform: str = None) -> Dict[str, Any]:
        """
        Get the optimal posting schedule.

        Returns a recommended weekly schedule with best hours per day.
        """
        data = self.df if platform is None else self.df[self.df["platform"] == platform]

        if len(data) < 10:
            return {"error": "Not enough data (need 10+ posts)"}

        # Calculate confidence-weighted engagement for each day-hour combo
        schedule = {}
        for day in self.DAY_ORDER:
            day_data = data[data["day_of_week"] == day]
            if day_data.empty:
                schedule[day] = {"recommend_posting": False, "reason": "No data"}
                continue

            # Find best hours for this day
            hourly_scores = []
            for hour in range(24):
                hour_data = day_data[day_data["hour"] == hour]
                if len(hour_data) >= 2:
                    score = self._confidence_weighted_score(
                        hour_data["engagement_rate"],
                        len(data),
                    )
                    hourly_scores.append((hour, score, len(hour_data)))

            if not hourly_scores:
                schedule[day] = {"recommend_posting": True, "best_hours": [], "confidence": "low"}
                continue

            # Sort by score, take top 3
            hourly_scores.sort(key=lambda x: x[1], reverse=True)
            top_hours = hourly_scores[:3]

            schedule[day] = {
                "recommend_posting": True,
                "best_hours": [
                    {
                        "hour": h,
                        "time": f"{h:02d}:00",
                        "score": round(s, 4),
                        "sample_size": n,
                    }
                    for h, s, n in top_hours
                ],
                "avg_engagement": round(day_data["engagement_rate"].mean(), 4),
                "post_count": len(day_data),
                "confidence": "high" if len(day_data) >= 10 else "medium" if len(day_data) >= 5 else "low",
            }

        # Overall best slots (top 5 across all days)
        all_slots = []
        for day, info in schedule.items():
            for h in info.get("best_hours", []):
                all_slots.append({
                    "day": day,
                    "hour": h["hour"],
                    "time": h["time"],
                    "score": h["score"],
                })

        all_slots.sort(key=lambda x: x["score"], reverse=True)

        # Worst times (to avoid)
        avoid_slots = self._find_worst_times(data)

        return {
            "weekly_schedule": schedule,
            "top_5_slots": all_slots[:5],
            "avoid_times": avoid_slots[:5],
            "data_points": len(data),
        }

    def get_next_best_time(self, platform: str = None) -> Dict:
        """Get the single next best time to post from now."""
        schedule = self.get_optimal_schedule(platform)
        top_slots = schedule.get("top_5_slots", [])

        if not top_slots:
            return {"message": "Not enough data to recommend"}

        now = self.df["published_at"].max()
        if pd.isna(now):
            now = pd.Timestamp.now(tz="Asia/Seoul")
        current_day = now.day_name()
        current_hour = now.hour

        # Find the next upcoming slot
        for offset in range(7):
            check_day = (now + pd.Timedelta(days=offset)).day_name()
            for slot in top_slots:
                if slot["day"] == check_day:
                    if offset == 0 and slot["hour"] <= current_hour:
                        continue  # Already passed today
                    return {
                        "day": slot["day"],
                        "time": slot["time"],
                        "score": slot["score"],
                        "days_from_now": offset,
                    }

        return top_slots[0]  # Fallback to overall best

    def _confidence_weighted_score(self, engagement_rates: pd.Series, total_n: int) -> float:
        """
        Calculate engagement score weighted by sample confidence and recency.

        Uses Bayesian-inspired adjustment: with small samples,
        pull toward the global mean; with large samples, trust the data.
        Recency weights give more importance to recent posts.
        """
        n = len(engagement_rates)
        if n == 0:
            return 0.0

        # Use recency weights for the mean
        w = self.df.loc[engagement_rates.index, "weight"].values
        local_mean = float(np.average(engagement_rates.values, weights=w))
        global_mean = float(np.average(self.df["engagement_rate"].values, weights=self.df["weight"].values))

        # Confidence weight: more data = higher confidence in local mean
        confidence = min(n / 20, 1.0)  # Saturates at n=20

        weighted = (confidence * local_mean) + ((1 - confidence) * global_mean)
        return weighted

    def _find_worst_times(self, data: pd.DataFrame) -> List[Dict]:
        """Find the worst performing time slots to avoid."""
        worst = []

        for day in self.DAY_ORDER:
            day_data = data[data["day_of_week"] == day]
            for hour in range(24):
                hour_data = day_data[day_data["hour"] == hour]
                if len(hour_data) >= 3:
                    avg_rate = hour_data["engagement_rate"].mean()
                    if avg_rate < data["engagement_rate"].mean() * 0.5:
                        worst.append({
                            "day": day,
                            "hour": hour,
                            "time": f"{hour:02d}:00",
                            "avg_engagement_rate": round(avg_rate, 4),
                        })

        worst.sort(key=lambda x: x["avg_engagement_rate"])
        return worst


def get_optimal_times(df: pd.DataFrame, platform: str = None) -> Dict:
    """Convenience function."""
    model = PostingTimeModel(df)
    return model.get_optimal_schedule(platform)
