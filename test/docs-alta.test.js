// test/docs-alta.test.js — Corpy pide los documentos del alta, revisa cada foto y avisa cuando está todo.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ObjectId } = require('mongodb');
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const UID = new ObjectId();
const cols = { users: [{ _id: UID, name: 'Manolo García', whatsapp: '+34 611 22 33 44' }], peticionesDocs: [] };
const igual = (a, b) => String(a) === String(b);
const cumple = (d, q) => Object.entries(q).every(([k, v]) => v && typeof v === 'object' && '$in' in v ? v.$in.includes(d[k]) : igual(d[k], v));
stub('src/db.js', { getDB: async () => ({ collection: n => ({
  findOne: async q => (cols[n] || []).find(d => cumple(d, q)) || null,
  find: q => ({ toArray: async () => (cols[n] || []).filter(d => cumple(d, q)), sort: function () { return this; }, limit: function () { return this; } }),
  insertOne: async d => { const _id = new ObjectId(); (cols[n] = cols[n] || []).push({ _id, ...d }); return { insertedId: _id }; },
  updateOne: async (q, u) => { const d = (cols[n] || []).find(x => cumple(x, q)); if (!d) return; Object.assign(d, u.$set || {}); for (const [k, v] of Object.entries(u.$inc || {})) d[k] = (d[k] || 0) + v; },
  updateMany: async (q, u) => { (cols[n] || []).filter(x => cumple(x, q)).forEach(d => Object.assign(d, u.$set || {})); },
}) }) });
const subidos = [];
stub('src/personalDocs.js', { subir: async (o) => { subidos.push(o); return { id: 'doc' + subidos.length }; } });
const A = require(path.join(root, 'src/docsAlta.js'));

test('pide por WhatsApp el DNI/NIE por las dos caras y la Seguridad Social', async () => {
  const env = [];
  const r = await A.pedir(String(UID), { por: 'Álex', _enviar: async (a, t) => { env.push([a, t]); return true; } });
  assert.equal(r.a, '+34611223344');
  assert.match(env[0][1], /Hola Manolo/); assert.match(env[0][1], /DNI o NIE por delante/); assert.match(env[0][1], /Seguridad Social/);
  assert.ok(await A.abiertaDe(String(UID)));
});

test('foto borrosa: se pide repetir; ticket: a Compras; con todo: gracias y aviso a Álex', async () => {
  const pet = await A.abiertaDe(String(UID));
  const foto = { buf: Buffer.from('x'), mime: 'image/jpeg' };
  let r = await A.recibir(pet, foto, { _mirar: async () => ({ tipo: 'seguridad_social', legible: false, problema: 'borrosa' }) });
  assert.match(r.respuesta, /no se lee bien \(borrosa\)/); assert.equal(subidos.length, 0);
  r = await A.recibir(pet, foto, { _mirar: async () => ({ tipo: 'ticket_o_factura', legible: true }) });
  assert.equal(r.aCompras, true);
  r = await A.recibir(pet, foto, { _mirar: async () => ({ tipo: 'doc_delante', legible: true, numero: '12345678Z' }) });
  assert.match(r.respuesta, /Recibido: DNI o NIE por delante\. Falta DNI o NIE por detrás y el número/);
  assert.equal(subidos[0].tipo, 'dni'); assert.match(subidos[0].notas, /12345678Z/);
  r = await A.recibir(pet, foto, { _mirar: async () => ({ tipo: 'doc_delante', legible: true }) });   // la IA repite «delante»: es la otra cara
  assert.match(r.respuesta, /Falta el número de la Seguridad Social/);
  const avisos = [];
  r = await A.recibir(pet, foto, { _mirar: async () => ({ tipo: 'seguridad_social', legible: true }), _avisar: async t => avisos.push(t) });
  assert.match(r.respuesta, /Ya lo tenemos todo/); assert.equal(subidos[2].tipo, 'tarjeta_ss');
  assert.match(avisos[0], /Manolo García\* ya ha mandado todos sus documentos/);
  assert.equal(await A.abiertaDe(String(UID)), null);
});

test('recordatorio a quien no lo ha mandado en un día, como mucho 2 veces', async () => {
  const env = [];
  await A.pedir(String(UID), { _enviar: async () => true });
  const manana = new Date(Date.now() + 25 * 3600 * 1000);
  assert.equal((await A.recordar({ hoy: manana, _enviar: async (a, t) => { env.push(t); return true; } })).recordados, 1);
  assert.match(env[0], /aún nos falta DNI o NIE por delante/);
  assert.equal((await A.recordar({ hoy: manana, _enviar: async () => true })).recordados, 0);   // mismo día: no
});

test('recordatorios: no en festivo; al día siguiente y a los 2 días; luego aviso a Álex una sola vez; volver a pedir conserva lo recibido', async () => {
  stub('src/festivos.js', { esFestivo: async f => f === '2026-10-12' });
  cols.peticionesDocs.forEach(x => { if (x.estado === 'abierta') x.estado = 'completa'; });   // solo cuenta la de este test
  const U2 = new ObjectId(); cols.users.push({ _id: U2, name: 'Javier Huaca', whatsapp: '+34 672 86 15 28' });
  const env = [], jefe = [];
  const _enviar = async (a, t) => { env.push(t); return true; };
  await A.pedir(String(U2), { _enviar });
  const p = cols.peticionesDocs.find(x => String(x.userId) === String(U2) && x.estado === 'abierta'); p.at = new Date('2026-10-09T09:00:00Z');
  p.recibidas = { [p.piezas[0]]: 'docX' };   // ya mandó una pieza
  const t = d => new Date(d + 'T08:30:00Z');
  const opts = { _enviar, _avisarJefe: async x => { jefe.push(x); } };
  assert.equal((await A.recordar({ hoy: t('2026-10-12'), ...opts })).festivo, true);
  assert.equal((await A.recordar({ hoy: t('2026-10-13'), ...opts })).recordados, 1);
  assert.equal((await A.recordar({ hoy: t('2026-10-14'), ...opts })).recordados, 0);   // aún no han pasado 2 días
  assert.equal((await A.recordar({ hoy: t('2026-10-15'), ...opts })).recordados, 1);
  assert.equal((await A.recordar({ hoy: t('2026-10-16'), ...opts })).avisosJefe, 0);
  assert.equal((await A.recordar({ hoy: t('2026-10-19'), ...opts })).avisosJefe, 1);
  assert.equal((await A.recordar({ hoy: t('2026-10-20'), ...opts })).avisosJefe, 0);   // una sola vez
  assert.match(jefe[0], /Javier Huaca\* sigue sin mandar/);
  // Volver a pedir: se conserva lo que ya mandó y solo se pide lo que falta
  await A.pedir(String(U2), { _enviar });
  const nueva = cols.peticionesDocs.find(x => String(x.userId) === String(U2) && x.estado === 'abierta');
  assert.equal(Object.keys(nueva.recibidas).length, 1); assert.match(env[env.length - 1], /Te lo recuerdo/);
});
