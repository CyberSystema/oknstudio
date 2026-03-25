/**
 * OKN Studio — Site-Wide Authentication Middleware
 * ================================================
 * Intercepts every request. If no valid session cookie,
 * shows a login page. On correct password, sets a session cookie.
 *
 * Required Cloudflare env var:
 *   SITE_PASSWORD_HASH — SHA-256 hex hash of the site password
 */

const COOKIE_NAME = 'okns_auth';

export async function onRequest(context) {
  const { request, env, next } = context;

  // Skip auth for the login POST itself
  const url = new URL(request.url);
  if (url.pathname === '/_auth' && request.method === 'POST') {
    return handleLogin(request, env);
  }

  // Check for valid session cookie
  const cookie = getCookie(request, COOKIE_NAME);
  if (cookie) {
    const valid = await verifyAuthCookie(cookie, env);
    if (valid) {
      return next();
    }
  }

  // No valid cookie — show login page
  return new Response(loginPageHTML(url.pathname), {
    status: 401,
    headers: { 'Content-Type': 'text/html;charset=UTF-8' },
  });
}

// ══════════════════════════════════════
// LOGIN HANDLER
// ══════════════════════════════════════

async function handleLogin(request, env) {
  try {
    const form = await request.formData();
    const password = form.get('password') || '';
    const redirect = form.get('redirect') || '/';

    const storedHash = (env.SITE_PASSWORD_HASH || '').toLowerCase().trim();
    if (!storedHash) {
      return new Response('SITE_PASSWORD_HASH not configured', { status: 500 });
    }

    const hash = await sha256(password);
    if (hash !== storedHash) {
      return new Response(loginPageHTML(redirect, 'Wrong password — please try again.'), {
        status: 401,
        headers: { 'Content-Type': 'text/html;charset=UTF-8' },
      });
    }

    // Generate signed session cookie
    const token = await generateAuthCookie(env);

    return new Response(null, {
      status: 302,
      headers: {
        'Location': redirect,
        'Set-Cookie': `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  } catch (e) {
    return new Response('Authentication error', { status: 500 });
  }
}

// ══════════════════════════════════════
// COOKIE HELPERS
// ══════════════════════════════════════

function getCookie(request, name) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : null;
}

async function generateAuthCookie(env) {
  const secret = env.TOKEN_SECRET || 'okns-default';
  const payload = Date.now().toString();
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const sigHex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return payload + '.' + sigHex;
}

async function verifyAuthCookie(token, env) {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const timestamp = parseInt(parts[0]);
  if (isNaN(timestamp)) return false;

  // Session cookie — no expiry check (browser handles it)
  // But reject tokens older than 30 days as a safety net
  if (Date.now() - timestamp > 30 * 24 * 60 * 60 * 1000) return false;

  const secret = env.TOKEN_SECRET || 'okns-default';
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(parts[0]));
  const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return expected === parts[1];
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ══════════════════════════════════════
// LOGIN PAGE HTML
// ══════════════════════════════════════

function loginPageHTML(redirect = '/', error = '') {
  const errorHtml = error
    ? `<div style="background:#fff0f0;color:#c53030;border:1px solid #fed7d7;padding:12px 16px;border-radius:10px;font-size:14px;margin-bottom:16px">${error}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>OKN Studio — Sign In</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@700&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'DM Sans',sans-serif;background:#0f2137;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}
body::before{content:'';position:absolute;width:600px;height:600px;border-radius:50%;background:radial-gradient(circle,rgba(196,149,58,0.06) 0%,transparent 70%);top:-100px;right:-100px}
body::after{content:'';position:absolute;width:500px;height:500px;border-radius:50%;background:radial-gradient(circle,rgba(139,26,26,0.04) 0%,transparent 70%);bottom:-100px;left:-100px}
.card{position:relative;z-index:1;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:48px 40px;max-width:380px;width:100%;text-align:center;backdrop-filter:blur(8px)}
h1{font-family:'Cormorant Garamond',serif;font-size:32px;margin-bottom:4px;color:white}
.sub{color:rgba(255,255,255,0.45);font-size:13px;margin-bottom:32px}
.divider{width:40px;height:2px;background:linear-gradient(90deg,transparent,#c4953a,transparent);margin:12px auto 24px}
input{width:100%;padding:14px 18px;border:2px solid rgba(255,255,255,0.1);border-radius:10px;background:rgba(255,255,255,0.05);color:white;font-size:15px;font-family:'DM Sans',sans-serif;outline:none;transition:border 0.2s}
input:focus{border-color:#c4953a}
input::placeholder{color:rgba(255,255,255,0.3)}
button{width:100%;padding:14px;border:none;border-radius:10px;background:linear-gradient(135deg,#c4953a,#e8c97a);color:#0f2137;font-size:15px;font-weight:600;font-family:'DM Sans',sans-serif;cursor:pointer;margin-top:12px;transition:all 0.2s}
button:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(196,149,58,0.3)}
.foot{color:rgba(255,255,255,0.2);font-size:11px;margin-top:24px}
.foot a{color:rgba(255,255,255,0.3);text-decoration:none}
@media(max-width:480px){.card{margin:16px;padding:36px 28px}h1{font-size:26px}}
</style>
</head>
<body>
<div class="card">
  <h1>OKN Studio</h1>
  <div class="divider"></div>
  <div class="sub">Enter the team password to continue</div>
  ${errorHtml}
  <form method="POST" action="/_auth">
    <input type="hidden" name="redirect" value="${redirect}">
    <input type="password" name="password" placeholder="Team password" autofocus autocomplete="off">
    <button type="submit">Sign In</button>
  </form>
  <div class="foot">Powered by <a href="https://cybersystema.com" target="_blank">CyberSystema</a></div>
</div>
</body>
</html>`;
}
