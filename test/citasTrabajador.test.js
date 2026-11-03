// citasTrabajador.js — citas que dicen los trabajadores (4/11/2026). IA, calendario, envíos y BD simulados.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/citasTrabajador');

const manana = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
const dbFalsa = () => { const docs = new Map(); return { collection: () => ({ findOne: async q => docs.get(q._id) || null, insertOne: async d => { docs.set(d._id, d); return { insertedId: d._id }; } }) }; };
const prog = () => { const l = []; return { l, crear: async d => { l.push(d); return { ok: true }; } }; };

test('filtro: solo lo que parece una cita va a la IA', () => {
  assert.ok(C.pareceCita('mañana a las 10 tengo visita en Major 75'));
  assert.ok(C.pareceCita('el jueves paso por Sobrequés'));
  assert.ok(!C.pareceCita('ya he subido el ticket de Obramat'));
  assert.ok(!C.pareceCita('mañana llego tarde'));
});

test('mensaje de David con cita → calendario, aviso a Álex y a él una hora antes', async () => {
  const P = prog(), cal = [], alex = [];
  const r = await C.deMensaje({ userId: '6a1c9b470faa632f1f00029f', nombre: 'David Taladros', texto: 'mañana a las 10 tengo visita en Major 75 con el presidente' }, {
    _db: dbFalsa(), _prog: P, _enviar: async t => { alex.push(t); return true; },
    _crear: async e => { cal.push(e); return 'ev1'; },
    _llamar: async () => ({ citas: [{ fecha: manana, hora: '10:00', sitio: 'Major 75', con: 'el presidente', quien_va: 'David', que: 'visita filtraciones' }] }) });
  assert.match(r, /Apuntado en el calendario/);
  assert.match(cal[0].titulo, /^David: visita filtraciones · Major 75/);
  // mañana: la víspera (hoy a las 19:00) puede haber pasado ya; el de 1 h antes siempre
  assert.ok(P.l.some(x => /hoy a las 10:00/.test(x.texto)));
  assert.match(alex[0], /\*David\* le ha dicho a Corpy que tiene cita/);
});

test('sin cita (la IA no saca nada) → null y no se apunta nada', async () => {
  const P = prog();
  const r = await C.deMensaje({ userId: 'x', nombre: 'Diego', texto: 'el lunes voy a pedir el material a las 8' }, { _db: dbFalsa(), _prog: P, _llamar: async () => ({ citas: [] }), _crear: async () => 'x', _enviar: async () => true });
  assert.strictEqual(r, null); assert.strictEqual(P.l.length, 0);
});

test('cita de grupo: avisa a cada uno de los que van; un nombre repetido no se adivina', async () => {
  const P = prog();
  const us = [{ _id: 'a', name: 'David Taladros', telefono: '600' }, { _id: 'b', name: 'Diego Campillo', telefono: '601' },
    { _id: 'c', name: 'Javier Huaca', telefono: '602' }, { _id: 'd', name: 'Javier Viñas', telefono: '603' }, { _id: 'e', name: 'Jose Beliard', telefono: '604', avisosWa: 'ninguno' }];
  const av = await C.avisarQuienVa({ fecha: manana, hora: '09:00', quienVa: 'David, Diego, Javier y Jose', que: 'visita', sitio: 'Sobrequés 5' }, { _prog: P, _usuarios: us });
  assert.deepStrictEqual(av.sort(), ['David', 'Diego']);
  assert.ok(P.l.length >= 2);
});

test('cita a 3 días: aviso la víspera a las 19:00 con lo que hay que hacer, y 1 h antes', async () => {
  const P = prog();
  const f = new Date(Date.now() + 3 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
  await C.avisarQuienVa({ fecha: f, hora: '09:00', quienVa: 'David', que: 'mirar desagüe', sitio: 'Sobrequés 5' }, { _prog: P, _usuarios: [{ _id: 'a', name: 'David Taladros', telefono: '600' }] });
  assert.strictEqual(P.l.length, 2);
  assert.match(P.l[0].texto, /para \*mañana\*: \*a las 09:00\* · mirar desagüe · Sobrequés 5/);
  assert.match(P.l[1].texto, /hoy a las 09:00/);
});
