const CACHE = 'bailuyuan-v4';
const IMG_CACHE = 'bailuyuan-img-v3';
const PRECACHE = ['/', '/index.html', '/logo.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(
    ks.filter(k => k !== CACHE && k !== IMG_CACHE).map(k => caches.delete(k))
  )));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Cross-origin images from images.bailuyuan.fun: cache-first with long TTL
  if (url.hostname === 'images.bailuyuan.fun') {
    e.respondWith(caches.open(IMG_CACHE).then(cache =>
      cache.match(e.request).then(r => {
        if (r) return r;
        return fetch(e.request).then(resp => {
          if (resp.ok) cache.put(e.request, resp.clone());
          return resp;
        }).catch(() => new Response('', { status: 408 }));
      })
    ));
    return;
  }

  // Same-origin static assets: cache-first
  if (url.origin === location.origin && url.pathname.match(/\.(css|js|woff2?|png|jpe?g|webp|avif|svg|ico)$/i)) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(resp => {
      if (resp.ok) caches.open(CACHE).then(c => c.put(e.request, resp.clone()));
      return resp;
    })));
    return;
  }

  // HTML: network-first
  if (url.origin === location.origin) {
    e.respondWith(fetch(e.request).then(resp => {
      if (resp.ok) caches.open(CACHE).then(c => c.put(e.request, resp.clone()));
      return resp;
    }).catch(() => caches.match(e.request)));
  }
});
