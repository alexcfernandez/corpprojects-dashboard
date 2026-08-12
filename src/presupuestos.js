// src/presupuestos.js — Motor de presupuestos. Empieza por la BASE DE PRECIOS:
// el catálogo de PARTIDAS (tu lista de precios). Una partida es un trabajo con
// su unidad y su precio (p.ej. "Pintar pared" — m² — 8,50 €/m²), opcionalmente
// con el coste real para ver el margen. Sobre esto irá el presupuesto (medición
// × partidas). Multi-empresa desde el diseño (cada partida lleva empresaId).
const { ObjectId } = require('mongodb');
const EMPRESA = process.env.EMPRESA_ID || 'corp';

async function getDB() { return require('./db').getDB(); }
const num = v => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : 0; };

const UNIDADES = ['m²', 'ml', 'ud', 'h', 'kg', 'm³', 'global'];

function limpiar(data) {
  const unidad = UNIDADES.includes(data.unidad) ? data.unidad : 'ud';
  return {
    nombre:      String(data.nombre || '').trim(),
    capitulo:    String(data.capitulo || '').trim(),   // agrupador: Pintura, Suelos, Fontanería…
    unidad,
    precioVenta: Math.round(num(data.precioVenta) * 100) / 100,
    coste:       Math.round(num(data.coste) * 100) / 100,
    notas:       String(data.notas || '').trim(),
  };
}

async function getPartidas({ search } = {}) {
  const db = await getDB();
  const q = { empresaId: EMPRESA };
  if (search) q.$or = [
    { nombre:   { $regex: search, $options: 'i' } },
    { capitulo: { $regex: search, $options: 'i' } },
  ];
  return db.collection('partidas').find(q).sort({ capitulo: 1, nombre: 1 }).toArray();
}

async function crearPartida(data, by) {
  const db = await getDB();
  const p = limpiar(data);
  if (!p.nombre) throw new Error('Ponle un nombre a la partida');
  if (p.precioVenta <= 0) throw new Error('El precio de venta debe ser mayor que 0');
  const doc = { empresaId: EMPRESA, ...p, by: by || '', createdAt: new Date(), updatedAt: new Date() };
  const r = await db.collection('partidas').insertOne(doc);
  return { ok: true, id: String(r.insertedId) };
}

async function editarPartida(id, data) {
  const db = await getDB();
  const p = limpiar(data);
  if (!p.nombre) throw new Error('Ponle un nombre a la partida');
  await db.collection('partidas').updateOne(
    { _id: new ObjectId(id), empresaId: EMPRESA },
    { $set: { ...p, updatedAt: new Date() } }
  );
  return { ok: true };
}

async function eliminarPartida(id) {
  const db = await getDB();
  await db.collection('partidas').deleteOne({ _id: new ObjectId(id), empresaId: EMPRESA });
  return { ok: true };
}

// ── PRESUPUESTOS ─────────────────────────────────────────────────
// Un presupuesto = líneas de partidas con su cantidad. Las cantidades pueden
// venir de una MEDICIÓN (m² de pared → pintura, m² de suelo → suelo, ml → rodapié).
// Cada línea guarda una copia del precio/coste de la partida en ese momento
// (así el presupuesto no cambia si luego retocas el catálogo).
const n2 = n => Math.round((Number(n) || 0) * 100) / 100;

function computeTotales(lineas) {
  let venta = 0, coste = 0;
  (lineas || []).forEach(l => { venta += (num(l.cantidad)) * (Number(l.precioVenta) || 0); coste += (num(l.cantidad)) * (Number(l.coste) || 0); });
  venta = n2(venta); coste = n2(coste);
  return { totalVenta: venta, totalCoste: coste, beneficio: n2(venta - coste), margen: venta > 0 ? Math.round((venta - coste) / venta * 100) : 0 };
}
function limpiarLineas(lineas) {
  return (Array.isArray(lineas) ? lineas : []).map(l => ({
    partidaId:   l.partidaId ? String(l.partidaId) : null,
    nombre:      String(l.nombre || '').trim() || 'Partida',
    unidad:      String(l.unidad || 'ud'),
    cantidad:    num(l.cantidad),
    precioVenta: n2(l.precioVenta),
    coste:       n2(l.coste),
  }));
}

async function getPresupuestos() {
  const db = await getDB();
  const arr = await db.collection('presupuestos').find({ empresaId: EMPRESA }).sort({ updatedAt: -1 }).toArray();
  return arr.map(p => ({ _id: p._id, nombre: p.nombre, clientName: p.clientName || '', estado: p.estado || 'borrador', nLineas: (p.lineas || []).length, ...computeTotales(p.lineas), updatedAt: p.updatedAt }));
}
async function getPresupuesto(id) {
  const db = await getDB();
  const p = await db.collection('presupuestos').findOne({ _id: new ObjectId(id), empresaId: EMPRESA });
  if (!p) throw new Error('Presupuesto no encontrado');
  return { ...p, totales: computeTotales(p.lineas) };
}
async function crearPresupuesto(data, by) {
  const db = await getDB();
  const nombre = String(data.nombre || '').trim();
  if (!nombre) throw new Error('Ponle un nombre al presupuesto');
  const doc = {
    empresaId: EMPRESA, nombre,
    clientName: String(data.clientName || '').trim(),
    medicionId: data.medicionId ? String(data.medicionId) : null,
    medicionTotales: data.medicionTotales || null,
    lineas: limpiarLineas(data.lineas),
    notas: String(data.notas || '').trim(),
    estado: 'borrador',
    by: by || '', createdAt: new Date(), updatedAt: new Date(),
  };
  const r = await db.collection('presupuestos').insertOne(doc);
  return { ok: true, id: String(r.insertedId) };
}
async function guardarPresupuesto(id, data) {
  const db = await getDB();
  const set = { updatedAt: new Date() };
  if ('nombre' in data) set.nombre = String(data.nombre || '').trim();
  if ('clientName' in data) set.clientName = String(data.clientName || '').trim();
  if ('lineas' in data) set.lineas = limpiarLineas(data.lineas);
  if ('notas' in data) set.notas = String(data.notas || '').trim();
  if ('estado' in data) set.estado = String(data.estado || 'borrador');
  if ('medicionId' in data) set.medicionId = data.medicionId ? String(data.medicionId) : null;
  if ('medicionTotales' in data) set.medicionTotales = data.medicionTotales || null;
  await db.collection('presupuestos').updateOne({ _id: new ObjectId(id), empresaId: EMPRESA }, { $set: set });
  return { ok: true };
}
async function eliminarPresupuesto(id) {
  const db = await getDB();
  await db.collection('presupuestos').deleteOne({ _id: new ObjectId(id), empresaId: EMPRESA });
  return { ok: true };
}

module.exports = {
  UNIDADES, getPartidas, crearPartida, editarPartida, eliminarPartida,
  getPresupuestos, getPresupuesto, crearPresupuesto, guardarPresupuesto, eliminarPresupuesto,
};
