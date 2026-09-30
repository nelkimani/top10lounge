// Top 10 Lounge service worker.
// Bump VERSION whenever this file's caching rules change; old caches are deleted on activate.
const VERSION = 'v2';
const SHELL = 'top10-shell-' + VERSION;
const FONTS = 'top10-fonts-' + VERSION;
const IMGS = 'top10-img-' + VERSION;
const PRECACHE = ['/offline.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/icons/favicon-32.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (![SHELL, FONTS, IMGS].includes(k)) await caches.delete(k);
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;                                  // orders are POSTs: never touched

  // Google Fonts: serve from cache, refresh in the background.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(r => { if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (url.origin !== location.origin) return;

  // Live data and the staff admin page always go to the network. Never cache prices, orders or admin.
  if (url.pathname.startsWith('/api/') || url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return;

  // The site itself: network first so new prices/edits show up, cached copy when offline.
  if (req.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html')) {
    e.respondWith((async () => {
      try {
        const res = (await e.preloadResponse) || (await fetch(req));
        if (res.ok) { const c = await caches.open(SHELL); c.put('/', res.clone()); }
        return res;
      } catch (_) {
        return (await caches.match('/')) || (await caches.match('/offline.html'));
      }
    })());
    return;
  }

  // Other pages (e.g. /admin.html) are not ours to cache.
  if (req.mode === 'navigate') return;

  // Product photos: show the saved copy instantly, refresh it in the background.
  // (The ?v= number in the URL changes when a photo is replaced, so a new photo is a new cache entry.)
  if (url.pathname.startsWith('/img/')) {
    e.respondWith(caches.open(IMGS).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }

  // Icons, manifest: cache first.
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
    if (r.ok) caches.open(SHELL).then(c => c.put(req, r.clone()));
    return r;
  })));
});
