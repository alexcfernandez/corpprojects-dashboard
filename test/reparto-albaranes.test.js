// test/reparto-albaranes.test.js — Factura que agrupa albaranes de varias obras (Pintures Sant Narcís):
// reparto por obra con las líneas de cada albarán.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');

const F = { _id: 'f'.repeat(24), empresaId: 'corp', tipo: 'factura', proveedor: 'Pintures Sant Narcís', proveedorNorm: 'pintures sant narcis', base: 100, total: 121,
  lineas: [
    { descripcion: 'PATTEX', importe: 7.2, albaran: 'SC/286689', obraTexto: 'OBRA CARLES RAHOLA, 13 ATIC (ALEX RINCON)' },
    { descripcion: 'BROTXA', importe: 10.06, albaran: 'SC/286689', obraTexto: 'OBRA CARLES RAHOLA, 13 ATIC (ALEX RINCON)' },
    { descripcion: 'IRIS SPRAY', importe: 10.35, albaran: 'SC/286733', obraTexto: 'CARRER OVIEDO 39 ALEX RINCON' },
    { descripcion: 'TOLLENS', importe: 48.5, albaran: 'SC/286800', obraTexto: 'CARME 60' },
    { descripcion: 'ESMALTE', importe: 23.89, albaran: 'SC/286864', obraTexto: null },
  ] };
const ALB = [{ _id: 'a'.repeat(24), tipo: 'albaran', numero: 'SC/286864', obraId: 'o3', obraRef: 'Carme 60', proveedor: 'Pintures Sant Narcis', proveedorNorm: 'pintures sant narcis' }];
const cursor = arr => { const c = { project: () => c, sort: () => c, toArray: async () => arr.slice() }; return c; };
const db = { collection: n => ({ findOne: async () => F, find: () => cursor(n === 'compras' ? ALB : []) }) };
const dbPath = require.resolve(path.join(root, 'src/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDB: async () => db } };
const obPath = require.resolve(path.join(root, 'src/obras.js'));
require.cache[obPath] = { id: obPath, filename: obPath, loaded: true, exports: { getSelector: async () => [
  { id: 'o1', reference: 'Carles Rahola 13 Àtic', clientName: 'Alex Rincon', address: 'C/ Carles Rahola 13', aliases: [] },
  { id: 'o2', reference: 'Oviedo 39', clientName: 'CP Oviedo 39', address: 'Carrer Oviedo 39', aliases: [] },
  { id: 'o3', reference: 'Carme 60', clientName: 'CP Carme 60', address: 'Carrer del Carme 60', aliases: [] },
] } };
const C = require(path.join(root, 'src/compras.js'));

test('cada albarán va a su obra; dos albaranes de la misma obra se juntan', async () => {
  const r = await C.repartoPorAlbaran(F._id);
  const de = id => r.grupos.find(g => g.obraId === id);
  assert.equal(de('o1').importe, 17.26);                 // Carles Rahola, por el nombre (sin «Alex Rincon»)
  assert.equal(de('o2').importe, 10.35);                 // Oviedo 39
  assert.equal(de('o3').importe, 72.39);                 // Carme 60 por el texto + SC/286864 por el albarán en Compras
  assert.deepEqual(de('o3').albaranes.sort(), ['SC/286800', 'SC/286864']);
  assert.equal(r.suma, 100); assert.equal(r.diferencia, 0);
});
