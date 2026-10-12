// src/encargos.js — ENCARGOS A TRABAJADORES (12/10/2026): lo que Álex pide a alguien por Corpy («pídele a Javi la talla de
// botas», «dile a Manolo que traiga el carnet de conducir») para que no se olvide:
//   · Corpy se lo pide por WhatsApp «de parte de Álex»;
//   · se lo recuerda (L-V 10:35, no en festivos): al día siguiente y a los 2 días; si sigue sin contestar, avisa a Álex
//     una sola vez;
//   · cuando contesta (texto, audio o foto/papel) se apunta en el encargo, se le pasa a Álex y se cierra; si contesta
//     «mañana te lo digo» o parecido, se le pasa igual pero sigue abierto (y siguen los recordatorios);
//   · en Inicio sale lo que está esperando. Colección `encargos`.
'use strict';
const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const COL = 'encargos';
const H = 3600 * 1000;
const primer = n => { const p = String(n || '').trim().split(/\s+/)[0] || ''; return p ? p.charAt(0).toUpperCase() + p.slice(1) : ''; };
const hoyISO = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
// Respuestas que NO cumplen el encargo («mañana te lo digo», «vale», «no lo tengo»…): se pasan a Álex pero sigue abierto.
const APLAZA = /^\s*(ok|vale|valee*|vale vale|d'acord|entendido|perfecto|si|sí|de acuerdo|👍|ok ok)[\s.!]*$|\b(ma[nñ]ana|luego|despu[eé]s|esta tarde|el lunes|el martes|cuando pueda|ahora no|ahora mismo no|no lo tengo|no s[eé]|lo miro|lo busco|te digo|te lo digo|te lo paso|te lo mando|ya te|m[aá]s tarde)\b/i;

async function _usuario(db, userId) { return db.collection('users').findOne({ _id: new ObjectId(String(userId)) }, { projection: { name: 1, whatsapp: 1, telefono: 1 } }); }

// Crear: `que` = resumen corto («talla de botas»); `mensaje` = lo que se le dice al trabajador.
async function crear({ userId, que, mensaje, por = 'Álex' } = {}, { _enviar = null } = {}) {
  const db = await getDB();
  const u = await _usuario(db, userId);
  if (!u) throw new Error('No encuentro ese trabajador');
  const movil = require('./recordatoriosCobro')._movil(u.whatsapp || u.telefono);
  if (!movil) throw new Error(`${u.name} no tiene un móvil en su ficha: pónselo en Usuarios`);
  que = String(que || '').trim().slice(0, 120); mensaje = String(mensaje || que).trim().slice(0, 600);
  if (!que) throw new Error('¿Qué le pido?');
  const txt = `Hola ${primer(u.name)} 👋 De parte de Álex: ${mensaje}\n\nContéstame por aquí cuando lo tengas (si es una foto o un papel, mándalo aquí mismo). ¡Gracias!`;
  const ok = await (_enviar || require('./notifications').sendWhatsAppTo)(movil, txt);
  if (ok === false) throw new Error('No se pudo enviar el WhatsApp (mira que Corpy esté conectado)');
  const doc = { userId: String(userId), nombre: u.name, movil, que, mensaje, estado: 'abierto', por, at: new Date(), recordatorios: 0, respuestas: [] };
  const r = await db.collection(COL).insertOne(doc);
  return { ok: true, id: String(r.insertedId), nombre: u.name, texto: txt };
}

async function abiertosDe(userId) {
  if (!userId) return [];
  const db = await getDB();
  return db.collection(COL).find({ userId: String(userId), estado: 'abierto' }).sort({ at: 1 }).toArray();
}

async function lista({ abiertos = true } = {}) {
  const db = await getDB();
  const l = await db.collection(COL).find(abiertos ? { estado: 'abierto' } : {}).sort({ at: -1 }).limit(100).toArray();
  const ahora = Date.now();
  return l.map(e => ({ id: String(e._id), userId: e.userId, nombre: e.nombre, que: e.que, estado: e.estado, at: e.at, dias: Math.floor((ahora - new Date(e.at)) / (24 * H)), recordatorios: e.recordatorios || 0, ultimaRespuesta: (e.respuestas || []).slice(-1)[0] || null }));
}

async function cerrar(id, { como = 'hecho', por = 'Álex' } = {}) {
  const db = await getDB();
  await db.collection(COL).updateOne({ _id: new ObjectId(String(id)) }, { $set: { estado: como === 'cancelado' ? 'cancelado' : 'hecho', cerradoAt: new Date(), cerradoPor: por } });
  return { ok: true };
}

// El trabajador contesta (texto o archivo). Devuelve la respuesta para él, o null si no tenía encargos abiertos.
async function respuesta(userId, nombreTrab, { texto = '', docs = [] } = {}, { _avisar = null } = {}) {
  const abiertos = await abiertosDe(userId);
  if (!abiertos.length) return null;
  const e = abiertos[abiertos.length - 1];   // el más reciente: es al que suele contestar
  const db = await getDB();
  const aplaza = !docs.length && APLAZA.test(String(texto || ''));
  const r = { at: new Date(), texto: String(texto || '').slice(0, 1000), docs: docs.map(d => d.id).filter(Boolean) };
  await db.collection(COL).updateOne({ _id: e._id }, { $push: { respuestas: r }, ...(aplaza ? {} : { $set: { estado: 'hecho', cerradoAt: new Date(), cerradoPor: 'respuesta del trabajador' } }) });
  const aviso = `💬 *${nombreTrab || e.nombre}* contesta a tu encargo «${e.que}»:\n${texto ? `"${String(texto).slice(0, 400)}"` : ''}${docs.length ? `${texto ? '\n' : ''}📎 ${docs.length} archivo${docs.length > 1 ? 's' : ''} (guardado${docs.length > 1 ? 's' : ''} en su carpeta de Personal)` : ''}${aplaza ? '\n\n(Parece que aún no lo tiene: sigo recordándoselo.)' : '\n\n✔ Encargo cerrado.'}`;
  try { await (_avisar || require('./notifications').sendWhatsApp)(aviso); } catch (err) {}
  return aplaza ? `👍 Apuntado, ${primer(nombreTrab || e.nombre)}. Cuando lo tengas, mándamelo por aquí.` : `✅ ¡Gracias, ${primer(nombreTrab || e.nombre)}! Se lo paso a Álex.`;
}

// Recordatorios (cron L-V 10:35): mismo calendario que los papeles del alta.
async function recordar({ hoy = new Date(), _enviar = null, _avisarJefe = null } = {}) {
  try { if (await require('./festivos').esFestivo(hoyISO(hoy))) return { recordados: 0, festivo: true }; } catch (e) {}
  const db = await getDB();
  const l = await db.collection(COL).find({ estado: 'abierto' }).toArray();
  let n = 0, avisos = 0;
  for (const e of l) {
    const desde = hoy - new Date(e.ultimoRecordatorio || (e.respuestas || []).slice(-1).map(r => r.at)[0] || e.at);
    if ((e.recordatorios || 0) >= 2) {
      if (!e.avisadoJefe && desde >= 44 * H) {
        const dias = Math.round((hoy - new Date(e.at)) / (24 * H));
        try { await (_avisarJefe || require('./notifications').sendWhatsApp)(`⏰ *${e.nombre}* sigue sin contestar a tu encargo «${e.que}» (hace ${dias} días, recordado 2 veces). ¿Le llamas?\n\nCuando esté, dime *«${primer(e.nombre)} ya lo ha hecho»* y lo cierro.`); avisos++; await db.collection(COL).updateOne({ _id: e._id }, { $set: { avisadoJefe: hoy } }); } catch (err) {}
      }
      continue;
    }
    if (desde < ((e.recordatorios || 0) === 0 ? 20 : 44) * H) continue;
    const txt = `Hola ${primer(e.nombre)} 👋 Te recuerdo lo que te pidió Álex: ${e.mensaje}\n\nContéstame por aquí cuando lo tengas. ¡Gracias!`;
    const ok = await (_enviar || require('./notifications').sendWhatsAppTo)(e.movil, txt);
    if (ok !== false) { n++; await db.collection(COL).updateOne({ _id: e._id }, { $set: { ultimoRecordatorio: hoy }, $inc: { recordatorios: 1 } }); }
  }
  return { recordados: n, avisosJefe: avisos };
}

// Para Inicio: cuántos encargos esperan y de quién.
async function resumenInicio() {
  const l = await lista();
  return { n: l.length, personas: [...new Set(l.map(e => e.nombre))], viejos: l.filter(e => e.dias >= 3).length };
}

module.exports = { crear, abiertosDe, lista, cerrar, respuesta, recordar, resumenInicio, _APLAZA: APLAZA };
