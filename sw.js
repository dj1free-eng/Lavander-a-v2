/**

- LaundryPro — sw.js
- Service Worker for full offline-first PWA support.
- Strategy: Cache-first for static assets, network-first for API calls.
  */

“use strict”;

const CACHE_NAME    = “laundrypro-v1.0.0”;
const STATIC_CACHE  = “laundrypro-static-v1.0.0”;
const DYNAMIC_CACHE = “laundrypro-dynamic-v1.0.0”;

// Assets to pre-cache on install
const PRECACHE_ASSETS = [
“/”,
“/index.html”,
“/styles.css”,
“/app.js”,
“/manifest.json”,
// Fonts are loaded via Google Fonts — they will be cached dynamically
];

// ============================================================
// INSTALL — Pre-cache static assets
// ============================================================
self.addEventListener(“install”, (event) => {
console.log(”[SW] Installing v1.0.0”);

event.waitUntil(
caches
.open(STATIC_CACHE)
.then((cache) => {
console.log(”[SW] Pre-caching static assets”);
return cache.addAll(PRECACHE_ASSETS);
})
.then(() => self.skipWaiting())
.catch((err) => console.warn(”[SW] Pre-cache failed:”, err))
);
});

// ============================================================
// ACTIVATE — Cleanup old caches
// ============================================================
self.addEventListener(“activate”, (event) => {
console.log(”[SW] Activating”);

event.waitUntil(
Promise.all([
// Claim all clients immediately
self.clients.claim(),

```
  // Delete outdated caches
  caches.keys().then((cacheNames) =>
    Promise.all(
      cacheNames
        .filter((name) => name !== STATIC_CACHE && name !== DYNAMIC_CACHE)
        .map((name) => {
          console.log("[SW] Deleting old cache:", name);
          return caches.delete(name);
        })
    )
  ),
])
```

);
});

// ============================================================
// FETCH — Cache strategies
// ============================================================
self.addEventListener(“fetch”, (event) => {
const { request } = event;
const url = new URL(request.url);

// Skip non-GET requests and cross-origin API calls
if (request.method !== “GET”) return;
if (url.protocol === “chrome-extension:”) return;

// Strategy: Cache-first for same-origin static files
if (url.origin === self.location.origin) {
event.respondWith(cacheFirst(request));
return;
}

// Strategy: Cache-first for Google Fonts (CDN assets)
if (url.hostname === “fonts.googleapis.com” || url.hostname === “fonts.gstatic.com”) {
event.respondWith(cacheFirst(request));
return;
}

// Strategy: Network-first for everything else (API calls, etc.)
event.respondWith(networkFirst(request));
});

/**

- Cache-first: Try cache, fall back to network, then cache the result.
  */
  async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

try {
const networkResponse = await fetch(request);
if (networkResponse && networkResponse.status === 200) {
const cache = await caches.open(DYNAMIC_CACHE);
cache.put(request, networkResponse.clone());
}
return networkResponse;
} catch (err) {
// Return offline fallback for HTML requests
if (request.destination === “document”) {
const fallback = await caches.match(”/index.html”);
if (fallback) return fallback;
}
return new Response(“Offline”, { status: 503, statusText: “Service Unavailable” });
}
}

/**

- Network-first: Try network, fall back to cache.
  */
  async function networkFirst(request) {
  try {
  const networkResponse = await fetch(request);
  if (networkResponse && networkResponse.status === 200) {
  const cache = await caches.open(DYNAMIC_CACHE);
  cache.put(request, networkResponse.clone());
  }
  return networkResponse;
  } catch (err) {
  const cached = await caches.match(request);
  if (cached) return cached;
  return new Response(JSON.stringify({ error: “Offline”, cached: false }), {
  status: 503,
  headers: { “Content-Type”: “application/json” },
  });
  }
  }

// ============================================================
// BACKGROUND SYNC (experimental — falls back gracefully)
// ============================================================
self.addEventListener(“sync”, (event) => {
if (event.tag === “sync-laundry-data”) {
console.log(”[SW] Background sync triggered”);
// The app handles sync via the Sync module in app.js
// SW sync is a secondary trigger
event.waitUntil(
self.clients.matchAll().then((clients) => {
clients.forEach((client) => {
client.postMessage({ type: “SYNC_REQUESTED” });
});
})
);
}
});

// ============================================================
// MESSAGE HANDLING — Communication with app
// ============================================================
self.addEventListener(“message”, (event) => {
if (event.data && event.data.type === “SKIP_WAITING”) {
self.skipWaiting();
}

if (event.data && event.data.type === “GET_VERSION”) {
event.ports[0].postMessage({ version: CACHE_NAME });
}
});

// ============================================================
// PUSH NOTIFICATIONS (stub — ready for future use)
// ============================================================
self.addEventListener(“push”, (event) => {
if (!event.data) return;

const data = event.data.json();
event.waitUntil(
self.registration.showNotification(data.title || “LaundryPro”, {
body:  data.body  || “”,
icon:  “/icons/icon-192.png”,
badge: “/icons/icon-192.png”,
})
);
});
