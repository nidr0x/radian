const CACHE_NAME = 'radian-shell-__BUILD_ID__';
// APP_SHELL is replaced at build time by the version-offline-shell plugin in vite.config.ts
// with the exact paths emitted into dist (hashed Vite assets plus every other shipped file).
// Do not edit by hand: this build placeholder gets swapped for the generated precache list.
const APP_SHELL = "__PRECACHE_MANIFEST__";
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
