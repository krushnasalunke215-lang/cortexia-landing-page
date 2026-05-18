const VERSION = 'cortexia-v16';
const SHELL = [
  '/mobile.css?v=16',
  '/mobile.js?v=16',
  '/icons/icon-192.png'
];

// Install: cache shell assets with new version
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)));
  self.skipWaiting(); // Activate immediately
});

// Activate: purge ALL old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))
    )
  );
  self.clients.claim(); // Take control of all tabs
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Skip API/webhook — always network
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/webhooks/')) return;

  // Network-first for EVERYTHING (HTML, JS, CSS, images).
  // Ensures fresh assets on every load when online, fallback to cache when offline.
  e.respondWith(
    fetch(e.request).then(response => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(VERSION).then(c => c.put(e.request, clone));
      }
      return response;
    }).catch(() => caches.match(e.request))
  );
});
