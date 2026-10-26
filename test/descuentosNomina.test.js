'use strict';
const test = require('node:test');
const assert = require('node:assert');
const D = require('../src/descuentosNomina');
function fakeDb() {
  const l = []; let n = 0;
  const val = (d, k) => k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), d);
  const ok = (d, q) => Object.entries(q).every(([k, v]) => {
    const x = val(d, k);
    if (v && typeof v === 'object' && '$ne' in v) return x !== v.$ne;
    if (v && typeof v === 'object' && '$in' in v) return v.$in.map(String).includes(String(x));
    return String(x) === String(v);
  });
  return { l, collection: () => ({
    findOne: async q => l.find(d => ok(d, q)) || null,
    insertOne: async d => { d._id = d._id || ('a'.repeat(23) + (++n)).slice(-24); l.push(d); return { insertedId: d._id }; },
    find: q => ({ sort: () => ({ toArray: async () => l.filter(d => ok(d, q)) }) }),
    updateMany: async (q, u) => { const m = l.filter(d => ok(d, q)); m.forEach(d => Object.assign(d, u.$set)); return { modifiedCount: m.length }; },
  }) };
}
const JC = '6abf89d4f19733a7e9c1083d', DAV = '6a1c9b470faa632f1f00029f';

test('una compra por líneas: la descarga se le descuenta a Juan Carlos, una sola vez aunque se confirme dos veces', async () => {
  const db = fakeDb();
  const c = { _id: 'c1', proveedor: 'Saltoki', numero: '913.775', fecha: '2026-10-09', lineas: [
    { descripcion: 'MECANISMO UNIVERSAL DESCARGA SIMPLE', importe: 22.82, para: { t: 'descontar', workerId: JC, workerName: 'Juan Carlos' } },
    { descripcion: 'BASE ENCHUFE 2P+TT', importe: 39.96, para: { t: 'obra', obraId: 'x' } } ] };
  await D.desdeCompra(c, 'Álex', { _db: db });
  await D.desdeCompra(c, 'Álex', { _db: db });
  const p = await D.pendientes({ _db: db });
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].nombre, 'Juan Carlos');
  assert.strictEqual(p[0].total, 22.82);
  assert.match(p[0].lineas[0].concepto, /DESCARGA.*Saltoki nº 913\.775/);
});

test('las botas de David por Corpy, y al marcarlo descontado ya no sale', async () => {
  const db = fakeDb();
  await D.apuntar({ userId: DAV, nombre: 'David Taladros', concepto: 'Botas', importe: '45,50', origen: { tipo: 'corpy' } }, 'Álex', { _db: db });
  await assert.rejects(D.apuntar({ userId: DAV, concepto: 'Nada', importe: 0 }, '', { _db: db }), /importe/);
  assert.strictEqual((await D.pendientes({ _db: db }))[0].total, 45.5);
  const r = await D.marcarDescontado({ userId: DAV, mes: '2026-10' }, 'Álex', { _db: db });
  assert.strictEqual(r.descontados, 1);
  assert.strictEqual((await D.pendientes({ _db: db })).length, 0);
  assert.strictEqual(db.l[0].mes, '2026-10');
});

