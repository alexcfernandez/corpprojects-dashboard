// test/obras-fusionar.test.js — fusionar una obra repetida en la buena: todo pasa y la repetida queda como alias.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ObjectId } = require('mongodb');
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const O = new ObjectId(), D = new ObjectId();
const cols = { obras: [{ _id: O, reference: 'edificio seguridad social', aliases: [] }, { _id: D, reference: 'INSS Girona (Seranco)', aliases: ['INSS'] }],
  fichajeMarcas: [{ _id: 1, obraId: String(O) }], compras: [{ _id: 2, obraId: String(O), obraRef: 'edificio seguridad social', reparto: [] }],
  attendance: [{ _id: 3, clientName: 'edificio seguridad social', obras: [{ obraId: String(O), clientName: 'edificio seguridad social' }] }] };
const match = (d, q) => Object.entries(q).every(([k, v]) => {
  if (k === 'obras.obraId') return (d.obras || []).some(x => v.$in.map(String).includes(String(x.obraId)));
  if (k === 'reparto.obraId') return (d.reparto || []).some(x => String(x.obraId) === String(v));
  if (v && v.$in) return v.$in.map(String).includes(String(d[k]));
  if (v instanceof ObjectId) return String(d[k]) === String(v);
  return d[k] === v;
});
const db = { collection: n => ({
  findOne: async q => (cols[n] || []).find(d => match(d, q)) || null,
  updateOne: async (q, u) => { const d = (cols[n] || []).find(x => match(x, q)); if (d) Object.assign(d, u.$set); return { modifiedCount: d ? 1 : 0 }; },
  updateMany: async (q, u) => { let m = 0; for (const d of (cols[n] || []).filter(x => match(x, q))) { m++; for (const [k, v] of Object.entries(u.$set)) {
    if (k.startsWith('obras.$[x].')) d.obras.forEach(x => { if (String(x.obraId) === String(O)) x[k.slice(11)] = v; }); else if (k.startsWith('reparto.$[x].')) {} else d[k] = v; } } return { modifiedCount: m }; },
}) };
stub('src/db.js', { getDB: async () => db, getDBLegacy: async () => ({ db, client: { close: async () => {} } }) });
const OB = require(path.join(root, 'src/obras.js'));

test('fusionar: fichajes, compras y presencia pasan a la buena; la repetida queda descartada y como alias', async () => {
  const r = await OB.fusionarObras(String(O), String(D), 'Álex');
  assert.equal(cols.fichajeMarcas[0].obraId, String(D));
  assert.equal(cols.compras[0].obraId, String(D)); assert.equal(cols.compras[0].obraRef, 'INSS Girona (Seranco)');
  assert.equal(cols.attendance[0].obras[0].obraId, String(D)); assert.equal(cols.attendance[0].clientName, 'INSS Girona (Seranco)');
  assert.equal(cols.obras[0].status, 'descartada'); assert.deepEqual(cols.obras[1].aliases, ['INSS', 'edificio seguridad social']);
  assert.equal(r.a, 'INSS Girona (Seranco)');
});
