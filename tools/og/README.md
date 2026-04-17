# `tools/og/` — OG Image Build Pipeline

Builds the canonical `site/og-image.png` shown when an OKN Studio
link is shared on social platforms (Twitter/X, Facebook, Slack,
LinkedIn, Discord, Telegram, iMessage, etc.).

## Files

| File          | Role |
|---------------|------|
| `render.html` | The source — an HTML page that renders at exactly 1200×630 with Google Fonts loaded and status data injected. |
| `generate-status.mjs` | Runs live HTTP checks against the deployed site and writes `status-data.js` for the renderer. |
| `build.sh`    | Refreshes status, then takes a headless-Chrome screenshot of `render.html` and writes it to `site/og-image.png`. |
| `README.md`   | This file. |

`site/og-image.svg` is the vector-source version of the same
composition — open it directly in a browser to preview without a
rendering step. `render.html` should stay pixel-for-pixel
equivalent to the SVG.

## Usage

First time only:

```bash
chmod +x tools/og/build.sh
```

Then, any time you change `render.html` or want a fresh live status snapshot:

```bash
./tools/og/build.sh
git add site/og-image.png
git commit -m 'Rebuild og-image'
```

The script:

1. Runs `generate-status.mjs` to check the deployed surfaces and update `status-data.js`.
2. Finds Chrome / Chromium / Brave on macOS or Linux automatically.
3. Uses a throwaway profile so it never disturbs your browser session.
4. Waits for Google Fonts to load (via `--virtual-time-budget`).
5. Writes a crisp 1200×630 PNG to `site/og-image.png`.

## Dynamic status

The OG card itself is still an image, so social platforms will cache it as a snapshot. What is dynamic is the build: every time you run `./tools/og/build.sh`, the renderer checks the configured deployment, injects the current system result, and burns that live status into the exported PNG.

For a continuously updating deployed monitor page (instead of a snapshot), use:

`/status/`

That page runs live checks in the browser every 20 seconds and displays the current `og-image.png` beside the live readings.

You can point the checks at a different environment with:

```bash
OKN_OG_STATUS_BASE_URL=https://your-preview-url.example.com ./tools/og/build.sh
```

To refresh the browser preview without rebuilding the PNG, run:

```bash
node tools/og/generate-status.mjs
```

## Why an HTML source?

SVG with `@import url(...)` to Google Fonts renders perfectly in
browsers, but most social-media crawlers rasterise OG images
without loading external resources — which means fonts fall back
to whatever the rasteriser has installed (usually nothing close
to Sora + IBM Plex).

Headless Chrome *does* load external fonts, so rendering the HTML
version guarantees the rasterised PNG matches the design exactly.

## Fallback: manual capture

If you don't want to install Chrome, first run `node tools/og/generate-status.mjs`, then open `render.html` in any browser, set the viewport to exactly 1200×630, and use a screenshot tool (macOS: Cmd+Shift+4, then space, click window). Save to `site/og-image.png`.
