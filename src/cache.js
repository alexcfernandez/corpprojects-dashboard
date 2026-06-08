// src/cache.js — caché en memoria con TTL + deduplicación de llamadas en vuelo
//
// Para qué sirve:
//   - TTL: guarda el resultado de una llamada cara (a StelOrder) durante X ms,
//     para no repetirla en cada carga del dashboard ni en cada pasada del scheduler.
//   - Deduplicación "en vuelo": si llegan varias peticiones A LA VEZ con la caché
//     fría, todas comparten UNA sola descarga en lugar de lanzar 4-5 idénticas.
//     Esto es lo que evita que una carga de pantalla consuma el límite diario.
//
// Es a propósito sencilla: un solo proceso (Railway, 1 instancia). Si algún día
// hay varias instancias, se migra esta misma interfaz a Redis/Mongo sin tocar
// quien la usa.

const store = new Map();    // key -> { value, expires }
const inflight = new Map(); // key -> Promise (descarga en curso)

/**
 * Devuelve el valor cacheado si está fresco; si no, ejecuta fetcher(),
 * guarda el resultado con su TTL y lo devuelve. Las llamadas concurrentes
 * a la misma key comparten la misma promesa.
 *
 * @param {string}   key      identificador del dato (p.ej. 'receipts')
 * @param {number}   ttlMs    cuántos ms se considera fresco
 * @param {Function} fetcher  función async que trae el dato real
 */
async function cached(key, ttlMs, fetcher) {
  const now = Date.now();

  // 1) ¿Hay valor fresco? -> devolver sin tocar la API
  const hit = store.get(key);
  if (hit && now < hit.expires) {
    return hit.value;
  }

  // 2) ¿Hay ya una descarga en curso para esta key? -> esperar ESA (dedup)
  if (inflight.has(key)) {
    return inflight.get(key);
  }

  // 3) Caché fría: lanzar la descarga, registrarla como "en vuelo"
  //    (se registra de forma síncrona, antes de cualquier await, para que
  //     las peticiones que llegan en el mismo instante la encuentren).
  const promise = (async () => {
    try {
      const value = await fetcher();
      store.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    } finally {
      // pase lo que pase, esta descarga deja de estar "en vuelo"
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

/**
 * Borra una key concreta, o toda la caché si no se pasa argumento.
 * Útil para un botón "Actualizar ahora" cuando acabas de tocar algo en StelOrder.
 */
function invalidate(key) {
  if (key) {
    store.delete(key);
  } else {
    store.clear();
  }
}

/** Estado de la caché (para un endpoint de depuración opcional). */
function stats() {
  const now = Date.now();
  const keys = [];
  for (const [k, v] of store.entries()) {
    keys.push({ key: k, freshForMs: Math.max(0, v.expires - now) });
  }
  return { entries: keys, inflight: [...inflight.keys()] };
}

module.exports = { cached, invalidate, stats };
