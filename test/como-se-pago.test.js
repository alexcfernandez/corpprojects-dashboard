// test/como-se-pago.test.js — «¿Cómo se pagó?»: pago libre que cuadra, pago ya casado, o tarjeta sin extracto.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
let banco = [], tarj = [], porMov = new Map();
const cur = a => ({ project: () => ({ toArray: async () => a }), toArray: async () => a });
stub('src/db.js', { getDB: async () => ({ collection: n => ({
  find: () => cur(n === 'bancoMovimientos' ? banco : tarj),
  aggregate: () => ({ toArray: async () => [{ _id: 'ES12...0012', desde: '2026-01-01', hasta: '2026-10-08' }] }),
}) }) });
stub('src/tarjetas.js', { listaTarjetas: async () => [{ last4: '6439', banco: 'Revolut', persona: 'David Taladros', desde: '2026-07-01', hasta: '2026-10-08', nMovimientos: 300 }, { last4: '9259', banco: 'Santander crédito', persona: 'Álex', desde: '2026-01-01', hasta: '2026-08-31', nMovimientos: 120 }] });
stub('src/trimestre.js', { mapaPagos: async () => ({ porMov }), enlazarCompra: async () => ({ ok: true }) });
const C = require(path.join(root, 'src/comoSePago.js'));
const fra = { numero: 'F0018-043-12', proveedor: 'Obramat', fecha: '2026-09-20', total: 85.4 };

test('un pago libre del mismo importe esos días: «se pagó casi seguro con…»', async () => {
  tarj = [{ _id: 't1', fecha: '2026-09-20', importe: -85.4, concepto: 'Obramat Girona', tarjeta: '6439', fuente: 'revolut' }]; banco = []; porMov = new Map();
  const r = await C.investigar(fra);
  assert.equal(r.candidatos.length, 1); assert.match(r.conclusion, /Revolut …6439 \(David Taladros\) el 20\/09\/2026/);
});
test('el pago de ese importe ya está casado con otra factura', async () => {
  porMov = new Map([['t1', { estado: 'punteado', docs: [{ ref: 'F0018-043-99' }] }]]);
  const r = await C.investigar(fra);
  assert.match(r.conclusion, /ya está casado con F0018-043-99/);
});
test('ningún pago: avisa de la tarjeta sin movimientos cargados en esa fecha', async () => {
  tarj = []; porMov = new Map();
  const r = await C.investigar(fra);
  assert.match(r.conclusion, /Faltan movimientos de …9259 \(Álex\)/);
  assert.equal(r.tarjetas.find(t => t.tarjeta === '9259').cubre, false);
});
