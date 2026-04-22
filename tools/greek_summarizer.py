#!/usr/bin/env python3
import json
import re
import sys
from typing import List

import numpy as np
from sentence_transformers import SentenceTransformer

MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
_MODELS = {}


def get_model(model_name: str = MODEL_NAME) -> SentenceTransformer:
    key = (model_name or MODEL_NAME).strip()
    if key not in _MODELS:
        _MODELS[key] = SentenceTransformer(key)
    return _MODELS[key]


def normalize_text(text: str) -> str:
    if not text:
        return ""

    cleaned = str(text)
    # Remove obvious web/navigation noise.
    cleaned = re.sub(r"https?://\S+", " ", cleaned)
    cleaned = re.sub(r"\b(?:share|cookie|privacy|menu|search|login|subscribe)\b", " ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"[\|•►▶★☆]+", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def sentence_quality(sentence: str) -> bool:
    s = sentence.strip()
    if len(s) < 35 or len(s) > 320:
        return False

    greek = len(re.findall(r"[\u0370-\u03FF\u1F00-\u1FFF]", s))
    alpha = len(re.findall(r"[A-Za-z\u0370-\u03FF\u1F00-\u1FFF]", s))
    if alpha == 0:
        return False

    # Prefer Greek-heavy, prose-like lines.
    if greek < 15:
        return False
    if s.count("@") == 1 and " " not in s:
        return False
    # Reject fragments with unbalanced parentheses (cut-off mid-sentence artifacts).
    if s.count("(") != s.count(")"):
        return False
    return True


def split_sentences(text: str) -> List[str]:
    if not text:
        return []

    normalized = normalize_text(text)
    if not normalized:
        return []

    parts = re.split(r"(?<=[\.!;;\?])\s+", normalized)
    sentences = []
    seen = set()
    for part in parts:
        chunk = part.strip()
        if not sentence_quality(chunk):
            continue
        key = chunk.casefold()
        if key in seen:
            continue
        seen.add(key)
        sentences.append(chunk)
    return sentences


def cosine_similarity_matrix(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    a_norm = a / np.maximum(np.linalg.norm(a, axis=1, keepdims=True), 1e-12)
    b_norm = b / np.maximum(np.linalg.norm(b, axis=1, keepdims=True), 1e-12)
    return a_norm @ b_norm.T


def summarize(text: str, max_sentences: int = 3, model_name: str = MODEL_NAME, title: str = "") -> str:
    # Sentences come only from the body text, never from the title.
    sentences = split_sentences(text)
    if not sentences:
        return "Δεν υπάρχει επαρκές κείμενο για σύνοψη."

    if len(sentences) <= max_sentences:
        return " ".join(sentences)

    model = get_model(model_name)

    sent_embeddings = model.encode(sentences, normalize_embeddings=False)
    # Include title in document context so relevance scoring stays on-topic.
    doc_context = " ".join(part for part in [title, " ".join(sentences)] if part)
    doc_embedding = model.encode([doc_context], normalize_embeddings=False)

    sims = cosine_similarity_matrix(sent_embeddings, doc_embedding).reshape(-1)

    # Keep strong and diverse sentences (simple MMR-like penalty).
    ranked = list(np.argsort(-sims))
    selected = []
    selected_set = set()

    for idx in ranked:
        i = int(idx)
        if i in selected_set:
            continue

        penalty = 0.0
        if selected:
            sim_to_selected = cosine_similarity_matrix(
                sent_embeddings[[i]],
                sent_embeddings[[j for j in selected]],
            ).reshape(-1)
            penalty = float(np.max(sim_to_selected)) if sim_to_selected.size else 0.0

        score = float(sims[i]) - 0.25 * penalty
        if score < 0.05:
            continue

        selected.append(i)
        selected_set.add(i)
        if len(selected) >= max_sentences:
            break

    if not selected:
        selected = [int(i) for i in np.argsort(-sims)[:max_sentences]]

    selected = [sentences[i] for i in sorted(selected)]
    summary = " ".join(selected).strip()

    # Final polish.
    summary = re.sub(r"\s+([,.;:!?])", r"\1", summary)
    summary = re.sub(r"\s+", " ", summary).strip()
    return summary or "Δεν υπάρχει επαρκές κείμενο για σύνοψη."


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        print(json.dumps({"error": "No input payload"}, ensure_ascii=False))
        return 1

    payload = json.loads(raw)
    text = str(payload.get("text") or "").strip()
    title = str(payload.get("title") or "").strip()
    max_sentences = int(payload.get("max_sentences") or 3)
    model_name = str(payload.get("model_name") or MODEL_NAME).strip() or MODEL_NAME

    # Pass title separately so it is used for context but not as a sentence candidate.
    summary = summarize(text, max_sentences=max_sentences, model_name=model_name, title=title)

    print(json.dumps({"summary": summary}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
