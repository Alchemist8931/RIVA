// ================================================================
//  RIVA — sw.js
//  Service Worker: cache-first для статической оболочки,
//  не кэширует запросы к Supabase (auth, rest, realtime, storage).
// ================================================================

const CACHE_NAME = 'riva-shell-v2';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './assets/app.js',
  './assets/format.js',
  './assets/favicon.svg'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Не трогаем кросс-origin (Supabase, Google Fonts, jsDelivr, Tailwind CDN, esm.sh)
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, clone));
        }
        return res;
      }).catch(() => cached);

      // stale-while-revalidate
      return cached || fetchPromise;
    })
  );
});
