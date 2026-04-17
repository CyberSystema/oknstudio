#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# OKN Studio — OG image builder
# ═══════════════════════════════════════════════════════════════════
# Renders tools/og/render.html to site/og-image.png via headless
# Chrome. Run this once after any edit to render.html.
#
# Usage:
#   ./tools/og/build.sh
#
# Requirements:
#   · Google Chrome or Chromium (any recent version)
#   · macOS or Linux
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Paths (resolved relative to this script) ───────────────────────
HERE="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
REPO="$( cd -- "$HERE/../.." &> /dev/null && pwd )"
SRC="$HERE/render.html"
DST="$REPO/site/og-image.png"
STATUS_GENERATOR="$HERE/generate-status.mjs"

# ── Verify source exists ───────────────────────────────────────────
if [ ! -f "$SRC" ]; then
  echo "✗ render.html not found at: $SRC" >&2
  exit 1
fi

if [ -f "$STATUS_GENERATOR" ]; then
  if command -v node >/dev/null 2>&1; then
    echo "→ Refreshing status snapshot"
    node "$STATUS_GENERATOR"
    echo
  else
    echo "! node not found — using existing status-data.js snapshot" >&2
    echo
  fi
fi

# ── Find Chrome/Chromium ───────────────────────────────────────────
CHROME=""

# macOS canonical paths
MAC_PATHS=(
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta"
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
  "/Applications/Chromium.app/Contents/MacOS/Chromium"
  "/Applications/Arc.app/Contents/MacOS/Arc"
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
)
for p in "${MAC_PATHS[@]}"; do
  if [ -x "$p" ]; then CHROME="$p"; break; fi
done

# Linux/PATH fallback
if [ -z "$CHROME" ]; then
  for cmd in google-chrome google-chrome-stable chromium chromium-browser chrome brave-browser; do
    if command -v "$cmd" >/dev/null 2>&1; then
      CHROME="$(command -v "$cmd")"
      break
    fi
  done
fi

if [ -z "$CHROME" ]; then
  cat >&2 <<'EOF'
✗ No Chrome/Chromium binary found.

  Install one of:
    · Google Chrome    — https://www.google.com/chrome/
    · Chromium         — brew install --cask chromium
    · Brave            — brew install --cask brave-browser

  Or open tools/og/render.html in your browser manually and
  capture a 1200×630 screenshot to site/og-image.png.
EOF
  exit 1
fi

# ── Render ─────────────────────────────────────────────────────────
echo "→ Source:  $SRC"
echo "→ Chrome:  $CHROME"
echo "→ Output:  $DST"
echo

# Use a temp profile dir so we don't disturb the user's Chrome session
PROFILE="$(mktemp -d -t okn-og-XXXXXXXX)"
trap 'rm -rf "$PROFILE"' EXIT

"$CHROME" \
  --headless=new \
  --disable-gpu \
  --no-sandbox \
  --hide-scrollbars \
  --force-device-scale-factor=1 \
  --window-size=1200,630 \
  --user-data-dir="$PROFILE" \
  --default-background-color=00000000 \
  --virtual-time-budget=5000 \
  --run-all-compositor-stages-before-draw \
  --screenshot="$DST" \
  "file://$SRC" \
  >/dev/null 2>&1 || {
    # Fallback: older --headless flag
    "$CHROME" \
      --headless \
      --disable-gpu \
      --no-sandbox \
      --hide-scrollbars \
      --force-device-scale-factor=1 \
      --window-size=1200,630 \
      --user-data-dir="$PROFILE" \
      --virtual-time-budget=5000 \
      --screenshot="$DST" \
      "file://$SRC"
  }

if [ ! -f "$DST" ]; then
  echo "✗ Screenshot was not produced." >&2
  exit 1
fi

SIZE="$(stat -f%z "$DST" 2>/dev/null || stat -c%s "$DST")"
KB="$(( SIZE / 1024 ))"
echo "✓ Wrote og-image.png  (${KB} KB)"
echo
echo "  Next:"
echo "    git add site/og-image.png"
echo "    git commit -m 'Rebuild og-image'"
