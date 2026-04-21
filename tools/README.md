# Tools

Standalone utilities that support the site but don't ship as part of the
runtime. Keep these framework-free and committed-dependency-free where
possible.

## `og/` — OG image generator

Generates the Open Graph preview image (`og-image.png`) and the richer
status OG card used by `/status/`.

- `build.sh`            — one-shot build script invoked by CI / `npm run og:build`.
- `render.html`         — the HTML template rendered to PNG.
- `generate-status.mjs` — fetches runtime status data, writes `status-data.js`,
  and rebuilds the status OG image.
- `status-data.js`      — emitted artefact; checked in so the static site can
  consume it without a build step.

Scripts:

```bash
npm run og:status   # regenerate status-data.js + render status OG
npm run og:build    # rebuild the main og-image.png
```

## `bucket-map.py`

One-off helper that inspects the Backblaze B2 bucket and emits a JSON map
consumed by the media gallery. Run manually when adding new top-level
folders:

```bash
source .venv/bin/activate
python tools/bucket-map.py > site/media/bucket-map.json
```

Requires the same `B2_*` credentials documented in
[`functions/README.md`](../functions/README.md), exported in the shell env.
