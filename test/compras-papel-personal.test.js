const test = require('node:test');
const assert = require('node:assert');
const { papelPersonal } = require('../src/compras');

test('papeles personales de un trabajador no son compras', () => {
  assert.strictEqual(papelPersonal({ tipo: 'otro', proveedor: 'Ministerio de Inclusión, Seguridad Social y Migraciones' }).tipo, 'extranjeria');
  assert.match(papelPersonal({ tipo: 'otro', proveedor: 'CaixaBank' }).nombre, /cuenta bancaria/);
  assert.strictEqual(papelPersonal({ tipo: 'factura', proveedor: 'Obramat' }), null);
  assert.strictEqual(papelPersonal({ tipo: 'ticket', proveedor: 'Repsol' }), null);
  assert.strictEqual(papelPersonal({ tipo: 'factura', proveedor: 'Banco de Pintura SL' }), null);
});
