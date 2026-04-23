const DEFAULT_PATH = '/api/internal/digest-draft';

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(triggerDraftCreation(env, controller.cron || 'scheduled'));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'digest-cron-worker' });
    }

    if (url.pathname === '/run' && request.method === 'POST') {
      if (!(await isAuthorized(request, env))) {
        return Response.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
      }
      return triggerDraftCreation(env, 'manual');
    }

    return new Response('Not found', { status: 404 });
  },
};

async function triggerDraftCreation(env, trigger) {
  const targetUrl = buildTargetUrl(env);
  const secret = String(env.DIGEST_CRON_SECRET || '').trim();

  if (!targetUrl) {
    throw new Error('DIGEST_CRON_TARGET_URL is not configured.');
  }
  if (!secret) {
    throw new Error('DIGEST_CRON_SECRET is not configured.');
  }

  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'User-Agent': `okn-digest-cron/${trigger}`,
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Digest cron target failed (${response.status}): ${text.slice(0, 500)}`);
  }

  return new Response(text, {
    status: 200,
    headers: { 'content-type': response.headers.get('content-type') || 'application/json' },
  });
}

function buildTargetUrl(env) {
  const raw = String(env.DIGEST_CRON_TARGET_URL || '').trim();
  if (raw) return raw;

  const apiBaseUrl = String(env.DIGEST_CRON_API_BASE_URL || '').trim();
  if (!apiBaseUrl) return '';
  return new URL(DEFAULT_PATH, apiBaseUrl).toString();
}

async function isAuthorized(request, env) {
  const expected = String(env.DIGEST_CRON_SECRET || '').trim();
  if (!expected) return false;
  const auth = String(request.headers.get('authorization') || '');
  const provided = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!provided) return false;
  return timingSafeEqual(provided, expected);
}

async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const [sigA, sigB] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode(a)),
    crypto.subtle.sign('HMAC', key, enc.encode(b)),
  ]);
  const aArr = new Uint8Array(sigA);
  const bArr = new Uint8Array(sigB);
  let diff = 0;
  for (let i = 0; i < aArr.length; i++) diff |= aArr[i] ^ bArr[i];
  return diff === 0;
}
