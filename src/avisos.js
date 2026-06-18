// src/avisos.js — Responsables por familia + registro persistente de avisos
// Aísla la lógica nueva del sistema de cobros:
//  · familyContacts: a qué email enviar los avisos de cada familia (gestionable
//    desde el admin). Permite pausar/reactivar una familia.
//  · alertLog: registro PERSISTENTE de qué aviso se envió y cuándo, para que un
//    redespliegue no reenvíe los mismos avisos (antes el control era en memoria).

async function getDB() {
  return require('./db').getDB();
}

// ── Responsables por familia ──────────────────────────────────────
async function getFamilyContacts() {
  const db = await getDB();
  return db.collection('familyContacts').find({}).toArray();
}

async function getFamilyContactMap() {
  const list = await getFamilyContacts();
  const map = {};
  list.forEach(c => { map[c.family] = c; });
  return map;
}

// email del responsable de una familia, o null si no hay / está pausada
async function getFamilyEmail(family) {
  if (!family) return null;
  const db = await getDB();
  const doc = await db.collection('familyContacts').findOne({ family });
  if (!doc || doc.paused) return null;
  return (doc.email || '').trim() || null;
}

async function isFamilyPaused(family) {
  if (!family) return false;
  const db = await getDB();
  const doc = await db.collection('familyContacts').findOne({ family });
  return !!(doc && doc.paused);
}

const FREQS   = ['manual', 'weekly', 'biweekly', 'daily', 'twice_daily'];
const FORMATS = ['grouped', 'individual'];
const MODOS   = ['familia', 'cliente'];

// upsert de un responsable. email, paused, freq, format y/o modo.
async function setFamilyContact(family, { email, paused, freq, format, modo } = {}) {
  if (!family) throw new Error('Falta la familia');
  const db = await getDB();
  const set = { family, updatedAt: new Date() };
  if (email  !== undefined) set.email  = String(email || '').trim();
  if (paused !== undefined) set.paused = !!paused;
  if (freq   !== undefined) set.freq   = FREQS.includes(freq)     ? freq   : 'manual';
  if (format !== undefined) set.format = FORMATS.includes(format) ? format : 'grouped';
  if (modo   !== undefined) set.modo   = MODOS.includes(modo)     ? modo   : 'familia';
  await db.collection('familyContacts').updateOne({ family }, { $set: set }, { upsert: true });
  return db.collection('familyContacts').findOne({ family });
}

// Config completa de una familia, con valores por defecto seguros.
async function getFamilyConfig(family) {
  const db = await getDB();
  const doc = (await db.collection('familyContacts').findOne({ family })) || {};
  return {
    family,
    email:  (doc.email || '').trim(),
    paused: !!doc.paused,
    freq:   FREQS.includes(doc.freq)     ? doc.freq   : 'manual',
    format: FORMATS.includes(doc.format) ? doc.format : 'grouped',
    modo:   MODOS.includes(doc.modo)     ? doc.modo   : 'familia'
  };
}

// ── Registro persistente de avisos enviados ───────────────────────
// Clave por día: un aviso (factura + nivel) se envía una vez al día.
function _key(invoiceId, level) {
  const today = new Date().toISOString().slice(0, 10);
  return `${invoiceId}|${level}|${today}`;
}

async function wasAlertSentToday(invoiceId, level) {
  const db = await getDB();
  const doc = await db.collection('alertLog').findOne({ key: _key(invoiceId, level) });
  return !!doc;
}

async function markAlertSent(invoiceId, level) {
  const db = await getDB();
  const key = _key(invoiceId, level);
  await db.collection('alertLog').updateOne(
    { key },
    { $set: { key, invoiceId, level, sentAt: new Date() } },
    { upsert: true }
  );
}

// ── Pausa global de avisos (interruptor de emergencia) ────────────
async function isGlobalPaused() {
  const db = await getDB();
  const doc = await db.collection('appSettings').findOne({ key: 'avisos' });
  return !!(doc && doc.globalPaused);
}

async function setGlobalPaused(paused) {
  const db = await getDB();
  await db.collection('appSettings').updateOne(
    { key: 'avisos' },
    { $set: { key: 'avisos', globalPaused: !!paused, updatedAt: new Date() } },
    { upsert: true }
  );
  return !!paused;
}

// Pausa independiente para los avisos de PEDIDOS DE TRABAJO.
// Por defecto PAUSADO (true) hasta que el usuario lo active.
async function isPedidosPaused() {
  const db = await getDB();
  const doc = await db.collection('appSettings').findOne({ key: 'pedidosAvisos' });
  if (!doc) return true;            // sin configurar = pausado por seguridad
  return !!doc.paused;
}

async function setPedidosPaused(paused) {
  const db = await getDB();
  await db.collection('appSettings').updateOne(
    { key: 'pedidosAvisos' },
    { $set: { key: 'pedidosAvisos', paused: !!paused, updatedAt: new Date() } },
    { upsert: true }
  );
  return !!paused;
}

// Interruptor de ESCRITURA EN STELORDER (Fase 4). Por defecto APAGADO.
async function isStelWriteEnabled() {
  const db = await getDB();
  const doc = await db.collection('appSettings').findOne({ key: 'stelWrite' });
  return !!(doc && doc.enabled);
}

async function setStelWriteEnabled(enabled) {
  const db = await getDB();
  await db.collection('appSettings').updateOne(
    { key: 'stelWrite' },
    { $set: { key: 'stelWrite', enabled: !!enabled, updatedAt: new Date() } },
    { upsert: true }
  );
  return !!enabled;
}

module.exports = {
  getFamilyContacts, getFamilyContactMap, getFamilyEmail, isFamilyPaused, setFamilyContact, getFamilyConfig,
  wasAlertSentToday, markAlertSent,
  isGlobalPaused, setGlobalPaused,
  isPedidosPaused, setPedidosPaused,
  isStelWriteEnabled, setStelWriteEnabled
};
