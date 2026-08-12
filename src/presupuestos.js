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

module.exports = { UNIDADES, getPartidas, crearPartida, editarPartida, eliminarPartida };
