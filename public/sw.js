const CACHE_NAME = 'safeguard-shell-v6';
const SHELL_ASSETS = [
  '/manifest.json',
  '/apple-touch-icon.png',
  '/logo_tdtu.jpg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async cache => {
        await cache.addAll(SHELL_ASSETS);
        const indexRes = await fetch('/index.html', { cache: 'no-store' });
        if (indexRes.ok) {
          await cache.put('/index.html', indexRes.clone());
          await cache.put('/', indexRes);
        }
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    return;
  }

  const isHtml = event.request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html';
  event.respondWith(
    fetch(isHtml ? new Request(event.request.url, { cache: 'no-store' }) : event.request)
      .then(res => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then(cached => cached || caches.match('/index.html')))
  );
});

self.addEventListener('push', event => {
  let data = {
    title: '🚨 CẢNH BÁO TÉ NGÃ KHẨN CẤP!',
    body: 'Phát hiện người thân bị té ngã! Hãy bấm vào để kiểm tra ngay.',
    tag: 'safeguard-fall-alert'
  };

  if (event.data) {
    try {
      data = Object.assign(data, event.data.json());
    } catch (e) {
      data.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/apple-touch-icon.png',
      badge: '/apple-touch-icon.png',
      tag: data.tag || 'safeguard-fall-alert',
      renotify: true,
      requireInteraction: true,
      data: { url: '/' }
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('/');
      }
    })
  );
});
