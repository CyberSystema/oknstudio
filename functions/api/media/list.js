/**
 * OKN Studio — Media Library List API
 * ====================================
 * Lists files and folders from the private B2 bucket via S3-compatible API.
 * Protected by the site-wide auth middleware (cookie check happens before this).
 *
 * GET /api/media/list?prefix=video/events/&cursor=...
 *
 * Required Cloudflare env vars:
 *   B2_KEY_ID, B2_APP_KEY, B2_ENDPOINT, B2_BUCKET
 */

import { AwsClient } from 'aws4fetch';

const MIME_CATEGORIES = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'heic', 'heif', 'tiff', 'bmp', 'raw', 'cr2', 'arw', 'nef'],
  video: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'm4v', 'mts'],
  audio: ['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a', 'wma', 'aiff'],
  document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv'],
  design: ['psd', 'ai', 'fig', 'sketch', 'xd', 'eps'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'],
};

function getFileType(key) {
  const ext = key.split('.').pop().toLowerCase();
  for (const [cat, exts] of Object.entries(MIME_CATEGORIES)) {
    if (exts.includes(ext)) return cat;
  }
  return 'other';
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

/** Extract region from B2 endpoint: s3.eu-central-003.backblazeb2.com → eu-central-003 */
function extractRegion(endpoint) {
  const match = endpoint.match(/^s3\.([^.]+)\.backblazeb2\.com$/);
  return match ? match[1] : 'us-west-004';
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (!env.B2_KEY_ID || !env.B2_APP_KEY || !env.B2_ENDPOINT || !env.B2_BUCKET) {
    return Response.json({ error: 'B2 not configured' }, { status: 500 });
  }

  // Edge cache — avoids hitting B2 for repeated identical listings
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const prefix = url.searchParams.get('prefix') || '';
  const cursor = url.searchParams.get('cursor') || '';
  const maxKeys = 200;

  const region = extractRegion(env.B2_ENDPOINT);

  const s3 = new AwsClient({
    accessKeyId: env.B2_KEY_ID,
    secretAccessKey: env.B2_APP_KEY,
    service: 's3',
    region: region,
  });

  const params = new URLSearchParams({
    'list-type': '2',
    'prefix': prefix,
    'delimiter': '/',
    'max-keys': maxKeys.toString(),
  });
  if (cursor) params.set('continuation-token', cursor);

  const s3Url = `https://${env.B2_BUCKET}.${env.B2_ENDPOINT}/?${params}`;

  try {
    const res = await s3.fetch(s3Url, { method: 'GET' });

    if (!res.ok) {
      const body = await res.text();
      console.error('B2 list error:', res.status, body);
      return Response.json({ error: 'Failed to list files', detail: body.slice(0, 200), status: res.status }, { status: 502 });
    }

    const xml = await res.text();

    const folders = [...xml.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>\s*<\/CommonPrefixes>/g)]
      .map(m => m[1]);

    const files = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)]
      .map(m => {
        const block = m[1];
        const key = block.match(/<Key>([^<]+)<\/Key>/)?.[1] || '';
        const size = parseInt(block.match(/<Size>([^<]+)<\/Size>/)?.[1] || '0');
        const modified = block.match(/<LastModified>([^<]+)<\/LastModified>/)?.[1] || '';
        return { key, size, sizeFormatted: formatSize(size), modified, type: getFileType(key) };
      })
      .filter(f => f.key !== prefix && f.size > 0 && !f.key.endsWith('.bzEmpty'));

    const isTruncated = xml.includes('<IsTruncated>true</IsTruncated>');
    const nextCursor = isTruncated
      ? (xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] || null)
      : null;

    const response = Response.json({
      prefix,
      folders,
      files,
      cursor: nextCursor,
      truncated: isTruncated,
      count: files.length,
      folderCount: folders.length,
    }, {
      headers: { 'Cache-Control': 'private, max-age=1800' },
    });

    context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    console.error('B2 list exception:', err);
    return Response.json({ error: 'B2 connection failed', detail: err.message }, { status: 502 });
  }
}
