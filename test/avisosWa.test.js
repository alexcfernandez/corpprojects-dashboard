'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
// «Solo lo importante»: a quien lo tiene no le sale lo automático, salvo que acabe de escribir él.
test('silenciado: solo a quien tiene avisosWa=importante y no ha escrito en 15 min', async () => {
  const mock = (rel, exp) => { const p = require.resolve(path.join(__dirname, '..', 'src', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; return p; };
  let escribio = false;
  const ps = [
    mock('users', { getUsers: async () => [{ _id: 'j', name: 'Jose', telefono: '+34 600 111 222', avisosWa: 'importante' }, { _id: 'd', name: 'David', telefono: '600333444' }] }),
    mock('db', { getDB: async () => ({ collection: () => ({ findOne: async () => (escribio ? { _id: 1 } : null) }) }) }),
  ];
  const C = require('../src/canalWhatsapp');
  C._olvidarSilenciados();
  assert.strictEqual(await C._silenciado('whatsapp:+34600111222'), true);
  assert.strictEqual(await C._silenciado('+34600333444'), false);
  escribio = true;
  assert.strictEqual(await C._silenciado('+34600111222'), false, 'si acaba de escribir, la respuesta sale');
  ps.forEach(p => delete require.cache[p]);
});
