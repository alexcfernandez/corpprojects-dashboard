// test/fase8-canal.test.js — Fase 8 (pull/solo-salida): selector de canal
// (twilio | bridge→cola), reclamo atómico del outbox, y validación del token.
// No abre puertos ni red: mockea 'twilio' y la colección Mongo.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const root = path.join(__dirname, '..');

// ── Mock de Mongo (whatsappOutbox + bridgeStatus) ──
let outbox = [];        // docs {_id, to, body, ts, status}
let bridgeStatus = [];
let seq = 0;
let insertShouldFail = false;
const cols = {
  whatsappOutbox: {
    async insertOne(doc) { if (insertShouldFail) throw new Error('mongo caído'); const _id = 'o' + (seq++); outbox.push({ _id, ...doc }); return { insertedId: _id }; },
    async findOneAndUpdate(filter, update, opts) {
      const cands = outbox.filter(d => d.status === filter.status).sort((a, b) => a.ts - b.ts);
      const doc = cands[0];
      if (!doc) return null;
      Object.assign(doc, update.$set);
      return doc; // driver v6 devuelve el doc directamente
    },
  },
  bridgeStatus: {
    async updateOne(q, u, o) { bridgeStatus.push({ q, set: u.$set }); return {}; },
  },
};
const db = { collection: (n) => cols[n] || (cols[n] = { async insertOne() { return {}; } }) };
const dbPath = require.resolve(path.join(root, 'src/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDB: async () => db } };

// ── Mock de 'twilio' interceptando require ──
let twilioSent = [];
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'twilio') return () => ({ messages: { create: async (m) => { twilioSent.push(m); return { sid: 'x' }; } } });
  return origLoad.apply(this, arguments);
};

process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'tok';
process.env.TWILIO_WHATSAPP_FROM = 'whatsapp:+14155238886';

const canal = require(path.join(root, 'src/canalWhatsapp.js'));

function reset() { outbox = []; bridgeStatus = []; twilioSent = []; insertShouldFail = false; }

test('default = twilio (sin CANAL_WHATSAPP) → NO encola', async () => {
  reset(); delete process.env.CANAL_WHATSAPP;
  const ok = await canal.enviarUno('+34611223344', 'hola');
  assert.equal(ok, true);
  assert.equal(twilioSent.length, 1);
  assert.equal(outbox.length, 0);
});

test('canal = bridge → ENCOLA en whatsappOutbox (pending, sin prefijo whatsapp:)', async () => {
  reset();
  const ok = await canal.enviarUno('whatsapp:+34611223344', 'hola', { canal: 'bridge' });
  assert.equal(ok, true);
  assert.equal(twilioSent.length, 0);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].to, '+34611223344');
  assert.equal(outbox[0].status, 'pending');
});

test('bridge: si falla el encolado → fallback a Twilio (no queda mudo)', async () => {
  reset(); insertShouldFail = true;
  const ok = await canal.enviarUno('+34611223344', 'hola', { canal: 'bridge' });
  assert.equal(ok, true);
  assert.equal(twilioSent.length, 1);
});

test('reclamarLoteOutbox: reclama atómico en orden, respeta limit y marca sent + heartbeat', async () => {
  reset();
  await canal.encolarSalida('+34600000001', 'uno');
  await canal.encolarSalida('+34600000002', 'dos');
  await canal.encolarSalida('+34600000003', 'tres');

  const lote1 = await canal.reclamarLoteOutbox(2);
  assert.equal(lote1.length, 2);
  assert.deepEqual(lote1.map(m => m.body), ['uno', 'dos']);   // orden por ts
  assert.equal(bridgeStatus.length >= 1, true, 'heartbeat lastSeen actualizado');
  assert.equal(outbox.filter(d => d.status === 'sent').length, 2);

  const lote2 = await canal.reclamarLoteOutbox(10);
  assert.equal(lote2.length, 1);
  assert.equal(lote2[0].body, 'tres');

  const lote3 = await canal.reclamarLoteOutbox(10);
  assert.equal(lote3.length, 0, 'ya no quedan pendientes');
});

test('tokenBridgeValido: sin BRIDGE_TOKEN → siempre false', () => {
  delete process.env.BRIDGE_TOKEN;
  assert.equal(canal.tokenBridgeValido('lo-que-sea'), false);
});

test('tokenBridgeValido: correcto=true, incorrecto/vacío=false', () => {
  process.env.BRIDGE_TOKEN = 'secreto-correcto';
  assert.equal(canal.tokenBridgeValido('secreto-correcto'), true);
  assert.equal(canal.tokenBridgeValido('secreto-incorrecto'), false);
  assert.equal(canal.tokenBridgeValido(''), false);
  assert.equal(canal.tokenBridgeValido(undefined), false);
});

test.after(() => { Module._load = origLoad; });
