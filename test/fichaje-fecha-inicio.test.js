// test/fichaje-fecha-inicio.test.js — Quien empieza más tarde no ficha ni cuenta antes de su primer día.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('src/db.js', { getDB: async () => ({}) });
stub('src/users.js', {
  normalizeRole: r => r,
  getUsers: async () => [
    { _id: 'u1', name: 'Melvin', role: 'tecnico', whatsapp: '+34600000001' },
    { _id: 'u2', name: 'Norman', role: 'tecnico', whatsapp: '+34600000002', fechaInicio: '2026-10-19' },
  ],
});
const fm = require(path.join(root, 'src/fichajeMarcas.js'));

test('antes de su fecha de inicio no está en la plantilla; desde ese día, sí', async () => {
  assert.deepEqual((await fm.trabajadoresQueFichan('2026-10-16')).map(w => w.name), ['Melvin']);
  assert.deepEqual((await fm.trabajadoresQueFichan('2026-10-19')).map(w => w.name), ['Melvin', 'Norman']);
});
