// src/peticionesGrupo.js — Lo que nos piden en los grupos de clientes (20/10/2026, Álex: «que se lea todo el grupo de SYNC,
// que busque todo lo que dicen de pedir presupuesto, las incidencias… y las mire con StelOrder y haga el primer filtrado»).
//
// Corpy está en el grupo en MODO ESCUCHA (grupoWhatsapp.js guarda los mensajes y no contesta nunca). Los grupos marcados
// con `peticiones: true` en bridgeGrupos pasan además por aquí: cada media hora la IA lee lo nuevo, lo separa en
// peticiones (presupuesto / trabajo / queja / consulta / aviso) y lo cruza con StelOrder (cliente, incidencias abiertas,
// presupuestos recientes) para decir si ya está cubierto o es nuevo. A Álex y a la oficina les llega un aviso con lo
// nuevo y queda la lista en el inicio del dashboard. Solo en los grupos con autoIncidencia (CINC) se crea sola la
// incidencia de un trabajo o queja nueva, y con corpyResponde Corpy pide en el grupo el contacto que falte.
//
// El historial de antes de que Corpy entrara no llega por WhatsApp: se importa el chat exportado (Exportar chat → sin
// archivos) con importarChat(); se guarda en `grupoHistorial` y se analiza igual, sin avisos.
//
//   peticionesGrupo { jid, grupo, tipo, clienteId, cliente, direccion, contacto, quien, resumen, queHacer, urgente,
//                     situacion, incidencia, presupuesto, mensajes:[{fecha, quien, texto}], fotoIds, fuente, estado, creado }
//   grupoHistorial  { jid, grupo, quien, texto, fecha, media, analizado }
'use strict';
const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const COL = 'peticionesGrupo', HIST = 'grupoHistorial';
const TIPOS = ['presupuesto', 'trabajo', 'queja', 'consulta', 'aviso'];
const SITUACIONES = ['nuevo', 'ya_hay_incidencia', 'ya_hay_presupuesto', 'seguimiento'];
const ESTADOS_INC_ABIERTA = /pendiente|en proceso|programado|parte de trabajo|presupuesto hecho/i;
const fmt = d => new Date(d).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
const corto = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

const HERRAMIENTA = {
  name: 'guardar_peticiones',
  description: 'Guarda las peticiones que hay en los mensajes del grupo.',
  input_schema: { type: 'object', properties: {
    peticiones: { type: 'array', items: { type: 'object', properties: {
      msgs: { type: 'array', items: { type: 'integer' }, description: 'Números [n] de los mensajes que forman esta petición' },
      tipo: { type: 'string', enum: TIPOS, description: 'presupuesto = piden precio; trabajo = algo que hay que ir a hacer/arreglar; queja = se quejan de algo nuestro; consulta = preguntan algo; aviso = nos informan (cita, llaves, acceso…)' },
      cliente_id: { type: ['string', 'null'], description: 'id del cliente de StelOrder de la lista (comunidad/finca), si se puede saber' },
      cliente: { type: 'string', description: 'Comunidad o cliente tal como se entiende (calle y número)' },
      direccion: { type: ['string', 'null'], description: 'Piso, puerta, zona concreta (3º 1ª, parking, cubierta…)' },
      contacto: { type: ['string', 'null'], description: 'Nombre y teléfono de contacto si lo dan' },
      resumen: { type: 'string', description: 'Qué piden, en una o dos frases claras' },
      titulo: { type: 'string', description: 'Título corto de 3 a 6 palabras con lo que pasa o lo que piden, sin el cliente ni «urgente» (p. ej. «Fuga de agua en el baño», «Presupuesto pintar escalera»). Va de título en StelOrder' },
      que_hacer: { type: 'string', description: 'Lo siguiente que tiene que hacer la oficina (ir a mirar, hacer presupuesto, llamar a…, nada)' },
      urgente: { type: 'boolean', description: 'Agua entrando, sin luz, peligro, se quejan de que no fuimos…' },
      situacion: { type: 'string', enum: SITUACIONES, description: 'nuevo; ya_hay_incidencia (una incidencia ABIERTA ya lo cubre); ya_hay_presupuesto (ya se hizo el presupuesto); seguimiento (insisten o preguntan por algo que ya estaba pedido)' },
      incidencia: { type: ['string', 'null'], description: 'INCxxxxx de StelOrder que lo cubre, si la hay' },
      presupuesto: { type: ['string', 'null'], description: 'PRTxxxxx de StelOrder que lo cubre, si lo hay' },
      actualiza: { type: ['string', 'null'], description: 'id de una petición anterior (lista PETICIONES ABIERTAS) si esto es la misma cosa' },
      respondimos: { type: 'boolean', description: 'Alguien de Corp contestó en el chat a esta petición' },
      hecho_en_chat: { type: 'boolean', description: 'En el chat se ve que se hizo, se mandó el presupuesto o se cerró (fotos de acabado, «ya está», «enviado»…)' },
      cita: { type: ['object', 'null'], description: 'SOLO si en estos mensajes queda fijado un día para ir (lo dice alguien de Corp, el administrador o un vecino: «vamos mañana a las 10», «os espera el jueves a las 9», «habíamos quedado el miércoles»). Fecha absoluta. null si no hay día concreto.', properties: {
        fecha: { type: 'string', description: 'YYYY-MM-DD' }, hora: { type: ['string', 'null'], description: 'HH:MM en 24 h, o null' }, con: { type: ['string', 'null'], description: 'Con quién se queda (nombre/teléfono), si se dice' } } },
      pedir_contacto: { type: 'boolean', description: 'true SOLO si para ir a hacerlo nos falta un contacto o cómo entrar y nadie lo ha dado. false si ya estamos trabajando en ese edificio, si alguien de Corp ya contestó que se encarga («sí miramos», «vamos»), si el contacto ya salió (en la conversación anterior o en la petición abierta), si es zona común con acceso o si no hay que ir a ningún sitio' },
    }, required: ['msgs', 'tipo', 'cliente', 'resumen', 'que_hacer', 'urgente', 'situacion'] } },
  }, required: ['peticiones'] },
};

const INSTRUCCIONES = `Eres de la oficina de Corp Projects Holding SL (reformas y mantenimiento de comunidades en Girona). Te paso mensajes de un grupo de WhatsApp con un administrador de fincas que nos encarga trabajos. Sepáralos en PETICIONES: cada cosa distinta que nos piden (un presupuesto, un trabajo, una queja, una consulta o un aviso). Junta en la misma petición los mensajes que hablan de lo mismo (texto + fotos + contacto que viene después). Lo que no pide nada (saludos, «ok», «gracias», emojis, conversación) no es petición.
Cruza cada una con StelOrder: busca el cliente en CLIENTES (las comunidades suelen ir por calle y número; «Ctat.», «CP», «Comunitat» = comunidad). Mira si una INCIDENCIA ABIERTA o un PRESUPUESTO RECIENTE del mismo cliente ya lo cubre (misma cosa, no solo mismo cliente). Si hay una PETICIÓN ABIERTA que es la misma cosa, pon su id en «actualiza».
Usa la CONVERSACIÓN ANTERIOR para entender a qué responde cada mensaje nuevo: un nombre o un teléfono suelto («Josep Maria», «te lo he pasado antes») contesta a lo último que se preguntó (también a Corpy) y va a esa petición con «actualiza» y el contacto; lo que cuenta alguien de Corp después de ir («no hay pérdida», «ya está») es el resultado de la petición de la que se hablaba justo antes, aunque se parezca a otra más antigua. Mira la fecha de las peticiones abiertas: lo de hoy casi siempre sigue a lo más reciente.
Escribe en castellano llano, frases cortas, sin tecnicismos. No inventes datos: si no se sabe el cliente, deja cliente_id vacío y pon lo que se entienda.`;

async function _catalogo({ desde = null, historial = false } = {}) {
  const S = require('./stelorder');
  const [{ clientMap }, inc, est, st, tipos] = await Promise.all([
    S.getClients(), S.getAllIncidents(), S.getWorkEstimates(), S.getIncidentStateMap(), S.getIncidentTypeMaps().then(x => x.typeName).catch(() => ({})),
  ]);
  const nombre = id => { const c = clientMap[String(id)]; return c ? (c['legal-name'] || c.name || '') : ''; };
  const clientes = Object.entries(clientMap).map(([id, c]) => `${id} · ${corto(c['legal-name'] || c.name, 60)}`);
  const lim = desde ? new Date(new Date(desde).getTime() - 30 * 86400000) : new Date(Date.now() - 120 * 86400000);
  const incidencias = (inc || []).filter(i => !i.deleted && (historial ? true : (ESTADOS_INC_ABIERTA.test(st[i['incident-state-id']] || '') || new Date(i.date) >= lim)))
    .map(i => `${i['full-reference']} · ${String(i.date).slice(0, 10)} · ${st[i['incident-state-id']] || '?'} · ${corto(tipos[i['incident-type-id']], 14)} · ${corto(nombre(i['account-id']), 40)} · ${corto(i.description, 140)}`);
  const EST = { 1120641: 'Pendiente', 1120642: 'Rechazado', 1120656: 'Aceptado', 1120650: 'Cerrado' };
  const presupuestos = (est || []).filter(e => !e.deleted && (historial || new Date(e.date) >= lim))
    .map(e => `${e['full-reference']} · ${String(e.date).slice(0, 10)} · ${EST[e['document-state-id']] || '?'} · ${corto(nombre(e['account-id']), 40)} · ${corto(e.title, 80) || 's/t'} · ${e['total-amount']} €`);
  return { clientes, incidencias, presupuestos, nombre };
}

function _ventana(cat, desde, hasta) {
  const a = new Date(desde.getTime() - 45 * 86400000).toISOString().slice(0, 10), b = new Date(hasta.getTime() + 150 * 86400000).toISOString().slice(0, 10);
  const dentro = l => { const f = (l.split(' · ')[1] || ''); return f >= a && f <= b; };
  return { ...cat, incidencias: cat.incidencias.filter(dentro), presupuestos: cat.presupuestos.filter(dentro) };
}

async function _llamarIA(prompt, maxTokens = 8000) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Falta ANTHROPIC_API_KEY');
  const c = new AbortController(); const tm = setTimeout(() => c.abort(), maxTokens > 8000 ? 480000 : 180000);
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: c.signal,
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: require('./config').ia.agente, max_tokens: maxTokens, tools: [HERRAMIENTA], tool_choice: { type: 'tool', name: HERRAMIENTA.name }, messages: [{ role: 'user', content: prompt }] }) }).finally(() => clearTimeout(tm));
  const d = await r.json();
  if (!r.ok) throw new Error(`API ${r.status}: ${d.error?.message || ''}`);
  const tu = (d.content || []).find(b => b.type === 'tool_use');
  return tu ? tu.input : { peticiones: [] };
}

// Analiza una tanda de mensajes [{ _id, fecha, quien, texto, fotoIds, nMedia }] de UN grupo.
const NUESTROS = /alfonso|alex|álex|oficina corp|corpy|judit|paula/i;
async function _tanda(db, { jid, grupo, msgs, fuente, cat, _llamar, extra = '', maxTokens = 8000, contexto = [], memoria = '' }) {
  const abiertas = await db.collection(COL).find({ jid, estado: { $in: ['pendiente', 'archivo'] } }).sort({ fecha: -1 }).limit(fuente === 'historial' ? 80 : 40).toArray();
  const nuestros = [...new Set(msgs.map(m => m.quien).filter(q => NUESTROS.test(q || '')))];
  const lineas = msgs.map((m, n) => `[${n}] ${fmt(m.fecha)} ${m.quien}: ${corto(m.texto, 900) || '(sin texto)'}${m.nMedia ? ` (📷 ${m.nMedia} foto${m.nMedia > 1 ? 's' : ''})` : ''}`);
  const prompt = `${INSTRUCCIONES}${extra ? '\n' + extra : ''}

GRUPO: ${grupo || jid}${nuestros.length ? `\nSON DE CORP (los demás son el administrador o vecinos): ${nuestros.join(', ')}` : ''}

${memoria ? `LO QUE YA SABEMOS DE ESTOS SITIOS (memoria de Corpy, solo de este grupo; úsalo: un contacto que ya está aquí NO se pide):\n${memoria}\n\n` : ''}${contexto.length ? `CONVERSACIÓN ANTERIOR (ya analizada; solo para entender los mensajes nuevos, no saques peticiones de aquí):\n${contexto.join('\n')}\n\n` : ''}MENSAJES:
${lineas.join('\n')}

PETICIONES ABIERTAS (id · cliente · resumen · fecha · contacto):
${abiertas.map(p => `${p._id} · ${p.cliente}${p.direccion ? ' (' + corto(p.direccion, 40) + ')' : ''} · ${corto(p.resumen, 120)} · ${fmt(p.fecha)}${p.contacto ? ' · contacto: ' + corto(p.contacto, 60) : ''}`).join('\n') || '(ninguna)'}

INCIDENCIAS DE STELORDER (ref · fecha · estado · tipo · cliente · descripción):
${cat.incidencias.join('\n')}

PRESUPUESTOS (ref · fecha · estado · cliente · título · total):
${cat.presupuestos.join('\n')}

CLIENTES (id · nombre):
${cat.clientes.join('\n')}`;
  const out = _llamar ? await _llamar(prompt) : await _llamarIA(prompt, maxTokens);
  const nuevas = [], actualizadas = [];
  for (const p of (out.peticiones || [])) {
    const ms = (p.msgs || []).map(n => msgs[n]).filter(Boolean);
    if (!ms.length) continue;
    const mensajes = ms.map(m => ({ fecha: m.fecha, quien: m.quien, texto: corto(m.texto, 1000) }));
    const fotoIds = ms.flatMap(m => m.fotoIds || []);
    const set = { tipo: TIPOS.includes(p.tipo) ? p.tipo : 'consulta', clienteId: p.cliente_id && /^\d+$/.test(String(p.cliente_id)) ? String(p.cliente_id) : null,
      cliente: corto(p.cliente, 120), titulo: corto(p.titulo, 60) || null, direccion: corto(p.direccion, 120) || null, contacto: corto(p.contacto, 120) || null, resumen: corto(p.resumen, 400), queHacer: corto(p.que_hacer, 300),
      urgente: !!p.urgente, respondimos: p.respondimos == null ? null : !!p.respondimos, hechoEnChat: p.hecho_en_chat == null ? null : !!p.hecho_en_chat, situacion: SITUACIONES.includes(p.situacion) ? p.situacion : 'nuevo', incidencia: corto(p.incidencia, 12) || null, presupuesto: corto(p.presupuesto, 12) || null, pedirContacto: p.pedir_contacto === true, actualizado: new Date() };
    if (p.cita && /^\d{4}-\d{2}-\d{2}$/.test(p.cita.fecha || '')) set.cita = { fecha: p.cita.fecha, hora: /^\d{1,2}:\d{2}$/.test(p.cita.hora || '') ? p.cita.hora : null, con: corto(p.cita.con, 80) || null };
    if (set.clienteId) set.clienteStel = cat.nombre(set.clienteId) || null;
    const prev = p.actualiza && ObjectId.isValid(String(p.actualiza)) ? abiertas.find(a => String(a._id) === String(p.actualiza)) : null;
    if (prev) {
      // Una queja, una urgencia o que insistan sobre algo ya archivado lo vuelve a poner a la vista (2/11/2026: lo de
      // Cartagena siguió archivado mientras CINC pedía que llamáramos al presidente).
      // Lo que ya sabíamos (contacto, piso, cliente, INC/PRT) no se borra porque el mensaje nuevo no lo repita.
      for (const k of ['titulo', 'contacto', 'direccion', 'clienteId', 'clienteStel', 'incidencia', 'presupuesto', 'cita']) if (set[k] == null && prev[k] != null) delete set[k];
      const junta = { ...prev, ...set };
      if (fuente !== 'historial') await _citaAlCalendario(db, junta, prev.cita);
      if (prev.estado === 'archivo' && importa(set) && ms.some(m => !NUESTROS.test(m.quien || ''))) Object.assign(set, { estado: 'pendiente', reabiertaAt: new Date() });
      await db.collection(COL).updateOne({ _id: prev._id }, { $set: set, $push: { mensajes: { $each: mensajes } }, $addToSet: { fotoIds: { $each: fotoIds }, archivos: { $each: ms.flatMap(m => m.archivos || []) } } });
      actualizadas.push(junta);
    } else {
      // Del historial solo quedan a la vista (pendiente) las de los últimos 90 días que no se ven hechas; el resto, al archivo
      // para el informe de lo que se nos escapó.
      const reciente = Date.now() - new Date(ms[0].fecha).getTime() < 90 * 86400000;
      const estado = fuente !== 'historial' ? 'pendiente' : (reciente && !set.hechoEnChat && set.situacion !== 'ya_hay_presupuesto' ? 'pendiente' : 'archivo');
      const archivos = ms.flatMap(m => m.archivos || []);
      const doc = { jid, grupo: grupo || null, ...set, quien: ms[0].quien, mensajes, fotoIds, archivos, fuente, fecha: ms[0].fecha, estado, creado: new Date() };
      const r = await db.collection(COL).insertOne(doc);
      const nueva = { ...doc, _id: r.insertedId };
      if (fuente !== 'historial') await _citaAlCalendario(db, nueva, null);
      nuevas.push(nueva);
    }
  }
  return { nuevas, actualizadas };
}

// Una cita que se fija en el grupo («vamos el jueves a las 10», «habíais quedado el miércoles») va a la agenda de Álex
// (3/11/2026: el propietario de Santiago Sobrequés 5 esperó a alguien que no fue y la cita no estaba en ningún calendario).
// Solo citas de hoy en adelante y una vez por fecha/hora; queda en p.citaCal y sale en el aviso.
async function _citaAlCalendario(db, p, antes, { _crear = null } = {}) {
  const c = p.cita; if (!c || !c.fecha) return null;
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
  if (c.fecha < hoy || (antes && antes.fecha === c.fecha && antes.hora === c.hora && p.citaCal)) return null;
  const titulo = `Visita ${p.clienteStel || p.cliente}${p.direccion ? ' ' + p.direccion : ''}${c.con ? ' · ' + c.con : p.contacto ? ' · ' + p.contacto : ''}`;
  try {
    const id = await (_crear || require('./calendar').crearEventoPersonal)({ date: c.fecha, hora: c.hora, titulo: corto(titulo, 140), nota: `${p.resumen}${p.incidencia ? '\n' + p.incidencia : ''}\nGrupo «${p.grupo || 'WhatsApp'}»` });
    const citaCal = { id, fecha: c.fecha, hora: c.hora, at: new Date() };
    await db.collection(COL).updateOne({ _id: p._id }, { $set: { citaCal } });
    p.citaCal = citaCal; p.citaNueva = true;
    return citaCal;
  } catch (e) { console.warn('[Peticiones] cita al calendario:', e.message); return null; }
}

// Lo de una petición que ya existía que merece aviso: urgente, insisten, o una queja que nadie de Corp ha contestado.
const importa = p => !!(p.urgente || p.situacion === 'seguimiento' || (p.tipo === 'queja' && !p.respondimos) || p.citaNueva);

function _textoAviso(grupo, nuevas, actualizadas, auto = {}) {
  const et = { presupuesto: '💶 Presupuesto', trabajo: '🔧 Trabajo', queja: '⚠️ Queja', consulta: '❓ Consulta', aviso: 'ℹ️ Aviso' };
  const sit = p => p.situacion === 'ya_hay_incidencia' ? ` (ya está en ${p.incidencia || 'una incidencia'})` : p.situacion === 'ya_hay_presupuesto' ? ` (ya hay ${p.presupuesto || 'presupuesto'})` : p.situacion === 'seguimiento' ? ' (insisten)' : '';
  const hecho = p => { const a = auto[String(p._id)]; if (!a) return '';
    return ['', a.incidencia ? `   ✅ Incidencia creada: *${a.incidencia}*` : a.error ? `   ⚠️ No he podido crear la incidencia: ${a.error}` : '',
      a.yaContestado ? '   💬 Ya contestó alguien de Corp en el grupo: no propongo operario ni pido contacto.' : '',
      a.sinOperario ? `   👷 ${a.sinOperario}` : '',
      a.preguntado ? (p.tipo === 'presupuesto' ? '   📝 Presupuesto para ti (te lo paso aparte).' : '   👷 Te pregunto aparte quién va.') : a.propuesta ? `   👷 Propongo a *${a.propuesta.nombre}* el ${a.propuesta.fechaTxt} a las ${a.propuesta.hora} (${a.propuesta.motivo}). Dime a quién o confírmalo en Inicio → Peticiones.` : '',
      a.contactoFicha ? `   📇 Contacto de la ficha: ${a.contactoFicha}` : '',
      a.pedidoContacto ? '   📨 He pedido en el grupo un teléfono de contacto.' : ''].filter((x, i) => !i || x).join('\n'); };
  const l = [...nuevas, ...actualizadas.filter(importa)];
  const cab = /^Correo · /.test(grupo || '') ? `📧 *${grupo}*` : `📋 *Grupo «${grupo}»*`;
  return `${cab}: ${l.length} cosa${l.length > 1 ? 's' : ''} que nos piden\n\n` +
    l.map(p => `${p.urgente ? '🚨 ' : ''}${et[p.tipo] || p.tipo} · *${p.cliente}*${p.direccion ? ' ' + p.direccion : ''}: ${p.resumen}${sit(p)}\n   → ${p.queHacer}${p.citaNueva && p.citaCal ? `\n   📅 Cita apuntada en tu calendario: *${p.citaCal.fecha.split('-').reverse().join('/')}${p.citaCal.hora ? ' a las ' + p.citaCal.hora : ''}*` : ''}${hecho(p)}`).join('\n\n') +
    `\n\nLas tienes en el inicio del dashboard (Peticiones de los grupos).`;
}

// Consultas que no piden nada («vaaaale», «gracias»): al archivo y sin aviso (30/10/2026, Álex).
const SIN_ACCION = /^\s*(nada|ninguna?)\b|no hay acci[oó]n|no requiere|no pide nada/i;
const sinAccion = p => p.tipo === 'consulta' && SIN_ACCION.test(p.queHacer || '');

// Grupos con bridgeGrupos.autoIncidencia (los de CINC; 30/10/2026, Álex: «que cree la incidencia y me proponga operario
// y día; si no dan teléfono, que Corpy lo pida en el grupo»): un trabajo o una queja nueva crea su incidencia en
// StelOrder y el aviso lleva la propuesta de trabajos.propuesta(). El trabajo se sigue confirmando en Inicio → Peticiones.
// Corpy solo escribe en el grupo si además tiene corpyResponde.
async function _autoIncidencias(db, g, nuevas, { _crear = null, _propuesta = null, _enviar = null } = {}) {
  const out = {};
  if (!g.autoIncidencia) return out;
  for (const p of nuevas) {
    // Presupuesto: su incidencia de presupuesto y a Álex «📝 Presupuesto para hacer (tú)» (no se propone operario).
    if (!['trabajo', 'queja', 'presupuesto'].includes(p.tipo) || p.incidencia || p.situacion !== 'nuevo') continue;
    const r = out[String(p._id)] = {};
    if (p.clienteId) { try { r.incidencia = (await (_crear || crearIncidencia)(String(p._id), 'Corpy (grupo)')).ref; } catch (e) { r.error = e.message; } }
    else r.error = 'no sé de qué comunidad de StelOrder es';
    // Si alguien de Corp ya contestó («sí miramos») lo lleva él: ni operario propuesto ni preguntas en el grupo (2/11/2026:
    // Corpy pidió contacto y día para Joan Maragall 5º 3ª cuando Alfonso ya había dicho que lo miraban, colgados allí mismo).
    if (p.respondimos) { r.yaContestado = true; continue; }
    if (p.tipo === 'presupuesto') { if (!_crear) { try { r.preguntado = await require('./trabajosSeguimiento').preguntarQuien({ ...p, incidencia: r.incidencia || p.incidencia }, null); } catch (e) {} } continue; }
    try { const pr = await (_propuesta || require('./trabajos').propuesta)(String(p._id)); r.propuesta = pr.propuesta; if (!pr.propuesta && pr.motivo) r.sinOperario = pr.motivo; } catch (e) {}
    // A Álex: «¿Quién va?» con la propuesta; su respuesta crea el pedido y se lo manda al operario (trabajosSeguimiento.js).
    if (!_crear) { try { r.preguntado = await require('./trabajosSeguimiento').preguntarQuien({ ...p, incidencia: r.incidencia || p.incidencia }, r.propuesta); } catch (e) { console.warn('[Peticiones] quién va:', e.message); } }
    // Antes de pedirlo, la lista de contactos de la comunidad (contactos.js): el de ese piso o, si es zona común, el presi.
    if (!p.contacto && p.pedirContacto) {
      const c = await require('./contactos').paraPeticion(p, { _db: db }).catch(() => null);
      if (c) { r.contactoFicha = c.texto; p.contacto = c.texto; await db.collection(COL).updateOne({ _id: p._id }, { $set: { contacto: c.texto, contactoDeFicha: true } }); }
    }
    if (!p.contacto && g.corpyResponde && p.pedirContacto) {
      const txt = `Hola, soy Corpy, de la oficina de Corp Projects. Para lo de ${p.cliente}${p.direccion ? ' (' + p.direccion + ')' : ''}: ¿nos pasáis un nombre y teléfono de contacto y cuándo se puede entrar? Gracias.`;
      try { r.pedidoContacto = (await (_enviar || require('./notifications').sendWhatsAppTo)(g._id, txt, { sinTraducir: true, importante: true })) !== false; } catch (e) {}
      if (r.pedidoContacto) await db.collection(COL).updateOne({ _id: p._id }, { $set: { contactoPedidoAt: new Date() } });
    }
  }
  return out;
}

async function _avisarOficina(txt) {
  const N = require('./notifications');
  for (const to of [...new Set([N.destinoDueno(), process.env.OFICINA_TELEFONO || '+34674013723'].filter(Boolean))]) {
    try { await N.sendWhatsAppTo(to, txt); } catch (e) { console.warn('[Peticiones] aviso:', e.message); }
  }
}

// Lo que se habló justo antes (ya analizado) y lo que escribió Corpy en el grupo: sin esto la IA leía «Josep Maria» o
// «no hay pérdida» sueltos y los pegaba a otra petición (2/11/2026). Lo de Corpy dentro de la tanda va con los mensajes.
async function _contexto(db, jid, desde, hasta) {
  const ini = new Date(new Date(desde).getTime() - 36 * 3600 * 1000);
  const [ant, out] = await Promise.all([
    db.collection('grupoMensajes').find({ jid, pet: true, ts: { $gte: ini, $lt: new Date(desde) } }).sort({ ts: -1 }).limit(25).toArray(),
    db.collection('whatsappLog').find({ dir: 'out', numero: jid, ok: { $ne: false }, ts: { $gte: ini, $lte: new Date(hasta) } }).sort({ ts: 1 }).limit(20).toArray(),
  ]);
  const deCorpy = out.map(o => ({ fecha: o.ts, quien: 'Corpy (oficina Corp)', texto: o.texto, fotoIds: [], nMedia: 0 }));
  const contexto = [...ant.map(m => ({ fecha: m.ts, quien: m.quien, texto: m.texto, nMedia: (m.media || []).length })), ...deCorpy.filter(m => m.fecha < new Date(desde))]
    .sort((a, b) => new Date(a.fecha) - new Date(b.fecha))
    .map(m => `${fmt(m.fecha)} ${m.quien}: ${corto(m.texto, 300) || '(sin texto)'}${m.nMedia ? ' (📎)' : ''}`);
  return { contexto, corpy: deCorpy.filter(m => m.fecha >= new Date(desde)) };
}

// Cada petición creada o puesta al día deja su línea en la memoria del sitio (memoria.js). Sin esperar ni romper nada.
function _memo(p) {
  if (p && p.jid) require('./memoria').dePeticion(p).catch(e => console.warn('[Peticiones] memoria:', e.message));
  // Y el teléfono que den, a los contactos de la comunidad (sin duplicar).
  if (p && p.jid && p.contacto && !p.contactoDeFicha) require('./contactos').desdePeticion(p).catch(e => console.warn('[Peticiones] contactos:', e.message));
}

// Cada media hora: lo nuevo de los grupos con peticiones:true.
async function analizar({ avisar = true, _llamar = null, _cat = null } = {}) {
  const db = await getDB();
  const grupos = await db.collection('bridgeGrupos').find({ activo: true, peticiones: true }).toArray();
  const res = [];
  for (const g of grupos) {
    const raw = await db.collection('grupoMensajes').find({ jid: g._id, pet: { $ne: true } }).sort({ ts: 1 }).limit(200).toArray();
    if (!raw.length) continue;
    // Se espera a que la persona acabe de escribir (el texto suele ir en varios mensajes y las fotos después).
    if (Date.now() - new Date(raw[raw.length - 1].ts).getTime() < 10 * 60 * 1000) continue;
    const { contexto, corpy } = await _contexto(db, g._id, raw[0].ts, raw[raw.length - 1].ts);
    const msgs = [...raw.map(m => ({ _id: m._id, fecha: m.ts, quien: m.quien, texto: m.texto, fotoIds: m.fotoIds || [], nMedia: (m.media || []).length })), ...corpy]
      .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
    const cat = _cat || await _catalogo();
    // Memoria de Corpy de los sitios que se nombran, SOLO de este grupo (lo de otros clientes o lo interno no entra).
    const memoria = await require('./memoria').paraPrompt(raw.map(m => m.texto || '').join(' '), { paraGrupo: g._id, limite: 40 }).catch(() => '');
    const r = await _tanda(db, { jid: g._id, grupo: g.nombre, msgs, fuente: 'whatsapp', cat, _llamar, contexto, memoria });
    await db.collection('grupoMensajes').updateMany({ _id: { $in: raw.map(m => m._id) } }, { $set: { pet: true } });
    for (const p of [...r.nuevas, ...r.actualizadas]) _memo(p);
    const mudas = r.nuevas.filter(sinAccion);
    if (mudas.length) await db.collection(COL).updateMany({ _id: { $in: mudas.map(p => p._id) } }, { $set: { estado: 'archivo', archivadoPor: 'sin acción' } });
    const nuevas = r.nuevas.filter(p => !sinAccion(p));
    let auto = {};
    try { auto = await _autoIncidencias(db, g, nuevas); } catch (e) { console.warn('[Peticiones] incidencias:', e.message); }
    if (avisar && (nuevas.length || r.actualizadas.some(importa))) await _avisarOficina(_textoAviso(g.nombre || 'WhatsApp', nuevas, r.actualizadas, auto));
    res.push({ grupo: g.nombre, mensajes: raw.length, nuevas: r.nuevas.length, actualizadas: r.actualizadas.length });
  }
  return res;
}

// ── Correos de administradores y clientes (2/11/2026, Álex: «que no nos queden correos sueltos»): Finques Company
// mandó tres correos por la gotera de Bellpuig 41 3-1 (8/10, 19/10 y 2/11, este ya avisando de que mandaban a otro
// industrial y nos pasaban la factura) y solo salió un aviso suelto cada vez. Ahora cada correo de incidencia entra como
// los mensajes de un grupo: petición, incidencia en StelOrder con operario propuesto, y si insisten se junta con la que
// había y se vuelve a avisar. Cada remitente (dominio) es su propio «grupo» correo:dominio.
const EXTRA_CORREO = `Esto es un CORREO (no un grupo de WhatsApp) de un administrador de fincas o de un cliente. Suele llevar debajo los correos anteriores citados: úsalos para entender, pero lo que cuenta es lo que pide el correo nuevo. Si insisten («no heu anat», «torna a sortir aigua», «quan anireu?») o avisan de que mandarán a otro industrial, es la misma petición (seguimiento) y es urgente.`;
const CORREO_GENERICO = /^(gmail|googlemail|hotmail|outlook|yahoo|icloud|live|msn|me)\./i;
function _limpiaCorreo(t) {
  return String(t || '').split(/\n-- ?\n|Este e-mail puede contener|Aquest e-mail pot contenir|This email may contain/i)[0]
    .replace(/^>+ ?/gm, '').replace(/\[https?:[^\]]+\]/g, '').replace(/<https?:[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();
}
function _jidCorreo(de) {
  const email = String((String(de).match(/<([^>]+)>/) || [, de])[1] || '').trim().toLowerCase();
  const dominio = email.split('@')[1] || email;
  const nombre = String(de).replace(/<[^>]*>/, '').replace(/"/g, '').trim() || email;
  return CORREO_GENERICO.test(dominio) ? { jid: 'correo:' + email, grupo: `Correo · ${nombre}`, nombre } : { jid: 'correo:' + dominio, grupo: `Correo · ${dominio}`, nombre };
}
async function deCorreo({ gmailId, de, asunto, cuerpo, fecha = new Date(), avisar = true, autoIncidencia = true, _llamar = null, _cat = null } = {}) {
  const db = await getDB();
  if (gmailId && await db.collection(COL).findOne({ gmailIds: gmailId })) return { ya: true };
  const { jid, grupo, nombre } = _jidCorreo(de);
  const texto = `Asunto: ${asunto}\n${_limpiaCorreo(cuerpo)}`.slice(0, 2500);
  const msgs = [{ fecha: new Date(fecha), quien: `${nombre} (correo)`, texto, fotoIds: [], nMedia: 0 }];
  const cat = _cat || await _catalogo();
  const memoria = await require('./memoria').paraPrompt(texto, { paraGrupo: jid, limite: 40 }).catch(() => '');
  const r = await _tanda(db, { jid, grupo, msgs, fuente: 'correo', cat, _llamar, extra: EXTRA_CORREO, memoria });
  const ids = [...r.nuevas, ...r.actualizadas].map(p => p._id);
  if (ids.length) await db.collection(COL).updateMany({ _id: { $in: ids } }, { $set: { canal: 'correo' }, $addToSet: { gmailIds: gmailId || null } });
  for (const p of [...r.nuevas, ...r.actualizadas]) _memo(p);
  const nuevas = r.nuevas.filter(p => !sinAccion(p));
  let auto = {};
  if (autoIncidencia) { try { auto = await _autoIncidencias(db, { _id: jid, autoIncidencia: true }, nuevas); } catch (e) { console.warn('[Peticiones] correo incidencias:', e.message); } }
  const avisado = !!(avisar && (nuevas.length || r.actualizadas.some(importa)));
  if (avisado) await _avisarOficina(_textoAviso(grupo, nuevas, r.actualizadas, auto));
  return { jid, nuevas: nuevas.map(p => ({ id: String(p._id), cliente: p.cliente, resumen: p.resumen, incidencia: (auto[String(p._id)] || {}).incidencia || p.incidencia || null })), actualizadas: r.actualizadas.map(p => String(p._id)), avisado };
}

// ── Recados de SecretarIA por teléfono (3/11/2026, Álex: «que los recados creen solos la incidencia, como los correos»):
// cuando nadie coge una llamada de Corp en Nuvo Voz la atiende SecretarIA y Nuvo Voz nos manda el recado (nuvoVoz.js).
// Entra como un correo más, en su propio «grupo» voz:corp: petición, incidencia en StelOrder con operario propuesto y
// «¿Quién va?» a Álex. El cliente viene por externalId (= account-id de StelOrder, de la caché: no gasta cupo). Del
// teléfono solo llegan las 3 últimas cifras. Si es URGENTE sale al momento un WhatsApp a Álex y a la oficina; si no,
// sin aviso suelto (sale en el de las 8:15 y en la pregunta de quién va).
const EXTRA_RECADO = `Esto es un RECADO que un cliente dejó por TELÉFONO a SecretarIA (la IA que coge las llamadas de Corp cuando nadie puede). Casi siempre es una sola petición. Si dice que ya llamó antes, que no hemos ido o que vuelve a pasar, es seguimiento. No hay teléfono completo: no lo inventes.`;
const JID_VOZ = 'voz:corp', GRUPO_VOZ = 'Llamadas · SecretarIA';
async function deRecado({ llamada, fecha = new Date(), urgente = false, resumen, titulo = null, contacto = null, final = '', _llamar = null, _cat = null, _enviar = null, _auto = null } = {}) {
  const db = await getDB();
  if (llamada && await db.collection(COL).findOne({ llamadas: String(llamada) })) return { ya: true };
  urgente = !!urgente || /^\s*URGENTE\b/i.test(resumen || '');
  const cat = _cat || await _catalogo();
  const ext = contacto && String(contacto.externalId || '').trim();
  const accId = ext && /^\d+$/.test(ext) && cat.nombre(ext) ? ext : null;
  const quien = `${corto(contacto && contacto.nombre, 60) || 'Cliente sin identificar'} (teléfono acabado en ${String(final || '').slice(-3) || '¿?'})`;
  const extra = EXTRA_RECADO + (accId ? `\nEl número que llamó es del cliente de StelOrder ${accId} · ${cat.nombre(accId)}: usa ese cliente_id salvo que el recado hable claramente de otra comunidad.` : '');
  const texto = corto(resumen, 2500);
  const msgs = [{ fecha: new Date(fecha), quien, texto, fotoIds: [], nMedia: 0 }];
  const memoria = await require('./memoria').paraPrompt(texto, { paraGrupo: JID_VOZ, limite: 40 }).catch(() => '');
  const r = await _tanda(db, { jid: JID_VOZ, grupo: GRUPO_VOZ, msgs, fuente: 'llamada', cat, _llamar, extra, memoria });
  for (const p of r.nuevas) {
    const set = { canal: 'llamada', recado: { nombre: corto(contacto && contacto.nombre, 60) || null, final: String(final || '').slice(-3) || null, fecha: new Date(fecha), texto } };
    if (corto(titulo, 60)) set.titulo = corto(titulo, 60);
    if (!p.clienteId && accId) Object.assign(set, { clienteId: accId, clienteStel: cat.nombre(accId) || null });
    if (urgente) set.urgente = true;
    Object.assign(p, set);
    await db.collection(COL).updateOne({ _id: p._id }, { $set: set, $addToSet: { llamadas: String(llamada || '') } });
  }
  for (const p of r.actualizadas) {
    await db.collection(COL).updateOne({ _id: p._id }, { $set: urgente ? { urgente: true } : {}, $addToSet: { llamadas: String(llamada || '') } });
    if (urgente) p.urgente = true;
  }
  for (const p of [...r.nuevas, ...r.actualizadas]) _memo(p);
  const nuevas = r.nuevas.filter(p => !sinAccion(p));
  let auto = {};
  try { auto = await (_auto || _autoIncidencias)(db, { _id: JID_VOZ, autoIncidencia: true }, nuevas); } catch (e) { console.warn('[Peticiones] recado incidencias:', e.message); }
  let avisado = false;
  if (urgente) {
    const lista = [...nuevas, ...r.actualizadas];
    const txt = `🚨 *URGENTE · recado de SecretarIA* (${fmt(fecha)})\n${quien}\n\n` + (lista.length ? _textoAviso(GRUPO_VOZ, nuevas, r.actualizadas, auto) : `${texto}\n\nNo he sacado ninguna petición de esto: míralo tú.`);
    const N = require('./notifications');
    for (const to of [...new Set([N.destinoDueno(), process.env.OFICINA_TELEFONO || '+34674013723'].filter(Boolean))]) {
      try { if (await (_enviar || N.sendWhatsAppTo)(to, txt, { importante: true }) !== false) avisado = true; } catch (e) { console.warn('[Peticiones] recado urgente:', e.message); }
    }
  }
  return { jid: JID_VOZ, urgente, avisado, nuevas: nuevas.map(p => ({ id: String(p._id), cliente: p.clienteStel || p.cliente, resumen: p.resumen, incidencia: (auto[String(p._id)] || {}).incidencia || p.incidencia || null, error: (auto[String(p._id)] || {}).error || null })), actualizadas: r.actualizadas.map(p => String(p._id)) };
}

// ── Historial: chat exportado de WhatsApp (.txt) ──
// Android: «20/10/26, 15:07 - Nombre: texto» · iPhone: «[20/10/26, 15:07:12] Nombre: texto». Las líneas sin fecha siguen
// el mensaje anterior. «<Multimedia omitido>», «imagen omitida», «‎image omitted»… cuentan como foto.
function parsearChat(txt) {
  const re = /^‎?\[?(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?\s?m\.?)?\]?\s*(?:-\s*)?([^:]{1,60}?):\s([\s\S]*)$/i;
  const out = [];
  for (const linea of String(txt || '').replace(/\r/g, '').split('\n')) {
    const m = re.exec(linea);
    if (m) {
      let [, d, mo, y, h, mi, s, ampm, quien, texto] = m;
      y = Number(y) < 100 ? 2000 + Number(y) : Number(y); h = Number(h);
      if (ampm && /p/i.test(ampm) && h < 12) h += 12; if (ampm && /a/i.test(ampm) && h === 12) h = 0;
      const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${mi}:${s || '00'}`;
      const fecha = new Date(new Date(iso + 'Z').getTime() - _offsetMadrid(iso) * 60000);
      const archivos = [...texto.matchAll(/<adjunto:\s*([^>]+)>/gi)].map(x => x[1].trim());
      const media = archivos.length > 0 || /multimedia omitido|omitid[oa]|image omitted|imagen omitida|video omitted|archivo adjunto/i.test(texto);
      const limpio = texto.replace(/\u200e?<adjunto:[^>]*>/gi, '').replace(/<?[^<>]*omitid[oa]>?|\u200e?image omitted/ig, '').replace(/\u200e/g, '').trim();
      out.push({ fecha, quien: quien.replace(/\u200e/g, '').trim(), texto: limpio, media, archivos });
    } else if (out.length && linea.trim()) out[out.length - 1].texto = (out[out.length - 1].texto + '\n' + linea.replace(/\u200e/g, '').trim()).trim();
  }
  return out.filter(m => (m.texto || m.media) && !/cifrados de extremo a extremo|end-to-end encrypted|creó el grupo|te añadió|añadió a|salió del grupo|cambió el (asunto|icono)/i.test(m.texto));
}
// Minutos de diferencia de Madrid con UTC en esa fecha (60 en invierno, 120 en verano).
function _offsetMadrid(iso) {
  const d = new Date(iso + 'Z');
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hourCycle: 'h23' }).format(d);
  return ((Number(t) - d.getUTCHours() + 24) % 24) * 60;
}

async function importarChat({ jid, texto, desde = null }) {
  const db = await getDB();
  const g = await db.collection('bridgeGrupos').findOne({ _id: String(jid) });
  if (!g) throw new Error('Ese grupo no lo ha visto el puente');
  let msgs = parsearChat(texto);
  if (desde) msgs = msgs.filter(m => m.fecha >= new Date(desde));
  if (!msgs.length) throw new Error('No he encontrado mensajes en el archivo (¿es el .txt de «Exportar chat»?)');
  // Lo ya importado (mismo grupo, fecha, quién y texto) no se repite.
  const ya = new Set((await db.collection(HIST).find({ jid: g._id }).project({ fecha: 1, quien: 1, texto: 1 }).toArray()).map(m => `${+m.fecha}|${m.quien}|${m.texto}`));
  const nuevos = msgs.filter(m => !ya.has(`${+m.fecha}|${m.quien}|${m.texto}`)).map(m => ({ jid: g._id, grupo: g.nombre, ...m, analizado: false, importado: new Date() }));
  if (nuevos.length) await db.collection(HIST).insertMany(nuevos);
  return { ok: true, leidos: msgs.length, nuevos: nuevos.length, desde: msgs[0].fecha, hasta: msgs[msgs.length - 1].fecha };
}

// Analiza el historial importado por tandas (sin avisos: se repasa en la lista).
const EXTRA_HISTORIAL = `Esto es el HISTORIAL antiguo del grupo (repaso para ver qué se nos escapó). Para cada petición di también si alguien de Corp contestó (respondimos) y si en el chat se ve que se hizo o se mandó el presupuesto (hecho_en_chat). En situacion usa «nuevo» cuando NO hay ni incidencia ni presupuesto en StelOrder que lo cubra. Para los presupuestos fíjate bien en el PRT que corresponde (mismo cliente y misma cosa, fecha poco después). Junta lo que es la misma cosa aunque se repita días después (eso es que insistieron).`;
async function analizarHistorial({ jid, tanda = 220, maxTandas = 200, _llamar = null, log = null } = {}) {
  const db = await getDB();
  const g = await db.collection('bridgeGrupos').findOne({ _id: String(jid) });
  if (!g) throw new Error('Grupo no encontrado');
  const primero = await db.collection(HIST).find({ jid: g._id, analizado: false }).sort({ fecha: 1 }).limit(1).toArray();
  if (!primero.length) return { tandas: 0, nuevas: 0 };
  const cat = await _catalogo({ desde: primero[0].fecha, historial: true });
  let tandas = 0, nuevas = 0, actualizadas = 0;
  while (tandas < maxTandas) {
    const raw = await db.collection(HIST).find({ jid: g._id, analizado: false }).sort({ fecha: 1 }).limit(tanda).toArray();
    if (!raw.length) break;
    const msgs = raw.map(m => ({ _id: m._id, fecha: m.fecha, quien: m.quien, texto: m.texto, nMedia: (m.archivos || []).length || (m.media ? 1 : 0), archivos: m.archivos || [] }));
    const arg = { jid: g._id, grupo: g.nombre, msgs, fuente: 'historial', cat: _ventana(cat, raw[0].fecha, raw[raw.length - 1].fecha), _llamar, extra: EXTRA_HISTORIAL, maxTokens: 16000 };
    let r;
    try { r = await _tanda(db, arg); }
    catch (e) { if (log) log(`tanda ${tandas + 1}: ${e.message} — reintento`); await new Promise(ok => setTimeout(ok, 20000)); r = await _tanda(db, arg); }
    await db.collection(HIST).updateMany({ _id: { $in: raw.map(m => m._id) } }, { $set: { analizado: true } });
    tandas++; nuevas += r.nuevas.length; actualizadas += r.actualizadas.length;
    if (log) log(`tanda ${tandas}: ${raw[0].fecha.toISOString().slice(0, 10)} → ${raw[raw.length - 1].fecha.toISOString().slice(0, 10)} · ${raw.length} mensajes · ${r.nuevas.length} nuevas, ${r.actualizadas.length} unidas`);
  }
  const quedan = await db.collection(HIST).countDocuments({ jid: g._id, analizado: false });
  return { tandas, nuevas, actualizadas, quedan };
}

async function lista({ estado = 'pendiente', jid = null, limite = 200 } = {}) {
  const db = await getDB();
  const q = {}; if (estado && estado !== 'todas') q.estado = estado; if (jid) q.jid = String(jid);
  const l = await db.collection(COL).find(q).sort({ urgente: -1, fecha: -1 }).limit(Math.min(500, limite)).toArray();
  return l.map(p => ({ ...p, id: String(p._id) }));
}

async function marcar(id, { estado, nota = '' }, por = '') {
  if (!['pendiente', 'hecho', 'descartado'].includes(estado)) throw new Error('Estado no válido');
  if (!ObjectId.isValid(String(id))) throw new Error('Petición no encontrada');
  const db = await getDB();
  const r = await db.collection(COL).updateOne({ _id: new ObjectId(String(id)) }, { $set: { estado, nota: corto(nota, 300), marcadoPor: por, marcadoAt: new Date() } });
  if (!r.matchedCount) throw new Error('Petición no encontrada');
  _memo(await db.collection(COL).findOne({ _id: new ObjectId(String(id)) }));
  return { ok: true };
}

async function marcarGrupo(jid, peticiones) {
  const db = await getDB();
  const r = await db.collection('bridgeGrupos').updateOne({ _id: String(jid) }, { $set: { peticiones: !!peticiones } });
  if (!r.matchedCount) throw new Error('Ese grupo aún no lo ha visto el puente');
  return { ok: true };
}

// ── Presupuesto mandado al grupo (30/10/2026): un PDF de presupuesto que alguien de Corp manda al grupo («PRT00853.pdf»,
// «PRESUPUESTODETRABAJO-00754-JOAN_MARAGALL__34.pdf») es un presupuesto ENVIADO. StelOrder no ve los envíos por WhatsApp
// y la petición seguía como pendiente: dos veces el mismo día se dio por no enviado lo que Álex ya había pasado. Se marca la
// petición (la que ya lleva ese PRT o la de presupuesto abierta del mismo cliente) y se deja la nota privada en StelOrder.
const RE_PRT = /(?:PRT|PRESUPUESTODETRABAJO[-_ ]?)0*(\d{3,5})/i;
function refDePdf(nombre) { const m = String(nombre || '').match(RE_PRT); return m ? 'PRT' + m[1].padStart(5, '0') : null; }
async function _notaStel(id, texto) {
  const S = require('./stelorder');
  if (S.enPausa() || S.cupoAgotado()) return false;
  const g = await S._client.get(`/workEstimates/${id}`, { timeout: 20000 });
  const b = Array.isArray(g.data) ? g.data[0] : g.data;
  if (!b || !b.id || String(b['private-comments'] || '').includes(texto)) return false;
  await S._client.put(`/workEstimates/${id}`, { ...b, 'private-comments': [b['private-comments'], texto].filter(Boolean).join('\n') }, { headers: { 'Content-Type': 'application/json; charset=utf-8' }, timeout: 25000 });
  return true;
}
async function presupuestoEnviado({ jid, grupo = null, nombres = [], por = '', ts = new Date() }, { _presupuestos = null, _nota = _notaStel } = {}) {
  const refs = [...new Set(nombres.map(refDePdf).filter(Boolean))];
  if (!refs.length) return { refs: [] };
  const db = await getDB();
  const prts = await (_presupuestos || require('./stelorder').getWorkEstimates)().catch(() => []);
  const out = [];
  for (const ref of refs) {
    const prt = (prts || []).find(e => (e['full-reference'] || '') === ref);
    let pets = await db.collection(COL).find({ jid, presupuesto: ref }).toArray();
    if (!pets.length && prt) pets = await db.collection(COL).find({ jid, tipo: 'presupuesto', estado: 'pendiente', clienteId: String(prt['account-id']) }).toArray();
    const queHacer = `${ref} enviado al grupo el ${fmt(ts)}${por ? ' por ' + por : ''}. Esperar respuesta.`;
    for (const p of pets) await db.collection(COL).updateOne({ _id: p._id }, { $set: { presupuesto: ref, situacion: 'ya_hay_presupuesto', estado: 'hecho', nota: 'Presupuesto enviado al grupo', queHacer, presupuestoEnviado: { ref, at: ts, por }, actualizado: new Date() } });
    let nota = false;
    if (prt) { try { nota = await _nota(prt.id, `Enviado por WhatsApp al grupo «${grupo || 'WhatsApp'}» el ${fmt(ts)}${por ? ' (' + por + ')' : ''}.`); } catch (e) { console.warn('[Peticiones] nota StelOrder:', e.message); } }
    out.push({ ref, peticiones: pets.length, nota });
  }
  return { refs: out };
}

// ── Presupuesto NUESTRO que el cliente devuelve al grupo (2/11/2026): CINC mandó escaneado el PRT00876 con el sello y la
// firma de la comunidad y acabó en Compras como si fuera un gasto; nadie se enteró de que lo aceptaban. Si lleva sello o
// firma se guarda el archivo, se marca la petición y se avisa a Álex y a oficina; StelOrder no se toca (lo decide Álex).
// Si solo nos reenvían nuestro PDF, nada.
async function presupuestoDevuelto({ jid, grupo = null, ref = null, nombre = null, firmado = false, quien = '', data = null, mimetype = null, msgId = null, ts = new Date() }, { _avisar = _avisarOficina } = {}) {
  const r = refDePdf(ref) || refDePdf(nombre);
  if (!firmado) return { ref: r, firmado: false };
  const db = await getDB();
  const f = data ? await db.collection('grupoFotos').insertOne({ jid, grupo, msgId, from: null, quien, texto: `${r || 'Presupuesto'} devuelto con sello o firma`, obraId: null, obraRef: null, mimetype, bytes: data.length, data, ts }) : null;
  const pets = r ? await db.collection(COL).find({ jid, $or: [{ presupuesto: r }, { 'presupuestoEnviado.ref': r }] }).toArray() : [];
  const queHacer = `${r} devuelto con sello/firma por ${quien} el ${fmt(ts)}: parece aceptado. Marcarlo como aceptado en StelOrder y programar el trabajo.`;
  for (const p of pets) { await db.collection(COL).updateOne({ _id: p._id }, { $set: { estado: 'pendiente', queHacer, presupuestoFirmado: { ref: r, at: ts, por: quien }, actualizado: new Date() }, ...(f ? { $addToSet: { fotoIds: String(f.insertedId) } } : {}) }); _memo({ ...p, estado: 'pendiente', queHacer, presupuestoFirmado: { ref: r, at: ts, por: quien } }); }
  await _avisar(`📝 *${quien || 'El cliente'}* ha devuelto en el grupo «${grupo || 'WhatsApp'}» el *${r || 'presupuesto'}* con sello o firma: parece que lo aceptan.\n→ Míralo y, si es así, márcalo como aceptado en StelOrder.`);
  return { ref: r, firmado: true, peticiones: pets.length };
}

// ── Incidencia en StelOrder desde una petición (botón «Crear incidencia» de la tarjeta). Presupuesto → tipo Presupuesto;
// lo demás → Actuación. Necesita el cliente de StelOrder; la descripción lleva el resumen, el contacto y los mensajes.
const TIPO_INC = { presupuesto: 3145, otro: 3146 };
async function crearIncidencia(id, por = '') {
  if (!ObjectId.isValid(String(id))) throw new Error('Petición no encontrada');
  const db = await getDB();
  const p = await db.collection(COL).findOne({ _id: new ObjectId(String(id)) });
  if (!p) throw new Error('Petición no encontrada');
  if (p.incidencia) throw new Error(`Ya tiene la incidencia ${p.incidencia}`);
  if (!p.clienteId) throw new Error('No sé de qué cliente de StelOrder es: ponle el cliente a mano en StelOrder');
  const { clientMap } = await require('./stelorder').getClients().catch(() => ({ clientMap: {} }));
  const descripcion = [tituloPeticion(p), '', p.resumen, ...detalle(p, { clientMap }), '', ...original(p)].join('\n').slice(0, 3800);
  const r = await require('./stelorder').crearIncidencia({ accId: p.clienteId, descripcion, tipoId: p.tipo === 'presupuesto' ? TIPO_INC.presupuesto : TIPO_INC.otro, requestedBy: por || 'Peticiones del grupo' });
  await db.collection(COL).updateOne({ _id: p._id }, { $set: { incidencia: r.ref, incidenciaId: r.id || null, situacion: 'ya_hay_incidencia', incidenciaCreadaPor: por, incidenciaCreadaAt: new Date() } });
  return { ok: true, ref: r.ref, id: r.id || null };
}

// ── Cómo se ven en StelOrder la incidencia y el pedido (3/11/2026, Álex con PDT00559: «faltaría el título y todo, que se
// vea mejor»). Título corto «URGENTE · Fuga de agua · Bellpuig 41» y, debajo del resumen, dónde, contacto y de dónde vino.
// Para todas las peticiones: grupos, correos y recados de SecretarIA.
const _dia = d => new Date(d).toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric' });
const _hora = d => new Date(d).toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' });
const esLlamada = p => p.canal === 'llamada' || p.jid === JID_VOZ;
function tituloPeticion(p) {
  const que = corto(p.titulo, 60) || corto(String(p.resumen || '').replace(/^\s*URGENTE\s*·\s*/i, '').split(/[.;:]/)[0], 50) || 'Petición';
  const cli = corto(p.clienteStel || p.cliente, 40);
  return corto(`${p.urgente ? 'URGENTE · ' : ''}${que}${cli ? ' · ' + cli : ''}`, 100);
}
// Líneas «Dónde», «Contacto» y el origen. La dirección sale de la ficha del cliente (caché de StelOrder) más el piso.
function detalle(p, { clientMap = {}, incidencia = null } = {}) {
  const c = p.clienteId ? clientMap[String(p.clienteId)] : null;
  const a = (c && c['main-address']) || {};
  const ficha = [a['address-data'], [a['postal-code'], a['city-town']].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const donde = [ficha ? `${corto(c['legal-name'] || c.name, 60)} · ${ficha}` : '', p.direccion ? `(${p.direccion})` : ''].filter(Boolean).join(' ');
  const r = p.recado || {};
  const contacto = p.contacto || (esLlamada(p) ? `${r.nombre || 'sin nombre'}${r.final ? ` · teléfono acabado en ${r.final} (completo en Nuvo Voz)` : ''}` : '');
  const f = (esLlamada(p) && r.fecha) || p.fecha;
  const origen = esLlamada(p) ? `Llamada del ${_dia(f)} a las ${_hora(f)} · atendida por SecretarIA (Nuvo Voz)`
    : p.canal === 'correo' ? `Correo de ${String(p.grupo || '').replace(/^Correo · /, '') || 'un cliente'} del ${_dia(f)} a las ${_hora(f)}`
      : `Pedido en el grupo «${p.grupo || 'WhatsApp'}» el ${_dia(f)} a las ${_hora(f)}`;
  return [donde ? `Dónde: ${donde}` : '', contacto ? `Contacto: ${contacto}` : '', `${origen}${incidencia ? ' · ' + incidencia : ''}`].filter(Boolean);
}
// Lo que dijeron tal cual: el recado entero o los últimos mensajes del grupo/correo.
function original(p) {
  if (esLlamada(p)) return ['Recado completo:', corto((p.recado && p.recado.texto) || (p.mensajes || [])[0]?.texto, 2500)];
  return ['Mensajes:', ...(p.mensajes || []).slice(-6).map(m => `${fmt(m.fecha)} ${m.quien}: ${corto(m.texto, 300)}`)];
}

// ── Resumen diario por correo (20:30): lo que ha pasado hoy en los grupos y lo que sigue abierto ──
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function resumenDiario({ hoy = new Date(), enviar = true, _enviar = null } = {}) {
  const db = await getDB();
  const ymd = new Date(hoy).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
  const ini = new Date(new Date(ymd + 'T00:00:00Z').getTime() - _offsetMadrid(ymd + 'T00:00:00') * 60000);   // medianoche en Madrid
  const grupos = await db.collection('bridgeGrupos').find({ activo: true, peticiones: true }).toArray();
  if (!grupos.length) return { enviado: false, motivo: 'sin grupos' };
  const jids = grupos.map(g => g._id);
  const [nMsgs, nuevas, pend] = await Promise.all([
    db.collection('grupoMensajes').countDocuments({ jid: { $in: jids }, ts: { $gte: ini } }),
    db.collection(COL).find({ $or: [{ jid: { $in: jids } }, { canal: { $in: ['correo', 'llamada'] } }], creado: { $gte: ini }, fuente: { $ne: 'historial' } }).sort({ urgente: -1, fecha: 1 }).toArray(),
    db.collection(COL).find({ $or: [{ jid: { $in: jids } }, { canal: { $in: ['correo', 'llamada'] } }], estado: 'pendiente' }).sort({ urgente: -1, fecha: 1 }).toArray(),
  ]);
  if (!nMsgs && !nuevas.length && !pend.length) return { enviado: false, motivo: 'nada' };
  const et = { presupuesto: 'Presupuesto', trabajo: 'Trabajo', queja: 'Queja', consulta: 'Consulta', aviso: 'Aviso' };
  const sit = p => p.situacion === 'ya_hay_incidencia' ? `está en ${p.incidencia || 'una incidencia'}` : p.situacion === 'ya_hay_presupuesto' ? `hay ${p.presupuesto || 'presupuesto'}` : p.situacion === 'seguimiento' ? 'insisten' : 'nuevo, no está en StelOrder';
  const dias = p => Math.floor((Date.now() - new Date(p.fecha).getTime()) / 86400000);
  const fila = p => `<tr><td style="padding:6px 8px;border-top:1px solid #ddd;white-space:nowrap">${p.urgente ? '🚨 ' : ''}${et[p.tipo] || p.tipo}</td><td style="padding:6px 8px;border-top:1px solid #ddd"><b>${esc(p.cliente)}</b>${p.direccion ? ' · ' + esc(p.direccion) : ''}<br>${esc(p.resumen)}<br><span style="color:#666">→ ${esc(p.queHacer)} (${esc(sit(p))}${dias(p) > 0 ? ` · ${dias(p)} días` : ''})</span></td></tr>`;
  const tabla = l => `<table style="border-collapse:collapse;font:14px system-ui,sans-serif;width:100%">${l.map(fila).join('')}</table>`;
  const viejas = pend.filter(p => dias(p) >= 7);
  const fecha = new Date(hoy).toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'long', day: 'numeric', month: 'long' });
  const html = `<div style="font:14px system-ui,sans-serif;max-width:720px">
<h2 style="margin:0 0 4px">Grupos de clientes · ${esc(fecha)}</h2>
<p style="color:#555;margin:0 0 14px">${nMsgs} mensaje${nMsgs === 1 ? '' : 's'} hoy · ${nuevas.length} petición${nuevas.length === 1 ? '' : 'es'} nueva${nuevas.length === 1 ? '' : 's'} · ${pend.length} abierta${pend.length === 1 ? '' : 's'}${viejas.length ? ` (${viejas.length} con más de una semana)` : ''}</p>
${nuevas.length ? `<h3 style="margin:16px 0 4px">Nuevo hoy</h3>${tabla(nuevas)}` : ''}
${pend.length ? `<h3 style="margin:16px 0 4px">Sigue abierto</h3>${tabla(pend.filter(p => !nuevas.some(n => String(n._id) === String(p._id))).slice(0, 40))}` : ''}
<p style="color:#888;margin-top:16px">Lo marcáis como hecho o descartado en el inicio del dashboard (Peticiones de los grupos).</p></div>`;
  const text = `Grupos de clientes · ${fecha}\n${nMsgs} mensajes hoy · ${nuevas.length} nuevas · ${pend.length} abiertas\n\n` + [...nuevas, ...pend.filter(p => !nuevas.some(n => String(n._id) === String(p._id)))].slice(0, 50).map(p => `- ${et[p.tipo] || p.tipo} · ${p.cliente}: ${p.resumen} → ${p.queHacer} (${sit(p)})`).join('\n');
  const subject = `Grupos de clientes · ${nuevas.length} nueva${nuevas.length === 1 ? '' : 's'}, ${pend.length} abierta${pend.length === 1 ? '' : 's'}`;
  if (!enviar) return { enviado: false, subject, html, text };
  const to = process.env.RESUMEN_GRUPOS_EMAIL || process.env.EMAIL_ADMIN || 'hola@corpprojects.es';
  const bcc = process.env.EMAIL_OFICINA || 'hola@corpprojects.es';
  const ok = await (_enviar || require('./notifications').sendEmail)({ to, bcc: bcc !== to ? bcc : undefined, subject, html, text });
  return { enviado: !!ok, to, subject, nuevas: nuevas.length, abiertas: pend.length };
}

module.exports = { _citaAlCalendario, deCorreo, deRecado, JID_VOZ, tituloPeticion, detalle, original, _limpiaCorreo, _jidCorreo, presupuestoEnviado, presupuestoDevuelto, refDePdf, crearIncidencia, resumenDiario, _ventana, analizar, importarChat, analizarHistorial, parsearChat, lista, marcar, marcarGrupo, _tanda, _textoAviso, _autoIncidencias, _sinAccion: sinAccion, _contexto, TIPOS };
