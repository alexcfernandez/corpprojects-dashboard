// test/agente-presencia.test.js — Lo que lee Corpy para contestar preguntas de presencia y horas.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const AT = [
  { date: '2026-10-08', workerId: 'd', workerName: 'David Taladros', estado: 'obra', horas: 8, clientName: 'Simón bombi', obras: [{ clientName: 'Simón bombi', horas: 8 }] },
  { date: '2026-10-09', workerId: 'd', workerName: 'David Taladros', estado: 'obra', horas: 4, clientName: 'Simón bombi', obras: [{ clientName: 'Simón bombi', horas: 4 }] },
  { date: '2026-10-09', workerId: 'j', workerName: 'Javier Huaca', estado: 'vacaciones', horas: 0 },
];
stub('src/attendance.js', { getAttendance: async ({ from, to }) => AT.filter(e => e.date >= from && e.date <= to), extremosPorTrabajador: async () => new Map([['d', { primero: '2026-09-01', ultimo: '2026-10-09' }], ['j', { primero: '2026-10-09', ultimo: '2026-10-09' }], ['m', { primero: '2026-10-01', ultimo: '2026-10-07' }]]) });
stub('src/festivos.js', { lista: async () => ({ '2026-10-12': 'Hispanitat' }) });
stub('src/users.js', { getUsers: async () => [{ _id: 'd', name: 'David Taladros', role: 'tecnico' }, { _id: 'j', name: 'Javier Huaca', role: 'tecnico' }, { _id: 'm', name: 'Manolo', role: 'tecnico' }], normalizeRole: r => r });
const A = require(path.join(root, 'src/agente.js'));

test('horas de David esta semana, por obra, y quién no tiene nada apuntado', async () => {
  const r = await A._consultarPresencia({ desde: '2026-10-05', hasta: '2026-10-09', trabajador: 'david' });
  assert.equal(r.porPersona[0].horas, 12); assert.equal(r.porObra[0].nombre, 'Simón bombi');
  const t = await A._consultarPresencia({ desde: '2026-10-09', hasta: '2026-10-09' });
  assert.deepEqual(t.resumenPorPersona.find(p => p.nombre === 'Manolo').fechasSinApuntar, ['2026-10-09']);
  // «¿Cuántos días faltó David este mes?»: 05/10 al 09/10 sin nada el 5, 6 y 7 (empezó en septiembre) → 3 sin apuntar
  const d = (await A._consultarPresencia({ desde: '2026-10-01', hasta: '2026-10-09', trabajador: 'David' })).resumenPorPersona[0];
  assert.equal(d.trabajados, 2); assert.equal(d.laborables, 7); assert.equal(d.sinApuntar, 5);
  // Javier empezó el 09/10: no cuenta lo de antes
  const j = (await A._consultarPresencia({ desde: '2026-10-01', hasta: '2026-10-09', trabajador: 'Javier' })).resumenPorPersona[0];
  assert.equal(j.laborables, 1); assert.equal(j.vacaciones, 1); assert.equal(j.sinApuntar, 0);
  const v = await A._consultarPresencia({ desde: '2026-10-01', hasta: '2026-10-31', estado: 'vacaciones' });
  assert.equal(v.porPersona.length, 1); assert.equal(v.porPersona[0].nombre, 'Javier Huaca'); assert.equal(v.porPersona[0].horas, 0);
});
