// Familienwerk service worker.
// Conservative strategy so authenticated/dynamic pages keep working:
//  - navigations: network-first, fall back to cache, then the offline page
//  - static assets: cache-first with background fill
//  - /api/* and cross-origin: never intercepted
// Bump this whenever unhashed static assets change (icons, manifest, fonts) —
// they are served cache-first, so old clients keep stale copies until the name changes.
const CACHE = 'fc-v4';
const OFFLINE_URL = '/offline';
const PRECACHE = [OFFLINE_URL];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(request).then((cached) => cached || caches.match(OFFLINE_URL)),
      ),
    );
    return;
  }

  const isStatic =
    url.pathname.startsWith('/_next/static/') ||
    /\.(?:png|svg|ico|webmanifest|woff2?)$/.test(url.pathname);

  if (isStatic) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const resp = await fetch(request);
        if (resp.ok) cache.put(request, resp.clone());
        return resp;
      }),
    );
  }
});
