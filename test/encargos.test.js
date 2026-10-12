// test/encargos.test.js — Encargos a trabajadores: se pide, se recuerda, se cierra al contestar y si no, aviso a Álex.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ObjectId } = require('mongodb');
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const UID = new ObjectId();
const cols = { users: [{ _id: UID, name: 'Javier Huaca', whatsapp: '+34 672 86 15 28' }], encargos: [] };
const igual = (a, b) => String(a) === String(b);
const cumple = (d, q) => Object.entries(q).every(([k, v]) => igual(d[k], v));
stub('src/db.js', { getDB: async () => ({ collection: n => ({
  findOne: async q => (cols[n] || []).find(d => cumple(d, q)) || null,
  find: q => { const l = (cols[n] || []).filter(d => cumple(d, q)); const o = { toArray: async () => l, sort: () => o, limit: () => o }; return o; },
  insertOne: async d => { const _id = new ObjectId(); cols[n].push({ _id, ...d }); return { insertedId: _id }; },
  updateOne: async (q, u) => { const d = cols[n].find(x => cumple(x, q)); if (!d) return; for (const [k, v] of Object.entries(u.$set || {})) { const ps = k.split('.'); let o = d; ps.slice(0, -1).forEach(p => { o = o[p] = o[p] || {}; }); o[ps[ps.length - 1]] = v; } for (const [k, v] of Object.entries(u.$inc || {})) d[k] = (d[k] || 0) + v; for (const [k, v] of Object.entries(u.$push || {})) (d[k] = d[k] || []).push(v); },
}) }) });
stub('src/festivos.js', { esFestivo: async f => f === '2026-10-12' });
stub('src/notifications.js', { sendWhatsAppTo: async () => true, sendWhatsApp: async () => true });
const E = require(path.join(root, 'src/encargos.js'));

test('se le pide de parte de Álex; «mañana te lo digo» lo deja abierto; la respuesta de verdad lo cierra y se avisa a Álex', async () => {
  const env = [], jefe = [];
  const r = await E.crear({ userId: String(UID), que: 'talla de botas', mensaje: '¿Qué talla de botas usas?' }, { _enviar: async (a, t) => { env.push(t); return true; } });
  assert.match(env[0], /Hola Javier 👋 Soy Corpy, de la oficina de Corp Projects\. ¿Qué talla de botas usas\?/); assert.doesNotMatch(env[0], /de parte de Álex/i);
  let t = await E.respuesta(String(UID), 'Javier Huaca', { texto: 'mañana te lo digo' }, { _avisar: async x => jefe.push(x) });
  assert.match(t, /Apuntado/); assert.equal((await E.abiertosDe(String(UID))).length, 1); assert.match(jefe[0], /sigo record/);
  t = await E.respuesta(String(UID), 'Javier Huaca', { texto: 'un 43' }, { _avisar: async x => jefe.push(x) });
  assert.match(t, /Gracias/); assert.equal((await E.abiertosDe(String(UID))).length, 0); assert.match(jefe[1], /«talla de botas»:\n"un 43"[\s\S]*cerrado/);
  assert.equal(await E.respuesta(String(UID), 'Javier Huaca', { texto: 'hola' }), null);   // sin encargos: sigue el camino normal
  void r;
});

test('recordatorios: no en festivo, 2 como máximo y luego aviso a Álex una vez', async () => {
  cols.encargos.length = 0;
  await E.crear({ userId: String(UID), que: 'carnet de conducir', mensaje: 'Tráete mañana el carnet de conducir' }, { _enviar: async () => true });
  cols.encargos[0].at = new Date('2026-10-09T09:00:00Z');
  const jefe = [], o = { _enviar: async () => true, _avisarJefe: async x => jefe.push(x) }, d = x => new Date(x + 'T08:35:00Z');
  assert.equal((await E.recordar({ hoy: d('2026-10-12'), ...o })).festivo, true);
  assert.equal((await E.recordar({ hoy: d('2026-10-13'), ...o })).recordados, 1);
  assert.equal((await E.recordar({ hoy: d('2026-10-15'), ...o })).recordados, 1);
  assert.equal((await E.recordar({ hoy: d('2026-10-19'), ...o })).avisosJefe, 1);
  assert.equal((await E.recordar({ hoy: d('2026-10-20'), ...o })).avisosJefe, 0);
  assert.match(jefe[0], /Javier Huaca\* sigue sin contestar/);
});

test('memoria: «tengo que devolver la batidora» se apunta y Corpy se lo pregunta al día siguiente sin «de parte de»', async () => {
  cols.encargos.length = 0;
  const p = await E.apuntarDeTrabajador(String(UID), 'Javier Huaca', 'mañana devuelvo la batidora a Obramat', { _ia: async () => ({ hay: true, que: 'devolver la batidora', pregunta: '¿Ya devolviste la batidora a Obramat?', cuando: null }) });
  assert.equal(p.que, 'devolver la batidora');
  assert.equal(await E.apuntarDeTrabajador(String(UID), 'Javier Huaca', 'buenos días', { _ia: async () => ({ hay: false }) }), null);
  cols.encargos[0].at = new Date('2026-10-13T09:00:00Z');
  const env = [];
  assert.equal((await E.recordar({ hoy: new Date('2026-10-14T08:35:00Z'), _enviar: async (a, t) => { env.push(t); return true; } })).recordados, 1);
  assert.equal(env[0], 'Hola Javier 👋 ¿Ya devolviste la batidora a Obramat?');
});

test('tallas: se guardan en la ficha; si falta algo sigue abierto y pide solo eso', async () => {
  cols.encargos.length = 0; cols.users[0].tallas = undefined; cols.users[0].nacimiento = undefined;
  const F = require(path.join(root, 'src/fichaDatos.js'));
  const env = [];
  await F.pedir(String(UID));   // crea el encargo (envía por notifications: stub abajo)
  void env;
  const e = cols.encargos.find(x => x.tipo === 'tallas');
  assert.ok(e); assert.match(e.textoInicial, /Soy Corpy/); assert.doesNotMatch(e.textoInicial, /de parte de/i);
  let r = await F.respuesta(e, String(UID), 'Javier Huaca', 'camiseta L y zapato 43', { _leerIA: async () => ({ ropa: 'L', calzado: '43' }), _avisar: async () => {} });
  assert.match(r, /Me falta tu talla de pantalón/); assert.doesNotMatch(r, /nacimiento/); assert.equal(cols.users[0].tallas.ropa, 'L'); assert.equal(e.estado, 'abierto');
  r = await F.respuesta(e, String(UID), 'Javier Huaca', 'pantalón 42, nací el 3/5/1990', { _leerIA: async () => ({ pantalon: '42', nacimiento: '1990-05-03' }), _avisar: async () => {} });
  assert.match(r, /Apuntadas tus tallas/); assert.equal(e.estado, 'hecho'); assert.equal(cols.users[0].nacimiento, '1990-05-03');
});
