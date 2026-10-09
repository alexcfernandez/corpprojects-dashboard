// test/recibidas-punteo.test.js — Compras que no están en StelOrder: con qué proveedor de StelOrder se juntan.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
let compras = [];
stub('src/db.js', { getDB: async () => ({ collection: () => ({ find: () => ({ project: () => ({ toArray: async () => compras }) }) }) }) });
const T = require(path.join(root, 'src/trimestre.js'));

test('una factura de Classicauto Girona Taller no va a la cuenta de Auto-Taller Kin por compartir «taller»', async () => {
  const stel = [
    { id: '1', proveedor: 'AUTO-TALLER KIN', refProveedor: '2026226', fecha: '2026-10-05', total: 391.75 },
    { id: '2', proveedor: 'CLASSICAUTO GIRONA TALLER, S.L.', refProveedor: 'A26-001200', fecha: '2026-07-02', total: 1010.36 },
  ];
  compras = [
    { _id: 'a', proveedor: 'Classicauto Girona Taller', numero: 'A26-003367', fecha: '2026-09-30', total: 1598.14 },
    { _id: 'b', proveedor: 'Auto Taller Kin', numero: '2026240', fecha: '2026-10-08', total: 210 },
    { _id: 'c', proveedor: 'Tallers Puig', numero: 'T-88', fecha: '2026-10-08', total: 50 },
  ];
  const r = await T.recibidasPunteo(stel);
  const de = id => r.find(x => x.compraId === id).proveedor;
  assert.equal(de('a'), 'CLASSICAUTO GIRONA TALLER, S.L.');
  assert.equal(de('b'), 'AUTO-TALLER KIN');
  assert.equal(de('c'), 'Tallers Puig');   // solo comparte «tallers»: se queda con su nombre
});
