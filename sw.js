// 喵迹 PWA  Service Worker
// 策略：应用壳（HTML/图标/manifest）cache-first 离线秒开；API 与 AI 调用一律走网络，不缓存。
const CACHE = 'miaji-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 云端数据（账号/家庭/同步/AI 对话/视觉）永远走网络，绝不缓存
  if (url.pathname.startsWith('/api/') || url.pathname === '/chat' || url.pathname === '/vision') return;
  if (e.request.method !== 'GET') return;
  // 导航请求：网络优先，失败回退缓存壳（离线也能开 App）
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/index.html')));
    return;
  }
  e.respondWith(
    caches.match(e.request).then((r) =>
      r || fetch(e.request).then((resp) => {
        const cp = resp.clone();
        caches.open(CACHE).then((c) => c.put(e.request, cp));
        return resp;
      }).catch(() => caches.match('/index.html'))
    )
  );
});
