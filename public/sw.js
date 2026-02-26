// sw.js - v7.0.0  강화된 캐시 우회
// 모든 navigation(HTML 페이지) 요청을 항상 네트워크에서 받아옴
// → 브라우저 캐시가 있어도 SW가 가로채 최신 HTML 강제 로드

const SW_VERSION = 'sw-v7';

self.addEventListener('install', (event) => {
  console.log('[SW] install', SW_VERSION);
  // 대기 없이 즉시 활성화
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[SW] activate', SW_VERSION);
  event.waitUntil(
    // 모든 이전 캐시 삭제
    caches.keys().then(keys =>
      Promise.all(keys.map(k => {
        console.log('[SW] deleting cache:', k);
        return caches.delete(k);
      }))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // navigation 요청(HTML 페이지) → 항상 네트워크 우선
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req, {
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache'
        }
      }).catch(() => {
        // 오프라인 상태에서만 캐시 fallback (없으면 오류)
        return caches.match(req);
      })
    );
    return;
  }

  // API 요청 → 항상 네트워크 (no-store)
  if (req.url.includes('/api/')) {
    event.respondWith(
      fetch(req, { cache: 'no-store' })
    );
    return;
  }

  // 나머지 정적 파일(js, css 등) → 기본 처리
});
