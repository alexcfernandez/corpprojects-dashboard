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

test('partes de horas nuestros (Corp Projects) van a la obra, no a compras', () => {
  const { esParteNuestro } = require('../src/compras');
  assert.strictEqual(esParteNuestro({ proveedor: 'Corp Projects', tipo: 'albaran', total: 0 }), true);
  assert.strictEqual(esParteNuestro({ proveedor: 'Obramat', tipo: 'albaran', total: 0 }), false);
  assert.strictEqual(esParteNuestro({ proveedor: 'Corp Projects', tipo: 'factura', total: 120 }), false);
});

test('papeles de vehículo: ficha técnica e ITV no son compras', () => {
  const { papelVehiculo } = require('../src/compras');
  assert.deepStrictEqual(papelVehiculo({ tipo: 'otro', total: 0 }, { aviso: 'Hoja de tarjetas ITV del vehículo matrícula 9257FCY' }), { tipo: 'itv', matricula: '9257FCY' });
  assert.strictEqual(papelVehiculo({ tipo: 'otro', total: 0 }, { documentoVehiculo: { tipo: 'ficha_tecnica', matricula: '9257 FCY' } }).matricula, '9257FCY');
  assert.strictEqual(papelVehiculo({ tipo: 'factura', total: 54.98 }, { aviso: 'ITV del vehículo 8446JDT' }), null);   // la factura de la ITV sí es una compra
});
