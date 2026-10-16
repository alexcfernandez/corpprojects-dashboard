const test = require('node:test');
const assert = require('node:assert');
const { _repartir: r } = require('../src/encargos');

test('respuesta a la lista numerada de compras sin obra', () => {
  assert.deepStrictEqual(r('1 Rahola, 2 almacén, 3 y 4 Rahola', 4), { 1: 'Rahola', 2: 'almacén', 3: 'Rahola', 4: 'Rahola' });
  assert.deepStrictEqual(r('1,2 Rahola 3 furgoneta', 3), { 1: 'Rahola', 2: 'Rahola', 3: 'furgoneta' });
  assert.deepStrictEqual(r('1 santa eugenia 57 2 almacen', 2), { 1: 'santa eugenia 57', 2: 'almacen' });
  assert.deepStrictEqual(r('Rahola', 2), { 1: 'Rahola', 2: 'Rahola' });
});
