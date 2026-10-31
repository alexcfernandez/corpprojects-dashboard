'use strict';
const test = require('node:test');
const assert = require('node:assert');
const A = require('../src/adelantos');
function fakeDb() {
  const l = []; let n = 0;
  const ok = (d, q) => Object.entries(q).every(([k, v]) => v === null ? d[k] == null : String(d[k]) === String(v));
  const col = {
    findOne: async q => l.find(d => ok(d, q)) || null,
    insertOne: async d => { d._id = d._id || ('b'.repeat(23) + (++n)).slice(-24); l.push(d); return { insertedId: d._id }; },
    find: q => ({ toArray: async () => l.filter(d => ok(d, q)) }),
    updateOne: async (q, u) => { const d = l.find(x => ok(x, q)); if (d) Object.assign(d, u.$set); return { matchedCount: d ? 1 : 0 }; },
  };
  return { l, collection: () => col };
}
const U = [
  { _id: 'a00000000000000000000001', name: 'Melvin Ramirez' }, { _id: 'a00000000000000000000002', name: 'Ramon Dominguez' },
  { _id: 'a00000000000000000000003', name: 'Diego Campillo' }, { _id: 'a00000000000000000000004', name: 'David Taladros' },
  { _id: 'a00000000000000000000005', name: 'Alfonso' },
];
const mov = (id, fecha, importe, concepto) => ({ _id: id, fechaOperacion: fecha, importe, concepto });
const MEDIODIA = new Date('2026-10-31T11:00:00Z');

test('clasificar: lo claro se confirma solo; lo que va a otra cuenta o sin concepto se pregunta; facturas y SPASS fuera', () => {
  const c = m => A.clasificar(m, U);
  const a = c(mov('m1', '2026-10-08', -300, 'TRANSFERENCIA INMEDIATA A FAVOR DE DIEGO CAMPILLO CARBONELL CONCEPTO Adelanto nómina'));
  assert.deepStrictEqual([a.seguro, a.tipo, a.mes, a.nombre], [true, 'adelanto', '2026-10', 'Diego Campillo']);
  const n = c(mov('m2', '2026-10-01', -887.95, 'TRANSFERENCIA INMEDIATA A FAVOR DE Ramon dominguez CONCEPTO Nómina septiembre'));
  assert.deepStrictEqual([n.seguro, n.tipo, n.mes], [true, 'nomina', '2026-09']);
  const o = c(mov('m3', '2026-10-19', -250, 'TRANSFERENCIA INMEDIATA A FAVOR DE Maria dolores buenavida garcia CONCEPTO Melvin adelanto'));
  assert.deepStrictEqual([o.seguro, o.nombre, o.cuentaAjena, o.cuentaDe], [false, 'Melvin Ramirez', true, 'Maria dolores buenavida garcia']);
  const r = c(mov('m4', '2026-10-24', -72, 'TRANSFERENCIA INMEDIATA A FAVOR DE Ramon dominguez CONCEPTO Melvin'));
  assert.deepStrictEqual([r.seguro, r.nombre], [false, 'Melvin Ramirez']);           // el concepto manda sobre la cuenta
  assert.strictEqual(c(mov('m5', '2026-10-30', -100, 'TRANSFERENCIA A FAVOR DE David Valencia CONCEPTO Adelanto nómina')).seguro, false);   // fin de mes: ¿de cuál?
  assert.strictEqual(c(mov('m6', '2026-10-13', -42.35, 'TRANSFERENCIA INMEDIATA A FAVOR DE SPASS Group CONCEPTO Formació treballador Melvin Santiago Ramirez Contreras')), null);
  assert.strictEqual(c(mov('m7', '2026-10-22', -2000, 'TRANSFERENCIA INMEDIATA A FAVOR DE Jamal CONCEPTO Compra furgoneta peugeot 2624CMV')), null);
  assert.strictEqual(c(mov('m8', '2026-10-05', -500, 'TRANSFERENCIA INMEDIATA A FAVOR DE ALFONSO GALVEZ CONCEPTO Nómina')).tipo, 'socio');
  assert.strictEqual(c(mov('m9', '2026-10-05', 300, 'TRANSFERENCIA DE DIEGO')), null);   // cobros no
  assert.strictEqual(c(mov('m10', '2026-10-22', -70, 'TRANSFERENCIA A FAVOR DE David Valencia CONCEPTO Compra material placaandreu')).tipo, 'gasto');
});

test('banco → pregunta a Álex → «2 Ramón» lo apunta como adelanto de Ramón y pasa a la siguiente; sin repetir movimientos', async () => {
  const db = fakeDb();
  const movs = [
    mov('m1', '2026-10-08', -300, 'TRANSFERENCIA INMEDIATA A FAVOR DE DIEGO CAMPILLO CARBONELL CONCEPTO Adelanto nómina'),
    mov('m3', '2026-10-19', -250, 'TRANSFERENCIA INMEDIATA A FAVOR DE Maria dolores buenavida garcia CONCEPTO Melvin adelanto'),
    mov('m4', '2026-10-24', -72, 'TRANSFERENCIA INMEDIATA A FAVOR DE Ramon dominguez CONCEPTO Melvin'),
  ];
  const r1 = await A.desdeBanco(null, { _db: db, _users: U, movs });
  assert.deepStrictEqual([r1.nuevos, r1.preguntar], [3, 2]);
  assert.strictEqual((await A.desdeBanco(null, { _db: db, _users: U, movs })).nuevos, 0);
  const enviados = [];
  const p = await A.siguientePregunta({ _db: db, _enviar: async t => { enviados.push(t); return true; }, ahora: MEDIODIA });
  assert.ok(p.enviado && /250,00 €/.test(enviados[0]) && /Maria dolores/.test(enviados[0]) && /la cuenta no es de Melvin/.test(enviados[0]));
  // Mientras no conteste, no se manda otra.
  assert.strictEqual((await A.siguientePregunta({ _db: db, _enviar: async () => true, ahora: MEDIODIA })).esperando, true);
  assert.strictEqual(await A.responder('hola qué tal', { _db: db, _users: U, ahora: MEDIODIA }), null);
  const res = await A.responder('2 Ramon', { _db: db, _users: U, ahora: MEDIODIA });
  assert.match(res, /Adelanto de nómina\* de \*Ramon Dominguez\* \(octubre\)/);
  assert.match(res, /72,00 €/);                                    // la siguiente pregunta va en la misma respuesta
  const d = db.l.find(x => x.movId === 'm3');
  assert.deepStrictEqual([d.estado, d.tipo, d.userId, d.cuentaDe], ['confirmado', 'adelanto', 'a00000000000000000000002', 'Maria dolores buenavida garcia']);
  const res2 = await A.responder('4', { _db: db, _users: U, ahora: new Date(MEDIODIA.getTime() + 1000) });
  assert.match(res2, /Sábado o día extra\* de \*Melvin Ramirez\*/);
  assert.match(res2, /No queda ningún pago por aclarar/);
  const m = await A.resumenMes('2026-10', { _db: db });
  assert.deepStrictEqual(m.trabajadores.map(t => [t.nombre, t.cobrado]), [['Diego Campillo', 300], ['Melvin Ramirez', 72], ['Ramon Dominguez', 250]]);
});

test('responder: «1 noviembre» cambia el mes, «luego» lo aplaza, y de noche no se pregunta', async () => {
  const db = fakeDb();
  await A.desdeBanco(null, { _db: db, _users: U, movs: [mov('m5', '2026-10-30', -100, 'TRANSFERENCIA A FAVOR DE David Valencia CONCEPTO Adelanto nómina')] });
  assert.strictEqual((await A.siguientePregunta({ _db: db, _enviar: async () => true, ahora: new Date('2026-10-31T23:30:00Z') })).deNoche, true);
  await A.siguientePregunta({ _db: db, _enviar: async () => true, ahora: MEDIODIA });
  assert.match(await A.responder('luego', { _db: db, _users: U, ahora: MEDIODIA }), /mañana/);
  assert.strictEqual((await A.siguientePregunta({ _db: db, _enviar: async () => true, ahora: MEDIODIA })).aplazados, true);
  const mañana = new Date(MEDIODIA.getTime() + 21 * 3600 * 1000);
  await A.siguientePregunta({ _db: db, _enviar: async () => true, ahora: mañana });
  assert.match(await A.responder('1 noviembre', { _db: db, _users: U, ahora: mañana }), /de \*David Taladros\* \(noviembre\)/);
  assert.strictEqual(db.l[0].mes, '2026-11');
});

test('grupo y Corpy: «adelanto de 50 a Diego» queda por confirmar y se junta con el banco cuando sale; el efectivo se confirma', async () => {
  const db = fakeDb();
  const g = await A.desdeGrupo({ texto: 'Le he pasado un adelanto de 50€ a Diego', quien: 'Alfonso', grupo: 'Corp equipo' }, { _db: db, _users: U });
  assert.deepStrictEqual([g.estado, g.donde, g.quien, g.importe], ['por_confirmar', 'grupo:Corp equipo', 'Alfonso', 50]);
  const r = await A.desdeBanco(null, { _db: db, _users: U, movs: [mov('m9', g.fecha, -50, 'TRANSFERENCIA INMEDIATA A FAVOR DE DIEGO CAMPILLO CARBONELL CONCEPTO Pago')] });
  assert.strictEqual(r.juntados, 1);
  assert.strictEqual(db.l.length, 1);
  assert.deepStrictEqual([db.l[0].estado, db.l[0].movId, db.l[0].cuentaDe], ['confirmado', 'm9', 'DIEGO CAMPILLO CARBONELL']);
  const e = await A.desdeGrupo({ texto: 'adelanto 20 euros a Diego en efectivo', quien: 'Alfonso', grupo: 'Corp equipo' }, { _db: db, _users: U });
  assert.deepStrictEqual([e.estado, e.medio], ['confirmado', 'efectivo']);
  assert.strictEqual(await A.desdeGrupo({ texto: 'mañana vamos a la obra de Diego', quien: 'Alfonso' }, { _db: db, _users: U }), null);
  const csv = await A.csvMes(g.fecha.slice(0, 7), { _db: db });
  assert.match(csv, /Diego Campillo;50;Adelanto de nómina;banco;DIEGO CAMPILLO CARBONELL;Pago;Alfonso;grupo:Corp equipo \+ banco/);
});
