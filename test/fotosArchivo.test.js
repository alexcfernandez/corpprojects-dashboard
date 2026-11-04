// Las fotos que Álex manda a Corpy se archivan: en un sitio o como ticket de un pago con tarjeta (4/11/2026).
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


const FA = require('../src/fotosArchivo');
const F = require('../src/fotosPedir');
const foto = s => ({ data: Buffer.from(s).toString('base64'), media_type: 'image/jpeg' });
const ALEX = '+34648536489';
function conDB(db) { const dbm = require('../src/db'); const real = dbm.getDB; dbm.getDB = async () => db; return () => { dbm.getDB = real; }; }

test('archivar en un sitio sin obra: queda en sitioFotos con su cliente y pasar_fotos la encuentra', async () => {
  const db = fakeDB(); db.cols.obras = [];
  FA._pendientes.clear(); FA.guardarPendientes(ALEX, [foto('bajante')]);
  const r = await FA.archivar({ destino: 'sitio', sitio: 'Santa Eugenia 57', nota: 'Tubo bajante para cambiar' }, ALEX, { _db: db, _cliente: async () => ({ id: '9', name: 'CP Santa Eugenia 57' }) });
  assert.match(r.reply, /1 foto guardada en \*CP Santa Eugenia 57\*/);
  assert.strictEqual(db.cols.sitioFotos.length, 1); assert.strictEqual(db.cols.sitioFotos[0].clienteId, '9');
  assert.strictEqual(FA.hay(ALEX), 0);
  const env = [];
  const p = await F.pasar({ sitio: 'Santa Eugenia 57' }, ALEX, { _db: db, _enviar: async (to, pie, a) => { env.push([pie, a.data.toString()]); return true; } });
  assert.strictEqual(env[0][1], 'bajante'); assert.match(env[0][0], /archivada por ti/); assert.match(p.reply, /la foto/);
});

test('archivar en una obra: va a «Fotos de la obra»; sin fotos pide que las mande; sin sitio pregunta y las guarda', async () => {
  const db = fakeDB(); const obra = new ObjectId();
  db.cols.obras = [{ _id: obra, reference: 'Bellpuig 41', status: 'activa' }];
  const subidas = [];
  FA._pendientes.clear(); FA.guardarPendientes(ALEX, [foto('a'), foto('b')]);
  let r = await FA.archivar({ destino: 'sitio', sitio: 'Bellpuig 41' }, ALEX, { _db: db, _subir: async (d) => { subidas.push(d); return { id: String(subidas.length) }; } });
  assert.strictEqual(subidas.length, 2); assert.strictEqual(subidas[0].obraId, String(obra)); assert.strictEqual(subidas[0].tipo, 'fotos_obra');
  assert.match(r.reply, /2 fotos guardadas en la obra \*Bellpuig 41\*/);
  r = await FA.archivar({ destino: 'sitio', sitio: 'Bellpuig 41' }, ALEX, { _db: db });
  assert.ok(r.aclara); assert.match(r.reply, /No tengo fotos/);
  FA.guardarPendientes(ALEX, [foto('c')]);
  r = await FA.archivar({ destino: 'sitio' }, ALEX, { _db: db });
  assert.ok(r.aclara); assert.strictEqual(FA.hay(ALEX), 1);
  FA._pendientes.clear();
});

test('ticket: un solo pago de Álex sin ticket → compra creada y unida al pago; varios → pregunta cuál y guarda las fotos', async () => {
  const pagos = [{ id: 'm1', tel: ALEX, comercio: 'TQ Mate', importe: -45.6, fecha: '2026-11-04', userId: 'u1' }, { id: 'm2', tel: '+34600000000', comercio: 'Obramat', importe: -20, fecha: '2026-11-04' }];
  const creadas = [], unidas = [];
  FA._pendientes.clear(); FA.guardarPendientes(ALEX, [foto('recibo')]);
  let r = await FA.archivar({ destino: 'ticket' }, ALEX, { _pendientes: async () => pagos, _crear: async d => { creadas.push(d); return { id: 'c1' }; }, _alSubir: async (m, c) => unidas.push([m, c]) });
  assert.match(r.reply, /Guardado el ticket de \*TQ Mate\* · 45,60 €/);
  assert.strictEqual(creadas[0].fotos[0].data.toString(), 'recibo'); assert.deepStrictEqual(unidas, [['m1', 'c1']]);
  const dos = [...pagos, { id: 'm3', tel: ALEX, comercio: 'Gasolinera', importe: -60, fecha: '2026-11-03' }];
  FA.guardarPendientes(ALEX, [foto('otro')]);
  r = await FA.archivar({ destino: 'ticket' }, ALEX, { _pendientes: async () => dos, _crear: async () => { throw new Error('no'); } });
  assert.ok(r.aclara); assert.match(r.reply, /1\. \*TQ Mate\*[\s\S]*2\. \*Gasolinera\*/); assert.strictEqual(FA.hay(ALEX), 1);
  r = await FA.archivar({ destino: 'ticket', comercio: 'gasolinera' }, ALEX, { _pendientes: async () => dos, _crear: async () => ({ id: 'c2' }), _alSubir: async (m, c) => unidas.push([m, c]) });
  assert.match(r.reply, /Gasolinera/); assert.deepStrictEqual(unidas[1], ['m3', 'c2']);
  r = await FA.aTicket(ALEX, [foto('x')], { _pendientes: async () => [] });
  assert.ok(r.aclara); assert.match(r.reply, /No tengo ningún pago/);
});

test('apuntar_pendiente con sitio: guarda el pendiente y archiva allí las fotos; las que llegan después van al mismo sitio', async () => {
  const db = fakeDB(); db.cols.obras = []; const fin = conDB(db);
  const stel = require('../src/stelorder'); const real = stel.getClients;
  stel.getClients = async () => ({ clientMap: { 9: { name: 'CP Santa Eugenia 57', address: 'C/ Santa Eugenia 57' }, 10: { name: 'CP Santa Eugenia 12' } } });
  try {
    FA._pendientes.clear(); FA._ultimo.clear(); FA.guardarPendientes(ALEX, [foto('bajante')]);
    const r = await require('../src/agenteExtra').ejecutar('apuntar_pendiente', { texto: 'Tubo bajante de Santa Eugenia 57 pendiente para cambiar', sitio: 'Santa Eugenia 57' }, ALEX);
    assert.match(r.reply, /📌 Apuntado/); assert.match(r.reply, /La foto, guardada en \*CP Santa Eugenia 57\*/);
    assert.strictEqual(db.cols.pendientes.length, 1); assert.strictEqual(db.cols.sitioFotos.length, 1);
    assert.strictEqual(FA.reciente(ALEX).sitio, 'Santa Eugenia 57');
  } finally { stel.getClients = real; fin(); }
});
