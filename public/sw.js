// Service Worker — Corp Projects Dashboard
const CACHE = 'cp-v109';
const STATIC = [
  '/',
  '/parte',
  '/fichar',
  '/fichajes',
  '/compra',
  '/compras',
  '/almacen',
  '/sitios',
  '/gps',
  '/asignar-facturas',
  '/activos',
  '/medir',
  '/catalogo',
  '/push-client.js',
  '/obra-picker.js',
  '/modules/hoy.js',
  '/tool-theme.css',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=Space+Grotesk:wght@500;600;700&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js'
];

// Instalar — cachear recursos estáticos
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => {
      return cache.addAll(STATIC.filter(u => !u.startsWith('http') || u.includes('fonts') || u.includes('cloudflare')));
    }).catch(() => {}) // No fallar si algo no se puede cachear
  );
  self.skipWaiting();
});

// Activar — limpiar caches viejos
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — estrategia: Network first, cache fallback
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Ignora esquemas que la Cache API no admite (chrome-extension://, etc.)
  // Esto evita los errores de extensiones de navegador (monederos cripto…).
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // API calls — siempre red, nunca cache
  if (url.pathname.startsWith('/api/')) return;

  // Recursos estáticos — CACHÉ PRIMERO (pinta al instante) y se actualiza por detrás.
  // Cada despliegue cambia CACHE, así que la versión vieja se borra al activar el SW nuevo.
  if (e.request.method !== 'GET') return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const enCache = await cache.match(e.request, { ignoreSearch: e.request.mode === 'navigate' });
    const red = fetch(e.request).then(res => { if (res && res.status === 200) cache.put(e.request, res.clone()); return res; }).catch(() => null);
    if (enCache) { e.waitUntil(red); return enCache; }
    const res = await red;
    return res || new Response('Sin conexión', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  })());
});

// ── Notificaciones push (avisos de fichaje) ──────────────────────
// El servidor manda { title, body, url, tag }. Se muestra aunque la app esté cerrada.
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Corp Projects', {
    body: d.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: d.tag || undefined,        // mismo tag = sustituye al aviso anterior (no se apilan)
    renotify: !!d.tag,
    data: { url: d.url || '/' },
  }));
});

// Al tocar el aviso: si la app ya está abierta se enfoca y va a la pantalla; si no, se abre.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const abiertas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of abiertas) {
      if ('focus' in c) { try { if ('navigate' in c) await c.navigate(url); } catch (err) {} return c.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});
