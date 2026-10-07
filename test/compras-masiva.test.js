// test/compras-masiva.test.js — Subida masiva: la factura de la web (Bricoman) de una compra que ya estaba como ticket
// (Obramat, lo subió el trabajador) se reconoce por NIF + total + fecha; un PDF con varias facturas se parte por páginas.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');

const docs = [{ _id: 't1', empresaId: 'corp', estado: 'por_revisar', tipo: 'ticket', proveedorNorm: 'obramat', nif: 'B84406289', fecha: '2026-07-10', total: 116.01, obraId: 'o1', obraRef: 'Oviedo 16' }];
const val = (d, k) => d[k] === undefined ? null : d[k];
const ok = (d, q) => Object.entries(q).every(([k, c]) => k === '$or' ? c.some(x => ok(d, x)) : (c && typeof c === 'object') ? (('$in' in c ? c.$in.includes(val(d, k)) : true) && ('$ne' in c ? val(d, k) !== c.$ne : true) && ('$gte' in c ? val(d, k) >= c.$gte : true) && ('$lte' in c ? val(d, k) <= c.$lte : true)) : val(d, k) === c);
const db = { collection: () => ({ findOne: async q => docs.find(d => ok(d, q)) || null }) };
const dbPath = require.resolve(path.join(root, 'src/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDB: async () => db } };
const C = require(path.join(root, 'src/compras.js'));

test('la factura de la web es la misma compra que el ticket (otro nombre, mismo NIF, total y fecha ±1 día)', async () => {
  const g = await C._gemelaTicket(db, { _id: 'f1', proveedorNorm: 'bricolaje bricoman', nif: 'B84406289', fecha: '2026-07-11', total: 116.01 });
  assert.equal(g && g._id, 't1');
  assert.equal(await C._gemelaTicket(db, { _id: 'f2', proveedorNorm: 'bricolaje bricoman', nif: 'B84406289', fecha: '2026-07-11', total: 99 }), null);
});

test('un PDF con 3 facturas se parte en 3', async () => {
  const { PDFDocument } = require('pdf-lib');
  const d = await PDFDocument.create(); for (let i = 0; i < 3; i++) d.addPage();
  const partes = await C._partirPdf(Buffer.from(await d.save()));
  assert.equal(partes.length, 3);
});
