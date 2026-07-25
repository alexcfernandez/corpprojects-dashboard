// src/pendientes.js — Pendientes / recordatorios del owner ("no me lo dejes olvidar").
//
// PRINCIPIO: NO se inventan fechas. Se guarda el texto tal cual y aparece en el
// resumen diario de la mañana HASTA que el owner diga que está hecho. (Los
// recordatorios con fecha/vencimiento son un incremento posterior.)
//
// No choca con las notas de comunidad (comunidades.js): las notas requieren
// "apunta/anota … EN <comunidad>"; los pendientes usan verbos propios
// ("recuérdame…", "pendiente…", "apúntame que…" sin "en <comunidad>").

const COL = 'pendientes';
async function getDB() { return require('./db').getDB(); }
function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim(); }

// ── Almacén ──────────────────────────────────────────────────────
async function addPendiente(texto, from) {
  const t = String(texto || '').trim();
  if (!t) return null;
  const db = await getDB();
  const doc = { texto: t, from: String(from || ''), estado: 'abierto', createdAt: new Date() };
  const r = await db.collection(COL).insertOne(doc);
  return { id: String(r.insertedId), ...doc };
}

async function listPendientes({ soloAbiertos = true } = {}) {
  const db = await getDB();
  const q = soloAbiertos ? { estado: 'abierto' } : {};
  return db.collection(COL).find(q).sort({ createdAt: 1 }).toArray();
}

// Cierra por índice 1-based (el número que se muestra en la lista) o por id.
async function cerrarPendiente({ idx = null, id = null } = {}) {
  const db = await getDB();
  let doc = null;
  if (id) {
    try { const { ObjectId } = require('mongodb'); doc = await db.collection(COL).findOne({ _id: new ObjectId(id) }); } catch (e) {}
  } else if (idx != null) {
    const abiertos = await listPendientes({ soloAbiertos: true });
    doc = abiertos[idx - 1] || null;
  }
  if (!doc) return null;
  await db.collection(COL).updateOne({ _id: doc._id }, { $set: { estado: 'hecho', doneAt: new Date() } });
  return { id: String(doc._id), texto: doc.texto };
}

// Sección para el resumen diario (colector reutilizable). null si no hay nada.
async function seccionResumen() {
  const abiertos = await listPendientes({ soloAbiertos: true }).catch(() => []);
  if (!abiertos.length) return null;
  const lineas = abiertos.map((p, i) => `${i + 1}. ${p.texto}`).join('\n');
  return `📌 *Pendientes* (${abiertos.length}):\n${lineas}\n_Para cerrar uno: "hecho el pendiente 1"._`;
}

// ── Detección de intención (pura, testeable) ─────────────────────
// Devuelve { tipo:'add'|'list'|'done', texto?, idx? } o null si no es de pendientes.
function detectarIntent(texto) {
  const n = norm(texto);

  // LISTAR
  if (/^\s*(pendientes|mis pendientes|lista de pendientes|tareas pendientes|que tengo pendiente|que me queda pendiente|que tengo que hacer)\b/.test(n))
    return { tipo: 'list' };

  // CERRAR: menciona "pendiente" + un verbo de completado/eliminado (+ número).
  if (/\bpendiente\b/.test(n) && /\b(hecho|hecha|ya est[aá]|listo|completad\w*|termin\w*|cierra|cerrad\w*|quita|borra|elimina)\b/.test(n)) {
    const m = n.match(/\b(\d{1,3})\b/);
    return { tipo: 'done', idx: m ? parseInt(m[1], 10) : null };
  }

  // AÑADIR: verbos de recordatorio propios, o "pendiente" con verbo de alta, o
  // "apúntame/anótame que…" SIN "en <algo>" (eso sería una nota de comunidad).
  const recuerda = /\b(recuerdame|acuerdate|no me( lo)? dejes olvidar|no me olvides)\b/.test(n);
  const conPendiente = /\bpendiente\b/.test(n) && /\b(tengo|queda|dejo|apunta\w*|anota\w*|a[nñ]ade|mete|pon|nuevo|otro)\b/.test(n);
  const apuntaMe = /\b(apuntame|anotame)\b/.test(n) && !/\ben\s+\S/.test(n);
  if (recuerda || conPendiente || apuntaMe) return { tipo: 'add', texto: limpiarVerbo(texto) };

  return null;
}

// Quita el verbo de recordatorio del principio para guardar solo la tarea.
function limpiarVerbo(texto) {
  let t = String(texto || '').trim();
  t = t.replace(/^\s*(recu[eé]rdame|acu[eé]rdate|no me( lo)? dejes olvidar|no me olvides|ap[uú]ntame|an[oó]tame|a[nñ]ade(\s+un)?\s+pendiente|nuevo pendiente|tengo\s+(un\s+)?pendiente|queda pendiente)\b[:,]?\s*/i, '');
  t = t.replace(/^\s*(de|que|:)\s+/i, '');
  t = t.replace(/[,\s]*(que )?no me( lo)? dejes olvidar\.?$/i, ''); // coletilla al final
  return t.trim() || String(texto || '').trim();
}

module.exports = { addPendiente, listPendientes, cerrarPendiente, seccionResumen, detectarIntent, limpiarVerbo };
