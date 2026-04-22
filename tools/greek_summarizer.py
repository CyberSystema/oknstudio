#!/usr/bin/env python3
import json
import re
import sys
from typing import List

import numpy as np
from sentence_transformers import SentenceTransformer

MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"


def split_sentences(text: str) -> List[str]:
    if not text:
        return []

    normalized = re.sub(r"\s+", " ", text).strip()
    if not normalized:
        return []

    parts = re.split(r"(?<=[\.!;;\?])\s+", normalized)
    sentences = []
    for part in parts:
        chunk = part.strip()
        if len(chunk) >= 25:
            sentences.append(chunk)
    return sentences


def cosine_similarity_matrix(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    a_norm = a / np.maximum(np.linalg.norm(a, axis=1, keepdims=True), 1e-12)
    b_norm = b / np.maximum(np.linalg.norm(b, axis=1, keepdims=True), 1e-12)
    return a_norm @ b_norm.T


def summarize(text: str, max_sentences: int = 3) -> str:
    sentences = split_sentences(text)
    if not sentences:
        return "Δεν υπάρχει επαρκές κείμενο για σύνοψη."

    if len(sentences) <= max_sentences:
        return " ".join(sentences)

    model = SentenceTransformer(MODEL_NAME)

    sent_embeddings = model.encode(sentences, normalize_embeddings=False)
    doc_embedding = model.encode([" ".join(sentences)], normalize_embeddings=False)

    sims = cosine_similarity_matrix(sent_embeddings, doc_embedding).reshape(-1)

    # Keep the strongest sentences, then restore original order for readability.
    top_indices = np.argsort(-sims)[:max_sentences]
    top_indices = sorted(int(i) for i in top_indices)

    selected = [sentences[i] for i in top_indices]
    return " ".join(selected)


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        print(json.dumps({"error": "No input payload"}, ensure_ascii=False))
        return 1

    payload = json.loads(raw)
    text = str(payload.get("text") or "").strip()
    title = str(payload.get("title") or "").strip()
    max_sentences = int(payload.get("max_sentences") or 3)

    source = "\n\n".join(part for part in [title, text] if part)
    summary = summarize(source, max_sentences=max_sentences)

    print(json.dumps({"summary": summary}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
