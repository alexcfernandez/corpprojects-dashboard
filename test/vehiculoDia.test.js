// Furgoneta del día (4/11/2026): a quién le sale, elegirla, aviso si dos llevan la misma y conductor habitual a los 3 días.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ObjectId } = require('mongodb');
const VD = require('../src/vehiculoDia');

function fakeDB() {
  const cols = {};
  const get = (d, k) => k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), d);
  const ok = (d, q) => Object.entries(q || {}).every(([k, v]) => {
    const x = get(d, k);
    if (v && typeof v === 'object' && !(v instanceof ObjectId) && Object.keys(v).some(c => c[0] === '$'))
      return Object.entries(v).every(([op, w]) => op === '$gte' ? x >= w : op === '$lte' ? x <= w : op === '$lt' ? x < w : op === '$ne' ? x !== w : op === '$in' ? w.includes(x) : true);
    return v instanceof ObjectId ? String(x) === String(v) : x === v;
  });
  const cursor = l => { const c = { sort: s => { const [k, dir] = Object.entries(s)[0]; l = [...l].sort((a, b) => (a[k] > b[k] ? 1 : -1) * dir); return c; }, limit: n => { l = l.slice(0, n); return c; }, project: () => c, toArray: async () => l }; return c; };
  const collection = n => {
    const l = cols[n] = cols[n] || [];
    return {
      _l: l,
      insertOne: async d => { if (l.some(x => x._id === d._id)) { const e = new Error('dup'); e.code = 11000; throw e; } l.push(d); return {}; },
      findOne: async (q) => l.find(d => ok(d, q)) || null,
      find: q => cursor(l.filter(d => ok(d, q))),
      updateOne: async (q, u, o = {}) => { let d = l.find(x => ok(x, q)); if (!d && o.upsert) { d = { _id: q._id }; l.push(d); } if (d) Object.assign(d, u.$set || {}); return { matchedCount: d ? 1 : 0 }; },
    };
  };
  return { collection, cols };
}

const uDavid = new ObjectId(), uJose = new ObjectId(), uDiego = new ObjectId(), uJC = new ObjectId();
const vPartner = new ObjectId(), vBerlingo = new ObjectId();
function base() {
  const db = fakeDB();
  db.collection('users')._l.push(
    { _id: uDavid, name: 'David Taladros', docs: { carnet: 'B 12345' } },
    { _id: uJose, name: 'Jose Beliard', conduce: true, docs: { carnet: '' } },
    { _id: uDiego, name: 'Diego Campillo', docs: { carnet: '' } },
    { _id: uJC, name: 'Juan Carlos', conduce: false, docs: { carnet: 'EE. UU.' } });
  db.collection('vehiculos')._l.push(
    { _id: vPartner, nombre: 'Peugeot Partner', matricula: '1111AAA', plazas: 5, estado: 'activo', conductor: { userId: String(uDavid), name: 'David Taladros' } },
    { _id: vBerlingo, nombre: 'Citroën Berlingo', matricula: '2222BBB', plazas: 2, estado: 'activo', conductor: null });
  return db;
}

test('a quién le sale: carnet o conductor (auto), y lo marcado a mano manda', async () => {
  const db = base();
  assert.strictEqual((await VD.paraTrabajador(String(uDiego), { hoy: '2026-11-04', _db: db })).conduce, false);
  assert.strictEqual((await VD.paraTrabajador(String(uJC), { hoy: '2026-11-04', _db: db })).conduce, false);   // carnet sin validar: marcado «no»
  assert.strictEqual((await VD.paraTrabajador(String(uJose), { hoy: '2026-11-04', _db: db })).conduce, true);
  const d = await VD.paraTrabajador(String(uDavid), { hoy: '2026-11-04', _db: db });
  assert.strictEqual(d.conduce, true);
  assert.strictEqual(d.propuesta, String(vPartner));   // su habitual
  assert.strictEqual(d.elegido, null);
  assert.deepStrictEqual(d.vehiculos.map(v => [v.nombre, v.plazas, v.habitual]), [['Citroën Berlingo', 2, null], ['Peugeot Partner', 5, 'David']]);
  assert.strictEqual(VD.conduce(null), false);
});

test('elegir: se guarda por día, «no conduzco» vale y dos con la misma → un aviso a la oficina', async () => {
  const db = base(); const avisos = [];
  const av = async t => avisos.push(t);
  await VD.elegir({ workerId: String(uDavid), workerName: 'David Taladros' }, String(vPartner), { hoy: '2026-11-04', _db: db, _avisar: av, _asignar: async () => {} });
  let d = await VD.paraTrabajador(String(uDavid), { hoy: '2026-11-04', _db: db });
  assert.deepStrictEqual(d.elegido, { vehiculoId: String(vPartner) });
  const r = await VD.elegir({ workerId: String(uJose), workerName: 'Jose Beliard' }, String(vPartner), { hoy: '2026-11-04', _db: db, _avisar: av, _asignar: async () => {} });
  assert.deepStrictEqual(r.conflicto, ['David']);
  assert.strictEqual(avisos.length, 1);
  assert.match(avisos[0], /Peugeot Partner.*Jose\* y \*David/);
  await VD.elegir({ workerId: String(uJose), workerName: 'Jose Beliard' }, String(vPartner), { hoy: '2026-11-04', _db: db, _avisar: av, _asignar: async () => {} });
  assert.strictEqual(avisos.length, 1);   // el aviso sale una vez
  d = await VD.paraTrabajador(String(uDavid), { hoy: '2026-11-04', _db: db });
  assert.strictEqual(d.vehiculos.find(v => v.id === String(vPartner)).hoyLaLleva, 'Jose');
  const n = await VD.elegir({ workerId: String(uJose), workerName: 'Jose Beliard' }, null, { hoy: '2026-11-04', _db: db, _avisar: av });
  assert.strictEqual(n.vehiculoId, null);
  await assert.rejects(VD.elegir({ workerId: String(uJose), workerName: 'Jose' }, 'xx', { _db: db }), /no válida/);
  await assert.rejects(VD.elegir({ workerId: String(uJose), workerName: 'Jose' }, String(new ObjectId()), { _db: db }), /no está en la lista/);
  // Historial de la ficha y multas: quién la llevó ese día.
  assert.deepStrictEqual((await VD.historial(String(vPartner), { hoy: '2026-11-04', _db: db })).map(x => x.workerName), ['David Taladros']);
  assert.deepStrictEqual((await VD.enFecha(String(vPartner), '2026-11-04', { _db: db })).map(x => x.workerName), ['David Taladros']);
});

test('3 días seguidos con la Berlingo → pasa a ser su conductor y deja la Partner', async () => {
  const db = base(); const asign = [];
  const as = async (vid, c, por) => asign.push([vid, c.userId || null, por]);
  for (const f of ['2026-11-04', '2026-11-05']) {
    const r = await VD.elegir({ workerId: String(uDavid), workerName: 'David Taladros' }, String(vBerlingo), { hoy: f, _db: db, _asignar: as, _avisar: async () => {} });
    assert.strictEqual(r.habitual, false);
  }
  const r = await VD.elegir({ workerId: String(uDavid), workerName: 'David Taladros' }, String(vBerlingo), { hoy: '2026-11-06', _db: db, _asignar: as, _avisar: async () => {} });
  assert.strictEqual(r.habitual, true);
  assert.deepStrictEqual(asign, [[String(vBerlingo), String(uDavid), 'automático'], [String(vPartner), null, 'automático']]);
  // Al día siguiente le propone la que eligió la última vez si ya no es conductor de ninguna.
  db.collection('vehiculos')._l.forEach(v => { v.conductor = null; });
  assert.strictEqual((await VD.paraTrabajador(String(uDavid), { hoy: '2026-11-07', _db: db })).propuesta, String(vBerlingo));
});
