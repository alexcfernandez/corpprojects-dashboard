// test/corpus-routing.test.js — Corpus de regresión del ENRUTADO DETERMINISTA
// (Fase 0). Fija el comportamiento actual de las capas de detección que NO
// dependen de la IA, para poder refactorizar sin cambiarlo sin querer.
//
// NO cubre el enrutador IA (facturas/presupuestos/pedidos vía clasificar()), que
// necesita un arnés con mocks — queda para el arnés del agente (Fase 1).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { clasificarAccion } = require('../src/acceso');
const pend = require('../src/pendientes');
const em = require('../src/email-intelligence');
const asis = require('../src/asistente');

// ── Clasificación de acción (acceso): lectura | escritura | dinero ──
const ACCION = [
  ['¿qué debe Illa Verda?',                         'lectura'],
  ['resumen de tesorería',                          'lectura'],
  ['cuánto le debo a Javi',                         'lectura'],
  ['crea una incidencia en Santander 1',            'escritura'],
  ['crea un presupuesto a Illa Verda por 6000€',    'escritura'],
  ['paga a Jose 100€',                              'escritura'],
  ['apunta en Illa Verda que la caldera es Roca',   'escritura'],
  ['cambia el IVA de la 309 al 10%',                'escritura'],
  ['sube el presupuesto 309 un 10%',                'dinero'],
  ['baja el presupuesto 309 en 200€',               'dinero'],
  ['añade una partida al presupuesto 88',           'dinero'],
  ['haz la factura 309 más barata 200€',            'lectura'],   // factura no editable → mensaje honesto
];
for (const [frase, esperado] of ACCION)
  test(`clasificarAccion · "${frase}" → ${esperado}`, () => assert.equal(clasificarAccion(frase), esperado));

// ── Pendientes (detectarIntent): add | list | done | null ──
const PEND = [
  ['recuérdame hacer la factura de la EICA',        'add'],
  ['apúntame que tengo que llamar al fontanero',    'add'],
  ['añade un pendiente: revisar el contrato',       'add'],
  ['pendientes',                                    'list'],
  ['hecho el pendiente 2',                          'done'],
  ['quita el pendiente 3',                          'done'],
  ['apunta en Illa Verda que la caldera es Roca',   null],       // nota de comunidad, NO pendiente
  ['¿qué debe Illa Verda?',                         null],
];
for (const [frase, tipo] of PEND)
  test(`detectarIntent · "${frase}" → ${tipo}`, () => {
    const r = pend.detectarIntent(frase);
    assert.equal(r ? r.tipo : null, tipo);
  });

// ── Correo a demanda (intentCorreo) ──
test('intentCorreo · corpus', () => {
  assert.deepEqual(em.intentCorreo('¿algo de la gestoría?'), { soloGestoria: true });
  assert.deepEqual(em.intentCorreo('resumen del correo'), { soloGestoria: false });
  assert.equal(em.intentCorreo('cuántos pedidos tenemos'), null);
});

// ── Modificar presupuesto (parseModPresupuesto): pct | delta | add_partida | null ──
const MOD = [
  ['sube el PRT00309 un 10%',                       'pct'],
  ['baja el presupuesto 309 en 200€',               'delta'],
  ['añade una partida al PRT00309: 3 focos a 45€',  'add_partida'],
  ['dime el presupuesto 309',                       null],       // consulta, no modificación
];
for (const [frase, tipo] of MOD)
  test(`parseModPresupuesto · "${frase}" → ${tipo}`, () => {
    const r = asis.parseModPresupuesto(frase);
    assert.equal(r.tipo, tipo);
  });

// ── Factura no editable (mensaje honesto) vs presupuesto ──
test('mensajeFacturaNoEditable · corpus', () => {
  assert.match(asis.mensajeFacturaNoEditable('baja la factura 512 en 150€') || '', /rectificativa/i);
  assert.equal(asis.mensajeFacturaNoEditable('sube el presupuesto 309 un 10%'), null);
  assert.equal(asis.mensajeFacturaNoEditable('dame la factura 309'), null);
});

// ── Gestoría por remitente (autoritativo) ──
test('esGestoria · corpus (@somassessors.com)', () => {
  process.env.GESTORIA_EMAILS = '@somassessors.com';
  assert.equal(em.esGestoria('Joan <joan@somassessors.com>'), true);
  assert.equal(em.esGestoria('x@gmail.com'), false);
});
