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
const TOKEN_EXPIRY_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW = 60 * 60 * 1000;
const rateLimits = new Map();

// ══════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════

export async function onRequestPost(context) {
  const { request, env } = context;
  const headers = corsHeaders();

  try {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (isRateLimited(ip)) {
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
  return new Response(null, { headers: corsHeaders() });
}

function corsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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
    const decoded = atob(content.slice(0, 1000));
    if (!decoded.includes(',') && !decoded.includes('\t') && !decoded.includes('\n')) {
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
      recordRateLimit(ip);
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
      recordRateLimit(ip);
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
  const secret = env.TOKEN_SECRET || 'okn-default-secret';
  const payload = Date.now().toString();
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return payload + '.' + Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyToken(token, env) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const timestamp = parseInt(parts[0]);
  if (isNaN(timestamp) || Date.now() - timestamp > TOKEN_EXPIRY_MS) return false;

  const secret = env.TOKEN_SECRET || 'okn-default-secret';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(parts[0]));
  const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return expected === parts[1];
}

// ══════════════════════════════════════
// RATE LIMITING
// ══════════════════════════════════════

function isRateLimited(ip) {
  const now = Date.now();
  const record = rateLimits.get(ip);
  if (!record) return false;
  if (now - record.start > RATE_LIMIT_WINDOW) { rateLimits.delete(ip); return false; }
  return record.count >= RATE_LIMIT_MAX;
}

function recordRateLimit(ip) {
  const now = Date.now();
  const record = rateLimits.get(ip);
  if (!record || now - record.start > RATE_LIMIT_WINDOW) {
    rateLimits.set(ip, { start: now, count: 1 });
  } else {
    record.count++;
  }
}
