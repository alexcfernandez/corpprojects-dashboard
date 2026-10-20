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
  const incidencias = (inc || []).filter(i => !i.deleted && (historial ? new Date(i.date) >= lim : (ESTADOS_INC_ABIERTA.test(st[i['incident-state-id']] || '') || new Date(i.date) >= lim)))
    .map(i => `${i['full-reference']} · ${String(i.date).slice(0, 10)} · ${st[i['incident-state-id']] || '?'} · ${corto(tipos[i['incident-type-id']], 14)} · ${corto(nombre(i['account-id']), 40)} · ${corto(i.description, 140)}`);
  const presupuestos = (est || []).filter(e => !e.deleted && new Date(e.date) >= lim)
    .map(e => `${e['full-reference']} · ${String(e.date).slice(0, 10)} · ${corto(nombre(e['account-id']), 40)} · ${corto(e.title, 80) || 's/t'} · ${e['total-amount']} €`);
  return { clientes, incidencias, presupuestos, nombre };
}

async function _llamarIA(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Falta ANTHROPIC_API_KEY');
  const c = new AbortController(); const tm = setTimeout(() => c.abort(), 180000);
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: c.signal,
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: require('./config').ia.agente, max_tokens: 8000, tools: [HERRAMIENTA], tool_choice: { type: 'tool', name: HERRAMIENTA.name }, messages: [{ role: 'user', content: prompt }] }) }).finally(() => clearTimeout(tm));
  const d = await r.json();
  if (!r.ok) throw new Error(`API ${r.status}: ${d.error?.message || ''}`);
  const tu = (d.content || []).find(b => b.type === 'tool_use');
  return tu ? tu.input : { peticiones: [] };
}

// Analiza una tanda de mensajes [{ _id, fecha, quien, texto, fotoIds, nMedia }] de UN grupo.
async function _tanda(db, { jid, grupo, msgs, fuente, cat, _llamar }) {
  const abiertas = await db.collection(COL).find({ jid, estado: 'pendiente' }).sort({ creado: -1 }).limit(40).toArray();
  const lineas = msgs.map((m, n) => `[${n}] ${fmt(m.fecha)} ${m.quien}: ${corto(m.texto, 900) || '(sin texto)'}${m.nMedia ? ` (📷 ${m.nMedia} foto${m.nMedia > 1 ? 's' : ''})` : ''}`);
  const prompt = `${INSTRUCCIONES}

GRUPO: ${grupo || jid}

MENSAJES:
${lineas.join('\n')}

PETICIONES ABIERTAS (id · cliente · resumen):
${abiertas.map(p => `${p._id} · ${p.cliente} · ${corto(p.resumen, 120)}`).join('\n') || '(ninguna)'}

INCIDENCIAS DE STELORDER (ref · fecha · estado · tipo · cliente · descripción):
${cat.incidencias.join('\n')}

PRESUPUESTOS RECIENTES (ref · fecha · cliente · título · total):
${cat.presupuestos.join('\n')}

CLIENTES (id · nombre):
${cat.clientes.join('\n')}`;
  const out = _llamar ? await _llamar(prompt) : await _llamarIA(prompt);
  const nuevas = [], actualizadas = [];
  for (const p of (out.peticiones || [])) {
    const ms = (p.msgs || []).map(n => msgs[n]).filter(Boolean);
    if (!ms.length) continue;
    const mensajes = ms.map(m => ({ fecha: m.fecha, quien: m.quien, texto: corto(m.texto, 1000) }));
    const fotoIds = ms.flatMap(m => m.fotoIds || []);
    const set = { tipo: TIPOS.includes(p.tipo) ? p.tipo : 'consulta', clienteId: p.cliente_id && /^\d+$/.test(String(p.cliente_id)) ? String(p.cliente_id) : null,
      cliente: corto(p.cliente, 120), direccion: corto(p.direccion, 120) || null, contacto: corto(p.contacto, 120) || null, resumen: corto(p.resumen, 400), queHacer: corto(p.que_hacer, 300),
      urgente: !!p.urgente, situacion: SITUACIONES.includes(p.situacion) ? p.situacion : 'nuevo', incidencia: corto(p.incidencia, 12) || null, presupuesto: corto(p.presupuesto, 12) || null, actualizado: new Date() };
    if (set.clienteId) set.clienteStel = cat.nombre(set.clienteId) || null;
    const prev = p.actualiza && ObjectId.isValid(String(p.actualiza)) ? abiertas.find(a => String(a._id) === String(p.actualiza)) : null;
    if (prev) {
      await db.collection(COL).updateOne({ _id: prev._id }, { $set: set, $push: { mensajes: { $each: mensajes } }, $addToSet: { fotoIds: { $each: fotoIds } } });
      actualizadas.push({ ...prev, ...set });
    } else {
      const doc = { jid, grupo: grupo || null, ...set, quien: ms[0].quien, mensajes, fotoIds, fuente, fecha: ms[0].fecha, estado: 'pendiente', creado: new Date() };
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
      const media = /multimedia omitido|omitid[oa]|image omitted|imagen omitida|video omitted|<adjunto|archivo adjunto|\.jpg|\.pdf \(/i.test(texto);
      out.push({ fecha, quien: quien.replace(/^‎/, '').trim(), texto: media ? texto.replace(/<?[^<>]*omitid[oa]>?|‎?image omitted/ig, '').trim() : texto.trim(), media });
    } else if (out.length && linea.trim()) out[out.length - 1].texto += '\n' + linea.trim();
  }
  return out.filter(m => !/cifrados de extremo a extremo|end-to-end encrypted|creó el grupo|te añadió|añadió a|salió del grupo|cambió el (asunto|icono)/i.test(m.texto));
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
async function analizarHistorial({ jid, tanda = 120, maxTandas = 30, _llamar = null } = {}) {
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
    const msgs = raw.map(m => ({ _id: m._id, fecha: m.fecha, quien: m.quien, texto: m.texto, nMedia: m.media ? 1 : 0 }));
    const r = await _tanda(db, { jid: g._id, grupo: g.nombre, msgs, fuente: 'historial', cat, _llamar });
    await db.collection(HIST).updateMany({ _id: { $in: raw.map(m => m._id) } }, { $set: { analizado: true } });
    tandas++; nuevas += r.nuevas.length; actualizadas += r.actualizadas.length;
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

module.exports = { analizar, importarChat, analizarHistorial, parsearChat, lista, marcar, marcarGrupo, _tanda, _textoAviso, TIPOS };
