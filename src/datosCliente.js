// src/datosCliente.js — Corpy le pide a un CLIENTE su DNI o NIF por WhatsApp para ponerlo en la factura (2/11/2026).
// Álex: «teléfono Aura 687058812 para pedir el DNI y guardar en su ficha»; «si no tengo el NIF de un cliente, me pides el
// teléfono y Corpy le manda un mensaje para que se gestione todo». Es lo mismo que docsAlta.js hace con los trabajadores.
//
// pedir(): guarda el teléfono en la ficha de StelOrder si no lo tenía, abre la petición y manda el WhatsApp. Lo que ese
// número conteste mientras la petición está abierta (server.js → procesarWhatsApp, antes de «asistente privado») pasa por
// respuesta(): la IA lee el DNI/NIE/NIF de la foto, PDF o texto, se valida la letra y, si la ficha de StelOrder no tenía
// NIF, se pone; si tenía otro distinto NO se pisa y se avisa a Álex. La foto queda en `docsClientes` (dato personal: no va
// a Personal ni a las carpetas de obra que ven los trabajadores) y se le reenvía a Álex. Un recordatorio a los 2 días.
//   peticionesCliente { clienteId, nombre, movil, que:'dni'|'nif', estado:'abierta'|'recibida'|'cerrada', por, at,
//                       recordatorios, ultimoRecordatorio, nif, docId, recibidaAt }
//   docsClientes      { clienteId, nombre, tipo, nif, mime, size, data, peticionId, por, subido }
'use strict';
const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const COL = 'peticionesCliente', DOCS = 'docsClientes';
const QUE = { dni: 'una foto de tu DNI (o NIE) por delante', nif: 'el NIF (o CIF) de la empresa o persona a cuyo nombre va la factura' };
const corto = (s, m) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, m);
const primerNombre = n => { const p = String(n || '').trim().split(/\s+/)[0] || ''; return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : ''; };
const movilDe = t => require('./recordatoriosCobro')._movil(t);

// ── Validación oficial de la letra (DNI, NIE) y del dígito de control del CIF ──
const LETRAS = 'TRWAGMYFPDXBNJZSQVHLCKE';
function validarNif(v) {
  const s = String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  let m = /^(\d{8})([A-Z])$/.exec(s);
  if (m) return LETRAS[Number(m[1]) % 23] === m[2] ? { ok: true, nif: s, tipo: 'DNI' } : { ok: false, nif: s, motivo: 'la letra no cuadra con el número' };
  m = /^([XYZ])(\d{7})([A-Z])$/.exec(s);
  if (m) return LETRAS[Number('XYZ'.indexOf(m[1]) + m[2]) % 23] === m[3] ? { ok: true, nif: s, tipo: 'NIE' } : { ok: false, nif: s, motivo: 'la letra no cuadra con el número' };
  m = /^([ABCDEFGHJNPQRSUVW])(\d{7})([0-9A-J])$/.exec(s);
  if (m) {
    const d = m[2].split('').map(Number); let a = 0, b = 0;
    d.forEach((x, i) => { if (i % 2) a += x; else { const y = x * 2; b += Math.floor(y / 10) + (y % 10); } });
    const c = (10 - ((a + b) % 10)) % 10;
    const okD = String(c) === m[3], okL = 'JABCDEFGHI'[c] === m[3];
    const soloLetra = 'KPQSNW'.includes(m[1]), soloNum = 'ABEH'.includes(m[1]);
    const ok = soloLetra ? okL : soloNum ? okD : (okD || okL);
    return ok ? { ok: true, nif: s, tipo: 'CIF' } : { ok: false, nif: s, motivo: 'el dígito de control no cuadra' };
  }
  return { ok: false, nif: s, motivo: 'no tiene forma de DNI, NIE ni CIF' };
}
// Un DNI/NIE/CIF escrito en un texto («mi dni es 41.580.660-H»).
function nifDeTexto(texto) {
  const t = String(texto || '').toUpperCase().replace(/(\d)[.\s-](?=\d)/g, '$1').replace(/(\d)[\s-]+([A-Z])\b/g, '$1$2');
  const m = t.match(/\b(\d{8}[A-Z]|[XYZ]\d{7}[A-Z]|[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J])\b/);
  return m ? m[1] : null;
}

// ── Cliente de StelOrder: lectura-modificación-escritura del documento entero, con copia en stelWriteLog ──
async function _clienteRaw(id) {
  const S = require('./stelorder');
  const r = await S._client.get(`/clients/${id}`, { timeout: 20000 });
  return Array.isArray(r.data) ? r.data[0] : r.data;
}
async function _guardarCliente(id, cambios, motivo, por) {
  const S = require('./stelorder');
  if (S.enPausa && S.enPausa()) throw new Error('StelOrder está en pausa');
  const db = await getDB();
  const antes = await _clienteRaw(id);
  if (!antes || !antes.id) throw new Error('No encuentro ese cliente en StelOrder');
  const log = await db.collection('stelWriteLog').insertOne({ tipo: 'datos-cliente', clienteId: String(id), motivo, before: Object.fromEntries(Object.keys(cambios).map(k => [k, antes[k] ?? null])), nuevo: cambios, requestedBy: por || null, at: new Date(), result: 'pending' });
  try {
    await S._client.put(`/clients/${id}`, { ...antes, ...cambios }, { headers: { 'Content-Type': 'application/json; charset=utf-8' }, timeout: 25000 });
    const d = await _clienteRaw(id);
    const ok = Object.entries(cambios).every(([k, v]) => String(d[k] ?? '').trim() === String(v).trim());
    await db.collection('stelWriteLog').updateOne({ _id: log.insertedId }, { $set: { result: ok ? 'ok' : 'no_cuajo', after: Object.fromEntries(Object.keys(cambios).map(k => [k, d[k] ?? null])) } });
    try { S.invalidate('clients'); } catch (e) {}
    if (!ok) throw new Error('StelOrder no guardó el cambio');
    return d;
  } catch (e) { await db.collection('stelWriteLog').updateOne({ _id: log.insertedId }, { $set: { result: 'error', error: e.message } }); throw e; }
}

function textoPeticion(nombre, que) {
  return `Hola${nombre ? ' ' + nombre : ''}, soy Corpy, de la oficina de Corp Projects 👋\n\nPara poner la factura a tu nombre necesitamos ${QUE[que] || QUE.dni}. ¿Nos la puedes mandar por aquí cuando puedas? Si prefieres, también vale escribir el número.\n\nMuchas gracias.\nCorpy, de la oficina de Corp Projects`;
}

// pedir({ clienteId, telefono, que, por }) → { ok, texto, a, telefonoGuardado }
async function pedir({ clienteId, telefono, que = 'dni', por = '' } = {}, { _cliente = _clienteRaw, _guardar = _guardarCliente, _enviar = null, _db = null } = {}) {
  if (!/^\d+$/.test(String(clienteId || ''))) throw new Error('¿De qué cliente de StelOrder es?');
  que = que === 'nif' ? 'nif' : 'dni';
  const c = await _cliente(clienteId);
  if (!c || !c.id) throw new Error('No encuentro ese cliente en StelOrder');
  const nombre = corto(c['legal-name'] || c.name, 120);
  const movil = movilDe(telefono || c.phone || c.phone2);
  if (!movil) throw new Error(`No tengo un móvil de ${nombre}: dime su teléfono`);
  // El teléfono a la ficha si no lo tenía (así la próxima vez no hay que pedirlo).
  let telefonoGuardado = false;
  if (telefono && !String(c.phone || '').trim()) {
    try { await _guardar(clienteId, { phone: movil.replace(/^\+34/, '') }, 'teléfono para pedir el DNI/NIF', por); telefonoGuardado = true; }
    catch (e) { console.warn('[DatosCliente] teléfono:', e.message); }
  }
  const db = _db || await getDB();
  const antes = await db.collection(COL).findOne({ clienteId: String(clienteId), estado: 'abierta' });
  const txt = textoPeticion(primerNombre(nombre), que);
  const ok = await (_enviar || require('./notifications').sendWhatsAppTo)(movil, txt);
  if (ok === false) throw new Error('No se pudo enviar el WhatsApp (mira que Corpy esté conectado)');
  if (antes) await db.collection(COL).updateOne({ _id: antes._id }, { $set: { estado: 'sustituida' } });
  const doc = { clienteId: String(clienteId), nombre, movil, que, estado: 'abierta', por: por || '', at: new Date(), recordatorios: 0, nifAntes: corto(c['tax-identification-number'], 20) || null };
  const r = await db.collection(COL).insertOne(doc);
  return { ok: true, id: String(r.insertedId), a: movil, texto: txt, nombre, telefonoGuardado };
}

async function abiertaDeNumero(from, { _db = null } = {}) {
  const movil = movilDe(from); if (!movil) return null;
  const db = _db || await getDB();
  return db.collection(COL).findOne({ movil, estado: 'abierta' }, { sort: { at: -1 } });
}

// Qué documento es y qué número lleva (solo eso).
const HERR = { name: 'documento_cliente', description: 'Qué documento de identidad es y su número', input_schema: { type: 'object', properties: {
  tipo: { type: 'string', enum: ['dni', 'nie', 'pasaporte', 'cif', 'otro'], description: 'dni = DNI español; nie = NIE/TIE de extranjero; cif = tarjeta o papel con el CIF/NIF de una empresa; otro = no es un documento de identidad' },
  legible: { type: 'boolean', description: 'true si el número se lee entero y sin dudas' },
  numero: { type: 'string', description: 'El número del documento (DNI/NIE con su letra, o CIF), sin espacios' },
  nombre: { type: 'string', description: 'Nombre y apellidos (o razón social) que aparecen' },
}, required: ['tipo', 'legible'] } };
async function _mirar(buf, mime) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) return null;
  const b64 = buf.toString('base64');
  const contenido = /pdf/i.test(mime) ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } } : { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } };
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 45000);
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: c.signal, headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: require('./config').ia.vision, max_tokens: 300, tools: [HERR], tool_choice: { type: 'tool', name: HERR.name }, messages: [{ role: 'user', content: [contenido, { type: 'text', text: 'Un cliente nos manda esto para que le hagamos la factura a su nombre. Dime qué documento es y su número.' }] }] }) }).finally(() => clearTimeout(t));
    const d = await r.json(); if (!r.ok) throw new Error('API ' + r.status);
    const tu = (d.content || []).find(b => b.type === 'tool_use');
    return tu ? tu.input : null;
  } catch (e) { console.warn('[DatosCliente] IA:', e.message); return null; }
}

async function _avisarAlex(txt, archivo) {
  const N = require('./notifications');
  try { await N.sendWhatsApp(txt); } catch (e) {}
  if (archivo) {
    try { const W = require('./canalWhatsapp'); if (W.canalActivo() === 'bridge') await W.enviarArchivo(N.destinoDueno(), `📎 ${archivo.nombre}`, archivo); } catch (e) {}
  }
}

// Lo que contesta el cliente. Devuelve el texto para él, o null si ese número no tiene petición abierta.
// media: { fotos:[{url,type}], pdf:{url,type} } como llega a procesarWhatsApp; _bajar(url) → Buffer.
async function respuesta(from, body, media = {}, { _bajar, _mirar: mirar = _mirar, _cliente = _clienteRaw, _guardar = _guardarCliente, _avisar = _avisarAlex, _memoria = null, _db = null } = {}) {
  const db = _db || await getDB();
  const pet = await abiertaDeNumero(from, { _db: db });
  if (!pet) return null;
  const docs = [...(media.fotos || []), ...(media.pdf ? [media.pdf] : [])];
  let nif = nifDeTexto(body), buf = null, mime = null, leido = null;
  for (const m of docs) {
    try {
      buf = await _bajar(m.url); mime = String(m.type || 'image/jpeg').split(';')[0];
      leido = await mirar(buf, mime);
      if (leido && leido.numero) { nif = nif || leido.numero; break; }
    } catch (e) { console.warn('[DatosCliente] bajar/mirar:', e.message); }
  }
  // Ni foto ni número: lo que diga se le pasa a Álex (puede ser «mañana te lo mando»).
  if (!nif && !buf) {
    await _avisar(`💬 *${pet.nombre}* contesta a la petición del ${pet.que === 'nif' ? 'NIF' : 'DNI'}: «${corto(body, 300)}»`);
    return 'Gracias, se lo paso a Álex. Cuando puedas, mándanos la foto o el número por aquí.';
  }
  if (buf && !nif) {
    if (leido && leido.tipo === 'otro') { await _avisar(`📎 *${pet.nombre}* ha mandado algo que no parece un DNI/NIF${body ? ': «' + corto(body, 200) + '»' : ''}.`, { data: buf, mime, nombre: `Enviado por ${pet.nombre}` }); return 'Gracias. Esto no parece un DNI; se lo paso a Álex. Si puedes, mándanos una foto del DNI por delante, que se lea bien el número.'; }
    return '📸 No se lee bien el número. ¿Nos mandas otra foto más de cerca, con buena luz y sin reflejos? Gracias.';
  }
  const v = validarNif(nif);
  if (!v.ok) {
    await _avisar(`⚠️ *${pet.nombre}* ha mandado un ${pet.que === 'nif' ? 'NIF' : 'DNI'} que no cuadra (${v.nif}: ${v.motivo}).`, buf ? { data: buf, mime, nombre: `DNI ${pet.nombre}` } : null);
    return `Gracias. El número ${v.nif} no me cuadra (${v.motivo}). ¿Lo puedes revisar o mandarnos una foto del documento?`;
  }
  // Foto guardada aparte (dato personal: no va a Personal ni a las carpetas de obra).
  let docId = null;
  if (buf) { const r = await db.collection(DOCS).insertOne({ clienteId: pet.clienteId, nombre: pet.nombre, tipo: (leido && leido.tipo) || (v.tipo || '').toLowerCase(), nif: v.nif, mime, size: buf.length, data: buf, peticionId: String(pet._id), por: 'Corpy (WhatsApp)', subido: new Date() }); docId = String(r.insertedId); }
  // A la ficha de StelOrder si estaba vacía; si había otro distinto, no se pisa.
  let estadoFicha = 'puesto';
  try {
    const c = await _cliente(pet.clienteId);
    const antes = String(c['tax-identification-number'] || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (antes === v.nif) estadoFicha = 'igual';
    else if (antes) estadoFicha = 'distinto:' + antes;
    else await _guardar(pet.clienteId, { 'tax-identification-number': v.nif }, `${v.tipo} recibido por WhatsApp`, 'Corpy (WhatsApp)');
  } catch (e) { estadoFicha = 'error:' + e.message; }
  await db.collection(COL).updateOne({ _id: pet._id }, { $set: { estado: 'recibida', nif: v.nif, docId, recibidaAt: new Date(), estadoFicha } });
  try { await (_memoria || require('./memoria')).apuntar({ sujeto: { tipo: 'cliente', id: pet.clienteId, nombre: pet.nombre }, tipo: 'dato', unico: 'nif', texto: `${v.tipo} ${v.nif} (lo mandó por WhatsApp el ${new Date().toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' })})`, datos: { nif: v.nif, docId }, ambito: 'interno', fuente: { tipo: 'whatsapp', ref: String(pet._id), por: 'Corpy' } }); } catch (e) {}
  const ficha = estadoFicha === 'puesto' ? 'Lo he puesto en su ficha de StelOrder.' : estadoFicha === 'igual' ? 'Ya lo tenía así en StelOrder.'
    : estadoFicha.startsWith('distinto:') ? `⚠️ En StelOrder tenía otro (${estadoFicha.slice(9)}): NO lo he cambiado. Dime cuál vale.` : `⚠️ No lo he podido poner en StelOrder (${estadoFicha.slice(6)}): ponlo a mano.`;
  await _avisar(`🪪 *${pet.nombre}* ha mandado su ${v.tipo}: *${v.nif}*. ${ficha}`, buf ? { data: buf, mime, nombre: `${v.tipo} ${pet.nombre}${/pdf/.test(mime) ? '.pdf' : '.jpg'}` } : null);
  return '✅ Recibido, ¡muchas gracias! Ya lo tenemos para la factura.';
}

// Un recordatorio a los 2 días si no ha contestado (L-V, no festivos). Si sigue sin contestar 2 días después, se avisa a
// Álex una vez («¿le llamas?»), como en docsAlta.
async function recordar({ hoy = new Date(), _enviar = null, _avisarJefe = null, _db = null } = {}) {
  const db = _db || await getDB();
  try { if (await require('./festivos').esFestivo(hoy.toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' }))) return { recordados: 0, festivo: true }; } catch (e) {}
  const H = 3600 * 1000; let n = 0, avisos = 0;
  for (const p of await db.collection(COL).find({ estado: 'abierta' }).toArray()) {
    const desde = hoy - new Date(p.ultimoRecordatorio || p.at);
    if ((p.recordatorios || 0) >= 1) {
      if (!p.avisadoJefe && desde >= 44 * H) {
        try { await (_avisarJefe || require('./notifications').sendWhatsApp)(`⏰ *${p.nombre}* sigue sin mandar el ${p.que === 'nif' ? 'NIF' : 'DNI'} (pedido el ${new Date(p.at).toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' })} y recordado una vez). ¿Le llamas?`); avisos++; await db.collection(COL).updateOne({ _id: p._id }, { $set: { avisadoJefe: hoy } }); } catch (e) {}
      }
      continue;
    }
    if (desde < 44 * H) continue;
    const txt = `Hola${primerNombre(p.nombre) ? ' ' + primerNombre(p.nombre) : ''}, te lo recuerdo: para la factura nos falta ${QUE[p.que] || QUE.dni}. Puedes mandarlo por aquí mismo. ¡Gracias!\nCorpy, de la oficina de Corp Projects`;
    const ok = await (_enviar || require('./notifications').sendWhatsAppTo)(p.movil, txt);
    if (ok !== false) { n++; await db.collection(COL).updateOne({ _id: p._id }, { $set: { ultimoRecordatorio: hoy }, $inc: { recordatorios: 1 } }); }
  }
  return { recordados: n, avisosJefe: avisos };
}

async function documento(id) {
  if (!ObjectId.isValid(String(id))) return null;
  const db = await getDB();
  return db.collection(DOCS).findOne({ _id: new ObjectId(String(id)) });
}

module.exports = { pedir, respuesta, recordar, abiertaDeNumero, documento, validarNif, nifDeTexto, _textoPeticion: textoPeticion };
