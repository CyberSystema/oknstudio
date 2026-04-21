# OKN Analytics Pipeline

Python pipeline that ingests social platform exports (Instagram, TikTok, Facebook, YouTube), merges them with historical account snapshots, and emits ML-driven reports / recommendations.

## Layout

```
analytics-pipeline/
  data/<platform>/      Raw CSV / JSON / XLSX exports, dropped in by the upload UI.
  history/              Unified account-level + demographics history (append-only).
  models/               Forecasting, scoring, timing, ML engine.
  scripts/              Entry points — see below.
  requirements.txt
```

### Entry points (`scripts/`)
- `main.py` — the pipeline runner used by CI. Calls `ingest` → `analyze` → `report`.
- `ingest.py` — loads per-post exports, normalises to `UNIFIED_SCHEMA`, merges with history.
- `ingest_account.py` — pulls account-level daily metrics (reach, views, visits…).
- `ingest_tiktok.py` — TikTok-specific account + demographics import.
- `analyze.py` — derives metrics, segments, and insights from the unified frame.
- `report.py` — renders HTML + JSON report artefacts to `site/analytics/`.
- `config.py` — platform directory map, schema, timezone helpers.

## Running locally

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r analytics-pipeline/requirements.txt
python analytics-pipeline/scripts/main.py
```

The venv is reused by the VS Code Python extension — activate it before running anything.

## Data safety

`ingest.py` enforces:

- **50 MB file cap** per CSV / XLSX to prevent OOM from bad exports.
- **Strict Unicode-aware encodings** (utf-8, utf-8-sig, cp949, euc-kr). No `latin-1`
  fallback — that silently produced mojibake for Korean text.
- **CSV-formula-injection neutralisation** on all string columns (leading
  `=`, `+`, `-`, `@`, tab, CR are escaped with a `'` prefix so downstream
  Excel / Sheets consumers don't execute them).

## Environment

The ingestors write to GitHub via the `/api/analytics/upload` Pages Function.
Required Cloudflare env vars for the uploader are documented in
[`functions/README.md`](../functions/README.md).
