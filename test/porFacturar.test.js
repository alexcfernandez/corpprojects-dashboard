'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { calcularPorFacturar } = require('../src/obras');

test('lo hecho a precio mínimo: material +30 %, jornada 450, 20 €/día', () => {
  const r = calcularPorFacturar({ totalHoras: 90, dias: 5, material: 1000, facturado: 0 });
  assert.strictEqual(r.lineas.material.venta, 1300);
  assert.strictEqual(r.lineas.manoObra.venta, 4500);
  assert.strictEqual(r.lineas.desplazamientos.venta, 100);
  assert.strictEqual(r.minimo, 5900);
  assert.strictEqual(r.falta, 5900);
  assert.strictEqual(r.estado, 'falta');
});

test('facturado de sobra → ok; sin facturas usa lo certificado', () => {
  assert.strictEqual(calcularPorFacturar({ totalHoras: 9, dias: 1, material: 0, facturado: 600 }).estado, 'ok');
  const c = calcularPorFacturar({ totalHoras: 9, dias: 1, material: 0, certificado: 500 });
  assert.strictEqual(c.fuente, 'certificaciones'); assert.strictEqual(c.estado, 'ok');
});

test('presupuesto todo incluido: lo que deja para mano de obra y si se queda corto', () => {
  const r = calcularPorFacturar({ totalHoras: 180, dias: 10, material: 10000, presupuesto: 29400, facturado: 10000 });
  assert.strictEqual(r.paraManoObra, 29400 - 13000 - 200);
  assert.strictEqual(r.jornadasQueDa, 36);
  assert.strictEqual(r.jornadasLlevadas, 20);
  assert.strictEqual(r.quedaPorFacturar, 19400);
  assert.strictEqual(calcularPorFacturar({ totalHoras: 900, dias: 50, material: 10000, presupuesto: 20000 }).estado, 'corto');
});

test('solo cuenta el tiempo de socios marcado «se cobra»', () => {
  const socios = { ratos: [{ minutos: 60, quienes: ['Álex', 'Alfonso'], km: 10, facturable: true }, { minutos: 120, quienes: ['Álex'], km: 0, facturable: false }] };
  assert.strictEqual(calcularPorFacturar({ socios }).lineas.gestion.venta, 83);
});
