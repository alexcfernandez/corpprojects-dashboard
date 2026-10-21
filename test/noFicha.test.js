'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
// El dueño (noFicha) no está en la plantilla que ficha: ni recordatorios ni «no ha fichado».
test('trabajadoresQueFichan deja fuera a quien tiene noFicha', async () => {
  const usersPath = require.resolve(path.join(__dirname, '..', 'src', 'users'));
  require.cache[usersPath] = { id: usersPath, filename: usersPath, loaded: true, exports: {
    getUsers: async () => [
      { _id: 'a1', name: 'Alex', role: 'tech', whatsapp: '600000001', noFicha: true },
      { _id: 'j1', name: 'Jose Beliard', role: 'tech', telefono: '600000002' },
    ],
    normalizeRole: r => ({ tech: 'tecnico', office: 'oficina' }[r] || r),
  } };
  const fm = require('../src/fichajeMarcas');
  const l = await fm.trabajadoresQueFichan('2026-10-21');
  assert.deepStrictEqual(l.map(w => w.name), ['Jose Beliard']);
  delete require.cache[usersPath];
});
