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

// Cada línea tiene un tipo: 'seccion' (título con subtotal, no suma nada),
// 'partida' (viene del catálogo) o 'libre' (concepto a mano: puerta, lámpara…).
// Las líneas viejas sin tipo se tratan como 'partida' (retrocompatible).
function esSeccion(l) { return (l && l.tipo) === 'seccion'; }

// IVA: cada presupuesto tiene un tipo por defecto (ivaDefault, normalmente 10%
// en reforma de vivienda). Una línea puede llevar su propio `iva` (override);
// si es null/undefined hereda el del presupuesto. Total = base + IVA.
function computeTotales(lineas, ivaDefault) {
  const g = Number.isFinite(ivaDefault) ? ivaDefault : 10;
  let venta = 0, coste = 0, iva = 0;
  (lineas || []).forEach(l => {
    if (esSeccion(l)) return;
    const v = (num(l.cantidad)) * (Number(l.precioVenta) || 0);
    venta += v;
    coste += (num(l.cantidad)) * (Number(l.coste) || 0);
    const r = (l.iva === null || l.iva === undefined) ? g : Number(l.iva);
    iva += v * (Number.isFinite(r) ? r : g) / 100;
  });
  venta = n2(venta); coste = n2(coste); iva = n2(iva);
  return { totalVenta: venta, totalCoste: coste, totalIva: iva, totalConIva: n2(venta + iva), beneficio: n2(venta - coste), margen: venta > 0 ? Math.round((venta - coste) / venta * 100) : 0 };
}
function limpiarLineas(lineas) {
  return (Array.isArray(lineas) ? lineas : []).map(l => {
    const tipo = ['seccion', 'partida', 'libre'].includes(l.tipo) ? l.tipo : 'partida';
    if (tipo === 'seccion') return { tipo, nombre: String(l.nombre || '').trim() || 'Sección' };
    const ivaOverride = (l.iva === null || l.iva === undefined || l.iva === '') ? null : Number(l.iva);
    return {
      tipo,
      partidaId:   l.partidaId ? String(l.partidaId) : null,
      nombre:      String(l.nombre || '').trim() || (tipo === 'libre' ? 'Concepto' : 'Partida'),
      unidad:      String(l.unidad || 'ud'),
      cantidad:    num(l.cantidad),
      precioVenta: n2(l.precioVenta),
      coste:       n2(l.coste),
      iva:         Number.isFinite(ivaOverride) ? ivaOverride : null,
    };
  });
}

async function getPresupuestos() {
  const db = await getDB();
  const arr = await db.collection('presupuestos').find({ empresaId: EMPRESA }).sort({ updatedAt: -1 }).toArray();
  return arr.map(p => ({ _id: p._id, nombre: p.nombre, clientName: p.clientName || '', estado: p.estado || 'borrador', nLineas: (p.lineas || []).filter(l => !esSeccion(l)).length, ...computeTotales(p.lineas, p.iva), updatedAt: p.updatedAt }));
}
async function getPresupuesto(id) {
  const db = await getDB();
  const p = await db.collection('presupuestos').findOne({ _id: new ObjectId(id), empresaId: EMPRESA });
  if (!p) throw new Error('Presupuesto no encontrado');
  return { ...p, iva: Number.isFinite(p.iva) ? p.iva : 10, totales: computeTotales(p.lineas, p.iva) };
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
    iva: Number.isFinite(Number(data.iva)) ? Number(data.iva) : 10,
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
  if ('iva' in data && Number.isFinite(Number(data.iva))) set.iva = Number(data.iva);
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
