// test/config.test.js — comprobaciones de integridad de la config base.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const CONFIG = require('../src/config');

test('workersFallback: PINs únicos y de 4+ dígitos', () => {
  const pins = CONFIG.workersFallback.map(w => w.pin).filter(Boolean);
  assert.ok(pins.length > 0, 'debe haber trabajadores con PIN');
  assert.equal(new Set(pins).size, pins.length, 'hay PINs duplicados');
  for (const p of pins) {
    assert.match(String(p), /^\d{4,}$/, `PIN inválido: ${p}`);
  }
});

test('workersFallback: cada trabajador tiene id, nombre y coste/hora > 0', () => {
  for (const w of CONFIG.workersFallback) {
    assert.ok(w.id, 'falta id');
    assert.ok(w.name, `falta name en ${w.id}`);
    assert.ok(w.costeHora > 0, `costeHora inválido en ${w.name}`);
  }
});

test('getRateForWorker: usa la tarifa por nombre y cae a costeHora si no existe', () => {
  assert.equal(CONFIG.getRateForWorker({ name: 'Jose Beliard' }), 26.72);
  assert.equal(CONFIG.getRateForWorker({ name: 'Desconocido', costeHora: 15 }), 15);
});

test('tipoJornadaPorFecha: fin de semana = EXTRA, laborable = NORMAL', () => {
  assert.equal(CONFIG.tipoJornadaPorFecha('2026-07-19'), 'EXTRA');  // domingo
  assert.equal(CONFIG.tipoJornadaPorFecha('2026-07-20'), 'NORMAL'); // lunes
});
