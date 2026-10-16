const test = require('node:test');
const assert = require('node:assert');
const I = require('../src/idiomas');

test('mensaje a un trabajador con otro idioma: traducción arriba y español debajo', async () => {
  const out = await I.paraEnviar('+34600000000', 'Hola 👋 pulsa *Termino la jornada*', { _idioma: 'ar', _llamar: async () => 'مرحبا 👋' });
  assert.match(out, /^مرحبا 👋\n\n— Español —\nHola 👋 pulsa \*Termino la jornada\*$/);
  assert.strictEqual(await I.paraEnviar('+34600000000', 'Hola', { _idioma: null }), 'Hola');
  assert.strictEqual(await I.paraEnviar('+34600000000', 'Hola', { _idioma: 'es' }), 'Hola');
});
