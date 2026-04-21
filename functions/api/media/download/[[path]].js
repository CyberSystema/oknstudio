/**
 * OKN Studio — Media Download Proxy
 * ===================================
 * Proxies file downloads from the private B2 bucket.
 * Catch-all route: GET /api/media/download/video/events/file.mp4
 *
 * The [[path]] captures everything after /download/ as an array.
 * Auth is handled by the site-wide middleware.
 *
 * Required Cloudflare env vars:
 *   B2_KEY_ID, B2_APP_KEY, B2_ENDPOINT, B2_BUCKET
 */

import { AwsClient } from 'aws4fetch';

const EXT_TO_CONTENT_TYPE = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', heic: 'image/heic', tiff: 'image/tiff',
  bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', avi: 'video/x-msvideo',
  mkv: 'video/x-matroska', m4v: 'video/mp4',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
  aac: 'audio/aac', flac: 'audio/flac',
  pdf: 'application/pdf', json: 'application/json', csv: 'text/csv',
  txt: 'text/plain', md: 'text/markdown',
  zip: 'application/zip', gz: 'application/gzip',
};

/** Extract region from B2 endpoint: s3.eu-central-003.backblazeb2.com → eu-central-003 */
function extractRegion(endpoint) {
  const match = endpoint.match(/^s3\.([^.]+)\.backblazeb2\.com$/);
  return match ? match[1] : 'us-west-004';
}

export async function onRequestGet(context) {
  const { request, env, params } = context;

  if (!env.B2_KEY_ID || !env.B2_APP_KEY || !env.B2_ENDPOINT || !env.B2_BUCKET) {
    return Response.json({ error: 'B2 not configured' }, { status: 500 });
  }

  const joinedPath = (params.path || []).join('/');
  if (!joinedPath) {
    return Response.json({ error: 'No file path specified' }, { status: 400 });
  }

  let filePath;
  try {
    filePath = sanitizeObjectKey(joinedPath);
  } catch {
    return Response.json({ error: 'Invalid path' }, { status: 400 });
  }

  const region = extractRegion(env.B2_ENDPOINT);

  const s3 = new AwsClient({
    accessKeyId: env.B2_KEY_ID,
    secretAccessKey: env.B2_APP_KEY,
    service: 's3',
    region: region,
  });

  const s3Url = `https://${env.B2_BUCKET}.${env.B2_ENDPOINT}/${filePath}`;

  try {
    /** @type {Record<string, string>} */
    const headers = {};
    const rangeHeader = request.headers.get('Range');
    if (rangeHeader) headers['Range'] = rangeHeader;

    const res = await s3.fetch(s3Url, { method: 'GET', headers });

    if (!res.ok) {
      if (res.status === 404) return Response.json({ error: 'File not found' }, { status: 404 });
      return Response.json({ error: 'Download failed' }, { status: res.status });
    }

    const ext = filePath.split('.').pop().toLowerCase();
    const contentType = EXT_TO_CONTENT_TYPE[ext] || res.headers.get('Content-Type') || 'application/octet-stream';

    const url = new URL(request.url);
    const forceDownload = url.searchParams.has('download');
    const fileName = safeFileName(filePath.split('/').pop() || 'download.bin');

    const responseHeaders = new Headers();
    responseHeaders.set('Content-Type', contentType);
    responseHeaders.set('Content-Disposition', forceDownload
      ? `attachment; filename="${fileName}"`
      : `inline; filename="${fileName}"`);

    const contentLength = res.headers.get('Content-Length');
    if (contentLength) responseHeaders.set('Content-Length', contentLength);

    const contentRange = res.headers.get('Content-Range');
    if (contentRange) responseHeaders.set('Content-Range', contentRange);

    responseHeaders.set('Accept-Ranges', 'bytes');
    responseHeaders.set('Cache-Control', 'private, max-age=86400');

    return new Response(res.body, { status: res.status, headers: responseHeaders });
  } catch (err) {
    console.error('B2 download exception:', err);
    return Response.json({ error: 'B2 connection failed' }, { status: 502 });
  }
}

function sanitizeObjectKey(rawPath) {
  // Defense-in-depth against double-URL-encoding bypass
  // (e.g. `%252e%252e` \u2192 `%2e%2e` \u2192 `..`).
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw new Error('Invalid path');
  }
  if (decoded.includes('%')) {
    // Re-decoding should be a no-op if the input was single-encoded.
    try {
      const reDecoded = decodeURIComponent(decoded);
      if (reDecoded !== decoded) throw new Error('Invalid path');
    } catch {
      throw new Error('Invalid path');
    }
  }

  // Normalise separators \u2014 reject both forward-slash lead and backslashes.
  const normalized = decoded.replaceAll('\\', '/');

  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
    throw new Error('Invalid path');
  }

  // Reject control characters that could be used to smuggle headers/paths.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(normalized)) {
    throw new Error('Invalid path');
  }

  const parts = normalized.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..') {
      throw new Error('Invalid path');
    }
  }

  return parts.join('/');
}

function safeFileName(value) {
  return String(value).replace(/["\\\r\n]/g, '_');
}
