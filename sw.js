// Offline cache for the app shell. Your financial data is NOT here: it lives encrypted in IndexedDB.
// Cache names are prefixed so this never touches caches of other apps on the same github.io site.
const VERSION = 'ledger-app-v0.1.0';
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './js/app.js', './js/store.js', './js/parsers.js', './js/rules.js',
  './vendor/pdf.min.mjs', './vendor/pdf.worker.min.mjs',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('ledger-app-') && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // price APIs etc. go straight to the network
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request))
  );
});
