// test/fase8-canal.test.js — selector de canal (twilio|bridge) + validación del
// token del puente. No abre puertos ni red: mockea twilio y axios.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const root = path.join(__dirname, '..');

// ── Mock de 'twilio' y 'axios' interceptando require ──
let twilioSent = [];
let axiosPosts = [];
let axiosShouldFail = false;
const origResolve = Module._resolveFilename;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'twilio') {
    return () => ({ messages: { create: async (m) => { twilioSent.push(m); return { sid: 'x' }; } } });
  }
  if (request === 'axios') {
    return { post: async (url, body, opts) => { axiosPosts.push({ url, body, opts }); if (axiosShouldFail) throw new Error('bridge caído'); return { status: 200 }; } };
  }
  return origLoad.apply(this, arguments);
};

process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'tok';
process.env.TWILIO_WHATSAPP_FROM = 'whatsapp:+14155238886';

const canal = require(path.join(root, 'src/canalWhatsapp.js'));

test('default = twilio (sin CANAL_WHATSAPP) → envía por Twilio', async () => {
  delete process.env.CANAL_WHATSAPP;
  twilioSent = []; axiosPosts = [];
  const ok = await canal.enviarUno('+34611223344', 'hola');
  assert.equal(ok, true);
  assert.equal(twilioSent.length, 1);
  assert.equal(axiosPosts.length, 0);
  assert.equal(twilioSent[0].to, 'whatsapp:+34611223344'); // añade prefijo whatsapp:
});

test('canal por parámetro = bridge → POST al puente con el token en header', async () => {
  process.env.BRIDGE_URL = 'https://vps.example/bridge/';
  process.env.BRIDGE_TOKEN = 'secreto-largo';
  twilioSent = []; axiosPosts = []; axiosShouldFail = false;
  const ok = await canal.enviarUno('whatsapp:+34611223344', 'hola', { canal: 'bridge' });
  assert.equal(ok, true);
  assert.equal(axiosPosts.length, 1);
  assert.equal(twilioSent.length, 0);
  assert.match(axiosPosts[0].url, /\/send$/);           // sin doble barra
  assert.equal(axiosPosts[0].body.to, '+34611223344');  // el puente usa el número tal cual
  assert.equal(axiosPosts[0].opts.headers['X-Bridge-Token'], 'secreto-largo');
});

test('bridge caído + fallbackTwilio → reintenta por Twilio (no queda mudo)', async () => {
  process.env.BRIDGE_URL = 'https://vps.example';
  process.env.BRIDGE_TOKEN = 'secreto-largo';
  twilioSent = []; axiosPosts = []; axiosShouldFail = true;
  const ok = await canal.enviarUno('+34611223344', 'hola', { canal: 'bridge' });
  assert.equal(ok, true);
  assert.equal(axiosPosts.length, 1, 'intentó el puente');
  assert.equal(twilioSent.length, 1, 'cayó a Twilio');
});

test('tokenBridgeValido: sin BRIDGE_TOKEN → siempre false', () => {
  delete process.env.BRIDGE_TOKEN;
  assert.equal(canal.tokenBridgeValido('cualquier-cosa'), false);
  assert.equal(canal.tokenBridgeValido(''), false);
});

test('tokenBridgeValido: correcto = true, incorrecto/vacío = false', () => {
  process.env.BRIDGE_TOKEN = 'secreto-correcto';
  assert.equal(canal.tokenBridgeValido('secreto-correcto'), true);
  assert.equal(canal.tokenBridgeValido('secreto-incorrecto'), false);
  assert.equal(canal.tokenBridgeValido(''), false);
  assert.equal(canal.tokenBridgeValido(undefined), false);
  assert.equal(canal.tokenBridgeValido('secreto-correcto '), false); // no hace trim
});

test.after(() => { Module._load = origLoad; Module._resolveFilename = origResolve; });
