/**
 * OKN Studio — Admin Auth Events API
 * ===================================
 * Paginates auth event records from AUDIT_LOG_KV for the private admin page.
 */

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 60;

export async function onRequestGet(context) {
  const { request, env } = context;

  if (!env.AUDIT_LOG_KV) {
    return Response.json({ ok: false, error: 'AUDIT_LOG_KV not configured' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const url = new URL(request.url);
  const rawLimit = Number(url.searchParams.get('limit') || DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT) : DEFAULT_LIMIT;
  const cursor = url.searchParams.get('cursor') || undefined;

  try {
    const listed = await env.AUDIT_LOG_KV.list({
      prefix: 'auth:',
      limit,
      cursor,
    });

    const keys = (listed.keys || []).map((k) => k.name);
    const rows = await Promise.all(keys.map((k) => env.AUDIT_LOG_KV.get(k, { type: 'json' })));

    const events = rows
      .map((row, idx) => normalizeEvent(row, keys[idx]))
      .filter(Boolean)
      .sort((a, b) => (a.t < b.t ? 1 : -1));

    return Response.json({
      ok: true,
      events,
      count: events.length,
      cursor: listed.cursor || null,
      listComplete: !!listed.list_complete,
    }, {
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return Response.json({ ok: false, error: 'Failed to load auth events' }, {
      status: 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}

function normalizeEvent(row, key) {
  if (!row || typeof row !== 'object') return null;
  return {
    t: typeof row.t === 'string' ? row.t : new Date(0).toISOString(),
    ip: typeof row.ip === 'string' ? row.ip : 'unknown',
    success: !!row.success,
    reason: typeof row.reason === 'string' ? row.reason : '',
    ua: typeof row.ua === 'string' ? row.ua : '',
    key,
  };
}
