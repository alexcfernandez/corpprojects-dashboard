// test/fase0-estado.test.js — estado de confirmaciones persistido (write-through
// + hydrate). Simula un reinicio limpiando la caché y recargando desde "Mongo".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');

// Mock de Mongo (colección estadoConversacion) ANTES de requerir el store.
let store = new Map();
const col = {
  async findOne(q) { return store.get(q.from) || null; },
  async updateOne(q, u, o) { store.set(q.from, { from: q.from, ...(u.$set || {}) }); return {}; },
  async deleteOne(q) { store.delete(q.from); return {}; },
};
const dbPath = require.resolve(path.join(root, 'src/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDB: async () => ({ collection: () => col }) } };

const est = require(path.join(root, 'src/estadoConversacion.js'));
const tick = () => new Promise(r => setImmediate(r));

test('set/get funciona como un Map (caché en memoria)', () => {
  est.set('u1', { accion: 'partidaFaltaPrecio', ref: 'PRT00309', ts: 1 });
  assert.deepEqual(est.get('u1'), { accion: 'partidaFaltaPrecio', ref: 'PRT00309', ts: 1 });
});

test('set persiste en Mongo (write-through)', async () => {
  est.set('u2', { accion: 'cambioIvaConfirmar', id: '9', iva: 21, ts: 2 });
  await tick(); // deja que aterrice el upsert fire-and-forget
  assert.ok(store.has('u2'));
  assert.equal(store.get('u2').val.iva, 21);
});

test('hydrate recupera el estado tras un "reinicio" (caché vacía)', async () => {
  est.set('u3', { accion: 'presuConfirm', ts: 3 });
  await tick();
  est._cache.clear();                       // simula reinicio del proceso
  assert.equal(est.get('u3'), undefined);   // ya no está en memoria
  await est.hydrate('u3');                   // recarga desde Mongo
  assert.deepEqual(est.get('u3'), { accion: 'presuConfirm', ts: 3 });
});

test('delete borra de caché y de Mongo', async () => {
  est.set('u4', { accion: 'x', ts: 4 });
  await tick();
  est.delete('u4');
  await tick();
  assert.equal(est.get('u4'), undefined);
  assert.equal(store.has('u4'), false);
});

test('hydrate de un from sin estado no rompe ni inventa', async () => {
  est._cache.clear();
  await est.hydrate('desconocido');
  assert.equal(est.get('desconocido'), undefined);
});
