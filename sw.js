/* MAV Health service worker — network-first with offline fallback.
   Fresh code whenever online; the cached shell keeps the app working offline. */
const CACHE = 'mav-health-v10';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/main.js',
  './js/store.js',
  './js/ui.js',
  './js/ai.js',
  './js/ics.js',
  './js/planner.js',
  './js/views/scan.js',
  './js/views/profile.js',
  './js/views/settings.js',
  './js/views/today.js',
  './js/views/calendar.js',
  './js/views/meals.js',
  './js/views/train.js',
  './js/views/team.js',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // only cache good same-origin responses — never overwrite a working
        // shell copy with a 404/500 from a deploy gap, and never stow
        // cross-origin (opaque) responses in the app cache
        if (res.ok && new URL(e.request.url).origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(e.request).then((hit) => hit || caches.match('./index.html'))
      )
  );
});
