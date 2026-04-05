const CACHE_NAME = "cricket-arena-v3";  // Increment version each time you want a fresh cache
const ASSETS_TO_CACHE = [
    "./",
    "./index.html",
    "./style.css",
    "./app.js",
    "./manifest.json",
    "https://unpkg.com/dexie/dist/dexie.js",
    "https://cdn.jsdelivr.net/npm/sweetalert2@11"
];

self.addEventListener("install", (event) => {
    self.skipWaiting();  // Force waiting service worker to become active
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cache) => {
                    if (cache !== CACHE_NAME) return caches.delete(cache);
                })
            );
        })
    );
    self.clients.claim();  // Take control of all open pages immediately
});

self.addEventListener("fetch", (event) => {
    event.respondWith(
        caches.match(event.request).then((response) => response || fetch(event.request))
    );
});
