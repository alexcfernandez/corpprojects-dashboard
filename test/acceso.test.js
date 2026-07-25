// test/acceso.test.js — clasificación de acciones del control de acceso.
// Criterio: PIN + confirmación SOLO para modificar importes de presupuestos/
// facturas EXISTENTES. Crear presupuestos/pedidos/incidencias y apuntar pagos a
// trabajador son escrituras normales (solo owner, sin PIN). Cambiar el IVA es un
// flujo de escritura existente.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { clasificarAccion } = require('../src/acceso');

const CASOS = [
  ['resumen de Cinc',                             'lectura'],
  ['¿cuánto debe Illa Verda?',                    'lectura'],
  ['crea una incidencia en Santander 1',          'escritura'],
  ['crea un presupuesto a Illa Verda por 6000€',  'escritura'],
  ['genera el pedido de material',                'escritura'],
  ['paga a Jose 100€',                            'escritura'],
  ['apunta en Illa Verda que la caldera es Roca', 'escritura'],
  ['sube el presupuesto 309 un 10%',              'dinero'],
  ['baja el presupuesto 309 en 200€',             'dinero'],
  ['añade una partida al presupuesto 88',         'dinero'],
  ['cambia el IVA de la 309 al 10%',              'escritura'],
  // Fase 2: modificar una FACTURA emitida NO es 'dinero' (no editable por API);
  // se responde con la verdad (rectificativa a mano) en el router.
  ['haz la factura 309 más barata 200€',          'lectura'],
  ['baja la factura 512 en 150€',                 'lectura'],
];

for (const [texto, esperado] of CASOS) {
  test(`clasificarAccion("${texto}") = ${esperado}`, () => {
    assert.equal(clasificarAccion(texto), esperado);
  });
}
