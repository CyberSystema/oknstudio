/**
 * OKN Studio — Admin Probes API
 * ==============================
 * Runs synthetic checks against selected first-party paths and returns timing
 * and status metadata for the private admin dashboard.
 */

const DEFAULT_TARGETS = [
  '/_health',
  '/status/',
  '/analytics/',
  '/media/',
  '/darkroom/',
  '/analytics/upload',
  '/admin/',
  '/api/media/list?prefix=',
];

const TARGET_LIMIT = 16;
const TIMEOUT_MS = 8000;

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);

  const fromQuery = (url.searchParams.get('targets') || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

  const targets = (fromQuery.length ? fromQuery : DEFAULT_TARGETS)
    .slice(0, TARGET_LIMIT)
    .filter(isSafeTarget);

  const cookie = request.headers.get('Cookie') || '';
  const probes = await Promise.all(targets.map((target) => probeTarget(target, request.url, cookie)));

  return Response.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    probes,
  }, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}

function isSafeTarget(target) {
  if (!target) return false;
  if (!target.startsWith('/')) return false;
  if (target.startsWith('//')) return false;
  if (target.includes('\\')) return false;
  if (target.includes('\n') || target.includes('\r')) return false;
  return true;
}

async function probeTarget(target, requestUrl, cookie) {
  const started = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const full = new URL(target, requestUrl).toString();
    const res = await fetch(full, {
      method: 'GET',
      headers: {
        'Cookie': cookie,
        'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8',
      },
      signal: ctrl.signal,
      redirect: 'manual',
      cf: {
        cacheTtl: 0,
        cacheEverything: false,
      },
    });

    const ms = Date.now() - started;
    const ct = (res.headers.get('Content-Type') || '').slice(0, 80);

    return {
      target,
      ok: res.status >= 200 && res.status < 400,
      status: res.status,
      ms,
      contentType: ct,
    };
  } catch (err) {
    const ms = Date.now() - started;
    return {
      target,
      ok: false,
      status: 0,
      ms,
      error: err && err.name === 'AbortError' ? 'timeout' : 'fetch_failed',
    };
  } finally {
    clearTimeout(t);
  }
}
