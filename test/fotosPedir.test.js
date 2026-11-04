// Álex le pide fotos a Corpy: «mándame las fotos de Bellpuig 41» (4/11/2026).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ObjectId } = require('mongodb');

// Mongo de mentira: lo justo para estas consultas (igualdad, $in, $lt/$gte, $or, $ne, $exists).
function fakeDB() {
  const cols = {};
  const ok = (d, q) => Object.entries(q || {}).every(([k, v]) => {
    if (k === '$or') return v.some(x => ok(d, x));
    const x = k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), d);
    if (v && typeof v === 'object' && !(v instanceof Date) && Object.keys(v).some(c => c[0] === '$')) {
      return Object.entries(v).every(([op, w]) => op === '$in' ? (Array.isArray(x) ? x.some(y => w.some(z => String(z) === String(y))) : w.some(z => String(z) === String(x))) : op === '$lt' ? x < w : op === '$gte' ? x >= w : op === '$ne' ? x !== w : op === '$exists' ? (x !== undefined) === w : true);
    }
    if (v === null) return x == null;
    return Array.isArray(x) ? x.includes(v) : (v instanceof Date ? +x === +v : (v && v._bsontype === 'ObjectId') ? String(x) === String(v) : x === v);
  });
  const upd = (d, u) => {
    for (const [k, v] of Object.entries(u.$set || {})) d[k] = v;
    for (const k of Object.keys(u.$unset || {})) delete d[k];
    for (const [k, v] of Object.entries(u.$addToSet || {})) { d[k] = d[k] || []; for (const y of (v && v.$each) || [v]) if (!d[k].includes(y)) d[k].push(y); }
    for (const [k, v] of Object.entries(u.$push || {})) { d[k] = d[k] || []; d[k].push(...((v && v.$each) || [v])); }
  };
  const cursor = l => { const c = { sort: () => c, limit: n => { l = l.slice(0, n); return c; }, project: () => c, toArray: async () => l }; return c; };
  const collection = n => {
    const l = cols[n] = cols[n] || [];
    return {
      insertOne: async d => { if (d._id == null) d._id = new ObjectId(); l.push(d); return { insertedId: d._id }; },
      findOne: async q => l.find(d => ok(d, q)) || null,
      find: q => cursor(l.filter(d => ok(d, q))),
      updateOne: async (q, u, o = {}) => { let d = l.find(x => ok(x, q)); if (!d && o.upsert) { d = { _id: q._id }; l.push(d); } if (d) upd(d, u); return { matchedCount: d ? 1 : 0 }; },
      replaceOne: async (q, doc) => { const i = l.findIndex(x => ok(x, q)); if (i >= 0) l[i] = doc; else l.push(doc); return {}; },
      deleteOne: async q => { const i = l.findIndex(x => ok(x, q)); if (i >= 0) l.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; },
      countDocuments: async q => l.filter(d => ok(d, q)).length,
    };
  };
  return { collection, cols };
}

const F = require('../src/fotosPedir');
const img = s => Buffer.from(s);

function datos() {
  const db = fakeDB();
  const obra = new ObjectId(), otra = new ObjectId();
  db.cols.obras = [{ _id: obra, reference: 'Bellpuig 41', clientName: 'CP Bellpuig 41', status: 'activa' }, { _id: otra, reference: 'Can Bells 20', status: 'activa' }];
  const dVis = new ObjectId(), dFicha = new ObjectId(), vf = new ObjectId(), gObra = new ObjectId(), gPet = new ObjectId(), gOp = new ObjectId(), gOtra = new ObjectId();
  db.cols.docsPersonal = [
    { _id: dVis, ambito: 'obra', obraId: String(obra), tipo: 'fotos_obra', fecha: '2026-11-03', mime: 'image/jpeg', data: img('visita') },
    { _id: dFicha, ambito: 'obra', obraId: String(obra), tipo: 'fotos_obra', fecha: '2026-10-20', mime: 'image/jpeg', data: img('ficha') },
  ];
  db.cols.visitas = [
    { _id: new ObjectId(), fecha: '2026-11-03', sitio: 'Bellpuig 41', obraId: String(obra), fotos: [String(dVis)] },
    { _id: new ObjectId(), fecha: '2026-11-04', sitio: 'Remences 9', cliente: 'CP Remences 9', obraId: null, fotos: [String(vf)] },
  ];
  db.cols.visitaFotos = [{ _id: vf, data: img('remences'), mimetype: 'image/jpeg' }];
  db.cols.grupoFotos = [
    { _id: gObra, obraId: String(obra), quien: 'Javi', mimetype: 'image/jpeg', ts: new Date('2026-11-01T10:00:00Z'), data: img('g1') },
    { _id: gPet, obraId: null, quien: 'Marta', mimetype: 'image/jpeg', ts: new Date('2026-11-02T10:00:00Z'), data: img('g2') },
    { _id: gOp, obraId: null, quien: 'David', mimetype: 'image/jpeg', ts: new Date('2026-11-04T09:00:00Z'), data: img('g3') },
    { _id: gOtra, obraId: String(otra), quien: 'X', mimetype: 'image/jpeg', ts: new Date('2026-11-04T09:00:00Z'), data: img('no') },
  ];
  db.cols.peticionesGrupo = [{ _id: new ObjectId(), direccion: 'C/ Bellpuig 41, 3º 1ª', cliente: 'CP Bellpuig 41', fotoIds: [String(gPet)], creado: new Date() }];
  db.cols.workOrderAssignments = [{ _id: new ObjectId(), obraId: null, cliente: 'CP Bellpuig 41', fotosOperario: [String(gOp)] }];
  return db;
}

test('pasar_fotos: junta visita, ficha de la obra, grupo, petición y operario; las más nuevas primero; nada de otra obra', async () => {
  const db = datos(); const env = [];
  const r = await F.pasar({ sitio: 'Bellpuig 41' }, '34600', { _db: db, _enviar: async (to, pie, a) => { env.push({ to, pie, d: a.data.toString() }); return true; } });
  assert.deepStrictEqual(env.map(e => e.d), ['g3', 'visita', 'g2', 'g1', 'ficha']);
  assert.match(env[0].pie, /Bellpuig 41 · operario \(David\) 04\/11 \(1\/5\)/);
  assert.match(env[1].pie, /visita 03\/11/);
  assert.match(r.reply, /Te mando 5 fotos de \*Bellpuig 41\*\./);
});

test('pasar_fotos: por día, sin obra (visita en visitaFotos), y sin fotos', async () => {
  const db = datos(); const env = [];
  const enviar = async (to, pie, a) => { env.push(a.data.toString()); return true; };
  let r = await F.pasar({ sitio: 'Bellpuig 41', fecha: '2026-11-03' }, '34600', { _db: db, _enviar: enviar });
  assert.deepStrictEqual(env, ['visita']); assert.match(r.reply, /la foto de \*Bellpuig 41\* del 03\/11/);
  env.length = 0;
  r = await F.pasar({ sitio: 'Remences 9' }, '34600', { _db: db, _enviar: enviar });
  assert.deepStrictEqual(env, ['remences']);
  r = await F.pasar({ sitio: 'Sant Joan 3' }, '34600', { _db: db, _enviar: enviar });
  assert.match(r.reply, /No tengo fotos de \*Sant Joan 3\*/);
  r = await F.pasar({ sitio: '' }, '34600', { _db: db, _enviar: enviar });
  assert.ok(r.aclara);
});

test('pasar_fotos: más de 10 → las 10 más nuevas y dice cuántas quedan', async () => {
  const db = datos();
  for (let i = 0; i < 12; i++) db.cols.docsPersonal.push({ _id: new ObjectId(), ambito: 'obra', obraId: String(db.cols.obras[0]._id), tipo: 'fotos_obra', fecha: `2026-09-${String(i + 1).padStart(2, '0')}`, mime: 'image/jpeg', data: img('x' + i) });
  let n = 0;
  const r = await F.pasar({ sitio: 'Bellpuig 41' }, '34600', { _db: db, _enviar: async () => { n++; return true; } });
  assert.strictEqual(n, 10); assert.match(r.reply, /Hay 7 más/);
});

test('pasar_fotos: si no se puede mandar por WhatsApp, lo dice', async () => {
  const r = await F.pasar({ sitio: 'Bellpuig 41' }, '34600', { _db: datos(), _enviar: async () => false });
  assert.match(r.reply, /Tengo 5 fotos de \*Bellpuig 41\*, pero ahora no te las puedo mandar/);
});
