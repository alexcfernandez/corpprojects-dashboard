// src/mediciones.js — Medidor por estancias (base del motor de presupuestos, F1).
// Añades estancias (sala, cocina, habitación…) con largo × ancho × alto y saca
// solos: m² de suelo, m² de techo, m² de paredes y metros de rodapié (perímetro).
// En pocos clics tienes medido todo el piso. Base para partidas/presupuesto.
//
// Multi-empresa desde el diseño: cada medición lleva `empresaId` (barato ahora,
// carísimo de añadir después). Con una sola empresa, EMPRESA = 'corp' por defecto.
const { ObjectId } = require('mongodb');
const EMPRESA = process.env.EMPRESA_ID || 'corp';

async function getDB() { return require('./db').getDB(); }
const num = v => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : 0; };

// Cálculo por estancia (rectangular: cubre la mayoría de pisos). `descuentoParedes`
// resta huecos de puertas/ventanas en m² (opcional).
function calcEstancia(e = {}) {
  const largo = num(e.largo), ancho = num(e.ancho), alto = num(e.alto), desc = num(e.descuentoParedes);
  const suelo = largo * ancho;
  const perimetro = 2 * (largo + ancho);
  const paredes = Math.max(0, perimetro * alto - desc);
  return { suelo: r2(suelo), techo: r2(suelo), perimetro: r2(perimetro), paredes: r2(paredes) };
}
function calcTotales(estancias = []) {
  const t = { suelo: 0, techo: 0, paredes: 0, rodapie: 0 };
  estancias.forEach(e => { const c = calcEstancia(e); t.suelo += c.suelo; t.techo += c.techo; t.paredes += c.paredes; t.rodapie += c.perimetro; });
  return { suelo: r2(t.suelo), techo: r2(t.techo), paredes: r2(t.paredes), rodapie: r2(t.rodapie) };
}
function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// Normaliza la medición para devolver: estancias con sus cálculos + totales.
function conCalculos(m) {
  const estancias = (m.estancias || []).map(e => ({ ...e, calc: calcEstancia(e) }));
  return { ...m, estancias, totales: calcTotales(m.estancias || []) };
}

async function getMediciones() {
  const db = await getDB();
  const arr = await db.collection('mediciones').find({ empresaId: EMPRESA }).sort({ updatedAt: -1 }).toArray();
  return arr.map(m => ({
    _id: m._id, nombre: m.nombre, clientName: m.clientName || '',
    nEstancias: (m.estancias || []).length, totales: calcTotales(m.estancias || []),
    updatedAt: m.updatedAt,
  }));
}

async function getMedicion(id) {
  const db = await getDB();
  const m = await db.collection('mediciones').findOne({ _id: new ObjectId(id), empresaId: EMPRESA });
  if (!m) throw new Error('Medición no encontrada');
  return conCalculos(m);
}

function limpiarEstancias(estancias) {
  return (Array.isArray(estancias) ? estancias : []).map((e, i) => ({
    id: e.id || `e${i}_${Date.now()}`,
    nombre: String(e.nombre || '').trim() || 'Estancia',
    largo: num(e.largo), ancho: num(e.ancho), alto: num(e.alto),
    descuentoParedes: num(e.descuentoParedes),
  }));
}

async function crearMedicion(data, by) {
  const db = await getDB();
  const nombre = String(data.nombre || '').trim();
  if (!nombre) throw new Error('Ponle un nombre a la medición (p. ej. la dirección)');
  const doc = {
    empresaId: EMPRESA,
    nombre,
    clientName: String(data.clientName || '').trim(),
    obraId: data.obraId ? String(data.obraId) : null,
    estancias: limpiarEstancias(data.estancias),
    createdAt: new Date(), updatedAt: new Date(), by: by || '',
  };
  const r = await db.collection('mediciones').insertOne(doc);
  return { ok: true, id: String(r.insertedId) };
}

async function editarMedicion(id, data, by) {
  const db = await getDB();
  const set = { updatedAt: new Date() };
  if ('nombre' in data) set.nombre = String(data.nombre || '').trim();
  if ('clientName' in data) set.clientName = String(data.clientName || '').trim();
  if ('obraId' in data) set.obraId = data.obraId ? String(data.obraId) : null;
  if ('estancias' in data) set.estancias = limpiarEstancias(data.estancias);
  await db.collection('mediciones').updateOne({ _id: new ObjectId(id), empresaId: EMPRESA }, { $set: set });
  return { ok: true };
}

async function eliminarMedicion(id) {
  const db = await getDB();
  await db.collection('mediciones').deleteOne({ _id: new ObjectId(id), empresaId: EMPRESA });
  return { ok: true };
}

module.exports = { getMediciones, getMedicion, crearMedicion, editarMedicion, eliminarMedicion, calcEstancia, calcTotales };
