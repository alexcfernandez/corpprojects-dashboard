// test/banco-dashboard.test.js — Bancos y gastos con las compras de tarjeta: cuentan en su categoría y el traspaso
// a Revolut / la liquidación de la tarjeta de ese mes ya no se suman (serían el mismo dinero dos veces).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');
const banco = [
  { mes: '2026-09', importe: -500, concepto: 'Transferencia A Favor De Corp Projects Holding Sl Concepto Pago Compras Tarjetas', categoria: 'pago_proveedor', flujo: 'salida' },
  { mes: '2026-09', importe: -1200, concepto: 'Recibo Saltoki Girona', categoria: 'material', flujo: 'salida' },
  { mes: '2026-09', importe: 3000, concepto: 'Transferencia De Ctat Prop Creu 2', categoria: 'ingreso_comunidad', flujo: 'entrada' },
];
const tarjetas = [
  { fecha: '2026-09-10', importe: -116.01, concepto: 'Obramat Girona', tipo: 'CARD_PAYMENT' },
  { fecha: '2026-09-11', importe: -60, concepto: 'Esclatoil Girona', tipo: 'CARD_PAYMENT' },
  { fecha: '2026-09-12', importe: 16.01, concepto: 'Refund from Obramat Girona', tipo: 'CARD_REFUND' },
];
const cur = arr => ({ toArray: async () => arr, project: () => ({ toArray: async () => arr }) });
const p = require.resolve(path.join(root, 'src/db.js'));
require.cache[p] = { id: p, filename: p, loaded: true, exports: { getDB: async () => ({ collection: n => ({ find: () => cur(n === 'bancoMovimientos' ? banco : tarjetas) }) }) } };
const B = require(path.join(root, 'src/banco.js'));

test('septiembre: Saltoki 1.200 + tarjeta 160 (116,01 + 60 − 16,01); el traspaso de 500 a Revolut no cuenta', async () => {
  const d = await B.getDashboardData();
  assert.equal(Math.round(d.BD['2026'].g[8] * 100) / 100, 1360);
  assert.equal(d.BD['2026'].i[8], 3000);
});
