// src/waLog.js — Registro de TODAS las conversaciones de WhatsApp (Twilio y puente).
//
// Para revisar desde el dashboard qué escribe cada persona y qué le contesta Corpy,
// y así pulir las respuestas. Entradas y salidas en `whatsappLog` (60 días); las fotos
// que llegan, en `whatsappLogMedia` (14 días, máx. 2 MB cada una).
//
//   whatsappLog { dir:'in'|'out', canal, numero:'+34…', texto, media:[{type,name,mediaId}], ok, origen, ts }

const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const LOG = 'whatsappLog', MEDIA = 'whatsappLogMedia';
const MAX_MEDIA = 2 * 1024 * 1024;
let _idx = false;
async function db() {
  const d = await getDB();
  if (!_idx) {
    _idx = true;
    d.collection(LOG).createIndex({ ts: 1 }, { expireAfterSeconds: 60 * 24 * 3600 }).catch(() => {});
    d.collection(LOG).createIndex({ numero: 1, ts: -1 }).catch(() => {});
    d.collection(MEDIA).createIndex({ ts: 1 }, { expireAfterSeconds: 14 * 24 * 3600 }).catch(() => {});
  }
  return d;
}
function numeroDe(x) {
  const s = String(x || '').replace(/^whatsapp:/i, '').trim();
  if (s.endsWith('@g.us')) return s;
  const d = s.replace(/\D/g, '');
  if (!d) return null;
  return d.length === 9 ? '+34' + d : '+' + d.replace(/^00/, '');
}
const ult9 = x => String(x || '').replace(/\D/g, '').slice(-9);

// Nunca rompe el flujo del mensaje: si el registro falla, solo se avisa en el log.
async function registrar({ dir, canal, numero, texto, media, ok, origen }) {
  try {
    const d = await db();
    const ts = new Date();
    const med = [];
    for (const m of (Array.isArray(media) ? media : [])) {
      if (!m) continue;
      const item = { type: m.type || null, name: m.name || null, mediaId: null };
      if (m.buf && m.buf.length <= MAX_MEDIA && /^image\//i.test(m.type || '')) {
        const r = await d.collection(MEDIA).insertOne({ type: m.type, data: m.buf, bytes: m.buf.length, ts });
        item.mediaId = String(r.insertedId);
      }
      med.push(item);
    }
    await d.collection(LOG).insertOne({ dir, canal: canal || null, numero: numeroDe(numero), texto: String(texto || '').slice(0, 4000) || null, media: med, ok: ok !== false, origen: origen || null, ts });
  } catch (e) { console.warn('[WaLog] no se pudo registrar:', e.message); }
}

// Nombres para mostrar: fichas de usuarios (teléfono/whatsapp), dueño y contactos.
async function nombres(d) {
  const map = {};
  try {
    const us = await require('./users').getUsers(true);
    for (const u of us) for (const t of [u.whatsapp, u.telefono]) { const k = ult9(t); if (k.length === 9) map[k] = { nombre: u.name, rol: u.autonomo && u.autonomo.activo ? 'autónomo' : (u.role || null) }; }
  } catch (e) {}
  try { const cs = await d.collection('contactos').find({}).project({ numero: 1, nombre: 1, rol: 1 }).toArray(); cs.forEach(c => { const k = ult9(c.numero); if (k.length === 9 && !map[k]) map[k] = { nombre: c.nombre || null, rol: c.rol || 'contacto' }; }); } catch (e) {}
  try { const ac = require('./acceso'); (ac.ownersConfigurados ? ac.ownersConfigurados() : []).forEach(o => { const k = ult9(o); if (k.length === 9) map[k] = { nombre: (map[k] && map[k].nombre) || 'Dueño', rol: 'dueño' }; }); } catch (e) {}
  return map;
}

// Mensajes de salida por el puente anteriores al registro (vienen del buzón).
async function salidasBuzon(d, desde, numero) {
  const q = { ts: { $gte: desde } };
  if (numero) q.to = { $regex: ult9(numero) + '$' };
  const docs = await d.collection('whatsappOutbox').find(q).project({ to: 1, body: 1, ts: 1, status: 1 }).sort({ ts: -1 }).limit(2000).toArray();
  return docs.map(o => ({ dir: 'out', canal: 'bridge', numero: numeroDe(o.to), texto: o.body, media: [], ok: o.status !== 'failed', origen: 'buzón', ts: o.ts }));
}
// Une registro + buzón sin duplicar (mismo número, mismo texto, < 3 min).
function unir(log, buzon) {
  const out = [...log];
  for (const b of buzon) {
    const dup = log.some(l => l.dir === 'out' && l.numero === b.numero && l.texto === b.texto && Math.abs(new Date(l.ts) - new Date(b.ts)) < 3 * 60 * 1000);
    if (!dup) out.push(b);
  }
  return out.sort((a, b) => new Date(a.ts) - new Date(b.ts));
}

async function conversaciones({ dias = 7 } = {}) {
  const d = await db();
  const desde = new Date(Date.now() - Math.min(Math.max(Number(dias) || 7, 1), 60) * 24 * 3600 * 1000);
  const [log, buzon, nom] = await Promise.all([
    d.collection(LOG).find({ ts: { $gte: desde } }).project({ dir: 1, numero: 1, texto: 1, media: 1, ts: 1 }).sort({ ts: -1 }).limit(5000).toArray(),
    salidasBuzon(d, desde), nombres(d),
  ]);
  const todos = unir(log, buzon);
  const porNum = {};
  for (const m of todos) {
    if (!m.numero) continue;
    const c = (porNum[m.numero] = porNum[m.numero] || { numero: m.numero, entrantes: 0, salientes: 0, fotos: 0, ultimo: null });
    if (m.dir === 'in') c.entrantes++; else c.salientes++;
    c.fotos += (m.media || []).filter(x => /^image\//i.test(x.type || '')).length;
    if (!c.ultimo || new Date(m.ts) > new Date(c.ultimo.ts)) c.ultimo = { dir: m.dir, texto: m.texto || ((m.media || []).length ? '📎 archivo' : ''), ts: m.ts };
  }
  return Object.values(porNum).map(c => ({ ...c, ...(nom[ult9(c.numero)] || { nombre: null, rol: null }) }))
    .sort((a, b) => (b.entrantes > 0) - (a.entrantes > 0) || new Date(b.ultimo.ts) - new Date(a.ultimo.ts));
}

async function hilo(numero, { dias = 7 } = {}) {
  const d = await db();
  const n = numeroDe(numero);
  if (!n) throw new Error('Número no válido');
  const desde = new Date(Date.now() - Math.min(Math.max(Number(dias) || 7, 1), 60) * 24 * 3600 * 1000);
  const q = n.endsWith('@g.us') ? { numero: n } : { numero: { $regex: ult9(n) + '$' } };
  const [log, buzon, nom] = await Promise.all([
    d.collection(LOG).find({ ...q, ts: { $gte: desde } }).sort({ ts: 1 }).limit(1000).toArray(),
    n.endsWith('@g.us') ? [] : salidasBuzon(d, desde, n), nombres(d),
  ]);
  return { numero: n, ...(nom[ult9(n)] || { nombre: null, rol: null }), mensajes: unir(log.map(m => ({ ...m, _id: String(m._id) })), buzon) };
}

async function media(id) {
  const d = await db();
  const m = await d.collection(MEDIA).findOne({ _id: new ObjectId(String(id)) });
  return m ? { type: m.type, buf: Buffer.from(m.data.buffer || m.data) } : null;
}

module.exports = { registrar, conversaciones, hilo, media, numeroDe };
