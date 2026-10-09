// src/docsAlta.js — Corpy le pide a un trabajador nuevo SUS documentos para el alta (9/10/2026).
//
// La oficina pulsa «Pedir documentos del alta» en Personal → Corpy le escribe por WhatsApp qué necesita (DNI/NIE por
// las dos caras y el número de la Seguridad Social; si es extranjero sin NIE, pasaporte y papeles de extranjería).
// Mientras la petición está abierta, cada foto/PDF que mande se mira con IA: qué documento es y si se lee bien
// (con Melvin la gestoría devolvió la foto de la SS por borrosa). Si se lee, va a su carpeta de Personal; si no,
// se le pide que la repita. Lo que no sea un documento suyo (un ticket, un albarán) sigue a Compras como siempre.
// Cuando está todo, se le da las gracias y se avisa a Álex. Colección `peticionesDocs`.
'use strict';
const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const COL = 'peticionesDocs';

// Lo que se pide. «dni» se cumple con DNI o NIE (las dos caras); «extranjero» pide además pasaporte y papeles.
const PIEZAS = {
  doc_delante: 'DNI o NIE por delante',
  doc_detras: 'DNI o NIE por detrás',
  seguridad_social: 'el número de la Seguridad Social (la tarjeta o un papel donde salga)',
  pasaporte: 'el pasaporte (la hoja de la foto)',
  extranjeria: 'el papel de extranjería (solicitud de residencia o admisión a trámite)',
};
const piezasDe = extranjero => (extranjero ? ['pasaporte', 'extranjeria', 'seguridad_social'] : ['doc_delante', 'doc_detras', 'seguridad_social']);
// A qué tipo de la carpeta de Personal va cada pieza.
const TIPO_PERSONAL = { doc_delante: 'dni', doc_detras: 'dni', pasaporte: 'dni', seguridad_social: 'tarjeta_ss', extranjeria: 'extranjeria' };

const primerNombre = n => { const p = String(n || '').trim().split(/\s+/)[0] || ''; return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : ''; };
const lista = ks => ks.map(k => PIEZAS[k]).join(', ').replace(/, ([^,]*)$/, ' y $1');

function textoPeticion(nombre, piezas) {
  return `Hola${nombre ? ' ' + nombre : ''} 👋 Soy Corpy, de Corp Projects.\n\nPara darte de alta en la Seguridad Social necesitamos que nos mandes por aquí estas fotos:\n${piezas.map((k, i) => `${i + 1}. ${PIEZAS[k].charAt(0).toUpperCase() + PIEZAS[k].slice(1)}`).join('\n')}\n\nHazlas de cerca, con buena luz y sin reflejos, que se lean bien todos los números. Solo tus documentos, nada más. ¡Gracias!`;
}

async function _usuario(db, userId) {
  return db.collection('users').findOne({ _id: new ObjectId(String(userId)) }, { projection: { name: 1, whatsapp: 1, telefono: 1, active: 1 } });
}

async function pedir(userId, { extranjero = false, por = null, _enviar = null } = {}) {
  const db = await getDB();
  const u = await _usuario(db, userId);
  if (!u) throw new Error('No encuentro ese trabajador');
  const movil = require('./recordatoriosCobro')._movil(u.whatsapp || u.telefono);
  if (!movil) throw new Error(`${u.name} no tiene un móvil en su ficha: pónselo en Usuarios`);
  const piezas = piezasDe(!!extranjero);
  const txt = textoPeticion(primerNombre(u.name), piezas);
  const ok = await (_enviar || require('./notifications').sendWhatsAppTo)(movil, txt);
  if (ok === false) throw new Error('No se pudo enviar el WhatsApp (mira que Corpy esté conectado)');
  await db.collection(COL).updateMany({ userId: String(userId), estado: 'abierta' }, { $set: { estado: 'sustituida' } });
  const doc = { userId: String(userId), nombre: u.name, movil, piezas, recibidas: {}, estado: 'abierta', por: por || '', at: new Date(), recordatorios: 0 };
  const r = await db.collection(COL).insertOne(doc);
  return { ok: true, id: String(r.insertedId), a: movil, texto: txt };
}

async function abiertaDe(userId) {
  if (!userId) return null;
  const db = await getDB();
  return db.collection(COL).findOne({ userId: String(userId), estado: 'abierta' });
}
async function listar() {
  const db = await getDB();
  return (await db.collection(COL).find({ estado: { $in: ['abierta', 'completa'] } }).sort({ at: -1 }).limit(50).toArray())
    .map(p => ({ id: String(p._id), userId: p.userId, nombre: p.nombre, estado: p.estado, at: p.at, faltan: p.piezas.filter(k => !p.recibidas[k]).map(k => PIEZAS[k]), recibidas: Object.keys(p.recibidas).map(k => PIEZAS[k]) }));
}
async function cerrar(id) {
  const db = await getDB();
  await db.collection(COL).updateOne({ _id: new ObjectId(String(id)) }, { $set: { estado: 'cerrada', cerradaAt: new Date() } });
  return { ok: true };
}

// Qué documento es y si se lee bien (solo eso: no se guarda ningún dato del documento salvo el número).
const HERR = { name: 'documento_alta', description: 'Qué documento de identidad o de Seguridad Social es la imagen y si se lee bien', input_schema: { type: 'object', properties: {
  tipo: { type: 'string', enum: ['doc_delante', 'doc_detras', 'pasaporte', 'seguridad_social', 'extranjeria', 'ticket_o_factura', 'otro'], description: 'doc_delante/doc_detras = DNI español o NIE/TIE (tarjeta de extranjero); seguridad_social = tarjeta o documento con el nº de afiliación; extranjeria = resguardo de solicitud de residencia, admisión a trámite, resolución…; ticket_o_factura = compra, albarán' },
  legible: { type: 'boolean', description: 'true si se leen bien TODOS los números y letras (sin desenfoque, reflejos ni cortes)' },
  problema: { type: 'string', description: 'Si no es legible: qué pasa, en pocas palabras (borrosa, cortada, reflejo, muy oscura…)' },
  numero: { type: 'string', description: 'El número principal (DNI/NIE, pasaporte o nº de la Seguridad Social) si se lee' },
}, required: ['tipo', 'legible'] } };
async function _mirar(buf, mime) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) return null;
  const b64 = buf.toString('base64');
  const contenido = /pdf/i.test(mime) ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } } : { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } };
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 45000);
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: c.signal, headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: require('./config').ia.vision, max_tokens: 300, tools: [HERR], tool_choice: { type: 'tool', name: HERR.name }, messages: [{ role: 'user', content: [contenido, { type: 'text', text: 'Un trabajador manda esta foto para darse de alta en la Seguridad Social. Dime qué documento es y si se lee bien entero.' }] }] }) }).finally(() => clearTimeout(t));
    const d = await r.json(); if (!r.ok) throw new Error('API ' + r.status);
    const tu = (d.content || []).find(b => b.type === 'tool_use');
    return tu ? tu.input : null;
  } catch (e) { console.warn('[DocsAlta] IA:', e.message); return null; }
}

// Llega una foto/PDF de un trabajador con petición abierta. Devuelve { respuesta } si la ha tratado, o
// { aCompras: true } si no es un documento suyo (ticket, albarán…) y debe seguir el camino normal.
async function recibir(pet, { buf, mime }, { _mirar: mirar = _mirar, _avisar = null } = {}) {
  const db = await getDB();
  const v = await mirar(buf, mime);
  if (!v) return { respuesta: '📎 He recibido tu foto pero ahora no la puedo mirar. La oficina la revisará.', guardar: 'otro' };
  if (v.tipo === 'ticket_o_factura') return { aCompras: true };
  const nombre = primerNombre(pet.nombre);
  if (!v.legible) return { respuesta: `📸 Esta foto no se lee bien${v.problema ? ' (' + String(v.problema).slice(0, 60) + ')' : ''}. ¿Me la repites más de cerca, con buena luz y sin reflejos?` };
  // DNI/NIE: si ya está una cara y llega «la misma», se entiende la que falta (la IA a veces no distingue).
  let pieza = v.tipo;
  if ((pieza === 'doc_delante' || pieza === 'doc_detras') && pet.recibidas[pieza] && pet.piezas.includes('doc_delante')) pieza = pieza === 'doc_delante' ? 'doc_detras' : 'doc_delante';
  if (pieza === 'pasaporte' && pet.piezas.includes('doc_delante') && !pet.recibidas.doc_delante) pieza = 'doc_delante';   // sirve como identificación
  const tipoP = TIPO_PERSONAL[pieza] || 'otro';
  const notas = `${PIEZAS[pieza] ? PIEZAS[pieza].charAt(0).toUpperCase() + PIEZAS[pieza].slice(1) : 'Documento'} · enviado por WhatsApp para el alta${v.numero ? ' · nº ' + String(v.numero).slice(0, 30) : ''}`;
  const d = await require('./personalDocs').subir({ ambito: 'trabajador', userId: pet.userId, tipo: tipoP, archivo: { buffer: buf, mimetype: mime, originalname: `${PIEZAS[pieza] || 'documento'} (WhatsApp).${/pdf/.test(mime) ? 'pdf' : 'jpg'}` }, notas, visibleTrabajador: true }, 'Corpy (WhatsApp)');
  const recibidas = { ...pet.recibidas, [pieza]: { docId: d && (d.id || d._id) ? String(d.id || d._id) : null, at: new Date() } };
  const faltan = pet.piezas.filter(k => !recibidas[k]);
  await db.collection(COL).updateOne({ _id: pet._id }, { $set: { recibidas, ...(faltan.length ? {} : { estado: 'completa', completaAt: new Date() }) }, ...(v.numero && (pieza === 'doc_delante' || pieza === 'pasaporte') ? {} : {}) });
  pet.recibidas = recibidas;
  if (faltan.length) return { respuesta: `✅ Recibido: ${PIEZAS[pieza] || 'documento'}. Falta ${lista(faltan)}.` };
  try {
    const url = `${process.env.DASHBOARD_URL || 'https://dashboard.corpprojects.es'}/personal`;
    await (_avisar || require('./notifications').sendWhatsApp)(`📇 *${pet.nombre}* ya ha mandado todos sus documentos para el alta (${lista(pet.piezas)}). Están en su carpeta: ${url}`);
  } catch (e) {}
  return { respuesta: `✅ ¡Perfecto${nombre ? ', ' + nombre : ''}! Ya lo tenemos todo para tu alta. Gracias 🙏` };
}

// Recordatorio (L-V por la mañana): a quien no ha mandado todo en 24 h, una vez al día y como mucho 2 veces.
async function recordar({ hoy = new Date(), _enviar = null } = {}) {
  const db = await getDB();
  const ps = await db.collection(COL).find({ estado: 'abierta' }).toArray();
  let n = 0;
  for (const p of ps) {
    if ((p.recordatorios || 0) >= 2 || hoy - new Date(p.ultimoRecordatorio || p.at) < 20 * 3600 * 1000) continue;
    const faltan = p.piezas.filter(k => !p.recibidas[k]);
    if (!faltan.length) continue;
    const txt = `Hola${primerNombre(p.nombre) ? ' ' + primerNombre(p.nombre) : ''} 👋 Para tu alta aún nos falta ${lista(faltan)}. Mándalo por aquí cuando puedas (fotos de cerca y que se lean bien). ¡Gracias!`;
    const ok = await (_enviar || require('./notifications').sendWhatsAppTo)(p.movil, txt);
    if (ok !== false) { n++; await db.collection(COL).updateOne({ _id: p._id }, { $set: { ultimoRecordatorio: hoy }, $inc: { recordatorios: 1 } }); }
  }
  return { recordados: n };
}

module.exports = { pedir, abiertaDe, listar, cerrar, recibir, recordar, PIEZAS, TIPO_PERSONAL, _textoPeticion: textoPeticion };
