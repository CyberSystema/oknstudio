/**
 * OKN Studio — Admin Autonomy API
 * =================================
 * Machine-readable survivability report for the live system.
 * Combines runtime configuration readiness, first-party synthetic checks,
 * recent operational evidence, and concrete recovery recommendations.
 */

const PROBE_TARGETS = [
  '/_health',
  '/status/',
  '/api/admin/overview',
  '/api/admin/logs?limit=1',
  '/api/admin/control-center',
  '/api/media/list?prefix=',
];

const PROBE_TIMEOUT_MS = 8000;
const LOG_SAMPLE_LIMIT = 160;

export async function onRequestGet(context) {
  const { request, env } = context;

  const [probes, logSummary] = await Promise.all([
    runInternalProbes(request),
    summarizeLogs(env),
  ]);

  const envChecks = buildEnvChecks(env);
  const domainChecks = buildDomainChecks({ envChecks, probes, logSummary });
  const dependencyMatrix = buildDependencyMatrix(env);
  const score = buildScore([...envChecks, ...domainChecks, ...probes.checks, ...logSummary.checks]);
  const recommendations = buildRecommendations({ envChecks, domainChecks, probes, logSummary, dependencyMatrix });
  const recoveryPlaybooks = buildRecoveryPlaybooks(env);

  return Response.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    score,
    envChecks,
    domainChecks,
    probes,
    logSummary,
    dependencyMatrix,
    recommendations,
    recoveryPlaybooks,
  }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

export function buildRecoveryPlaybooks(env) {
  const repo = parseRepo(String(env.GITHUB_REPO || '').trim());

  return [
    secretPlaybook(
      'pages-auth-secrets',
      'Pages auth secret recovery',
      'critical',
      env,
      ['SITE_PASSWORD_HASH', 'TOKEN_SECRET', 'ADMIN_PASSWORD_HASH'],
      'Recovers primary and owner authentication continuity for live access control.'
    ),
    secretPlaybook(
      'pages-ingest-secrets',
      'Pages ingest secret recovery',
      'important',
      env,
      ['UPLOAD_PASSWORD_HASH', 'GITHUB_PAT', 'GITHUB_REPO'],
      'Recovers analytics upload write-back continuity into the repository.'
    ),
    secretPlaybook(
      'pages-media-secrets',
      'Pages media archive secret recovery',
      'important',
      env,
      ['B2_KEY_ID', 'B2_APP_KEY', 'B2_ENDPOINT', 'B2_BUCKET'],
      'Recovers media listing/download continuity for the private archive proxy.'
    ),
    secretPlaybook(
      'pages-digest-secrets',
      'Pages digest secret recovery',
      'important',
      env,
      ['ANTHROPIC_API_KEY', 'RESEND_API_KEY', 'WEEKLY_DIGEST_FROM', 'WEEKLY_DIGEST_REVIEW_RECIPIENTS', 'WEEKLY_DIGEST_RECIPIENTS', 'DIGEST_CRON_SECRET'],
      'Recovers autonomous digest drafting and delivery continuity.'
    ),
    kvBindingPlaybook(env),
    githubActionsSecretPlaybook(repo),
  ];
}

function secretPlaybook(id, title, severity, env, required, note) {
  const missing = required.filter((name) => !hasEnv(env, name));
  const commands = missing.length
    ? missing.map((name) => `printf '%s' '<${name}_VALUE>' | npx wrangler pages secret put ${name} --project-name=oknstudio`)
    : ['No action required.'];

  return {
    id,
    title,
    severity,
    status: missing.length ? 'action-required' : 'ready',
    missing,
    summary: missing.length
      ? `${missing.length} missing value(s): ${missing.join(', ')}`
      : 'All required values are present.',
    commands,
    note,
  };
}

function kvBindingPlaybook(env) {
  const missing = [];
  if (!env.RATE_LIMIT_KV) missing.push('RATE_LIMIT_KV');
  if (!env.AUDIT_LOG_KV) missing.push('AUDIT_LOG_KV');
  if (!env.LOGS_KV) missing.push('LOGS_KV');

  return {
    id: 'pages-kv-bindings',
    title: 'Pages KV binding recovery',
    severity: 'important',
    status: missing.length ? 'action-required' : 'ready',
    missing,
    summary: missing.length
      ? `Missing KV binding(s): ${missing.join(', ')}`
      : 'Required KV bindings are available.',
    commands: missing.length
      ? [
        'Cloudflare Dashboard -> Pages project -> Settings -> Functions -> KV namespace bindings.',
        `Bind namespaces for: ${missing.join(', ')} (production and preview).`,
        'Trigger a redeploy so new bindings are picked up by functions.',
      ]
      : ['No action required.'],
    note: 'KV bindings cannot be created automatically by this endpoint; this is a guided recovery runbook.',
  };
}

function githubActionsSecretPlaybook(repo) {
  const target = repo ? `${repo.owner}/${repo.name}` : '<owner>/<repo>';
  return {
    id: 'github-actions-secrets',
    title: 'GitHub Actions secret recovery',
    severity: 'advisory',
    status: 'manual-check',
    missing: [],
    summary: 'Runtime cannot introspect GitHub Actions secrets; verify them proactively.',
    commands: [
      `gh secret set CLOUDFLARE_API_TOKEN --repo ${target} --body '<CLOUDFLARE_API_TOKEN>'`,
      `gh secret set CLOUDFLARE_ACCOUNT_ID --repo ${target} --body '<CLOUDFLARE_ACCOUNT_ID>'`,
      `gh secret set B2_KEY_ID --repo ${target} --body '<B2_KEY_ID>'`,
      `gh secret set B2_APP_KEY --repo ${target} --body '<B2_APP_KEY>'`,
      `gh secret set RCLONE_GDRIVE_TOKEN --repo ${target} --body '<RCLONE_GDRIVE_TOKEN_JSON>'`,
    ],
    note: 'Use this only when Actions failures indicate missing/rotated repository secrets.',
  };
}

function parseRepo(value) {
  const clean = String(value || '').trim();
  if (!clean || !clean.includes('/')) return null;
  const [owner, name] = clean.split('/');
  if (!owner || !name) return null;
  return { owner, name };
}

function buildEnvChecks(env) {
  return [
    check('site-auth', 'Site auth continuity', 'critical', hasEnv(env, 'SITE_PASSWORD_HASH') && hasEnv(env, 'TOKEN_SECRET'), 'Primary site gate is configured.', 'SITE_PASSWORD_HASH or TOKEN_SECRET is missing.'),
    check('admin-auth', 'Owner admin continuity', 'critical', hasEnv(env, 'ADMIN_PASSWORD_HASH'), 'Owner admin gate is configured.', 'ADMIN_PASSWORD_HASH is missing.'),
    check('durable-rate-limit', 'Durable rate limits', 'important', !!env.RATE_LIMIT_KV, 'RATE_LIMIT_KV is bound.', 'RATE_LIMIT_KV is not bound; rate limits reset on isolate restart.'),
    check('audit-log', 'Historical auth audit trail', 'important', !!env.AUDIT_LOG_KV, 'AUDIT_LOG_KV is bound.', 'AUDIT_LOG_KV is not bound; historical auth audit is unavailable.'),
    check('ops-log-store', 'Operational log store', 'important', !!(env.LOGS_KV || env.AUDIT_LOG_KV), 'Operational log storage is configured.', 'LOGS_KV or AUDIT_LOG_KV is not bound.'),
    check('upload-writeback', 'GitHub write-back path', 'important', hasEnv(env, 'UPLOAD_PASSWORD_HASH') && hasEnv(env, 'GITHUB_PAT') && hasEnv(env, 'GITHUB_REPO'), 'Upload write-back path is configured.', 'Upload write-back path is incomplete.'),
    check('media-archive', 'Media archive continuity', 'important', hasEnv(env, 'B2_KEY_ID') && hasEnv(env, 'B2_APP_KEY') && hasEnv(env, 'B2_ENDPOINT') && hasEnv(env, 'B2_BUCKET'), 'Backblaze media archive is configured.', 'Backblaze media archive configuration is incomplete.'),
    check('digest-generation', 'Digest generation continuity', 'important', hasEnv(env, 'ANTHROPIC_API_KEY'), 'Anthropic digest summarizer is configured.', 'ANTHROPIC_API_KEY is missing.'),
    check('digest-delivery', 'Digest delivery continuity', 'important', hasEnv(env, 'RESEND_API_KEY') && hasEnv(env, 'WEEKLY_DIGEST_FROM') && hasEnv(env, 'WEEKLY_DIGEST_REVIEW_RECIPIENTS') && hasEnv(env, 'WEEKLY_DIGEST_RECIPIENTS'), 'Digest delivery configuration is complete.', 'Digest delivery configuration is incomplete.'),
    check('digest-scheduler', 'Digest scheduler readiness', 'advisory', hasEnv(env, 'DIGEST_CRON_SECRET'), 'DIGEST_CRON_SECRET is configured for Worker-triggered draft creation.', 'DIGEST_CRON_SECRET is missing; the optional scheduled digest worker cannot authenticate.'),
  ];
}

function buildDomainChecks({ envChecks, probes, logSummary }) {
  const env = mapChecks(envChecks);
  const probe = mapChecks(probes.checks);
  const log = mapChecks(logSummary.checks);

  return [
    domainCheck(
      'security-survivability',
      'Security survivability',
      isOk(env, 'site-auth') && isOk(env, 'admin-auth') && isOk(env, 'durable-rate-limit') && isOk(env, 'audit-log'),
      'critical',
      'Primary auth, owner gate, rate limiting, and auth audit are durable.',
      'Security continuity is weakened by missing auth durability or audit persistence.'
    ),
    domainCheck(
      'observability-survivability',
      'Observability survivability',
      isOk(env, 'ops-log-store') && isOk(probe, 'probe:health') && isOk(probe, 'probe:api-admin-overview') && isOk(probe, 'probe:api-admin-control-center') && isOk(log, 'recent-log-freshness'),
      'important',
      'Health, admin control plane, and recent logs are available.',
      'Observability continuity is degraded by missing logs or failing control-plane probes.'
    ),
    domainCheck(
      'editorial-survivability',
      'Editorial survivability',
      isOk(env, 'upload-writeback') && isOk(env, 'digest-generation') && isOk(env, 'digest-delivery'),
      'important',
      'Ingest, summarization, and digest delivery can continue without local intervention.',
      'Editorial continuity is degraded by missing ingest or digest dependencies.'
    ),
    domainCheck(
      'asset-survivability',
      'Asset survivability',
      isOk(env, 'media-archive') && isOk(probe, 'probe:api-media-list'),
      'important',
      'Media archive configuration and runtime access path are healthy.',
      'Media continuity is degraded by missing archive configuration or failed media probe.'
    ),
  ];
}

function buildDependencyMatrix(env) {
  return [
    dependency('Cloudflare Pages', 'Hosting and auth middleware runtime', true, 'managed', 'Primary execution environment for the site and Pages Functions.'),
    dependency('Cloudflare KV', 'Durable rate limiting and operational history', !!(env.RATE_LIMIT_KV || env.AUDIT_LOG_KV || env.LOGS_KV), env.LOGS_KV || env.AUDIT_LOG_KV ? 'configured' : 'missing', 'Durable observability and security history depend on KV bindings.'),
    dependency('GitHub', 'Repo write-back for analytics uploads and Actions automation', hasEnv(env, 'GITHUB_PAT') && hasEnv(env, 'GITHUB_REPO'), hasEnv(env, 'GITHUB_PAT') ? 'configured' : 'missing', 'Used for upload write-back and off-platform automation.'),
    dependency('Backblaze B2', 'Private media archive', hasEnv(env, 'B2_KEY_ID') && hasEnv(env, 'B2_APP_KEY') && hasEnv(env, 'B2_ENDPOINT') && hasEnv(env, 'B2_BUCKET'), hasEnv(env, 'B2_BUCKET') ? 'configured' : 'missing', 'Keeps the media library durable outside the Pages deployment.'),
    dependency('Anthropic', 'Digest draft summarization', hasEnv(env, 'ANTHROPIC_API_KEY'), hasEnv(env, 'ANTHROPIC_API_KEY') ? 'configured' : 'missing', 'Required for autonomous digest drafting.'),
    dependency('Resend', 'Digest email delivery', hasEnv(env, 'RESEND_API_KEY') && hasEnv(env, 'WEEKLY_DIGEST_FROM'), hasEnv(env, 'RESEND_API_KEY') ? 'configured' : 'missing', 'Required for review and final digest email delivery.'),
  ];
}

async function runInternalProbes(request) {
  const cookie = request.headers.get('Cookie') || '';
  const rows = await Promise.all(PROBE_TARGETS.map((target) => probe(request.url, cookie, target)));
  const checks = rows.map((row) => check(
    `probe:${probeId(row.target)}`,
    `Probe ${row.target}`,
    'important',
    !!row.ok,
    `${row.target} responded with ${row.status} in ${row.ms} ms.`,
    `${row.target} failed with ${row.status || 0}${row.error ? ` (${row.error})` : ''}.`
  ));

  return {
    total: rows.length,
    healthy: rows.filter((row) => row.ok).length,
    failed: rows.filter((row) => !row.ok).length,
    rows,
    checks,
  };
}

async function probe(requestUrl, cookie, target) {
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);

  try {
    const res = await fetch(new URL(target, requestUrl).toString(), {
      method: 'GET',
      headers: {
        'Cookie': cookie,
        'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8',
      },
      redirect: 'manual',
      signal: ctrl.signal,
    });

    return {
      target,
      ok: res.status >= 200 && res.status < 400,
      status: res.status,
      ms: Date.now() - startedAt,
      contentType: String(res.headers.get('Content-Type') || '').slice(0, 80),
    };
  } catch (error) {
    return {
      target,
      ok: false,
      status: 0,
      ms: Date.now() - startedAt,
      error: error && error.name === 'AbortError' ? 'timeout' : 'fetch_failed',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function summarizeLogs(env) {
  const ns = env.LOGS_KV || env.AUDIT_LOG_KV || null;
  if (!ns) {
    return {
      available: false,
      totalSampled: 0,
      lastEventAt: null,
      lastError: null,
      counts24h: { total: 0, warning: 0, error: 0, admin: 0, auth: 0 },
      checks: [check('recent-log-freshness', 'Recent operational evidence', 'important', false, 'Recent logs are available.', 'No durable operational log store is configured.')],
    };
  }

  try {
    const listed = await ns.list({ prefix: 'log:', limit: LOG_SAMPLE_LIMIT });
    const keys = (listed.keys || []).map((row) => row.name).slice(0, LOG_SAMPLE_LIMIT);
    const rows = await Promise.all(keys.map((key) => ns.get(key, { type: 'json' })));
    const logs = rows
      .filter((row) => row && typeof row === 'object')
      .map((row, index) => normalizeLog(row, keys[index]))
      .sort((left, right) => (left.t < right.t ? 1 : -1));

    const now = Date.now();
    const last24h = logs.filter((row) => now - Date.parse(row.t) <= 24 * 60 * 60 * 1000);
    const lastEventAt = logs[0]?.t || null;
    const freshnessMinutes = lastEventAt ? Math.round((now - Date.parse(lastEventAt)) / 60000) : null;
    const lastError = logs.find((row) => row.level === 'error' || (Number.isFinite(row.status) && row.status >= 500)) || null;
    const freshEnough = lastEventAt ? (now - Date.parse(lastEventAt)) <= 7 * 24 * 60 * 60 * 1000 : false;

    return {
      available: true,
      totalSampled: logs.length,
      listComplete: !!listed.list_complete,
      lastEventAt,
      freshnessMinutes,
      lastError,
      counts24h: {
        total: last24h.length,
        warning: last24h.filter((row) => row.level === 'warning').length,
        error: last24h.filter((row) => row.level === 'error' || (Number.isFinite(row.status) && row.status >= 500)).length,
        admin: last24h.filter((row) => row.category === 'admin').length,
        auth: last24h.filter((row) => row.category === 'auth').length,
      },
      checks: [
        check('recent-log-freshness', 'Recent operational evidence', 'important', freshEnough, 'Recent logs exist within the last 7 days.', 'Operational logs are stale or absent for more than 7 days.'),
      ],
    };
  } catch {
    return {
      available: false,
      totalSampled: 0,
      lastEventAt: null,
      lastError: null,
      counts24h: { total: 0, warning: 0, error: 0, admin: 0, auth: 0 },
      checks: [check('recent-log-freshness', 'Recent operational evidence', 'important', false, 'Recent logs are available.', 'Operational log store is configured but could not be read.')],
    };
  }
}

function buildScore(checks) {
  const weights = { critical: 15, important: 6, advisory: 2 };
  const max = checks.reduce((sum, row) => sum + (weights[row.severity] || 1), 0) || 1;
  const earned = checks.reduce((sum, row) => sum + (row.ok ? (weights[row.severity] || 1) : 0), 0);
  const value = Math.round((earned / max) * 100);
  const criticalFailures = checks.filter((row) => !row.ok && row.severity === 'critical').length;
  const importantFailures = checks.filter((row) => !row.ok && row.severity === 'important').length;

  return {
    value,
    status: criticalFailures ? 'critical' : importantFailures ? 'warning' : 'healthy',
    passing: checks.filter((row) => row.ok).length,
    total: checks.length,
    criticalFailures,
    importantFailures,
  };
}

function buildRecommendations({ envChecks, domainChecks, probes, logSummary, dependencyMatrix }) {
  const recs = [];

  for (const row of [...domainChecks, ...envChecks, ...probes.checks, ...logSummary.checks]) {
    if (row.ok) continue;
    recs.push({ severity: row.severity, title: row.label, action: row.failure });
  }

  for (const dep of dependencyMatrix) {
    if (dep.configured) continue;
    recs.push({
      severity: dep.mode === 'missing' ? 'important' : 'advisory',
      title: `${dep.service} dependency`,
      action: `${dep.service} is not configured for ${dep.role}.`,
    });
  }

  return dedupeRecommendations(recs)
    .sort((left, right) => severityRank(left.severity) - severityRank(right.severity))
    .slice(0, 10);
}

function dedupeRecommendations(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = `${row.title}|${row.action}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function severityRank(severity) {
  if (severity === 'critical') return 0;
  if (severity === 'important') return 1;
  return 2;
}

function mapChecks(checks) {
  return new Map(checks.map((row) => [row.id, row]));
}

function isOk(checkMap, id) {
  return !!checkMap.get(id)?.ok;
}

function check(id, label, severity, ok, success, failure) {
  return { id, label, severity, ok, success, failure };
}

function domainCheck(id, label, ok, severity, success, failure) {
  return { id, label, severity, ok, success, failure };
}

function dependency(service, role, configured, mode, note) {
  return { service, role, configured, mode, note };
}

function hasEnv(env, key) {
  return !!String(env[key] || '').trim();
}

function probeId(target) {
  return String(target || '')
    .replace(/^\//, '')
    .replace(/\?.*$/, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'root';
}

function normalizeLog(row, key) {
  return {
    key,
    t: typeof row.t === 'string' ? row.t : new Date(0).toISOString(),
    level: String(row.level || 'info').toLowerCase(),
    category: String(row.category || 'ops').toLowerCase(),
    event: String(row.event || ''),
    message: String(row.message || ''),
    path: String(row.path || ''),
    status: Number.isFinite(row.status) ? Number(row.status) : null,
  };
}
