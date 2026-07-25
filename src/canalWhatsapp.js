// src/canalWhatsapp.js — Selector de transporte de salida de WhatsApp.
//
// Elige entre Twilio (actual) y el puente Baileys (Fase 8), por mensaje o por
// la variable de entorno CANAL_WHATSAPP=bridge|twilio (default 'twilio').
// Con el default, el comportamiento es EXACTAMENTE el de hoy (Twilio).
//
// El troceo de mensajes largos se mantiene en quien llama (server.enviarWhatsApp);
// aquí solo se decide el transporte y se envía UN cuerpo.

const axios = require('axios');

function canalActivo(override) {
  const c = String(override || process.env.CANAL_WHATSAPP || 'twilio').toLowerCase();
  return c === 'bridge' ? 'bridge' : 'twilio';
}

async function _twilioUno(to, body) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    console.log('[Canal] Twilio no configurado. Para', to, ':', String(body).slice(0, 80));
    return false;
  }
  const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const dest = /^whatsapp:/i.test(to) ? to : `whatsapp:${to}`;
  await client.messages.create({ from: process.env.TWILIO_WHATSAPP_FROM, to: dest, body: String(body || '') });
  return true;
}

async function _bridgeUno(to, body) {
  const url = process.env.BRIDGE_URL, token = process.env.BRIDGE_TOKEN;
  if (!url || !token) { console.error('[Canal] BRIDGE_URL/BRIDGE_TOKEN sin configurar'); return false; }
  const dest = String(to || '').replace(/^whatsapp:/i, ''); // el puente usa el número tal cual (+34…)
  await axios.post(`${url.replace(/\/+$/, '')}/send`, { to: dest, body: String(body || '') },
    { headers: { 'X-Bridge-Token': token }, timeout: 15000 });
  return true;
}

// Envía UN mensaje por el canal elegido. Si el puente falla y fallbackTwilio
// (default true), reintenta por Twilio para no quedar mudo durante la migración.
async function enviarUno(to, body, { canal, fallbackTwilio = true } = {}) {
  const usar = canalActivo(canal);
  try {
    return usar === 'bridge' ? await _bridgeUno(to, body) : await _twilioUno(to, body);
  } catch (err) {
    console.error(`[Canal] Error enviando por ${usar}:`, err.message);
    if (usar === 'bridge' && fallbackTwilio) {
      console.warn('[Canal] Reintentando por Twilio (respaldo)…');
      try { return await _twilioUno(to, body); } catch (e2) { console.error('[Canal] Twilio respaldo falló:', e2.message); }
    }
    return false;
  }
}

// Valida el secreto del puente en tiempo constante y sin fuga de longitud.
// Sin BRIDGE_TOKEN configurado → false SIEMPRE (endpoint cerrado). El token
// NUNCA se loguea. Es la única barrera de /api/bridge/inbound.
function tokenBridgeValido(provided) {
  const crypto = require('crypto');
  const expected = process.env.BRIDGE_TOKEN;
  if (!expected) return false;
  const a = crypto.createHash('sha256').update(String(provided || '')).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = { enviarUno, canalActivo, tokenBridgeValido };
