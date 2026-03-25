"""
OKN Analytics Pipeline — ML & Neural Network Engine
====================================================
Machine learning models for deeper social media intelligence.

Models:
1. Engagement Predictor    — MLP Neural Network predicts engagement for new posts
2. Content Clustering      — KMeans groups similar-performing content
3. Feature Importance      — GradientBoosting identifies what drives engagement
4. Caption NLP             — TF-IDF finds high-engagement words/topics
5. Anomaly Detection       — IsolationForest finds statistically unusual posts
6. Time Series Decompose   — Separates trend, seasonality, and residual
7. Growth Trajectory       — Polynomial regression on follower growth
"""

import pandas as pd
import numpy as np
import logging
import re
from typing import Dict, Any, List, Optional

from sklearn.preprocessing import StandardScaler, MinMaxScaler
from sklearn.neural_network import MLPRegressor
from sklearn.ensemble import GradientBoostingRegressor, IsolationForest
from sklearn.cluster import KMeans
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.model_selection import cross_val_score
from sklearn.metrics import r2_score, mean_absolute_error
from sklearn.metrics.pairwise import cosine_similarity

from config import compute_recency_weights

logger = logging.getLogger("okn.ml")

# ══════════════════════════════════════════════
# SENTENCE EMBEDDINGS (optional — graceful fallback)
# ══════════════════════════════════════════════
_embedding_model = None
HAS_EMBEDDINGS = False

try:
    from sentence_transformers import SentenceTransformer
    HAS_EMBEDDINGS = True
except ImportError:
    pass


def _get_embedding_model():
    """Load the multilingual sentence-transformer model (singleton)."""
    global _embedding_model
    if _embedding_model is None and HAS_EMBEDDINGS:
        logger.info("      Loading multilingual embedding model...")
        _embedding_model = SentenceTransformer("paraphrase-multilingual-MiniLM-L12-v2")
    return _embedding_model


def _compute_embeddings(texts: List[str]) -> Optional[np.ndarray]:
    """Encode texts to 384-dim vectors. Returns None if not available."""
    model = _get_embedding_model()
    if model is None:
        return None
    try:
        return model.encode(texts, show_progress_bar=False, batch_size=32)
    except Exception as e:
        logger.warning(f"      Embedding failed: {e}")
        return None


class MLEngine:
    """
    Runs ML models on a SINGLE platform's data.
    Always instantiate per-platform to avoid methodology mixing.
    """

    MIN_POSTS_FOR_ML = 10
    MIN_POSTS_FOR_NN = 15

    def __init__(self, df: pd.DataFrame, platform: str):
        self.df = df.copy()
        self.platform = platform
        self.results: Dict[str, Any] = {}
        self._extract_features()

    def _extract_features(self):
        """Build feature matrix from post data."""
        df = self.df

        # Time features (extract in KST)
        df["published_at"] = pd.to_datetime(df["published_at"], errors="coerce", utc=True)
        try:
            kst = df["published_at"].dt.tz_convert("Asia/Seoul")
        except Exception:
            kst = df["published_at"]
        df["hour"] = kst.dt.hour.fillna(0).astype(int)
        df["day_of_week"] = kst.dt.dayofweek.fillna(0).astype(int)
        df["is_weekend"] = (df["day_of_week"] >= 5).astype(int)

        # Caption features
        df["caption_length"] = df["title"].fillna("").str.len()
        df["hashtag_count"] = df["title"].fillna("").apply(
            lambda x: len(re.findall(r"#\w+", str(x)))
        )
        df["has_emoji"] = df["title"].fillna("").apply(
            lambda x: 1 if re.search(r"[\U0001F600-\U0001F9FF\U00002600-\U000027BF\U0001F300-\U0001F5FF]", str(x)) else 0
        )
        df["is_multilingual"] = df["title"].fillna("").apply(
            lambda x: 1 if (re.search(r"[\uAC00-\uD7AF]", str(x)) and re.search(r"[a-zA-Z]", str(x))) else 0
        )

        # Content type one-hot
        for ct in df["content_type"].unique():
            df[f"is_{ct}"] = (df["content_type"] == ct).astype(int)

        # Duration feature
        if "duration_sec" in df.columns:
            df["duration_sec"] = pd.to_numeric(df["duration_sec"], errors="coerce").fillna(0)

        self.df = df

        # Feature columns for models
        self.feature_cols = [
            "hour", "day_of_week", "is_weekend",
            "caption_length", "hashtag_count", "has_emoji", "is_multilingual",
        ]
        # Add content type dummies
        for col in df.columns:
            if col.startswith("is_") and col not in ["is_weekend", "is_multilingual"]:
                self.feature_cols.append(col)

        if "duration_sec" in df.columns:
            self.feature_cols.append("duration_sec")

        # Recency weights — last 90 days get full weight for ML training
        if "weight" in df.columns:
            self.sample_weights = df["weight"].values
        else:
            self.sample_weights = compute_recency_weights(df["published_at"]).values

        # Semantic caption embeddings (multilingual, pre-trained)
        captions = df["title"].fillna("").tolist()
        self.embeddings = _compute_embeddings(captions)
        if self.embeddings is not None:
            logger.info(f"      Embeddings: {self.embeddings.shape[1]}d vectors for {len(captions)} captions")
            # Add PCA-reduced embedding features to tabular model
            # Use min(10, n_posts//5) components to avoid overfitting
            from sklearn.decomposition import PCA
            n_components = min(10, max(3, len(captions) // 5))
            pca = PCA(n_components=n_components, random_state=42)
            emb_reduced = pca.fit_transform(self.embeddings)
            for i in range(n_components):
                col_name = f"emb_{i}"
                df[col_name] = emb_reduced[:, i]
                self.feature_cols.append(col_name)
            self.pca = pca
            logger.info(f"      Added {n_components} semantic features ({pca.explained_variance_ratio_.sum():.0%} variance captured)")

    def run_all(self) -> Dict[str, Any]:
        """Run all ML models. Returns results dict."""
        n = len(self.df)
        logger.info(f"   🧠 ML Engine ({self.platform}): {n} posts")

        self.results["platform"] = self.platform
        self.results["n_posts"] = n

        if n < self.MIN_POSTS_FOR_ML:
            self.results["status"] = "insufficient_data"
            self.results["message"] = f"Need at least {self.MIN_POSTS_FOR_ML} posts for ML (have {n})"
            return self.results

        self.results["status"] = "ok"

        # Core models
        self.results["feature_importance"] = self._feature_importance()
        self.results["engagement_prediction"] = self._engagement_predictor()
        self.results["content_clusters"] = self._content_clustering()
        self.results["anomalies"] = self._anomaly_detection()
        self.results["caption_analysis"] = self._caption_nlp()
        self.results["engagement_drivers"] = self._engagement_drivers()

        # Advanced models
        self.results["content_fatigue"] = self._content_fatigue()
        self.results["posting_cadence"] = self._optimal_cadence()
        self.results["momentum_score"] = self._momentum_score()
        self.results["root_cause"] = self._root_cause_analysis()

        # Semantic AI models (require sentence-transformers)
        if self.embeddings is not None:
            self.results["topic_discovery"] = self._topic_discovery()
            self.results["similar_posts"] = self._similar_post_predictor()
            self.results["hashtag_clusters"] = self._hashtag_cluster_strategy()
        else:
            for key in ["topic_discovery", "similar_posts", "hashtag_clusters"]:
                self.results[key] = {"status": "no_embeddings", "message": "Install sentence-transformers for semantic AI models"}

        return self.results

    # ──────────────────────────────────────────
    # 1. ENGAGEMENT PREDICTOR (Neural Network)
    # ──────────────────────────────────────────

    def _engagement_predictor(self) -> Dict:
        """
        Train an MLP Neural Network to predict engagement rate.
        Returns model quality metrics and predictions.
        """
        n = len(self.df)
        if n < self.MIN_POSTS_FOR_NN:
            return {"status": "need_more_data", "min_required": self.MIN_POSTS_FOR_NN}

        X = self.df[self.feature_cols].fillna(0).values
        y = self.df["engagement_rate"].values

        scaler = StandardScaler()
        X_scaled = scaler.fit_transform(X)

        # MLP Neural Network
        mlp = MLPRegressor(
            hidden_layer_sizes=(32, 16, 8),
            activation="relu",
            solver="adam",
            max_iter=2000,
            random_state=42,
            early_stopping=True,
            validation_fraction=0.15,
            alpha=0.01,  # L2 regularization
        )

        try:
            # Cross-validation score
            if n >= 20:
                cv_scores = cross_val_score(mlp, X_scaled, y, cv=min(5, n // 4),
                                            scoring="r2")
                cv_r2 = float(np.mean(cv_scores))
            else:
                cv_r2 = None

            # Fit on full data
            mlp.fit(X_scaled, y)
            y_pred = mlp.predict(X_scaled)

            r2 = float(r2_score(y, y_pred))
            mae = float(mean_absolute_error(y, y_pred))

            # Predicted vs actual for each post
            self.df["predicted_engagement_rate"] = y_pred
            self.df["engagement_residual"] = y - y_pred

            # Find overperformers (actual >> predicted) and underperformers
            overperformers = self.df.nlargest(3, "engagement_residual")
            underperformers = self.df.nsmallest(3, "engagement_residual")

            return {
                "status": "trained",
                "model": "MLP Neural Network (32→16→8)",
                "r2_score": round(r2, 4),
                "cv_r2_score": round(cv_r2, 4) if cv_r2 is not None else None,
                "mae": round(mae, 4),
                "interpretation": self._interpret_r2(cv_r2 if cv_r2 is not None else r2),
                "overperformers": [
                    {
                        "title": str(row.get("title", "") or "")[:80],
                        "actual": round(row["engagement_rate"], 4),
                        "predicted": round(row["predicted_engagement_rate"], 4),
                        "surplus": round(row["engagement_residual"], 4),
                        "permalink": row.get("permalink", ""),
                    }
                    for _, row in overperformers.iterrows()
                ],
                "underperformers": [
                    {
                        "title": str(row.get("title", "") or "")[:80],
                        "actual": round(row["engagement_rate"], 4),
                        "predicted": round(row["predicted_engagement_rate"], 4),
                        "deficit": round(row["engagement_residual"], 4),
                        "permalink": row.get("permalink", ""),
                    }
                    for _, row in underperformers.iterrows()
                ],
            }
        except Exception as e:
            logger.warning(f"   Neural net failed: {e}")
            return {"status": "failed", "error": str(e)}

    # ──────────────────────────────────────────
    # 2. FEATURE IMPORTANCE
    # ──────────────────────────────────────────

    def _feature_importance(self) -> Dict:
        """
        Use GradientBoosting to rank which features drive engagement.
        """
        X = self.df[self.feature_cols].fillna(0).values
        y = self.df["engagement_rate"].values

        try:
            gb = GradientBoostingRegressor(
                n_estimators=100,
                max_depth=3,
                learning_rate=0.1,
                random_state=42,
            )
            gb.fit(X, y, sample_weight=self.sample_weights)

            importances = gb.feature_importances_
            feature_ranking = sorted(
                zip(self.feature_cols, importances),
                key=lambda x: x[1],
                reverse=True,
            )

            # Human-readable feature names
            readable_names = {
                "hour": "Posting Hour",
                "day_of_week": "Day of Week",
                "is_weekend": "Weekend Post",
                "caption_length": "Caption Length",
                "hashtag_count": "Number of Hashtags",
                "has_emoji": "Uses Emoji",
                "is_multilingual": "Multilingual Caption",
                "duration_sec": "Video Duration",
                "is_short_video": "Short Video (Reel/TikTok)",
                "is_carousel": "Carousel Post",
                "is_image": "Single Image",
                "is_long_video": "Long Video",
                "is_story": "Story",
                "is_other": "Other Format",
            }

            return {
                "status": "ok",
                "model": "GradientBoosting (100 trees)",
                "r2_score": round(float(gb.score(X, y)), 4),
                "top_features": [
                    {
                        "feature": readable_names.get(f, f),
                        "raw_feature": f,
                        "importance": round(float(imp), 4),
                        "pct": round(float(imp) * 100, 1),
                    }
                    for f, imp in feature_ranking[:8]
                    if imp > 0.01
                ],
            }
        except Exception as e:
            return {"status": "failed", "error": str(e)}

    # ──────────────────────────────────────────
    # 3. CONTENT CLUSTERING
    # ──────────────────────────────────────────

    def _content_clustering(self) -> Dict:
        """
        KMeans clustering to find groups of similar-performing content.
        """
        cluster_features = ["engagement_rate", "likes", "comments", "shares"]
        available = [c for c in cluster_features if c in self.df.columns]

        if len(available) < 2:
            return {"status": "insufficient_features"}

        X = self.df[available].fillna(0).values
        scaler = MinMaxScaler()
        X_scaled = scaler.fit_transform(X)

        n = len(self.df)
        k = min(3, max(2, n // 5))  # 2-3 clusters based on data size

        try:
            km = KMeans(n_clusters=k, random_state=42, n_init=10)
            self.df["cluster"] = km.fit_predict(X_scaled)

            clusters = []
            for c in range(k):
                cluster_data = self.df[self.df["cluster"] == c]
                clusters.append({
                    "cluster_id": c,
                    "size": len(cluster_data),
                    "avg_engagement_rate": round(cluster_data["engagement_rate"].mean(), 4),
                    "avg_reach": int(cluster_data["reach"].mean()),
                    "avg_likes": int(cluster_data["likes"].mean()),
                    "avg_shares": int(cluster_data["shares"].mean()),
                    "dominant_type": cluster_data["content_type"].mode().iloc[0] if len(cluster_data) > 0 else "unknown",
                    "sample_titles": cluster_data["title"].head(3).tolist(),
                })

            # Label clusters
            clusters.sort(key=lambda x: x["avg_engagement_rate"], reverse=True)
            labels = ["[TOP] Top Performers", "[AVG] Average", "[LOW] Needs Improvement"]
            for i, c in enumerate(clusters):
                c["label"] = labels[min(i, len(labels) - 1)]

            return {
                "status": "ok",
                "n_clusters": k,
                "clusters": clusters,
            }
        except Exception as e:
            return {"status": "failed", "error": str(e)}

    # ──────────────────────────────────────────
    # 4. ANOMALY DETECTION (Isolation Forest)
    # ──────────────────────────────────────────

    def _anomaly_detection(self) -> Dict:
        """
        Use IsolationForest to find statistically anomalous posts
        (both surprisingly good and surprisingly bad).
        """
        features = ["reach", "engagement_total", "likes", "comments", "shares"]
        available = [c for c in features if c in self.df.columns]

        if len(available) < 3:
            return {"status": "insufficient_features"}

        X = self.df[available].fillna(0).values

        try:
            iso = IsolationForest(
                contamination=0.15,  # Expect ~15% anomalies
                random_state=42,
                n_estimators=100,
            )
            self.df["anomaly_score"] = iso.fit_predict(X)
            self.df["anomaly_raw_score"] = iso.decision_function(X)

            anomalies = self.df[self.df["anomaly_score"] == -1].sort_values(
                "anomaly_raw_score"
            )

            # Classify: positive anomaly (good) or negative
            results = []
            for _, row in anomalies.iterrows():
                is_positive = row["engagement_rate"] > self.df["engagement_rate"].median()
                results.append({
                    "title": str(row.get("title", "") or "")[:80],
                    "type": "viral_outlier" if is_positive else "underperformer_outlier",
                    "engagement_rate": round(row["engagement_rate"], 4),
                    "reach": int(row["reach"]),
                    "anomaly_score": round(float(row["anomaly_raw_score"]), 4),
                    "permalink": row.get("permalink", ""),
                })

            return {
                "status": "ok",
                "model": "IsolationForest",
                "total_anomalies": len(anomalies),
                "viral_outliers": [r for r in results if r["type"] == "viral_outlier"],
                "underperformer_outliers": [r for r in results if r["type"] == "underperformer_outlier"],
            }
        except Exception as e:
            return {"status": "failed", "error": str(e)}

    # ──────────────────────────────────────────
    # 5. CAPTION NLP (TF-IDF)
    # ──────────────────────────────────────────

    def _caption_nlp(self) -> Dict:
        """
        TF-IDF analysis on captions to find words/topics
        correlated with high engagement.
        """
        import unicodedata

        def _strip_accents(text):
            """Remove all diacritical marks (accents, tonos) for consistent matching."""
            nfkd = unicodedata.normalize("NFKD", str(text))
            return "".join(c for c in nfkd if unicodedata.category(c) != "Mn")

        captions = self.df["title"].fillna("").tolist()

        # Filter out very short captions
        valid_mask = self.df["title"].fillna("").str.len() > 10
        if valid_mask.sum() < 5:
            return {"status": "insufficient_captions"}

        valid_df = self.df[valid_mask]
        # Strip accents from captions so "τής" matches stop word "της"
        valid_captions = [_strip_accents(c) for c in valid_df["title"].tolist()]

        try:
            # Multi-language stop words (English, Greek, Korean)
            try:
                from stopwordsiso import stopwords as sw_iso
                stop_words = sw_iso(["en", "el", "ko"])
                logger.debug("stopwordsiso loaded: %d stop words", len(stop_words))
            except ImportError:
                logger.info("      stopwordsiso not installed — using built-in stop words")
                from sklearn.feature_extraction.text import ENGLISH_STOP_WORDS
                stop_words = set(ENGLISH_STOP_WORDS)
                stop_words.update([
                    "και", "το", "τον", "την", "του", "της", "τα", "οι", "των", "τους",
                    "τις", "στο", "στη", "στον", "στην", "στα", "στις", "στους",
                    "με", "για", "από", "σε", "ως", "προς", "μετά", "κατά", "παρά",
                    "είναι", "ήταν", "έχει", "έχουν", "θα", "να", "δεν", "μην",
                    "που", "ότι", "αν", "αλλά", "όμως", "ενώ", "επειδή", "αφού",
                    "ένα", "ένας", "μια", "μία", "αυτό", "αυτή", "αυτός", "αυτά",
                    "αυτές", "αυτοί", "αυτών", "αυτούς",
                    "εγώ", "εσύ", "εμείς", "εσείς", "μου", "σου", "μας", "σας",
                    "πολύ", "πιο", "κάθε", "όλα", "όλες", "όλοι", "όλων",
                    "εδώ", "εκεί", "πως", "πώς", "όταν", "πριν", "μετά",
                    "τώρα", "πάλι", "ακόμα", "ίσως", "μόνο", "πάντα",
                ])
                stop_words.update([
                    "의", "에", "을", "를", "이", "가", "은", "는", "와", "과",
                    "도", "로", "으로", "에서", "까지", "부터", "하고", "이나", "나",
                    "그", "이것", "저", "것", "수", "등", "더", "또", "및",
                    "한", "할", "하는", "된", "되는", "있는", "없는", "위해",
                    "그리고", "하지만", "그러나", "그래서", "때문에",
                    "있다", "없다", "하다", "되다", "이다",
                ])

            # Strip accents from stop words too so both sides match
            stop_words = {_strip_accents(w) for w in stop_words}

            # Add common social media noise terms
            stop_words.update([
                "fyp", "foryou", "foryoupage", "viral", "trending", "reels",
                "like", "follow", "share", "comment", "link", "bio", "dm",
                "http", "https", "www", "com",
            ])

            tfidf = TfidfVectorizer(
                max_features=50,
                min_df=2,
                stop_words=list(stop_words),
                token_pattern=r"(?u)\b[#\w][\w]{2,}\b",
            )

            tfidf_matrix = tfidf.fit_transform(valid_captions)
            feature_names = tfidf.get_feature_names_out()

            # Correlate each term with engagement
            engagement = valid_df["engagement_rate"].values
            term_engagement = {}

            for i, term in enumerate(feature_names):
                term_presence = (tfidf_matrix[:, i].toarray().flatten() > 0).astype(int)
                if term_presence.sum() >= 2:
                    # Average engagement when term is present vs absent
                    eng_with = engagement[term_presence == 1].mean()
                    eng_without = engagement[term_presence == 0].mean()
                    lift = (eng_with / eng_without) - 1 if eng_without > 0 else 0

                    term_engagement[term] = {
                        "term": term,
                        "posts_with_term": int(term_presence.sum()),
                        "avg_engagement_with": round(float(eng_with), 4),
                        "avg_engagement_without": round(float(eng_without), 4),
                        "engagement_lift": round(float(lift), 4),
                    }

            # Sort by engagement lift
            high_engagement_terms = sorted(
                term_engagement.values(),
                key=lambda x: x["engagement_lift"],
                reverse=True,
            )

            # Top hashtags specifically
            hashtags = [t for t in high_engagement_terms if t["term"].startswith("#")]

            return {
                "status": "ok",
                "top_engagement_terms": high_engagement_terms[:10],
                "top_hashtags": hashtags[:5],
                "low_engagement_terms": sorted(
                    term_engagement.values(),
                    key=lambda x: x["engagement_lift"],
                )[:5],
                "total_terms_analyzed": len(term_engagement),
            }
        except Exception as e:
            return {"status": "failed", "error": str(e)}

    # ──────────────────────────────────────────
    # 6. ENGAGEMENT DRIVERS
    # ──────────────────────────────────────────

    def _engagement_drivers(self) -> Dict:
        """
        Statistical correlation analysis to find what specifically
        drives engagement on this platform.
        """
        drivers = {}

        # Caption length vs engagement
        if len(self.df) >= 10:
            corr = self.df["caption_length"].corr(self.df["engagement_rate"])
            optimal_length = self.df.nlargest(
                min(5, len(self.df) // 3), "engagement_rate"
            )["caption_length"].median()
            drivers["caption_length"] = {
                "correlation": round(float(corr), 4),
                "direction": "longer is better" if corr > 0.1 else "shorter is better" if corr < -0.1 else "no strong effect",
                "optimal_range": f"{int(optimal_length * 0.7)}-{int(optimal_length * 1.3)} characters",
            }

        # Hashtag count vs engagement
        if self.df["hashtag_count"].sum() > 0:
            corr = self.df["hashtag_count"].corr(self.df["engagement_rate"])
            optimal_tags = self.df.nlargest(
                min(5, len(self.df) // 3), "engagement_rate"
            )["hashtag_count"].median()
            drivers["hashtags"] = {
                "correlation": round(float(corr), 4),
                "direction": "more is better" if corr > 0.1 else "fewer is better" if corr < -0.1 else "no strong effect",
                "optimal_count": int(optimal_tags),
            }

        # Multilingual content effect (recency-weighted)
        if self.df["is_multilingual"].sum() >= 2 and (self.df["is_multilingual"] == 0).sum() >= 2:
            m_df = self.df[self.df["is_multilingual"] == 1]
            s_df = self.df[self.df["is_multilingual"] == 0]
            multi_eng = float(np.average(m_df["engagement_rate"].values, weights=m_df["weight"].values if "weight" in m_df.columns else None))
            single_eng = float(np.average(s_df["engagement_rate"].values, weights=s_df["weight"].values if "weight" in s_df.columns else None))
            drivers["multilingual"] = {
                "multilingual_avg_engagement": round(float(multi_eng), 4),
                "single_language_avg_engagement": round(float(single_eng), 4),
                "lift": round(float((multi_eng / single_eng) - 1), 4) if single_eng > 0 else 0,
                "recommendation": "Multilingual captions perform better" if multi_eng > single_eng * 1.1 else "Single-language captions perform better" if single_eng > multi_eng * 1.1 else "No significant difference",
            }

        # Emoji effect (recency-weighted)
        if self.df["has_emoji"].sum() >= 2 and (self.df["has_emoji"] == 0).sum() >= 2:
            e_df = self.df[self.df["has_emoji"] == 1]
            ne_df = self.df[self.df["has_emoji"] == 0]
            emoji_eng = float(np.average(e_df["engagement_rate"].values, weights=e_df["weight"].values if "weight" in e_df.columns else None))
            no_emoji_eng = float(np.average(ne_df["engagement_rate"].values, weights=ne_df["weight"].values if "weight" in ne_df.columns else None))
            drivers["emoji"] = {
                "with_emoji_avg": round(float(emoji_eng), 4),
                "without_emoji_avg": round(float(no_emoji_eng), 4),
                "lift": round(float((emoji_eng / no_emoji_eng) - 1), 4) if no_emoji_eng > 0 else 0,
            }

        # Weekend vs weekday (recency-weighted)
        if self.df["is_weekend"].sum() >= 2 and (self.df["is_weekend"] == 0).sum() >= 2:
            we_df = self.df[self.df["is_weekend"] == 1]
            wd_df = self.df[self.df["is_weekend"] == 0]
            we_eng = float(np.average(we_df["engagement_rate"].values, weights=we_df["weight"].values if "weight" in we_df.columns else None))
            wd_eng = float(np.average(wd_df["engagement_rate"].values, weights=wd_df["weight"].values if "weight" in wd_df.columns else None))
            drivers["weekend_effect"] = {
                "weekend_avg": round(float(we_eng), 4),
                "weekday_avg": round(float(wd_eng), 4),
                "better": "weekend" if we_eng > wd_eng * 1.05 else "weekday" if wd_eng > we_eng * 1.05 else "no difference",
            }

        return drivers

    # ──────────────────────────────────────────
    # 7. CONTENT FATIGUE DETECTOR
    # ──────────────────────────────────────────

    def _content_fatigue(self) -> Dict:
        """
        Detect declining engagement trends per content type.
        Uses rolling regression on engagement rate over time to find
        content types that are losing audience interest.
        """
        df = self.df.copy()
        df = df.sort_values("published_at")

        if len(df) < 15:
            return {"status": "need_more_data"}

        fatigue_results = []
        for ctype in df["content_type"].unique():
            cdf = df[df["content_type"] == ctype].copy()
            if len(cdf) < 5:
                continue

            # Convert dates to numeric (days since first post)
            cdf["days"] = (cdf["published_at"] - cdf["published_at"].min()).dt.total_seconds() / 86400
            eng = cdf["engagement_rate"].values
            days = cdf["days"].values
            w = cdf["weight"].values if "weight" in cdf.columns else np.ones(len(cdf))

            # Weighted linear regression: engagement_rate = slope * days + intercept
            # Slope tells us if engagement is rising or falling
            w_sum = w.sum()
            x_mean = np.average(days, weights=w)
            y_mean = np.average(eng, weights=w)
            numerator = np.sum(w * (days - x_mean) * (eng - y_mean))
            denominator = np.sum(w * (days - x_mean) ** 2)

            if denominator == 0:
                slope = 0
            else:
                slope = numerator / denominator

            # Slope per 30 days (monthly trend)
            monthly_change = slope * 30

            # Classify
            if monthly_change < -0.01:
                status = "declining"
                severity = "high" if monthly_change < -0.03 else "medium"
            elif monthly_change > 0.01:
                status = "growing"
                severity = "positive"
            else:
                status = "stable"
                severity = "none"

            # Recent vs older performance
            midpoint = len(cdf) // 2
            older_eng = cdf.iloc[:midpoint]["engagement_rate"].mean()
            recent_eng = cdf.iloc[midpoint:]["engagement_rate"].mean()

            fatigue_results.append({
                "content_type": ctype,
                "post_count": len(cdf),
                "trend": status,
                "severity": severity,
                "monthly_change_pct": round(float(monthly_change * 100), 2),
                "older_avg_rate": round(float(older_eng), 4),
                "recent_avg_rate": round(float(recent_eng), 4),
                "change_pct": round(float((recent_eng / older_eng - 1) * 100), 1) if older_eng > 0 else 0,
            })

        # Sort by severity
        severity_order = {"high": 0, "medium": 1, "none": 2, "positive": 3}
        fatigue_results.sort(key=lambda x: severity_order.get(x["severity"], 2))

        return {
            "status": "ok",
            "content_types": fatigue_results,
            "fatigued_types": [r for r in fatigue_results if r["trend"] == "declining"],
            "growing_types": [r for r in fatigue_results if r["trend"] == "growing"],
        }

    # ──────────────────────────────────────────
    # 8. OPTIMAL POSTING CADENCE
    # ──────────────────────────────────────────

    def _optimal_cadence(self) -> Dict:
        """
        Find the optimal number of posts per week.
        Groups weeks by post count and measures average engagement per group.
        Identifies the sweet spot where engagement is maximized.
        """
        df = self.df.copy()
        df = df.sort_values("published_at")

        if len(df) < 15:
            return {"status": "need_more_data"}

        # Group posts by week
        df["week_start"] = df["published_at"].dt.to_period("W").apply(
            lambda r: r.start_time
        )

        weekly = df.groupby("week_start").agg(
            post_count=("post_id", "count"),
            avg_engagement=("engagement_rate", "mean"),
            total_reach=("reach", "sum"),
            total_engagement=("engagement_total", "sum"),
        )

        if len(weekly) < 4:
            return {"status": "need_more_weeks"}

        # Group weeks by post count and find engagement per cadence
        cadence_perf = {}
        for count in sorted(weekly["post_count"].unique()):
            weeks_at_count = weekly[weekly["post_count"] == count]
            if len(weeks_at_count) >= 1:
                cadence_perf[int(count)] = {
                    "weeks_observed": len(weeks_at_count),
                    "avg_engagement_rate": round(float(weeks_at_count["avg_engagement"].mean()), 4),
                    "avg_total_reach": int(weeks_at_count["total_reach"].mean()),
                    "avg_total_engagement": int(weeks_at_count["total_engagement"].mean()),
                }

        # Find optimal cadence (best engagement rate with enough data)
        reliable = {k: v for k, v in cadence_perf.items() if v["weeks_observed"] >= 2}
        if reliable:
            optimal = max(reliable.items(), key=lambda x: x[1]["avg_engagement_rate"])
            max_reach = max(reliable.items(), key=lambda x: x[1]["avg_total_reach"])
        else:
            optimal = max(cadence_perf.items(), key=lambda x: x[1]["avg_engagement_rate"])
            max_reach = max(cadence_perf.items(), key=lambda x: x[1]["avg_total_reach"])

        current_cadence = round(weekly["post_count"].tail(4).mean(), 1)

        return {
            "status": "ok",
            "cadence_performance": cadence_perf,
            "optimal_for_engagement": {
                "posts_per_week": optimal[0],
                "avg_engagement_rate": optimal[1]["avg_engagement_rate"],
            },
            "optimal_for_reach": {
                "posts_per_week": max_reach[0],
                "avg_total_reach": max_reach[1]["avg_total_reach"],
            },
            "current_cadence": current_cadence,
            "recommendation": self._cadence_recommendation(current_cadence, optimal[0]),
        }

    @staticmethod
    def _cadence_recommendation(current, optimal):
        diff = optimal - current
        if abs(diff) < 0.5:
            return f"Your current pace (~{current:.0f}/week) is close to optimal ({optimal}/week). Maintain it."
        elif diff > 0:
            return f"Consider posting more: {optimal}/week is optimal, you're averaging {current:.0f}/week."
        else:
            return f"Consider posting less: {optimal}/week is optimal, you're averaging {current:.0f}/week. Quality over quantity."

    # ──────────────────────────────────────────
    # 9. AUDIENCE MOMENTUM SCORE
    # ──────────────────────────────────────────

    def _momentum_score(self) -> Dict:
        """
        Composite forward-looking score (0-100) combining:
        - Engagement trend (is it going up or down?)
        - Posting consistency (regular posting schedule?)
        - Reach growth (is reach expanding?)
        - Content quality trend (are recent posts better?)

        A high momentum score means things are accelerating.
        A low score means things are stalling.
        """
        df = self.df.copy()
        df = df.sort_values("published_at")

        if len(df) < 10:
            return {"status": "need_more_data"}

        now = df["published_at"].max()
        last_30 = df[df["published_at"] >= now - pd.Timedelta(days=30)]
        prev_30 = df[(df["published_at"] >= now - pd.Timedelta(days=60)) &
                     (df["published_at"] < now - pd.Timedelta(days=30))]

        # 1. Engagement Trend (0-25)
        if len(last_30) >= 3 and len(prev_30) >= 3:
            recent_eng = last_30["engagement_rate"].mean()
            prev_eng = prev_30["engagement_rate"].mean()
            eng_ratio = recent_eng / prev_eng if prev_eng > 0 else 1.0
            eng_score = min(25, max(0, (eng_ratio - 0.5) * 50))  # 0.5x=0, 1.0x=25, 1.5x=25
        else:
            eng_score = 12.5  # Neutral

        # 2. Posting Consistency (0-25)
        weeks = df.groupby(df["published_at"].dt.to_period("W")).size()
        if len(weeks) >= 4:
            recent_weeks = weeks.tail(4)
            consistency = 1.0 - (recent_weeks.std() / recent_weeks.mean() if recent_weeks.mean() > 0 else 1.0)
            consistency_score = max(0, min(25, consistency * 25))
            # Bonus for no gaps
            if recent_weeks.min() > 0:
                consistency_score = min(25, consistency_score + 5)
        else:
            consistency_score = 10

        # 3. Reach Growth (0-25)
        if len(last_30) >= 3 and len(prev_30) >= 3:
            recent_reach = last_30["reach"].mean()
            prev_reach = prev_30["reach"].mean()
            reach_ratio = recent_reach / prev_reach if prev_reach > 0 else 1.0
            reach_score = min(25, max(0, (reach_ratio - 0.5) * 50))
        else:
            reach_score = 12.5

        # 4. Content Quality Trend (0-25)
        # Compare composite signals: engagement_total, shares, saves
        quality_cols = [c for c in ["shares", "saves", "comments"] if c in df.columns]
        if quality_cols and len(last_30) >= 3 and len(prev_30) >= 3:
            recent_quality = last_30[quality_cols].sum().sum() / len(last_30)
            prev_quality = prev_30[quality_cols].sum().sum() / len(prev_30)
            quality_ratio = recent_quality / prev_quality if prev_quality > 0 else 1.0
            quality_score = min(25, max(0, (quality_ratio - 0.5) * 50))
        else:
            quality_score = 12.5

        total = round(eng_score + consistency_score + reach_score + quality_score, 1)

        # Interpret
        if total >= 75:
            verdict = "Strong momentum — your content strategy is accelerating"
        elif total >= 55:
            verdict = "Good momentum — steady growth, look for opportunities to push harder"
        elif total >= 35:
            verdict = "Moderate momentum — stable but not accelerating, consider experimenting"
        elif total >= 20:
            verdict = "Low momentum — engagement or reach may be stalling"
        else:
            verdict = "Warning — multiple signals declining, review content strategy"

        return {
            "status": "ok",
            "total_score": total,
            "max_possible": 100,
            "verdict": verdict,
            "breakdown": {
                "engagement_trend": round(eng_score, 1),
                "posting_consistency": round(consistency_score, 1),
                "reach_growth": round(reach_score, 1),
                "content_quality": round(quality_score, 1),
            },
            "detail": {
                "recent_30d_posts": len(last_30),
                "prev_30d_posts": len(prev_30),
                "recent_avg_engagement": round(float(last_30["engagement_rate"].mean()), 4) if len(last_30) > 0 else 0,
                "prev_avg_engagement": round(float(prev_30["engagement_rate"].mean()), 4) if len(prev_30) > 0 else 0,
            },
        }

    # ──────────────────────────────────────────
    # 10. ROOT CAUSE ANALYSIS (Feature Attribution)
    # ──────────────────────────────────────────

    def _root_cause_analysis(self) -> Dict:
        """
        For the top viral posts and worst flops, explain WHY using
        feature contribution analysis (similar to SHAP values).

        Uses the trained GradientBoosting model to decompose each
        post's predicted engagement into feature contributions.
        """
        if len(self.df) < self.MIN_POSTS_FOR_NN:
            return {"status": "need_more_data"}

        X = self.df[self.feature_cols].fillna(0).values
        y = self.df["engagement_rate"].values

        try:
            # Train a GradientBoosting model (tree-based = can extract contributions)
            from sklearn.ensemble import GradientBoostingRegressor
            gb = GradientBoostingRegressor(
                n_estimators=100, max_depth=3, learning_rate=0.1, random_state=42,
            )
            gb.fit(X, y, sample_weight=self.sample_weights)

            # Get predictions for all posts
            predictions = gb.predict(X)
            residuals = y - predictions

            # Find top overperformers and underperformers
            top_idx = np.argsort(residuals)[-3:][::-1]  # Top 3 overperformers
            bottom_idx = np.argsort(residuals)[:3]       # Top 3 underperformers

            # Feature contribution via individual conditional expectation
            # For each flagged post, measure how each feature shifts the prediction
            global_mean = predictions.mean()
            feature_names = self.feature_cols
            readable_names = {
                "hour": "Posting Hour", "day_of_week": "Day of Week",
                "is_weekend": "Weekend Post", "caption_length": "Caption Length",
                "hashtag_count": "Hashtags", "has_emoji": "Emoji Usage",
                "is_multilingual": "Multilingual", "duration_sec": "Video Duration",
                "is_short_video": "Short Video", "is_carousel": "Carousel",
                "is_image": "Single Image",
            }

            def _explain_post(idx):
                """Compute approximate feature contributions for a single post."""
                post_features = X[idx]
                contributions = []

                for i, feat_name in enumerate(feature_names):
                    # Baseline: set this feature to its mean, predict
                    X_modified = X[idx].copy()
                    X_modified[i] = X[:, i].mean()

                    baseline_pred = gb.predict(X_modified.reshape(1, -1))[0]
                    actual_pred = predictions[idx]
                    contribution = actual_pred - baseline_pred

                    if abs(contribution) > 0.001:  # Only significant contributions
                        readable = readable_names.get(feat_name, feat_name.replace("is_", "").replace("_", " ").title())
                        contributions.append({
                            "feature": readable,
                            "value": float(post_features[i]),
                            "contribution_pct": round(float(contribution * 100), 1),
                            "direction": "positive" if contribution > 0 else "negative",
                        })

                contributions.sort(key=lambda x: abs(x["contribution_pct"]), reverse=True)
                return contributions[:5]

            viral_explanations = []
            for idx in top_idx:
                row = self.df.iloc[idx]
                viral_explanations.append({
                    "title": row["title"][:60] if pd.notna(row["title"]) else "",
                    "actual_rate": round(float(y[idx]), 4),
                    "predicted_rate": round(float(predictions[idx]), 4),
                    "surplus": round(float(residuals[idx]), 4),
                    "permalink": row.get("permalink", ""),
                    "why": _explain_post(idx),
                })

            flop_explanations = []
            for idx in bottom_idx:
                row = self.df.iloc[idx]
                flop_explanations.append({
                    "title": row["title"][:60] if pd.notna(row["title"]) else "",
                    "actual_rate": round(float(y[idx]), 4),
                    "predicted_rate": round(float(predictions[idx]), 4),
                    "deficit": round(float(residuals[idx]), 4),
                    "permalink": row.get("permalink", ""),
                    "why": _explain_post(idx),
                })

            return {
                "status": "ok",
                "viral_explanations": viral_explanations,
                "flop_explanations": flop_explanations,
            }
        except Exception as e:
            return {"status": "failed", "error": str(e)}

    # ──────────────────────────────────────────
    # 11. TOPIC DISCOVERY (Semantic Clustering)
    # ──────────────────────────────────────────

    def _topic_discovery(self) -> Dict:
        """
        Discover content topics/themes from captions using semantic embeddings.
        Clusters posts by meaning (not just keywords) and tracks engagement per topic.
        Works across English, Korean, and Greek simultaneously.
        """
        if self.embeddings is None:
            return {"status": "no_embeddings"}

        df = self.df.copy()
        n = len(df)
        if n < 10:
            return {"status": "need_more_data"}

        try:
            # Determine number of clusters (3-8 based on data size)
            n_clusters = min(max(3, n // 15), 8)

            km = KMeans(n_clusters=n_clusters, random_state=42, n_init=10)
            df["topic_id"] = km.fit_predict(self.embeddings)

            # Name each topic by its most representative terms
            topics = []
            for tid in range(n_clusters):
                mask = df["topic_id"] == tid
                topic_posts = df[mask]

                if len(topic_posts) == 0:
                    continue

                # Get representative caption (closest to cluster center)
                center = km.cluster_centers_[tid]
                topic_embeddings = self.embeddings[mask.values]
                dists = np.linalg.norm(topic_embeddings - center, axis=1)
                best_idx = np.argmin(dists)
                representative = str(topic_posts.iloc[best_idx].get("title", ""))[:80]

                # Extract top keywords from topic captions
                captions = topic_posts["title"].fillna("").tolist()
                try:
                    tfidf = TfidfVectorizer(max_features=5, stop_words="english",
                                           token_pattern=r"(?u)\b[#\w][\w]{2,}\b")
                    tfidf.fit(captions)
                    keywords = list(tfidf.get_feature_names_out())
                except Exception:
                    keywords = []

                # Engagement stats
                w = topic_posts["weight"].values if "weight" in topic_posts.columns else np.ones(len(topic_posts))
                w_sum = w.sum()
                avg_eng = float(np.average(topic_posts["engagement_rate"].values, weights=w)) if w_sum > 0 else 0

                topics.append({
                    "topic_id": int(tid),
                    "post_count": len(topic_posts),
                    "keywords": keywords,
                    "representative_post": representative,
                    "avg_engagement_rate": round(avg_eng, 4),
                    "total_reach": int(topic_posts["reach"].sum()),
                    "content_types": topic_posts["content_type"].value_counts().to_dict(),
                })

            # Sort by engagement
            topics.sort(key=lambda x: x["avg_engagement_rate"], reverse=True)

            # Overall topic distribution
            overall_avg = float(df["engagement_rate"].mean())

            return {
                "status": "ok",
                "n_topics": n_clusters,
                "topics": topics,
                "best_topic": topics[0] if topics else None,
                "worst_topic": topics[-1] if topics else None,
                "overall_avg_engagement": round(overall_avg, 4),
            }
        except Exception as e:
            return {"status": "failed", "error": str(e)}

    # ──────────────────────────────────────────
    # 12. SIMILAR POST PREDICTOR
    # ──────────────────────────────────────────

    def _similar_post_predictor(self) -> Dict:
        """
        For each post, find the most similar past posts and predict engagement.
        Uses cosine similarity on semantic embeddings + content type matching.
        Shows which existing posts each new post resembles.
        """
        if self.embeddings is None:
            return {"status": "no_embeddings"}

        df = self.df.copy()
        n = len(df)
        if n < 10:
            return {"status": "need_more_data"}

        try:
            # Compute pairwise cosine similarity
            sim_matrix = cosine_similarity(self.embeddings)
            np.fill_diagonal(sim_matrix, 0)  # Don't match with self

            predictions = []
            errors = []

            for i in range(n):
                # Find top 5 most similar posts
                sim_scores = sim_matrix[i]
                top_k = min(5, n - 1)
                top_indices = np.argsort(sim_scores)[-top_k:][::-1]

                if len(top_indices) == 0:
                    continue

                # Weighted prediction: more similar posts get more weight
                neighbor_eng = df.iloc[top_indices]["engagement_rate"].values
                neighbor_sims = sim_scores[top_indices]

                if neighbor_sims.sum() > 0:
                    predicted = float(np.average(neighbor_eng, weights=neighbor_sims))
                else:
                    predicted = float(neighbor_eng.mean())

                actual = float(df.iloc[i]["engagement_rate"])
                error = actual - predicted
                errors.append(abs(error))

                predictions.append({
                    "post_idx": i,
                    "actual_rate": round(actual, 4),
                    "predicted_rate": round(predicted, 4),
                    "error": round(error, 4),
                    "top_similarity": round(float(sim_scores[top_indices[0]]), 3),
                })

            # Find most predictable and most surprising posts
            predictions.sort(key=lambda x: abs(x["error"]))
            most_predictable = predictions[:3]
            most_surprising = predictions[-3:][::-1]

            # Overall accuracy
            mae = float(np.mean(errors)) if errors else 0
            median_sim = float(np.median(sim_matrix[sim_matrix > 0])) if (sim_matrix > 0).any() else 0

            # Recent posts: predict what to expect from similar content
            recent_posts = []
            df_sorted = df.sort_values("published_at", ascending=False)
            for idx in df_sorted.index[:5]:
                i = df.index.get_loc(idx)
                sim_scores = sim_matrix[i]
                top_indices = np.argsort(sim_scores)[-3:][::-1]
                neighbor_eng = df.iloc[top_indices]["engagement_rate"].values
                neighbor_sims = sim_scores[top_indices]
                predicted = float(np.average(neighbor_eng, weights=neighbor_sims)) if neighbor_sims.sum() > 0 else float(neighbor_eng.mean())

                title = str(df.iloc[i].get("title", ""))[:60]
                similar_titles = [str(df.iloc[j].get("title", ""))[:40] for j in top_indices[:2]]

                recent_posts.append({
                    "title": title,
                    "actual_rate": round(float(df.iloc[i]["engagement_rate"]), 4),
                    "predicted_rate": round(predicted, 4),
                    "similar_to": similar_titles,
                    "similarity": round(float(sim_scores[top_indices[0]]), 3),
                })

            return {
                "status": "ok",
                "mean_absolute_error": round(mae, 4),
                "median_similarity": round(median_sim, 3),
                "most_predictable": most_predictable,
                "most_surprising": most_surprising,
                "recent_predictions": recent_posts,
            }
        except Exception as e:
            return {"status": "failed", "error": str(e)}

    # ──────────────────────────────────────────
    # 13. HASHTAG CLUSTER STRATEGY
    # ──────────────────────────────────────────

    def _hashtag_cluster_strategy(self) -> Dict:
        """
        Clusters hashtags into semantic groups using embeddings.
        Instead of analyzing individual hashtags, finds themes:
        e.g., '#orthodoxy #orthodox #church' = religion cluster.
        Tracks which clusters drive engagement.
        """
        if self.embeddings is None:
            return {"status": "no_embeddings"}

        df = self.df.copy()

        # Extract all hashtags from all captions
        all_hashtags = {}
        for idx, row in df.iterrows():
            caption = str(row.get("title", "") or "")
            tags = re.findall(r"#(\w{2,})", caption)
            eng_rate = float(row["engagement_rate"])
            for tag in tags:
                tag_lower = tag.lower()
                if tag_lower not in all_hashtags:
                    all_hashtags[tag_lower] = {"tag": f"#{tag_lower}", "posts": [], "engagement_rates": []}
                all_hashtags[tag_lower]["posts"].append(idx)
                all_hashtags[tag_lower]["engagement_rates"].append(eng_rate)

        if len(all_hashtags) < 3:
            return {"status": "insufficient_hashtags", "message": f"Only {len(all_hashtags)} unique hashtags found"}

        # Embed all hashtag texts
        hashtag_texts = [v["tag"] for v in all_hashtags.values()]
        hashtag_keys = list(all_hashtags.keys())
        tag_embeddings = _compute_embeddings(hashtag_texts)

        if tag_embeddings is None:
            return {"status": "embedding_failed"}

        try:
            # Cluster hashtags into semantic groups
            n_clusters = min(max(2, len(hashtag_keys) // 3), 6)
            km = KMeans(n_clusters=n_clusters, random_state=42, n_init=10)
            labels = km.fit_predict(tag_embeddings)

            clusters = []
            for cid in range(n_clusters):
                cluster_mask = labels == cid
                cluster_tags = [hashtag_keys[i] for i in range(len(hashtag_keys)) if cluster_mask[i]]

                if not cluster_tags:
                    continue

                # Aggregate engagement for this cluster
                all_eng = []
                all_posts = set()
                for tag in cluster_tags:
                    info = all_hashtags[tag]
                    all_eng.extend(info["engagement_rates"])
                    all_posts.update(info["posts"])

                avg_eng = float(np.mean(all_eng)) if all_eng else 0
                # Name cluster by top 3 hashtags (by post count)
                sorted_tags = sorted(cluster_tags, key=lambda t: len(all_hashtags[t]["posts"]), reverse=True)

                clusters.append({
                    "cluster_id": int(cid),
                    "top_hashtags": [f"#{t}" for t in sorted_tags[:5]],
                    "total_hashtags": len(cluster_tags),
                    "total_posts": len(all_posts),
                    "avg_engagement_rate": round(avg_eng, 4),
                    "label": " / ".join(sorted_tags[:3]),
                })

            clusters.sort(key=lambda x: x["avg_engagement_rate"], reverse=True)

            # Individual hashtag performance (top 10)
            top_hashtags = []
            for tag, info in all_hashtags.items():
                if len(info["posts"]) >= 2:
                    top_hashtags.append({
                        "tag": f"#{tag}",
                        "post_count": len(info["posts"]),
                        "avg_engagement": round(float(np.mean(info["engagement_rates"])), 4),
                    })
            top_hashtags.sort(key=lambda x: x["avg_engagement"], reverse=True)

            return {
                "status": "ok",
                "n_clusters": n_clusters,
                "clusters": clusters,
                "best_cluster": clusters[0] if clusters else None,
                "top_individual_hashtags": top_hashtags[:10],
                "total_unique_hashtags": len(all_hashtags),
            }
        except Exception as e:
            return {"status": "failed", "error": str(e)}

    # ──────────────────────────────────────────
    # HELPERS
    # ──────────────────────────────────────────

    @staticmethod
    def _interpret_r2(r2: float) -> str:
        if r2 >= 0.8:
            return "Excellent — the model captures most engagement patterns"
        elif r2 >= 0.5:
            return "Good — the model captures significant patterns"
        elif r2 >= 0.3:
            return "Moderate — some patterns detected, more data will improve accuracy"
        elif r2 >= 0:
            return "Weak — engagement may be driven by factors not captured in the data"
        else:
            return "Poor fit — engagement appears highly unpredictable from available features"


def run_ml(df: pd.DataFrame, platform: str) -> Dict[str, Any]:
    """Convenience function to run ML analysis for a single platform."""
    engine = MLEngine(df, platform)
    return engine.run_all()
