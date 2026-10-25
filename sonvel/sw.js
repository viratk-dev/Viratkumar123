// Sonvel service worker: precache the app shell, cache CDN libraries and fonts on first use.
const VERSION = 'sonvel-v1.0.0';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/app.js', './js/dsp.js', './js/pipeline.js', './js/engine.js', './js/waveform.js',
  './js/dsp-worker.js', './js/whisper-worker.js', './js/mp3-worker.js', './js/capture-worklet.js',
  './icons/logo.svg', './icons/logo-dark.svg', './icons/logo-mark.svg', './icons/favicon.svg', './icons/favicon-32.png',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png',
];
const RUNTIME = 'sonvel-runtime-v1';
// Libraries used offline after first load (pinned versions, so cache-first is safe).
const CDN_PRECACHE = [
  'https://cdn.jsdelivr.net/npm/@shiguredo/rnnoise-wasm@2025.1.5/dist/rnnoise.js',
  'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION); await c.addAll(SHELL);
    const r = await caches.open(RUNTIME); await Promise.all(CDN_PRECACHE.map((u) => r.add(new Request(u, { mode: 'cors' })).catch(() => {})));
    self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('sonvel-') && k !== VERSION && k !== RUNTIME) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (e) => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Hugging Face model files are cached by transformers.js itself (Cache API); don't double-store.
  if (/huggingface\.co|hf\.co|cdn-lfs/.test(url.hostname)) return;
  if (url.origin === location.origin) {
    // network-first for the shell so updates land; cache fallback offline
    e.respondWith((async () => {
      try { const res = await fetch(req); if (res.ok) (await caches.open(VERSION)).put(req, res.clone()); return res; }
      catch { return (await caches.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()); }
    })());
    return;
  }
  if (/cdn\.jsdelivr\.net|unpkg\.com|fonts\.(googleapis|gstatic)\.com/.test(url.hostname)) {
    // cache-first: versions are pinned
    e.respondWith((async () => {
      const hit = await caches.match(req); if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') { const c = await caches.open(RUNTIME); c.put(req, res.clone()).catch(() => {}); }
        return res;
      } catch (err) {
        return (await caches.match(req, { ignoreVary: true })) || Response.error();
      }
    })());
  }
});
