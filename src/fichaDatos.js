// src/fichaDatos.js — TALLAS Y CUMPLEAÑOS de cada trabajador (12/10/2026). Corpy se las pide (como un encargo, con sus
// recordatorios), lee la respuesta con IA («camiseta L, pantalón 42, zapato 43, nací el 5/3/1990») y las guarda en su
// ficha: users.tallas { ropa, pantalon, calzado } y users.nacimiento (AAAA-MM-DD). Si falta algo, sigue pidiéndolo.
// Con las tallas se hace la lista de compra de EPIs y la entrega ya sale con la talla de cada uno.
'use strict';
const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const primer = n => { const p = String(n || '').trim().split(/\s+/)[0] || ''; return p ? p.charAt(0).toUpperCase() + p.slice(1) : ''; };
const NOMBRES = { ropa: 'talla de camiseta/sudadera', pantalon: 'talla de pantalón', calzado: 'número de calzado', nacimiento: 'fecha de nacimiento' };

function faltanDe(u) {
  const t = (u && u.tallas) || {};
  return ['ropa', 'pantalon', 'calzado'].filter(k => !t[k]).concat(u && u.nacimiento ? [] : ['nacimiento']);
}
const lista = ks => { const l = ks.map(k => NOMBRES[k]); return l.length > 1 ? l.slice(0, -1).join(', ') + ' y ' + l[l.length - 1] : l[0] || ''; };

async function pedir(userId, { por = 'Álex' } = {}) {
  const db = await getDB();
  const u = await db.collection('users').findOne({ _id: new ObjectId(String(userId)) });
  if (!u) throw new Error('No encuentro ese trabajador');
  const faltan = faltanDe(u);
  if (!faltan.length) return { ok: true, yaEsta: true, nombre: u.name };
  const ya = await db.collection('encargos').findOne({ userId: String(userId), tipo: 'tallas', estado: { $in: ['abierto', 'programado'] } });
  if (ya) return { ok: true, yaPedido: true, nombre: u.name };
  const texto = `Hola ${primer(u.name)} 👋 Soy Corpy, de la oficina de Corp Projects. Para la ropa de trabajo y los EPIs necesito tu ${lista(faltan)}${faltan.includes('nacimiento') ? ' (la fecha es para felicitarte 🎂)' : ''}.\n\nContéstame en un solo mensaje, por ejemplo: «camiseta L, pantalón 42, zapato 43, nací el 5/3/1990». ¡Gracias!`;
  return require('./encargos').crear({ userId, que: 'tallas y cumpleaños', mensaje: lista(faltan), tipo: 'tallas', textoCompleto: texto, por });
}

// Quién NO cuenta como equipo aunque fiche (Álex tiene usuario de técnico para su presencia): EQUIPO_EXCLUIR=«Alex,…».
const _norm = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
const EXCLUIR = () => String(process.env.EQUIPO_EXCLUIR || 'Alex').split(',').map(_norm).filter(Boolean);
const delEquipo = u => u.active !== false && !u.autonomo && !u.esDueno && !EXCLUIR().includes(_norm(u.name));

// A todos los de plantilla que les falte algo (no autónomos).
async function pedirATodos({ por = 'Álex' } = {}) {
  const U = require('./users');
  const us = (await U.getUsers(false)).filter(u => delEquipo(u) && ['tecnico', 'encargado'].includes(U.normalizeRole(u.role)));
  const out = [];
  for (const u of us) { try { const r = await pedir(String(u._id), { por }); out.push({ nombre: u.name, ...(r.yaEsta ? { estado: 'ya las tiene' } : r.yaPedido ? { estado: 'ya pedidas' } : { estado: 'pedidas' }) }); } catch (e) { out.push({ nombre: u.name, error: e.message }); } }
  return out;
}

const HERR = { name: 'tallas', description: 'Tallas y fecha de nacimiento que dice el trabajador', input_schema: { type: 'object', properties: {
  ropa: { type: ['string', 'null'], description: 'Talla de camiseta/sudadera/chaqueta: XS, S, M, L, XL, XXL, 3XL… o null si no la dice.' },
  pantalon: { type: ['string', 'null'], description: 'Talla de pantalón: número (38, 40, 42…) o letra; null si no la dice.' },
  calzado: { type: ['string', 'null'], description: 'Número de calzado (40, 41, 42…); null si no lo dice.' },
  nacimiento: { type: ['string', 'null'], description: 'Fecha de nacimiento AAAA-MM-DD; null si no la dice o no está completa.' },
} } };
async function _leer(texto) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) return {};
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: require('./config').ia.agente, max_tokens: 300, tools: [HERR], tool_choice: { type: 'tool', name: 'tallas' }, messages: [{ role: 'user', content: `Mensaje de un trabajador al que le pedimos sus tallas y su fecha de nacimiento:\n"""${String(texto).slice(0, 600)}"""\nSaca solo lo que diga (no inventes).` }] }) });
  const j = await r.json(); const tu = (j.content || []).find(b => b.type === 'tool_use'); return (tu && tu.input) || {};
}

// Respuesta al encargo de tallas: se guarda lo que diga; si falta algo, sigue abierto y se le pide lo que falta.
async function respuesta(e, userId, nombreTrab, texto, { _avisar = null, _leerIA = null } = {}) {
  const db = await getDB();
  const x = await (_leerIA || _leer)(texto);
  const set = {};
  for (const k of ['ropa', 'pantalon', 'calzado']) if (x[k]) set[`tallas.${k}`] = String(x[k]).toUpperCase().slice(0, 8);
  if (x.nacimiento && /^\d{4}-\d{2}-\d{2}$/.test(x.nacimiento)) set.nacimiento = x.nacimiento;
  if (Object.keys(set).length) await db.collection('users').updateOne({ _id: new ObjectId(String(userId)) }, { $set: set });
  const u = await db.collection('users').findOne({ _id: new ObjectId(String(userId)) });
  const faltan = faltanDe(u);
  await db.collection('encargos').updateOne({ _id: e._id }, { $push: { respuestas: { at: new Date(), texto: String(texto).slice(0, 600), leido: set } }, $set: faltan.length ? { mensaje: lista(faltan) } : { estado: 'hecho', cerradoAt: new Date(), cerradoPor: 'respuesta del trabajador' } });
  const t = u.tallas || {};
  if (!faltan.length) try { await (_avisar || require('./notifications').sendWhatsApp)(`👕 *${u.name}*: camiseta ${t.ropa}, pantalón ${t.pantalon}, calzado ${t.calzado}${u.nacimiento ? `, cumple el ${u.nacimiento.slice(8, 10)}/${u.nacimiento.slice(5, 7)}` : ''}. Guardado en su ficha.`); } catch (err) {}
  return faltan.length
    ? `👍 Apuntado${Object.keys(set).length ? '' : ' (no lo he entendido del todo)'}. Me falta tu ${lista(faltan)}. ¿Me lo dices?`
    : `✅ ¡Gracias, ${primer(nombreTrab || u.name)}! Apuntadas tus tallas.`;
}

// Cumpleaños de hoy (cron de cada mañana): aviso a Álex.
async function cumpleHoy({ hoy = new Date(), _avisar = null } = {}) {
  const md = hoy.toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' }).slice(5);
  const us = (await require('./users').getUsers(false)).filter(u => u.active !== false && u.nacimiento && String(u.nacimiento).slice(5) === md);
  for (const u of us) { const anos = Number(hoy.toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' }).slice(0, 4)) - Number(String(u.nacimiento).slice(0, 4));
    try { await (_avisar || require('./notifications').sendWhatsApp)(`🎂 Hoy es el cumpleaños de *${u.name}* (${anos} años). ¡No te olvides de felicitarle!`); } catch (e) {} }
  return { n: us.length };
}

// Para la lista de compra de EPIs y la pantalla de Personal.
async function todas() {
  const U = require('./users');
  return (await U.getUsers(false)).filter(u => delEquipo(u) && ['tecnico', 'encargado'].includes(U.normalizeRole(u.role)))
    .map(u => ({ id: String(u._id), nombre: u.name, tallas: u.tallas || {}, nacimiento: u.nacimiento || null, faltan: faltanDe(u) }));
}

module.exports = { pedir, pedirATodos, respuesta, cumpleHoy, todas, faltanDe, delEquipo };
