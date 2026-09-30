// src/mediaPuente.js — Archivos (foto, PDF, audio) que trae el puente de WhatsApp.
// Se guardan en memoria 30 min (lo que dura el buffer de fotos + margen) y se usan con
// una url 'bridge-media:<id>' por el mismo camino que la media de Twilio.
const crypto = require('crypto');
const TTL = 30 * 60 * 1000, MAX = 300;
const _m = new Map(); // id -> { buf, type, name, ts }

function guardar(m) {
  const type = String((m && m.mimetype) || '').split(';')[0].trim() || 'application/octet-stream';
  if (!m || !m.data) return { url: null, type, name: m && m.fileName, demasiadoGrande: !!(m && m.demasiadoGrande), error: m && m.error };
  const ahora = Date.now();
  for (const [k, v] of _m) if (ahora - v.ts > TTL) _m.delete(k);
  while (_m.size >= MAX) _m.delete(_m.keys().next().value);
  const id = crypto.randomBytes(12).toString('hex');
  _m.set(id, { buf: Buffer.from(m.data, 'base64'), type, name: m.fileName || null, ts: ahora });
  return { url: 'bridge-media:' + id, type, name: m.fileName || null };
}
// null = era del puente pero ha caducado · undefined = no es una url del puente
function get(url) {
  const r = /^bridge-media:([a-f0-9]+)$/.exec(String(url || ''));
  return r ? (_m.get(r[1]) || null) : undefined;
}
async function leer(url) { const x = get(url); return x ? x.buf : null; }

module.exports = { guardar, get, leer };
