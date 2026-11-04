// src/gestionPeticiones.js — Álex gestiona recados y peticiones hablando con Corpy (4/11/2026): «descarta el de Exolution»,
// «el de Belpuig no es de ILLA VERDA, es un proveedor», «confirma el de Katerin», «ya he devuelto la llamada a CTAT
// Barcelona 51», «lo de la bañera lo hace Álex».
// Para que Corpy no se líe: nunca toca nada a la primera. Repite en una línea qué va a hacer y sobre qué petición
// (cliente, cuándo y nº) y solo lo hace cuando Álex contesta «sí» en el mensaje siguiente. Si encajan varias, da una lista
// corta numerada y Álex elige. Nada se borra: descartar es un estado y cada cambio queda apuntado en la petición.

const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const COL = 'peticionesGestion';      // { _id: from, accion, ids?, id?, extra, ts }: lo que espera el «sí» o el número
const TTL = 10 * 60 * 1000;
const POR = 'Álex (Corpy)';
const ACCIONES = ['descartar', 'hecho', 'confirmar', 'no_es_cliente', 'devuelta', 'asignar'];
const VERBO = { descartar: 'Descartar', hecho: 'Dar por hecha', confirmar: 'Confirmar', no_es_cliente: 'Pasar a «Otros / no es cliente»', devuelta: 'Apuntar que has devuelto la llamada de', asignar: 'Mandar a' };

const _n = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
const VACIAS = new Set(['el', 'la', 'lo', 'los', 'las', 'de', 'del', 'que', 'es', 'un', 'una', 'ya', 'he', 'a', 'al', 'en', 'y', 'con', 'por', 'recado', 'peticion', 'llamada', 'ctat', 'prop', 'comunidad', 'comunitat', 'cp', 'calle', 'carrer', 'c']);
const _palabras = q => _n(q).split(' ').filter(w => w.length >= 2 && !VACIAS.has(w));
// Cuántas palabras de lo que dice Álex están en la petición (los números cuentan doble y restan si no están).
function puntos(texto, q) {
  const t = ' ' + _n(texto) + ' ';
  let p = 0;
  for (const w of _palabras(q)) {
    if (/^\d+$/.test(w)) p += new RegExp(`(^|[^0-9])${w}([^0-9]|$)`).test(t) ? 2 : -1;
    else if (t.includes(w)) p += 1;
  }
  return p;
}
const _cuando = d => {
  const f = new Date(d), tz = { timeZone: 'Europe/Madrid' };
  const dia = x => new Date(x).toLocaleDateString('en-CA', tz);
  const h = f.toLocaleTimeString('es-ES', { ...tz, hour: '2-digit', minute: '2-digit' });
  if (dia(f) === dia(Date.now())) return `hoy ${h}`;
  if (dia(f) === dia(Date.now() - 864e5)) return `ayer ${h}`;
  return `${f.toLocaleDateString('es-ES', { ...tz, day: '2-digit', month: '2-digit' })} ${h}`;
};
const nRef = c => c.tipo === 'perdida' ? `perdida …${c.final || '¿?'}` : (c.p.incidencia || `ref. ${String(c.p._id).slice(-5)}`);
const _quien = p => p.noCliente ? (p.noCliente.que || p.cliente) : (p.clienteStel || p.cliente);
function etiqueta(c) {
  if (c.tipo === 'perdida') return `llamada perdida de *${c.nombre || 'número sin nombre'}* · ${_cuando(c.fecha)} · ${nRef(c)}`;
  const p = c.p, que = p.titulo || String(p.resumen || '').slice(0, 60);
  return `*${_quien(p)}*${que ? ` (${que})` : ''} · ${p.canal === 'llamada' || p.jid === 'voz:corp' ? 'recado' : p.canal === 'correo' ? 'correo' : 'grupo'} ${_cuando(p.fecha)} · ${nRef(c)}`;
}

// Lo que puede ser «el de Exolution»: peticiones abiertas de los últimos 45 días y, para «ya he devuelto», también las
// perdidas sin devolver de la última semana.
async function candidatos(accion, q, { _db = null } = {}) {
  const db = _db || await getDB();
  const ps = await db.collection('peticionesGrupo').find({ estado: 'pendiente', fecha: { $gte: new Date(Date.now() - 45 * 864e5) } }).sort({ fecha: -1 }).limit(400).toArray();
  const vale = p => accion === 'confirmar' ? !!(p.porConfirmar || p.noCliente) : accion === 'no_es_cliente' ? !p.noCliente && !p.incidencia && !(p.pedido && p.pedido.id)
    : accion === 'asignar' ? !(p.pedido && p.pedido.id) && !p.noCliente : accion === 'devuelta' ? (p.canal === 'llamada' || p.jid === 'voz:corp') && !p.llamadaDevuelta : true;
  const texto = p => [p.cliente, p.clienteStel, p.recado && p.recado.nombre, p.noCliente && p.noCliente.que, p.titulo, p.resumen, p.direccion, p.contacto, p.incidencia, String(p._id).slice(-5), p.grupo].filter(Boolean).join(' ');
  const l = ps.filter(vale).map(p => ({ tipo: 'peticion', p, id: String(p._id), pts: puntos(texto(p), q) }));
  if (accion === 'devuelta') {
    try {
      const V = require('./nuvoVoz');
      const per = await V.perdidasSinRecado(new Date(Date.now() - 7 * 864e5), new Date(), { _db: db });
      for (const x of per) {
        const nombre = (x.contacto && x.contacto.nombre) || null;
        l.push({ tipo: 'perdida', id: String(x._id), nombre, final: x.final || null, fecha: x.fecha, pts: puntos(`${nombre || ''} ${x.final || ''}`, q) });
      }
    } catch (e) { console.warn('[Gestión peticiones] perdidas:', e.message); }
  }
  const top = Math.max(0, ...l.map(x => x.pts));
  return top >= 1 ? l.filter(x => x.pts === top) : [];
}

async function _guardar(from, doc, db) { await db.collection(COL).replaceOne({ _id: String(from) }, { _id: String(from), ...doc, ts: new Date() }, { upsert: true }); }
async function _cliente(nombre) {
  const { clientMap } = await require('./stelorder').getClients();
  const c = Object.entries(clientMap).map(([id, x]) => ({ id, nombre: x.name, pts: puntos(x.name, nombre) })).filter(x => x.pts >= 1).sort((a, b) => b.pts - a.pts);
  if (!c.length) return { error: `No encuentro el cliente «${nombre}» en StelOrder.` };
  const igual = c.filter(x => x.pts === c[0].pts);
  return igual.length === 1 ? igual[0] : { error: `¿Qué cliente? ${igual.slice(0, 5).map(x => x.nombre).join(' · ')}` };
}
function _pregunta(accion, c, extra) {
  const tras = accion === 'confirmar' && extra.clienteNombre ? ` como de *${extra.clienteNombre}*` : '';
  const linea = accion === 'asignar' ? `${VERBO.asignar} *${extra.operarioNombre}* a ${etiqueta(c)}` : accion === 'devuelta' && c.tipo === 'perdida' ? `Apuntar que has devuelto la ${etiqueta(c)}` : `${VERBO[accion]} ${etiqueta(c)}${tras}`;
  return `¿Hago esto? ${linea}.\nContesta «sí» o «no».`;
}

// Herramienta de Corpy: busca la petición y PREGUNTA. No cambia nada.
async function proponer(input = {}, from, { _db = null } = {}) {
  const db = _db || await getDB();
  const accion = ACCIONES.includes(input.accion) ? input.accion : null;
  if (!accion) return '¿Qué hago con esa petición: descartarla, darla por hecha, confirmarla, pasarla a «no es cliente», apuntar que has devuelto la llamada o mandar a alguien?';
  const extra = { nota: String(input.nota || '').slice(0, 300) };
  if (accion === 'confirmar' && input.cliente) { const c = await _cliente(input.cliente); if (c.error) return c.error; Object.assign(extra, { clienteId: c.id, clienteNombre: c.nombre }); }
  if (accion === 'asignar') {
    if (!input.operario) return '¿Quién va?';
    const N = require('./nombres');
    const users = (await require('./users').getUsers(false)).filter(x => x.active !== false);
    const u = /^(yo|yo mismo)$/i.test(_n(input.operario)) ? require('./trabajosSeguimiento')._yo(from, users) : N.casarTrabajador(input.operario, users, await N.aliasDeTrabajadores(db));
    if (!u) return `No sé quién es «${input.operario}».`;
    if (u.varios) return `¿Quién? ${u.varios.join(' · ')}`;
    Object.assign(extra, { userId: String(u._id), operarioNombre: u.name });
  }
  if (accion === 'no_es_cliente' && input.quien) extra.que = String(input.quien).slice(0, 200);
  const c = await candidatos(accion, input.peticion || '', { _db: db });
  if (!c.length) { await db.collection(COL).deleteOne({ _id: String(from) }); return `No encuentro ninguna petición abierta que encaje con «${input.peticion || ''}»${accion === 'confirmar' ? ' y esté por confirmar' : ''}. Dime el cliente, la calle o quién llamó.`; }
  if (c.length > 1) {
    const l = c.slice(0, 5);
    await _guardar(from, { accion, ids: l.map(x => ({ tipo: x.tipo, id: x.id })), extra }, db);
    return `Hay ${c.length > 5 ? 'más de 5' : l.length} que encajan. ¿Cuál?\n${l.map((x, i) => `${i + 1}. ${etiqueta(x)}`).join('\n')}${c.length > 5 ? '\n(Si no está, dime algo más: calle, quién llamó o el día.)' : ''}\nContesta con el número.`;
  }
  await _guardar(from, { accion, ids: [{ tipo: c[0].tipo, id: c[0].id }], elegido: 0, extra }, db);
  return _pregunta(accion, c[0], extra);
}

async function _cargar(x, db) {
  if (x.tipo === 'perdida') { const d = await db.collection(require('./nuvoVoz').COL).findOne({ _id: x.id }); return d && { tipo: 'perdida', id: x.id, nombre: (d.contacto && d.contacto.nombre) || null, final: d.final || null, fecha: d.fecha }; }
  const p = ObjectId.isValid(x.id) ? await db.collection('peticionesGrupo').findOne({ _id: new ObjectId(x.id) }) : null;
  return p && { tipo: 'peticion', id: x.id, p };
}

async function _hacer(accion, c, extra, from, db) {
  const P = require('./peticionesGrupo');
  if (c.tipo === 'perdida') { await require('./nuvoVoz').marcarDevuelta(c.id, POR, { _db: db }); return `✅ Apuntado: has devuelto la ${etiqueta(c)}. Ya no sale en perdidas.`; }
  const p = c.p, id = String(p._id);
  if (p.estado !== 'pendiente') return `Esa petición ya no está abierta (está ${p.estado}). No he tocado nada.`;
  if (accion === 'descartar' || accion === 'hecho') { await P.marcar(id, { estado: accion === 'hecho' ? 'hecho' : 'descartado', nota: extra.nota || '' }, POR); return `✅ ${accion === 'hecho' ? 'Hecha' : 'Descartada'}: ${etiqueta(c)}. Queda en el historial, no se borra.`; }
  if (accion === 'no_es_cliente') { await P.noEsCliente(id, { que: extra.que || '' }, POR); return `✅ Pasada a «Otros / no es cliente»: ${etiqueta(c)}. Sin cliente, sin incidencia y sin «¿Quién va?».`; }
  if (accion === 'devuelta') {
    const r = await P.llamadaDevuelta(id, POR);
    // La perdida de ese mismo número (si la hubo) también deja de salir.
    try { const V = require('./nuvoVoz'); const fin = p.recado && p.recado.final; if (fin) for (const x of await V.perdidasSinRecado(new Date(Date.now() - 7 * 864e5), new Date(), { _db: db })) if (x.final === fin) await V.marcarDevuelta(x._id, POR, { _db: db }); } catch (e) {}
    return `✅ Apuntado: has devuelto la llamada de ${etiqueta(c)}.${r.hecha ? ' Como no era de un cliente, la doy por hecha.' : ''}`;
  }
  if (accion === 'confirmar') {
    const r = await P.confirmar(id, { clienteId: extra.clienteId || null }, POR);
    return `✅ Confirmada${extra.clienteNombre ? ` como de *${extra.clienteNombre}*` : ''}: ${etiqueta(c)}.${r.incidencia ? ` Incidencia ${r.incidencia}; ahora te pregunto quién va.` : ''}${r.error ? ` Ojo: ${r.error}` : ''}`;
  }
  if (accion === 'asignar') {
    if (p.porConfirmar) return `Esa petición está por confirmar: primero dime «confirma el de ${_quien(p)}». No he tocado nada.`;
    return require('./trabajosSeguimiento').asignar(p, { userId: extra.userId, nota: extra.nota || '' }, POR);
  }
  return 'No he hecho nada.';
}

// El mensaje siguiente de Álex: «sí» lo hace, «no» lo deja, un número elige de la lista. Cualquier otra cosa anula la
// pregunta (no se queda colgada para un «sí» de otra conversación) y sigue el camino normal.
const SI = /^(s[ií]|si+|vale|ok|okay|confirmo|adelante|hazlo|dale|correcto|perfecto|exacto)( (vale|hazlo|adelante|gracias|porfa|por favor|confirmo))*$/;
const NO = /^(no|nop|cancela|cancelar|dejalo|deja|olvidalo|nada|mejor no)( (lo|gracias|dejalo))*$/;
async function respuesta(texto, from, { _db = null } = {}) {
  const db = _db || await getDB();
  const e = await db.collection(COL).findOne({ _id: String(from) });
  if (!e) return null;
  if (Date.now() - new Date(e.ts).getTime() > TTL) { await db.collection(COL).deleteOne({ _id: e._id }); return null; }
  const t = _n(texto).replace(/^(el|la|numero|n) /, '');
  if (e.elegido == null) {
    const m = t.match(/^(\d)$/);
    if (!m) { await db.collection(COL).deleteOne({ _id: e._id }); return NO.test(t) ? '👍 Vale, no toco nada.' : null; }
    const i = Number(m[1]) - 1;
    if (!e.ids[i]) return `Elige un número del 1 al ${e.ids.length}.`;
    const c = await _cargar(e.ids[i], db);
    if (!c) { await db.collection(COL).deleteOne({ _id: e._id }); return 'Esa ya no la encuentro. No he tocado nada.'; }
    await db.collection(COL).updateOne({ _id: e._id }, { $set: { elegido: i, ts: new Date() } });
    return _pregunta(e.accion, c, e.extra || {});
  }
  await db.collection(COL).deleteOne({ _id: e._id });
  if (NO.test(t)) return '👍 Vale, no toco nada.';
  if (!SI.test(t)) return null;
  const c = await _cargar(e.ids[e.elegido], db);
  if (!c) return 'Esa petición ya no la encuentro. No he tocado nada.';
  try { return await _hacer(e.accion, c, e.extra || {}, from, db); } catch (err) { return `No he podido: ${err.message}`; }
}

const TOOL = { name: 'gestionar_peticion', description: 'Álex GESTIONA un recado de SecretarIA o una petición abierta: «descarta el de Exolution», «el de Belpuig no es de ILLA VERDA, es un proveedor» (no_es_cliente), «confirma el de Katerin» / «el de Katerin es de Can Bells 30» (confirmar, con cliente), «ya he devuelto la llamada a CTAT Barcelona 51» (devuelta), «lo de la bañera lo hace Álex» (asignar), «lo de Cartagena ya está» (hecho). NO cambia nada: busca la petición y le pregunta a Álex en una línea; solo se hace cuando él contesta «sí». Si encajan varias, le da una lista numerada. Nunca borra.', input_schema: { type: 'object', properties: {
  accion: { type: 'string', enum: ACCIONES },
  peticion: { type: 'string', description: 'Cómo la nombra Álex: quien llamó, cliente, calle, qué pasa o la referencia («Exolution», «Belpuig», «Katerin», «bañera», «CTAT Barcelona 51», «INC00654»).' },
  cliente: { type: ['string', 'null'], description: 'Solo en confirmar: el cliente de StelOrder si dice que es de otro.' },
  operario: { type: ['string', 'null'], description: 'Solo en asignar: quién lo hace, tal como lo dice («Álex», «David», «yo»).' },
  quien: { type: ['string', 'null'], description: 'Solo en no_es_cliente: quién es y qué quiere, si lo dice («proveedor de aluminio»).' },
  nota: { type: ['string', 'null'] },
}, required: ['accion', 'peticion'] } };

module.exports = { TOOL, proponer, respuesta, candidatos, puntos, etiqueta, COL };
