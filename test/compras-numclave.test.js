'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { _numClave } = require('../src/compras');
test('el mismo nº de factura escrito distinto es el mismo (repetidas de Obramat, 26/10/2026)', () => {
  const k = _numClave('F0018-043-51-07-02841');
  assert.strictEqual(_numClave('F0018-043-51-07/02841'), k);
  assert.strictEqual(_numClave('F0018-043-51-07/0002841'), k);
  assert.notStrictEqual(_numClave('F0018-043-51-07/0002842'), k);
  assert.strictEqual(_numClave('061088'), _numClave('61088'));
});
