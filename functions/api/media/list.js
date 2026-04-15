/**
 * OKN Studio — Media Library List API
 * ====================================
 * Lists files and folders from the private B2 bucket via S3-compatible API.
 * Protected by the site-wide auth middleware (cookie check happens before this).
 *
 * GET /api/media/list?prefix=video/events/&cursor=...
 *
 * Returns JSON:
 * {
 *   folders: ["video/events/2025-04-20_pascha/", ...],
 *   files: [{ key, size, modified, type }, ...],
 *   cursor: "..." | null,
 *   prefix: "video/events/"
 * }
 *
 * Required Cloudflare env vars:
 *   B2_KEY_ID          — Backblaze Application Key ID
 *   B2_APP_KEY         — Backblaze Application Key (secret)
 *   B2_ENDPOINT        — e.g. s3.eu-central-003.backblazeb2.com
 *   B2_BUCKET          — e.g. okn-media-archive
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
  for (const [category, extensions] of Object.entries(MIME_CATEGORIES)) {
    if (extensions.includes(ext)) return category;
  }
  return 'other';
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // Validate env
  if (!env.B2_KEY_ID || !env.B2_APP_KEY || !env.B2_ENDPOINT || !env.B2_BUCKET) {
    return Response.json({ error: 'B2 not configured' }, { status: 500 });
  }

  // ── Edge cache (5 min) — avoids hitting B2 for repeated identical listings ──
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const prefix = url.searchParams.get('prefix') || '';
  const cursor = url.searchParams.get('cursor') || '';
  const maxKeys = 200;

  // Build S3 ListObjectsV2 request
  const s3 = new AwsClient({
    accessKeyId: env.B2_KEY_ID,
    secretAccessKey: env.B2_APP_KEY,
    service: 's3',
    region: 'auto',
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
      return Response.json({ error: 'Failed to list files', status: res.status }, { status: 502 });
    }

    const xml = await res.text();

    // Parse XML response
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
      // Filter out the prefix itself (S3 sometimes returns the folder as an object)
      .filter(f => f.key !== prefix && f.size > 0);

    const isTruncated = xml.includes('<IsTruncated>true</IsTruncated>');
    const nextCursor = isTruncated
      ? (xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] || null)
      : null;

    const response = Response.json({
      prefix,
      folders,
      files,
      cursor: nextCursor,
      count: files.length,
      folderCount: folders.length,
    }, {
      headers: { 'Cache-Control': 'private, max-age=300' },  // 5 min browser cache
    });

    // Store in edge cache (non-blocking)
    context.waitUntil(cache.put(cacheKey, response.clone()));

    return response;
  } catch (err) {
    console.error('B2 list exception:', err);
    return Response.json({ error: 'B2 connection failed' }, { status: 502 });
  }
}
