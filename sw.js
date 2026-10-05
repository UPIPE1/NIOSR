/* NIOS Result Watcher - service worker */
try { importScripts('./config.js'); } catch (e) { /* config is only needed for pushsubscriptionchange */ }

const CACHE = 'nios-watch-v3';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './admin.html',
  './admin.js',
  './config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first (so updates show up), cache as the offline fallback.
// Only same-origin GETs are handled: calls to the Supabase function are never cached.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html'))),
  );
});

// ------------------------------------------------------------------- push --
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : '' };
  }
  const found = data.type === 'found';
  const daily = data.type === 'daily';

  event.waitUntil((async () => {
    await self.registration.showNotification(data.title || 'NIOS Result Watcher', {
      body: data.body || '',
      icon: './icons/icon-192.png',
      tag: data.tag || (found ? 'nios-result' : daily ? 'nios-daily' : 'nios-test'), // same tag replaces, never stacks
      requireInteraction: found,                  // the result alert stays on screen until tapped
      vibrate: found ? [600, 200, 600, 200, 600, 200, 900] : daily ? [250, 120, 250] : [200],
      data: { url: data.url || './' },
    });
    // If the app is open, tell it so it can refresh and start the alarm right away.
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach((c) => c.postMessage({ type: 'push', payload: data }));
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.focus();
    }
    return self.clients.openWindow(target);
  })());
});

// The browser rotated the push subscription: create a new one and tell the server.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const url = self.NIOS_CONFIG && self.NIOS_CONFIG.FUNCTION_URL;
    const oldKey = event.oldSubscription && event.oldSubscription.options &&
      event.oldSubscription.options.applicationServerKey;
    if (!url || !oldKey) return;
    const sub = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: oldKey,
    });
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'subscribe', subscription: sub.toJSON() }),
    });
  })());
});
