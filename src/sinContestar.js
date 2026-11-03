// src/sinContestar.js — Correos de clientes, administradores y gestoría que nadie ha contestado (Álex, 3/11/2026: «lo
// que sobre todo no quiero que se me pase son contestaciones: avisar al cliente, que no se nos pierda la cita, estar
// siempre encima»). Caso: Jordi Garrido (Finques Company) escribió el 19/10 por las goteras de Bellpuig 41 3-1, nadie le
// contestó y el 2/11 amenazó con mandar a otro industrial y pasarnos la factura.
//   · Candidatos: colección `emails` (la llena email-intelligence desde el Gmail que recibe hola@) de los últimos 14 días,
//     PENDIENTE, de categorías que piden respuesta, sin remitentes automáticos (noreply, bancos, DEHú —eso lo lleva
//     notifOficiales—, informes…), en los que la IA no dijo «archivar» o «leer», y con más de 24 h laborables (sin
//     contar sábados ni domingos). Del mismo hilo, solo el último.
//   · ¿Contestado? En Gmail: un mensaje nuestro (SENT) en el hilo después del correo, o algo enviado a ese remitente
//     después. Se guarda en el doc (`contestado: {at, por}`) para no volver a preguntar. Si la petición del grupo de
//     WhatsApp ya dice `respondimos`, también vale (las de canal correo no: ahí la IA lo adivina y manda Gmail).
//   · «No necesita respuesta» desde el correo en el dashboard → `sinRespuesta: {at, por}`.
//   · Aviso L-V 9:15 y 16:15 a Álex + push a oficina; cada correo como mucho 3 veces. SIN_CONTESTAR=off lo apaga.
'use strict';
const { ObjectId } = require('mongodb');

const CATEGORIAS = /^(COMUNICACION|GESTORIA|PRESUPUESTO|INCIDENCIA)/;
const AUTOMATICO = /no-?reply|donotreply|do-not-reply|mailer-daemon|bounce|newsletter|notificaci|notifications?@|reportes?@|alertas?@|dehu|\.gob\.es|seg-social|agenciatributaria|revolut|santander|caixabank|bbva|sabadell|bankinter|ingdirect|quartix|stelorder|xvia|multivia|amazon|seur|corpprojects/i;
// Lo que la IA ya dijo del correo: si solo hay que archivarlo, leerlo o tenerlo en cuenta (circulares, confirmaciones,
// avisos de portal…), no pide respuesta. Si pide decidir, confirmar, enviar… o es urgente, sí.
const SOLO_LEER = /^(archivar|leer|tener en cuenta|registrar)/i;
const PIDE_ALGO = /respond|contest|confirm|decid|aprob|envi|firm|devolv|llam|avis|solicit/i;
const pideRespuesta = e => !SOLO_LEER.test(String(e.accionSugerida || '').trim()) && (['ALTA', 'MEDIA'].includes(e.urgencia) || PIDE_ALGO.test(e.accionSugerida || ''));
// Varios correos del mismo hilo («RE: Oferta…», «RV: …») cuentan como uno: se muestra el último, pero el tiempo cuenta
// desde el primero (si vuelven a escribir quejándose, no se reinicia el reloj).
const claveHilo = e => correoDe(e.de).replace(/@.*/, '') + '|' + String(e.asunto || '').replace(/^\s*((re|rv|fw|fwd|tr)\s*:\s*)+/i, '').toLowerCase().trim();
const DIAS = 14, HORAS = 24, MAX_AVISOS = 3, MAX_LISTA = 12;

const correoDe = de => (String(de || '').match(/<([^>]+)>/) || [null, String(de || '')])[1].trim().toLowerCase();
const nombreDe = de => String(de || '').replace(/<[^>]*>/, '').replace(/["']/g, '').trim() || correoDe(de);
const corto = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// Horas entre dos fechas sin contar sábados ni domingos (hora de Madrid aproximada: +1 h; en el borde de medianoche da igual).
function horasLaborables(desde, hasta = new Date()) {
  let h = 0;
  for (let t = new Date(desde).getTime(); t < hasta.getTime(); t += 3600000) {
    const dia = new Date(t + 3600000).getUTCDay();
    if (dia !== 0 && dia !== 6) h++;
  }
  return h;
}
const haceCuanto = (fecha, ahora = new Date()) => {
  const h = (ahora - new Date(fecha)) / 3600000;
  return h >= 48 ? `hace ${Math.floor(h / 24)} días` : `hace ${Math.round(h)} h`;
};

// ¿Le hemos contestado? Primero el hilo (un SENT posterior); si no, cualquier enviado a ese remitente después.
async function contestadoEnGmail(gmail, e) {
  const desde = new Date(e.fecha).getTime();
  const msg = await gmail.users.messages.get({ userId: 'me', id: e.gmailId, format: 'metadata', metadataHeaders: ['From'] });
  const threadId = msg.data.threadId;
  if (threadId) {
    const th = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'metadata', metadataHeaders: ['From'] });
    const nuestro = (th.data.messages || []).find(m => (m.labelIds || []).includes('SENT') && Number(m.internalDate) > desde);
    if (nuestro) return { at: new Date(Number(nuestro.internalDate)), por: 'gmail (en el hilo)' };
  }
  const addr = correoDe(e.de);
  if (addr && addr.includes('@')) {
    const l = await gmail.users.messages.list({ userId: 'me', q: `in:sent to:${addr} after:${Math.floor(desde / 1000)}`, maxResults: 1 });
    const m = (l.data.messages || [])[0];
    if (m) return { at: new Date(), por: 'gmail (enviado a ese remitente)' };
  }
  return null;
}

// Los que siguen sin contestar (y guarda en cada correo lo que se ha averiguado).
async function pendientes({ _db = null, _gmail = null, ahora = new Date() } = {}) {
  const db = _db || await require('./db').getDB();
  const desde = new Date(ahora.getTime() - DIAS * 86400000);
  const cs = await db.collection('emails').find({ fecha: { $gte: desde }, estado: 'PENDIENTE', contestado: null, sinRespuesta: null })
    .project({ cuerpo: 0, adjuntos: 0 }).sort({ fecha: 1 }).toArray();
  const ultimos = new Map();
  for (const e of cs.filter(e => CATEGORIAS.test(e.categoria || '') && !AUTOMATICO.test(e.de || '') && e.gmailId && pideRespuesta(e))) {
    const k = claveHilo(e), antes = ultimos.get(k);
    ultimos.set(k, { ...e, desde: antes ? antes.desde : e.fecha });
  }
  const cand = [...ultimos.values()].filter(e => horasLaborables(e.desde, ahora) >= HORAS);
  if (!cand.length) return [];
  let gmail = _gmail;
  if (!gmail) { try { gmail = require('./email-intelligence').getGmailClient(); } catch (err) { gmail = null; } }
  const out = [];
  for (const e of cand) {
    // Contestado en el grupo de WhatsApp (petición de canal grupo con ese correo).
    const p = await db.collection('peticionesGrupo').findOne({ gmailIds: e.gmailId, respondimos: true, canal: { $ne: 'correo' } }, { projection: { _id: 1 } });
    if (p) { await db.collection('emails').updateOne({ _id: e._id }, { $set: { contestado: { at: ahora, por: 'grupo de WhatsApp' } } }); continue; }
    let c = null, sinComprobar = false;
    try { c = gmail ? await contestadoEnGmail(gmail, e) : null; if (!gmail) sinComprobar = true; }
    catch (err) { sinComprobar = true; console.warn('[SinContestar] Gmail:', err.message); }
    if (c) { await db.collection('emails').updateOne({ _id: e._id }, { $set: { contestado: c } }); continue; }
    out.push({ ...e, sinComprobar });
  }
  return out;
}

const textoAviso = (l, ahora = new Date()) => `✉️ *Correos sin contestar* (${l.length})\n` +
  l.slice(0, MAX_LISTA).map(e => `• *${corto(nombreDe(e.de), 40)}* — «${corto(e.asunto, 70)}» · ${haceCuanto(e.desde || e.fecha, ahora)}${e.sinComprobar ? ' (sin poder mirar Gmail)' : ''}` +
    (e.resumen ? `\n  ${corto(e.resumen, 120)}` : '')).join('\n') + (l.length > MAX_LISTA ? `\n… y ${l.length - MAX_LISTA} más (en Emails).` : '') +
  `\n\nContéstalos, o en Emails márcalos «No necesita respuesta».`;

async function aviso({ avisar = true, _db = null, _gmail = null, _enviar = null, _push = null, ahora = new Date() } = {}) {
  if (process.env.SIN_CONTESTAR === 'off') return { enviado: false, motivo: 'apagado' };
  const db = _db || await require('./db').getDB();
  const l = (await pendientes({ _db: db, _gmail, ahora })).filter(e => (e.avisosSinContestar || 0) < MAX_AVISOS);
  if (!l.length) return { enviado: false, n: 0 };
  if (avisar) {
    const texto = textoAviso(l, ahora);
    try { await (_enviar || require('./notifications').sendWhatsApp)(texto); } catch (e) { console.warn('[SinContestar] WhatsApp:', e.message); }
    try { await (_push || (p => require('./push').sendToOficina(p)))({ title: `${l.length} correo${l.length > 1 ? 's' : ''} sin contestar`, body: l.map(e => corto(nombreDe(e.de), 30)).join(' · ').slice(0, 140), url: '/#emails', tag: 'sin-contestar' }); } catch (e) {}
    for (const e of l) await db.collection('emails').updateOne({ _id: e._id }, { $inc: { avisosSinContestar: 1 }, $set: { ultimoAvisoSinContestar: ahora } });
  }
  return { enviado: avisar, n: l.length, correos: l.map(e => ({ de: nombreDe(e.de), asunto: e.asunto, desde: e.desde })) };
}

async function marcarSinRespuesta(id, por, { _db = null } = {}) {
  const db = _db || await require('./db').getDB();
  const r = await db.collection('emails').updateOne({ _id: new ObjectId(String(id)) }, { $set: { sinRespuesta: { at: new Date(), por: por || 'Oficina' } } });
  if (!r.matchedCount) throw new Error('No encuentro ese correo');
  return { ok: true };
}

module.exports = { pendientes, aviso, marcarSinRespuesta, textoAviso, horasLaborables, contestadoEnGmail };
