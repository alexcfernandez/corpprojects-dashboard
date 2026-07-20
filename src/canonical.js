// src/canonical.js — redirección a dominio canónico (opt-in por CANONICAL_HOST).
//
// Para qué sirve: una vez `dashboard.corpprojects.es` esté activo, evita que la
// app se siga usando desde la URL cruda de Railway. Se activa SOLO si defines la
// variable CANONICAL_HOST; si no está, no hace nada (comportamiento actual).
//
// Seguro por diseño — NO redirige:
//   · /health  (lo usa el healthcheck de Railway)
//   · /api/*   (webhook de Twilio y todas las llamadas del front)
//   · /auth/*  (callback de OAuth de Google)
//   · nada que no sea GET (POST de formularios/webhooks intactos)
// Usa 302 (temporal) a propósito: reversible si algún día cambias de dominio,
// sin quedarte cacheado en los navegadores como haría un 301.

function shouldRedirect({ method, host, path, canonicalHost }) {
  if (!canonicalHost) return false;
  if (method !== 'GET') return false;
  if (!host || host === canonicalHost) return false;
  if (path === '/health') return false;
  if (path.startsWith('/api')) return false;
  if (path.startsWith('/auth')) return false;
  return true;
}

// Middleware de Express que aplica la regla anterior.
function canonicalHostRedirect(req, res, next) {
  const canonicalHost = process.env.CANONICAL_HOST;
  if (shouldRedirect({ method: req.method, host: req.headers.host, path: req.path, canonicalHost })) {
    return res.redirect(302, `https://${canonicalHost}${req.originalUrl}`);
  }
  next();
}

module.exports = { shouldRedirect, canonicalHostRedirect };
