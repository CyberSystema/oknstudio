"""
OKN Analytics — Growth Forecasting Model
=========================================
Forecasts future growth metrics using:
1. Simple moving average (baseline)
2. Linear trend projection
3. Prophet (if available and enough data)

Produces 30-day forecasts for reach, engagement, and followers.
"""

import pandas as pd
import numpy as np
import logging
from typing import Dict, Any, Optional
from datetime import timedelta

from config import FORECAST

logger = logging.getLogger("okn.models.forecast")


class GrowthForecaster:
    """Forecasts social media growth metrics."""

    def __init__(self, df: pd.DataFrame):
        self.df = df.copy()
        self.df["published_at"] = pd.to_datetime(self.df["published_at"], errors="coerce")
        self.df = self.df.dropna(subset=["published_at"])
        self.prophet_available = self._check_prophet()

    def forecast_all(self) -> Dict[str, Any]:
        """Run forecasts for all key metrics."""
        if len(self.df) < 7:
            return {
                "error": "Need at least 7 data points for forecasting.",
                "current_data_points": len(self.df),
            }

        results = {
            "horizon_days": FORECAST["horizon_days"],
            "method_used": "prophet" if self.prophet_available else "statistical",
            "generated_at": pd.Timestamp.now().isoformat(),
        }

        # Build weekly time series
        weekly = self._build_weekly_series()

        if len(weekly) < FORECAST["min_history_weeks"]:
            return {
                "error": f"Need at least {FORECAST['min_history_weeks']} weeks of data.",
                "current_weeks": len(weekly),
            }

        # Forecast each metric
        for metric in ["reach", "engagement", "followers"]:
            col = {
                "reach": "total_reach",
                "engagement": "total_engagement",
                "followers": "total_followers",
            }[metric]

            if col in weekly.columns:
                forecast = self._forecast_metric(weekly, col, metric)
                results[metric] = forecast

        # Overall health assessment
        results["health"] = self._assess_health(results)

        return results

    def forecast_platform(self, platform: str) -> Dict[str, Any]:
        """Forecast growth for a specific platform."""
        pdata = self.df[self.df["platform"] == platform]
        if len(pdata) < 7:
            return {"error": f"Not enough data for {platform} forecast"}

        forecaster = GrowthForecaster(pdata)
        result = forecaster.forecast_all()
        result["platform"] = platform
        return result

    def _build_weekly_series(self) -> pd.DataFrame:
        """Aggregate data into weekly time series."""
        self.df["week_start"] = self.df["published_at"].dt.to_period("W").apply(
            lambda x: x.start_time
        )

        weekly = self.df.groupby("week_start").agg(
            total_reach=("reach", "sum"),
            total_engagement=("engagement_total", "sum"),
            total_followers=("followers_gained", "sum"),
            post_count=("post_id", "count"),
            avg_engagement_rate=("engagement_rate", "mean"),
        ).sort_index()

        return weekly

    def _forecast_metric(self, weekly: pd.DataFrame, column: str,
                         metric_name: str) -> Dict[str, Any]:
        """Forecast a single metric."""
        series = weekly[column].values
        dates = weekly.index

        # Try Prophet first, fall back to statistical
        if self.prophet_available and len(series) >= 8:
            try:
                return self._prophet_forecast(weekly, column, metric_name)
            except Exception as e:
                logger.warning(f"Prophet failed for {metric_name}: {e}")

        return self._statistical_forecast(series, dates, metric_name)

    def _statistical_forecast(self, series: np.ndarray, dates: pd.Index,
                              metric_name: str) -> Dict[str, Any]:
        """Simple statistical forecasting (linear trend + moving average)."""
        n = len(series)
        x = np.arange(n)

        # Linear trend
        if n >= 3:
            coeffs = np.polyfit(x, series, 1)
            slope = coeffs[0]
            intercept = coeffs[1]
        else:
            slope = 0
            intercept = series.mean()

        # Moving average (last 4 weeks)
        ma_window = min(4, n)
        moving_avg = series[-ma_window:].mean()

        # Weighted combination: 60% trend, 40% moving average
        forecast_weeks = FORECAST["horizon_days"] // 7

        forecasted = []
        last_date = dates[-1]

        for i in range(1, forecast_weeks + 1):
            trend_value = slope * (n + i) + intercept
            blended = 0.6 * trend_value + 0.4 * moving_avg
            blended = max(0, blended)  # No negative forecasts

            forecast_date = last_date + timedelta(weeks=i)
            forecasted.append({
                "week": str(forecast_date.date()) if hasattr(forecast_date, 'date') else str(forecast_date),
                "predicted": round(blended),
                "lower_bound": round(blended * (1 - (1 - FORECAST["confidence_interval"]))),
                "upper_bound": round(blended * (1 + (1 - FORECAST["confidence_interval"]))),
            })

        # Trend analysis
        if n >= 4:
            recent_trend = np.polyfit(range(min(4, n)), series[-min(4, n):], 1)[0]
        else:
            recent_trend = slope

        return {
            "method": "linear_trend_ma",
            "historical_weeks": n,
            "current_weekly_avg": round(float(moving_avg)),
            "trend_direction": "up" if slope > 0 else "down" if slope < 0 else "flat",
            "weekly_change_rate": round(float(slope / (moving_avg or 1)), 4),
            "forecast": forecasted,
            "summary": self._forecast_summary(metric_name, moving_avg, forecasted),
        }

    def _prophet_forecast(self, weekly: pd.DataFrame, column: str,
                          metric_name: str) -> Dict[str, Any]:
        """Forecast using Facebook Prophet."""
        from prophet import Prophet

        # Prepare Prophet format
        prophet_df = pd.DataFrame({
            "ds": weekly.index.to_timestamp() if hasattr(weekly.index, 'to_timestamp') else weekly.index,
            "y": weekly[column].values,
        })

        # Fit model
        model = Prophet(
            interval_width=FORECAST["confidence_interval"],
            weekly_seasonality=False,  # Our data is already weekly
            daily_seasonality=False,
            yearly_seasonality=True if len(prophet_df) >= 52 else False,
            changepoint_prior_scale=0.05,  # Conservative
        )

        model.fit(prophet_df)

        # Forecast
        future = model.make_future_dataframe(
            periods=FORECAST["horizon_days"] // 7,
            freq="W",
        )
        forecast = model.predict(future)

        # Extract future predictions
        future_only = forecast[forecast["ds"] > prophet_df["ds"].max()]

        forecasted = []
        for _, row in future_only.iterrows():
            forecasted.append({
                "week": str(row["ds"].date()),
                "predicted": round(max(0, row["yhat"])),
                "lower_bound": round(max(0, row["yhat_lower"])),
                "upper_bound": round(max(0, row["yhat_upper"])),
            })

        # Trend
        moving_avg = weekly[column].tail(4).mean()
        trend = forecast["trend"].diff().mean()

        return {
            "method": "prophet",
            "historical_weeks": len(weekly),
            "current_weekly_avg": round(float(moving_avg)),
            "trend_direction": "up" if trend > 0 else "down" if trend < 0 else "flat",
            "forecast": forecasted,
            "summary": self._forecast_summary(metric_name, moving_avg, forecasted),
        }

    def _forecast_summary(self, metric_name: str, current_avg: float,
                          forecast: list) -> str:
        """Generate human-readable forecast summary."""
        if not forecast:
            return "Insufficient data for forecast."

        final = forecast[-1]["predicted"]
        change = ((final - current_avg) / (current_avg or 1)) * 100

        direction = "increase" if change > 5 else "decrease" if change < -5 else "remain stable"

        return (
            f"Weekly {metric_name} is expected to {direction} over the next "
            f"{len(forecast)} weeks. Current avg: {current_avg:,.0f}, "
            f"Projected: {final:,.0f} ({change:+.1f}%)."
        )

    def _assess_health(self, results: Dict) -> Dict:
        """Overall growth health assessment."""
        health_signals = []

        for metric in ["reach", "engagement", "followers"]:
            data = results.get(metric, {})
            direction = data.get("trend_direction", "flat")

            if direction == "up":
                health_signals.append(1)
            elif direction == "flat":
                health_signals.append(0)
            else:
                health_signals.append(-1)

        avg_signal = np.mean(health_signals) if health_signals else 0

        if avg_signal > 0.5:
            status = "strong_growth"
            emoji = "🚀"
            message = "OKN's social presence is growing well across key metrics."
        elif avg_signal > -0.5:
            status = "stable"
            emoji = "📊"
            message = "Growth is stable. Look for opportunities to accelerate."
        else:
            status = "needs_attention"
            emoji = "⚠️"
            message = "Multiple metrics are declining. Review content strategy."

        return {
            "status": status,
            "emoji": emoji,
            "message": message,
            "signal_score": round(avg_signal, 2),
        }

    @staticmethod
    def _check_prophet() -> bool:
        """Check if Prophet is available."""
        try:
            from prophet import Prophet
            return True
        except ImportError:
            logger.info("Prophet not available — using statistical forecasting")
            return False


def forecast_growth(df: pd.DataFrame) -> Dict:
    """Convenience function."""
    forecaster = GrowthForecaster(df)
    return forecaster.forecast_all()
