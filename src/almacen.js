// almacen.js — STOCK DE CONSUMIBLES (Paso 4.1b de "la obra es una carpeta").
//
// Material que se compra en bloque para tener (big bags, sacos, tornillería…) y se va
// SACANDO para las obras. Cada salida carga su coste (unidades × precio medio) a la obra.
// Los artículos "con recogida" (big bags, contenedores) llevan además su ciclo:
// colocada en obra → recogida pedida (llamáis al camión) → recogida.
//
//   articulo = { empresaId, nombre, nombreNorm, unidad, cantidad (restante), precioUd (media
//                ponderada), recogida (bool), lotes:[{compraId, proveedor, fecha, cantidad, precioUd}],
//                createdAt, updatedAt }
//   salida   = { empresaId, articuloId, nombre, unidad, cantidad, precioUd, importe, obraId, obraRef,
//                por:{kind,userId,name}, fecha, nota,
//                recogida: null | { pendientes, estado: colocada|pedida|recogida, pedidaAt, pedidaPor,
//                                   pedidaNota, recogidas:[{cantidad, at, por}] } }
const { ObjectId } = require('mongodb');
const EMPRESA = process.env.EMPRESA_ID || 'corp';
const ART = 'almacen', SAL = 'almacenSalidas';
async function getDB() { return require('./db').getDB(); }
const oid = id => { try { return new ObjectId(String(id)); } catch (e) { throw new Error('No encontrado'); } };
// Clave de agrupación: sin acentos, sin palabras vacías y SIN espacios, para que
// «Big bag 1 m3», «BIG BAG 1M3» y «big-bag de 1m3» sean el mismo artículo.
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9ñç]+/g, ' ').replace(/\b(de|del|la|el|los|las|con|y|para|un|una)\b/g, '').replace(/\s+/g, '').trim();
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const r4 = n => Math.round((Number(n) || 0) * 10000) / 10000;

async function _obra(db, obraId) {
  if (!obraId) return null;
  try { const o = await db.collection('obras').findOne({ _id: new ObjectId(String(obraId)) }, { projection: { reference: 1 } }); return o ? { id: String(o._id), ref: o.reference || '' } : null; }
  catch (e) { return null; }
}

// ── ENTRADAS (desde una compra confirmada, o a mano) ─────────────
// Se agrupa por nombre: "Big bag 1 m3" de dos compras distintas es el MISMO artículo,
// y el precio medio se recalcula con lo que queda + lo que entra.
async function entrada({ nombre, unidad, cantidad, precioUd, recogida, compraId, proveedor, fecha, by }) {
  const db = await getDB();
  const n = String(nombre || '').trim().slice(0, 120); if (!n) throw new Error('Ponle nombre al artículo');
  const q = Math.max(0, Number(cantidad) || 0); if (!q) throw new Error('Cantidad no válida');
  const p = Math.max(0, Number(precioUd) || 0);
  const lote = { compraId: compraId ? String(compraId) : null, proveedor: proveedor || null, fecha: fecha || new Date().toISOString().slice(0, 10), cantidad: q, precioUd: r4(p), by: by || '', at: new Date() };
  const key = norm(n);
  const ex = await db.collection(ART).findOne({ empresaId: EMPRESA, nombreNorm: key });
  if (ex) {
    const rest = Math.max(0, Number(ex.cantidad) || 0);
    const precio = (rest + q) > 0 ? r4(((rest * (Number(ex.precioUd) || 0)) + q * p) / (rest + q)) : r4(p);
    await db.collection(ART).updateOne({ _id: ex._id }, { $set: { cantidad: r2(rest + q), precioUd: precio, unidad: ex.unidad || unidad || 'ud', recogida: !!(ex.recogida || recogida), updatedAt: new Date() }, $push: { lotes: lote } });
    return { id: String(ex._id), nombre: ex.nombre, nuevo: false, cantidad: r2(rest + q) };
  }
  const doc = { empresaId: EMPRESA, nombre: n, nombreNorm: key, unidad: String(unidad || 'ud').slice(0, 12), cantidad: r2(q), precioUd: r4(p), recogida: !!recogida, lotes: [lote], createdAt: new Date(), updatedAt: new Date() };
  const r = await db.collection(ART).insertOne(doc);
  return { id: String(r.insertedId), nombre: n, nuevo: true, cantidad: q };
}

// Lista del almacén. Sin `conPrecios` no salen importes (trabajadores).
async function lista({ conPrecios = false, todos = false } = {}) {
  const db = await getDB();
  const arr = await db.collection(ART).find({ empresaId: EMPRESA, ...(todos ? {} : { cantidad: { $gt: 0 } }) }).sort({ nombre: 1 }).toArray();
  return arr.map(a => ({ id: String(a._id), nombre: a.nombre, unidad: a.unidad || 'ud', cantidad: a.cantidad, recogida: !!a.recogida,
    ...(conPrecios ? { precioUd: a.precioUd, valor: r2((a.cantidad || 0) * (a.precioUd || 0)), lotes: (a.lotes || []).slice(-10).reverse() } : {}) }));
}
async function editar(id, data, por) {
  const db = await getDB();
  const set = { updatedAt: new Date() };
  if ('nombre' in data) { const n = String(data.nombre || '').trim().slice(0, 120); if (!n) throw new Error('Ponle nombre'); set.nombre = n; set.nombreNorm = norm(n); }
  if ('unidad' in data) set.unidad = String(data.unidad || 'ud').slice(0, 12);
  if ('recogida' in data) set.recogida = !!data.recogida;
  if ('precioUd' in data) set.precioUd = r4(Math.max(0, Number(data.precioUd) || 0));
  if ('cantidad' in data) set.cantidad = r2(Math.max(0, Number(data.cantidad) || 0)); // ajuste de inventario
  await db.collection(ART).updateOne({ _id: oid(id), empresaId: EMPRESA }, { $set: set });
  return { ok: true };
}

// ── SALIDAS: sacar material del almacén para una obra ────────────
async function salida({ articuloId, cantidad, obraId, nota, por }) {
  const db = await getDB();
  const a = await db.collection(ART).findOne({ _id: oid(articuloId), empresaId: EMPRESA });
  if (!a) throw new Error('Artículo no encontrado');
  const q = Number(cantidad) || 0; if (q <= 0) throw new Error('¿Cuántos sacas?');
  if (q > (a.cantidad || 0) + 1e-9) throw new Error(`Solo quedan ${a.cantidad} ${a.unidad || 'ud'} de «${a.nombre}»`);
  const obra = await _obra(db, obraId); if (!obra) throw new Error('Elige la obra a la que va');
  const doc = { empresaId: EMPRESA, articuloId: String(a._id), nombre: a.nombre, unidad: a.unidad || 'ud', cantidad: q, precioUd: a.precioUd || 0, importe: r2(q * (a.precioUd || 0)),
    obraId: obra.id, obraRef: obra.ref, por: por || null, fecha: new Date(), nota: String(nota || '').trim().slice(0, 200) || null,
    recogida: a.recogida ? { pendientes: q, estado: 'colocada', pedidaAt: null, pedidaPor: null, pedidaNota: null, recogidas: [] } : null };
  const r = await db.collection(SAL).insertOne(doc);
  await db.collection(ART).updateOne({ _id: a._id }, { $set: { cantidad: r2((a.cantidad || 0) - q), updatedAt: new Date() } });
  return { ok: true, id: String(r.insertedId), nombre: a.nombre, cantidad: q, obraRef: obra.ref, quedan: r2((a.cantidad || 0) - q), recogida: !!a.recogida };
}
async function deshacerSalida(id) {
  const db = await getDB();
  const s = await db.collection(SAL).findOne({ _id: oid(id), empresaId: EMPRESA }); if (!s) throw new Error('Salida no encontrada');
  if (s.recogida && s.recogida.estado !== 'colocada') throw new Error('Ya tiene recogida pedida o hecha; no se puede deshacer');
  await db.collection(SAL).deleteOne({ _id: s._id });
  await db.collection(ART).updateOne({ _id: oid(s.articuloId) }, { $inc: { cantidad: s.cantidad }, $set: { updatedAt: new Date() } });
  return { ok: true };
}
async function salidas({ obraId, desde, hasta, limit = 200, conPrecios = true } = {}) {
  const db = await getDB();
  const q = { empresaId: EMPRESA };
  if (obraId) q.obraId = String(obraId);
  if (desde || hasta) { q.fecha = {}; if (desde) q.fecha.$gte = new Date(desde); if (hasta) q.fecha.$lte = new Date(hasta + 'T23:59:59'); }
  const arr = await db.collection(SAL).find(q).sort({ fecha: -1 }).limit(Math.min(Number(limit) || 200, 500)).toArray();
  return arr.map(s => ({ ...s, _id: String(s._id), ...(conPrecios ? {} : { precioUd: undefined, importe: undefined }) }));
}

// ── RECOGIDAS (big bags, contenedores) ───────────────────────────
async function pedirRecogida(id, { nota, por } = {}) {
  const db = await getDB();
  const s = await db.collection(SAL).findOne({ _id: oid(id), empresaId: EMPRESA });
  if (!s || !s.recogida) throw new Error('Esta salida no lleva recogida');
  if (s.recogida.estado === 'recogida') throw new Error('Ya está recogida');
  await db.collection(SAL).updateOne({ _id: s._id }, { $set: { 'recogida.estado': 'pedida', 'recogida.pedidaAt': new Date(), 'recogida.pedidaPor': por || '', 'recogida.pedidaNota': String(nota || '').trim().slice(0, 200) || null } });
  return { ok: true };
}
async function marcarRecogida(id, { cantidad, por } = {}) {
  const db = await getDB();
  const s = await db.collection(SAL).findOne({ _id: oid(id), empresaId: EMPRESA });
  if (!s || !s.recogida) throw new Error('Esta salida no lleva recogida');
  const pend = Number(s.recogida.pendientes) || 0; if (pend <= 0) throw new Error('No queda nada por recoger');
  const q = Math.min(pend, Math.max(1, Number(cantidad) || pend));
  const quedan = r2(pend - q);
  await db.collection(SAL).updateOne({ _id: s._id }, { $set: { 'recogida.pendientes': quedan, 'recogida.estado': quedan > 0 ? s.recogida.estado : 'recogida' }, $push: { 'recogida.recogidas': { cantidad: q, at: new Date(), por: por || '' } } });
  return { ok: true, recogidas: q, quedan };
}
// Lo que hay colocado en obras esperando al camión, agrupado por obra.
async function recogidasPendientes() {
  const db = await getDB();
  const arr = await db.collection(SAL).find({ empresaId: EMPRESA, 'recogida.pendientes': { $gt: 0 } }).sort({ fecha: 1 }).toArray();
  const porObra = {};
  for (const s of arr) {
    const k = s.obraId || '-';
    (porObra[k] = porObra[k] || { obraId: s.obraId, obraRef: s.obraRef, total: 0, pedidas: 0, items: [] });
    porObra[k].total += s.recogida.pendientes; if (s.recogida.estado === 'pedida') porObra[k].pedidas += s.recogida.pendientes;
    porObra[k].items.push({ id: String(s._id), nombre: s.nombre, pendientes: s.recogida.pendientes, estado: s.recogida.estado, fecha: s.fecha, pedidaAt: s.recogida.pedidaAt, pedidaNota: s.recogida.pedidaNota, dias: Math.floor((Date.now() - new Date(s.fecha)) / 86400000) });
  }
  return Object.values(porObra).sort((a, b) => b.total - a.total);
}
// Para la ficha de la obra / rentabilidad (4.2): coste de lo sacado + sacas pendientes.
async function resumenObra(obraId) {
  const db = await getDB();
  const arr = await db.collection(SAL).find({ empresaId: EMPRESA, obraId: String(obraId) }).sort({ fecha: -1 }).toArray();
  return { importe: r2(arr.reduce((a, s) => a + (s.importe || 0), 0)), salidas: arr.map(s => ({ id: String(s._id), nombre: s.nombre, cantidad: s.cantidad, unidad: s.unidad, importe: s.importe, fecha: s.fecha, por: s.por && s.por.name, recogida: s.recogida })),
    sacasPendientes: arr.reduce((a, s) => a + ((s.recogida && s.recogida.pendientes) || 0), 0) };
}

module.exports = { entrada, lista, editar, salida, deshacerSalida, salidas, pedirRecogida, marcarRecogida, recogidasPendientes, resumenObra, _norm: norm };
