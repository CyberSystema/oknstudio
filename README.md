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
| `RESEND_API_KEY` | API key for digest review/final email delivery |
| `WEEKLY_DIGEST_FROM` | Verified sender, e.g. `OKN Digest <digest@updates.cybersystema.com>` |
| `WEEKLY_DIGEST_REVIEW_RECIPIENTS` | Your private review inbox or inboxes |
| `WEEKLY_DIGEST_RECIPIENTS` | Final recipient list for the approved digest |
| `WEEKLY_DIGEST_SITE_URL` | Source site, default `https://orthodoxkorea.org` |
| `WEEKLY_DIGEST_LOOKBACK_DAYS` | Lookback window, default `15` |
| `WEEKLY_DIGEST_CLAUDE_MODEL` | Optional Anthropic model override |
| `WEEKLY_DIGEST_CLAUDE_MAX_TOKENS` | Optional Anthropic token cap |
| `WEEKLY_DIGEST_SUMMARY_MAX_SENTENCES` | Optional summary length cap |
| `DIGEST_CRON_SECRET` | Shared secret for the optional Cloudflare cron draft trigger |

### GitHub Actions — secrets

| Secret | Purpose |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Pages deploy permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Your account ID |
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

The digest workflow now lives inside the private OKN admin panel. There is no GitHub Actions digest workflow anymore.

### Admin workflow

- Generate a 15-day draft from the admin console.
- The backend fetches recent Orthodox Korea posts, filters Greek entries, summarizes them with Anthropic, and stores the draft in KV.
- Review and correct summaries inside the admin UI.
- Send a private review email to yourself.
- Send the final email only when the draft is approved.

### Optional Cloudflare-native cron draft trigger

An optional separate Cloudflare Worker can create the draft on a schedule without sending email and without switching the Pages project into advanced mode.

Files:
- `functions/api/internal/digest-draft.js` — secret-protected Pages endpoint that only creates the draft.
- `workers/digest-cron.mjs` — scheduled Worker that calls the Pages endpoint.
- `wrangler.digest-cron.jsonc` — Worker config with the 1st and 16th at `00:15 UTC` cron.

Required Worker secrets/vars:
- `DIGEST_CRON_SECRET` — must match the Pages runtime secret of the same name.
- `DIGEST_CRON_TARGET_URL` — optional full URL to the Pages endpoint.
- `DIGEST_CRON_API_BASE_URL` — optional fallback base URL for the Pages Functions host (for example `https://oknstudio.pages.dev`).
  If `DIGEST_CRON_TARGET_URL` is omitted, the Worker derives it from `DIGEST_CRON_API_BASE_URL` plus `/api/internal/digest-draft`.

Deploy the scheduled Worker separately from the Pages project:

```bash
npx wrangler deploy -c wrangler.digest-cron.jsonc
```

The cron path is idempotent for a given digest window: if a draft for the current window already exists, it returns the existing draft instead of overwriting editorial changes.

### Local script

`tools/weekly-digest.mjs` still exists for local/manual use, but it is no longer the production automation path.

## Autonomy & Self-Maintenance

This repo now treats self-maintenance as a first-class requirement, not an assumption.

### What is already autonomous

- GitHub Actions covers deploys, analytics generation, and bucket-map refreshes.
- Dependabot updates npm, Python pipeline, and GitHub Actions dependencies on a schedule.
- Cloudflare Pages Functions expose owner-only operational endpoints for runtime readiness, probes, logs, and control-center data.
- The optional digest cron Worker can generate draft emails on schedule without manual intervention.

### Repo autonomy audit

Run the repo audit locally:

```bash
npm run autonomy:check
```

For machine-readable output:

```bash
node tools/autonomy-audit.mjs --json --strict
```

The audit verifies the minimum self-maintenance contract:

- core automation files exist;
- verification scripts stay wired into normal development;
- CI continues to run the autonomy audit;
- dependency update automation remains enabled;
- the runtime operational surfaces stay documented.

The script exits non-zero only for critical autonomy regressions, so it can be used safely in CI without creating noise from lower-priority recommendations.

### Live autonomy report

The deployed admin surface now exposes a machine-readable runtime survivability report at `/api/admin/autonomy`.

It is owner-gated like the rest of `/api/admin/*` and summarizes:

- configuration continuity for auth, media, ingest, digest, and log durability;
- first-party control-plane probe results;
- recent operational evidence from the unified log store;
- external dependency continuity for Cloudflare, GitHub, Backblaze, Anthropic, and Resend;
- top recovery actions in priority order.

The owner admin console reads this endpoint directly so the live system can explain its own maintainability state without requiring local repo access.

### Scheduled autonomy watch

GitHub Actions also runs a scheduled `Autonomy Watch` workflow to detect drift even when no code changes are being made. It executes the normal verification path, generates a JSON autonomy report artifact, and writes a concise summary into the workflow run.

### Automatic incident escalation

`Autonomy Escalation` listens to `Autonomy Watch` results and converts failures into a tracked GitHub issue automatically.

- On watch failure: opens (or updates) one incident issue labeled `autonomy-alert`.
- On watch recovery: comments and closes that incident issue automatically.

This ensures autonomy regressions are preserved as actionable backlog items even if no one is actively watching Actions in real time.

### Automatic self-healing

`Autonomy Self-Heal` runs after failed `Autonomy Watch` executions and attempts a narrow, deterministic set of repository repairs.

- It runs `tools/autonomy-self-heal.mjs` in dry-run and apply mode.
- It re-runs `npm run verify` after repairs.
- If successful, it opens an automatic PR with the repairs for review.

Current healing scope is intentionally conservative:

- restore `autonomy:check` and `verify` script wiring in `package.json`;
- restore autonomy audit step in `type-check.yml`;
- restore critical verification/schedule wiring in `autonomy-watch.yml`.

This creates a safe self-healing loop without giving automation permission to make broad or irreversible code changes.

### Environment recovery playbooks

The live autonomy endpoint now returns generated environment recovery playbooks (`recoveryPlaybooks`) for common non-code failures.

- Missing Pages runtime secrets are mapped to deterministic `wrangler pages secret put` command templates.
- Missing KV bindings are surfaced as explicit binding runbooks.
- GitHub Actions secret continuity includes a `gh secret set` command pack for fast restoration.

These playbooks are rendered directly in the owner admin autonomy panel, including one-click copy for each command set.

Incident playbooks are attached automatically to `Autonomy Watch incident` issues via the escalation workflow, so each failure ticket carries immediate recovery command packs.

### Dependabot guarded auto-merge

`Dependabot Auto-Merge` verifies Dependabot PRs and enables auto-merge only for semver patch/minor updates after full repo verification succeeds.

### Uptime guardian

`Uptime Guardian` probes public surfaces every 30 minutes and maintains a dedicated `uptime-alert` issue lifecycle (open/update on failure, close on recovery).

### Backup and restore drill

`Backup & Restore Drill` runs weekly, creates an archive of critical project state, restores it in CI, validates key files, and raises a `backup-alert` issue on failure.

### Secret rotation governance

`Secret Rotation Governance` opens or refreshes a monthly checklist issue for credential hygiene and rotation operations.

### Incident triage bot

`Autonomy Incident Triage` automatically posts a triage checklist on autonomy-alert issues and delegates a proposed code fix request to Copilot.

### Operational rule

Any future feature that becomes operationally important should add at least one of these before it is considered complete:

- a scheduled automation path;
- a runtime readiness/probe surface;
- a documented manual fallback;
- an audit check in `tools/autonomy-audit.mjs`.

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
