// test/sitios-dia.test.js — Trabajo por partes: la respuesta por WhatsApp a «¿dónde habéis estado hoy?»
// rellena la Presencia del que pregunta y de quien fue con él, sin pisar lo que haya puesto oficina.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');

const HOY = require(path.join(root, 'src/fichajeMarcas.js')).fechaHoy();
const DAVID = 'd'.repeat(24), JC = 'j'.repeat(24), RAMON = 'r'.repeat(24);
let att, preg, updates;
function reset() {
  preg = { _id: 'p1', workerId: DAVID, fecha: HOY, estado: 'enviada', partes: [{ nombre: 'Creu 2' }] };
  att = {
    [DAVID]: { _id: 'a1', workerId: DAVID, date: HOY, horas: 8, estado: 'obra', clientName: 'De partes', obras: [], dePartes: true, autoFromFichaje: true, equipo: [{ id: JC, nombre: 'Juan Carlos' }, { id: RAMON, nombre: 'Ramón' }] },
    [JC]: { _id: 'a2', workerId: JC, date: HOY, horas: 7, estado: 'obra', clientName: 'De partes', obras: [], dePartes: true, autoFromFichaje: true, autoFromEquipo: DAVID },
    [RAMON]: { _id: 'a3', workerId: RAMON, date: HOY, horas: 8, estado: 'obra', clientName: 'Montseny 2', obras: [{ obraId: 'o3', clientName: 'Montseny 2', horas: 8 }] },   // puesta por oficina
  };
  updates = [];
}
const cur = arr => { const c = { project: () => c, sort: () => c, limit: () => c, toArray: async () => arr }; return c; };
const db = { collection: n => ({
  findOne: async q => n === 'preguntasSitios' ? preg : n === 'attendance' ? (att[q.workerId] || null) : null,
  find: () => cur([]),
  updateOne: async (q, u) => { updates.push({ n, q, u }); if (n === 'attendance') { const id = q.workerId || Object.values(att).find(a => a._id === q._id)?.workerId; Object.assign(att[id] = att[id] || {}, u.$set); } if (n === 'preguntasSitios') Object.assign(preg, u.$set); },
}) };
const dbPath = require.resolve(path.join(root, 'src/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDB: async () => db } };
const obPath = require.resolve(path.join(root, 'src/obras.js'));
require.cache[obPath] = { id: obPath, filename: obPath, loaded: true, exports: { getSelector: async () => [
  { id: 'o1', reference: 'Creu 2', address: 'C/ Creu 2' }, { id: 'o2', reference: 'Pacheco 17', address: 'C/ Pacheco 17' }, { id: 'o3', reference: 'Montseny 2' },
] } };
const S = require(path.join(root, 'src/sitiosDia.js'));

test('horas: las dichas se respetan y el resto del día se reparte', () => {
  const r = S.repartirHoras([{ nombre: 'A', horas: 4 }, { nombre: 'B' }, { nombre: 'C' }], 8);
  assert.deepEqual(r.map(x => x.horas), [4, 2, 2]);
  assert.deepEqual(S.repartirHoras([{ nombre: 'A' }, { nombre: 'B' }, { nombre: 'C' }], 8).map(x => x.horas), [2.5, 2.5, 2.5]);
});

test('la respuesta rellena a David y a Juan Carlos; a Ramón (puesto por oficina) solo se le anota', async () => {
  reset();
  const ia = async () => ({ esRespuesta: true, sitios: [{ obraId: 'o1', nombre: 'creu', horas: 4 }, { obraId: 'o2', nombre: 'pacheco', horas: null }, { obraId: null, nombre: 'Casa de la señora Pilar', horas: null }] });
  const txt = await S.responder(DAVID, 'David Valencia', 'Creu 2 por la mañana, luego Pacheco y casa de la señora Pilar', { _leerIA: ia });
  assert.match(txt, /Apuntado para ti y Juan Carlos/);
  assert.match(txt, /No tengo como obra: Casa de la señora Pilar/);
  assert.match(txt, /A Ramón ya le había puesto la obra la oficina/);
  assert.deepEqual(att[DAVID].obras.map(o => [o.clientName, o.horas]), [['Creu 2', 4], ['Pacheco 17', 2], ['Casa de la señora Pilar', 2]]);
  assert.deepEqual(att[JC].obras.map(o => o.horas), [4, 1.5, 1.5]);           // con sus 7 h
  assert.equal(att[JC].sitiosPor, 'David Valencia');
  assert.equal(att[RAMON].obras[0].clientName, 'Montseny 2');                 // no se pisa
  assert.ok(att[RAMON].sitiosDichos);
  assert.equal(preg.estado, 'respondida');
});

test('un mensaje que no es la respuesta sigue el flujo normal', async () => {
  reset();
  const r = await S.responder(DAVID, 'David', 'Mañana llego un poco más tarde', { _leerIA: async () => ({ esRespuesta: false, sitios: [] }) });
  assert.equal(r, null);
  assert.equal(updates.length, 0);
});

test('texto de la pregunta con compañeros y partes', () => {
  const t = S.textoPregunta('David Valencia', [{ nombre: 'Juan Carlos Pérez' }], [{ nombre: 'Creu 2' }, { nombre: 'Pacheco 17' }]);
  assert.match(t, /David, ¿dónde habéis estado hoy \(tú y Juan Carlos\)\?/);
  assert.match(t, /Tengo los partes de: Creu 2, Pacheco 17/);
});
