// test/precios.test.js — clave del artículo, tienda y avisos de precio al comprar.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('src/db.js', { getDB: async () => ({}) });
const P = require(path.join(root, 'src/precios.js'));

test('misma clave para el mismo artículo y tienda estable', () => {
  assert.equal(P.clave('WEBERTHERM BASEGEL GRIS (48 SAC/PAL) - Contribución SCRAP ENVALORA'), P.clave('webertherm basegel gris'));
  assert.equal(P.tienda('Saint-Gobain Weber Cemarksa, S.A.U'), 'Weber');
  assert.equal(P.tienda('Werkhaus Sl Scs'), 'Bauhaus');
});

test('al comprar: más caro que la última vez y más barato en otra tienda', async () => {
  const hist = [
    { fecha: '2026-05-11', tienda: 'Weber', clave: P.clave('WEBERTHERM BASEGEL GRIS'), precio: 13.03 },
    { fecha: '2026-08-01', tienda: 'Saltoki', clave: P.clave('WEBERTHERM BASEGEL GRIS'), precio: 12.10 },
  ];
  const avisos = [];
  const r = await P.alComprar({ _id: 'x', proveedor: 'Saint-Gobain Weber', fecha: '2026-10-14', lineas: [{ descripcion: 'WEBERTHERM BASEGEL GRIS', cantidad: 48, importe: 48 * 14.6 }] }, { _hist: async () => hist, _avisar: async t => avisos.push(t) });
  assert.equal(r.avisos.length, 2);
  assert.match(avisos[0], /14,6|14\.60/); assert.match(avisos[0], /Saltoki/);
});
