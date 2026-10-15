// test/correccion-cliente.test.js — Conversación real del 14/10/2026:
//   «De rutlla nos deben algo?» → elegía RUTLLA 70-72 (hay varias Rutlla)
//   «Era rutlla 202»            → acertaba el cliente pero cambiaba a PEDIDOS
// Ahora: varias que encajan → pregunta cuál; corrección solo del cliente → repite
// la consulta anterior (facturas) con el cliente nuevo.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');

// Mock de ./db (genérico) — evita conexiones reales
const generic = { async findOne() { return null; }, async updateOne() { return {}; }, async insertOne() { return { insertedId: 'x' }; }, async deleteOne() { return {}; }, find() { return { sort() { return { async toArray() { return []; } }; } }; } };
const dbPath = require.resolve(path.join(root, 'src/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDB: async () => ({ collection: () => generic }), getDBLegacy: async () => ({ db: { collection: () => generic }, client: { async close() {} } }) } };

process.env.OWNER_NUMBERS = '+34611223344,+34600000001,+34600000002,+34600000003,+34600000004';
process.env.ANTHROPIC_API_KEY = 'test';

// IA mockeada con los MISMOS fallos que en producción: el clasificador ve la
// corrección como "pedidos" y elegirTarget se queda con la primera Rutlla.
global.fetch = async (url, opts) => {
  const prompt = JSON.parse(opts.body).messages[0].content;
  let out = {};
  if (/Clasifica su pregunta/.test(prompt)) {
    const q = (prompt.match(/Pregunta: "([^"]*)"/) || [])[1] || '';
    if (/deben/i.test(q))       out = { intent: 'facturas', scope: 'cliente', rawTarget: /illa verda/i.test(q) ? 'illa verda' : 'rutlla' };
    else if (/pedidos/i.test(q)) out = { intent: 'pedidos', scope: 'cliente', rawTarget: q.replace(/^.*pedidos de /i, '') };
    else                         out = { intent: 'pedidos', scope: 'cliente', rawTarget: q.replace(/^(era|no,?)\s+/i, '') };
  } else if (/Elige a cuál de esta lista/.test(prompt)) {
    out = { target: /202/.test(prompt.split('\n')[0]) ? 'CTAT PROP RUTLLA, 200-202' : 'RUTLLA 70-72' };
  }
  return { ok: true, async json() { return { content: [{ text: JSON.stringify(out) }] }; } };
};

const asistente = require(path.join(root, 'src/asistente.js'));
const stel = require(path.join(root, 'src/stelorder.js'));

stel.getClients = async () => ({
  clientMap: { 1: { name: 'RUTLLA 70-72' }, 2: { name: 'CTAT PROP RUTLLA, 200-202' }, 3: { name: 'RUTLLA 15' }, 4: { name: 'ILLA VERDA' } },
  families: [],
});
stel.getPendingInvoices = async () => [
  { number: 'FAC00900', client: 'CTAT PROP RUTLLA, 200-202', family: '', pending: 300, daysOverdue: 20 },
  { number: 'FAC00901', client: 'ILLA VERDA', family: '', pending: 120, daysOverdue: 5 },
];
stel.getWorkOrdersLive = async () => [{ number: 'PDT00050', client: 'ILLA VERDA', family: '', days: 3 }];

const OWNER = 'whatsapp:+34611223344';

test('«De rutlla nos deben algo?» con varias Rutlla → pregunta cuál, no elige una', async () => {
  const r = await asistente.responderConsulta('De rutlla nos deben algo?', OWNER);
  assert.match(r, /¿Cuál\?/);
  assert.match(r, /RUTLLA 70-72/);
  assert.match(r, /CTAT PROP RUTLLA, 200-202/);
  assert.match(r, /RUTLLA 15/);
  assert.doesNotMatch(r, /no tiene facturas pendientes/);
});

test('…«Era rutlla 202» → facturas pendientes de CTAT PROP RUTLLA, 200-202 (no pedidos)', async () => {
  const r = await asistente.responderConsulta('Era rutlla 202', OWNER);
  assert.match(r, /CTAT PROP RUTLLA, 200-202/);
  assert.match(r, /FAC00900/);
  assert.doesNotMatch(r, /pedido/i);
});

test('respuesta con el número de la lista («2») → la consulta original con ese cliente', async () => {
  const from = 'whatsapp:+34600000004';
  await asistente.responderConsulta('De rutlla nos deben algo?', from);
  const r = await asistente.responderConsulta('2', from);
  assert.match(r, /CTAT PROP RUTLLA, 200-202/);
  assert.match(r, /FAC00900/);
});

test('sin pregunta pendiente: «qué nos deben…» y luego «no, la de rutlla 202» → mantiene facturas', async () => {
  const from = 'whatsapp:+34600000001';
  const r1 = await asistente.responderConsulta('qué nos deben los de illa verda', from);
  assert.match(r1, /FAC00901/);
  const r2 = await asistente.responderConsulta('no, la de rutlla 202', from);
  assert.match(r2, /FAC00900/);
  assert.doesNotMatch(r2, /pedido/i);
});

test('si la corrección nombra otra consulta («no, los pedidos de illa verda») manda la nueva', async () => {
  const from = 'whatsapp:+34600000002';
  await asistente.responderConsulta('qué nos deben los de illa verda', from);
  const r = await asistente.responderConsulta('no, los pedidos de illa verda', from);
  assert.match(r, /PDT00050/);
});

test('«era X» sin consulta previa → no inventa contexto (va al router normal)', async () => {
  const from = 'whatsapp:+34600000003';
  const r = await asistente.responderConsulta('era rutlla 202', from);
  assert.match(r, /pedidos de trabajo abiertos/); // lo que diga el clasificador, como antes
});
