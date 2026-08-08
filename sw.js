/* Winnow service worker: offline app shell only.
 *
 * GitHub API traffic is never cached or intercepted. Unsent notes live in
 * localStorage and are flushed by app.js when the network returns.
 */

const CACHE = 'winnow-shell-v4';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'config.js',
  'manifest.webmanifest',
  'assets/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // never touch api.github.com

  /* Network first so a deploy shows up immediately; cache is the offline net.
   *
   * `cache: 'reload'` matters more than it looks. Pages serves these with
   * max-age=600, and a plain fetch() is served by the HTTP cache, so for ten
   * minutes "network first" quietly returns the old file. This forces a real
   * request and refreshes the HTTP cache with it. */
  event.respondWith(
    fetch(request, { cache: 'reload' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match('index.html')))
  );
});
