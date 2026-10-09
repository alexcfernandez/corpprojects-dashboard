// src/enlaceDoc.js — Enlace de descarga a UN documento de Personal sin entrar al dashboard (9/10/2026): para
// mandárselo a alguien por WhatsApp (p. ej. el contrato del contratista para que lo firme el administrador).
// Firmado con JWT_SECRET y con caducidad; no da acceso a nada más.
'use strict';
const crypto = require('crypto');
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const firma = s => b64u(crypto.createHmac('sha256', String(process.env.JWT_SECRET || '')).update('doc:' + s).digest()).slice(0, 32);
function crear(docId, { dias = 7 } = {}) {
  if (!process.env.JWT_SECRET) throw new Error('Falta JWT_SECRET');
  const exp = Math.floor(Date.now() / 1000) + Math.round(dias * 86400);
  const cuerpo = `${String(docId)}.${exp.toString(36)}`;
  return `${cuerpo}.${firma(cuerpo)}`;
}
function verificar(token) {
  const m = /^([a-f0-9]{24})\.([a-z0-9]+)\.([A-Za-z0-9_-]{32})$/.exec(String(token || ''));
  if (!m || !process.env.JWT_SECRET) return null;
  const esperado = firma(`${m[1]}.${m[2]}`);
  if (!crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(m[3]))) return null;
  if (parseInt(m[2], 36) * 1000 < Date.now()) return null;
  return m[1];
}
const url = (docId, o) => `${process.env.DASHBOARD_URL || 'https://dashboard.corpprojects.es'}/d/${crear(docId, o)}`;
module.exports = { crear, verificar, url };
