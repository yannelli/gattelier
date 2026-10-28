const CACHE_PREFIX = 'nanoscope-shell-';
const CACHE_NAME = `${CACHE_PREFIX}__NANO_BUILD__`;
const SHELL = ['/', '/app.bundle.js', '/app.bundle.css', '/manifest.webmanifest',
  '/vendors.json', '/metadata-v1.json', '/icons/nanoscope-180.png', '/icons/nanoscope-192.png', '/icons/nanoscope-512.png'];

function shellPath(request) {
  const url = new URL(request.url);
  if (url.pathname === '/metadata-v1.json' && request.cache === 'no-store') return null;
  return request.method === 'GET' && url.origin === self.location.origin && SHELL.includes(url.pathname)
    ? url.pathname : null;
}

async function fillCache(name) {
  const responses = await Promise.all(SHELL.map(async path => {
    const response = await fetch(path, { cache: 'reload', credentials: 'omit' });
    if (!response.ok || response.redirected) throw new Error(`Cannot cache ${path}`);
    return [path, response];
  }));
  const cache = await caches.open(name);
  await Promise.all(responses.map(([path, response]) => cache.put(path, response)));
}

self.addEventListener('install', event => event.waitUntil(fillCache(CACHE_NAME)));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const name of await caches.keys()) {
    if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) await caches.delete(name);
  }
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const path = shellPath(event.request);
  if (!path) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const saved = await cache.match(path);
    if (saved) return saved;
    const response = await fetch(path, { cache: 'reload', credentials: 'omit' });
    if (response.ok && !response.redirected) await cache.put(path, response.clone());
    return response;
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') { self.skipWaiting(); return; }
  if (event.data?.type !== 'REFRESH_SHELL') return;
  event.waitUntil((async () => {
    try {
      await fillCache(CACHE_NAME);
      event.ports[0]?.postMessage({ ok: true });
    } catch (error) {
      event.ports[0]?.postMessage({ ok: false, error: error.message });
    }
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) await existing.focus();
    else await self.clients.openWindow('/');
  })());
});
