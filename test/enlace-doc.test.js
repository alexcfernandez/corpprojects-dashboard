// test/enlace-doc.test.js — Enlace firmado a un documento: vale para ese, caduca y no se puede falsificar.
const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'secreto-de-prueba';
const E = require('../src/enlaceDoc');
test('enlace a un documento: válido, falsificado, de otro documento y caducado', () => {
  const t = E.crear('6ac8d9b35a16443607a80670');
  assert.equal(E.verificar(t), '6ac8d9b35a16443607a80670');
  assert.equal(E.verificar(t.replace('6ac8d9b3', '6ac8d9b4')), null);
  assert.equal(E.verificar(t.slice(0, -2) + 'xx'), null);
  assert.equal(E.verificar(E.crear('6ac8d9b35a16443607a80670', { dias: -1 })), null);
});
