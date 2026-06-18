// src/activity.js — Log de actividad de StelOrder (comparar fotos + anotar cambios).
// Tipos vigilados: pedidos, facturas, presupuestos, incidencias.
//
// Cómo funciona: cada pasada baja la lista de cada tipo, construye una "foto" de los
// campos que importan, la compara con la guardada y anota creados/modificados/borrados
// (con antes→después). La PRIMERA pasada de cada tipo solo guarda fotos (baseline),
// no llena el log con todo lo existente.
//
// Colecciones: activitySnapshots (última foto por entidad) · activityLog (cambios).

const stel = require('./stelorder');

async function getDB() {
  const { db } = await require('./db').getDBLegacy();
  return db;
}

const arr = x => (Array.isArray(x) ? x : []);

// Etiquetas legibles de cada campo.
const LABELS = {
  estado: 'Estado', importe: 'Importe', cliente: 'Cliente', tecnico: 'Técnico',
  cobrado: 'Cobrado', firmado: 'Firmado', lineas: 'Trabajo', pagado: 'Pagado',
  tipo: 'Tipo', titulo: 'Título'
};
const MONEY = new Set(['importe', 'pagado', 'pendiente']);
const BOOL  = new Set(['cobrado', 'firmado']);

function fmt(campo, v) {
  if (MONEY.has(campo)) return Number(v || 0).toFixed(2) + ' €';
  if (BOOL.has(campo))  return v ? 'Sí' : 'No';
  return String(v == null || v === '' ? '—' : v);
}

// Campos "reales" de una foto (ignora los meta que empiezan por _).
const campos = snap => Object.keys(snap || {}).filter(k => !k.startsWith('_'));

// Diferencias entre dos fotos (genérico sobre los campos presentes).
function diff(antes, ahora) {
  const keys = new Set([...campos(antes), ...campos(ahora)]);
  const cambios = [];
  for (const k of keys) {
    const a = antes ? antes[k] : undefined;
    const b = ahora ? ahora[k] : undefined;
    if (String(a) !== String(b)) {
      cambios.push({ campo: LABELS[k] || k, antes: fmt(k, a), despues: fmt(k, b) });
    }
  }
  return cambios;
}

// Resumen de campos clave para un "creado".
function resumenAlta(snap) {
  const orden = ['cliente', 'tipo', 'estado', 'titulo', 'importe', 'lineas'];
  const out = [];
  for (const k of orden) {
    const v = snap[k];
    if (v == null || v === '') continue;
    out.push({ campo: LABELS[k] || k, antes: '', despues: fmt(k, v) });
  }
  return out;
}

// ── Adaptadores (foto de cada tipo) ─────────────────────────────────────────
function snapPedido(o, stateMap, clientMap, empMap) {
  const cli = clientMap[String(o['account-id'])] || {};
  const lineas = arr(o.lines).filter(l => !l.deleted).map(l => l['item-name']).filter(Boolean).join(', ');
  return {
    estado:  stateMap[String(o['document-state-id'])] || String(o['document-state-id'] || ''),
    importe: Number(o['total-amount'] || 0),
    cliente: cli.name || '',
    tecnico: empMap[String(o['assignee-id'])] || (o['assignee-id'] != null ? '#' + o['assignee-id'] : ''),
    cobrado: !!o.settled,
    firmado: !!o.signed,
    lineas,
    _ref: o['full-reference'] || ('PDT#' + o.id),
    _fechaMod: o['utc-last-modification-date'] || null
  };
}

function snapFactura(inv) {
  const total = Number(inv.totalAmount || 0), pagado = Number(inv.paidAmount || 0);
  return {
    importe: total,
    pagado,
    cobrado: total > 0 && pagado >= total - 0.005,
    cliente: inv.client || '',
    _ref: inv.number || ('FAC#' + inv.id),
    _fechaMod: inv.date || null
  };
}

function snapPresupuesto(e) {
  return {
    estado:  e.stateLabel || '',
    importe: Number(e.total || 0),
    cliente: e.client || '',
    _ref: e.ref || e.number || ('PRE#' + e.id),
    _fechaMod: e.date || null
  };
}

function snapIncidencia(i, stateMap, incToType, clientMap) {
  return {
    estado:  stateMap[String(i['incident-state-id'])] || '',
    tipo:    incToType[String(i.id)] || '',
    cliente: (clientMap[String(i['account-id'])] || {}).name || '',
    titulo:  i.title || i.subject || i.description || i['private-comments'] || '',
    _ref: i['full-reference'] || i.reference || ('INC#' + i.id),
    _fechaMod: i['utc-last-modification-date'] || null
  };
}

const ADAPTERS = {
  pedido: {
    label: 'Pedido',
    async fetch() {
      const [orders, stateMap, { clientMap }, empMap] = await Promise.all([
        stel.getAllWorkOrders(), stel.getWorkOrderStateMap(), stel.getClients(), stel.getEmployeeMap()
      ]);
      return arr(orders).map(o => ({ id: String(o.id), deleted: !!o.deleted, snap: snapPedido(o, stateMap, clientMap, empMap) }));
    }
  },
  factura: {
    label: 'Factura',
    async fetch() {
      const invs = await stel.getInvoices();
      return arr(invs).map(inv => ({ id: String(inv.id), deleted: false, snap: snapFactura(inv) }));
    }
  },
  presupuesto: {
    label: 'Presupuesto',
    async fetch() {
      const s = await stel.getEstimatesSummary();
      return arr(s && s.all).map(e => ({ id: String(e.id), deleted: false, snap: snapPresupuesto(e) }));
    }
  },
  incidencia: {
    label: 'Incidencia',
    async fetch() {
      const [incs, stateMap, { incToType }, { clientMap }] = await Promise.all([
        stel.getAllIncidents(), stel.getIncidentStateMap(), stel.getIncidentTypeMaps(), stel.getClients()
      ]);
      return arr(incs).map(i => ({ id: String(i.id), deleted: !!i.deleted, snap: snapIncidencia(i, stateMap, incToType, clientMap) }));
    }
  }
};

// Escanea un tipo y aplica los cambios.
async function scanType(db, type) {
  const adapter = ADAPTERS[type];
  if (!adapter) return { error: 'tipo desconocido: ' + type };

  const snapCol = db.collection('activitySnapshots');
  const logCol  = db.collection('activityLog');
  const stateCol = db.collection('activityState');

  // ¿Primera vez para este tipo? Se decide por una MARCA explícita, no contando
  // fotos (así dos escaneos simultáneos no se pisan). La marca se pone al final.
  const st = await stateCol.findOne({ _id: type });
  const isBaseline = !(st && st.initialized);

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

  if (!isBaseline) {
    for (const id of Object.keys(prev)) {
      if (!seen.has(id)) {
        await logCol.insertOne({ type, label: adapter.label, ref: prev[id].snap._ref || id, kind: 'borrado', changes: [], at: now, fechaMod: prev[id].snap._fechaMod });
        await snapCol.deleteOne({ type, entityId: id });
        out.deleted++;
      }
    }
  }

  // La foto inicial ha terminado: marcamos el tipo como inicializado.
  if (isBaseline) {
    await stateCol.updateOne({ _id: type }, { $set: { initialized: true, updatedAt: now } }, { upsert: true });
  }

  return out;
}

// Escanea todos los tipos activos. Un solo escaneo a la vez (candado anti-solape).
let _scanning = false;
async function scan() {
  if (_scanning) return { skipped: true, types: {}, error: null };
  _scanning = true;
  try {
    const summary = { types: {}, error: null };
    let db;
    try { db = await getDB(); } catch (e) { summary.error = e.message; return summary; }
    for (const type of Object.keys(ADAPTERS)) {
      try { summary.types[type] = await scanType(db, type); }
      catch (e) { summary.types[type] = { error: e.message }; }
    }
    return summary;
  } finally { _scanning = false; }
}

// Reinicia el registro: borra log + fotos + marcas. El siguiente escaneo
// vuelve a tomar la foto inicial limpia (sin registrar lo antiguo).
async function reset() {
  const db = await getDB();
  const a = await db.collection('activityLog').deleteMany({});
  const b = await db.collection('activitySnapshots').deleteMany({});
  const c = await db.collection('activityState').deleteMany({});
  return { log: a.deletedCount, snapshots: b.deletedCount, state: c.deletedCount };
}

// Lee el log para la pestaña (más reciente primero).
async function getLog({ type, limit = 200 } = {}) {
  const db = await getDB();
  const q = {};
  if (type) q.type = type;
  return db.collection('activityLog').find(q).sort({ at: -1 }).limit(Math.min(limit, 500)).toArray();
}

module.exports = { scan, getLog, scanType, reset };
