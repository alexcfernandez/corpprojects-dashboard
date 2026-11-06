// Vigilar la respuesta de un trámite (permisos de la grúa, 6/11/2026).
const test = require('node:test');
const assert = require('node:assert');
const T = require('../src/tramitesVigilar');

test('sentido: concedido, denegado, requerimiento y sin saber', () => {
  assert.strictEqual(T.sentido("Resolució: s'autoritza la reserva d'espai per a camió grua"), 'concedido');
  assert.strictEqual(T.sentido('Se le concede la ocupación de la vía pública'), 'concedido');
  assert.strictEqual(T.sentido("No s'autoritza l'ocupació sol·licitada"), 'denegado');
  assert.strictEqual(T.sentido('Es denega la sol·licitud'), 'denegado');
  assert.strictEqual(T.sentido("Requeriment d'esmena: manca el plànol"), 'requerimiento');
  // El acuse habla de «la vigència de l'autorització municipal» y no es una concesión.
  assert.strictEqual(T.sentido("retirar la senyalització quan s'acabi la vigència de l'autorització municipal"), 'sin saber');
});

test('esDe: por nº de registro o por todas sus palabras', () => {
  const t = { registros: ['2026119826'], palabras: ['creu', 'reserva'] };
  assert.ok(T.esDe(t, 'Expedient 2026119826'));
  assert.ok(T.esDe(t, "Reserva d'espai al carrer de la Creu 42"));
  assert.ok(!T.esDe(t, "Reserva d'espai al carrer de Cartagena"));
});

test('vigilar: ignora el acuse y avisa de la resolución una sola vez', async () => {
  const docs = [{ _id: 1, titulo: 'Grúa Creu 42', registros: ['2026119826'], palabras: [], estado: 'esperando', avisados: [] }];
  const db = { collection: () => ({ find: () => ({ toArray: async () => docs.filter(d => d.estado === 'esperando') }), updateOne: async (q, u) => { const d = docs[0]; if (u.$push && u.$push.avisados) d.avisados.push(u.$push.avisados); if (u.$set) Object.assign(d, u.$set); } }) };
  const msgs = {
    a: { s: 'Sol.licitud enregistrada - Núm. 2026119826', b: "vigència de l'autorització municipal" },
    b: { s: 'Notificació expedient 2026119826', b: "<p>S'autoritza la reserva d'espai</p>" },
  };
  const gmail = { users: { messages: {
    list: async () => ({ data: { messages: [{ id: 'a' }, { id: 'b' }] } }),
    get: async ({ id }) => ({ data: { internalDate: '1793000000000', snippet: msgs[id].b, payload: { headers: [{ name: 'Subject', value: msgs[id].s }, { name: 'From', value: 'no-respongueu@aoc.cat' }], mimeType: 'text/html', body: { data: Buffer.from(msgs[id].b).toString('base64') } } } }),
  } } };
  const enviados = [];
  const r = await T.vigilar({ _gmail: gmail, _db: db, _enviar: async (to, txt) => enviados.push(txt) });
  assert.strictEqual(r.avisos.length, 1);
  assert.strictEqual(r.avisos[0].sentido, 'concedido');
  assert.ok(enviados.length >= 1 && /CONCEDIDO/.test(enviados[0]));
  assert.deepStrictEqual([...new Set(docs[0].avisados)].sort(), ['a', 'b']);
  assert.strictEqual(docs[0].estado, 'concedido');
});
