// test/pagos-trab.test.js — red de seguridad sobre la lógica pura de pagos.
// Ejecutar con: npm test  (usa el runner nativo de Node, sin dependencias).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  semanaLaboral, labelSemana, offsetSemana, formatInforme, mesNombre,
} = require('../src/pagos-trab');

const dow = iso => new Date(iso + 'T12:00:00Z').getUTCDay(); // 1=Lun .. 5=Vie

test('semanaLaboral: desde siempre es lunes y hasta siempre es viernes', () => {
  for (const base of ['2026-01-07', '2026-06-10', '2026-07-19', '2026-12-31']) {
    const { desde, hasta } = semanaLaboral(base);
    assert.equal(dow(desde), 1, `desde (${desde}) debería ser lunes`);
    assert.equal(dow(hasta), 5, `hasta (${hasta}) debería ser viernes`);
  }
});

test('semanaLaboral: hasta = desde + 4 días', () => {
  const { desde, hasta } = semanaLaboral('2026-06-10');
  const diff = (new Date(hasta) - new Date(desde)) / 86400000;
  assert.equal(diff, 4);
});

test('semanaLaboral: semana conocida (miércoles 2026-01-07)', () => {
  const s = semanaLaboral('2026-01-07');
  assert.equal(s.desde, '2026-01-05'); // lunes
  assert.equal(s.hasta, '2026-01-09'); // viernes
});

test('semanaLaboral: offset -1 retrocede una semana; +1 avanza', () => {
  assert.equal(semanaLaboral('2026-01-07', -1).desde, '2025-12-29');
  assert.equal(semanaLaboral('2026-01-07',  1).desde, '2026-01-12');
});

test('semanaLaboral: el domingo pertenece a la semana que termina, no a la que empieza', () => {
  // 2026-01-04 es domingo → su semana laboral es la anterior (29 dic – 2 ene)
  const s = semanaLaboral('2026-01-04');
  assert.equal(s.desde, '2025-12-29');
  assert.equal(s.hasta, '2026-01-02');
});

test('labelSemana: mismo mes vs meses distintos', () => {
  assert.equal(labelSemana('2026-01-05', '2026-01-09'), '5–9 ene');
  assert.equal(labelSemana('2026-06-29', '2026-07-03'), '29 jun–3 jul');
});

test('offsetSemana: interpreta las pistas habladas', () => {
  assert.equal(offsetSemana('la semana pasada'), -1);
  assert.equal(offsetSemana('anterior'), -1);
  assert.equal(offsetSemana('la que viene'), 1);
  assert.equal(offsetSemana('siguiente'), 1);
  assert.equal(offsetSemana('esta semana'), 0);
  assert.equal(offsetSemana(''), 0);
  assert.equal(offsetSemana(undefined), 0);
});

test('mesNombre: abreviado y completo', () => {
  assert.equal(mesNombre(0), 'ene');
  assert.equal(mesNombre(6, true), 'julio');
  assert.equal(mesNombre(11, true), 'diciembre');
});

test('formatInforme: sin movimientos', () => {
  const out = formatInforme([], { nombre: 'Jose', tituloPeriodo: 'julio' });
  assert.match(out, /No hay movimientos/);
});

test('formatInforme: saldo a favor del trabajador (le debemos)', () => {
  const movs = [
    { fecha: '2026-01-10', tipo: 'semana_trabajada', importe: 500 },
    { fecha: '2026-01-11', tipo: 'pago_semana',      importe: 200 },
  ];
  const out = formatInforme(movs, { nombre: 'Jose', tituloPeriodo: 'enero' });
  assert.match(out, /le debemos/);      // 500 devengado - 200 entregado = 300 a favor
  assert.doesNotMatch(out, /nos debe/);
});

test('formatInforme: trabajador ha cobrado de más (nos debe)', () => {
  const movs = [
    { fecha: '2026-01-10', tipo: 'semana_trabajada', importe: 200 },
    { fecha: '2026-01-11', tipo: 'adelanto',         importe: 500 },
  ];
  const out = formatInforme(movs, { nombre: 'Jose', tituloPeriodo: 'enero' });
  assert.match(out, /nos debe/);        // 200 devengado - 500 entregado = -300
});

test('formatInforme: la devolución reduce lo entregado', () => {
  const movs = [
    { fecha: '2026-01-10', tipo: 'semana_trabajada', importe: 300 },
    { fecha: '2026-01-11', tipo: 'pago_semana',      importe: 300 },
    { fecha: '2026-01-12', tipo: 'devolucion',       importe: 100 },
  ];
  // devengado 300, entregado 300-100=200 → saldo +100 a favor
  const out = formatInforme(movs, { nombre: 'Jose', tituloPeriodo: 'enero' });
  assert.match(out, /le debemos/);
});
