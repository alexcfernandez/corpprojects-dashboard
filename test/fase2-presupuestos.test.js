// test/fase2-presupuestos.test.js — parser de comandos de modificación de
// presupuestos (Fase 2) y mensaje honesto para facturas. Solo lógica pura.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseModPresupuesto, mensajeFacturaNoEditable } = require('../src/asistente');

test('detecta % de subida', () => {
  const p = parseModPresupuesto('sube el PRT00309 un 10%');
  assert.equal(p.tipo, 'pct'); assert.equal(p.ref, 'PRT00309'); assert.equal(p.valor, 10);
});

test('detecta % de bajada (valor negativo)', () => {
  const p = parseModPresupuesto('baja el presupuesto 309 un 5%');
  assert.equal(p.tipo, 'pct'); assert.equal(p.ref, '309'); assert.equal(p.valor, -5);
});

test('detecta importe fijo en € (bajada)', () => {
  const p = parseModPresupuesto('baja el PRT00309 en 200€');
  assert.equal(p.tipo, 'delta'); assert.equal(p.ref, 'PRT00309'); assert.equal(p.valor, -200);
});

test('detecta importe fijo "euros" (subida)', () => {
  const p = parseModPresupuesto('sube el PRT00088 150 euros');
  assert.equal(p.tipo, 'delta'); assert.equal(p.valor, 150);
});

test('no confunde el % con la referencia', () => {
  const p = parseModPresupuesto('sube el presupuesto 309 un 10%');
  assert.equal(p.ref, '309'); assert.equal(p.valor, 10);
});

test('detecta añadir partida', () => {
  const p = parseModPresupuesto('añade una partida al PRT00309: cambiar 3 fluorescentes');
  assert.equal(p.tipo, 'add_partida'); assert.equal(p.ref, 'PRT00309');
});

test('sin referencia → ref null', () => {
  const p = parseModPresupuesto('sube un 10%');
  assert.equal(p.ref, null);
});

test('mensaje honesto para modificar una factura', () => {
  assert.match(mensajeFacturaNoEditable('haz la factura 309 más barata 200€') || '', /rectificativa/i);
  assert.match(mensajeFacturaNoEditable('baja la factura 512 en 150€') || '', /rectificativa/i);
});

test('modificar un presupuesto NO dispara el mensaje de factura', () => {
  assert.equal(mensajeFacturaNoEditable('sube el presupuesto 309 un 10%'), null);
});

test('consultar una factura NO dispara el mensaje de factura', () => {
  assert.equal(mensajeFacturaNoEditable('dame la factura 309'), null);
});
