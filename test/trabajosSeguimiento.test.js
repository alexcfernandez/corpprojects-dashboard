// Seguimiento de trabajos por el grupo del operario (2/11/2026): recordatorios y lo que contesta David.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
// Sin base de datos ni enlaces reales.
require.cache[path.resolve(__dirname, '../src/fichajeAvisos.js')] = { exports: { enlacePersonal: async () => 'https://x/fichar?t=1' } };
const TS = require('../src/trabajosSeguimiento');

const UID = '6a1c9b470faa632f1f00029f';
function fakeDb(asig, partes = []) {
  const col = n => ({
    find: () => { const l = n === 'workOrderAssignments' ? asig : n === 'partes' ? partes : []; const c = { project: () => c, toArray: async () => l }; return c; },
    findOne: async () => n === 'bridgeGrupos' ? { _id: '1203@g.us', nombre: 'Reparaciones David Valencia', trabajosDe: UID, activo: true } : n === 'users' ? { name: 'David Taladros' } : null,
    updateOne: async () => ({}),
  });
  return { collection: col };
}
const hoy = '2026-11-03';
const base = { userId: UID, userName: 'David Taladros', peticionId: 'x', assignedAt: new Date(Date.now() - 2 * 86400000) };

test('por la mañana: hoy toca, sin día todavía y falta el parte, al grupo del operario', async () => {
  const enviados = [];
  const r = await TS.seguimiento({ momento: 'manana', hoy, _db: fakeDb([
    { ...base, workOrderId: '1', pedidoRef: 'PDT00900', cliente: 'Ctat. Solterra 14', fecha: hoy, hora: '10:00', contacto: 'Albert 600 000 000' },
    { ...base, workOrderId: '2', pedidoRef: 'PDT00901', cliente: 'Illa Verda Bellpuig 41', resumen: 'Gotera en el 3r 1a', fecha: null },
    { ...base, workOrderId: '3', pedidoRef: 'PDT00902', cliente: 'Girona per Girona 9', fecha: '2026-11-02' },
  ]), _enviar: async (to, t) => { enviados.push({ to, t }); return true; } });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(enviados[0].to, '1203@g.us');
  assert.match(enviados[0].t, /Hoy:\*[\s\S]*Solterra 14\* a las 10:00/);
  assert.match(enviados[0].t, /Sin día todavía[\s\S]*Illa Verda Bellpuig 41\*: Gotera en el 3r 1a \(hace 2 días\)/);
  assert.match(enviados[0].t, /Falta el parte[\s\S]*Girona per Girona 9\* \(fuiste el lunes 02\/11\)/);
});

test('con el parte hecho ya no se le recuerda', async () => {
  const enviados = [];
  await TS.seguimiento({ momento: 'manana', hoy, _db: fakeDb([{ ...base, workOrderId: '3', pedidoRef: 'PDT00902', cliente: 'Girona per Girona 9', fecha: '2026-11-02' }], [{ workOrderId: '3' }]), _enviar: async (to, t) => { enviados.push(t); return true; } });
  assert.strictEqual(enviados.length, 0);
});

test('por la tarde solo lo de mañana', async () => {
  const enviados = [];
  await TS.seguimiento({ momento: 'tarde', hoy, _db: fakeDb([
    { ...base, workOrderId: '1', pedidoRef: 'PDT00900', cliente: 'Solterra 14', fecha: '2026-11-04', hora: '09:00' },
    { ...base, workOrderId: '2', pedidoRef: 'PDT00901', cliente: 'Bellpuig 41', fecha: null },
  ]), _enviar: async (to, t) => { enviados.push(t); return true; } });
  assert.match(enviados[0], /Mañana\* \(miércoles 04\/11\)[\s\S]*Solterra 14\* a las 09:00/);
  assert.doesNotMatch(enviados[0], /Bellpuig/);
});

test('en su grupo solo cuenta lo que escribe el operario de ese grupo', async () => {
  const r = await TS.respuestaGrupo({ g: { _id: '1203@g.us', trabajosDe: UID }, quien: { userId: 'otro', name: 'Álex' }, texto: 'el jueves' });
  assert.strictEqual(r, null);
});
