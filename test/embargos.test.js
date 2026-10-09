// test/embargos.test.js — Embargos de sueldo: retenido en nóminas (sin repetidas) + a mano, pagado por banco o a mano.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const settings = [];
const noms = [
  { _id: 'a1', userId: '6a1c99b00faa632f1f00029a', tipo: 'nomina', mes: '2026-08', subido: '2026-10-07T21:01:32Z', importes: { liquido: 1800, bruto: 2425.94, embargo: 0 } },
  { _id: 'a2', userId: '6a1c99b00faa632f1f00029a', tipo: 'nomina', mes: '2026-08', subido: '2026-10-07T21:01:47Z', importes: { liquido: 1626.3, bruto: 2425.94, embargo: 173.7 } },
  { _id: 's1', userId: '6a1c99b00faa632f1f00029a', tipo: 'nomina', mes: '2026-09', subido: '2026-10-07T21:02:13Z', importes: { liquido: 1626.3, bruto: 2424.92, embargo: 173.7 } },
  { _id: 'o1', userId: '6a1c99b00faa632f1f00029a', tipo: 'nomina', mes: '2026-10', subido: '2026-11-01', importes: { liquido: 1626.3, bruto: 2424.92 } },
];
let movs = [];
const cumple = (d, q) => Object.entries(q).every(([k, c]) => { const v = d[k]; if (c && typeof c === 'object') { if ('$gte' in c && !(v >= c.$gte)) return false; if ('$lt' in c && !(v < c.$lt)) return false; if ('$regex' in c && !new RegExp(c.$regex, c.$options).test(v || '')) return false; return true; } return v === c; });
stub('src/db.js', { getDB: async () => ({ collection: n => ({
  findOne: async q => settings.find(s => s.key === q.key) || null,
  updateOne: async (q, u) => { let d = settings.find(s => s.key === q.key); if (!d) { d = { key: q.key, ...(u.$setOnInsert || {}) }; settings.push(d); } Object.assign(d, u.$set || {}); },
  find: q => { const L = (n === 'docsPersonal' ? noms : movs).filter(d => cumple(d, q)); return { project: () => ({ toArray: async () => L }), toArray: async () => L }; },
}) }) });
const E = require(path.join(root, 'src/embargos.js'));

test('Beliard: lo retenido cuenta una vez por mes; el pago apuntado se casa con el del banco', async () => {
  let b = (await E.estado()).find(e => e.id === 'beliard-arenys');
  assert.equal(b.retenido, 347.4); assert.equal(b.pendiente, 347.4); assert.equal(b.sinLeer, 1); assert.equal(b.vence, '2026-11-05');
  await E.apuntarPago('beliard-arenys', { importe: '347,40', fecha: '2026-10-10' }, 'Álex');
  b = (await E.estado()).find(e => e.id === 'beliard-arenys');
  assert.equal(b.pagado, 347.4); assert.equal(b.pendiente, 0); assert.equal(b.quedaTotal, 11511.66);
  movs = [{ fechaOperacion: '2026-10-12', importe: -347.4, concepto: "TRANSFERENCIA A FAVOR DE Servei Comu d'Execucio d'Arenys CONCEPTO 4933000005085911" }];
  b = (await E.estado()).find(e => e.id === 'beliard-arenys');
  assert.equal(b.pagado, 347.4); assert.equal(b.pagos.length, 1); assert.ok(b.pagos[0].banco);
});
test('Javier Viñas: el finiquito retenido sale pendiente en Reservas; David Valencia no', async () => {
  const r = await E.paraReservas();
  const j = r.find(i => i.clave === 'emb:vinas-aeat');
  assert.equal(j.importe, 160.02); assert.match(j.detalle, /192621739003N/);
  assert.ok(!r.some(i => i.clave === 'emb:valencia-aeat'));
});
