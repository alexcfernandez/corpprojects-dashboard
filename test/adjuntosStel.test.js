// Fotos de las peticiones adjuntas en StelOrder (6/11/2026) y grupos nuevos de Corpy en escucha.
const test = require('node:test');
const assert = require('node:assert');
const { ObjectId } = require('mongodb');
const A = require('../src/adjuntosStel');

function fakeDb(fotos) {
  const sets = [];
  return { sets, collection: name => ({
    find: () => ({ toArray: async () => name === 'grupoFotos' ? fotos : [] }),
    updateOne: async (q, u) => { sets.push([name, u]); },
  }) };
}

test('sube cada foto a la incidencia y al pedido una sola vez', async () => {
  const f1 = new ObjectId(), f2 = new ObjectId();
  const db = fakeDb([{ _id: f1, data: Buffer.from('a'), mimetype: 'image/jpeg', quien: 'Cristina', ts: new Date() }, { _id: f2, data: Buffer.from('b'), mimetype: 'image/jpeg', ts: new Date() }]);
  const subidas = [];
  const stel = { adjuntar: async o => { subidas.push([o.entityType, o.entityId]); return { ok: true }; } };
  const p = { _id: new ObjectId(), fotoIds: [String(f1), String(f2)], incidencia: 'INC00662', incidenciaId: '1', pedido: { id: '2', ref: 'PDT00562' }, fotosStel: { inc: [String(f1)] } };
  const r = await A.subir(p, { _db: db, _stel: stel });
  assert.deepStrictEqual(r, { inc: 1, ped: 2 });
  assert.deepStrictEqual(subidas, [['INCIDENT', '1'], ['WORKORDER', '2'], ['WORKORDER', '2']]);
  const r2 = await A.subir(p, { _db: db, _stel: stel });
  assert.deepStrictEqual(r2, { inc: 0, ped: 0 });
});

test('un grupo nuevo entra en escucha con incidencias y avisa a Álex; uno conocido no cambia', async () => {
  const G = require('../src/grupoWhatsapp');
  const dbm = require('../src/db');
  const orig = dbm.getDB;
  const calls = [];
  let existe = false;
  dbm.getDB = async () => ({ collection: () => ({ createIndex: async () => {}, updateOne: async (q, u, o) => { calls.push(u); const r = { upsertedCount: existe ? 0 : 1 }; existe = true; return r; } }) });
  const avisos = [];
  try {
    const r = await G.grupoVisto('123@g.us', 'Madrenas - Corp', { _enviar: async (to, t) => avisos.push(t) });
    assert.strictEqual(r.nuevo, true);
    assert.strictEqual(calls[0].$setOnInsert.activo, true);
    assert.strictEqual(calls[0].$setOnInsert.autoIncidencia, true);
    assert.strictEqual(calls[0].$setOnInsert.corpyResponde, undefined);
    assert.match(avisos[0], /Madrenas - Corp/);
    const r2 = await G.grupoVisto('123@g.us', 'Madrenas - Corp', { _enviar: async (to, t) => avisos.push(t) });
    assert.strictEqual(r2.nuevo, false);
    assert.strictEqual(avisos.length, 1);
  } finally { dbm.getDB = orig; }
});

test('los vídeos del aviso también van a la incidencia', async () => {
  const v1 = new ObjectId();
  const subidas = [];
  const db = { collection: name => ({ find: () => ({ toArray: async () => name === 'grupoVideos' ? [{ _id: v1, data: Buffer.from('v'), mimetype: 'video/mp4', ts: new Date() }] : [] }), updateOne: async () => {} }) };
  const r = await A.subir({ _id: new ObjectId(), videoIds: [String(v1)], incidencia: 'INC1', incidenciaId: '1' }, { _db: db, _stel: { adjuntar: async o => { subidas.push(o.nombre); return { ok: true }; } } });
  assert.deepStrictEqual(r, { inc: 1, ped: 0 });
  assert.match(subidas[0], /\.mp4$/);
});
