/**
 * OKN Studio — Operational log integrity tags
 * ============================================
 * Each persisted `log:` record carries a keyed integrity tag (`chainHash`):
 * an HMAC-SHA256 over the record's canonical fields, signed with TOKEN_SECRET.
 *
 * Because the key never lives in KV, an attacker who can edit a stored log value
 * cannot forge a matching tag — so the admin Control Center can detect tampered
 * or corrupted records. (A true cross-record hash chain is not reliable in an
 * eventually-consistent, concurrently-written KV store, so we verify each record
 * independently instead.)
 */

// Fields that define a log record's identity. Order is fixed and must match on
// both the write and verify sides. `chained`/`id`/transport fields are excluded.
export function canonicalLogPayload(row) {
  return [
    row?.t,
    row?.level,
    row?.category,
    row?.event,
    row?.path,
    row?.status,
    row?.message,
  ].map((v) => (v == null ? '' : String(v))).join('|');
}

export async function logIntegrityTag(secret, row) {
  const key = String(secret || '').trim();
  if (!key) return '';
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(canonicalLogPayload(row)));
  // 128-bit hex tag — ample collision resistance, half the size of the full digest.
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
