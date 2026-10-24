'use strict';
const test = require('node:test');
const assert = require('node:assert');
const F = require('../src/facturarAparte');
// Base de datos de mentira con lo justo (find por igualdad / $in / $exists, updateMany $set).
function fakeDb(docs) {
  const ok = (d, q) => Object.entries(q).every(([k, v]) => {
    if (v && typeof v === 'object' && '$exists' in v) return (d[k] !== undefined) === v.$exists;
    if (v && typeof v === 'object' && '$in' in v) return v.$in.some(x => String(x) === String(d[k]));
    return d[k] === v;
  });
  return { collection: () => ({
    find: q => ({ toArray: async () => docs.filter(d => ok(d, q)) }),
    updateMany: async (q, u) => { docs.filter(d => ok(d, q)).forEach(d => Object.assign(d, u.$set)); return {}; },
  }) };
}
test('un sábado marcado sale con todos los que estuvieron en esa obra, y se cierra al facturarlo', async () => {
  const docs = [
    { _id: 'a', date: '2026-10-24', workerName: 'Jose', facturarAparte: true, obras: [{ obraId: 'inss', clientName: 'INSS Girona (Seranco)', horas: 8 }] },
    { _id: 'b', date: '2026-10-24', workerName: 'Melvin', obras: [{ obraId: 'inss', clientName: 'INSS Girona (Seranco)', horas: 7.5 }] },
    { _id: 'c', date: '2026-10-24', workerName: 'David', obras: [{ obraId: 'otra', clientName: 'Remences 9', horas: 8 }] },
  ];
  const db = fakeDb(docs);
  const l = await F.pendientes({ _db: db });
  assert.strictEqual(l.length, 1);
  assert.deepStrictEqual(l[0].personas.map(p => p.nombre), ['Jose', 'Melvin']);
  assert.strictEqual(l[0].horas, 15.5);
  await F.marcarFacturado({ fecha: '2026-10-24', obraId: 'inss' }, 'Álex', { _db: db });
  assert.strictEqual((await F.pendientes({ _db: db })).length, 0);
});
