// Una cita fijada en el grupo va a la agenda una vez (3/11/2026: Santiago Sobrequés 5, nadie fue a la cita).
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/peticionesGrupo');

const db = { sets: [], collection: () => ({ updateOne: async (q, u) => db.sets.push(u.$set) }) };
const manana = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });

test('cita futura → calendario una vez; pasada o repetida → nada', async () => {
  const creadas = []; const _crear = async e => { creadas.push(e); return 'ev1'; };
  const p = { _id: 'x', cliente: 'Santiago Sobrequés 5', direccion: '6º 3a', contacto: 'Nuria 666 020 704', resumen: 'Filtraciones', grupo: 'Projects', cita: { fecha: manana, hora: '10:00' } };
  assert.ok(await P._citaAlCalendario(db, p, null, { _crear }));
  assert.strictEqual(creadas[0].titulo, 'Visita Santiago Sobrequés 5 6º 3a · Nuria 666 020 704');
  assert.deepStrictEqual([creadas[0].date, creadas[0].hora], [manana, '10:00']);
  assert.strictEqual(p.citaNueva, true);
  assert.strictEqual(await P._citaAlCalendario(db, p, { fecha: manana, hora: '10:00' }, { _crear }), null);
  assert.strictEqual(await P._citaAlCalendario(db, { ...p, citaCal: null, cita: { fecha: '2026-10-28', hora: null } }, null, { _crear }), null);
  assert.strictEqual(creadas.length, 1);
});
