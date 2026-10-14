// src/encargos.js — ENCARGOS A TRABAJADORES (12/10/2026): lo que Álex pide a alguien por Corpy («pídele a Javi la talla de
// botas», «dile a Manolo que traiga el carnet de conducir») para que no se olvide:
//   · Corpy se lo pide por WhatsApp con su propia autoridad (la oficina), no «de parte de Álex»: se le contesta a él;
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
// `tipo`: 'libre' (lo normal) o 'tallas' (tallas de ropa y calzado + fecha de nacimiento: la respuesta se lee con IA y se
// guarda en su ficha). `textoCompleto`: el mensaje entero (sin el «De parte de Álex»). `cuando` (AAAA-MM-DD futura):
// no se le dice nada hasta ese día (p. ej. «recuérdale el lunes a David que devuelva la batidora»).
async function crear({ userId, que, mensaje, por = 'Álex', tipo = 'libre', textoCompleto = null, cuando = null, origen = null } = {}, { _enviar = null } = {}) {
  const db = await getDB();
  const u = await _usuario(db, userId);
  if (!u) throw new Error('No encuentro ese trabajador');
  const movil = require('./recordatoriosCobro')._movil(u.whatsapp || u.telefono);
  if (!movil) throw new Error(`${u.name} no tiene un móvil en su ficha: pónselo en Usuarios`);
  que = String(que || '').trim().slice(0, 120); mensaje = String(mensaje || que).trim().slice(0, 600);
  if (!que) throw new Error('¿Qué le pido?');
  // Corpy habla con su propia autoridad (la oficina), no «de parte de Álex»: se le contesta A ÉL, sin esperar a ver a nadie.
  const txt = textoCompleto || `Hola ${primer(u.name)} 👋 Soy Corpy, de la oficina de Corp Projects. ${mensaje}\n\nContéstame por aquí en cuanto lo tengas (si es una foto o un papel, mándalo aquí mismo). Lo apunto yo, no hace falta esperar a decírselo a nadie.`;
  const diferido = /^\d{4}-\d{2}-\d{2}$/.test(String(cuando || '')) && cuando > hoyISO();
  if (!diferido) {
    const ok = await (_enviar || require('./notifications').sendWhatsAppTo)(movil, txt);
    if (ok === false) throw new Error('No se pudo enviar el WhatsApp (mira que Corpy esté conectado)');
  }
  const doc = { userId: String(userId), nombre: u.name, movil, que, mensaje, tipo, estado: diferido ? 'programado' : 'abierto', cuando: diferido ? cuando : null, textoInicial: txt, origen, por, at: new Date(), recordatorios: 0, respuestas: [] };
  const r = await db.collection(COL).insertOne(doc);
  return { ok: true, id: String(r.insertedId), nombre: u.name, texto: txt, programado: diferido ? cuando : null };
}

async function abiertosDe(userId) {
  if (!userId) return [];
  const db = await getDB();
  return db.collection(COL).find({ userId: String(userId), estado: 'abierto' }).sort({ at: 1 }).toArray();
}

async function lista({ abiertos = true } = {}) {
  const db = await getDB();
  const l = await db.collection(COL).find(abiertos ? { estado: { $in: ['abierto', 'programado'] } } : {}).sort({ at: -1 }).limit(100).toArray();
  const ahora = Date.now();
  return l.map(e => ({ id: String(e._id), userId: e.userId, nombre: e.nombre, que: e.que, estado: e.estado, cuando: e.cuando || null, origen: e.origen || null, at: e.at, respuestas: (e.respuestas || []).map(r => ({ at: r.at, texto: r.texto })), dias: Math.floor((ahora - new Date(e.at)) / (24 * H)), recordatorios: e.recordatorios || 0, ultimaRespuesta: (e.respuestas || []).slice(-1)[0] || null }));
}

async function cerrar(id, { como = 'hecho', por = 'Álex' } = {}) {
  const db = await getDB();
  await db.collection(COL).updateOne({ _id: new ObjectId(String(id)) }, { $set: { estado: como === 'cancelado' ? 'cancelado' : 'hecho', cerradoAt: new Date(), cerradoPor: por } });
  return { ok: true };
}

// ¿A cuál de sus encargos abiertos contesta? (13/10: a David le llegaron a la vez «tallas» y «cursos» y su
// «camiseta M, pantalón 40…» cerró el de cursos, porque se cogía siempre el último). Tallas si suena a tallas;
// una foto o un papel, a lo que no es tallas; si no, al que comparta más palabras con lo que dice (o el último).
const RE_TALLAS = /\b(camiseta|sudadera|pantal\w*|zapat\w*|calzado|botas?|tallas?|xxl|xl|xs)\b/i;
const _n = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ');
function elegir(abiertos, texto = '', docs = []) {
  if (abiertos.length <= 1) return abiertos[0] || null;
  const tallas = abiertos.filter(e => e.tipo === 'tallas'), otros = abiertos.filter(e => e.tipo !== 'tallas');
  if (texto && !docs.length && tallas.length && RE_TALLAS.test(texto)) return tallas[tallas.length - 1];
  const cand = otros.length ? otros : abiertos;
  if (cand.length === 1) return cand[0];
  const pal = x => new Set(_n(x).split(/\s+/).filter(w => w.length >= 4));
  const t = pal(texto); let mejor = cand[cand.length - 1], p = 0;
  for (const e of cand) { const c = [...pal(`${e.que} ${e.mensaje || ''}`)].filter(w => t.has(w)).length; if (c > p) { p = c; mejor = e; } }
  return mejor;
}

// El trabajador contesta (texto o archivo). Devuelve la respuesta para él, o null si no tenía encargos abiertos.
async function respuesta(userId, nombreTrab, { texto = '', docs = [] } = {}, { _avisar = null } = {}) {
  const abiertos = await abiertosDe(userId);
  if (!abiertos.length) return null;
  let e = elegir(abiertos, texto, docs);
  const db = await getDB();
  if (e.tipo === 'tallas' && texto) {
    const r = await require('./fichaDatos').respuesta(e, userId, nombreTrab, texto, { _avisar, soloSiEntiende: true });
    if (r) return r;
    // No eran tallas: a otro encargo suyo si lo hay; si no, se le pasa a Álex tal cual (que no se pierda).
    const otros = abiertos.filter(x => x.tipo !== 'tallas');
    if (!otros.length) {
      try { await (_avisar || require('./notifications').sendWhatsApp)(`💬 *${nombreTrab || e.nombre}* escribe al bot (le pedí las tallas, pero dice otra cosa):\n"${String(texto).slice(0, 500)}"`); } catch (err) {}
      return `👍 Se lo paso a la oficina. Y cuando puedas, me dices tu ${e.mensaje || 'talla de camiseta, pantalón y calzado'}.`;
    }
    e = elegir(otros, texto, docs);
  }
  // Pregunta de una compra («¿para qué obra?», «¿qué pasó con el anterior?»): se guarda en la compra y pone la obra.
  let deCompra = null;
  if (e.origen && e.origen.tipo === 'compra' && texto) { try { deCompra = await require('./comprasVigilancia').respuestaCompra(e.origen, texto, nombreTrab || e.nombre); } catch (err) {} }
  const aplaza = !docs.length && APLAZA.test(String(texto || ''));
  const r = { at: new Date(), texto: String(texto || '').slice(0, 1000), docs: docs.map(d => d.id).filter(Boolean) };
  await db.collection(COL).updateOne({ _id: e._id }, { $push: { respuestas: r }, ...(aplaza ? {} : { $set: { estado: 'hecho', cerradoAt: new Date(), cerradoPor: 'respuesta del trabajador' } }) });
  const aviso = `💬 *${nombreTrab || e.nombre}* contesta a tu encargo «${e.que}»:\n${texto ? `"${String(texto).slice(0, 400)}"` : ''}${docs.length ? `${texto ? '\n' : ''}📎 ${docs.length} archivo${docs.length > 1 ? 's' : ''} (guardado${docs.length > 1 ? 's' : ''} en su carpeta de Personal)` : ''}${aplaza ? '\n\n(Parece que aún no lo tiene: sigo recordándoselo.)' : '\n\n✔ Encargo cerrado.'}${deCompra && deCompra.obra ? `\n🏗️ Compra apuntada en la obra *${deCompra.obra}*.` : ''}`;
  try { await (_avisar || require('./notifications').sendWhatsApp)(aviso); } catch (err) {}
  return aplaza ? `👍 Apuntado, ${primer(nombreTrab || e.nombre)}. Te lo vuelvo a preguntar si no me llega; cuando lo tengas, mándamelo por aquí.` : `✅ ¡Gracias, ${primer(nombreTrab || e.nombre)}! Apuntado.`;
}

// Recordatorios (cron L-V 10:35): mismo calendario que los papeles del alta.
async function recordar({ hoy = new Date(), _enviar = null, _avisarJefe = null } = {}) {
  try { if (await require('./festivos').esFestivo(hoyISO(hoy))) return { recordados: 0, festivo: true }; } catch (e) {}
  const db = await getDB();
  // Los programados para hoy (o antes): se envían ahora y pasan a abiertos.
  for (const e of await db.collection(COL).find({ estado: 'programado' }).toArray()) {
    if (e.cuando > hoyISO(hoy)) continue;
    const ok = await (_enviar || require('./notifications').sendWhatsAppTo)(e.movil, e.textoInicial);
    if (ok !== false) await db.collection(COL).updateOne({ _id: e._id }, { $set: { estado: 'abierto', at: hoy, enviadoAt: hoy } });
  }
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
    const txt = e.tipo === 'tallas' ? `Hola ${primer(e.nombre)} 👋 Te recuerdo: me faltan ${e.mensaje}. Contéstame en un mensaje, p. ej. «camiseta L, pantalón 42, zapato 43». ¡Gracias!`
      : e.origen === 'trabajador' ? `Hola ${primer(e.nombre)} 👋 ${e.mensaje}`
      : `Hola ${primer(e.nombre)} 👋 Sigo esperando esto: ${e.mensaje}\n\nContéstame por aquí en cuanto lo tengas, lo apunto yo.`;
    const ok = await (_enviar || require('./notifications').sendWhatsAppTo)(e.movil, txt);
    if (ok !== false) { n++; await db.collection(COL).updateOne({ _id: e._id }, { $set: { ultimoRecordatorio: hoy }, $inc: { recordatorios: 1 } }); }
  }
  return { recordados: n, avisosJefe: avisos };
}

// MEMORIA de lo que dicen los trabajadores: si en lo que escriben queda algo pendiente («tengo que devolver la batidora»,
// «no encuentro el ticket», «mañana te traigo el papel»), la IA lo detecta y se apunta como encargo suyo: Corpy se lo
// vuelve a preguntar («¿Ya devolviste la batidora?») hasta que esté, sin que nadie se tenga que acordar.
const HERR_PEND = { name: 'pendiente', description: 'Si el mensaje deja algo pendiente que hay que volver a preguntarle', input_schema: { type: 'object', properties: {
  hay: { type: 'boolean', description: 'true solo si el trabajador dice que tiene que hacer/traer/devolver/buscar/enviar algo, o que algo se le ha perdido o no lo encuentra, o promete algo para más adelante. false si es un saludo, una duda, una queja o algo ya hecho.' },
  que: { type: ['string', 'null'], description: 'Resumen de 3-6 palabras, p. ej. «devolver la batidora», «ticket de gasolina perdido».' },
  pregunta: { type: ['string', 'null'], description: 'Lo que Corpy le preguntará para seguirlo, en tú, breve y directo. P. ej. «¿Ya devolviste la batidora?», «¿Encontraste el ticket de gasolina que perdiste?».' },
  cuando: { type: ['string', 'null'], description: 'AAAA-MM-DD en que tiene sentido preguntarle (si dice «el lunes lo traigo», ese lunes; si no dice, null = mañana).' },
}, required: ['hay'] } };
async function detectarPendiente(texto, { hoy = new Date(), _ia = null } = {}) {
  if (_ia) return _ia(texto);
  const key = process.env.ANTHROPIC_API_KEY; if (!key || String(texto || '').trim().length < 8) return { hay: false };
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: require('./config').ia.agente, max_tokens: 250, tools: [HERR_PEND], tool_choice: { type: 'tool', name: 'pendiente' }, messages: [{ role: 'user', content: `Hoy es ${hoyISO(hoy)}. Mensaje de un trabajador de una empresa de reformas a la oficina:\n«${String(texto).slice(0, 800)}»` }] }) });
    const j = await r.json(); const tu = (j.content || []).find(b => b.type === 'tool_use'); return (tu && tu.input) || { hay: false };
  } catch (e) { return { hay: false }; }
}
async function apuntarDeTrabajador(userId, nombre, texto, opts = {}) {
  const p = await detectarPendiente(texto, opts);
  if (!p || !p.hay || !p.que || !p.pregunta) return null;
  const db = await getDB();
  const u = await _usuario(db, userId); if (!u) return null;
  const movil = require('./recordatoriosCobro')._movil(u.whatsapp || u.telefono); if (!movil) return null;
  const cuando = /^\d{4}-\d{2}-\d{2}$/.test(String(p.cuando || '')) && p.cuando > hoyISO() ? p.cuando : null;
  const txt = `Hola ${primer(u.name)} 👋 ${p.pregunta}`;
  // Sin mensaje ahora (lo acaba de decir él): la primera pregunta llega «cuando» toca o, si no dice, mañana (recordatorio).
  const doc = { userId: String(userId), nombre: u.name, movil, que: String(p.que).slice(0, 120), mensaje: String(p.pregunta).slice(0, 300), tipo: 'libre', origen: 'trabajador', dicho: String(texto).slice(0, 500),
    estado: cuando ? 'programado' : 'abierto', cuando, textoInicial: txt, por: 'lo dijo él', at: new Date(), recordatorios: 0, respuestas: [] };
  const r = await db.collection(COL).insertOne(doc);
  return { id: String(r.insertedId), que: doc.que, cuando };
}

// Para Inicio: cuántos encargos esperan y de quién.
async function resumenInicio() {
  const l = await lista();
  return { n: l.length, personas: [...new Set(l.map(e => e.nombre))], viejos: l.filter(e => e.dias >= 3).length };
}

module.exports = { _elegir: elegir, apuntarDeTrabajador, detectarPendiente, crear, abiertosDe, lista, cerrar, respuesta, recordar, resumenInicio, _APLAZA: APLAZA };
