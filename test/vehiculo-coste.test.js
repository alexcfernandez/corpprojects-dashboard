// test/vehiculo-coste.test.js — Lo que cuesta una furgoneta: compra + gastos + seguro de la ficha (solo si no hay
// factura de seguro ese año) − venta, y la media al año.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');
const { ObjectId } = require('mongodb');
const VID = new ObjectId();
const V = { _id: VID, nombre: 'Berlingo', estado: 'activo', fechaAlta: '2025-01-01', formaCompra: 'compra', precioCompra: 1200, seguro: { precioAnual: 400 }, ivtm: 90 };
const compras = [
  { _id: 1, destino: 'vehiculo', vehiculoId: String(VID), fecha: '2025-03-10', base: 300, categoria: 'taller', estado: 'revisada' },
  { _id: 2, destino: 'vehiculo', vehiculoId: String(VID), fecha: '2026-02-01', base: 250, categoria: 'neumaticos', estado: 'revisada' },
  { _id: 3, destino: 'vehiculo', vehiculoId: String(VID), fecha: '2026-05-01', base: 380, categoria: 'seguro', estado: 'revisada' },
];
const cur = arr => { const c = { project: () => c, sort: () => c, toArray: async () => arr }; return c; };
const db = { collection: n => ({ findOne: async () => V, find: () => cur(n === 'compras' ? compras : []) }) };
const p = require.resolve(path.join(root, 'src/db.js'));
require.cache[p] = { id: p, filename: p, loaded: true, exports: { getDB: async () => db } };
const Vh = require(path.join(root, 'src/vehiculos.js'));

test('compra 1.200 + taller + neumáticos + seguro e impuesto, sin contar dos veces el seguro de 2026', async () => {
  const c = await Vh.costeTotal(String(VID), { hoy: new Date('2027-01-01T12:00:00Z') });
  const y25 = c.porAnio.find(a => a.anio === 2025), y26 = c.porAnio.find(a => a.anio === 2026);
  assert.equal(y25.total, 1200 + 300 + 400 + 90);
  assert.equal(y26.porCategoria.seguro, 380);              // la factura, no los 400 de la ficha
  assert.equal(y26.total, 250 + 380 + 90);
  assert.equal(c.total, 1990 + 720 + 490);                 // 2027 aún: seguro 400 + ivtm 90
  assert.ok(c.alAnio > 1500 && c.alAnio < 1700);
});
