// test/deuda-por-familia.test.js — "lo que nos deben por familias": total + bloques
// por familia (mayor deuda primero, "Sin familia" al final), sin pasar por la IA.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');

const generic = { async findOne() { return null; }, async updateOne() { return {}; }, async insertOne() { return { insertedId: 'x' }; }, async deleteOne() { return {}; }, find() { return { sort() { return { async toArray() { return []; } }; } }; } };
const dbPath = require.resolve(path.join(root, 'src/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDB: async () => ({ collection: () => generic }), getDBLegacy: async () => ({ db: { collection: () => generic }, client: { async close() {} } }) } };

process.env.OWNER_NUMBERS = '+34611223344';
delete process.env.ANTHROPIC_API_KEY; // enrutado determinista: no debe hacer falta la IA

const asistente = require(path.join(root, 'src/asistente.js'));
const stel = require(path.join(root, 'src/stelorder.js'));

stel.getClients = async () => ({ clientMap: {}, families: [] });
stel.getPendingInvoices = async () => [
  { number: 'FAC00001', client: 'RUTLLA 70-72',              family: 'FINQUES ROCA', pending: 100 },
  { number: 'FAC00002', client: 'RUTLLA 70-72',              family: 'FINQUES ROCA', pending: 50 },
  { number: 'FAC00003', client: 'CTAT PROP RUTLLA, 200-202', family: 'FINQUES ROCA', pending: 300 },
  { number: 'FAC00004', client: 'ILLA VERDA',                family: 'BELLPUIG',     pending: 1000 },
  { number: 'FAC00005', client: 'Particular Pérez',          family: '',             pending: 2000 },
];

const OWNER = 'whatsapp:+34611223344';
const norm = s => s.replace(/\s/g, ' ');

for (const frase of ['lo que nos deben por familias', '¿Qué nos deben por bloques de familia?', 'deuda agrupada por familia', 'listado de facturas pendientes por familia'])
  test(`«${frase}» → listado por familia`, async () => {
    const r = norm(await asistente.responderConsulta(frase, OWNER));
    assert.match(r, /Total pendiente: 3\.?450,00 €/);
    assert.match(r, /5 facturas · 2 familias \+ sin familia/);
  });

test('bloques: mayor deuda primero, clientes con subtotal, "Sin familia" al final', async () => {
  const r = norm(await asistente.responderConsulta('lo que nos deben por familias', OWNER));
  assert.match(r, /\*BELLPUIG\* — \*1\.?000,00 €\* · 1 fact\./);
  assert.match(r, /\*FINQUES ROCA\* — \*450,00 €\* · 3 fact\./);
  assert.match(r, /• CTAT PROP RUTLLA, 200-202 — 300,00 €/);
  assert.match(r, /• RUTLLA 70-72 — 150,00 € \(2\)/);
  assert.ok(r.indexOf('BELLPUIG') < r.indexOf('FINQUES ROCA'));
  assert.ok(r.indexOf('FINQUES ROCA') < r.indexOf('Sin familia')); // aunque deba más, va al final
  assert.ok(r.indexOf('CTAT PROP') < r.indexOf('RUTLLA 70-72'));
});

test('«qué debe la familia Bellpuig» NO es el listado por familias', async () => {
  const r = await asistente.responderConsulta('qué debe la familia Bellpuig', OWNER);
  assert.doesNotMatch(r, /Total pendiente: 3\.?450/);
});
