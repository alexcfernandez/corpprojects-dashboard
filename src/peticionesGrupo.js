// src/peticionesGrupo.js — Lo que nos piden en los grupos de clientes (20/10/2026, Álex: «que se lea todo el grupo de SYNC,
// que busque todo lo que dicen de pedir presupuesto, las incidencias… y las mire con StelOrder y haga el primer filtrado»).
//
// Corpy está en el grupo en MODO ESCUCHA (grupoWhatsapp.js guarda los mensajes y no contesta nunca). Los grupos marcados
// con `peticiones: true` en bridgeGrupos pasan además por aquí: cada media hora la IA lee lo nuevo, lo separa en
// peticiones (presupuesto / trabajo / queja / consulta / aviso) y lo cruza con StelOrder (cliente, incidencias abiertas,
// presupuestos recientes) para decir si ya está cubierto o es nuevo. A Álex y a la oficina les llega un aviso con lo
// nuevo y queda la lista en el inicio del dashboard. No se escribe nada en StelOrder ni en el grupo.
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
      que_hacer: { type: 'string', description: 'Lo siguiente que tiene que hacer la oficina (ir a mirar, hacer presupuesto, llamar a…, nada)' },
      urgente: { type: 'boolean', description: 'Agua entrando, sin luz, peligro, se quejan de que no fuimos…' },
      situacion: { type: 'string', enum: SITUACIONES, description: 'nuevo; ya_hay_incidencia (una incidencia ABIERTA ya lo cubre); ya_hay_presupuesto (ya se hizo el presupuesto); seguimiento (insisten o preguntan por algo que ya estaba pedido)' },
      incidencia: { type: ['string', 'null'], description: 'INCxxxxx de StelOrder que lo cubre, si la hay' },
      presupuesto: { type: ['string', 'null'], description: 'PRTxxxxx de StelOrder que lo cubre, si lo hay' },
      actualiza: { type: ['string', 'null'], description: 'id de una petición anterior (lista PETICIONES ABIERTAS) si esto es la misma cosa' },
      respondimos: { type: 'boolean', description: 'Alguien de Corp contestó en el chat a esta petición' },
      hecho_en_chat: { type: 'boolean', description: 'En el chat se ve que se hizo, se mandó el presupuesto o se cerró (fotos de acabado, «ya está», «enviado»…)' },
    }, required: ['msgs', 'tipo', 'cliente', 'resumen', 'que_hacer', 'urgente', 'situacion'] } },
  }, required: ['peticiones'] },
};

const INSTRUCCIONES = `Eres de la oficina de Corp Projects Holding SL (reformas y mantenimiento de comunidades en Girona). Te paso mensajes de un grupo de WhatsApp con un administrador de fincas que nos encarga trabajos. Sepáralos en PETICIONES: cada cosa distinta que nos piden (un presupuesto, un trabajo, una queja, una consulta o un aviso). Junta en la misma petición los mensajes que hablan de lo mismo (texto + fotos + contacto que viene después). Lo que no pide nada (saludos, «ok», «gracias», emojis, conversación) no es petición.
Cruza cada una con StelOrder: busca el cliente en CLIENTES (las comunidades suelen ir por calle y número; «Ctat.», «CP», «Comunitat» = comunidad). Mira si una INCIDENCIA ABIERTA o un PRESUPUESTO RECIENTE del mismo cliente ya lo cubre (misma cosa, no solo mismo cliente). Si hay una PETICIÓN ABIERTA que es la misma cosa, pon su id en «actualiza».
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
async function _tanda(db, { jid, grupo, msgs, fuente, cat, _llamar, extra = '', maxTokens = 8000 }) {
  const abiertas = await db.collection(COL).find({ jid, estado: { $in: ['pendiente', 'archivo'] } }).sort({ fecha: -1 }).limit(fuente === 'historial' ? 80 : 40).toArray();
  const nuestros = [...new Set(msgs.map(m => m.quien).filter(q => NUESTROS.test(q || '')))];
  const lineas = msgs.map((m, n) => `[${n}] ${fmt(m.fecha)} ${m.quien}: ${corto(m.texto, 900) || '(sin texto)'}${m.nMedia ? ` (📷 ${m.nMedia} foto${m.nMedia > 1 ? 's' : ''})` : ''}`);
  const prompt = `${INSTRUCCIONES}${extra ? '\n' + extra : ''}

GRUPO: ${grupo || jid}${nuestros.length ? `\nSON DE CORP (los demás son el administrador o vecinos): ${nuestros.join(', ')}` : ''}

MENSAJES:
${lineas.join('\n')}

PETICIONES ABIERTAS (id · cliente · resumen):
${abiertas.map(p => `${p._id} · ${p.cliente} · ${corto(p.resumen, 120)}`).join('\n') || '(ninguna)'}

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
      cliente: corto(p.cliente, 120), direccion: corto(p.direccion, 120) || null, contacto: corto(p.contacto, 120) || null, resumen: corto(p.resumen, 400), queHacer: corto(p.que_hacer, 300),
      urgente: !!p.urgente, respondimos: p.respondimos == null ? null : !!p.respondimos, hechoEnChat: p.hecho_en_chat == null ? null : !!p.hecho_en_chat, situacion: SITUACIONES.includes(p.situacion) ? p.situacion : 'nuevo', incidencia: corto(p.incidencia, 12) || null, presupuesto: corto(p.presupuesto, 12) || null, actualizado: new Date() };
    if (set.clienteId) set.clienteStel = cat.nombre(set.clienteId) || null;
    const prev = p.actualiza && ObjectId.isValid(String(p.actualiza)) ? abiertas.find(a => String(a._id) === String(p.actualiza)) : null;
    if (prev) {
      await db.collection(COL).updateOne({ _id: prev._id }, { $set: set, $push: { mensajes: { $each: mensajes } }, $addToSet: { fotoIds: { $each: fotoIds }, archivos: { $each: ms.flatMap(m => m.archivos || []) } } });
      actualizadas.push({ ...prev, ...set });
    } else {
      // Del historial solo quedan a la vista (pendiente) las de los últimos 90 días que no se ven hechas; el resto, al archivo
      // para el informe de lo que se nos escapó.
      const reciente = Date.now() - new Date(ms[0].fecha).getTime() < 90 * 86400000;
      const estado = fuente !== 'historial' ? 'pendiente' : (reciente && !set.hechoEnChat && set.situacion !== 'ya_hay_presupuesto' ? 'pendiente' : 'archivo');
      const archivos = ms.flatMap(m => m.archivos || []);
      const doc = { jid, grupo: grupo || null, ...set, quien: ms[0].quien, mensajes, fotoIds, archivos, fuente, fecha: ms[0].fecha, estado, creado: new Date() };
      const r = await db.collection(COL).insertOne(doc);
      nuevas.push({ ...doc, _id: r.insertedId });
    }
  }
  return { nuevas, actualizadas };
}

function _textoAviso(grupo, nuevas, actualizadas) {
  const et = { presupuesto: '💶 Presupuesto', trabajo: '🔧 Trabajo', queja: '⚠️ Queja', consulta: '❓ Consulta', aviso: 'ℹ️ Aviso' };
  const sit = p => p.situacion === 'ya_hay_incidencia' ? ` (ya está en ${p.incidencia || 'una incidencia'})` : p.situacion === 'ya_hay_presupuesto' ? ` (ya hay ${p.presupuesto || 'presupuesto'})` : p.situacion === 'seguimiento' ? ' (insisten)' : '';
  const l = [...nuevas, ...actualizadas.filter(p => p.urgente || p.situacion === 'seguimiento')];
  return `📋 *Grupo «${grupo}»*: ${l.length} cosa${l.length > 1 ? 's' : ''} que nos piden\n\n` +
    l.map(p => `${p.urgente ? '🚨 ' : ''}${et[p.tipo] || p.tipo} · *${p.cliente}*${p.direccion ? ' ' + p.direccion : ''}: ${p.resumen}${sit(p)}\n   → ${p.queHacer}`).join('\n\n') +
    `\n\nLas tienes en el inicio del dashboard (Peticiones de los grupos).`;
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
    const msgs = raw.map(m => ({ _id: m._id, fecha: m.ts, quien: m.quien, texto: m.texto, fotoIds: m.fotoIds || [], nMedia: (m.media || []).length }));
    const cat = _cat || await _catalogo();
    const r = await _tanda(db, { jid: g._id, grupo: g.nombre, msgs, fuente: 'whatsapp', cat, _llamar });
    await db.collection('grupoMensajes').updateMany({ _id: { $in: raw.map(m => m._id) } }, { $set: { pet: true } });
    if (avisar && (r.nuevas.length || r.actualizadas.some(p => p.urgente || p.situacion === 'seguimiento'))) {
      const N = require('./notifications');
      const txt = _textoAviso(g.nombre || 'WhatsApp', r.nuevas, r.actualizadas);
      for (const to of [...new Set([N.destinoDueno(), process.env.OFICINA_TELEFONO || '+34674013723'].filter(Boolean))]) {
        try { await N.sendWhatsAppTo(to, txt); } catch (e) { console.warn('[Peticiones] aviso:', e.message); }
      }
    }
    res.push({ grupo: g.nombre, mensajes: raw.length, nuevas: r.nuevas.length, actualizadas: r.actualizadas.length });
  }
  return res;
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
  return { ok: true };
}

async function marcarGrupo(jid, peticiones) {
  const db = await getDB();
  const r = await db.collection('bridgeGrupos').updateOne({ _id: String(jid) }, { $set: { peticiones: !!peticiones } });
  if (!r.matchedCount) throw new Error('Ese grupo aún no lo ha visto el puente');
  return { ok: true };
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
  const msgs = (p.mensajes || []).slice(-6).map(m => `${fmt(m.fecha)} ${m.quien}: ${corto(m.texto, 300)}`).join('\n');
  const descripcion = [`${p.resumen}${p.direccion ? ' (' + p.direccion + ')' : ''}`, p.contacto ? `Contacto: ${p.contacto}` : '', `Grupo «${p.grupo || 'WhatsApp'}»:`, msgs].filter(Boolean).join('\n').slice(0, 3800);
  const r = await require('./stelorder').crearIncidencia({ accId: p.clienteId, descripcion, tipoId: p.tipo === 'presupuesto' ? TIPO_INC.presupuesto : TIPO_INC.otro, requestedBy: por || 'Peticiones del grupo' });
  await db.collection(COL).updateOne({ _id: p._id }, { $set: { incidencia: r.ref, incidenciaId: r.id || null, situacion: 'ya_hay_incidencia', incidenciaCreadaPor: por, incidenciaCreadaAt: new Date() } });
  return { ok: true, ref: r.ref, id: r.id || null };
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
    db.collection(COL).find({ jid: { $in: jids }, creado: { $gte: ini }, fuente: { $ne: 'historial' } }).sort({ urgente: -1, fecha: 1 }).toArray(),
    db.collection(COL).find({ jid: { $in: jids }, estado: 'pendiente' }).sort({ urgente: -1, fecha: 1 }).toArray(),
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

module.exports = { crearIncidencia, resumenDiario, _ventana, analizar, importarChat, analizarHistorial, parsearChat, lista, marcar, marcarGrupo, _tanda, _textoAviso, TIPOS };
