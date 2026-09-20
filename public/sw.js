const CACHE_NAME = 'radian-shell-__BUILD_ID__';
const APP_SHELL = [
  '/', '/manifest.webmanifest', '/icon.svg',
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
const CURRENT_SHELL_MARKER = 'name="radian-pwa-version" content="2"';

const hasLegacyShell = async () => {
  const keys = await caches.keys();
  for (const key of keys.filter((candidate) => candidate.startsWith('radian-shell-') && candidate !== CACHE_NAME)) {
    const cache = await caches.open(key);
    const shell = (await cache.match('/')) ?? (await cache.match('/index.html'));
    if (shell && !(await shell.text()).includes(CURRENT_SHELL_MARKER)) return true;
  }
  return false;
};

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then(async (cache) => {
    await cache.addAll(APP_SHELL);
    const shell = await cache.match('/');
    const html = await shell.text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map((match) => match[1]);
    await cache.addAll(assets);
    if (await hasLegacyShell()) self.skipWaiting();
  }));
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('radian-shell-') && key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/.well-known/')) return;
  const isAsset = url.pathname.startsWith('/assets/') || url.pathname.startsWith('/exercises/') || APP_SHELL.includes(url.pathname);
  if (event.request.mode !== 'navigate' && !isAsset) return;
  event.respondWith(caches.open(CACHE_NAME).then(async (cache) => {
    // The HTML and its hashed assets stay on the same release until the user updates.
    if (event.request.mode === 'navigate') return (await cache.match('/')) ?? fetch(event.request);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok && response.type === 'basic') await cache.put(event.request, response.clone());
    return response;
  }));
});
