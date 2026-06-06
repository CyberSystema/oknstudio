/**
 * OKN Studio — Time-ordered KV key tokens
 * ========================================
 * Cloudflare KV `list()` returns keys in ascending lexicographic order with no
 * reverse option. Time-series records (auth events, operational logs) want the
 * MOST RECENT entries at the front of a page so dashboards can show "recent"
 * activity without scanning the whole namespace.
 *
 * We store an INVERTED, fixed-width base36 timestamp: a larger time produces a
 * lexicographically SMALLER token, so newer records sort first.
 *
 * The token is left-padded to 13 chars, which guarantees a leading "000…" for
 * every realistic timestamp. Legacy keys used a bare `Date.now().toString(36)`
 * (no padding; leading char is a letter for the current era), so every new token
 * also sorts BEFORE every legacy key — the change takes effect immediately and
 * pre-migration records simply age out via their TTL at the tail of the list.
 */

// 36**10 ≈ 3.66e15 ms (year ~117000) — safely above any real Date.now() and well
// below Number.MAX_SAFE_INTEGER, so the inversion stays exact integer math.
const DESC_TS_CEILING = 36 ** 10;
const TOKEN_WIDTH = 13;

export function descendingTimeToken(ms = Date.now()) {
  const t = Number.isFinite(ms) ? Math.floor(ms) : Date.now();
  const clamped = Math.min(Math.max(t, 0), DESC_TS_CEILING - 1);
  return (DESC_TS_CEILING - 1 - clamped).toString(36).padStart(TOKEN_WIDTH, '0');
}
