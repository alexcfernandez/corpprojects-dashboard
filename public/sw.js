// Service Worker — Corp Projects Dashboard
const CACHE = 'cp-v35';
const STATIC = [
  '/',
  '/parte',
  '/subir-factura',
  '/asignar-facturas',
  '/activos',
  '/medir',
  '/catalogo',
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

  // Recursos estáticos — red primero, cache como fallback
  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Guardar en cache si es válido
        if (res && res.status === 200 && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
