// src/clientes.js — Cuentas de un cliente (comunidad, particular, empresa): lo que le hemos facturado, lo que
// nos han costado sus obras y lo gastado directamente a su nombre (reparaciones sueltas sin obra, destino
// «cliente» en Compras). Se ve en la ficha de la comunidad del dashboard.
'use strict';
async function getDB() { return require('./db').getDB(); }
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

async function historial(nombre) {
  const n = norm(nombre);
  if (!n) throw new Error('Falta el cliente');
  const db = await getDB();
  const compras = require('./compras');
  const [directas, obras, emitidas] = await Promise.all([
    db.collection('compras').find({ destino: 'cliente', estado: { $ne: 'descartada' }, duplicadoDe: null }).project({ lineas: 0, ia: 0 }).toArray(),
    db.collection('obras').find({ status: { $ne: 'descartada' } }).project({ reference: 1, clientName: 1, status: 1, budgetAmount: 1, invoicedAmount: 1, startDate: 1, createdAt: 1 }).toArray(),
    require('./trimestre').todasEmitidas().catch(() => []),
  ]);
  const suyas = directas.filter(c => norm(c.clienteNombre) === n);
  const susObras = obras.filter(o => norm(o.clientName) === n);
  const obrasOut = [];
  for (const o of susObras) {
    let coste = 0, docs = 0;
    try { const l = await compras.deObra(String(o._id)); coste = l.reduce((a, c) => a + (c.importe || 0), 0); docs = l.length; } catch (e) {}
    obrasOut.push({ id: String(o._id), referencia: o.reference || '', estado: o.status || '', presupuesto: r2(o.budgetAmount), compras: r2(coste), nCompras: docs });
  }
  const facturas = (emitidas || []).filter(f => norm(f.cliente) === n).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  const base = f => (f.base != null ? Number(f.base) : (Number(f.total) || 0) / 1.21);
  const facturado = r2(facturas.reduce((a, f) => a + base(f), 0));
  const pendiente = r2(facturas.reduce((a, f) => a + (f.pendiente > 0 ? f.pendiente : 0), 0));
  const gastoDirecto = r2(suyas.reduce((a, c) => a + (c.base != null ? c.base : (c.total || 0)), 0));
  const gastoObras = r2(obrasOut.reduce((a, o) => a + o.compras, 0));
  return {
    cliente: nombre,
    totales: { facturado, pendienteCobro: pendiente, gastoDirecto, gastoObras, gasto: r2(gastoDirecto + gastoObras), margenSinManoObra: r2(facturado - gastoDirecto - gastoObras) },
    facturas: facturas.slice(0, 60).map(f => ({ numero: f.numero, fecha: f.fecha, base: r2(base(f)), total: f.total, pendiente: f.pendiente })),
    nFacturas: facturas.length,
    obras: obrasOut.sort((a, b) => b.compras - a.compras),
    compras: suyas.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha))).map(c => ({ id: String(c._id), fecha: c.fecha, proveedor: c.proveedor, numero: c.numero, base: c.base, total: c.total, estado: c.estado, nota: c.nota || null })),
  };
}

module.exports = { historial, norm };
