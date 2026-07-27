// src/estadoConversacion.js — Estado de confirmaciones del asistente, persistido.
//
// Fase 0: sustituye el `Map` en memoria (que se perdía en cada reinicio de Railway)
// por un store WRITE-THROUGH con caché en memoria + persistencia en Mongo. Mantiene
// la MISMA API síncrona que un Map (.get/.set/.delete) para no tocar los ~75 puntos
// de uso; solo hay que llamar a `await hydrate(from)` al principio del turno para
// cargar de Mongo lo que este proceso aún no tenga en caché.
//
// Escrituras best-effort (fire-and-forget): la caché es la verdad dentro del turno;
// Mongo es la red para sobrevivir a reinicios. Las entradas ya llevan `ts` y las
// comprueba el propio asistente (ventana de 10 min), y hay TTL de 1 h en el índice.

const COL = 'estadoConversacion';
const cache = new Map();
async function getDB() { return require('./db').getDB(); }

// Carga desde Mongo el estado de `from` si este proceso aún no lo tiene en caché.
async function hydrate(from) {
  const k = String(from || '');
  if (cache.has(k)) return;
  try {
    const db = await getDB();
    const doc = await db.collection(COL).findOne({ from: k });
    if (doc && doc.val !== undefined) cache.set(k, doc.val);
  } catch (e) { /* best-effort: si Mongo falla, seguimos solo con caché */ }
}

function get(from) { return cache.get(String(from || '')); }

function set(from, val) {
  const k = String(from || '');
  cache.set(k, val);
  getDB().then(db => db.collection(COL).updateOne(
    { from: k }, { $set: { from: k, val, updatedAt: new Date() } }, { upsert: true })).catch(() => {});
  return val;
}

function del(from) {
  const k = String(from || '');
  cache.delete(k);
  getDB().then(db => db.collection(COL).deleteOne({ from: k })).catch(() => {});
}

// Se exporta `delete` con ese nombre para ser un drop-in del Map original.
module.exports = { hydrate, get, set, delete: del, _cache: cache };
