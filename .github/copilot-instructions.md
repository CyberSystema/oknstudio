# OKN Studio Copilot Instructions

## Mission
Keep autonomy workflows reliable, minimal in scope, and fully verifiable.

## Build And Test
- Run `npm run autonomy:check` for autonomy contract validation.
- Run `npm run verify` before finalizing changes.
- Prefer targeted checks first, then full verify.

## Autonomy Conventions
- Treat `.github/workflows/` and `tools/autonomy-*.mjs` as high-safety surfaces.
- Keep fixes deterministic and reversible.
- Avoid unrelated refactors in incident-driven changes.
- Update `README.md` when behavior or operations policy changes.

## Incident Workflow Expectations
- Capture root cause in issue or PR text.
- Include rollback steps for any workflow or runtime behavior change.
- If external dependency failure is suspected, document provider ownership and evidence.
