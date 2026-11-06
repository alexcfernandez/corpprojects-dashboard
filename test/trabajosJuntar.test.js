// Lo pendiente de la misma comunidad va en el mismo parte (Joan Maragall 44-46, 6/11/2026).
const test = require('node:test');
const assert = require('node:assert');
const { ObjectId } = require('mongodb');
const J = require('../src/trabajosJuntar');

function fakeDb({ pets, asig }) {
  const sets = [];
  const col = name => ({
    findOne: async q => name === 'peticionesGrupo' ? pets.find(p => String(p._id) === String(q._id)) || null : null,
    find: q => ({ sort: () => ({ toArray: async () => pets.filter(p => p.clienteId === q.clienteId && p.estado === 'pendiente' && p.tipo === 'trabajo' && !(p.pedido && p.pedido.id) && !p.hechoEnChat && !q._id.$nin.some(x => String(x) === String(p._id))) }) }),
    updateOne: async (q, u) => { sets.push([name, u]); if (name === 'workOrderAssignments') Object.assign(asig, u.$set); },
    updateMany: async (q, u) => { sets.push([name, u]); for (const p of pets) if (q._id.$in.some(x => String(x) === String(p._id)) && u.$set) Object.assign(p, u.$set); },
  });
  return { db: { collection: col }, sets };
}

test('cuelga la 6ª planta del trabajo de la 5ª y no repite la segunda vez', async () => {
  const id5 = new ObjectId(), id6 = new ObjectId(), id53 = new ObjectId();
  const pets = [
    { _id: id5, clienteId: '12043713', estado: 'pendiente', tipo: 'trabajo', pedido: { id: '62172447' }, fecha: new Date() },
    { _id: id6, clienteId: '12043713', estado: 'pendiente', tipo: 'trabajo', incidencia: 'INC00656', direccion: '6ª planta', queHacer: 'Revisar la luz del rellano', fecha: new Date() },
    { _id: id53, clienteId: '12043713', estado: 'pendiente', tipo: 'trabajo', hechoEnChat: true, fecha: new Date() },   // ya resuelta en el chat
  ];
  const asig = { _id: 1, workOrderId: '62172447', pedidoRef: 'PDT00560', userId: 'u1', userName: 'David Taladros', peticionId: String(id5) };
  const { db } = fakeDb({ pets, asig });
  const llamadas = [];
  const stel = { lineasMismaComunidad: async (id, extras) => { llamadas.push([id, extras.map(e => e.incidencia)]); return { ok: true }; } };
  const r = await J.juntar(asig, { _db: db, _stel: stel });
  assert.strictEqual(r.nuevos.length, 1);
  assert.deepStrictEqual(llamadas, [['62172447', ['INC00656']]]);   // la línea al pedido de StelOrder
  assert.deepStrictEqual(asig.extrasStel, [String(id6)]);
  assert.strictEqual(r.extras[0].incidencia, 'INC00656');
  assert.strictEqual(pets[1].juntoA.pedidoRef, 'PDT00560');
  assert.match(J.textoExtras(r.extras), /6ª planta: Revisar la luz del rellano \(INC00656\)/);
  const r2 = await J.juntar(asig, { _db: db, _stel: stel });
  assert.strictEqual(r2.nuevos.length, 0);
  assert.strictEqual(llamadas.length, 1);   // ya está en StelOrder: no se vuelve a escribir
});

test('un trabajo hecho o en observación no junta nada', async () => {
  const { db } = fakeDb({ pets: [], asig: {} });
  assert.strictEqual((await J.juntar({ peticionId: 'x', status: 'done' }, { _db: db })).nuevos.length, 0);
  assert.strictEqual((await J.juntar({ peticionId: 'x', observacion: {} }, { _db: db })).nuevos.length, 0);
});

test('el PDF del pedido lleva lo de la misma comunidad', async () => {
  const T = require('../src/trabajos');
  const buf = await T.pdfPedido({ ref: 'PDT00560', incidencia: 'INC00659', cliente: 'Ctat. Prop. Joan Maragall 44-46', p: { resumen: 'Luz de la 5ª parpadea' }, operario: 'David', extras: [{ incidencia: 'INC00656', direccion: '6ª planta', que: 'Revisar la luz del rellano' }] });
  const raw = require('zlib').inflateSync(buf.subarray(buf.indexOf('stream') + 7)).toString('latin1');
  const txt = [...raw.matchAll(/<([0-9A-F]+)> Tj/g)].map(m => Buffer.from(m[1], 'hex').toString('latin1')).join('\n');
  assert.match(txt, /6ª planta: Revisar la luz del rellano \(INC00656\)/);
  assert.match(txt, /misma visita/);
});
