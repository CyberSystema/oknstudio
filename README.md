<div align="center">

<img src="assets/okn_logo.png" alt="OKN" width="140">

<br>

# OKN Studio

**The digital workspace for the Orthodox Korea Network**

[![Live](https://img.shields.io/badge/Live-oknstudio.cybersystema.com-1a3a5c?style=flat-square)](https://oknstudio.cybersystema.com)
[![Python 3.11+](https://img.shields.io/badge/Python-3.11+-3776AB?style=flat-square&logo=python&logoColor=white)](https://python.org)

</div>

---

A unified platform for the OKN content team — analytics, production tools, and media management in one place. Built on Cloudflare Pages with a Python ML pipeline.

## Tools

| Tool | Status | URL | Description |
|---|---|---|---|
| **Analytics** | ✅ Live | `/analytics/` | Social media intelligence — 14 ML models, automated reports |
| **Upload** | ✅ Live | `/analytics/upload` | Drag & drop CSV exports with auto-detection |
| **Calendar** | 🔜 Planned | `/calendar/` | Team content calendar |
| **Media Pool** | ✅ Live | `/media/` | Private media library (Backblaze B2) |

## Architecture

```
oknstudio/
├── site/                          ← Deployed (public website)
│   ├── index.html                 ← Landing page
│   ├── 404.html
│   ├── analytics/
│   │   ├── index.html             ← Analytics home
│   │   ├── report.html            ← Generated report
│   │   └── upload.html            ← Upload page
│   └── media/
│       └── index.html             ← Media browser
├── assets/                        ← Logos (source of truth)
├── functions/                     ← Cloudflare Functions
│   ├── _middleware.js             ← Site-wide auth
│   └── api/
│       ├── analytics/upload.js   ← Upload API
│       └── media/                 ← Media Pool API
│           ├── list.js            ← List files/folders from B2
│           └── download/[[path]].js ← Proxy downloads from B2
├── analytics-pipeline/            ← Private (never deployed)
│   ├── scripts/                   ← Python pipeline
│   ├── models/                    ← ML models
│   ├── data/                      ← CSV exports
│   └── history/                   ← Historical data
├── tools/                          ← Operational scripts
│   └── bucket-map.py              ← Daily B2 structure → Google Drive
└── .github/workflows/
    ├── analytics.yml              ← Pipeline workflow
    ├── bucket-map.yml             ← Daily bucket map → Google Drive
    └── deploy.yml                 ← Deploy workflow
```

## Workflows

**Analytics Pipeline** (`analytics.yml`) — triggers on data/script changes + weekly Monday 09:00 KST:

```
Upload CSV → pipeline runs → report generated → committed to site/analytics/
```

**Deploy** (`deploy.yml`) — triggers on any push to `site/`, `functions/`, or `assets/`:

```
Push to site/ → copy assets → npm install → deploy to Cloudflare Pages
```

**Bucket Map** (`bucket-map.yml`) — daily at 06:00 UTC + manual trigger:

```
List B2 bucket → generate HTML directory map → upload to shared Google Drive folder
```

## Setup

### Cloudflare Environment Variables

Set via Cloudflare Pages dashboard or `wrangler pages secret put`:

| Variable | Description |
|---|---|
| `SITE_PASSWORD_HASH` | SHA-256 hash of the site-wide password |
| `UPLOAD_PASSWORD_HASH` | SHA-256 hash of the upload password |
| `GITHUB_PAT` | Fine-grained GitHub token (Contents: Read+Write) |
| `GITHUB_REPO` | `CyberSystema/oknstudio` |
| `TOKEN_SECRET` | Random string for HMAC signing |
| `B2_KEY_ID` | Backblaze B2 Application Key ID |
| `B2_APP_KEY` | Backblaze B2 Application Key (secret) |
| `B2_ENDPOINT` | B2 S3 endpoint (e.g. `s3.eu-central-003.backblazeb2.com`) |
| `B2_BUCKET` | B2 bucket name (e.g. `okn-media-archive`) |

### GitHub Secrets

Set in GitHub repo Settings → Secrets and variables → Actions → Secrets:

| Secret | Description |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare Pages deploy token |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `B2_KEY_ID` | Same as Cloudflare (used by bucket-map workflow) |
| `B2_APP_KEY` | Same as Cloudflare (used by bucket-map workflow) |
| `B2_ENDPOINT` | Same as Cloudflare (used by bucket-map workflow) |
| `B2_BUCKET` | Same as Cloudflare (used by bucket-map workflow) |
| `RCLONE_GDRIVE_TOKEN` | rclone Google Drive OAuth token JSON (see below) |

### GitHub Variables

Set in GitHub repo Settings → Secrets and variables → Actions → Variables:

| Variable | Value |
|---|---|
| `GDRIVE_REMOTE_NAME` | `gdrive` (or `gdrive-shared`) |
| `GDRIVE_BUCKET_MAP_FOLDER` | Shared folder name on Drive (e.g. `OKN Media Archive`) |

### Generate password hash

```bash
echo -n "YOUR_PASSWORD" | shasum -a 256
```

### Extract Google Drive token for CI

After configuring `rclone` with Google Drive locally (see SSH workflow), extract the token:

```bash
rclone config dump | python3 -c "import sys,json; print(json.dumps(json.loads(sys.stdin.read())['gdrive']['token']))"
```

Copy the entire JSON string and add it as the `RCLONE_GDRIVE_TOKEN` secret in GitHub.

## License

Internal tool for the Orthodox Korea Network.

---

<div align="center">

<a href="https://cybersystema.com">
<img src="assets/cybersystema_logo.png" alt="CyberSystema" width="60">
</a>

<br>

Built by [Nikolaos Pinatsis](https://github.com/CyberSystema) · [cybersystema.com](https://cybersystema.com)

</div>
