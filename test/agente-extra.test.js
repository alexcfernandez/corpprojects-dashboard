const test = require('node:test');
const assert = require('node:assert');
const X = require('../src/agenteExtra');

test('nombres: «Rutlla 202» encaja con Rutlla 200-202 y no con Rutlla 70-72', () => {
  assert.ok(X._puntos('CTAT PROP RUTLLA, 200-202', 'rutlla 202') > X._puntos('RUTLLA 70-72', 'rutlla 202'));
  assert.ok(X._puntos('RUTLLA 70-72', 'rutlla') > 0 && X._puntos('CTAT PROP RUTLLA, 200-202', 'rutlla') > 0);   // «Rutlla» a secas: los dos (pregunta)
});

test('proveedores: Obramat es Bricoman y Bauhaus es Werkhaus', () => {
  assert.ok(X._casaProveedor('BRICOLAJE BRICOMAN, S.L.U. (OBRAMAT GIRONA)', 'obramat'));
  assert.ok(X._casaProveedor('Bricoman', 'Obramat'));
  assert.ok(X._casaProveedor('WERKHAUS SL', 'bauhaus'));
  assert.ok(!X._casaProveedor('Saltoki girona S.A', 'obramat'));
});

test('material: «suelo» busca también porcelánico, parquet, laminado…', () => {
  const t = X._terminosMaterial('qué suelo compramos');
  assert.ok(t.includes('porcelan') && t.includes('parquet') && t.includes('laminad'));
});
