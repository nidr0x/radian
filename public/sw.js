const CACHE_NAME = 'radian-shell-v11';
const APP_SHELL = [
  '/', '/index.html', '/manifest.webmanifest', '/icon.svg',
  '/exercises/atlas-push.webp', '/exercises/atlas-pull.webp', '/exercises/atlas-arms.webp',
  '/exercises/atlas-legs.webp', '/exercises/atlas-support.webp',
  '/exercises/individual/incline-press.webp', '/exercises/individual/chest-press.webp',
  '/exercises/individual/cable-fly.webp', '/exercises/individual/lateral-raise.webp',
  '/exercises/individual/triceps-pushdown.webp', '/exercises/individual/overhead-triceps.webp',
  '/exercises/individual/lat-pulldown.webp', '/exercises/individual/chest-supported-row.webp',
  '/exercises/individual/straight-arm-pulldown.webp', '/exercises/individual/reverse-fly.webp',
  '/exercises/individual/biceps-curl.webp', '/exercises/individual/incline-curl.webp',
  '/exercises/individual/machine-crunch.webp', '/exercises/individual/leg-press.webp',
  '/exercises/individual/romanian-deadlift.webp', '/exercises/individual/leg-curl.webp',
  '/exercises/individual/leg-extension.webp', '/exercises/individual/calf-raise.webp',
  '/exercises/individual/shoulder-press.webp',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request).then((cached) => cached ?? fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match('/'))));
});
