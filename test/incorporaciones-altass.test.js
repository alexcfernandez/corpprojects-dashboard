'use strict';
const test = require('node:test');
const assert = require('node:assert');
const I = require('../src/incorporaciones');

test('cerrarConAltaSS: con el alta de la gestoría en su carpeta la incorporación se cierra; sin ella, no', async () => {
  const incs = [{ _id: 'i1', nombre: 'Javier Orlando Huaca Páez', userId: 'u1', estado: 'abierta' }, { _id: 'i2', nombre: 'Pepe', userId: 'u2', estado: 'abierta' }];
  const docs = [{ userId: 'u1', tipo: 'alta_ss' }, { userId: 'u2', tipo: 'dni' }];
  const db = { collection: n => ({
    find: () => ({ toArray: async () => n === 'incorporaciones' ? incs : [] }),
    findOne: async q => docs.find(d => d.userId === q.userId && d.tipo === q.tipo) || null,
    updateOne: async () => {}, insertOne: async () => ({}),
  }) };
  const cerradas = [];
  const r = await I.cerrarConAltaSS({ _db: db, _cerrar: async id => cerradas.push(id) });
  assert.deepStrictEqual(r, ['Javier Orlando Huaca Páez']);
  assert.deepStrictEqual(cerradas, ['i1']);
});
