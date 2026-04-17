/**
 * OKN Analytics — Upload API (Cloudflare Pages Function)
 * =====================================================
 * Secure file upload endpoint. Validates CSV files and commits them
 * to GitHub as a SINGLE commit using the Git Data API (trees).
 *
 * Required Cloudflare environment variables:
 *   UPLOAD_PASSWORD_HASH  — SHA-256 hex hash of the team password
 *   GITHUB_PAT            — Fine-grained GitHub Personal Access Token
 *   GITHUB_REPO           — e.g. "CyberSystema/oknstudio"
 *   TOKEN_SECRET          — Random string for signing session tokens
 */

// ══════════════════════════════════════
// ALLOWED TARGET FILES
// ══════════════════════════════════════

const ALLOWED = {
  instagram: [
    'content.csv', 'Follows.csv', 'Interactions.csv', 'Link clicks.csv',
    'Reach.csv', 'Views.csv', 'Visits.csv', 'Audience.csv',
  ],
  tiktok: [
    'Content.csv', 'Overview.csv', 'Viewers.csv', 'FollowerHistory.csv',
    'FollowerActivity.csv', 'FollowerGender.csv', 'FollowerTopTerritories.csv',
  ],
};

// Case-insensitive lookup → correct filename
const FILENAME_MAP = {};
for (const [platform, files] of Object.entries(ALLOWED)) {
  FILENAME_MAP[platform] = {};
  for (const f of files) {
    FILENAME_MAP[platform][f.toLowerCase()] = f;
  }
}

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_BATCH_SIZE = 15;
const MAX_TOTAL_UPLOAD_SIZE = 20 * 1024 * 1024;
const MAX_REQUEST_BODY_SIZE = 24 * 1024 * 1024;
const TOKEN_EXPIRY_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW = 60 * 60 * 1000;
const rateLimits = new Map();

// ══════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════

export async function onRequestPost(context) {
  const { request, env } = context;
  const headers = corsHeaders(request, env);

  try {
    const contentLength = Number(request.headers.get('Content-Length') || '0');
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_SIZE) {
      return respond({ ok: false, error: 'Request body too large' }, 413, headers);
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (await isRateLimited(ip, env)) {
      return respond({ ok: false, error: 'Too many requests. Try again later.' }, 429, headers);
    }

    const body = await request.json();

    if (body.action === 'auth') {
      return await handleAuth(body, env, headers);
    } else if (body.action === 'upload_batch') {
      return await handleBatchUpload(body, env, headers, ip);
    } else if (body.action === 'upload') {
      // Legacy single-file upload (backwards compatibility)
      return await handleSingleUpload(body, env, headers, ip);
    } else {
      return respond({ ok: false, error: 'Invalid action' }, 400, headers);
    }
  } catch (e) {
    return respond({ ok: false, error: 'Server error: ' + e.message }, 500, headers);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'https://oknstudio.cybersystema.com',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    },
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const configuredOrigins = (env.UPLOAD_ALLOWED_ORIGINS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  let allowOrigin = 'https://oknstudio.cybersystema.com';
  if (configuredOrigins.includes('*')) {
    allowOrigin = '*';
  } else if (origin && (configuredOrigins.includes(origin) || origin === allowOrigin)) {
    allowOrigin = origin;
  }

  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function respond(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}

// ══════════════════════════════════════
// AUTH
// ══════════════════════════════════════

async function handleAuth(body, env, headers) {
  const password = body.password;
  if (!password || typeof password !== 'string') {
    return respond({ ok: false, error: 'Password required' }, 400, headers);
  }

  const storedHash = (env.UPLOAD_PASSWORD_HASH || '').toLowerCase().trim();
  if (!storedHash) {
    return respond({ ok: false, error: 'Upload not configured. Set UPLOAD_PASSWORD_HASH.' }, 500, headers);
  }

  const hash = await sha256(password);
  if (hash !== storedHash) {
    return respond({ ok: false, error: 'Wrong password' }, 401, headers);
  }

  const token = await generateToken(env);
  return respond({ ok: true, token }, 200, headers);
}

// ══════════════════════════════════════
// VALIDATE A SINGLE FILE
// ══════════════════════════════════════

function validateFile(platform, filename, content) {
  if (!platform || !ALLOWED[platform]) {
    return { ok: false, error: 'Invalid platform' };
  }
  if (!filename || typeof filename !== 'string') {
    return { ok: false, error: 'No filename' };
  }

  const correctName = FILENAME_MAP[platform][filename.toLowerCase().trim()];
  if (!correctName) {
    return { ok: false, error: `"${filename}" is not allowed for ${platform}` };
  }

  if (!content || typeof content !== 'string') {
    return { ok: false, error: 'No file content' };
  }
  if ((content.length * 3 / 4) > MAX_FILE_SIZE) {
    return { ok: false, error: `${correctName} is too large (max 5MB)` };
  }

  try {
    const decoded = atob(content);
    const sample = decoded.slice(0, 20000);
    const lines = sample.split(/\r?\n/).filter(Boolean);
    const header = lines[0] || '';

    if (lines.length < 2) {
      return { ok: false, error: `${correctName} appears to be empty or header-only` };
    }

    if (!header.includes(',') && !header.includes('\t')) {
      return { ok: false, error: `${correctName} does not appear to be a valid CSV` };
    }
  } catch (e) {
    return { ok: false, error: `${correctName} has invalid encoding` };
  }

  return { ok: true, correctName, path: `analytics-pipeline/data/${platform}/${correctName}` };
}

// ══════════════════════════════════════
// BATCH UPLOAD — single commit
// ══════════════════════════════════════

async function handleBatchUpload(body, env, headers, ip) {
  if (!await verifyToken(body.token, env)) {
    return respond({ ok: false, error: 'Session expired. Please sign in again.' }, 401, headers);
  }

  const files = body.files;
  if (!Array.isArray(files) || files.length === 0) {
    return respond({ ok: false, error: 'No files provided' }, 400, headers);
  }
  if (files.length > MAX_BATCH_SIZE) {
    return respond({ ok: false, error: `Too many files (max ${MAX_BATCH_SIZE})` }, 400, headers);
  }

  const totalBytes = files.reduce((sum, file) => {
    if (!file || typeof file.content !== 'string') return sum;
    return sum + Math.floor((file.content.length * 3) / 4);
  }, 0);
  if (totalBytes > MAX_TOTAL_UPLOAD_SIZE) {
    return respond({ ok: false, error: 'Total upload size exceeds 20MB limit' }, 413, headers);
  }

  // Validate every file before touching GitHub
  const validated = [];
  for (const f of files) {
    const result = validateFile(f.platform, f.filename, f.content);
    if (!result.ok) {
      return respond({ ok: false, error: result.error }, 400, headers);
    }
    validated.push({ path: result.path, content: f.content, name: result.correctName });
  }

  // Commit all files as a single commit
  try {
    const fileNames = validated.map(v => v.name).join(', ');
    const platforms = [...new Set(files.map(f => f.platform))].join(' & ');
    const now = new Date();
    const dateStr = String(now.getUTCDate()).padStart(2,'0') + String(now.getUTCMonth()+1).padStart(2,'0') + now.getUTCFullYear();
    const message = `📤 Update analytics data (${dateStr})\n\n${validated.length} file(s): ${fileNames}\nPlatform(s): ${platforms}`;

    const result = await batchCommitToGitHub(env, validated, message);
    if (result.ok) {
      await recordRateLimit(ip, env);
      return respond({ ok: true, files: validated.length, commit: result.sha }, 200, headers);
    } else {
      return respond({ ok: false, error: result.error }, 500, headers);
    }
  } catch (e) {
    return respond({ ok: false, error: 'GitHub commit failed: ' + e.message }, 500, headers);
  }
}

// ══════════════════════════════════════
// SINGLE UPLOAD — legacy, one file
// ══════════════════════════════════════

async function handleSingleUpload(body, env, headers, ip) {
  if (!await verifyToken(body.token, env)) {
    return respond({ ok: false, error: 'Session expired. Please sign in again.' }, 401, headers);
  }

  const result = validateFile(body.platform, body.filename, body.content);
  if (!result.ok) {
    return respond({ ok: false, error: result.error }, 400, headers);
  }

  try {
    const now = new Date();
    const dateStr = String(now.getUTCDate()).padStart(2,'0') + String(now.getUTCMonth()+1).padStart(2,'0') + now.getUTCFullYear();
    const message = `📤 Update analytics data (${dateStr})\n\n${result.correctName} (${body.platform})`;
    const commitResult = await batchCommitToGitHub(env, [{ path: result.path, content: body.content }], message);
    if (commitResult.ok) {
      await recordRateLimit(ip, env);
      return respond({ ok: true, path: result.path }, 200, headers);
    } else {
      return respond({ ok: false, error: commitResult.error }, 500, headers);
    }
  } catch (e) {
    return respond({ ok: false, error: 'GitHub commit failed: ' + e.message }, 500, headers);
  }
}

// ══════════════════════════════════════
// GITHUB GIT DATA API — atomic commit
// ══════════════════════════════════════
//
// Uses the Git Data API to create a single commit with multiple files:
//   1. Get current branch HEAD → commit SHA
//   2. Get that commit's tree SHA
//   3. Create a blob for each file
//   4. Create a new tree with all blobs
//   5. Create a new commit with that tree
//   6. Update the branch ref to the new commit
//

async function batchCommitToGitHub(env, files, message) {
  const repo = env.GITHUB_REPO || 'CyberSystema/oknstudio';
  const token = env.GITHUB_PAT;
  const branch = env.GITHUB_BRANCH || 'main';

  if (!token) return { ok: false, error: 'GitHub token not configured' };

  const api = `https://api.github.com/repos/${repo}`;
  const gh = (url, opts = {}) => fetch(url, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'OKN-Analytics-Upload',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });

  // 1. Get current HEAD
  const refRes = await gh(`${api}/git/ref/heads/${branch}`);
  if (!refRes.ok) {
    return { ok: false, error: `Cannot read branch (${refRes.status})` };
  }
  const refData = await refRes.json();
  const headSha = refData.object.sha;

  // 2. Get the tree SHA from the HEAD commit
  const commitRes = await gh(`${api}/git/commits/${headSha}`);
  if (!commitRes.ok) {
    return { ok: false, error: `Cannot read commit (${commitRes.status})` };
  }
  const commitData = await commitRes.json();
  const baseTreeSha = commitData.tree.sha;

  // 3. Create a blob for each file
  const treeItems = [];
  for (const file of files) {
    const blobRes = await gh(`${api}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: file.content, encoding: 'base64' }),
    });
    if (!blobRes.ok) {
      const err = await blobRes.json().catch(() => ({}));
      return { ok: false, error: `Blob creation failed for ${file.path}: ${err.message || blobRes.status}` };
    }
    const blobData = await blobRes.json();
    treeItems.push({
      path: file.path,
      mode: '100644',  // regular file
      type: 'blob',
      sha: blobData.sha,
    });
  }

  // 4. Create a new tree
  const treeRes = await gh(`${api}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems }),
  });
  if (!treeRes.ok) {
    const err = await treeRes.json().catch(() => ({}));
    return { ok: false, error: `Tree creation failed: ${err.message || treeRes.status}` };
  }
  const treeData = await treeRes.json();

  // 5. Create a new commit
  const newCommitRes = await gh(`${api}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message,
      tree: treeData.sha,
      parents: [headSha],
    }),
  });
  if (!newCommitRes.ok) {
    const err = await newCommitRes.json().catch(() => ({}));
    return { ok: false, error: `Commit creation failed: ${err.message || newCommitRes.status}` };
  }
  const newCommitData = await newCommitRes.json();

  // 6. Update the branch ref
  const updateRes = await gh(`${api}/git/refs/heads/${branch}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: newCommitData.sha }),
  });
  if (!updateRes.ok) {
    const err = await updateRes.json().catch(() => ({}));
    return { ok: false, error: `Ref update failed: ${err.message || updateRes.status}` };
  }

  return { ok: true, sha: newCommitData.sha };
}

// ══════════════════════════════════════
// CRYPTO & TOKENS
// ══════════════════════════════════════

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function generateToken(env) {
  const secret = getRequiredTokenSecret(env);
  const payload = Date.now().toString();
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return payload + '.' + Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyToken(token, env) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const timestamp = Number(parts[0]);
  if (!Number.isSafeInteger(timestamp)) return false;
  if (timestamp > Date.now()) return false;
  if (Date.now() - timestamp > TOKEN_EXPIRY_MS) return false;

  let secret;
  try {
    secret = getRequiredTokenSecret(env);
  } catch {
    return false;
  }

  const sigBytes = hexToBytes(parts[1]);
  if (!sigBytes) return false;

  // Use crypto.subtle.verify for constant-time HMAC comparison
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(parts[0]));
}

function hexToBytes(hex) {
  if (!hex || hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const n = parseInt(hex.slice(i, i + 2), 16);
    if (isNaN(n)) return null;
    bytes[i / 2] = n;
  }
  return bytes;
}

// ══════════════════════════════════════
// RATE LIMITING
// ══════════════════════════════════════

async function isRateLimited(ip, env) {
  if (env.RATE_LIMIT_KV) {
    const payload = await env.RATE_LIMIT_KV.get(`upload_rl:${ip}`, { type: 'json' });
    if (!payload) return false;
    const now = Date.now();
    if (now - payload.start > RATE_LIMIT_WINDOW) return false;
    return payload.count >= RATE_LIMIT_MAX;
  }

  const now = Date.now();
  const record = rateLimits.get(ip);
  if (!record) return false;
  if (now - record.start > RATE_LIMIT_WINDOW) { rateLimits.delete(ip); return false; }
  return record.count >= RATE_LIMIT_MAX;
}

async function recordRateLimit(ip, env) {
  if (env.RATE_LIMIT_KV) {
    const key = `upload_rl:${ip}`;
    const now = Date.now();
    const record = await env.RATE_LIMIT_KV.get(key, { type: 'json' });
    let next;
    if (!record || now - record.start > RATE_LIMIT_WINDOW) {
      next = { start: now, count: 1 };
    } else {
      next = { start: record.start, count: record.count + 1 };
    }
    await env.RATE_LIMIT_KV.put(key, JSON.stringify(next), { expirationTtl: Math.ceil(RATE_LIMIT_WINDOW / 1000) + 60 });
    return;
  }

  const now = Date.now();
  const record = rateLimits.get(ip);
  if (!record || now - record.start > RATE_LIMIT_WINDOW) {
    rateLimits.set(ip, { start: now, count: 1 });
  } else {
    record.count++;
  }
}

function getRequiredTokenSecret(env) {
  const secret = (env.TOKEN_SECRET || '').trim();
  if (!secret) {
    throw new Error('TOKEN_SECRET not configured');
  }
  return secret;
}
