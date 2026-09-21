// src/push.js — Notificaciones push de la PWA (Web Push / VAPID).
//
// Canal PRINCIPAL de los avisos de fichaje: gratis y sin riesgo de baneo (a diferencia
// de WhatsApp por Baileys). Cada dispositivo se suscribe una vez desde la app.
//  · Claves VAPID: de env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY) o, si no están, se
//    generan UNA vez y se guardan en Mongo (pushConfig) → cero configuración y las
//    suscripciones siguen valiendo entre despliegues.
//  · Suscripciones en `pushSubs`: { endpoint (único), keys, kind: 'worker'|'admin',
//    userId, name, role }. Las caducadas (404/410) se borran solas al enviar.

const EMPRESA = process.env.EMPRESA_ID || 'corp';
const COL = 'pushSubs';

async function getDB() { return require('./db').getDB(); }

let _vapid = null;
async function getVapid() {
  if (_vapid) return _vapid;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    _vapid = { publicKey: process.env.VAPID_PUBLIC_KEY.trim(), privateKey: process.env.VAPID_PRIVATE_KEY.trim() };
    return _vapid;
  }
  const db = await getDB();
  let doc = await db.collection('pushConfig').findOne({ _id: 'vapid' });
  if (!doc) {
    const k = require('web-push').generateVAPIDKeys();
    try { await db.collection('pushConfig').insertOne({ _id: 'vapid', publicKey: k.publicKey, privateKey: k.privateKey, createdAt: new Date() }); }
    catch (e) { /* otra instancia la creó a la vez: leemos la suya */ }
    doc = await db.collection('pushConfig').findOne({ _id: 'vapid' });
    console.log('[Push] Claves VAPID generadas y guardadas.');
  }
  _vapid = { publicKey: doc.publicKey, privateKey: doc.privateKey };
  return _vapid;
}
async function publicKey() { return (await getVapid()).publicKey; }

async function _webpush() {
  const wp = require('web-push');
  const v = await getVapid();
  wp.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:hola@corpprojects.es', v.publicKey, v.privateKey);
  return wp;
}

// Guarda (o actualiza) la suscripción de ESTE dispositivo para este usuario.
async function subscribe(quien, subscription, userAgent) {
  const s = subscription || {};
  if (!s.endpoint || !/^https:\/\//.test(s.endpoint) || !s.keys || !s.keys.p256dh || !s.keys.auth) throw new Error('Suscripción no válida');
  const db = await getDB();
  await db.collection(COL).updateOne(
    { endpoint: s.endpoint },
    { $set: {
        empresaId: EMPRESA, endpoint: s.endpoint, keys: { p256dh: String(s.keys.p256dh), auth: String(s.keys.auth) },
        kind: quien.kind, userId: String(quien.userId || ''), name: quien.name || '', role: quien.role || '',
        userAgent: String(userAgent || '').slice(0, 300), updatedAt: new Date(),
      }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );
  return { ok: true };
}
async function unsubscribe(endpoint) {
  if (!endpoint) return { ok: true };
  const db = await getDB();
  await db.collection(COL).deleteOne({ endpoint: String(endpoint) });
  return { ok: true };
}

// Envía a una lista de suscripciones. Devuelve cuántas llegaron. payload: {title, body, url, tag}.
async function _enviar(subs, payload) {
  if (!subs || !subs.length) return 0;
  const wp = await _webpush();
  const db = await getDB();
  const data = JSON.stringify({ title: payload.title || 'Corp Projects', body: payload.body || '', url: payload.url || '/', tag: payload.tag || undefined });
  let ok = 0;
  await Promise.all(subs.map(async s => {
    try {
      await wp.sendNotification({ endpoint: s.endpoint, keys: s.keys }, data, { TTL: payload.ttl || 3600, urgency: 'high' });
      ok++;
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) { await db.collection(COL).deleteOne({ endpoint: s.endpoint }).catch(() => {}); }
      else console.warn('[Push] fallo:', e && (e.statusCode || e.message));
    }
  }));
  return ok;
}

// A todos los dispositivos de un TRABAJADOR. Devuelve nº de dispositivos a los que llegó.
async function sendToWorker(userId, payload) {
  const db = await getDB();
  const subs = await db.collection(COL).find({ empresaId: EMPRESA, kind: 'worker', userId: String(userId) }).toArray();
  return _enviar(subs, payload);
}
// A oficina: dispositivos de admins con rol Dueño/Oficina.
async function sendToOficina(payload) {
  const db = await getDB();
  const { normalizeRole } = require('./users');
  const subs = (await db.collection(COL).find({ empresaId: EMPRESA, kind: 'admin' }).toArray())
    .filter(s => ['owner', 'oficina'].includes(normalizeRole(s.role)));
  return _enviar(subs, payload);
}
async function sendToEndpoint(endpoint, payload) {
  const db = await getDB();
  const s = await db.collection(COL).findOne({ endpoint: String(endpoint) });
  return _enviar(s ? [s] : [], payload);
}
// Qué trabajadores tienen al menos un dispositivo con avisos activados.
async function workersConPush() {
  const db = await getDB();
  const subs = await db.collection(COL).find({ empresaId: EMPRESA, kind: 'worker' }).toArray();
  return new Set(subs.map(s => String(s.userId)));
}

module.exports = { publicKey, subscribe, unsubscribe, sendToWorker, sendToOficina, sendToEndpoint, workersConPush };
