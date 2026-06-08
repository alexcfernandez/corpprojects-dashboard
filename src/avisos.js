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

// upsert de un responsable. email y/o paused.
async function setFamilyContact(family, { email, paused } = {}) {
  if (!family) throw new Error('Falta la familia');
  const db = await getDB();
  const set = { family, updatedAt: new Date() };
  if (email  !== undefined) set.email  = String(email || '').trim();
  if (paused !== undefined) set.paused = !!paused;
  await db.collection('familyContacts').updateOne({ family }, { $set: set }, { upsert: true });
  return db.collection('familyContacts').findOne({ family });
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

module.exports = {
  getFamilyContacts, getFamilyContactMap, getFamilyEmail, isFamilyPaused, setFamilyContact,
  wasAlertSentToday, markAlertSent
};
