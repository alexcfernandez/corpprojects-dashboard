'use strict';
const test = require('node:test');
const assert = require('node:assert');
const T = require('../src/trabajos');

test('día propuesto: siguiente laborable; urgente antes de las 13:00 es hoy', () => {
  assert.strictEqual(T.diaPropuesto({ ahora: new Date('2026-10-21T08:00:00Z') }), '2026-10-22');            // miércoles → jueves
  assert.strictEqual(T.diaPropuesto({ urgente: true, ahora: new Date('2026-10-21T08:00:00Z') }), '2026-10-21'); // urgente por la mañana → hoy
  assert.strictEqual(T.diaPropuesto({ urgente: true, ahora: new Date('2026-10-21T13:30:00Z') }), '2026-10-22'); // urgente por la tarde → mañana
  assert.strictEqual(T.diaPropuesto({ ahora: new Date('2026-10-23T08:00:00Z') }), '2026-10-26');            // viernes → lunes
});

test('palabras de la comunidad: sin «ctat», «carrer»… y con el número', () => {
  assert.deepStrictEqual(T._palabras('CTAT PROP. carrer Major de Salt 75, 77'), ['major', 'salt', '75', '77']);
  assert.deepStrictEqual(T._palabras('Plza. MELA MUTERMILCH 1-2-3'), ['mela', 'mutermilch', '1', '2', '3']);
  assert.strictEqual(T._fechaTxt('2026-10-22'), 'jueves 22/10');
});

test('ocupado: obra fija o 3+ días seguidos en la misma obra; no si la petición es de esa obra (2/11/2026, Abdellah en el INSS)', () => {
  const recientes = ['2026-10-27', '2026-10-28', '2026-10-30', '2026-11-02'].map(date => ({ workerId: 'a1', date, estado: 'obra', obras: [{ clientName: 'INSS Girona (Seranco)' }] }));
  const casaNada = () => false;
  assert.strictEqual(T._ocupadoEn('a1', { recientes, fecha: '2026-11-03', casa: casaNada }), 'INSS Girona (Seranco)');
  assert.strictEqual(T._ocupadoEn('a1', { recientes: recientes.slice(0, 2), fecha: '2026-11-03', casa: casaNada }), null);
  assert.strictEqual(T._ocupadoEn('a1', { recientes, fecha: '2026-11-03', casa: n => /inss/i.test(n) }), null);
  const fijas = [{ workerId: 'm1', activa: true, desde: '2026-10-01', hasta: null, obraRef: 'INSS Girona (Seranco)' }];
  assert.strictEqual(T._ocupadoEn('m1', { fijas, fecha: '2026-11-03', casa: casaNada }), 'INSS Girona (Seranco)');
  assert.strictEqual(T._ocupadoEn('m1', { fijas, fecha: '2026-09-30', casa: casaNada }), null);
});
