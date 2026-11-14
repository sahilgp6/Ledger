// Offline cache for the app shell. Your financial data is NOT here: it lives encrypted in IndexedDB.
// Cache names are prefixed so this never touches caches of other apps on the same github.io site.
const VERSION = 'ledger-app-v1.7.3';
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './js/app.js', './js/store.js', './js/parsers.js', './js/rules.js', './js/sms.js', './js/planner.js', './js/ai.js', './js/xlsx.js', './js/llm-worker.js',
  './vendor/pdf.min.mjs', './vendor/pdf.worker.min.mjs',
  './fonts/inter-latin-wght-normal.woff2', './fonts/inter-latin-ext-wght-normal.woff2', './fonts/fraunces-latin-opsz-normal.woff2', './fonts/fraunces-latin-ext-opsz-normal.woff2',
  './cloudflare-worker.js', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];
self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache (GitHub Pages caches files for 10 minutes),
  // otherwise a new version could be installed with old files
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('ledger-app-') && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // price APIs etc. go straight to the network
  // Cache-first. The large AI engine files are cached the first time they are used.
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok && url.pathname.includes('/vendor/')) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return res;
    }))
  );
});
