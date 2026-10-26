// src/descuentosNomina.js — LO QUE SE DESCUENTA EN NÓMINA (26/10/2026, Álex: «cosas que se compran los trabajadores, como
// Juan Carlos la descarga, o David unas botas y dijo "descontármela": que quede apuntado para descontárselo cada mes»).
// Entra de dos sitios:
//   · Compras: una línea de factura con destino «💸 A descontar en nómina» y el trabajador (al confirmar la compra);
//   · Corpy: «descuéntale a David las botas, 45 €».
// Sale en Inicio (por persona, con «✔ Descontado»). A la gestoría NO se le manda (Álex: «a Eduard solo los absentismos»). Colección `descuentosNomina`: { userId, nombre, concepto, importe, fecha, origen, estado
// pendiente|descontado|anulado, mes (el de la nómina en que se descontó) }.
'use strict';
async function getDB() { return require('./db').getDB(); }
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const hoyISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
const COL = 'descuentosNomina';

async function apuntar({ userId, nombre = '', concepto, importe, fecha = null, origen = { tipo: 'manual' } } = {}, por = '', { _db = null } = {}) {
  if (!/^[a-f0-9]{24}$/.test(String(userId || ''))) throw new Error('¿A quién se le descuenta?');
  const imp = r2(Math.abs(Number(String(importe).replace(',', '.'))));
  if (!(imp > 0)) throw new Error('Falta el importe');
  if (!String(concepto || '').trim()) throw new Error('Falta qué es');
  const db = _db || await getDB(); const col = db.collection(COL);
  // La misma línea de la misma compra no se apunta dos veces (si se reabre y se vuelve a confirmar).
  if (origen && origen.compraId != null && origen.linea != null) {
    const ya = await col.findOne({ 'origen.compraId': String(origen.compraId), 'origen.linea': Number(origen.linea), estado: { $ne: 'anulado' } });
    if (ya) return { ...ya, repetido: true };
  }
  const doc = { userId: String(userId), nombre: String(nombre || '').trim().slice(0, 80), concepto: String(concepto).trim().slice(0, 160), importe: imp,
    fecha: /^\d{4}-\d{2}-\d{2}$/.test(String(fecha || '')) ? fecha : hoyISO(), origen: origen || { tipo: 'manual' }, estado: 'pendiente', mes: null, por: String(por || ''), creado: new Date() };
  const r = await col.insertOne(doc); doc._id = r.insertedId;
  return doc;
}

// Al confirmar una compra por líneas: cada línea «a descontar» de un trabajador.
async function desdeCompra(c, por = '', { _db = null } = {}) {
  const out = [];
  for (const [i, l] of (c.lineas || []).entries()) {
    if (!l.para || l.para.t !== 'descontar' || !l.para.workerId) continue;
    out.push(await apuntar({ userId: l.para.workerId, nombre: l.para.workerName || '', importe: l.importe,
      concepto: `${l.descripcion}${c.proveedor ? ` (${c.proveedor}${c.numero ? ' nº ' + c.numero : ''})` : ''}`, fecha: c.fecha || null,
      origen: { tipo: 'compra', compraId: String(c._id), linea: i } }, por, { _db }));
  }
  return out;
}

async function pendientes({ userId = null, _db = null } = {}) {
  const db = _db || await getDB();
  const l = await db.collection(COL).find({ estado: 'pendiente', ...(userId ? { userId: String(userId) } : {}) }).sort({ fecha: 1 }).toArray();
  const por = {};
  for (const d of l) (por[d.userId] = por[d.userId] || { userId: d.userId, nombre: d.nombre, total: 0, lineas: [] }).lineas.push({ id: String(d._id), concepto: d.concepto, importe: d.importe, fecha: d.fecha, origen: d.origen && d.origen.tipo });
  return Object.values(por).map(p => ({ ...p, total: r2(p.lineas.reduce((s, x) => s + x.importe, 0)) })).sort((a, b) => b.total - a.total);
}

// «Descontado»: el de esa persona (todo lo pendiente) o líneas concretas, en la nómina de `mes`.
async function marcarDescontado({ userId = null, ids = null, mes = null } = {}, por = '', { _db = null } = {}) {
  const db = _db || await getDB(); const { ObjectId } = require('mongodb');
  const m = /^\d{4}-\d{2}$/.test(String(mes || '')) ? mes : hoyISO().slice(0, 7);
  const q = { estado: 'pendiente' };
  if (Array.isArray(ids) && ids.length) q._id = { $in: ids.map(x => new ObjectId(String(x))) };
  else if (userId) q.userId = String(userId);
  else throw new Error('¿De quién?');
  const r = await db.collection(COL).updateMany(q, { $set: { estado: 'descontado', mes: m, descontadoPor: String(por || ''), descontadoAt: new Date() } });
  return { ok: true, descontados: r.modifiedCount, mes: m };
}
async function anular(id, por = '', { _db = null } = {}) {
  const db = _db || await getDB(); const { ObjectId } = require('mongodb');
  const r = await db.collection(COL).updateOne({ _id: new ObjectId(String(id)), estado: 'pendiente' }, { $set: { estado: 'anulado', anuladoPor: String(por || ''), anuladoAt: new Date() } });
  if (!r.matchedCount) throw new Error('No está pendiente');
  return { ok: true };
}


module.exports = { apuntar, desdeCompra, pendientes, marcarDescontado, anular };
