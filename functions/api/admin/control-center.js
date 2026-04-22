/**
 * OKN Studio — Admin Control Center API
 * =====================================
 * Unified admin API for operational modules:
 * alerts, queue/dead-letter, approvals, service map, synthetic history,
 * SLO, presets, quality audit, knowledge base, session intelligence,
 * audit integrity, and brute-force intelligence.
 */

const PREFIX = 'cc:';
const MAX_LIST = 1000;

export async function onRequestGet(context) {
  const { request, env } = context;
  const ns = getNs(env);
  if (!ns) {
    return Response.json({ ok: false, error: 'No log/security KV configured (LOGS_KV or AUDIT_LOG_KV).' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const url = new URL(request.url);
  const module = String(url.searchParams.get('module') || 'summary').trim().toLowerCase();

  if (module === 'quality-audit') {
    return handleQualityAudit(request);
  }

  const [alerts, queue, deadLetters, approvals, presets, knowledge, syntheticHistory, logs] = await Promise.all([
    listByPrefix(ns, `${PREFIX}alert:`),
    listByPrefix(ns, `${PREFIX}queue:`),
    listByPrefix(ns, `${PREFIX}dead:`),
    listByPrefix(ns, `${PREFIX}approval:`),
    listByPrefix(ns, `${PREFIX}preset:`),
    listByPrefix(ns, `${PREFIX}kb:`),
    listByPrefix(ns, `${PREFIX}synthetic:`),
    listByPrefix(ns, 'log:'),
  ]);

  const serviceMap = buildServiceMap(request.url, logs);
  const slo = buildSlo(logs);
  const integrity = buildIntegrity(logs);
  const bruteForce = buildBruteforce(logs);
  const sessions = buildSessionIntelligence(logs);

  return Response.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    alerts,
    queue,
    deadLetters,
    approvals,
    presets,
    knowledge,
    serviceMap,
    syntheticHistory: syntheticHistory.slice(0, 500),
    slo,
    integrity,
    bruteForce,
    sessions,
  }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const ns = getNs(env);
  if (!ns) {
    return Response.json({ ok: false, error: 'No log/security KV configured (LOGS_KV or AUDIT_LOG_KV).' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON.' }, { status: 400 });
  }

  const action = String(body.action || '').trim();
  if (!action) {
    return Response.json({ ok: false, error: 'Missing action.' }, { status: 400 });
  }

  try {
    if (action === 'alert.upsert') return upsertRecord(ns, `${PREFIX}alert:`, body.record);
    if (action === 'alert.delete') return deleteRecord(ns, `${PREFIX}alert:`, body.id);

    if (action === 'queue.enqueue') return upsertRecord(ns, `${PREFIX}queue:`, normalizeQueueRecord(body.record));
    if (action === 'queue.update') return upsertRecord(ns, `${PREFIX}queue:`, normalizeQueueRecord(body.record));
    if (action === 'queue.deadletter') return moveQueueToDeadLetter(ns, body.id, body.reason);
    if (action === 'queue.retry') return retryDeadLetter(ns, body.id);

    if (action === 'approval.submit') return upsertRecord(ns, `${PREFIX}approval:`, normalizeApprovalRecord(body.record, false));
    if (action === 'approval.review') return upsertRecord(ns, `${PREFIX}approval:`, normalizeApprovalRecord(body.record, true));

    if (action === 'preset.upsert') return upsertRecord(ns, `${PREFIX}preset:`, body.record);
    if (action === 'preset.delete') return deleteRecord(ns, `${PREFIX}preset:`, body.id);

    if (action === 'kb.upsert') return upsertRecord(ns, `${PREFIX}kb:`, body.record);
    if (action === 'kb.delete') return deleteRecord(ns, `${PREFIX}kb:`, body.id);

    if (action === 'synthetic.record') return appendSyntheticRecord(ns, body.record);

    if (action === 'session.forceLogoutAll') return forceLogoutAll(ns, body.reason);
    if (action === 'session.blockIp') return blockIp(ns, body.ip, body.reason);
    if (action === 'session.unblockIp') return unblockIp(ns, body.ip);

    return Response.json({ ok: false, error: `Unsupported action: ${action}` }, { status: 400 });
  } catch {
    return Response.json({ ok: false, error: 'Failed to process action.' }, { status: 500 });
  }
}

async function handleQualityAudit(request) {
  const url = new URL(request.url);
  const width = sanitizeNum(url.searchParams.get('width'));
  const height = sanitizeNum(url.searchParams.get('height'));
  const codec = String(url.searchParams.get('codec') || '').toLowerCase();
  const sizeMb = sanitizeNum(url.searchParams.get('sizeMb'));

  const result = qualityAudit({ width, height, codec, sizeMb });
  return Response.json({ ok: true, result }, { headers: { 'Cache-Control': 'no-store' } });
}

function qualityAudit(input) {
  const issues = [];
  const notes = [];
  const ratio = input.width > 0 && input.height > 0 ? (input.width / input.height) : 0;

  if (!input.width || !input.height) issues.push({ severity: 'error', message: 'Missing resolution metadata.' });
  if (input.width > 0 && input.height > 0 && (input.width < 720 || input.height < 720)) issues.push({ severity: 'warning', message: 'Resolution below 720p baseline.' });

  const allowedCodecs = new Set(['h264', 'hevc', 'vp9', 'av1', 'jpeg', 'png', 'webp']);
  if (input.codec && !allowedCodecs.has(input.codec)) issues.push({ severity: 'warning', message: `Non-standard codec: ${input.codec}` });

  if (input.sizeMb > 0 && input.sizeMb > 120) issues.push({ severity: 'warning', message: 'Very large file size (>120MB).' });

  if (ratio > 0) {
    const closeTo = (target) => Math.abs(ratio - target) < 0.03;
    if (closeTo(16 / 9)) notes.push('Landscape-friendly (16:9).');
    else if (closeTo(9 / 16)) notes.push('Vertical-friendly (9:16).');
    else if (closeTo(1)) notes.push('Square-friendly (1:1).');
    else issues.push({ severity: 'info', message: `Uncommon aspect ratio (${ratio.toFixed(2)}).` });
  }

  const score = Math.max(0, 100 - issues.reduce((acc, v) => acc + (v.severity === 'error' ? 35 : v.severity === 'warning' ? 15 : 5), 0));

  return {
    score,
    pass: score >= 70,
    issues,
    notes,
    normalized: {
      width: input.width,
      height: input.height,
      codec: input.codec,
      sizeMb: input.sizeMb,
      ratio: ratio > 0 ? Number(ratio.toFixed(4)) : null,
    },
  };
}

function buildServiceMap(baseUrl, logs) {
  const nodes = [
    '/_health',
    '/status/',
    '/analytics/',
    '/analytics/upload',
    '/media/',
    '/darkroom/',
    '/admin/',
    '/api/admin/logs',
    '/api/admin/probes',
    '/api/media/list',
  ];

  const now = Date.now();
  const recent = logs.filter((row) => now - Date.parse(row.t) <= 24 * 60 * 60 * 1000);
  const byPath = new Map();
  for (const row of recent) {
    const path = String(row.path || '');
    if (!path) continue;
    if (!byPath.has(path)) byPath.set(path, []);
    byPath.get(path).push(row);
  }

  return {
    root: new URL(baseUrl).origin,
    nodes: nodes.map((path) => {
      const rows = byPath.get(path) || [];
      const err = rows.filter((r) => Number.isFinite(r.status) && r.status >= 500).length;
      const warn = rows.filter((r) => Number.isFinite(r.status) && r.status >= 400 && r.status < 500).length;
      const avgMs = rows.length ? Math.round(rows.reduce((acc, r) => acc + (Number.isFinite(r.ms) ? r.ms : 0), 0) / rows.length) : null;
      return {
        path,
        calls24h: rows.length,
        avgMs,
        status: err ? 'error' : warn ? 'warning' : 'ok',
      };
    }),
    dependencies: [
      { from: '/admin/', to: '/api/admin/logs' },
      { from: '/admin/', to: '/api/admin/probes' },
      { from: '/media/', to: '/api/media/list' },
      { from: '/analytics/upload', to: '/api/analytics/upload' },
    ],
  };
}

function buildSlo(logs) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const rows = logs.filter((r) => Date.parse(r.t) >= start.getTime() && Number.isFinite(r.status));
  const total = rows.length;
  const good = rows.filter((r) => r.status >= 200 && r.status < 400).length;
  const err = rows.filter((r) => r.status >= 500).length;
  const availability = total ? (good / total) * 100 : 100;
  const objective = 99.5;

  return {
    month: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
    objective,
    availability: Number(availability.toFixed(3)),
    requests: total,
    errors5xx: err,
    burnRate: objective > 0 ? Number(Math.max(0, (objective - availability) / (100 - objective)).toFixed(4)) : 0,
    onTrack: availability >= objective,
    progressPct: Number(Math.min(100, (availability / objective) * 100).toFixed(2)),
  };
}

function buildIntegrity(logs) {
  const rows = logs.slice().sort((a, b) => (a.t > b.t ? 1 : -1));
  let prev = 'seed';
  let brokenAt = null;

  for (const row of rows) {
    const payload = `${row.t}|${row.level}|${row.category}|${row.event}|${row.path}|${row.status}|${row.message}`;
    const hash = quickHash(prev + '|' + payload);
    if (!hash) continue;
    prev = hash;
    if (!row.chainHash) continue;
    if (row.chainHash !== hash && !brokenAt) brokenAt = row.t;
  }

  return {
    checked: rows.length,
    ok: !brokenAt,
    brokenAt,
    head: prev,
  };
}

function buildBruteforce(logs) {
  const failRows = logs.filter((r) => r.category === 'auth' && String(r.level) === 'warning');
  const byIp = new Map();
  const byCountry = new Map();

  for (const row of failRows) {
    const ip = String(row.ip || 'unknown');
    const country = String(row.country || '??');
    byIp.set(ip, (byIp.get(ip) || 0) + 1);
    byCountry.set(country, (byCountry.get(country) || 0) + 1);
  }

  return {
    failedAuthEvents: failRows.length,
    topIps: topMap(byIp, 12),
    topCountries: topMap(byCountry, 12),
  };
}

function buildSessionIntelligence(logs) {
  const authRows = logs.filter((r) => r.category === 'auth' || r.category === 'security');
  const last24h = authRows.filter((r) => Date.now() - Date.parse(r.t) <= 24 * 60 * 60 * 1000);
  const suspicious = last24h.filter((r) => r.level === 'warning' || r.level === 'error');

  return {
    authEvents24h: last24h.length,
    suspicious24h: suspicious.length,
    suspiciousSample: suspicious.slice(0, 40),
  };
}

function topMap(map, n) {
  return Array.from(map.entries())
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
}

function quickHash(value) {
  let h = 2166136261;
  const str = String(value || '');
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

async function appendSyntheticRecord(ns, record) {
  const next = {
    id: randomId(),
    t: new Date().toISOString(),
    region: String((record && record.region) || 'global').slice(0, 20),
    path: String((record && record.path) || '').slice(0, 200),
    status: Number.isFinite(record && record.status) ? Number(record.status) : null,
    ms: Number.isFinite(record && record.ms) ? Number(record.ms) : null,
  };
  const key = `${PREFIX}synthetic:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
  await ns.put(key, JSON.stringify(next), { expirationTtl: 3600 * 24 * 180 });
  return Response.json({ ok: true, id: next.id });
}

async function upsertRecord(ns, prefix, record) {
  const next = normalizeRecord(record);
  const id = String(next.id || randomId()).slice(0, 80);
  next.id = id;
  next.updatedAt = new Date().toISOString();
  if (!next.createdAt) next.createdAt = next.updatedAt;
  await ns.put(`${prefix}${id}`, JSON.stringify(next), { expirationTtl: 3600 * 24 * 365 });
  return Response.json({ ok: true, id, record: next });
}

async function deleteRecord(ns, prefix, id) {
  const safe = String(id || '').trim();
  if (!safe) return Response.json({ ok: false, error: 'Missing id' }, { status: 400 });
  await ns.delete(`${prefix}${safe}`);
  return Response.json({ ok: true, id: safe });
}

async function moveQueueToDeadLetter(ns, id, reason) {
  const safe = String(id || '').trim();
  if (!safe) return Response.json({ ok: false, error: 'Missing id' }, { status: 400 });
  const row = await ns.get(`${PREFIX}queue:${safe}`, { type: 'json' });
  if (!row || typeof row !== 'object') return Response.json({ ok: false, error: 'Queue item not found.' }, { status: 404 });

  const next = {
    ...row,
    id: safe,
    deadAt: new Date().toISOString(),
    deadReason: String(reason || 'manual').slice(0, 120),
  };
  await ns.put(`${PREFIX}dead:${safe}`, JSON.stringify(next), { expirationTtl: 3600 * 24 * 365 });
  await ns.delete(`${PREFIX}queue:${safe}`);
  return Response.json({ ok: true, id: safe, dead: true });
}

async function retryDeadLetter(ns, id) {
  const safe = String(id || '').trim();
  if (!safe) return Response.json({ ok: false, error: 'Missing id' }, { status: 400 });
  const row = await ns.get(`${PREFIX}dead:${safe}`, { type: 'json' });
  if (!row || typeof row !== 'object') return Response.json({ ok: false, error: 'Dead-letter item not found.' }, { status: 404 });

  const next = {
    ...row,
    id: safe,
    retries: (Number(row.retries) || 0) + 1,
    state: 'queued',
    updatedAt: new Date().toISOString(),
  };
  delete next.deadAt;
  delete next.deadReason;

  await ns.put(`${PREFIX}queue:${safe}`, JSON.stringify(next), { expirationTtl: 3600 * 24 * 365 });
  await ns.delete(`${PREFIX}dead:${safe}`);
  return Response.json({ ok: true, id: safe, queued: true });
}

async function forceLogoutAll(ns, reason) {
  const record = {
    t: Date.now(),
    reason: String(reason || 'manual_force_logout').slice(0, 120),
  };
  await ns.put(`${PREFIX}security:force_logout_before`, JSON.stringify(record), { expirationTtl: 3600 * 24 * 365 });
  return Response.json({ ok: true, forcedAt: record.t });
}

async function blockIp(ns, ip, reason) {
  const safeIp = String(ip || '').trim();
  if (!safeIp) return Response.json({ ok: false, error: 'Missing ip' }, { status: 400 });
  await ns.put(`${PREFIX}security:block_ip:${safeIp}`, JSON.stringify({ ip: safeIp, reason: String(reason || 'manual').slice(0, 120), t: Date.now() }), {
    expirationTtl: 3600 * 24 * 365,
  });
  return Response.json({ ok: true, ip: safeIp });
}

async function unblockIp(ns, ip) {
  const safeIp = String(ip || '').trim();
  if (!safeIp) return Response.json({ ok: false, error: 'Missing ip' }, { status: 400 });
  await ns.delete(`${PREFIX}security:block_ip:${safeIp}`);
  return Response.json({ ok: true, ip: safeIp });
}

function normalizeQueueRecord(record) {
  const next = normalizeRecord(record);
  if (!next.state) next.state = 'queued';
  if (!Number.isFinite(next.retries)) next.retries = 0;
  if (!Number.isFinite(next.maxRetries)) next.maxRetries = 3;
  if (!next.type) next.type = 'generic';
  return next;
}

function normalizeApprovalRecord(record, reviewed) {
  const next = normalizeRecord(record);
  if (!next.status) next.status = reviewed ? 'approved' : 'pending';
  if (reviewed) next.reviewedAt = new Date().toISOString();
  return next;
}

function normalizeRecord(record) {
  const next = record && typeof record === 'object' ? { ...record } : {};
  if (!next.id) next.id = randomId();
  return next;
}

async function listByPrefix(ns, prefix) {
  const listed = await ns.list({ prefix, limit: MAX_LIST });
  const keys = (listed.keys || []).map((v) => v.name);
  const rows = await Promise.all(keys.map((k) => ns.get(k, { type: 'json' })));

  return rows
    .filter((v) => v && typeof v === 'object')
    .map((row, idx) => {
      const id = keys[idx].slice(prefix.length);
      return {
        id,
        ...row,
      };
    })
    .sort((a, b) => {
      const ta = Date.parse(a.updatedAt || a.createdAt || a.t || 0);
      const tb = Date.parse(b.updatedAt || b.createdAt || b.t || 0);
      return tb - ta;
    });
}

function sanitizeNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function getNs(env) {
  return env.LOGS_KV || env.AUDIT_LOG_KV || null;
}

function randomId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
