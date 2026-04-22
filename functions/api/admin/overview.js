/**
 * OKN Studio — Admin Overview API
 * =================================
 * Returns environment readiness, auth telemetry snapshot, and runtime metadata
 * for the private admin dashboard.
 */

const STARTED_AT = Date.now();

export async function onRequestGet(context) {
  const { request, env } = context;

  const checks = {
    siteAuth: hasEnv(env, 'SITE_PASSWORD_HASH') && hasEnv(env, 'TOKEN_SECRET'),
    adminAuth: hasEnv(env, 'ADMIN_PASSWORD_HASH'),
    uploadApi: hasEnv(env, 'UPLOAD_PASSWORD_HASH') && hasEnv(env, 'GITHUB_PAT') && hasEnv(env, 'GITHUB_REPO'),
    b2Media: hasEnv(env, 'B2_KEY_ID') && hasEnv(env, 'B2_APP_KEY') && hasEnv(env, 'B2_ENDPOINT') && hasEnv(env, 'B2_BUCKET'),
    rateLimitKv: !!env.RATE_LIMIT_KV,
    auditKv: !!env.AUDIT_LOG_KV,
    logStore: !!(env.LOGS_KV || env.AUDIT_LOG_KV),
  };

  const warnings = [];
  if (!checks.adminAuth) warnings.push('ADMIN_PASSWORD_HASH is missing. Admin gate cannot be used safely.');
  if (!checks.rateLimitKv) warnings.push('RATE_LIMIT_KV not bound. Rate limits reset on isolate restart.');
  if (!checks.auditKv) warnings.push('AUDIT_LOG_KV not bound. Historical auth audit log is unavailable.');
  if (!checks.logStore) warnings.push('No LOGS_KV/AUDIT_LOG_KV bound. Unified activity logs are unavailable.');

  const [authSummary, rateSummary] = await Promise.all([
    summarizeAuth(env),
    summarizeRateLimit(env),
  ]);

  return Response.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    runtime: {
      isolateUptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
      colo: request.headers.get('CF-Connecting-Colo') || null,
      country: request.headers.get('CF-IPCountry') || null,
      ipMasked: maskIp(request.headers.get('CF-Connecting-IP') || ''),
      userAgent: (request.headers.get('User-Agent') || '').slice(0, 160),
    },
    checks,
    warnings,
    authSummary,
    rateSummary,
  }, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}

function hasEnv(env, key) {
  return !!String(env[key] || '').trim();
}

function maskIp(ip) {
  if (!ip) return null;
  if (ip.includes(':')) {
    const parts = ip.split(':');
    if (parts.length < 2) return 'xxxx';
    return parts.slice(0, 2).join(':') + ':xxxx';
  }
  const parts = ip.split('.');
  if (parts.length !== 4) return 'x.x.x.x';
  return `${parts[0]}.${parts[1]}.x.x`;
}

async function summarizeAuth(env) {
  if (!env.AUDIT_LOG_KV) {
    return {
      available: false,
      sampled: 0,
      success: 0,
      failed: 0,
      lastEventAt: null,
    };
  }

  try {
    const listed = await env.AUDIT_LOG_KV.list({ prefix: 'auth:', limit: 80 });
    const keys = (listed.keys || []).map((k) => k.name).slice(0, 80);
    const rows = await Promise.all(keys.map((k) => env.AUDIT_LOG_KV.get(k, { type: 'json' })));

    let success = 0;
    let failed = 0;
    let lastEventAt = null;

    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      if (row.success) success += 1;
      else failed += 1;
      if (!lastEventAt || (row.t && row.t > lastEventAt)) lastEventAt = row.t || lastEventAt;
    }

    return {
      available: true,
      sampled: rows.length,
      success,
      failed,
      lastEventAt,
      listComplete: !!listed.list_complete,
    };
  } catch {
    return {
      available: false,
      sampled: 0,
      success: 0,
      failed: 0,
      lastEventAt: null,
      error: 'audit_kv_unavailable',
    };
  }
}

async function summarizeRateLimit(env) {
  if (!env.RATE_LIMIT_KV) {
    return {
      available: false,
      activeKeys: 0,
    };
  }

  try {
    const listed = await env.RATE_LIMIT_KV.list({ prefix: 'auth_rl:', limit: 200 });
    return {
      available: true,
      activeKeys: (listed.keys || []).length,
      listComplete: !!listed.list_complete,
    };
  } catch {
    return {
      available: false,
      activeKeys: 0,
      error: 'rate_limit_kv_unavailable',
    };
  }
}
