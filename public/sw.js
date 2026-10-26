// Service worker: keeps the heavy face-recognition files on the iPad so the
// kiosk starts instantly, even after the app is closed or the iPad restarts.
//
// - /models/* and /vendor/* (~8 MB, never change) → served from the iPad's cache.
//   They're downloaded once, ahead of time, when this worker installs.
// - Everything else (pages, scripts, API calls) → always fetched fresh from the
//   server, so app updates and punches work exactly as before.
//
// If the face models are ever replaced, bump CACHE to force a re-download.
const CACHE = 'kiosk-models-v1';
const PRECACHE = [
  '/vendor/face-api.js',
  '/models/tiny_face_detector_model-weights_manifest.json',
  '/models/tiny_face_detector_model.bin',
  '/models/face_landmark_68_model-weights_manifest.json',
  '/models/face_landmark_68_model.bin',
  '/models/face_recognition_model-weights_manifest.json',
  '/models/face_recognition_model.bin',
  '/models/face_expression_model-weights_manifest.json',
  '/models/face_expression_model.bin',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (!/^\/(models|vendor)\//.test(url.pathname)) return; // not ours → normal network

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(event.request);
    if (hit) return hit;
    const res = await fetch(event.request);
    if (res.ok) cache.put(event.request, res.clone());
    return res;
  })());
});
