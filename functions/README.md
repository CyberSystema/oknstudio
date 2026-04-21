# Cloudflare Pages Functions

Edge serverless routes. Every request to the site runs through
`_middleware.js` first for authentication and security-header enforcement.

## Routes

| Path | File | Purpose |
|------|------|---------|
| `*` | `_middleware.js` | Site-wide password auth, HSTS, CSP, rate limiting. |
| `POST /api/analytics/upload` | `api/analytics/upload.js` | Accepts batch CSV uploads and commits them to the repo via the GitHub Git Data API as a single atomic commit. |
| `GET /api/media/list` | `api/media/list.js` | Lists keys in the private B2 bucket (authenticated). |
| `GET /api/media/download/*` | `api/media/download/[[path]].js` | Range-capable proxy for B2 object downloads. |

## Required environment

All set via Cloudflare Pages → Project → Settings → Environment Variables.

### Site auth
- `SITE_PASSWORD_HASH` — SHA-256 hex hash of the site password.
- `TOKEN_SECRET`       — Random secret used for HMAC session signing.

### Upload API
- `UPLOAD_PASSWORD_HASH`    — SHA-256 hex hash of the team upload password.
- `UPLOAD_ALLOWED_ORIGINS`  — Comma-separated list of origins allowed to
  call `/api/analytics/upload`. Wildcard `*` is explicitly rejected.
- `GITHUB_PAT`              — Fine-grained PAT with contents:write on the repo.
- `GITHUB_REPO`             — e.g. `CyberSystema/oknstudio`.
- `GITHUB_BRANCH`           — defaults to `main`.

### B2 / media proxy
- `B2_KEY_ID`, `B2_APP_KEY`, `B2_ENDPOINT`, `B2_BUCKET` — Backblaze S3-compatible credentials.

### Optional KV bindings
- `RATE_LIMIT_KV` — Workers KV namespace. When bound, auth + upload rate
  limits survive Worker cold starts. Without it, the code falls back to an
  ephemeral per-isolate `Map`.
- `AUDIT_LOG_KV`  — Workers KV namespace. When bound, each auth event
  (success / failure) is persisted for 180 days under `auth:<ts>:<ip>`.
  Auth events are also emitted to `console.log` so Cloudflare Logpush
  captures them regardless.

## Security notes

- HMAC session tokens now carry a random 16-byte nonce to prevent
  timestamp-prediction brute force. Legacy two-part tokens are still
  accepted until they expire.
- Media download sanitiser rejects double URL encoding (`%252e%252e`),
  control characters, absolute paths, null bytes, and `.`/`..` segments.
- CSP is permissive for inline styles/scripts because the site ships a
  zero-build ESM convention. `esm.sh` is the only remote script origin.

## Local dev

Pages Functions run under Wrangler:

```bash
npx wrangler pages dev site --compatibility-date=2024-10-01
```

Provide a `.dev.vars` file with the env vars above for local testing.
