/**
 * OKN Studio — Admin Unified Logs API
 * ====================================
 * GET  /api/admin/logs   -> query structured logs with category/level filters
 * POST /api/admin/logs   -> append custom admin/user/ops log event
 */

const DEFAULT_LIMIT = 80;
const MAX_LIMIT = 200;
const LIST_BATCH = 200;
const MAX_SCAN = 2400;
const MAX_EXPORT_SCAN = 30000;
const MAX_EXPORT_ROWS = 10000;

export async function onRequestGet(context) {
  const { request, env } = context;
  const ns = getLogsNamespace(env);
  if (!ns) {
    return Response.json({ ok: false, error: 'No log store configured (LOGS_KV or AUDIT_LOG_KV).' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const url = new URL(request.url);
  const limit = sanitizeLimit(url.searchParams.get('limit'));
  const all = url.searchParams.get('all') === '1';
  const cursor = sanitizeCursor(url.searchParams.get('cursor'));
  const levelSet = parseCsvSet(url.searchParams.get('levels'));
  const categorySet = parseCsvSet(url.searchParams.get('categories'));
  const pathContains = String(url.searchParams.get('path') || '').trim().toLowerCase().slice(0, 120);
  const text = String(url.searchParams.get('text') || '').trim().toLowerCase().slice(0, 120);
  const minStatus = sanitizeMinStatus(url.searchParams.get('minStatus'));

  const items = [];
  let scanned = 0;
  let nextCursor = cursor || undefined;
  let listComplete = false;
  let cappedByRowLimit = false;

  const scanLimit = all ? MAX_EXPORT_SCAN : MAX_SCAN;
  const targetRows = all ? MAX_EXPORT_ROWS : limit;

  while (items.length < targetRows && scanned < scanLimit) {
    const listed = await ns.list({
      prefix: 'log:',
      limit: LIST_BATCH,
      cursor: nextCursor,
    });

    const keys = (listed.keys || []).map((k) => k.name);
    if (!keys.length) {
      listComplete = true;
      nextCursor = null;
      break;
    }

    const rows = await Promise.all(keys.map((k) => ns.get(k, { type: 'json' })));
    scanned += keys.length;

    for (let i = 0; i < rows.length; i += 1) {
      const row = normalizeLog(rows[i], keys[i]);
      if (!row) continue;
      if (!matchesFilters(row, { levelSet, categorySet, minStatus, pathContains, text })) continue;
      items.push(row);
      if (items.length >= targetRows) {
        cappedByRowLimit = true;
        break;
      }
    }

    listComplete = !!listed.list_complete;
    nextCursor = listed.cursor || null;
    if (cappedByRowLimit || listComplete || !nextCursor) break;
  }

  items.sort((a, b) => (a.t < b.t ? 1 : -1));

  const reachedScanLimit = scanned >= scanLimit && !listComplete;
  const truncated = !!(cappedByRowLimit || reachedScanLimit);

  return Response.json({
    ok: true,
    logs: items,
    count: items.length,
    mode: all ? 'all' : 'paged',
    scanned,
    cursor: nextCursor,
    listComplete,
    truncated,
    cap: all ? MAX_EXPORT_ROWS : limit,
    filters: {
      levels: Array.from(levelSet),
      categories: Array.from(categorySet),
      pathContains,
      text,
      minStatus,
    },
  }, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const ns = getLogsNamespace(env);
  if (!ns) {
    return Response.json({ ok: false, error: 'No log store configured (LOGS_KV or AUDIT_LOG_KV).' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }

  const record = {
    t: new Date().toISOString(),
    level: normalizeLevel(body.level),
    category: normalizeCategory(body.category),
    event: String(body.event || 'manual_log').slice(0, 64),
    message: String(body.message || '').slice(0, 600),
    requestId: String(body.requestId || '').slice(0, 80),
    method: String(body.method || '').slice(0, 12),
    path: String(body.path || '').slice(0, 400),
    query: String(body.query || '').slice(0, 800),
    status: Number.isFinite(body.status) ? Number(body.status) : null,
    ms: Number.isFinite(body.ms) ? Number(body.ms) : null,
    ip: String(body.ip || '').slice(0, 80),
    country: String(body.country || '').slice(0, 8),
    colo: String(body.colo || '').slice(0, 16),
    ua: String(body.ua || '').slice(0, 240).replace(/[\r\n]/g, ' '),
    tags: Array.isArray(body.tags) ? body.tags.slice(0, 12).map((v) => String(v).slice(0, 24)) : [],
    data: body.data && typeof body.data === 'object' ? body.data : null,
  };

  try {
    const key = `log:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
    const retentionDays = Number(env.LOG_RETENTION_DAYS || 180);
    const ttl = Math.max(1, Number.isFinite(retentionDays) ? retentionDays : 180) * 24 * 60 * 60;
    await ns.put(key, JSON.stringify(record), { expirationTtl: ttl });
    return Response.json({ ok: true, key }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ ok: false, error: 'Failed to write log record.' }, { status: 500 });
  }
}

function getLogsNamespace(env) {
  return env.LOGS_KV || env.AUDIT_LOG_KV || null;
}

function sanitizeLimit(raw) {
  const n = Number(raw || DEFAULT_LIMIT);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
}

function sanitizeCursor(raw) {
  const v = String(raw || '').trim();
  return v ? v.slice(0, 300) : null;
}

function sanitizeMinStatus(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(100, Math.min(599, Math.floor(n)));
}

function parseCsvSet(raw) {
  const out = new Set();
  for (const item of String(raw || '').split(',')) {
    const v = item.trim().toLowerCase();
    if (v) out.add(v);
  }
  return out;
}

function normalizeLevel(level) {
  const v = String(level || 'info').toLowerCase();
  if (v === 'debug' || v === 'info' || v === 'warning' || v === 'error') return v;
  return 'info';
}

function normalizeCategory(category) {
  const v = String(category || 'ops').toLowerCase();
  const allowed = new Set(['request', 'auth', 'security', 'system', 'ops', 'error', 'admin', 'user']);
  return allowed.has(v) ? v : 'ops';
}

function normalizeLog(row, key) {
  if (!row || typeof row !== 'object') return null;
  return {
    key,
    t: typeof row.t === 'string' ? row.t : new Date(0).toISOString(),
    level: normalizeLevel(row.level),
    category: normalizeCategory(row.category),
    event: String(row.event || ''),
    message: String(row.message || ''),
    requestId: String(row.requestId || ''),
    method: String(row.method || ''),
    path: String(row.path || ''),
    query: String(row.query || ''),
    status: Number.isFinite(row.status) ? Number(row.status) : null,
    ms: Number.isFinite(row.ms) ? Number(row.ms) : null,
    ip: String(row.ip || ''),
    country: String(row.country || ''),
    colo: String(row.colo || ''),
    ua: String(row.ua || ''),
    tags: Array.isArray(row.tags) ? row.tags : [],
    data: row.data && typeof row.data === 'object' ? row.data : null,
  };
}

function matchesFilters(row, filters) {
  const { levelSet, categorySet, minStatus, pathContains, text } = filters;
  if (levelSet.size && !levelSet.has(row.level)) return false;
  if (categorySet.size && !categorySet.has(row.category)) return false;
  if (minStatus !== null && Number.isFinite(row.status) && row.status < minStatus) return false;
  if (pathContains && !String(row.path || '').toLowerCase().includes(pathContains)) return false;
  if (text) {
    const haystack = `${row.event} ${row.message} ${row.path} ${row.method}`.toLowerCase();
    if (!haystack.includes(text)) return false;
  }
  return true;
}
