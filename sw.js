const CACHE_NAME = "fxdash-v1";

// 앱 쉘(오프라인에서도 최소 UI가 뜨게)
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest"
];

// install: 앱 쉘 선캐시
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

// activate: 이전 캐시 정리
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : null)))
    )
  );
  self.clients.claim();
});

// fetch 전략
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 같은 origin만
  if (url.origin !== self.location.origin) return;

  // API: network-first (실시간 우선), 실패하면 cache fallback
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // 정적: cache-first
  event.respondWith(caches.match(req).then((cached) => cached || fetch(req)));
});