// src/vehiculos.js — Gastos de cada vehículo (furgonetas y coches) para saber cuánto cuesta cada uno.
//
// Los vehículos son activos tipo 'vehiculo' (Llaves y herramientas: nombre, matrícula, quién lo lleva).
// Los gastos salen de:
//   · Compras con destino 'vehiculo' (facturas de taller, seguro, ITV…), por su base sin IVA si la hay.
//   · Pagos del punteo marcados «del vehículo» sin factura (tickets de gasolina, parking…).

async function getDB() { return require('./db').getDB(); }
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const CATEGORIAS = { taller: 'Taller y reparaciones', combustible: 'Combustible', neumaticos: 'Neumáticos', seguro: 'Seguro', itv: 'ITV', impuestos: 'Impuestos (IVTM)', peajes: 'Peajes y parking', lavado: 'Lavado', renting: 'Renting / leasing', gps: 'Localizador GPS', otros: 'Otros' };
// Categoría probable a partir del proveedor o el concepto.
function sugerirCategoria(texto) {
  const n = norm(texto);
  if (/neumat|pneumat|euromaster|confort auto/.test(n)) return 'neumaticos';
  if (/\bitv\b|inspeccion tecnica|applus|sgs/.test(n)) return 'itv';
  if (/seguro|assegur|mapfre|allianz|axa|generali|mutua|admiral|linea directa|occident/.test(n)) return 'seguro';
  if (/gasolin|petroprix|petrem|repsol|cepsa|galp|esclatoil|bp |shell|carburant|e\.?s\.? |estacio de servei|ballenoil|plenoil/.test(n)) return 'combustible';
  if (/peaje|autopista|autopistes|parking|aparcament|estacioname|via-?t/.test(n)) return 'peajes';
  if (/renting|leasing|arval|ald |leaseplan|northgate/.test(n)) return 'renting';
  if (/quartix|localiza|gps|tracker/.test(n)) return 'gps';
  if (/lavado|rentat|wash/.test(n)) return 'lavado';
  if (/taller|mecan|auto|norauto|midas|recambi|recanvi|carrosser|chapa|feu vert|classicauto|kin\b/.test(n)) return 'taller';
  if (/ivtm|impuesto vehic|xaloc|circulacion/.test(n)) return 'impuestos';
  return 'otros';
}

async function lista() {
  const db = await getDB();
  return (await db.collection('activos').find({ tipo: 'vehiculo' }, { projection: { foto: 0 } }).sort({ nombre: 1 }).toArray())
    .map(v => ({ id: String(v._id), codigo: v.codigo, nombre: v.nombre, matricula: v.matricula || '', marca: v.marca || '', modelo: v.modelo || '', quien: v.holderType === 'operario' ? v.holderName : null }));
}

async function gastos({ desde, hasta } = {}) {
  const db = await getDB();
  const qFecha = (campo) => (desde || hasta) ? { [campo]: { ...(desde ? { $gte: desde } : {}), ...(hasta ? { $lte: hasta } : {}) } } : {};
  const [cs, pm] = await Promise.all([
    db.collection('compras').find({ destino: 'vehiculo', vehiculoId: { $ne: null }, estado: { $ne: 'descartada' }, ...qFecha('fecha') })
      .project({ vehiculoId: 1, proveedor: 1, numero: 1, fecha: 1, base: 1, total: 1, categoria: 1, estado: 1, createdAt: 1 }).toArray(),
    db.collection('punteoManual').find({ decision: 'vehiculo', vehiculoId: { $ne: null }, ...qFecha('fecha') }).toArray(),
  ]);
  return [
    ...cs.map(c => ({ vehiculoId: c.vehiculoId, fecha: c.fecha || (c.createdAt && c.createdAt.toISOString().slice(0, 10)), concepto: [c.proveedor, c.numero].filter(Boolean).join(' nº '), categoria: c.categoria && CATEGORIAS[c.categoria] ? c.categoria : sugerirCategoria(c.proveedor), importe: r2(c.base != null ? c.base : c.total), conFactura: true, compraId: String(c._id), porRevisar: c.estado !== 'revisada' })),
    ...pm.map(p => ({ vehiculoId: p.vehiculoId, fecha: p.fecha, concepto: p.concepto + (p.nota ? ` — ${p.nota}` : ''), categoria: p.categoria || sugerirCategoria(p.concepto), importe: r2(Math.abs(p.importe || 0)), conFactura: false })),
  ].sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
}

// Resumen por vehículo para un año: total, por categoría, por mes y los últimos gastos.
async function resumen({ anio } = {}) {
  const y = Number(anio) || new Date().getFullYear();
  const [vs, gs] = await Promise.all([lista(), gastos({ desde: `${y}-01-01`, hasta: `${y}-12-31` })]);
  const out = vs.map(v => {
    const mios = gs.filter(g => g.vehiculoId === v.id);
    const porCat = {}, porMes = {};
    for (const g of mios) { porCat[g.categoria] = r2((porCat[g.categoria] || 0) + g.importe); const m = String(g.fecha || '').slice(0, 7); porMes[m] = r2((porMes[m] || 0) + g.importe); }
    const meses = Object.keys(porMes).filter(Boolean).length;
    return { ...v, total: r2(mios.reduce((a, g) => a + g.importe, 0)), porCategoria: porCat, porMes, mediaMes: meses ? r2(mios.reduce((a, g) => a + g.importe, 0) / meses) : 0, sinFactura: mios.filter(g => !g.conFactura).length, gastos: mios.slice(0, 60) };
  }).sort((a, b) => b.total - a.total);
  return { anio: y, categorias: CATEGORIAS, vehiculos: out, total: r2(out.reduce((a, v) => a + v.total, 0)) };
}

module.exports = { CATEGORIAS, sugerirCategoria, lista, gastos, resumen };
