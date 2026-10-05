// test/reclamaciones.test.js — Comisiones de CINC mal cobradas: se apuntan, se reclaman y se resuelven.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');

// Mongo mínimo en memoria para la colección reclamaciones.
let docs = [], n = 0;
const casa = (d, q) => Object.entries(q).every(([k, v]) => String(d[k]) === String(v));
const col = {
  async findOne(q) { return docs.find(d => casa(d, q)) || null; },
  async updateOne(q, u, o = {}) {
    let d = docs.find(x => casa(x, q));
    if (!d) { if (!o.upsert) return { matchedCount: 0 }; d = { _id: String(++n).padStart(24, '0'), ...q, ...(u.$setOnInsert || {}) }; docs.push(d); }
    Object.assign(d, u.$set || {});
    if (u.$push) for (const [k, v] of Object.entries(u.$push)) (d[k] = d[k] || []).push(v);
    return { matchedCount: 1 };
  },
  async deleteOne(q) { docs = docs.filter(d => !casa(d, q)); },
  find() { const c = { project: () => c, sort: () => c, limit: () => c, toArray: async () => docs.slice() }; return c; },
};
const db = { collection: () => col };
const dbPath = require.resolve(path.join(root, 'src/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDB: async () => db } };
const ccPath = require.resolve(path.join(root, 'src/comisionesCinc.js'));
let filas = [];
require.cache[ccPath] = { id: ccPath, filename: ccPath, loaded: true, exports: { revisar: async id => ({ compra: { id, numero: 'F26/4601605', fecha: '2026-08-31', base: 500 }, filas }) } };
// El ObjectId real exige 24 hex: los _id del mock lo son.
const R = require(path.join(root, 'src/reclamaciones.js'));

test('una factura con errores queda pendiente con lo cobrado de más', async () => {
  filas = [
    { num: 'FAC00950', cliente: 'CP Creu 2', descripcion: 'Fact. 950', cobra: 30, debe: 30, deMas: 0, estado: 'ok' },
    { num: 'FAC00950', cliente: 'CP Creu 2', descripcion: 'Fact. 950', cobra: 30, debe: 30, deMas: 30, estado: 'duplicada' },
    { num: 'FAC00686', cliente: 'CP Montseny', descripcion: 'Fact. 686', cobra: 120.15, debe: 35.4, deMas: 84.75, estado: 'de_mas' },
    { num: 'FAC00343', cliente: 'CP X', descripcion: 'Fact. 343', cobra: 5, debe: 8, deMas: -3, estado: 'de_menos' },
  ];
  const r = await R.desdeCinc('aaaaaaaaaaaaaaaaaaaaaaaa', 'Álex');
  assert.equal(r.reclamacion.estado, 'pendiente');
  assert.equal(r.reclamacion.importe, 114.75);
  assert.equal(r.reclamacion.conIva, 138.85);
  assert.equal(r.reclamacion.lineas.length, 2);
  assert.equal(r.reclamacion.mirar.length, 1);   // lo que cobran de menos no se reclama, se mira
});

test('volver a comprobarla no pisa el estado reclamada', async () => {
  const id = docs[0]._id;
  await R.cambiarEstado(id, { estado: 'reclamada', fecha: '2026-10-02' }, 'Álex');
  const r = await R.desdeCinc('aaaaaaaaaaaaaaaaaaaaaaaa', 'Álex');
  assert.equal(r.reclamacion.estado, 'reclamada');
  assert.equal(r.reclamacion.reclamadaEl, '2026-10-02');
});

test('texto para CINC con total e IVA; resuelta con abono sale del total', async () => {
  const t = R.textoReclamacion(docs.map(d => ({ ...d, id: d._id })), { formato: 'whatsapp' });
  assert.match(t.texto, /F26\/4601605/); assert.match(t.texto, /FAC950/); assert.match(t.texto, /114,75 €/);
  await R.cambiarEstado(docs[0]._id, { estado: 'resuelta', abono: 'A26/1' }, 'Álex');
  const p = await R.pendienteProveedor();
  assert.equal(p.total, 0);
  assert.equal(docs[0].historial.length, 2);
});
