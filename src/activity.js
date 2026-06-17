// src/activity.js — Log de actividad de StelOrder (comparar fotos + anotar cambios).
// Paso 1: PEDIDOS de trabajo. El motor es genérico; añadir facturas/presupuestos/
// incidencias luego es solo sumar adaptadores.
//
// Cómo funciona: cada pasada baja la lista, construye una "foto" de los campos que
// importan, la compara con la guardada y anota creados/modificados/borrados (con
// antes→después). La PRIMERA pasada de cada tipo solo guarda fotos (baseline), no
// llena el log con todo lo existente.
//
// Colecciones: activitySnapshots (última foto por entidad) · activityLog (cambios).

const stel = require('./stelorder');

async function getDB() {
  const { db } = await require('./db').getDBLegacy();
  return db;
}

// Etiquetas legibles de cada campo (para el log).
const LABELS = {
  estado: 'Estado', importe: 'Importe', cliente: 'Cliente', tecnico: 'Técnico',
  cobrado: 'Cobrado', firmado: 'Firmado', lineas: 'Trabajo', titulo: 'Título'
};

// Campos que comparamos para detectar modificaciones (sin ruido).
const CAMPOS = ['estado', 'importe', 'cliente', 'tecnico', 'cobrado', 'firmado', 'lineas'];

// ── Adaptador: PEDIDOS de trabajo ───────────────────────────────────────────
function snapPedido(o, stateMap, clientMap, empMap) {
  const cli = clientMap[String(o['account-id'])] || {};
  const lines = (Array.isArray(o.lines) ? o.lines.filter(l => !l.deleted) : [])
    .map(l => l['item-name']).filter(Boolean).join(', ');
  return {
    estado:  stateMap[String(o['document-state-id'])] || String(o['document-state-id'] || ''),
    importe: Number(o['total-amount'] || 0),
    cliente: cli.name || '',
    tecnico: empMap[String(o['assignee-id'])] || (o['assignee-id'] != null ? '#' + o['assignee-id'] : ''),
    cobrado: !!o.settled,
    firmado: !!o.signed,
    lineas:  lines,
    _ref:    o['full-reference'] || ('PDT#' + o.id),
    _fechaMod: o['utc-last-modification-date'] || null
  };
}

const ADAPTERS = {
  pedido: {
    label: 'Pedido',
    async fetch() {
      const [orders, stateMap, { clientMap }, empMap] = await Promise.all([
        stel.getAllWorkOrders(), stel.getWorkOrderStateMap(), stel.getClients(), stel.getEmployeeMap()
      ]);
      return (Array.isArray(orders) ? orders : []).map(o => ({
        id: String(o.id),
        deleted: !!o.deleted,
        snap: snapPedido(o, stateMap, clientMap, empMap)
      }));
    }
  }
};

// Convierte un valor a texto legible para el log.
function fmt(campo, v) {
  if (campo === 'importe') return Number(v || 0).toFixed(2) + ' €';
  if (campo === 'cobrado' || campo === 'firmado') return v ? 'Sí' : 'No';
  return String(v == null || v === '' ? '—' : v);
}

// Diferencias entre dos fotos.
function diff(antes, ahora) {
  const cambios = [];
  for (const c of CAMPOS) {
    const a = antes ? antes[c] : undefined;
    const b = ahora ? ahora[c] : undefined;
    if (String(a) !== String(b)) {
      cambios.push({ campo: LABELS[c] || c, antes: fmt(c, a), despues: fmt(c, b) });
    }
  }
  return cambios;
}

// Escanea un tipo y aplica los cambios. Devuelve {created, modified, deleted, baseline}.
async function scanType(db, type) {
  const adapter = ADAPTERS[type];
  if (!adapter) return { error: 'tipo desconocido: ' + type };

  const snapCol = db.collection('activitySnapshots');
  const logCol  = db.collection('activityLog');

  const prevCount = await snapCol.countDocuments({ type });
  const isBaseline = prevCount === 0;

  const current = await adapter.fetch();
  const prev = {};
  await snapCol.find({ type }).forEach(d => { prev[d.entityId] = d; });

  const out = { created: 0, modified: 0, deleted: 0, baseline: isBaseline };
  const seen = new Set();
  const now = new Date();

  for (const item of current) {
    seen.add(item.id);
    const key = { type, entityId: item.id };
    const prevDoc = prev[item.id];

    // Borrado lógico desde StelOrder
    if (item.deleted) {
      if (prevDoc && !isBaseline) {
        await logCol.insertOne({ type, label: adapter.label, ref: prevDoc.snap._ref || item.id, kind: 'borrado', changes: [], at: now, fechaMod: item.snap._fechaMod });
        out.deleted++;
      }
      await snapCol.deleteOne(key);
      continue;
    }

    if (!prevDoc) {
      if (!isBaseline) {
        await logCol.insertOne({ type, label: adapter.label, ref: item.snap._ref, kind: 'creado', changes: resumenAlta(item.snap), at: now, fechaMod: item.snap._fechaMod });
        out.created++;
      }
    } else {
      const cambios = diff(prevDoc.snap, item.snap);
      if (cambios.length && !isBaseline) {
        await logCol.insertOne({ type, label: adapter.label, ref: item.snap._ref, kind: 'modificado', changes: cambios, at: now, fechaMod: item.snap._fechaMod });
        out.modified++;
      }
    }
    await snapCol.updateOne(key, { $set: { type, entityId: item.id, snap: item.snap, updatedAt: now } }, { upsert: true });
  }

  // Entidades que ya no están en la lista → borradas
  if (!isBaseline) {
    for (const id of Object.keys(prev)) {
      if (!seen.has(id)) {
        await logCol.insertOne({ type, label: adapter.label, ref: prev[id].snap._ref || id, kind: 'borrado', changes: [], at: now, fechaMod: prev[id].snap._fechaMod });
        await snapCol.deleteOne({ type, entityId: id });
        out.deleted++;
      }
    }
  }

  return out;
}

// Para un "creado", mostramos un resumen de los campos clave.
function resumenAlta(snap) {
  const out = [];
  if (snap.cliente) out.push({ campo: 'Cliente', antes: '', despues: snap.cliente });
  if (snap.estado)  out.push({ campo: 'Estado',  antes: '', despues: snap.estado });
  if (snap.lineas)  out.push({ campo: 'Trabajo', antes: '', despues: snap.lineas });
  return out;
}

// Escanea todos los tipos activos.
async function scan() {
  const summary = { types: {}, error: null };
  let db;
  try { db = await getDB(); } catch (e) { summary.error = e.message; return summary; }
  for (const type of Object.keys(ADAPTERS)) {
    try { summary.types[type] = await scanType(db, type); }
    catch (e) { summary.types[type] = { error: e.message }; }
  }
  return summary;
}

// Lee el log para la pestaña (más reciente primero).
async function getLog({ type, limit = 200 } = {}) {
  const db = await getDB();
  const q = {};
  if (type) q.type = type;
  return db.collection('activityLog').find(q).sort({ at: -1 }).limit(Math.min(limit, 500)).toArray();
}

module.exports = { scan, getLog, scanType };
