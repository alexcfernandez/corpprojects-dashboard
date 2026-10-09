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

test('nombre comercial ≠ razón social: las facturas de StelOrder heredan el alias para casar con el recibo', async () => {
  const stel = [{ id: '3', proveedor: 'COSSI COWORKING', refProveedor: '26-CW-91', fecha: '2026-07-08', total: 90.75 }];
  compras = [{ _id: 'd', proveedor: 'Cossi Coworking', razonSocial: 'Gerard Codina Mas', numero: '25-CW-147', fecha: '2025-10-09', total: 90.75 }];
  const r = await T.recibidasPunteo(stel);
  assert.equal(r.find(x => x.id === '3').alias, 'Gerard Codina Mas');
  const C = require(path.join(root, 'src/conciliacion.js'));
  const f = C.conciliar({ movimientos: [{ id: 'm', fecha: '2026-07-14', importe: -90.75, concepto: 'Recibo Gerard Codina Mas Nº Recibo 0049 2439 755 Bbrnfpj Ref. Mandato Oficina Fi', codigo: '061' }], emitidas: [], recibidas: r.filter(x => x.id === '3') }).filas[0];
  assert.equal(f.estado, 'punteado'); assert.equal(f.docs[0].refProveedor, '26-CW-91');
});
