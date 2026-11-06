// Avisos al grupo del cliente cuando el trabajo avanza, con pausa (6/11/2026).
const test = require('node:test');
const assert = require('node:assert');
const { ObjectId } = require('mongodb');
const A = require('../src/avisosCliente');

function fakeDb({ a, p, g, pausa = false }) {
  return { collection: name => ({
    findOne: async () => name === 'workOrderAssignments' ? a : name === 'peticionesGrupo' ? p : name === 'bridgeGrupos' ? g : name === 'config' ? { pausa } : null,
    updateOne: async (q, u) => { if (name === 'workOrderAssignments' && u.$push) (a.avisosCliente = a.avisosCliente || []).push(u.$push.avisosCliente); },
  }) };
}

test('programado y hecho van al grupo del cliente una vez cada uno', async () => {
  const pid = new ObjectId();
  const a = { _id: 1, workOrderId: '9', peticionId: String(pid), userName: 'David Taladros', fecha: '2026-11-09', hora: '09:00', direccion: 'C/ Oviedo 16, 1º 4ª', incidenciaRef: 'INC00662' };
  const db = fakeDb({ a, p: { _id: pid, jid: '1@g.us' }, g: { _id: '1@g.us', activo: true, nombre: 'Madrenas - Corp' } });
  const env = [];
  const enviar = async (to, t) => { env.push([to, t]); return true; };
  const r = await A.paso('9', 'programado', { _db: db, _enviar: enviar });
  assert.ok(r.ok);
  assert.match(env[0][1], /pasa David el lunes 09\/11 a las 09:00/);
  assert.strictEqual((await A.paso('9', 'programado', { _db: db, _enviar: enviar })).no, 'ya avisado');
  await A.paso('9', 'hecho', { _db: db, _enviar: enviar });
  assert.match(env[1][1], /ya está hecho/);
  assert.strictEqual(env.length, 2);
});

test('en pausa (todos o el grupo) o sin grupo no se avisa', async () => {
  const pid = new ObjectId();
  const base = () => ({ _id: 1, workOrderId: '9', peticionId: String(pid), fecha: '2026-11-09' });
  const enviar = async () => { throw new Error('no debería enviar'); };
  assert.strictEqual((await A.paso('9', 'hecho', { _db: fakeDb({ a: base(), p: { _id: pid, jid: '1@g.us' }, g: { activo: true }, pausa: true }), _enviar: enviar })).no, 'en pausa (todos)');
  assert.strictEqual((await A.paso('9', 'hecho', { _db: fakeDb({ a: base(), p: { _id: pid, jid: '1@g.us' }, g: { activo: true, avisosPausa: true } }), _enviar: enviar })).no, 'en pausa (grupo)');
  assert.strictEqual((await A.paso('9', 'hecho', { _db: fakeDb({ a: base(), p: { _id: pid, jid: 'correo:x' }, g: null }), _enviar: enviar })).no, 'no viene de un grupo');
});

test('saca nombre y teléfono del texto de la incidencia', () => {
  assert.strictEqual(A.contactosDe('Si us plau avisar-nos. Llogater - Paco 609 76 89 10. JOAQUIN ROCA PAGES 630981732 40277858M'), 'Paco 609 768 910 · JOAQUIN ROCA PAGES 630 981 732');
});
