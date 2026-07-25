// src/canalWhatsapp.js — Selector de transporte de salida de WhatsApp.
//
// Elige entre Twilio (actual) y el puente Baileys (Fase 8), por mensaje o por
// la variable CANAL_WHATSAPP=bridge|twilio (default 'twilio' → igual que hoy).
//
// Arquitectura del puente = PULL / solo-salida: el dashboard NO llama al puente.
// La rama 'bridge' encola en la colección Mongo `whatsappOutbox`; el puente
// (en el VPS) sondea GET /api/bridge/outbox y envía. Así el puente no expone
// ningún puerto público: solo hace llamadas salientes.
//
// El troceo de mensajes largos se mantiene en quien llama (server.enviarWhatsApp).

const OUTBOX = 'whatsappOutbox';

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

// Salida por el puente = ENCOLAR en Mongo. El puente lo recogerá por pull.
async function encolarSalida(to, body) {
  const db = await require('./db').getDB();
  const dest = String(to || '').replace(/^whatsapp:/i, ''); // el puente usa el número tal cual (+34…)
  await db.collection(OUTBOX).insertOne({ to: dest, body: String(body || ''), ts: new Date(), status: 'pending' });
  return true;
}

// Reclama atómicamente hasta `limit` mensajes pendientes (findOneAndUpdate marca
// cada uno 'sent' en la misma operación → sin doble entrega aunque haya varios
// sondeos). Actualiza bridgeStatus.lastSeen como heartbeat del puente.
async function reclamarLoteOutbox(limit = 10) {
  const db = await require('./db').getDB();
  try {
    await db.collection('bridgeStatus').updateOne(
      { _id: 'bridge' }, { $set: { lastSeen: new Date() } }, { upsert: true });
  } catch (e) { /* el heartbeat no debe tumbar la respuesta */ }

  const max = Math.max(1, Math.min(Number(limit) || 10, 50));
  const lote = [];
  for (let i = 0; i < max; i++) {
    const r = await db.collection(OUTBOX).findOneAndUpdate(
      { status: 'pending' },
      { $set: { status: 'sent', sentAt: new Date() } },
      { sort: { ts: 1 }, returnDocument: 'after' }
    );
    const doc = r ? (r.value !== undefined ? r.value : r) : null; // driver v6 devuelve el doc; compat con {value}
    if (!doc) break;
    lote.push({ id: String(doc._id), to: doc.to, body: doc.body });
  }
  return lote;
}

// Envía UN mensaje por el canal elegido. Si el puente (encolar) falla y
// fallbackTwilio (default true), reintenta por Twilio para no quedar mudo.
async function enviarUno(to, body, { canal, fallbackTwilio = true } = {}) {
  const usar = canalActivo(canal);
  try {
    return usar === 'bridge' ? await encolarSalida(to, body) : await _twilioUno(to, body);
  } catch (err) {
    console.error(`[Canal] Error enviando por ${usar}:`, err.message);
    if (usar === 'bridge' && fallbackTwilio) {
      console.warn('[Canal] No pude encolar para el puente; reintento por Twilio (respaldo)…');
      try { return await _twilioUno(to, body); } catch (e2) { console.error('[Canal] Twilio respaldo falló:', e2.message); }
    }
    return false;
  }
}

// Valida el secreto del puente en tiempo constante y sin fuga de longitud.
// Sin BRIDGE_TOKEN configurado → false SIEMPRE (endpoints cerrados). El token
// NUNCA se loguea. Es la única barrera de /api/bridge/inbound y /outbox.
function tokenBridgeValido(provided) {
  const crypto = require('crypto');
  const expected = process.env.BRIDGE_TOKEN;
  if (!expected) return false;
  const a = crypto.createHash('sha256').update(String(provided || '')).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = { enviarUno, canalActivo, tokenBridgeValido, encolarSalida, reclamarLoteOutbox };
