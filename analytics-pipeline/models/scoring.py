"""
OKN Analytics — Content Performance Scoring Model
==================================================
Assigns a composite score to each post and predicts
expected performance for future content.

Scoring dimensions:
- Reach Score: How far did this content travel?
- Engagement Score: How deeply did people interact?
- Quality Score: Weighted engagement (saves/shares > likes)
- Efficiency Score: Engagement relative to reach
- Growth Score: Did this content drive follower growth?
"""

import pandas as pd
import numpy as np
import logging
from typing import Dict, Any, List
from sklearn.preprocessing import MinMaxScaler

logger = logging.getLogger("okn.models.scoring")


class ContentScorer:
    """Scores individual posts and content strategies."""

    # Engagement quality weights (higher = more valuable)
    QUALITY_WEIGHTS = {
        "likes": 1.0,
        "comments": 3.0,
        "shares": 5.0,
        "saves": 4.0,
        "link_clicks": 2.0,
    }

    # Composite score dimension weights
    DIMENSION_WEIGHTS = {
        "reach": 0.20,
        "engagement": 0.25,
        "quality": 0.25,
        "efficiency": 0.20,
        "growth": 0.10,
    }

    def __init__(self, df: pd.DataFrame):
        self.df = df.copy()
        self.scaler = MinMaxScaler()

    def score_all_posts(self) -> pd.DataFrame:
        """Score every post and return DataFrame with scores."""
        if len(self.df) < 3:
            logger.warning("Not enough posts to score meaningfully")
            return self.df

        scored = self.df.copy()

        # Calculate raw dimension scores
        scored["reach_score"] = self._normalize(scored["reach"])
        scored["engagement_score"] = self._normalize(scored["engagement_total"])
        scored["quality_score"] = self._calculate_quality_scores(scored)
        scored["efficiency_score"] = self._normalize(scored["engagement_rate"])
        scored["growth_score"] = self._normalize(scored["followers_gained"])

        # Composite score (0-100)
        scored["composite_score"] = (
            scored["reach_score"] * self.DIMENSION_WEIGHTS["reach"]
            + scored["engagement_score"] * self.DIMENSION_WEIGHTS["engagement"]
            + scored["quality_score"] * self.DIMENSION_WEIGHTS["quality"]
            + scored["efficiency_score"] * self.DIMENSION_WEIGHTS["efficiency"]
            + scored["growth_score"] * self.DIMENSION_WEIGHTS["growth"]
        ) * 100

        scored["composite_score"] = scored["composite_score"].round(1)

        # Grade assignment
        scored["grade"] = scored["composite_score"].apply(self._assign_grade)

        return scored

    def get_content_type_scores(self) -> Dict[str, Any]:
        """Average scores by content type."""
        scored = self.score_all_posts()
        if "composite_score" not in scored.columns:
            return {}

        type_scores = scored.groupby("content_type").agg(
            avg_score=("composite_score", "mean"),
            median_score=("composite_score", "median"),
            best_score=("composite_score", "max"),
            worst_score=("composite_score", "min"),
            count=("composite_score", "count"),
        ).round(1)

        type_scores = type_scores.sort_values("avg_score", ascending=False)
        return type_scores.to_dict("index")

    def get_platform_scores(self) -> Dict[str, Any]:
        """Average scores by platform."""
        scored = self.score_all_posts()
        if "composite_score" not in scored.columns:
            return {}

        platform_scores = scored.groupby("platform").agg(
            avg_score=("composite_score", "mean"),
            best_score=("composite_score", "max"),
            count=("composite_score", "count"),
        ).round(1)

        return platform_scores.to_dict("index")

    def get_top_posts(self, n: int = 10) -> List[Dict]:
        """Get the top N scoring posts."""
        scored = self.score_all_posts()
        if "composite_score" not in scored.columns:
            return []

        top = scored.nlargest(n, "composite_score")
        return [
            {
                "rank": i + 1,
                "title": str(row.get("title", "") or "")[:80],
                "platform": row["platform"],
                "content_type": row["content_type"],
                "score": row["composite_score"],
                "grade": row["grade"],
                "reach": int(row["reach"]),
                "engagement": int(row["engagement_total"]),
                "published_at": str(row["published_at"]),
                "permalink": row.get("permalink", ""),
            }
            for i, (_, row) in enumerate(top.iterrows())
        ]

    def predict_performance(self, content_type: str, platform: str,
                            day_of_week: str = None, hour: int = None) -> Dict:
        """
        Predict expected performance for a new post
        based on historical patterns.
        """
        # Filter to matching historical content
        mask = (
            (self.df["content_type"] == content_type)
            & (self.df["platform"] == platform)
        )
        matching = self.df[mask]

        if len(matching) < 3:
            # Fall back to just platform
            matching = self.df[self.df["platform"] == platform]

        if len(matching) < 3:
            return {"error": "Not enough historical data for prediction"}

        prediction = {
            "expected_reach": int(matching["reach"].median()),
            "expected_engagement": int(matching["engagement_total"].median()),
            "expected_engagement_rate": round(matching["engagement_rate"].median(), 4),
            "expected_likes": int(matching["likes"].median()),
            "expected_comments": int(matching["comments"].median()),
            "expected_shares": int(matching["shares"].median()),
            "optimistic_reach": int(matching["reach"].quantile(0.75)),
            "pessimistic_reach": int(matching["reach"].quantile(0.25)),
            "confidence": "high" if len(matching) >= 20 else "medium" if len(matching) >= 10 else "low",
            "based_on_posts": len(matching),
        }

        return prediction

    def _calculate_quality_scores(self, df: pd.DataFrame) -> pd.Series:
        """Calculate quality-weighted engagement scores."""
        quality = pd.Series(0.0, index=df.index)

        for metric, weight in self.QUALITY_WEIGHTS.items():
            if metric in df.columns:
                quality += df[metric] * weight

        return self._normalize(quality)

    @staticmethod
    def _normalize(series: pd.Series) -> pd.Series:
        """Normalize a series to 0-1 range using min-max scaling."""
        min_val = series.min()
        max_val = series.max()
        if max_val == min_val:
            return pd.Series(0.5, index=series.index)
        return (series - min_val) / (max_val - min_val)

    @staticmethod
    def _assign_grade(score: float) -> str:
        """Assign a letter grade based on composite score."""
        if score >= 70:
            return "A+"
        elif score >= 55:
            return "A"
        elif score >= 40:
            return "B+"
        elif score >= 30:
            return "B"
        elif score >= 20:
            return "C+"
        elif score >= 12:
            return "C"
        elif score >= 6:
            return "D"
        else:
            return "F"


def score_content(df: pd.DataFrame) -> Dict[str, Any]:
    """Convenience function to run content scoring."""
    scorer = ContentScorer(df)
    return {
        "top_posts": scorer.get_top_posts(10),
        "content_type_scores": scorer.get_content_type_scores(),
        "platform_scores": scorer.get_platform_scores(),
    }
