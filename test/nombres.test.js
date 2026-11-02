'use strict';
const test = require('node:test');
const assert = require('node:assert');
const N = require('../src/nombres');

const USERS = [
  { _id: 'd1', name: 'David Taladros', nombreCompleto: 'David Valencia Roca' },
  { _id: 'd2', name: 'Diego Campillo', nombreCompleto: 'Diego Campillo Carbonell' },
  { _id: 'm1', name: 'Manolo', nombreCompleto: 'Manuel Rivero Ramos (Manolo)', active: false },
  { _id: 'j1', name: 'Javier Huaca', nombreCompleto: 'Javier Orlando Huaca Páez' },
  { _id: 'j2', name: 'Javi el largo', active: false },
];
const ALIAS = [{ alias: 'el taladros', workerId: 'd1' }];

test('trabajadores: nombre completo, apodo y nombre de pila sin preguntar si solo hay uno', () => {
  assert.strictEqual(N.casarTrabajador('David Valencia', USERS, ALIAS)._id, 'd1');
  assert.strictEqual(N.casarTrabajador('David', USERS, ALIAS)._id, 'd1');
  assert.strictEqual(N.casarTrabajador('el taladros', USERS, ALIAS)._id, 'd1');
  assert.strictEqual(N.casarTrabajador('Javi', USERS, ALIAS)._id, 'j1');              // «Javi el largo» está de baja
  assert.strictEqual(N.casarTrabajador('Manolo Rivero', USERS, ALIAS), null);         // de baja: solo con inactivos
  assert.strictEqual(N.casarTrabajador('Manolo Rivero', USERS, ALIAS, { inactivos: true })._id, 'm1');
  assert.strictEqual(N.casarTrabajador('Manuel Rivero', USERS, ALIAS, { inactivos: true })._id, 'm1');
});

test('obras: todas las palabras en cualquier orden; si hay varias, la activa', () => {
  const O = [{ _id: 'o1', reference: 'Bar Claudia · Sant Pere Pescador', status: 'activa' }, { _id: 'o2', reference: 'Claudia', clientName: 'CLAUDIA BOSCH DAUNIS', address: 'Calle Santa Eugenia 35', status: 'activa' }];
  assert.strictEqual(N.casarObra('Claudia Bar', O)._id, 'o1');
  assert.strictEqual(N.casarObra('obra de Sant Pere', O)._id, 'o1');
  assert.deepStrictEqual(N.casarObra('Claudia', O).varias.length, 2);
  assert.strictEqual(N.casarObra('farmacia', O), null);
});

test('apuntarJornada: crea la presencia de cada uno y no pisa las horas fichadas', async () => {
  const A = require('../src/attendance');
  const att = [{ workerId: 'd1', date: '2026-11-01', fichado: true, horas: 9.2 }];
  const ok = (d, q) => Object.entries(q).every(([k, v]) => d[k] === v);
  const db = { collection: n => ({
    find: () => ({ project: () => ({ toArray: async () => n === 'obras' ? [{ _id: 'o1', reference: 'Bar Claudia · Sant Pere Pescador', status: 'activa' }] : n === 'users' ? USERS : ALIAS }) }),
    findOne: async q => att.find(d => ok(d, q)) || null,
    updateOne: async (q, u) => { let d = att.find(x => ok(x, q)); if (!d) { d = { ...q, ...u.$setOnInsert }; att.push(d); } Object.assign(d, u.$set); },
  }) };
  const r = await A.apuntarJornada({ trabajadores: ['David Valencia', 'Diego'], obra: 'Claudia Bar', fecha: '2026-11-01', desde: '9:00', hasta: '14:00' }, 'Álex', { _db: db });
  assert.strictEqual(r.obra, 'Bar Claudia · Sant Pere Pescador');
  assert.deepStrictEqual(r.trabajadores.map(t => [t.nombre, t.horas, t.fichadas]), [['David Taladros', 9.2, true], ['Diego Campillo', 5, false]]);
  assert.strictEqual(att.find(d => d.workerId === 'd2').obras[0].obraId, 'o1');
  await assert.rejects(A.apuntarJornada({ trabajadores: ['Pepe'], obra: 'Claudia Bar', horas: 8 }, '', { _db: db }), /no conozco a «Pepe»/);
  await assert.rejects(A.apuntarJornada({ trabajadores: ['Diego'], obra: 'Claudia Bar' }, '', { _db: db }), /Cuántas horas/);
});
