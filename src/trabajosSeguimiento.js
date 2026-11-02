// src/trabajosSeguimiento.js — Del aviso al parte, por WhatsApp (2/11/2026, Álex: «incidencia, y de esa incidencia un
// pedido de trabajo; que me pregunte quién va, yo le digo David, y se lo pase por el grupo; y luego con el cron: oye
// David, ¿ya has ido?; si contesta que ha quedado con el cliente tal día, que lo recuerde el día antes y ese día, y que
// le pida el parte con fotos»).
//
//   1. preguntarQuien(): llega un trabajo o una queja (grupo CINC o correo) → a Álex: «¿Quién va? Propongo a David».
//   2. Álex contesta («David», «David y Diego el jueves a las 10», «vale») → trabajos.crear(): incidencia + pedido (PDT)
//      + asignación; la ficha va al grupo del operario (bridgeGrupos.trabajosDe; «Reparaciones David Valencia») y a su app.
//   3. respuestaGrupo(): David contesta en su grupo («he quedado con Bellpuig el jueves a las 10», «hecho», fotos del
//      parte) → la IA lo casa con su trabajo → cita apuntada (Planificación/Google Calendar), aviso a Álex.
//   4. seguimiento(): por la mañana (hoy toca / sin día todavía / falta el parte) y por la tarde (mañana toca).
//      Insiste cada día hasta que hay día y luego parte.
'use strict';
const { ObjectId } = require('mongodb');
const TZ = 'Europe/Madrid';
const hoyISO = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: TZ });
const masDias = (f, n) => { const d = new Date(f + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const fechaTxt = f => { const d = new Date(f + 'T12:00:00Z'); return `${DIAS[d.getUTCDay()]} ${f.slice(8, 10)}/${f.slice(5, 7)}`; };
const corto = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const REF = /\(ref\. trabajo ([a-f0-9]{24})\)/;
async function getDB() { return require('./db').getDB(); }

// ── 1. ¿Quién va? ──
async function preguntarQuien(p, propuesta = null, { _enviar = null } = {}) {
  if (!p || !p._id || (p.pedido && p.pedido.id)) return false;
  const txt = `🔧 *¿Quién va?* ${p.urgente ? '🚨 ' : ''}*${p.clienteStel || p.cliente}*${p.direccion ? ' · ' + p.direccion : ''}\n${p.resumen}` +
    `${p.contacto ? `\nContacto: ${p.contacto}` : '\nSin contacto todavía'}${p.incidencia ? `\n${p.incidencia}` : ''}${p.grupo ? ` · ${p.grupo}` : ''}` +
    `${propuesta ? `\n\nPropongo a *${propuesta.nombre}* (${propuesta.motivo}).` : ''}` +
    `\n\nContesta «${propuesta ? propuesta.nombre.split(' ')[0] : 'David'}», «David y Diego», «David el jueves a las 10», «vale» o «no va nadie». Sin día, queda él con el cliente.\n\n(ref. trabajo ${p._id})`;
  const ok = await (_enviar || require('./notifications').sendWhatsApp)(txt);
  const db = await getDB();
  await db.collection('peticionesGrupo').updateOne({ _id: p._id }, { $set: { quienPreguntadoAt: new Date(), propuestaQuien: propuesta ? { userId: propuesta.userId, nombre: propuesta.nombre } : null } });
  return ok !== false;
}

// La última pregunta «¿Quién va?» a Álex (últimas 48 h) que siga sin pedido.
async function _ultimaPregunta(from) {
  let h; try { h = await require('./waLog').hilo(from, { dias: 2 }); } catch (e) { return null; }
  const m = (h.mensajes || []).filter(x => x.dir !== 'in' && REF.test(x.texto || '')).pop();
  if (!m) return null;
  const db = await getDB();
  const p = await db.collection('peticionesGrupo').findOne({ _id: new ObjectId(m.texto.match(REF)[1]) });
  return p && !(p.pedido && p.pedido.id) ? p : null;
}

// Respuesta corta de Álex sin pasar por la IA: «David», «vale», «no va nadie». Lo que lleve día, hora o varios nombres
// lo resuelve el agente con asignar_trabajo (que ve la misma «ref. trabajo»).
async function respuestaQuien(texto, from) {
  const t = require('./nombres').norm(texto).replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 30 || /\d|\b(y|con|lunes|martes|miercoles|jueves|viernes|sabado|domingo|manana|hoy|pasado|semana)\b/.test(t)) return null;
  const p = await _ultimaPregunta(from);
  if (!p) return null;
  if (/^(no va nadie|nadie|ninguno|lo miro yo|lo llevo yo)$/.test(t)) {
    const db = await getDB();
    await db.collection('peticionesGrupo').updateOne({ _id: p._id }, { $set: { quienRespuesta: 'nadie', quienRespuestaAt: new Date() } });
    return `👍 Vale, no mando a nadie para *${p.clienteStel || p.cliente}*. Sigue en la lista de incidencias.`;
  }
  let u = null;
  if (/^(vale|si|ok|okey|perfecto|de acuerdo|adelante|venga)$/.test(t)) u = p.propuestaQuien ? { _id: p.propuestaQuien.userId, name: p.propuestaQuien.nombre } : null;
  else {
    const db = await getDB();
    const users = (await require('./users').getUsers(false)).filter(x => x.active !== false);
    const r = require('./nombres').casarTrabajador(t, users, await require('./nombres').aliasDeTrabajadores(db));
    if (r && r.varios) return `¿Cuál? ${r.varios.join(' · ')}\n\n(ref. trabajo ${p._id})`;
    u = r;
  }
  if (!u) return null;
  return asignar(p, { userId: String(u._id) }, 'Álex (Corpy)');
}

async function asignar(p, { userId, fecha = null, hora = null, acompanan = [], nota = '' }, por) {
  try {
    const r = await require('./trabajos').crear(String(p._id), { userId, fecha, hora, acompanan, nota }, por);
    return `✅ *${r.pedido}* (${r.incidencia}) para *${r.operario}*${r.equipo.length ? ' con ' + r.equipo.join(', ') : ''}: ${p.clienteStel || p.cliente}.\n` +
      `${r.fecha ? `📅 ${r.fechaTxt}${r.hora ? ' a las ' + r.hora : ''}.` : 'Sin día: queda él con el cliente; le pregunto cada mañana hasta que me diga cuándo.'}\n` +
      `${r.avisado ? `Se lo he mandado${r.enGrupo ? ` al grupo «${r.enGrupo}»` : ' por WhatsApp'} y lo tiene en su app.` : '⚠️ No he podido avisarle por WhatsApp; lo tiene en su app.'}`;
  } catch (e) { return `No he podido crear el trabajo de ${p.clienteStel || p.cliente}: ${e.message}`; }
}

// ── 2. Trabajos abiertos de un operario ──
async function abiertos({ userId = null, _db = null } = {}) {
  const db = _db || await getDB();
  const q = { peticionId: { $exists: true }, status: { $ne: 'done' }, parteId: { $in: [null, undefined] }, cerrado: { $ne: true } };
  if (userId) q.userId = String(userId);
  const l = await db.collection('workOrderAssignments').find(q).toArray();
  const conParte = new Set((await db.collection('partes').find({ workOrderId: { $in: l.map(a => String(a.workOrderId)) } }).project({ workOrderId: 1 }).toArray()).map(x => String(x.workOrderId)));
  return l.filter(a => !conParte.has(String(a.workOrderId)));
}

// ── 3. Lo que contesta el operario en su grupo ──
const HERRAMIENTA = {
  name: 'leer_respuesta',
  description: 'Lo que dice el operario sobre sus trabajos.',
  input_schema: { type: 'object', properties: {
    pedido: { type: ['string', 'null'], description: 'PDT del trabajo del que habla (de la lista), o null si no se sabe' },
    accion: { type: 'string', enum: ['cita', 'hecho', 'problema', 'nada'], description: 'cita = dice cuándo ha quedado o cuándo irá; hecho = ya lo ha hecho/terminado; problema = no puede, no contesta el cliente, falta material, otra cosa que la oficina debe saber; nada = no habla de estos trabajos (saludos, otra cosa)' },
    fecha: { type: ['string', 'null'], description: 'YYYY-MM-DD del día que dice (calcúlalo desde HOY)' },
    hora: { type: ['string', 'null'], description: 'HH:MM si la dice' },
    nota: { type: ['string', 'null'], description: 'Lo importante en una frase (para la oficina)' },
  }, required: ['accion'] },
};
async function _leerIA(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Falta ANTHROPIC_API_KEY');
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: require('./config').ia.agente, max_tokens: 400, tools: [HERRAMIENTA], tool_choice: { type: 'tool', name: HERRAMIENTA.name }, messages: [{ role: 'user', content: prompt }] }) });
  const d = await r.json();
  if (!r.ok) throw new Error(`API ${r.status}: ${d.error?.message || ''}`);
  const tu = (d.content || []).find(b => b.type === 'tool_use');
  return tu ? tu.input : { accion: 'nada' };
}

// g = bridgeGrupos (con trabajosDe); quien = { userId, name }. Devuelve lo que se ha hecho (y contesta en el grupo).
async function respuestaGrupo({ g, quien, texto = '', fotoIds = [] }, { _leer = null, _enviar = null, _db = null } = {}) {
  if (!g || !g.trabajosDe || !quien || String(quien.userId) !== String(g.trabajosDe)) return null;
  const db = _db || await getDB();
  const ab = await abiertos({ userId: g.trabajosDe, _db: db });
  if (!ab.length) return null;
  const hoy = hoyISO();
  const enviar = _enviar || require('./notifications').sendWhatsAppTo;
  let r = { accion: 'nada' };
  if (String(texto || '').trim()) {
    const lista = ab.map(a => `${a.pedidoRef} · ${a.cliente}${a.direccion ? ' (' + corto(a.direccion, 40) + ')' : ''} · ${corto(a.resumen, 90)} · ${a.fecha ? 'cita ' + a.fecha + (a.hora ? ' ' + a.hora : '') : 'SIN DÍA'}`).join('\n');
    r = await (_leer || _leerIA)(`Eres la oficina de Corp Projects (reformas y mantenimiento en Girona). ${quien.name} es el operario y escribe en su grupo de trabajos. HOY es ${fechaTxt(hoy)} (${hoy}).\n\nSUS TRABAJOS ABIERTOS (pedido · cliente · qué · cita):\n${lista}\n\nMENSAJE DE ${quien.name}:\n${corto(texto, 600)}\n\nSi habla de uno de esos trabajos, di cuál y qué pasa. Si solo hay uno sin día y dice un día, es ese.`);
  }
  const a = r.pedido ? ab.find(x => x.pedidoRef === r.pedido) : null;
  const out = { accion: r.accion, pedido: a ? a.pedidoRef : null };
  if (r.accion === 'cita' && a && r.fecha) {
    const c = await require('./trabajos').fijarCita(a.workOrderId, { fecha: r.fecha, hora: r.hora || null, nota: r.nota }, quien.name);
    await enviar(g._id, `✅ Apuntado: *${a.cliente}* el *${c.fechaTxt}${c.hora ? ' a las ' + c.hora : ''}*. Te lo recuerdo el día antes y ese mismo día.`, { sinTraducir: true });
    await require('./notifications').sendWhatsApp(`📅 ${quien.name} ${c.cambiada ? 'ha cambiado' : 'ha quedado'}: *${a.cliente}* el ${c.fechaTxt}${c.hora ? ' a las ' + c.hora : ''} (${a.pedidoRef}).`);
    out.cita = { fecha: c.fecha, hora: c.hora };
  } else if (r.accion === 'hecho' && a) {
    const url = (await require('./fichajeAvisos').enlacePersonal(String(g.trabajosDe))) + '&ir=parte';
    await db.collection('workOrderAssignments').updateOne({ _id: a._id }, { $set: { dichoHechoAt: new Date() } });
    await enviar(g._id, `👍 *${a.cliente}*: hazme el parte en la app (horas, material y fotos) y lo cierro:\n${url}`, { sinTraducir: true });
  } else if (r.accion === 'problema') {
    await require('./notifications').sendWhatsApp(`⚠️ *${quien.name}*${a ? ` sobre *${a.cliente}* (${a.pedidoRef})` : ''}: ${r.nota || corto(texto, 300)}`);
  }
  // Fotos (del parte en papel o del trabajo): van al pedido del que habla o, si no lo dice, al único de hoy o ayer.
  if (fotoIds.length) {
    const cand = a ? [a] : ab.filter(x => x.fecha && x.fecha >= masDias(hoy, -1) && x.fecha <= hoy);
    if (cand.length === 1) {
      await db.collection('workOrderAssignments').updateOne({ _id: cand[0]._id }, { $addToSet: { fotosOperario: { $each: fotoIds } } });
      await enviar(g._id, `📸 Guardadas ${fotoIds.length} foto${fotoIds.length > 1 ? 's' : ''} en *${cand[0].cliente}* (${cand[0].pedidoRef}).`, { sinTraducir: true });
      out.fotosEn = cand[0].pedidoRef;
    }
  }
  return out;
}

// ── 4. Recordatorios ──
// momento 'manana' (8:30 L-S): hoy toca / sin día todavía / falta el parte. 'tarde' (18:30 L-V): mañana toca.
async function seguimiento({ momento = 'manana', hoy = hoyISO(), _enviar = null, _db = null } = {}) {
  const db = _db || await getDB();
  const ab = await abiertos({ _db: db });
  const porUser = {};
  for (const a of ab) (porUser[a.userId] = porUser[a.userId] || []).push(a);
  const enviar = _enviar || require('./notifications').sendWhatsAppTo;
  const man = masDias(hoy, 1);
  const res = [];
  for (const [userId, l] of Object.entries(porUser)) {
    const linea = a => `• *${corto(a.cliente, 40)}*${a.direccion ? ' · ' + corto(a.direccion, 30) : ''}${a.hora ? ' a las ' + a.hora : ''}${a.contacto ? '\n   ' + corto(a.contacto, 60) : ''}`;
    const dias = a => Math.floor((Date.now() - new Date(a.assignedAt || a.citaAt || Date.now()).getTime()) / 86400000);
    let partes = [];
    if (momento === 'tarde') {
      const manana = l.filter(a => a.fecha === man);
      if (manana.length) partes.push(`📅 *Mañana* (${fechaTxt(man)}):\n${manana.map(linea).join('\n')}`);
    } else {
      const hoyL = l.filter(a => a.fecha === hoy), sinDia = l.filter(a => !a.fecha), sinParte = l.filter(a => a.fecha && a.fecha < hoy);
      if (hoyL.length) partes.push(`📅 *Hoy:*\n${hoyL.map(linea).join('\n')}\nAl acabar, el parte en la app con fotos.`);
      if (sinDia.length) partes.push(`❓ *Sin día todavía* — ¿cuándo has quedado?\n${sinDia.map(a => `• *${corto(a.cliente, 40)}*: ${corto(a.resumen, 60)} (${dias(a) === 0 ? 'de hoy' : `hace ${dias(a)} día${dias(a) > 1 ? 's' : ''}`})`).join('\n')}\nContesta «${corto(sinDia[0].cliente, 20)} el jueves a las 10».`);
      if (sinParte.length) partes.push(`📝 *Falta el parte:*\n${sinParte.map(a => `• *${corto(a.cliente, 40)}* (fuiste el ${fechaTxt(a.fecha)}) — si no se pudo, dime para qué día lo paso`).join('\n')}`);
    }
    if (!partes.length) continue;
    const g = await db.collection('bridgeGrupos').findOne({ trabajosDe: String(userId), activo: true });
    const u = await db.collection('users').findOne({ _id: new ObjectId(userId) }, { projection: { name: 1, whatsapp: 1, telefono: 1, avisosWa: 1 } }).catch(() => null);
    const to = g ? g._id : (u && u.avisosWa !== 'ninguno' ? (u.whatsapp || u.telefono) : null);
    if (!to) continue;
    const url = (await require('./fichajeAvisos').enlacePersonal(String(userId)).catch(() => '')) + '&ir=parte';
    const nombre = u ? String(u.name || '').split(' ')[0] : '';
    const ok = await enviar(to, `${momento === 'tarde' ? '🔔' : '☀️'} ${nombre ? nombre + ', ' : ''}tus trabajos:\n\n${partes.join('\n\n')}\n\nEn la app: ${url}`, { sinTraducir: true });
    res.push({ userId, nombre: u && u.name, enviado: ok !== false, trabajos: l.length });
  }
  return res;
}

module.exports = { preguntarQuien, respuestaQuien, asignar, abiertos, respuestaGrupo, seguimiento, _ultimaPregunta, REF };
