// test/cuentas-proveedor.test.js — Cuenta de un proveedor: pagada por el banco, parcial (lo que falta), pagada
// solo según StelOrder, pendiente y un abono que resta.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');
const rec = [
  { id: 's1', numero: 'FPR00981', refProveedor: '20260014', proveedor: 'Rubén Esteban Díaz Aceña', fecha: '2026-09-21', total: 1962.62, pendienteStel: 1962.62 },
  { id: 's2', numero: 'FPR00990', refProveedor: '20260015', proveedor: 'Rubén Esteban Díaz Aceña', fecha: '2026-09-25', total: 500, pendienteStel: 500 },
  { id: 's3', numero: 'FPR00700', refProveedor: '20260003', proveedor: 'RUBÉN ESTEBAN DÍAZ ACEÑA', fecha: '2026-04-01', total: 300, pendienteStel: 0 },
  { id: 's4', numero: 'FPR00995', refProveedor: '20260016', proveedor: 'Rubén Esteban Díaz Aceña', fecha: '2026-10-01', total: 400, pendienteStel: 400 },
  { id: 's5', numero: 'FPR00873', refProveedor: 'A1', proveedor: 'PREFORMADOS ESPINOSA RUIZ, S.L.', fecha: '2026-07-30', total: 5349.71, pendienteStel: 5349.71 },
  { id: 's6', numero: 'FPR01000', refProveedor: 'AB1', proveedor: 'PREFORMADOS ESPINOSA RUIZ, S.L.', fecha: '2026-10-10', total: -160.49, pendienteStel: 0 },
];
const porDoc = new Map([
  ['FPR00981', [{ fecha: '2026-10-02', importe: -1962.62, origen: 'Cuenta Santander', conOtras: 0 }]],
  ['FPR00990', [{ fecha: '2026-10-02', importe: -200, origen: 'Cuenta Santander', conOtras: 0 }]],
  ['FPR00873', [{ fecha: '2026-07-17', importe: -3189.22, origen: 'Cuenta Santander', conOtras: 0 }, { fecha: '2026-07-22', importe: -2000, origen: 'Cuenta Santander', conOtras: 0 }]],
]);
const p = require.resolve(path.join(root, 'src/trimestre.js'));
require.cache[p] = { id: p, filename: p, loaded: true, exports: { todasRecibidas: async () => rec, recibidasPunteo: async r => r, mapaPagos: async () => ({ porDoc }), buscar: async () => ({ movimientos: [] }) } };
const CP = require(path.join(root, 'src/cuentasProveedor.js'));

test('Rubén: una pagada, una parcial (faltan 300), una pagada según StelOrder y una pendiente', async () => {
  const c = await CP.cuenta('Rubén Esteban');
  const by = n => c.facturas.find(f => f.numero === n);
  assert.equal(by('FPR00981').estado, 'pagada');
  assert.equal(by('FPR00990').estado, 'parcial'); assert.equal(by('FPR00990').pendiente, 300);
  assert.equal(by('FPR00700').segun, 'stelorder');
  assert.equal(by('FPR00995').estado, 'pendiente');
  assert.equal(c.totales.pendiente, 700);
});
test('Preformados: el abono del 3 % deja la cuenta a cero', async () => {
  const c = await CP.cuenta('Preformados Espinosa');
  assert.equal(c.totales.pendiente, 0);
  const l = await CP.cuentas();
  assert.equal(l.find(x => /preformados/i.test(x.proveedor)).pendiente, 0);
  assert.equal(l.find(x => /rub/i.test(x.proveedor)).pendiente, 700);
});
