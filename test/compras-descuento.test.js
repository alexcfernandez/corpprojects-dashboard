// test/compras-descuento.test.js — Descuento por línea: el importe sale de cantidad × precio − dto si la foto lo corta.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('src/db.js', { getDB: async () => ({}) });
const C = require(path.join(root, 'src/compras.js'));

test('Saltoki con la columna de importes cortada: se calcula con el descuento y suma la base', () => {
  const d = C._aplicarLectura({}, { tipo: 'albaran', proveedor: 'Saltoki', base: 62.78, total: 75.96, lineas: [
    { descripcion: 'MECANISMO UNIVERSAL DESCARGA SIMPLE', cantidad: 1, precio: 32.6, dto: 30, importe: null },
    { descripcion: 'BJC 18024 BASE ENCHUFE 2P+TT', cantidad: 4, precio: 15.37, dto: 35, importe: null },
    { descripcion: 'TICKET DESAYUNO SALTOKI', cantidad: 1, precio: null, importe: null }] });
  assert.equal(d.lineas[0].importe, 22.82); assert.equal(d.lineas[1].importe, 39.96); assert.equal(d.lineas[2].importe, null);
  assert.equal(Math.round((d.lineas[0].importe + d.lineas[1].importe) * 100) / 100, 62.78);
  assert.equal(d.lineas[0].dto, 30);
});
test('si el importe se lee, manda lo leído', () => {
  const d = C._aplicarLectura({}, { tipo: 'albaran', lineas: [{ descripcion: 'PENTRILO PAPER', cantidad: 1, precio: 28.06, dto: 20, importe: 22.45 }] });
  assert.equal(d.lineas[0].importe, 22.45);
});
