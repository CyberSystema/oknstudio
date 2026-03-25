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
| **Media Pool** | 🔜 Planned | `/media-pool/` | Shared media storage |

## Architecture

```
oknstudio/
├── site/                          ← Deployed (public website)
│   ├── index.html                 ← Landing page
│   ├── 404.html
│   └── analytics/
│       ├── index.html             ← Analytics home
│       ├── report.html            ← Generated report
│       └── upload.html            ← Upload page
├── assets/                        ← Logos (source of truth)
├── functions/                     ← Cloudflare Functions
│   ├── _middleware.js             ← Site-wide auth
│   └── api/analytics/upload.js   ← Upload API
├── analytics-pipeline/            ← Private (never deployed)
│   ├── scripts/                   ← Python pipeline
│   ├── models/                    ← ML models
│   ├── data/                      ← CSV exports
│   └── history/                   ← Historical data
└── .github/workflows/
    ├── analytics.yml              ← Pipeline workflow
    └── deploy.yml                 ← Deploy workflow
```

## Workflows

**Analytics Pipeline** (`analytics.yml`) — triggers on data/script changes + weekly Monday 09:00 KST:

```
Upload CSV → pipeline runs → report generated → committed to site/analytics/
```

**Deploy** (`deploy.yml`) — triggers on any push to `site/`, `functions/`, or `assets/`:

```
Push to site/ → copy assets → deploy to Cloudflare Pages
```

## Setup

### Cloudflare Environment Variables

| Variable | Description |
|---|---|
| `SITE_PASSWORD_HASH` | SHA-256 hash of the site-wide password |
| `UPLOAD_PASSWORD_HASH` | SHA-256 hash of the upload password |
| `GITHUB_PAT` | Fine-grained GitHub token (Contents: Read+Write) |
| `GITHUB_REPO` | `CyberSystema/oknstudio` |
| `TOKEN_SECRET` | Random string for HMAC signing |
| `CLOUDFLARE_API_TOKEN` | Cloudflare Pages deploy token (GitHub secret) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID (GitHub secret) |

### Generate password hash

```bash
echo -n "YOUR_PASSWORD" | shasum -a 256
```

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
