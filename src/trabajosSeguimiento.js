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
//      Insiste cada día hasta que hay día y luego parte; si pasan días sin respuesta, se lo pasa a Álex.
//   5. alParte(): parte hecho en la app → incidencia cerrada en StelOrder y petición hecha (o, si no se acabó, «¿cuándo
//      es la próxima visita?»). Horas: 2 por defecto (precio cerrado por salida; objetivo 900 €/día por equipo de dos).
//
// PRESUPUESTO ≠ TRABAJO (2/11/2026, Álex): un presupuesto lo hace Álex (no va al operario salvo que diga «que vaya David
// a verlo»); un trabajo va al operario. Si en la visita piden presupuesto, David lo dice en el grupo y le llega a Álex.
'use strict';
const { ObjectId } = require('mongodb');
const TZ = 'Europe/Madrid';
const hoyISO = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: TZ });
const masDias = (f, n) => { const d = new Date(f + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const fechaTxt = f => { const d = new Date(f + 'T12:00:00Z'); return `${DIAS[d.getUTCDay()]} ${f.slice(8, 10)}/${f.slice(5, 7)}`; };
const corto = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const REF = /\(ref\. trabajo ([a-f0-9]{24})\)/;
// Precio orientativo de una salida: el equipo de dos tiene que sacar OBJETIVO_DIA en 8 h (desplazamientos incluidos).
const OBJETIVO_DIA = () => Number(process.env.OBJETIVO_DIA_EQUIPO || 900);
const HORAS_MIN = () => Number(process.env.HORAS_SALIDA || 2);
const eur = n => (Math.round(n * 100) / 100).toFixed(2).replace('.', ',') + ' €';
function precioSalida(horas, personas = 2) { const h = Math.max(HORAS_MIN(), Number(horas) || 0); return Math.round(OBJETIVO_DIA() / 2 / 8 * h * Math.max(1, personas) * 100) / 100; }
async function getDB() { return require('./db').getDB(); }

// ── 1. ¿Quién va? ──
async function preguntarQuien(p, propuesta = null, { _enviar = null } = {}) {
  if (!p || !p._id || (p.pedido && p.pedido.id)) return false;
  const presu = p.tipo === 'presupuesto';
  const cab = presu ? `📝 *Presupuesto para hacer (tú)*` : `🔧 *Trabajo: ¿quién va?*`;
  const txt = `${cab} ${p.urgente ? '🚨 ' : ''}*${p.clienteStel || p.cliente}*${p.direccion ? ' · ' + p.direccion : ''}\n${p.resumen}` +
    `${p.contacto ? `\nContacto: ${p.contacto}` : '\nSin contacto todavía'}${p.incidencia ? `\n${p.incidencia}` : ''}${p.grupo ? ` · ${p.grupo}` : ''}` +
    (presu
      ? `\n\nSale cada mañana en tu lista de presupuestos por hacer. Si antes hay que ir a verlo, dime «David va a verlo» (o «David el jueves»); si no, no contestes.`
      : `${propuesta ? `\n\nPropongo a *${propuesta.nombre}* (${propuesta.motivo}).` : ''}\n\nContesta «${propuesta ? propuesta.nombre.split(' ')[0] : 'David'}», «David y Diego», «David el jueves a las 10», «vale», «es presupuesto» o «no va nadie». Sin día, queda él con el cliente.`) +
    `\n\n(ref. trabajo ${p._id})`;
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

// «Lo hace Álex», «va Javi», «voy yo» (3/11/2026: Álex contestó «lo hace Álex» y el pedido acabó en David). Puede ir
// cualquiera de la plantilla activa, también el dueño o un socio, no solo los técnicos. Si la frase es de asignar y no se
// reconoce a nadie, se vuelve a preguntar: nunca se pone al propuesto si Álex no lo ha nombrado ni ha dicho «vale».
const ACEPTA = /^(vale|si|ok|okey|perfecto|de acuerdo|adelante|venga)$/;
function _quitaVerbo(t) {
  const s = t.replace(/^(que )?(lo |la )?(hace|hara|haga|lleva|llevara|lleve|hago|llevo)\s+/, '').replace(/^(que )?(va|vaya|ira|voy|vas|iras)\s+/, '');
  return { s, verbo: s !== t };
}
// «Yo»: el usuario con el número que escribe; si no lo tiene apuntado, el único dueño.
function _yo(from, users) {
  const A = require('./acceso'), dig = A.ultimos9(A.normalizarNumero(from));
  const l = users.filter(u => dig && [u.whatsapp, u.telefono, u.phone].some(n => n && A.ultimos9(A.normalizarNumero(n)) === dig));
  if (l.length === 1) return l[0];
  const o = users.filter(u => require('./users').normalizeRole(u.role) === 'owner');
  return o.length === 1 ? o[0] : null;
}
const _repregunta = (p, que) => `${que} ¿Quién va a *${p.clienteStel || p.cliente}*? Dime el nombre como sale en la app (o «no va nadie»).\n\n(ref. trabajo ${p._id})`;
// El agente (IA) solo puede asignar a quien Álex ha nombrado en su último mensaje, a él mismo si dice «yo/voy», o al
// propuesto si ha dicho «vale». Si no se puede leer el hilo, no se bloquea.
async function nombrado(u, p, from, { users = [], alias = [] } = {}) {
  let h; try { h = await require('./waLog').hilo(from, { dias: 2 }); } catch (e) { return true; }
  const m = (h.mensajes || []).filter(x => x.dir === 'in' && x.texto).pop();
  if (!m) return true;
  const N = require('./nombres'), t = ' ' + N.norm(m.texto) + ' ';
  const ws = [u.name, u.nombreCompleto, ...alias.filter(a => String(a.workerId) === String(u._id)).map(a => a.alias)].flatMap(n => N.norm(n).split(' ')).filter(w => w.length >= 3);
  if (ws.some(w => t.includes(' ' + w + ' '))) return true;
  if (/ (yo|voy) /.test(t)) { const y = _yo(from, users); if (y && String(y._id) === String(u._id)) return true; }
  return !!(p.propuestaQuien && String(p.propuestaQuien.userId) === String(u._id) && / (vale|si|ok|okey|perfecto|de acuerdo|adelante|venga) /.test(t));
}

// Respuesta corta de Álex sin pasar por la IA: «David», «vale», «no va nadie». Lo que lleve día, hora o varios nombres
// lo resuelve el agente con asignar_trabajo (que ve la misma «ref. trabajo»).
async function respuestaQuien(texto, from) {
  const t = require('./nombres').norm(texto).replace(/[^a-z0-9ñ ]/g, ' ').replace(/\b(que )?(va|vaya|ira) (a )?(verlo|mirarlo|ver|mirar)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 30 || /\d|\b(y|con|lunes|martes|miercoles|jueves|viernes|sabado|domingo|manana|hoy|pasado|semana)\b/.test(t)) return null;
  const p = await _ultimaPregunta(from);
  if (!p) return null;
  if (/^(es (un )?presupuesto|presupuesto|lo presupuesto yo)$/.test(t)) {
    const db = await getDB();
    await db.collection('peticionesGrupo').updateOne({ _id: p._id }, { $set: { tipo: 'presupuesto', quienRespuesta: 'presupuesto', quienRespuestaAt: new Date() } });
    return `📝 Vale: *${p.clienteStel || p.cliente}* es presupuesto, lo haces tú. Te sale cada mañana en la lista hasta que esté hecho.`;
  }
  if (/^(no va nadie|nadie|ninguno|lo miro yo|lo llevo yo)$/.test(t)) {
    const db = await getDB();
    await db.collection('peticionesGrupo').updateOne({ _id: p._id }, { $set: { quienRespuesta: 'nadie', quienRespuestaAt: new Date() } });
    return `👍 Vale, no mando a nadie para *${p.clienteStel || p.cliente}*. Sigue en la lista de incidencias.`;
  }
  let u = null;
  if (ACEPTA.test(t)) {
    if (!p.propuestaQuien) return _repregunta(p, 'No te había propuesto a nadie.');
    u = { _id: p.propuestaQuien.userId, name: p.propuestaQuien.nombre };
  } else {
    const { s, verbo } = _quitaVerbo(t);
    const db = await getDB();
    const users = (await require('./users').getUsers(false)).filter(x => x.active !== false);
    const r = /^yo( mismo)?$/.test(s) ? _yo(from, users) : require('./nombres').casarTrabajador(s, users, await require('./nombres').aliasDeTrabajadores(db));
    if (r && r.varios) return `¿Cuál? ${r.varios.join(' · ')}\n\n(ref. trabajo ${p._id})`;
    if (!r && (verbo || /^yo( mismo)?$/.test(s))) return _repregunta(p, `No sé quién es «${s}».`);
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
// Abierto = asignado desde una petición y sin parte de «completado» (recordParteResult lo pasa a done). Un parte de
// «queda pendiente» deja el trabajo abierto y sin día (alParte) hasta que diga la próxima visita.
async function abiertos({ userId = null, _db = null } = {}) {
  const db = _db || await getDB();
  const q = { peticionId: { $exists: true }, status: { $ne: 'done' }, cerrado: { $ne: true } };
  if (userId) q.userId = String(userId);
  return db.collection('workOrderAssignments').find(q).toArray();
}
const ultimoToque = a => Math.max(...[a.assignedAt, a.citaAt, a.ultimaRespuestaAt, a.reabiertoAt].filter(Boolean).map(d => new Date(d).getTime()), 0) || Date.now();
const diasDesde = t => Math.floor((Date.now() - t) / 86400000);

// ── 3. Lo que contesta el operario en su grupo ──
const HERRAMIENTA = {
  name: 'leer_respuesta',
  description: 'Lo que dice el operario sobre sus trabajos.',
  input_schema: { type: 'object', properties: {
    pedido: { type: ['string', 'null'], description: 'PDT del trabajo del que habla (de la lista), o null si no se sabe' },
    accion: { type: 'string', enum: ['cita', 'hecho', 'volver', 'presupuesto', 'problema', 'nada'], description: 'cita = dice cuándo ha quedado o cuándo irá; hecho = lo ha terminado; volver = ha ido pero NO se ha acabado (falta material, no estaba nadie, hay que volver otro día); presupuesto = en la visita le piden un presupuesto de algo (lo hará Álex); problema = otra cosa que la oficina debe saber (no contesta el cliente, no puede ir…); nada = no habla de estos trabajos' },
    fecha: { type: ['string', 'null'], description: 'YYYY-MM-DD del día que dice (calcúlalo desde HOY); en «volver», el de la próxima visita si lo dice' },
    hora: { type: ['string', 'null'], description: 'HH:MM si la dice' },
    horas: { type: ['number', 'null'], description: 'Horas que dice que han estado, si las dice' },
    nota: { type: ['string', 'null'], description: 'Lo importante en una frase (para la oficina); en «presupuesto», de qué piden presupuesto' },
  }, required: ['accion'] },
};
async function _leerIA(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Falta ANTHROPIC_API_KEY');
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: require('./config').ia.auto, max_tokens: 400, tools: [HERRAMIENTA], tool_choice: { type: 'tool', name: HERRAMIENTA.name }, messages: [{ role: 'user', content: prompt }] }) });
  const d = await r.json();
  if (!r.ok) throw new Error(`API ${r.status}: ${d.error?.message || ''}`);
  const tu = (d.content || []).find(b => b.type === 'tool_use');
  return tu ? tu.input : { accion: 'nada' };
}

// Sin acabar: el trabajo vuelve a «sin día» (la cita anterior queda guardada) hasta que diga la próxima visita.
async function _reabrir(db, a, motivo, por) {
  await db.collection('workOrderAssignments').updateOne({ _id: a._id }, { $set: { fecha: null, hora: null, citaPendiente: true, reabiertoAt: new Date(), motivoPendiente: String(motivo || '').slice(0, 200) }, ...(a.fecha ? { $push: { citasAnteriores: { fecha: a.fecha, hora: a.hora || null, cambiada: new Date(), por, motivo: String(motivo || '').slice(0, 200) } } } : {}) });
}

// g = bridgeGrupos (con trabajosDe); quien = { userId, name }. Devuelve lo que se ha hecho (y contesta en el grupo).
async function respuestaGrupo({ g, quien, texto = '', fotoIds = [] }, { _leer = null, _enviar = null, _avisar = null, _db = null } = {}) {
  if (!g || !g.trabajosDe || !quien || String(quien.userId) !== String(g.trabajosDe)) return null;
  const db = _db || await getDB();
  const ab = await abiertos({ userId: g.trabajosDe, _db: db });
  if (!ab.length) return null;
  const hoy = hoyISO();
  const enviar = _enviar || require('./notifications').sendWhatsAppTo;
  const avisar = _avisar || require('./notifications').sendWhatsApp;
  const aGrupo = t => enviar(g._id, t, { sinTraducir: true });
  let r = { accion: 'nada' };
  if (String(texto || '').trim()) {
    const lista = ab.map(a => `${a.pedidoRef} · ${a.cliente}${a.direccion ? ' (' + corto(a.direccion, 40) + ')' : ''} · ${corto(a.resumen, 90)} · ${a.fecha ? 'cita ' + a.fecha + (a.hora ? ' ' + a.hora : '') : 'SIN DÍA'}`).join('\n');
    r = await (_leer || _leerIA)(`Eres la oficina de Corp Projects (reformas y mantenimiento en Girona). ${quien.name} es el operario y escribe en su grupo de trabajos. HOY es ${fechaTxt(hoy)} (${hoy}).\n\nSUS TRABAJOS ABIERTOS (pedido · cliente · qué · cita):\n${lista}\n\nMENSAJE DE ${quien.name}:\n${corto(texto, 600)}\n\nSi habla de uno de esos trabajos, di cuál y qué pasa. Si solo hay uno sin día y dice un día, es ese. Si solo hay uno con cita hoy o ayer y dice que está hecho, que hay que volver o que piden presupuesto, es ese.`);
  }
  const a = r.pedido ? ab.find(x => x.pedidoRef === r.pedido) : null;
  const out = { accion: r.accion, pedido: a ? a.pedidoRef : null };
  if (a && r.accion !== 'nada') await db.collection('workOrderAssignments').updateOne({ _id: a._id }, { $set: { ultimaRespuestaAt: new Date() } });
  const url = async () => (await require('./fichajeAvisos').enlacePersonal(String(g.trabajosDe))) + '&ir=parte';
  if (r.accion === 'cita' && a && r.fecha) {
    const c = await require('./trabajos').fijarCita(a.workOrderId, { fecha: r.fecha, hora: r.hora || null, nota: r.nota }, quien.name);
    await aGrupo(`✅ Apuntado: *${a.cliente}* el *${c.fechaTxt}${c.hora ? ' a las ' + c.hora : ''}*. Te lo recuerdo el día antes y ese mismo día.`);
    await avisar(`📅 ${quien.name} ${c.cambiada ? 'ha cambiado' : 'ha quedado'}: *${a.cliente}* el ${c.fechaTxt}${c.hora ? ' a las ' + c.hora : ''} (${a.pedidoRef}).`);
    out.cita = { fecha: c.fecha, hora: c.hora };
  } else if (r.accion === 'hecho' && a) {
    const horas = Number(r.horas) > 0 ? Number(r.horas) : null;
    await db.collection('workOrderAssignments').updateOne({ _id: a._id }, { $set: { dichoHechoAt: new Date(), ...(horas ? { horasDichas: horas } : {}) } });
    await aGrupo(`👍 *${a.cliente}*: hazme el parte en la app y lo cierro. ${horas ? `Pon ${String(horas).replace('.', ',')} h` : `¿Cuántas horas habéis estado? Si no lo cambias, cuento ${HORAS_MIN()} h`}; material y fotos si hay.\n${await url()}`);
  } else if (r.accion === 'volver' && a) {
    await _reabrir(db, a, r.nota || corto(texto, 150), quien.name);
    if (r.fecha) {
      const c = await require('./trabajos').fijarCita(a.workOrderId, { fecha: r.fecha, hora: r.hora || null, nota: r.nota }, quien.name);
      await aGrupo(`🔁 *${a.cliente}*: próxima visita el *${c.fechaTxt}${c.hora ? ' a las ' + c.hora : ''}*. Haz igualmente el parte de hoy en la app marcando que queda pendiente.`);
      out.cita = { fecha: c.fecha, hora: c.hora };
    } else await aGrupo(`🔁 *${a.cliente}* queda pendiente. ¿Cuándo es la próxima visita? Dime el día cuando lo sepas (o ponlo en la app). Haz el parte de hoy marcando que queda pendiente.`);
    await avisar(`🔁 *${quien.name}*: *${a.cliente}* no se ha acabado${r.nota ? ` (${r.nota})` : ''}. ${r.fecha ? `Vuelve el ${fechaTxt(r.fecha)}.` : 'Le he preguntado la próxima visita.'}`);
  } else if (r.accion === 'presupuesto') {
    out.presupuesto = await _presupuestoDeVisita(db, a || (ab.length === 1 ? ab[0] : null), r.nota || corto(texto, 300), quien.name);
    await aGrupo(out.presupuesto ? `📝 Apuntado: presupuesto de *${out.presupuesto.cliente}*${r.nota ? ` (${corto(r.nota, 80)})` : ''}. Se lo paso a Álex. Si tienes medidas o fotos, mándalas aquí.` : '📝 ¿De qué cliente es el presupuesto?');
  } else if (r.accion === 'problema') {
    await avisar(`⚠️ *${quien.name}*${a ? ` sobre *${a.cliente}* (${a.pedidoRef})` : ''}: ${r.nota || corto(texto, 300)}`);
  }
  // Fotos (del parte en papel o del trabajo): van al pedido del que habla o, si no lo dice, al único de hoy o ayer.
  if (fotoIds.length) {
    const cand = a ? [a] : ab.filter(x => x.fecha && x.fecha >= masDias(hoy, -1) && x.fecha <= hoy);
    if (cand.length === 1) {
      await db.collection('workOrderAssignments').updateOne({ _id: cand[0]._id }, { $addToSet: { fotosOperario: { $each: fotoIds } } });
      await aGrupo(`📸 Guardadas ${fotoIds.length} foto${fotoIds.length > 1 ? 's' : ''} en *${cand[0].cliente}* (${cand[0].pedidoRef}).`);
      out.fotosEn = cand[0].pedidoRef;
    }
  }
  return out;
}

// En la visita piden presupuesto: petición nueva de tipo presupuesto (mismo cliente), su incidencia de presupuesto y
// aviso a Álex («📝 Presupuesto para hacer (tú)»).
async function _presupuestoDeVisita(db, a, que, por) {
  if (!a) return null;
  const orig = a.peticionId && ObjectId.isValid(a.peticionId) ? await db.collection('peticionesGrupo').findOne({ _id: new ObjectId(a.peticionId) }) : null;
  const doc = { jid: orig ? orig.jid : null, grupo: orig ? orig.grupo : null, canal: orig ? orig.canal || null : null, tipo: 'presupuesto', clienteId: orig ? orig.clienteId || null : null, clienteStel: orig ? orig.clienteStel || null : null,
    cliente: a.cliente, direccion: a.direccion || null, contacto: a.contacto || null, resumen: `Presupuesto pedido en la visita de ${por}: ${que}`, queHacer: 'Hacer el presupuesto (Álex)', urgente: false,
    situacion: 'nuevo', quien: por, mensajes: [{ fecha: new Date(), quien: por, texto: que }], fotoIds: [], fuente: 'operario', origenPedido: a.pedidoRef || null, fecha: new Date(), estado: 'pendiente', creado: new Date() };
  const ins = await db.collection('peticionesGrupo').insertOne(doc);
  let inc = null;
  if (doc.clienteId) { try { inc = (await require('./peticionesGrupo').crearIncidencia(String(ins.insertedId), por)).ref; } catch (e) { console.warn('[Trabajos] incidencia presupuesto:', e.message); } }
  await preguntarQuien({ ...doc, _id: ins.insertedId, incidencia: inc });
  return { id: String(ins.insertedId), cliente: a.cliente, incidencia: inc };
}

// ── 4. Recordatorios ──
// momento 'manana' (8:30 L-S): hoy toca / sin día todavía / falta el parte, y a Álex lo que lleva días sin respuesta.
// 'tarde' (18:30): mañana toca.
async function seguimiento({ momento = 'manana', hoy = hoyISO(), _enviar = null, _avisar = null, _db = null } = {}) {
  const db = _db || await getDB();
  const ab = await abiertos({ _db: db });
  const porUser = {};
  for (const a of ab) (porUser[a.userId] = porUser[a.userId] || []).push(a);
  const enviar = _enviar || require('./notifications').sendWhatsAppTo;
  const man = masDias(hoy, 1);
  const res = [], escalar = [];
  for (const [userId, l] of Object.entries(porUser)) {
    const linea = a => `• *${corto(a.cliente, 40)}*${a.direccion ? ' · ' + corto(a.direccion, 30) : ''}${a.hora ? ' a las ' + a.hora : ''}${a.contacto ? '\n   ' + corto(a.contacto, 60) : ''}`;
    const dias = a => diasDesde(new Date(a.assignedAt || Date.now()).getTime());
    const u = await db.collection('users').findOne({ _id: new ObjectId(userId) }, { projection: { name: 1, whatsapp: 1, telefono: 1, avisosWa: 1 } }).catch(() => null);
    const nombre = u ? String(u.name || '').split(' ')[0] : '';
    let partes = [];
    if (momento === 'tarde') {
      const manana = l.filter(a => a.fecha === man);
      if (manana.length) partes.push(`📅 *Mañana* (${fechaTxt(man)}):\n${manana.map(linea).join('\n')}`);
    } else {
      const hoyL = l.filter(a => a.fecha === hoy), sinDia = l.filter(a => !a.fecha), sinParte = l.filter(a => a.fecha && a.fecha < hoy);
      if (hoyL.length) partes.push(`📅 *Hoy:*\n${hoyL.map(linea).join('\n')}\nAl acabar, el parte en la app: horas (${HORAS_MIN()} h si no lo cambias), material y fotos.`);
      if (sinDia.length) partes.push(`❓ *Sin día todavía* — ¿cuándo has quedado?\n${sinDia.map(a => `• *${corto(a.cliente, 40)}*: ${corto(a.motivoPendiente ? 'pendiente: ' + a.motivoPendiente : a.resumen, 60)} (${dias(a) === 0 ? 'de hoy' : `hace ${dias(a)} día${dias(a) > 1 ? 's' : ''}`})`).join('\n')}\nContesta «${corto(sinDia[0].cliente, 20)} el jueves a las 10».`);
      if (sinParte.length) partes.push(`📝 *Falta el parte:*\n${sinParte.map(a => `• *${corto(a.cliente, 40)}* (fuiste el ${fechaTxt(a.fecha)}) — si no se pudo, dime para qué día lo paso`).join('\n')}`);
      // Lleva 2 días o más sin decir nada de un trabajo sin día, o 2 días sin parte: a Álex.
      for (const a of sinDia.filter(a => diasDesde(ultimoToque(a)) >= 2)) escalar.push(`• *${a.userName || nombre}* · ${corto(a.cliente, 40)}: sin día desde hace ${diasDesde(ultimoToque(a))} días`);
      for (const a of sinParte.filter(a => a.fecha <= masDias(hoy, -2))) escalar.push(`• *${a.userName || nombre}* · ${corto(a.cliente, 40)}: falta el parte (era el ${fechaTxt(a.fecha)})`);
    }
    if (!partes.length) continue;
    const g = await db.collection('bridgeGrupos').findOne({ trabajosDe: String(userId), activo: true });
    const to = g ? g._id : (u && u.avisosWa !== 'ninguno' ? (u.whatsapp || u.telefono) : null);
    if (!to) continue;
    const url = (await require('./fichajeAvisos').enlacePersonal(String(userId)).catch(() => '')) + '&ir=parte';
    const ok = await enviar(to, `${momento === 'tarde' ? '🔔' : '☀️'} ${nombre ? nombre + ', ' : ''}tus trabajos:\n\n${partes.join('\n\n')}\n\nEn la app: ${url}`, { sinTraducir: true });
    res.push({ userId, nombre: u && u.name, enviado: ok !== false, trabajos: l.length });
  }
  if (escalar.length) await (_avisar || require('./notifications').sendWhatsApp)(`⚠️ *Trabajos sin respuesta*\n${escalar.join('\n')}\n\nDile algo tú, o fija tú la cita: «David ha quedado con X el jueves a las 10».`);
  return Object.assign(res, { escalados: escalar.length });
}

// ── 5. Parte hecho en la app de un trabajo que vino de una petición ──
async function alParte(workOrderId, parte, { _enviar = null, _avisar = null, _stel = null, _db = null } = {}) {
  const db = _db || await getDB();
  const a = await db.collection('workOrderAssignments').findOne({ workOrderId: String(workOrderId) });
  if (!a || !a.peticionId || !parte) return null;
  const enviar = _enviar || require('./notifications').sendWhatsAppTo;
  const avisar = _avisar || require('./notifications').sendWhatsApp;
  const g = await db.collection('bridgeGrupos').findOne({ trabajosDe: String(a.userId), activo: true });
  const aGrupo = t => g ? enviar(g._id, t, { sinTraducir: true }) : Promise.resolve(false);
  const est = parte.estadoTrabajo || 'completado';
  const horas = Number(parte.horas) || 0;
  const personas = 1 + Math.max((parte.equipo || []).length, (a.equipo || []).length);
  if (est === 'completado') {
    let cerrada = null;
    if (a.incidenciaRef) {
      try {
        const S = _stel || require('./stelorder');
        const [inc, st] = await Promise.all([S.getAllIncidents(), S.getIncidentStateMap()]);
        const i = inc.find(x => x['full-reference'] === a.incidenciaRef && !x.deleted);
        const cer = Object.entries(st).find(([, n]) => /^cerrad/i.test(String(n).trim()));
        if (i && cer && !/cerrad|factur/i.test(st[i['incident-state-id']] || '')) { await S.setIncidentState(i.id, Number(cer[0]), { requestedBy: `Parte de ${parte.workerName || a.userName}` }); cerrada = a.incidenciaRef; }
      } catch (e) { console.warn('[Trabajos] cerrar incidencia:', e.message); }
    }
    if (ObjectId.isValid(a.peticionId)) await db.collection('peticionesGrupo').updateOne({ _id: new ObjectId(a.peticionId) }, { $set: { estado: 'hecho', hechoAt: new Date(), hechoPor: `Parte de ${parte.workerName || a.userName}` } });
    await aGrupo(`✅ Parte de *${a.cliente}* recibido (${String(horas).replace('.', ',')} h). Cerrado, gracias.`);
    await avisar(`✅ *${parte.workerName || a.userName}* ha acabado *${a.cliente}* (${a.pedidoRef}${cerrada ? `, ${cerrada} cerrada` : ''}): ${String(horas).replace('.', ',')} h × ${personas} persona${personas > 1 ? 's' : ''}${(parte.materiales || []).length ? ` + ${parte.materiales.length} material${parte.materiales.length > 1 ? 'es' : ''}` : ''}.\nA precio cerrado (objetivo ${eur(OBJETIVO_DIA())}/día por equipo de dos) serían ~*${eur(precioSalida(horas, personas))}* + material.`);
    return { cerrado: true, incidencia: cerrada };
  }
  const motivo = parte.pendienteDetalle || parte.materialDetalle || (est === 'material' ? 'falta material' : 'queda pendiente');
  await _reabrir(db, a, motivo, parte.workerName || a.userName);
  await aGrupo(`🔁 *${a.cliente}* queda pendiente (${corto(motivo, 80)}). ¿Cuándo es la próxima visita? Dime el día o ponlo en la app.`);
  await avisar(`🔁 *${parte.workerName || a.userName}*: *${a.cliente}* no se ha acabado (${corto(motivo, 100)}). ${String(horas).replace('.', ',')} h hoy. Le he preguntado la próxima visita.`);
  return { cerrado: false, motivo };
}

module.exports = { preguntarQuien, respuestaQuien, nombrado, asignar, abiertos, respuestaGrupo, seguimiento, alParte, precioSalida, _ultimaPregunta, _yo, REF };
