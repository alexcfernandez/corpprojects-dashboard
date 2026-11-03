// Citas de cualquier grupo de Corpy → agenda, una vez (3/11/2026).
const test = require('node:test');
const assert = require('node:assert');
const CG = require('../src/citasGrupos');

const dia = n => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
function fakeDb(grupos, msgs) {
  const citas = [];
  return { citas, grupos, collection: n => ({
    find: q => ({ toArray: async () => n === 'bridgeGrupos' ? grupos.filter(g => g.activo && g.peticiones !== true) : [], sort: () => ({ limit: () => ({ toArray: async () =>
      n === 'grupoMensajes' ? msgs.filter(m => m.jid === q.jid && (q.ts.$gt ? m.ts > q.ts.$gt : m.ts <= q.ts.$lte)) : [] }) }) }),
    findOne: async q => citas.find(c => c._id === q._id) || null,
    insertOne: async d => citas.push(d),
    updateOne: async (q, u) => { const g = grupos.find(x => x._id === q._id); Object.assign(g, u.$set); },
  }) };
}

test('lee los grupos sin peticiones, apunta la cita una vez y avisa', async () => {
  const hace = new Date(Date.now() - 20 * 60000);
  const grupos = [{ _id: 'g1', nombre: 'Reparaciones David Valencia', activo: true }, { _id: 'g2', nombre: 'Projects', activo: true, peticiones: true }];
  const msgs = [{ jid: 'g1', ts: hace, quien: 'Alfonso', texto: 'Mañana a las 10 vamos a Sobrequés 5 con la Nuria' }];
  const db = fakeDb(grupos, msgs); const creadas = [], avisos = []; let prompts = 0;
  const _llamar = async () => { prompts++; return { citas: [{ fecha: dia(1), hora: '10:00', sitio: 'Santiago Sobrequés 5', con: 'Nuria', quien_va: 'Alfonso', que: 'Mirar filtraciones' }, { fecha: dia(-2), sitio: 'Pasada', que: 'x' }] }; };
  const _crear = async e => { creadas.push(e); return 'ev' + creadas.length; };
  const r = await CG.revisar({ _db: db, _llamar, _crear, _enviar: async t => avisos.push(t) });
  assert.deepStrictEqual(r, [{ grupo: 'Reparaciones David Valencia', citas: 1 }]);
  assert.strictEqual(prompts, 1);                                   // el grupo con peticiones lo lleva peticionesGrupo
  assert.deepStrictEqual([creadas[0].date, creadas[0].hora, creadas[0].titulo], [dia(1), '10:00', 'Mirar filtraciones · Santiago Sobrequés 5 · Nuria']);
  assert.match(avisos[0], /Cita del grupo «Reparaciones David Valencia»[\s\S]*10:00\* · Mirar filtraciones · Santiago Sobrequés 5 \(con Nuria\) — va Alfonso/);
  assert.ok(grupos[0].citasHasta);
  // La misma cita otra vez (otro mensaje que la repite) no se duplica.
  msgs.push({ jid: 'g1', ts: new Date(Date.now() - 15 * 60000), quien: 'Judit', texto: 'Recordad lo de mañana a las 10 en Sobrequés' });
  await CG.revisar({ _db: db, _llamar, _crear, _enviar: async t => avisos.push(t) });
  assert.strictEqual(creadas.length, 1); assert.strictEqual(avisos.length, 1);
});

test('si siguen escribiendo, espera', async () => {
  const grupos = [{ _id: 'g1', nombre: 'G', activo: true }];
  const db = fakeDb(grupos, [{ jid: 'g1', ts: new Date(), quien: 'A', texto: 'el jueves a las 9 en Canaders' }]);
  let llamado = false;
  await CG.revisar({ _db: db, _llamar: async () => { llamado = true; return { citas: [] }; } });
  assert.strictEqual(llamado, false);
});
