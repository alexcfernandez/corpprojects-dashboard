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

test('el «Com. 10%» a la reserva es ahorro: no es gasto y su entrada en la reserva no es ingreso; saldos del año', async () => {
  banco.push(
    { mes: '2026-10', iban: 'ES0000000000000000000012', fechaOperacion: '2026-10-01', importe: -800, saldo: 9200, concepto: 'Traspaso: Com. 10%', categoria: 'otros', flujo: 'salida' },
    { mes: '2026-10', iban: 'ES0000000000000000006452', fechaOperacion: '2026-10-01', importe: 800, saldo: 5800, concepto: 'Transferencia De Corp Projects Holding Sl Concepto: Com 10%', categoria: 'otros', flujo: 'entrada' },
    { mes: '2026-10', iban: 'ES0000000000000000000012', fechaOperacion: '2026-10-02', importe: 2000, saldo: 11200, concepto: 'Transferencia De Cliente', categoria: 'ingreso', flujo: 'entrada' },
  );
  const d = await B.getDashboardData();
  assert.equal(d.BD['2026'].i[9], 2000);
  assert.equal(d.BD['2026'].g[9], 0);
  assert.equal(d.BD['2026'].a[9], 800);
  const s12 = d.saldos.cuentas.find(c => c.cuenta === '0012'), s52 = d.saldos.cuentas.find(c => c.cuenta === '6452');
  assert.deepEqual([s12.inicio, s12.fin], [10000, 11200]);
  assert.deepEqual([s52.inicio, s52.fin], [5000, 5800]);
});
