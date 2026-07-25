// test/fase4a-pendientes.test.js — pendientes/recordatorios: detección de intención
// (sin robar las notas de comunidad), limpieza del verbo y CRUD + colector.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');

// ── Mock de la colección `pendientes` ──
let rows = []; let seq = 0;
const col = {
  async insertOne(doc) { const _id = 'p' + (seq++); rows.push({ _id, ...doc }); return { insertedId: _id }; },
  find(q) { const f = rows.filter(r => (q && q.estado) ? r.estado === q.estado : true); return { sort() { return { async toArray() { return f.slice(); } }; } }; },
  async updateOne(q, u) { const r = rows.find(x => x._id === q._id); if (r && u.$set) Object.assign(r, u.$set); return {}; },
  async findOne(q) { return rows.find(x => x._id === q._id) || null; },
};
const db = { collection: () => col };
const dbPath = require.resolve(path.join(root, 'src/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDB: async () => db } };

const P = require(path.join(root, 'src/pendientes.js'));

// ── detectarIntent: ADD ──
test('add: "recuérdame …"', () => { const r = P.detectarIntent('recuérdame hacer la factura de la EICA'); assert.equal(r.tipo, 'add'); assert.match(r.texto, /factura de la EICA/); });
test('add: "apúntame que …" (sin "en")', () => { assert.equal(P.detectarIntent('apúntame que tengo que llamar al fontanero').tipo, 'add'); });
test('add: "no me lo dejes olvidar …"', () => { assert.equal(P.detectarIntent('no me lo dejes olvidar pagar el seguro').tipo, 'add'); });
test('add: "añade un pendiente: …"', () => { assert.equal(P.detectarIntent('añade un pendiente: revisar el contrato').tipo, 'add'); });

// ── detectarIntent: LIST / DONE ──
test('list: "pendientes"', () => { assert.equal(P.detectarIntent('pendientes').tipo, 'list'); });
test('done: "hecho el pendiente 2"', () => { const r = P.detectarIntent('hecho el pendiente 2'); assert.equal(r.tipo, 'done'); assert.equal(r.idx, 2); });
test('done: "quita el pendiente 3"', () => { const r = P.detectarIntent('quita el pendiente 3'); assert.equal(r.tipo, 'done'); assert.equal(r.idx, 3); });

// ── NO colisión con notas de comunidad ni mensajes normales ──
test('NO roba nota de comunidad: "apunta en Illa Verda que…" → null', () => { assert.equal(P.detectarIntent('apunta en Illa Verda que la caldera es Roca'), null); });
test('NO roba: "anota en Bellpuig que…" → null', () => { assert.equal(P.detectarIntent('anota en Bellpuig que hay una fuga'), null); });
test('consulta normal → null', () => { assert.equal(P.detectarIntent('¿qué debe Illa Verda?'), null); });

// ── limpiarVerbo ──
test('limpiarVerbo quita el verbo inicial', () => { assert.equal(P.limpiarVerbo('recuérdame llamar a Pedro'), 'llamar a Pedro'); });
test('limpiarVerbo quita la coletilla final', () => {
  const t = P.limpiarVerbo('apúntame la factura de la EICA, no me lo dejes olvidar');
  assert.match(t, /factura de la EICA/); assert.doesNotMatch(t, /dejes olvidar/);
});

// ── CRUD + colector ──
test('CRUD: add / list / cerrar / seccionResumen', async () => {
  rows = []; seq = 0;
  await P.addPendiente('factura EICA', '+34x');
  await P.addPendiente('llamar fontanero', '+34x');

  let abiertos = await P.listPendientes({ soloAbiertos: true });
  assert.equal(abiertos.length, 2);

  const sec = await P.seccionResumen();
  assert.match(sec, /Pendientes/); assert.match(sec, /1\. factura EICA/);

  const done = await P.cerrarPendiente({ idx: 1 });
  assert.equal(done.texto, 'factura EICA');

  abiertos = await P.listPendientes({ soloAbiertos: true });
  assert.equal(abiertos.length, 1);
  assert.equal(abiertos[0].texto, 'llamar fontanero');
});

test('seccionResumen = null si no hay pendientes', async () => { rows = []; seq = 0; assert.equal(await P.seccionResumen(), null); });
