// test/programados.test.js — envíos programados: solo los que tocan, una sola vez, y si falla se avisa al dueño.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ObjectId } = require('mongodb');
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const UJ = new ObjectId(), UK = new ObjectId();
const cols = { users: [{ _id: UJ, name: 'Judit' }, { _id: UK, name: 'Kate', whatsapp: '+34 632 09 51 08' }], enviosProgramados: [] };
const cumple = (d, q) => Object.entries(q).every(([k, v]) => v && typeof v === 'object' && !(v instanceof ObjectId) ? (('$lte' in v ? d[k] <= v.$lte : true) && ('$in' in v ? v.$in.includes(d[k]) : true)) : String(d[k]) === String(v));
stub('src/db.js', { getDB: async () => ({ collection: n => ({
  insertOne: async d => { const _id = new ObjectId(); cols[n].push({ _id, ...d }); return { insertedId: _id }; },
  findOne: async q => cols[n].find(d => cumple(d, q)) || null,
  findOneAndUpdate: async (q, u, o) => { const l = cols[n].filter(d => cumple(d, q)).sort((a, b) => a.at - b.at); if (!l[0]) return null; Object.assign(l[0], u.$set); return l[0]; },
  updateOne: async (q, u) => { const d = cols[n].find(x => cumple(x, q)); if (d) Object.assign(d, u.$set); },
  find: q => ({ sort() { return this; }, limit() { return this; }, toArray: async () => cols[n].filter(d => cumple(d, q)) }),
}) }) });
const P = require(path.join(root, 'src/programados.js'));

test('manda a su hora (borrador, WhatsApp a móvil y al dueño), no antes ni dos veces; sin móvil avisa al dueño', async () => {
  const t7 = new Date('2026-10-13T05:00:00Z'), t830 = new Date('2026-10-13T06:30:00Z');
  await P.crear({ at: t7, tipo: 'borrador', msgId: '1a1321afea111da4', nota: 'Eduard' });
  await P.crear({ at: t830, tipo: 'whatsapp', a: 'dueno', texto: 'Recordatorio' });
  await P.crear({ at: t830, tipo: 'whatsapp', userId: String(UK), nombre: 'Kate', texto: 'Trae el teléfono' });
  await P.crear({ at: t830, tipo: 'whatsapp', userId: String(UJ), nombre: 'Judit', texto: 'Lista' });
  await assert.rejects(P.crear({ at: 'mañana', tipo: 'whatsapp', a: 'dueno', texto: 'x' }), /no válidas/);
  const borr = [], wa = [], dueno = [];
  const deps = { _enviarBorrador: async id => { borr.push(id); return { enviado: 'm1' }; }, _enviarWA: async (a, t) => { wa.push([a, t]); return true; }, _enviarDueno: async t => { dueno.push(t); return true; } };
  assert.equal((await P.tick({ ahora: new Date('2026-10-13T04:59:00Z'), ...deps })).enviados, 0);
  assert.equal((await P.tick({ ahora: t7, ...deps })).enviados, 1); assert.deepEqual(borr, ['1a1321afea111da4']);
  assert.equal((await P.tick({ ahora: t7, ...deps })).enviados, 0);
  assert.equal((await P.tick({ ahora: t830, ...deps })).enviados, 2);
  assert.deepEqual(wa, [['+34632095108', 'Trae el teléfono']]);
  assert.equal(dueno[0], 'Recordatorio'); assert.match(dueno[1], /No he podido enviar el WhatsApp programado a Judit: Judit no tiene móvil/);
  assert.equal(cols.enviosProgramados.filter(x => x.estado === 'error').length, 1);
});
