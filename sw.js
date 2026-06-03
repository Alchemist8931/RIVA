/* ============================================================
   RIVA — sw.js  (service worker, PWA-кэш)
   ВАЖНО: при каждом релизе меняй версию в CACHE ниже (…-v2.0.1, …-v2.0.2 …)
   — это заставит клиентов сбросить старый кэш и перечитать файлы.
   ============================================================ */

const CACHE = 'riva-v2.0.0';

/* Базовый каркас, кладётся в кэш при установке (пути относительно /RIVA/). */
const CORE = [
  './',
  './index.html',
  './assets/app.js'
];

/* Хосты, которые SW НЕ кэширует и не перехватывает логикой (только сеть). */
function isSupabase(url){
  return /\.supabase\.(co|in)$/.test(url.hostname) || url.hostname.includes('supabase');
}
function isCDN(url){
  return url.hostname.includes('jsdelivr.net')
      || url.hostname.includes('fonts.googleapis.com')
      || url.hostname.includes('fonts.gstatic.com')
      || url.hostname.includes('cdnfonts.com')
      || url.hostname.includes('esm.sh')
      || url.hostname.includes('cdnjs.cloudflare.com');
}
function isHTML(req, url){
  return req.mode === 'navigate'
      || req.destination === 'document'
      || /\.html$/.test(url.pathname);
}

/* ---------- Install: прекэш каркаса ---------- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(c => c.addAll(CORE)).catch(() => {}).then(() => self.skipWaiting())
  );
});

/* ---------- Activate: чистим старые версии кэша ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

/* ---------- Сообщение из приложения: мгновенно активировать новый SW ---------- */
self.addEventListener('message', (event) => {
  if(event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/* ---------- Fetch: стратегии ---------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Только GET. Всё остальное (POST/RPC и т.п.) — мимо SW.
  if(req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch(e) { return; }

  // Supabase (REST/Auth/Realtime/Storage) — никогда не кэшируем и не вмешиваемся.
  if(isSupabase(url)) return;

  // Кросс-доменные CDN (шрифты, supabase-js, иконки) — cache-first.
  if(url.origin !== self.location.origin){
    if(isCDN(url)) event.respondWith(cacheFirst(req));
    return; // прочее кросс-доменное — обычная сеть
  }

  // HTML и modalN.html — network-first (свежесть важнее), кэш — запасной для оффлайна.
  if(isHTML(req, url)){ event.respondWith(networkFirstHTML(req)); return; }

  // Прочая статика того же origin (app.js, css, иконки, картинки) — stale-while-revalidate.
  event.respondWith(staleWhileRevalidate(req));
});

/* ============================================================ Стратегии ============================================================ */

/* network-first для HTML; кэш-ключ нормализуем (без ?v=…), чтобы оффлайн отдавал последнюю версию */
async function networkFirstHTML(req){
  const cache = await caches.open(CACHE);
  try{
    const res = await fetch(req, { cache: 'no-store' });
    if(res && res.ok) cache.put(stripQuery(req), res.clone());
    return res;
  }catch(e){
    const hit = await cache.match(stripQuery(req), { ignoreSearch: true });
    if(hit) return hit;
    // запасной вариант для навигации — каркас
    const shell = await cache.match('./index.html');
    if(shell) return shell;
    return new Response('<h1>Нет соединения</h1>', { status: 503, headers: { 'Content-Type':'text/html; charset=utf-8' } });
  }
}

/* stale-while-revalidate: мгновенно из кэша, параллельно обновляем */
async function staleWhileRevalidate(req){
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  const network = fetch(req).then(res => {
    if(res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return cached || network || fetch(req);
}

/* cache-first: для статики с CDN (шрифты, библиотеки) */
async function cacheFirst(req){
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  if(cached) return cached;
  try{
    const res = await fetch(req);
    if(res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  }catch(e){
    return cached || Response.error();
  }
}

/* убрать query (?v=…) из ключа кэша */
function stripQuery(req){
  try{ const u = new URL(req.url); u.search = ''; return u.toString(); }
  catch(e){ return req; }
}
