// test/rrhh.test.js — Candidatos: entrevista puntuada sobre 100 y paso a trabajador con sus documentos.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ObjectId } = require('mongodb');
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const cols = { candidatos: [], candidatosDocs: [], users: [] };
const igual = (a, b) => String(a) === String(b);
const casa = (d, q) => Object.entries(q).every(([k, v]) => v && typeof v === 'object' && '$in' in v ? v.$in.includes(d[k]) : igual(d[k], v));
const col = n => ({
  insertOne: async d => { const _id = new ObjectId(); cols[n].push({ ...d, _id }); return { insertedId: _id }; },
  findOne: async q => cols[n].find(d => casa(d, q)) || null,
  updateOne: async (q, u) => { const d = cols[n].find(x => casa(x, q)); if (!d) return; Object.assign(d, u.$set || {}); for (const [k, v] of Object.entries(u.$push || {})) (d[k] = d[k] || []).push(v); },
  find: q => { const r = cols[n].filter(d => casa(d, q || {})); const c = { project: () => c, sort: () => c, limit: () => c, toArray: async () => r }; return c; },
  aggregate: () => ({ toArray: async () => [] }),
  deleteOne: async () => {}, deleteMany: async () => {},
});
const pasados = [];
stub('src/db.js', { getDB: async () => ({ collection: col }) });
stub('src/users.js', { createUser: async d => { if (!(d.costeHora > 0)) throw new Error('coste'); const id = new ObjectId(); cols.users.push({ _id: id, ...d, active: true }); return { id, ...d }; } });
stub('src/personalDocs.js', { subir: async (d) => { pasados.push(d.tipo); return {}; } });
const R = require(path.join(root, 'src/rrhh.js'));

test('entrevista: media de las notas × 20, y pasa a «entrevista»', async () => {
  const c = await R.crear({ nombre: 'Ramón Domínguez', oficio: 'pintor', telefono: '600111222' }, 'Álex');
  assert.equal(c.estado, 'nuevo');
  const e = await R.guardarEntrevista(c.id, { oficio: 'pintor', respuestas: [{ id: 'g1', nota: 4, respuesta: '5 años en una empresa de Salt' }, { id: 'p1', nota: 5 }, { id: 'p3', nota: 3 }, { id: 'xx', nota: 5 }] }, 'Álex');
  assert.equal(e.entrevista.puntuacion, 80);              // (4+5+3)/3 × 20; la pregunta que no existe no cuenta
  assert.equal(e.estado, 'entrevista');
  assert.ok(R.preguntas('pintor').preguntas.length > 6);  // generales + las del oficio
});

test('pasar a trabajador: pide el coste/hora, crea el usuario con PIN y pasa DNI y carné a Personal', async () => {
  const c = await R.crear({ nombre: 'Melvin Ramírez', oficio: 'albanil' }, 'Álex');
  const buf = { buffer: Buffer.from('x'), mimetype: 'image/jpeg', originalname: 'dni.jpg', size: 1 };
  await R.subirDoc(c.id, { tipo: 'dni', archivo: buf, leerIA: false }, 'Álex');
  await R.subirDoc(c.id, { tipo: 'carnet', archivo: { ...buf, originalname: 'carne.jpg' }, leerIA: false }, 'Álex');
  await R.subirDoc(c.id, { tipo: 'cv', archivo: { ...buf, mimetype: 'application/pdf', originalname: 'cv.pdf' }, leerIA: false }, 'Álex');
  await assert.rejects(R.contratar(c.id, {}, 'Álex'), /coste por hora/);
  const r = await R.contratar(c.id, { costeHora: 18 }, 'Álex');
  assert.match(r.pin, /^\d{4}$/);
  assert.deepEqual(pasados.sort(), ['carnet', 'dni']);    // el CV no va a Personal
  assert.equal((await R.ver(c.id)).estado, 'contratado');
  await assert.rejects(R.contratar(c.id, { costeHora: 18 }, 'Álex'), /Ya es trabajador/);
});
