/**
 * OKN Studio · Darkroom — Service worker
 * ======================================
 * Precaches the Darkroom shell so the tool keeps working offline after the
 * first visit. Strategy:
 *   - Precache static app code on install.
 *   - Network-first for navigation requests (HTML), falling back to cache.
 *   - Stale-while-revalidate for /darkroom/lib/, /_lib/, esm.sh, and fonts.
 *
 * Cache-busting: bump CACHE_NAME whenever shipping a breaking change.
 */

const CACHE_NAME = 'okn-darkroom-v3';

// Keep this list short and predictable — everything else is picked up
// by the runtime cache. These are the files the Darkroom shell always
// needs to boot.
const PRECACHE = [
  '/darkroom/',
  '/darkroom/index.html',
  '/darkroom/lib/app.js',
  '/darkroom/lib/i18n.js',
  '/darkroom/lib/messages.en.js',
  '/darkroom/lib/messages.ko.js',
  '/darkroom/lib/zones/registry.js',
  // Wired zone processors — without these a second-visit offline user
  // sees the card but the drop → dry-run → process flow 404s.
  '/darkroom/lib/zones/archive.js',
  '/darkroom/lib/zones/batch-rename.js',
  '/darkroom/lib/zones/bulk-compress.js',
  '/darkroom/lib/zones/colour-space.js',
  '/darkroom/lib/zones/heic-to-jpeg.js',
  '/darkroom/lib/zones/metadata-studio.js',
  '/darkroom/lib/zones/raw-develop.js',
  '/darkroom/lib/zones/social.js',
  '/darkroom/lib/zones/web-ready.js',
  // Shared engines and job plumbing — imported via the importmap.
  '/_lib/engines/metadata.js',
  '/_lib/engines/rename.js',
  '/_lib/job/dispatcher.js',
  '/_lib/job/intake.js',
  '/_lib/job/worker-pool.js',
  '/_lib/job/zipper.js',
  '/_lib/job/workers/runner.js',
  '/_lib/job/workers/echo.js',
  '/_lib/job/workers/image-encode.js',
  '/_lib/storage/db.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE).catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function shouldRuntimeCache(url) {
  if (url.origin === self.location.origin) {
    return url.pathname.startsWith('/darkroom/') ||
           url.pathname.startsWith('/_lib/');
  }
  // CDN deps we do want cached after first fetch.
  return url.host === 'esm.sh' ||
         url.host === 'fonts.googleapis.com' ||
         url.host === 'fonts.gstatic.com';
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Navigation (HTML): network-first, fall back to cache.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => undefined);
        return resp;
      }).catch(() => caches.match(req).then((m) => m || caches.match('/darkroom/index.html')))
    );
    return;
  }

  if (!shouldRuntimeCache(url)) return;

  // Stale-while-revalidate.
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(req);
      const networkP = fetch(req).then((resp) => {
        if (resp && resp.status === 200) cache.put(req, resp.clone()).catch(() => undefined);
        return resp;
      }).catch(() => cached);
      return cached || networkP;
    })
  );
});
