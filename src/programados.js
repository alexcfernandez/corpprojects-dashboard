// src/programados.js — ENVÍOS PROGRAMADOS (13/10/2026): «envía estos correos mañana a las 7», «mándale a X a las 8:30…».
// Lo hace el servidor (no depende de ningún ordenador encendido). Cada minuto se mandan los que ya tocan:
//   · tipo 'borrador': un borrador de Gmail ya preparado (se busca por el id del mensaje del enlace «compose=…»).
//   · tipo 'whatsapp': un WhatsApp a un móvil (`a`), a un usuario (`userId`, el móvil se coge de su ficha al enviar)
//     o al dueño (`a: 'dueno'`).
// Si algo falla (borrador borrado, usuario sin móvil…) se avisa al dueño por WhatsApp para que no se pierda.
// Colección `enviosProgramados` { at, tipo, msgId?, a?, userId?, nombre?, texto?, nota, estado: pendiente|enviando|enviado|error|anulado, resultado }.
'use strict';
const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const COL = 'enviosProgramados';

async function crear({ at, tipo, msgId = null, a = null, userId = null, nombre = '', texto = '', nota = '' } = {}, por = '') {
  const cuando = new Date(at);
  if (isNaN(cuando)) throw new Error('¿Cuándo? Fecha y hora no válidas');
  if (tipo === 'borrador') { if (!/^[a-f0-9]{10,24}$/i.test(String(msgId || ''))) throw new Error('Falta el id del borrador (el «compose=…» del enlace)'); }
  else if (tipo === 'whatsapp') {
    if (!String(texto || '').trim()) throw new Error('Falta el texto');
    if (a !== 'dueno' && !userId && !require('./recordatoriosCobro')._movil(a)) throw new Error('¿A quién? Móvil no válido');
    if (userId && !/^[a-f0-9]{24}$/.test(String(userId))) throw new Error('Usuario no válido');
  } else throw new Error('Tipo no válido (borrador o whatsapp)');
  const d = { at: cuando, tipo, msgId, a, userId: userId ? String(userId) : null, nombre: String(nombre || '').slice(0, 80), texto: String(texto || '').slice(0, 4000), nota: String(nota || '').slice(0, 200), estado: 'pendiente', por, creado: new Date() };
  const r = await (await getDB()).collection(COL).insertOne(d);
  return { ok: true, id: String(r.insertedId), ...d };
}

async function lista({ todos = false } = {}) {
  const q = todos ? {} : { estado: { $in: ['pendiente', 'enviando', 'error'] } };
  return (await (await getDB()).collection(COL).find(q).sort({ at: 1 }).limit(100).toArray()).map(x => ({ ...x, id: String(x._id) }));
}

async function anular(id) {
  await (await getDB()).collection(COL).updateOne({ _id: new ObjectId(String(id)), estado: 'pendiente' }, { $set: { estado: 'anulado', anuladoAt: new Date() } });
  return { ok: true };
}

// Envía un borrador de Gmail a partir del id de su mensaje.
async function enviarBorrador(msgId) {
  const gmail = require('./email-intelligence').getGmailClient();
  let pageToken;
  do {
    const r = await gmail.users.drafts.list({ userId: 'me', maxResults: 100, pageToken });
    const d = (r.data.drafts || []).find(x => x.message && x.message.id === msgId);
    if (d) { const s = await gmail.users.drafts.send({ userId: 'me', requestBody: { id: d.id } }); return { enviado: s.data.id }; }
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  throw new Error('El borrador ya no está en Gmail (¿se envió o se borró a mano?)');
}

async function enviarUno(x, { _enviarWA = null, _enviarDueno = null, _enviarBorrador = null } = {}) {
  if (x.tipo === 'borrador') return (_enviarBorrador || enviarBorrador)(x.msgId);
  if (x.a === 'dueno') { const ok = await (_enviarDueno || require('./notifications').sendWhatsApp)(x.texto); if (!ok) throw new Error('El WhatsApp no salió'); return { a: 'dueño' }; }
  let movil = x.a ? require('./recordatoriosCobro')._movil(x.a) : null;
  if (!movil && x.userId) {
    const u = await (await getDB()).collection('users').findOne({ _id: new ObjectId(x.userId) }, { projection: { name: 1, whatsapp: 1, telefono: 1 } });
    movil = u && require('./recordatoriosCobro')._movil(u.whatsapp || u.telefono);
    if (!movil) throw new Error(`${(u && u.name) || x.nombre || 'Esa persona'} no tiene móvil en su ficha`);
  }
  const ok = await (_enviarWA || require('./notifications').sendWhatsAppTo)(movil, x.texto);
  if (!ok) throw new Error('El WhatsApp no salió');
  return { a: movil };
}

// Cada minuto: los que ya tocan. Se «coge» cada uno de forma atómica para no mandarlo dos veces.
async function tick({ ahora = new Date(), ...deps } = {}) {
  const col = (await getDB()).collection(COL);
  let n = 0;
  for (;;) {
    const r = await col.findOneAndUpdate({ estado: 'pendiente', at: { $lte: ahora } }, { $set: { estado: 'enviando', cogido: new Date() } }, { sort: { at: 1 }, returnDocument: 'after' });
    const x = r && (r.value !== undefined ? r.value : r);
    if (!x || !x._id) break;
    try {
      const res = await enviarUno(x, deps);
      await col.updateOne({ _id: x._id }, { $set: { estado: 'enviado', enviadoAt: new Date(), resultado: res } });
      n++;
    } catch (e) {
      await col.updateOne({ _id: x._id }, { $set: { estado: 'error', error: e.message, errorAt: new Date() } });
      const que = x.tipo === 'borrador' ? `el correo programado${x.nota ? ` (${x.nota})` : ''}` : `el WhatsApp programado a ${x.nombre || x.a}`;
      try { await (deps._enviarDueno || require('./notifications').sendWhatsApp)(`⚠️ No he podido enviar ${que}: ${e.message}.`); } catch (_) {}
    }
  }
  return { enviados: n };
}

module.exports = { crear, lista, anular, tick, enviarBorrador };
