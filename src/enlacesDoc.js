// src/enlacesDoc.js — Enlaces de descarga que caducan, para que Corpy pase un documento por WhatsApp.
//
// El puente solo manda texto: en vez del archivo, Corpy manda un enlace de un solo destinatario que vale 24 h.
// Solo se crean para el dueño (agente.js lo comprueba). Cada enlace apunta a un documento de Personal
// (docsPersonal: de un trabajador o de la empresa) y queda apuntado quién lo pidió y cuántas veces se abrió.
//
//   enlacesDoc { _id: token, docId, nombre, para, creado, expira, abierto }
'use strict';
const crypto = require('crypto');
const HORAS = 24;
const BASE = () => (process.env.PUBLIC_URL || process.env.DASHBOARD_URL || 'https://dashboard.corpprojects.es').replace(/\/+$/, '');
async function col() {
  const d = await require('./db').getDB(); const c = d.collection('enlacesDoc');
  c.createIndex({ expira: 1 }, { expireAfterSeconds: 7 * 24 * 3600 }).catch(() => {});
  return c;
}
async function crear(docId, { nombre = null, para = null } = {}) {
  const token = crypto.randomBytes(18).toString('base64url');
  const ahora = new Date();
  await (await col()).insertOne({ _id: token, docId: String(docId), nombre, para, creado: ahora, expira: new Date(ahora.getTime() + HORAS * 3600 * 1000), abierto: 0 });
  return `${BASE()}/d/${token}`;
}
// El documento de un enlace vigente (null si no existe o ha caducado).
async function abrir(token) {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(String(token || ''))) return null;
  const c = await col();
  const e = await c.findOne({ _id: String(token) });
  if (!e || new Date(e.expira) < new Date()) return null;
  await c.updateOne({ _id: e._id }, { $inc: { abierto: 1 }, $set: { abiertoAt: new Date() } });
  return require('./personalDocs').archivo(e.docId);
}
module.exports = { crear, abrir, HORAS };
