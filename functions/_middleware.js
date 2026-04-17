/**
 * OKN Studio — Authentication Middleware (Hardened)
 * =================================================
 * Single site-wide password protecting all pages and API routes.
 *
 * Every request requires a valid session cookie (okns_auth).
 *
 * Required Cloudflare env vars:
 *   SITE_PASSWORD_HASH  — SHA-256 hex hash of the site password
 *   TOKEN_SECRET        — Random secret for HMAC session signing
 */

const SITE_COOKIE = 'okns_auth';
const MAX_BODY = 10 * 1024;
const MAX_AGE = 30 * 24 * 60 * 60;       // 30 days (seconds)
const RATE_WINDOW = 15 * 60 * 1000;      // 15 min (ms)
const RATE_MAX = 5;
const attempts = new Map();

// ══════════════════════════════════════
// SECURITY HEADERS
// ══════════════════════════════════════

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function applySecurityHeaders(response) {
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    out.headers.set(k, v);
  }
  return out;
}

// ══════════════════════════════════════
// ENTRY POINT
// ══════════════════════════════════════

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // ── Site login POST ──
  if (url.pathname === '/_auth' && request.method === 'POST') {
    return handleSiteLogin(request, env);
  }

  // ── Check site session ──
  const siteCookie = parseCookie(request, SITE_COOKIE);
  if (!siteCookie || !(await verifySession(siteCookie, env))) {
    return htmlResponse(loginHTML({
      pageTitle: 'Authenticate — OKN Studio',
      kicker: 'Secure Channel',
      heading: 'Enter',
      accent: 'Studio',
      sub: '<span>HTTPS</span><span class="divider">\u00b7</span><span>HMAC-SHA256</span><span class="divider">\u00b7</span><span>30-day</span>',
      action: '/_auth',
      hiddenFields: '',
      redirect: url.pathname,
      error: '',
      chromeRight: '<div class="auth-label"><span class="dot"></span>Auth Required</div>',
      footLeft: '<span class="secure">\u25c9 Encrypted</span>',
    }), 401);
  }

  // ── Authenticated — pass through with hardened headers ──
  const response = await next();
  return applySecurityHeaders(response);
}

// ══════════════════════════════════════
// SITE LOGIN
// ══════════════════════════════════════

async function handleSiteLogin(request, env) {
  try {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (isLimited(ip)) {
      return htmlResponse(loginHTML({
        pageTitle: 'Authenticate — OKN Studio',
        kicker: 'Secure Channel',
        heading: 'Enter',
        accent: 'Studio',
        sub: '<span>HTTPS</span><span class="divider">\u00b7</span><span>HMAC-SHA256</span>',
        action: '/_auth',
        hiddenFields: '',
        redirect: '/',
        error: 'Too many attempts \u2014 wait 15 minutes.',
        chromeRight: '<div class="auth-label"><span class="dot"></span>Auth Required</div>',
        footLeft: '<span class="secure">\u25c9 Encrypted</span>',
      }), 429);
    }

    if (bodyTooLarge(request)) {
      return new Response('Payload too large', { status: 413 });
    }

    const form = await request.formData();
    const password = form.get('password') || '';
    const redirect = sanitizeRedirect(form.get('redirect') || '/');

    const stored = (env.SITE_PASSWORD_HASH || '').toLowerCase().trim();
    if (!stored) {
      return new Response('SITE_PASSWORD_HASH not configured', { status: 500 });
    }

    const hash = await sha256(password);
    if (!(await timeSafeEqual(hash, stored))) {
      recordAttempt(ip);
      return htmlResponse(loginHTML({
        pageTitle: 'Authenticate — OKN Studio',
        kicker: 'Secure Channel',
        heading: 'Enter',
        accent: 'Studio',
        sub: '<span>HTTPS</span><span class="divider">\u00b7</span><span>HMAC-SHA256</span><span class="divider">\u00b7</span><span>30-day</span>',
        action: '/_auth',
        hiddenFields: '',
        redirect,
        error: 'Wrong password \u2014 please try again.',
        chromeRight: '<div class="auth-label"><span class="dot"></span>Auth Required</div>',
        footLeft: '<span class="secure">\u25c9 Encrypted</span>',
      }), 401);
    }

    const token = await signSession(env);
    return new Response(null, {
      status: 302,
      headers: {
        'Location': redirect,
        'Set-Cookie': `${SITE_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`,
      },
    });
  } catch {
    return new Response('Authentication error', { status: 500 });
  }
}

// ══════════════════════════════════════
// SESSION HELPERS
// ══════════════════════════════════════

function parseCookie(request, name) {
  const hdr = request.headers.get('Cookie') || '';
  const m = hdr.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? m[1] : null;
}

async function signSession(env) {
  const secret = requireSecret(env);
  const payload = Date.now().toString();
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return payload + '.' + hex(new Uint8Array(sig));
}

async function verifySession(token, env) {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const ts = token.slice(0, dot);
  const sigHex = token.slice(dot + 1);
  const timestamp = Number(ts);
  if (!Number.isSafeInteger(timestamp) || timestamp > Date.now()) return false;
  if (Date.now() - timestamp > MAX_AGE * 1000) return false;

  let secret;
  try { secret = requireSecret(env); } catch { return false; }

  const sigBytes = unhex(sigHex);
  if (!sigBytes) return false;

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  return crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(ts));
}

// ══════════════════════════════════════
// CRYPTO
// ══════════════════════════════════════

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return hex(new Uint8Array(buf));
}

/**
 * Constant-time string comparison via HMAC.
 * Signs `a`, then verifies the signature against `b`.
 * crypto.subtle.verify uses constant-time comparison internally.
 */
async function timeSafeEqual(a, b) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode('okns-ts-cmp'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(a));
  return crypto.subtle.verify('HMAC', key, sig, enc.encode(b));
}

function hex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function unhex(h) {
  if (!h || h.length % 2) return null;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < h.length; i += 2) {
    const n = parseInt(h.slice(i, i + 2), 16);
    if (isNaN(n)) return null;
    out[i / 2] = n;
  }
  return out;
}

// ══════════════════════════════════════
// RATE LIMITING (in-memory; ephemeral on Workers cold starts)
// ══════════════════════════════════════

function isLimited(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (now - rec.start > RATE_WINDOW) { attempts.delete(ip); return false; }
  return rec.count >= RATE_MAX;
}

function recordAttempt(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.start > RATE_WINDOW) {
    attempts.set(ip, { start: now, count: 1 });
  } else {
    rec.count++;
  }
}

// ══════════════════════════════════════
// VALIDATION
// ══════════════════════════════════════

function requireSecret(env) {
  const s = (env.TOKEN_SECRET || '').trim();
  if (!s) throw new Error('TOKEN_SECRET not configured');
  return s;
}

function sanitizeRedirect(val) {
  const r = String(val || '').trim();
  if (!r.startsWith('/') || r.startsWith('//') || r.includes('\\') || /\r|\n/.test(r)) return '/';
  return r;
}

function bodyTooLarge(request) {
  const cl = Number(request.headers.get('Content-Length') || '0');
  return Number.isFinite(cl) && cl > MAX_BODY;
}

function htmlResponse(html, status) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  });
}

function esc(v) { return String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
function escAttr(v) { return esc(v).replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }

// ══════════════════════════════════════
// LOGIN PAGE TEMPLATE (shared by site + module)
// ══════════════════════════════════════

function loginHTML({ pageTitle, kicker, heading, accent, sub, action, hiddenFields, redirect, error, chromeRight, footLeft }) {
  const safeRedirect = escAttr(sanitizeRedirect(redirect));
  const errorBlock = error
    ? `<div class="alert">
         <span class="alert-icon">!</span>
         <span class="alert-msg">${esc(error)}</span>
       </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${esc(pageTitle)}</title>
<meta name="theme-color" content="#0a0f14">
<meta name="color-scheme" content="dark">

<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" href="/favicon.svg">
<link rel="mask-icon" href="/favicon.svg" color="#5eead4">

<meta property="og:type" content="website">
<meta property="og:site_name" content="OKN Studio">
<meta property="og:title" content="OKN Studio \u2014 Orthodox Korea Network">
<meta property="og:description" content="The signal studio of the Orthodox Korea Network.">
<meta property="og:url" content="https://oknstudio.cybersystema.com/">
<meta property="og:image" content="https://oknstudio.cybersystema.com/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="OKN Studio">
<meta name="twitter:image" content="https://oknstudio.cybersystema.com/og-image.png">

<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600&family=IBM+Plex+Sans:wght@400;500&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#0a0f14;--bg-2:#0e141b;--bg-3:#121821;
  --signal:#5eead4;--signal-bright:#a7f3d0;--signal-dim:rgba(94,234,212,0.12);
  --text:#e8edf2;--text-dim:rgba(232,237,242,0.55);--text-faint:rgba(232,237,242,0.32);
  --text-ghost:rgba(232,237,242,0.18);
  --line:rgba(255,255,255,0.06);--line-2:rgba(255,255,255,0.1);--line-signal:rgba(94,234,212,0.2);
  --danger:#f87171;--warn:#fbbf24;
  --font-display:'Sora',sans-serif;--font-body:'IBM Plex Sans',sans-serif;--font-mono:'IBM Plex Mono',monospace;
}
html{-webkit-font-smoothing:antialiased}
body{font-family:var(--font-body);background:var(--bg);color:var(--text);min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 20px;position:relative;overflow:hidden;line-height:1.5}
body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(255,255,255,0.012) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.012) 1px,transparent 1px);background-size:48px 48px;pointer-events:none;z-index:0;mask-image:radial-gradient(ellipse at center,black 30%,transparent 85%)}
body::after{content:'';position:fixed;width:800px;height:800px;border-radius:50%;background:radial-gradient(circle,rgba(94,234,212,0.06) 0%,transparent 60%);top:-300px;right:-300px;pointer-events:none;z-index:0}
.chrome{position:fixed;top:0;left:0;right:0;z-index:10;background:rgba(10,15,20,0.7);backdrop-filter:blur(20px);border-bottom:1px solid var(--line)}
.chrome-inner{max-width:1400px;margin:0 auto;padding:12px 32px;display:flex;justify-content:space-between;align-items:center;font-family:var(--font-mono);font-size:11px;color:var(--text-dim)}
.brand{display:flex;align-items:center;gap:10px;color:var(--text)}
.brand svg{width:22px;height:22px}
.brand .slash{color:var(--text-ghost)}
.brand .studio{color:var(--signal)}
.auth-label{font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:var(--text-faint);display:flex;align-items:center;gap:8px}
.auth-label .dot{width:6px;height:6px;border-radius:50%;background:var(--signal);box-shadow:0 0 8px var(--signal);animation:pulse 2s ease-in-out infinite}

.card{position:relative;z-index:1;background:var(--bg-2);border:1px solid var(--line);border-radius:6px;padding:44px 44px 36px;max-width:440px;width:100%;animation:reveal 0.6s cubic-bezier(0.2,0.8,0.2,1) both;overflow:hidden}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,var(--signal),transparent)}
.card-tl{position:absolute;top:0;left:0;width:24px;height:24px;border-top:1px solid var(--signal);border-left:1px solid var(--signal);opacity:0.4}
.card-br{position:absolute;bottom:0;right:0;width:24px;height:24px;border-bottom:1px solid var(--signal);border-right:1px solid var(--signal);opacity:0.4}

.card-head{text-align:center;margin-bottom:32px}
.kicker{display:inline-flex;align-items:center;gap:10px;padding:5px 12px;border:1px solid var(--line-signal);background:var(--signal-dim);border-radius:3px;font-family:var(--font-mono);font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:var(--signal);margin-bottom:20px}
.kicker .dot{width:5px;height:5px;border-radius:50%;background:var(--signal);box-shadow:0 0 6px var(--signal)}

h1{font-family:var(--font-display);font-size:36px;font-weight:400;color:var(--text);letter-spacing:-0.025em;line-height:1.05;margin-bottom:10px}
h1 .accent{color:var(--signal);font-weight:500}
.sub{font-family:var(--font-mono);font-size:11px;color:var(--text-faint);letter-spacing:0.12em;text-transform:uppercase}
.sub .divider{color:var(--text-ghost);margin:0 8px}

.field{margin-bottom:16px}
.field-label{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.field-label .label{font-family:var(--font-mono);font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:var(--text-faint)}
.field-label .hint{font-family:var(--font-mono);font-size:10px;color:var(--text-ghost);letter-spacing:0.08em}

.input-wrap{position:relative}
.input-wrap::before{content:'\u203a';position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--signal);font-family:var(--font-mono);font-size:16px;pointer-events:none;opacity:0.7}
input{width:100%;padding:14px 16px 14px 34px;border:1px solid var(--line-2);border-radius:3px;background:var(--bg-3);color:var(--text);font-size:14px;font-family:var(--font-mono);outline:none;transition:all 0.2s;letter-spacing:0.06em}
input:focus{border-color:var(--signal);box-shadow:0 0 0 3px var(--signal-dim)}
input::placeholder{color:var(--text-ghost);letter-spacing:0.2em}

button{width:100%;padding:14px;border:none;border-radius:3px;background:var(--signal);color:var(--bg);font-size:13px;font-weight:600;font-family:var(--font-body);letter-spacing:0.02em;cursor:pointer;margin-top:8px;transition:all 0.25s;display:flex;align-items:center;justify-content:center;gap:10px;position:relative;overflow:hidden}
button::before{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.3),transparent);transform:translateX(-100%);transition:transform 0.6s}
button:hover{background:var(--signal-bright);transform:translateY(-1px);box-shadow:0 8px 24px rgba(94,234,212,0.25)}
button:hover::before{transform:translateX(100%)}
button .arrow{font-family:var(--font-mono);transition:transform 0.25s}
button:hover .arrow{transform:translateX(4px)}

.alert{display:flex;align-items:center;gap:10px;padding:12px 14px;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.25);color:#fca5a5;border-radius:3px;margin-bottom:16px;font-size:13px}
.alert-icon{flex-shrink:0;width:20px;height:20px;background:rgba(248,113,113,0.15);border:1px solid rgba(248,113,113,0.4);border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);font-weight:600;font-size:12px;color:var(--danger)}
.alert-msg{font-family:var(--font-mono);font-size:12px;letter-spacing:0.02em}

.foot{margin-top:28px;padding-top:24px;border-top:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;font-family:var(--font-mono);font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:var(--text-faint)}
.foot a{color:var(--signal);text-decoration:none}
.foot a:hover{color:var(--signal-bright)}
.foot .secure{display:flex;align-items:center;gap:6px;color:var(--signal)}

@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
@keyframes reveal{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
@media(max-width:480px){.chrome-inner{padding:10px 20px}.card{padding:36px 28px 28px}h1{font-size:30px}.foot{flex-direction:column;gap:12px}}
</style>
</head>
<body>

<header class="chrome">
  <div class="chrome-inner">
    <div class="brand">
      <svg viewBox="0 0 32 32" fill="none" stroke="#5eead4" stroke-width="1.5">
        <line x1="16" y1="4" x2="16" y2="12"/><line x1="16" y1="20" x2="16" y2="28"/>
        <line x1="4" y1="16" x2="12" y2="16"/><line x1="20" y1="16" x2="28" y2="16"/>
        <circle cx="16" cy="4" r="2" fill="#5eead4" stroke="none"/>
        <circle cx="16" cy="28" r="2" fill="#5eead4" stroke="none"/>
        <circle cx="4" cy="16" r="2" fill="#5eead4" stroke="none"/>
        <circle cx="28" cy="16" r="2" fill="#5eead4" stroke="none"/>
        <circle cx="16" cy="16" r="3" fill="#5eead4" stroke="none"/>
      </svg>
      <span>OKN<span class="slash">/</span><span class="studio">Studio</span></span>
    </div>
    ${chromeRight}
  </div>
</header>

<div class="card">
  <span class="card-tl"></span>
  <span class="card-br"></span>

  <div class="card-head">
    <div class="kicker"><span class="dot"></span>${esc(kicker)}</div>
    <h1>${heading} <span class="accent">${accent}</span></h1>
    <div class="sub">${sub}</div>
  </div>

  ${errorBlock}

  <form method="POST" action="${escAttr(action)}">
    <input type="hidden" name="redirect" value="${safeRedirect}">
    ${hiddenFields}
    <div class="field">
      <div class="field-label">
        <span class="label">Password</span>
        <span class="hint">required</span>
      </div>
      <div class="input-wrap">
        <input id="pw" type="password" name="password" placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" autofocus autocomplete="off">
      </div>
    </div>
    <button type="submit">
      Authenticate
      <span class="arrow">\u2192</span>
    </button>
  </form>

  <div class="foot">
    ${footLeft}
    <span>by <a href="https://cybersystema.com" target="_blank" rel="noopener">CyberSystema</a></span>
  </div>
</div>

</body>
</html>`;
}
