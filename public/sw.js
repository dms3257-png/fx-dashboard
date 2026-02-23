// sw.js - Service Worker: 모든 요청을 네트워크 우선으로 처리
const CACHE_NAME = 'fx-v5';

// 설치 즉시 활성화
self.addEventListener('install', e => {
  self.skipWaiting();
});

// 활성화 시 이전 캐시 모두 삭제
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 모든 fetch 요청: 항상 네트워크 우선
self.addEventListener('fetch', e => {
  // HTML 요청은 절대 캐시 사용 안 함
  if (e.request.mode === 'navigate' ||
      e.request.headers.get('accept').includes('text/html')) {
    e.respondWith(
      fetch(e.request, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache, no-store' }
      }).catch(() => caches.match(e.request)) // 오프라인 폴백
    );
    return;
  }
  // 나머지(JS/CSS/이미지)도 네트워크 우선
  e.respondWith(
    fetch(e.request, { cache: 'no-store' })
      .catch(() => caches.match(e.request))
  );
});
