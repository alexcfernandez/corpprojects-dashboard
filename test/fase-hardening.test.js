// test/fase-hardening.test.js — §1: blindaje del clasificador/IA.
// Distinguir "IA caída" de "intent otro"; ping de modelos; mensaje honesto.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');

// Mock de ./db (genérico) + estadoConversacion
const generic = { async findOne() { return null; }, async updateOne() { return {}; }, async insertOne() { return { insertedId: 'x' }; }, async deleteOne() { return {}; }, find() { return { sort() { return { limit() { return { async toArray() { return []; } }; }, async toArray() { return []; } }; } }; } };
const dbPath = require.resolve(path.join(root, 'src/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDB: async () => ({ collection: () => generic }), getDBLegacy: async () => ({ db: { collection: () => generic }, client: { async close() {} } }) } };

process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.OWNER_NUMBERS = '+34611223344';

const asistente = require(path.join(root, 'src/asistente.js'));
const stel = require(path.join(root, 'src/stelorder.js'));
stel.getClients = async () => ({ clientMap: { 1: { name: 'Illa Verda' } }, families: [{ name: 'Cinc' }] });

const OWNER = 'whatsapp:+34611223344';

// Control de fetch: 'ok' devuelve un JSON válido; 'fail' lanza (modelo caído).
let modoFetch = 'ok';
global.fetch = async () => {
  if (modoFetch === 'fail') throw new Error('model unavailable');
  if (modoFetch === 'http500') return { ok: false, status: 404, json: async () => ({ error: 'model not found' }) };
  return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '{"intent":"facturas","scope":"general","rawTarget":null}' }] }) };
};

test('clasificar: modelo OK → sin __iaError', async () => {
  modoFetch = 'ok';
  const cl = await asistente.clasificar('cuánto me deben');
  assert.equal(cl.__iaError, undefined);
  assert.equal(cl.intent, 'facturas');
});

test('clasificar: llamada FALLA → marca __iaError (no lo confunde con "otro")', async () => {
  modoFetch = 'fail';
  const cl = await asistente.clasificar('cuánto me deben');
  assert.equal(cl.__iaError, true);
});

test('clasificar: HTTP no-OK (modelo retirado) → marca __iaError', async () => {
  modoFetch = 'http500';
  const cl = await asistente.clasificar('cuánto me deben');
  assert.equal(cl.__iaError, true);
});

test('pingIA: modelo OK → true; modelo caído → false', async () => {
  modoFetch = 'ok';
  assert.equal(await asistente.pingIA('claude-sonnet-4-6'), true);
  modoFetch = 'fail';
  assert.equal(await asistente.pingIA('modelo-inexistente'), false);
});

test('responderConsulta: IA caída → mensaje honesto, NO se disfraza de agente', async () => {
  modoFetch = 'fail';
  const reply = await asistente.responderConsulta('enséñame el ranking de deudas de clientes', OWNER);
  assert.match(reply, /problema temporal|IA|inténtalo|prueba otra vez/i);
  assert.doesNotMatch(reply, /solo puedo apuntar eventos|solo agenda/i);
});
