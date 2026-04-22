<div align="center">

<img src="assets/okn_logo.png" alt="OKN" width="140">

<br>

# OKN Studio

**Signal Studio — the integrated workbench of the Orthodox Korea Network**

[![Live](https://img.shields.io/badge/Live-oknstudio.cybersystema.com-5eead4?style=flat-square)](https://oknstudio.cybersystema.com)
[![Python 3.11+](https://img.shields.io/badge/Python-3.11+-3776AB?style=flat-square&logo=python&logoColor=white)](https://python.org)
[![Cloudflare Pages](https://img.shields.io/badge/Cloudflare-Pages-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://pages.cloudflare.com)

</div>

---

A unified workbench for the OKN social-media team — analytics, media pool, ingest pipeline, and a forthcoming calendar. Static HTML on Cloudflare Pages, Cloudflare Functions for auth and media proxy, a Python ML pipeline in the background.

## Modules

| Module | Status | URL | Description |
|---|---|---|---|
| **Analytics** | ✅ Live | `/analytics/` | Social-media intelligence report — 14 ML models, auto-generated weekly |
| **Ingest** | ✅ Live | `/analytics/upload` | Drag-and-drop CSV uploads with platform auto-detection |
| **Media Pool** | ✅ Live | `/media/` | Private media library (Backblaze B2, authenticated proxy downloads, lazy thumbs) |
| **Darkroom** | ✅ Live | `/darkroom/` | Photo workflow station — rename / resize / strip / attribute / archive. Originals never touched. |
| **Calendar** | 🔧 In Development | `/calendar/` | Liturgical + editorial year, iCal feed (Q2 2026) |
| **Colophon** | ✅ Live | `/colophon/` | Design-system reference: typography, palette, components, stack |

## Architecture

```
oknstudio/
├── site/                          ← Deployed (public website)
│   ├── index.html                 ← Signal Studio landing
│   ├── 404.html                   ← "Signal Lost"
│   ├── favicon.svg                ← Network-cross mark
│   ├── analytics/
│   │   ├── index.html             ← Analytics hub
│   │   ├── report.html            ← Generated report (Signal Studio dark)
│   │   ├── full_results.json      ← Pipeline summary artefact
│   │   └── upload.html            ← Ingest
│   ├── calendar/
│   │   └── index.html             ← In-development page
│   ├── colophon/
│   │   └── index.html             ← Design-system reference
│   ├── darkroom/                   ← Photo workflow station (Phase 1 ships Batch Rename)
│   │   ├── index.html
│   │   └── lib/                    ← ESM modules loaded directly by the browser
│   │       ├── app.js              ← Controller — DOM wiring, dry-run, history
│   │       ├── i18n.js, messages.en.js
│   │       ├── engines/rename.js   ← Rename token grammar + collision resolver
│   │       ├── engines/rename.test.mjs ← 41 tests, zero deps (node --test)
│   │       ├── job/                ← intake.js · zipper.js · dispatcher.js
│   │       ├── storage/            ← db.js · settings.js · history.js (IndexedDB)
│   │       └── zones/              ← registry.js · batch-rename.js
│   └── media/
│       └── index.html             ← Media Pool browser
├── assets/                        ← Logo sources (baked into reports via base64)
├── functions/                     ← Cloudflare Functions
│   ├── _middleware.js             ← Site-wide HMAC auth + Signal Studio login page
│   ├── share.js                   ← Dynamic share-card SVG (edge-rendered, public, parametric)
│   └── api/
│       ├── analytics/upload.js    ← Upload endpoint
│       └── media/
│           ├── list.js            ← List B2 prefix (30-min edge cache)
│           └── download/[[path]].js ← Authenticated download proxy (24-h download cache)
├── analytics-pipeline/            ← Private, never deployed
│   ├── scripts/                   ← config.py · report.py · analyze.py · ingest*.py · main.py
│   ├── models/                    ← Trained ML artefacts
│   ├── data/                      ← Raw CSV exports
│   └── history/                   ← Historical runs
├── tools/                         ← Operational tooling
│   └── bucket-map.py              ← Daily B2 → Google Drive HTML map
└── .github/workflows/
    ├── analytics.yml              ← Weekly ML pipeline + report generation
    ├── bucket-map.yml             ← Daily B2 structure → Drive
    └── deploy.yml                 ← Cloudflare Pages deploy
```

## Workflows

**Analytics Pipeline** (`analytics.yml`) — triggers on push to `analytics-pipeline/{data,scripts,models}/` + cron Monday 00:00 UTC (09:00 KST):

```
CSV uploads → pipeline runs → charts + report.html + full_results.json → commit → deploy
```

**Deploy** (`deploy.yml`) — push to `site/` / `functions/` / `assets/` / `package.json` + auto-trigger after analytics:

```
Push → npm install aws4fetch → wrangler pages deploy site/ --project-name=oknstudio
```

**Bucket Map** (`bucket-map.yml`) — daily 06:00 UTC + manual:

```
rclone ls B2 → render HTML tree → rclone copyto shared Google Drive folder
```

## Setup

### Cloudflare Pages — secrets (runtime)

Set via the Cloudflare Pages dashboard or `wrangler pages secret put`:

| Variable | Purpose |
|---|---|
| `SITE_PASSWORD_HASH` | SHA-256 of the site-wide login password |
| `UPLOAD_PASSWORD_HASH` | SHA-256 of the analytics-upload password |
| `TOKEN_SECRET` | Random string — HMAC key for the 30-day session cookie |
| `GITHUB_PAT` | Fine-grained GitHub token (Contents: Read+Write) — writes uploaded CSVs back into the repo |
| `GITHUB_REPO` | `CyberSystema/oknstudio` |
| `B2_KEY_ID` | Backblaze B2 Application Key ID (use the **read-only** key here) |
| `B2_APP_KEY` | Backblaze B2 Application Key (read-only) |
| `B2_ENDPOINT` | `s3.eu-central-003.backblazeb2.com` |
| `B2_BUCKET` | `okn-media-archive` |

### GitHub Actions — secrets

| Secret | Purpose |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Pages deploy permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Your account ID |
| `RESEND_API_KEY` | API key for weekly email delivery (Resend) |
| `WEEKLY_DIGEST_FROM` | Verified sender, e.g. `OKN Digest <digest@updates.cybersystema.com>` |
| `WEEKLY_DIGEST_RECIPIENTS` | Comma-separated target emails for weekly digest |
| `B2_KEY_ID` | B2 key with **read+write** (used by bucket-map to list everything) |
| `B2_APP_KEY` | B2 key (read+write variant) |
| `B2_ENDPOINT` | `s3.eu-central-003.backblazeb2.com` |
| `B2_BUCKET` | `okn-media-archive` |
| `RCLONE_GDRIVE_TOKEN` | JSON OAuth token — extract instructions below |

### GitHub Actions — variables

| Variable | Value |
|---|---|
| `GDRIVE_REMOTE_NAME` | `gdrive-okn` |
| `GDRIVE_BUCKET_MAP_FOLDER` | `OKN Videos and Posts` |

### Generate a password hash

```bash
echo -n "YOUR_PASSWORD" | shasum -a 256
```

### Extract the Google Drive OAuth token for CI

After configuring `rclone` with your Drive locally:

```bash
rclone config dump | \
  python3 -c "import sys,json; print(json.dumps(json.loads(sys.stdin.read())['gdrive-okn']['token']))"
```

Copy the entire JSON string and paste it as the `RCLONE_GDRIVE_TOKEN` secret.

### Social share card

The `og:image` for every page is rendered dynamically on the edge by
[`functions/share.js`](functions/share.js) and served unauthenticated at
`/share` as `image/svg+xml`. There is no build step.

The endpoint is parametric — each page supplies its own card by
query-stringing the values it wants:

```
/share
  ?variant=landing|module|article|status
  &title=<string>
  &sub=<string>
  &kicker=<string>
  &tone=mint|ok|warn|down|violet|amber
  &chips=Analytics,Media,Darkroom,Reports   # landing variant only
  &meter=0-100                               # status variant only
```

All inputs are length-capped, XML-escaped, and enum-validated before
interpolation.

## Weekly Post Digest

`weekly-digest.yml` sends a weekly email with only the Greek posts published in the last 7 days on `https://orthodoxkorea.org`.

- If Greek posts exist, each email item includes title + link + date + AI summary in Greek.
- If no Greek posts exist, the email says there were no new Greek posts this week.
- Summaries are generated locally by an ML model (sentence-transformers), not an external AI API.

### Trigger

- Automatic: every Monday at `00:15 UTC` (`09:15 KST`)
- Manual: GitHub Actions → **Weekly Orthodox Korea Digest** → **Run workflow**

### Required secrets

- `RESEND_API_KEY`
- `WEEKLY_DIGEST_FROM` (e.g. `OKN Updates <okn@updates.cybersystema.com>`)
- `WEEKLY_DIGEST_RECIPIENT` (single email) or
- `WEEKLY_DIGEST_RECIPIENTS` (list separated by comma, semicolon, or newline)

### Local dry run (no email sent)

```bash
WEEKLY_DIGEST_DRY_RUN=true \
WEEKLY_DIGEST_FROM="OKN Digest <digest@updates.cybersystema.com>" \
WEEKLY_DIGEST_RECIPIENTS="you@example.com" \
node tools/weekly-digest.mjs
```

Script: `tools/weekly-digest.mjs`
Workflow: `.github/workflows/weekly-digest.yml`

## Design

OKN Studio ships in a single visual language — **Signal Studio**. A broadcast-engineering console crossed with a modern developer tool: dark ink backdrop, one confident mint-teal accent (`#5eead4`), Sora + IBM Plex for typography, a network-graph mark that doubles as the brand. Every module — analytics, media, ingest, calendar, colophon — reads from the same token set.

Open `/colophon/` on the live site for the full reference (typography, palette, components, stack).

## License

Internal tool for the Orthodox Metropolis of Korea. Source available for reference and adaptation.

---

<div align="center">

<a href="https://cybersystema.com">
<img src="assets/cybersystema_logo.png" alt="CyberSystema" width="60">
</a>

<br>

Built by [Nikolaos Pinatsis](https://github.com/CyberSystema) · [cybersystema.com](https://cybersystema.com) · Larissa → Seoul

</div>
