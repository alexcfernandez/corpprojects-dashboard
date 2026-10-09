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

test('proveedor de tienda (se paga con tarjeta): lo que no casa no es deuda, es «pagada en tienda»', () => {
  const { _aplicarTienda } = require('../src/cuentasProveedor');
  const pago = o => ({ fecha: '2026-10-06', importe: 10, origen: o });
  const fs = [
    { estado: 'pagada', pendiente: 0, pagos: [pago('Revolut …6439')] }, { estado: 'pagada', pendiente: 0, pagos: [pago('Revolut …6439')] },
    { estado: 'pagada', pendiente: 0, pagos: [pago('Crédito …9259')] }, { estado: 'pendiente', pendiente: 633.7, pagos: [] },
  ];
  assert.equal(_aplicarTienda(fs), true);
  assert.equal(fs[3].estado, 'sin_localizar'); assert.equal(fs[3].pendiente, 0); assert.equal(fs[3].sinLocalizar, 633.7);
  const transf = [{ estado: 'pagada', pendiente: 0, pagos: [pago('Cuenta Santander')] }, { estado: 'pagada', pendiente: 0, pagos: [pago('Cuenta Santander')] }, { estado: 'pagada', pendiente: 0, pagos: [pago('Cuenta Santander')] }, { estado: 'pendiente', pendiente: 500, pagos: [] }];
  assert.equal(_aplicarTienda(transf), false);
  assert.equal(transf[3].estado, 'pendiente');   // a Saltoki, Oliveras… sí se les debe
});

test('Obras Plener: la rectificativa anula la factura de 18.582,84 y su pago de 14.000 pasa a la nueva de 14.000,35', () => {
  const { _aplicarRectificativas } = require('../src/cuentasProveedor');
  const p = (fecha, importe) => ({ fecha, importe, origen: 'Cuenta Santander' });
  const fs = [
    { numero: 'FPR00217', refProveedor: '18062025001', fecha: '2025-06-18', total: 12705, pagado: 12705, pendiente: 0, estado: 'pagada', segun: 'banco', pagos: [p('2025-07-04', 12705)] },
    { numero: 'FPR00209', refProveedor: '18062025002', fecha: '2025-07-18', total: 18582.84, pagado: 14000, pendiente: 4582.84, estado: 'parcial', segun: 'banco', pagos: [p('2025-07-29', 14000)] },
    { numero: 'FPR00527', refProveedor: 'R018122025002', fecha: '2026-01-30', total: -18582.84, pagado: 0, pendiente: 0, estado: 'abono', pagos: [] },
    { numero: 'FPR00528', refProveedor: 'F018122025004', fecha: '2026-01-30', total: 14000.35, pagado: 14000.35, pendiente: 0, estado: 'pagada', segun: 'stelorder', pagos: [] },
  ];
  _aplicarRectificativas(fs);
  assert.equal(fs[1].estado, 'anulada'); assert.equal(fs[1].pendiente, 0); assert.equal(fs[1].pagado, 0);
  assert.equal(fs[3].estado, 'pagada'); assert.equal(fs[3].pagado, 14000); assert.equal(fs[3].pagos.length, 1);
  assert.equal(fs.reduce((a, f) => a + f.pagado, 0), 26705);          // lo que de verdad se les pagó
  assert.equal(fs.reduce((a, f) => a + f.pendiente, 0), 0);
});
