// corpySocio.js — Corpy como asistente de Alfonso (4/11/2026). IA, programados y calendario simulados.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/corpySocio');

const trab = { userId: '6adfdc959be87b1205a0c76e', name: 'Alfonso' };
const prog = () => { const l = []; return { l, crear: async (d, por) => { l.push({ ...d, por }); return { ok: true }; }, lista: async () => l.map(x => ({ ...x, estado: 'pendiente' })) }; };
const ia = resp => async () => resp;
const manana = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });

test('«yo» es Alfonso y siempre va él', () => {
  assert.deepStrictEqual(S._quienes(['yo']), ['Alfonso']);
  assert.deepStrictEqual(S._quienes([]), ['Alfonso']);
  assert.deepStrictEqual(S._quienes(['Álex']), ['Alfonso', 'Álex']);
});

test('hora de Madrid a UTC (invierno +1, verano +2)', () => {
  assert.strictEqual(S._aDate('2026-11-04', '09:30').toISOString(), '2026-11-04T08:30:00.000Z');
  assert.strictEqual(S._aDate('2026-07-04', '09:30').toISOString(), '2026-07-04T07:30:00.000Z');
});

test('recordatorio → WhatsApp programado a Alfonso a esa hora', async () => {
  const P = prog();
  const r = await S.intentar({ texto: 'recuérdame mañana a las 9 llamar a Madrenas', from: '34600', trab, _prog: P, _contexto: '', _memoria: '',
    _llamar: ia({ tipo: 'tool', name: 'recordatorio', input: { fecha: manana, hora: '9:00', texto: 'Llamar a Madrenas' } }) });
  assert.match(r, /te lo recuerdo/);
  assert.strictEqual(P.l.length, 1);
  assert.strictEqual(P.l[0].userId, trab.userId);
  assert.match(P.l[0].texto, /Llamar a Madrenas/);
});

test('cita → calendario con «Alfonso:» y aviso una hora antes', async () => {
  const P = prog(); const cal = []; 
  const r = await S.intentar({ texto: 'apunta mañana a las 10 visita Bellpuig', from: '34601', trab, _prog: P, _contexto: '', _memoria: '',
    _cal: { crearEventoPersonal: async e => { cal.push(e); return 'x'; } },
    _llamar: ia({ tipo: 'tool', name: 'crear_cita', input: { fecha: manana, hora: '10:00', titulo: 'Visita Bellpuig 41' } }) });
  assert.match(r, /Apuntada en el calendario/);
  assert.strictEqual(cal[0].titulo, 'Alfonso: Visita Bellpuig 41');
  assert.strictEqual(P.l[0].at.toISOString(), new Date(S._aDate(manana, '10:00').getTime() - 3600000).toISOString());
});

test('lo que no es suyo (NO_ES_MIO) sigue el camino de siempre', async () => {
  const r = await S.intentar({ texto: 'el PRT00880 está aceptado', from: '34602', trab, _contexto: '', _memoria: '', _llamar: ia({ tipo: 'texto', texto: 'NO_ES_MIO' }) });
  assert.strictEqual(r, null);
});

test('se apaga con CORPY_SOCIO=off', async () => {
  process.env.CORPY_SOCIO = 'off';
  try { assert.strictEqual(await S.intentar({ texto: 'hola', from: '1', trab, _llamar: ia({ tipo: 'texto', texto: 'x' }) }), null); }
  finally { delete process.env.CORPY_SOCIO; }
});
