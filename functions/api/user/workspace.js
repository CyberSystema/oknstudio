/**
 * OKN Studio — User Workspace API
 * ===============================
 * Non-admin surface for shared productivity features:
 * - Batch presets (read)
 * - Quality audit (run)
 * - Approval submit + tracking
 * - Queue visibility (read)
 * - Knowledge base (read)
 */

const PREFIX = 'cc:';
const MAX_LIST = 500;

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
  const module = String(url.searchParams.get('module') || 'init').toLowerCase();

  if (module === 'quality-audit') {
    const width = sanitizeNum(url.searchParams.get('width'));
    const height = sanitizeNum(url.searchParams.get('height'));
    const codec = String(url.searchParams.get('codec') || '').toLowerCase();
    const sizeMb = sanitizeNum(url.searchParams.get('sizeMb'));
    return Response.json({ ok: true, result: qualityAudit({ width, height, codec, sizeMb }) }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const [presets, approvals, queue, deadLetters, knowledge] = await Promise.all([
    listByPrefix(ns, `${PREFIX}preset:`),
    listByPrefix(ns, `${PREFIX}approval:`),
    listByPrefix(ns, `${PREFIX}queue:`),
    listByPrefix(ns, `${PREFIX}dead:`),
    listByPrefix(ns, `${PREFIX}kb:`),
  ]);

  return Response.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    presets,
    approvals: approvals.slice(0, 300),
    queue: queue.slice(0, 300),
    deadLetters: deadLetters.slice(0, 300),
    knowledge: knowledge.slice(0, 400),
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
  if (action === 'approval.submit') {
    const record = {
      id: randomId(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      subject: String((body.record && body.record.subject) || '').slice(0, 180),
      type: String((body.record && body.record.type) || 'publish').slice(0, 40),
      status: 'pending',
      details: String((body.record && body.record.details) || '').slice(0, 800),
      submittedBy: 'user',
    };
    if (!record.subject) {
      return Response.json({ ok: false, error: 'Subject is required.' }, { status: 400 });
    }
    await ns.put(`${PREFIX}approval:${record.id}`, JSON.stringify(record), { expirationTtl: 3600 * 24 * 365 });
    return Response.json({ ok: true, id: record.id, record });
  }

  return Response.json({ ok: false, error: `Unsupported action: ${action}` }, { status: 400 });
}

async function listByPrefix(ns, prefix) {
  const listed = await ns.list({ prefix, limit: MAX_LIST });
  const keys = (listed.keys || []).map((v) => v.name);
  const rows = await Promise.all(keys.map((k) => ns.get(k, { type: 'json' })));
  return rows
    .filter((v) => v && typeof v === 'object')
    .map((row, idx) => ({ id: keys[idx].slice(prefix.length), ...row }))
    .sort((a, b) => {
      const ta = Date.parse(a.updatedAt || a.createdAt || 0);
      const tb = Date.parse(b.updatedAt || b.createdAt || 0);
      return tb - ta;
    });
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
