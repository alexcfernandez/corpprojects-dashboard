// test/absentismes.test.js — La respuesta de absentismes a la gestoría sale de la presencia.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const P = [
  { nombre: 'David Valencia', laborables: 20, trabajados: 15, sinApuntar: 0, fechasSinApuntar: [], fechasFaltas: ['2026-08-03', '2026-08-04'], fechasBaja: ['2026-08-05', '2026-08-06', '2026-08-07'], fechasVacaciones: [] },
  { nombre: 'Diego Campillo', laborables: 20, trabajados: 18, sinApuntar: 1, fechasSinApuntar: ['2026-08-21'], fechasFaltas: ['2026-08-19'], fechasBaja: [], fechasVacaciones: [] },
  { nombre: 'Abdellah Souiri', laborables: 20, trabajados: 20, sinApuntar: 0, fechasSinApuntar: [], fechasFaltas: [], fechasBaja: [], fechasVacaciones: [] },
];
stub('src/agente.js', { _consultarPresencia: async () => ({ resumenPorPersona: P }) });
let borrador = null, wa = null;
stub('src/gmailBorrador.js', { crear: async o => { borrador = o; return { url: 'https://mail/x' }; } });
stub('src/notifications.js', { sendWhatsApp: async t => { wa = t; } });
const A = require(path.join(root, 'src/absentismes.js'));

test('reconoce la petición de Eduard y no las respuestas', () => {
  assert.equal(A.esPeticion({ de: '<eduard@somassessors.com>', asunto: "absentismes mes d'Agost" }), true);
  assert.equal(A.esPeticion({ de: '<eduard@somassessors.com>', asunto: 'nòmines', cuerpo: "necessito saber els dies d’absentisme dels treballadors" }), true);
  assert.equal(A.esPeticion({ de: '<eduard@somassessors.com>', asunto: "RE: absentismes mes d'Agost" }), false);
  assert.equal(A.esPeticion({ de: 'otro@x.com', asunto: 'absentismes' }), false);
  assert.equal(A.mesDe(new Date('2026-09-23T10:00:00Z')), '2026-09'); assert.equal(A.mesDe(new Date('2026-10-03T10:00:00Z')), '2026-09');
});
test('borrador en catalán en el hilo, con faltas y baja agrupadas; aviso con los días sin apuntar', async () => {
  const r = await A.preparar({ mes: '2026-08', threadId: 't1', messageId: '<m1>', asunto: "absentismes mes d'Agost" });
  assert.equal(borrador.threadId, 't1'); assert.equal(borrador.inReplyTo, '<m1>'); assert.match(borrador.asunto, /^Re: absentismes/);
  assert.match(r.texto, /David Valencia: 2 dies de falta \(del 3\/8 al 4\/8\); baixa del 5\/8 al 7\/8/);
  assert.match(r.texto, /Diego Campillo: 1 dia de falta \(19\/8\)/); assert.doesNotMatch(r.texto, /Abdellah/);
  assert.match(wa, /sin nada apuntado[\s\S]*Diego Campillo: 21\/8/);
});
