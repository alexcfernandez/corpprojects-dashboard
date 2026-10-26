// src/notifOficiales.js — NOTIFICACIONES OFICIALES Y MULTAS (26/10/2026). Dos cosas que pasaron a la vez: las 3 notificaciones
// de Red.es del Kit Digital (16/10) que nadie abrió a tiempo, y Álex: «lo de Multivia —nos avisan de las multas y
// identificamos conductores—, ¿lo podríamos hacer nosotros?». Los avisos ya llegan al correo; aquí se leen:
//   · DEHú (noreply.dehu@correo.gob.es): Estado, AEAT, Tesorería, DGT, ORGT («MULTES - TORDERA»), Red.es…
//   · e-NOTUM (ajuntaments catalanes: Girona…), con «Accés fins»;
//   · Red.es (avisos-pkd@acelerapyme.gob.es): 10 días naturales para abrir;
//   · Multivia «Solicitud Datos Conductor»: la multa con matrícula, día, importe y puntos.
// Cada una se guarda (notifOficiales) con hasta cuándo se puede abrir y se avisa a Álex por WhatsApp al llegar, 2 días
// antes y el último día. Si es una MULTA, con la matrícula y el día se busca quién llevaba la furgoneta (historial de
// Vehículos y su presencia de ese día) y se vigilan los 20 días naturales para identificar al conductor (art. 11 LSV: si
// no, la multa por no identificar es el doble o el triple). En Inicio salen las pendientes.
'use strict';
async function getDB() { return require('./db').getDB(); }
const hoyISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
const masDias = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const entre = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);
const dmy = s => { const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null; };
const fmt = iso => iso ? iso.split('-').reverse().join('/') : '';
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', ntilde: 'ñ', Ntilde: 'Ñ', agrave: 'à', egrave: 'è', ograve: 'ò', ccedil: 'ç', middot: '·' };
const limpio = s => String(s || '').replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&([a-zA-Z]+);/g, (m, n) => ENT[n] || m).replace(/\s+/g, ' ').trim();
// El cuerpo tal cual (extractBody quita los enlaces y aquí hacen falta).
function crudo(payload) {
  const dec = d => Buffer.from(String(d).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  const busca = (parts, mime) => { for (const x of parts || []) { if (x.mimeType === mime && x.body && x.body.data) return dec(x.body.data); const f = busca(x.parts, mime); if (f) return f; } return ''; };
  if (!payload) return '';
  if (payload.body && payload.body.data) return dec(payload.body.data);
  return busca(payload.parts, 'text/html') || busca(payload.parts, 'text/plain');
}
const PLAZO_IDENTIFICAR = 20;   // días naturales (art. 11 LSV)
const RE_MULTA = /\bmult[ae]s?\b|sanci[oó]n|sancionador|tr[aá]fico|tr[aà]nsit|denuncia|infracci[oó]n|estacionamiento|velocidad|radar/i;
// Lo que es rutina y ya lleva la gestoría (Tesorería manda cada semana las resoluciones de altas y bajas): se guarda sin avisar.
const RE_RUTINA = /altas\/bajas|alta\/baja/i;
const RE_ORG_TRAFICO = /tr[aá]fico|tr[aà]nsit|xaloc|gesti[oó]n tributaria|guardia urbana|polic[ií]a local/i;

// ── Lectura de cada tipo de aviso ────────────────────────────────────────────────────────────────────────────────────────
function leer({ de = '', asunto = '', cuerpo = '', fecha = new Date() } = {}) {
  const t = limpio(cuerpo); const recibida = new Date(fecha).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
  const g = re => { const m = t.match(re); return m ? m[1].trim() : ''; };
  let r = null;
  if (/noreply\.dehu@correo\.gob\.es/i.test(de)) {
    const comunicacion = /comunicaci[oó]n/i.test(asunto);
    r = { fuente: 'dehu', tipo: comunicacion ? 'comunicacion' : 'notificacion', organismo: g(/Organismo emisor:\s*(.+?),\s*con DIR3/i), identificador: g(/Identificador:\s*(\d+)/i),
      concepto: g(/Concepto:\s*(.+?)\s+(?:C[oó]mo puedes acceder|Esta (?:notificaci|comunicaci))/i), vence: dmy(g(/vencimiento el d[ií]a:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i)),
      enlace: (String(cuerpo).match(/https:\/\/dehu\.redsara\.es\/[^\s"'<]*(?:ver|aceptar)/i) || ['https://dehu.redsara.es'])[0] };
  } else if (/enotum\.cat/i.test(de)) {
    r = { fuente: 'enotum', tipo: 'notificacion', organismo: g(/Emissor\s+(.+?)\s+Assumpte/i) || g(/de l'ens\s+(.+)$/i), identificador: g(/Id\.\s*Notificaci[oó]\s+(\d+)/i),
      concepto: g(/Assumpte\s+(.+?)\s+Data de lliurament/i), vence: dmy(g(/Acc[eé]s fins\s+(\d{1,2}\/\d{1,2}\/\d{4})/i)),
      enlace: (String(cuerpo).match(/https:\/\/usuari\.enotum\.cat\?[^\s"'<]+/i) || ['https://usuari.enotum.cat'])[0].replace(/&amp;/g, '&'), recordatorio: /recordatori/i.test(asunto) };
  } else if (/acelerapyme\.gob\.es|red\.es/i.test(de) && /nueva (notificaci|comunicaci)/i.test(t)) {
    const comunicacion = /nueva comunicaci/i.test(t);
    r = { fuente: 'redes', tipo: comunicacion ? 'comunicacion' : 'notificacion', organismo: 'Red.es (Kit Digital)', identificador: '',
      concepto: g(/Concepto\s*:\s*(.+?)\s+Puede acceder/i), vence: comunicacion ? null : masDias(recibida, 10), enlace: 'https://portal.gestion.sedepkd.red.gob.es/portal/espacioPyme' };
  } else if (/xvia-serviciosjuridicos|multivia/i.test(de) && /datos? (del )?conductor/i.test(asunto)) {
    const mat = g(/MATR[IÍ]CULA:\s*([A-Z0-9-]{5,10})/i);
    r = { fuente: 'multivia', tipo: 'multa', organismo: g(/ORGANISMO SANCIONADOR:\s*(.+?)(?:\s+Para evitar|$)/i), identificador: g(/N[ºo°]\s*EXPEDIENTE:\s*(\S+)/i),
      concepto: `Multa ${g(/INFRACCI[OÓ]N IMPUTADA:\s*(.+?)\s+IMPORTE/i).toLowerCase()}`.trim(), vence: null, enlace: (String(cuerpo).match(/https:\/\/xvia-serviciosjuridicos\.online\/[^\s"'<]+/i) || [''])[0],
      multa: { matricula: require('./vehiculos').matNorm(mat), fechaInfraccion: dmy(g(/FECHA INFRACCI[OÓ]N:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i)), infraccion: g(/INFRACCI[OÓ]N IMPUTADA:\s*(.+?)\s+IMPORTE/i),
        importe: Number(g(/IMPORTE PROPUESTO:\s*([\d.,]+)/i).replace(',', '.')) || null, puntos: (n => n > 0 ? n : 0)(Number(g(/PUNTOS:\s*(\d+)/i))) } };
  }
  if (!r || (!r.concepto && !r.identificador)) return null;
  r.recibida = recibida;
  if (r.tipo !== 'multa' && RE_MULTA.test(`${r.concepto} ${RE_ORG_TRAFICO.test(r.organismo) ? 'multa' : ''}`)) { r.tipo = 'multa'; r.multa = { matricula: '', fechaInfraccion: null }; }
  return r;
}

// ── Quién llevaba el vehículo ese día ─────────────────────────────────────────────────────────────────────────────────────
async function conductorEn(matricula, fecha, { _db = null } = {}) {
  const db = _db || await getDB();
  const mat = require('./vehiculos').matNorm(matricula);
  if (!mat) return null;
  const v = await db.collection('vehiculos').findOne({ matricula: mat });
  if (!v) return { vehiculo: null, nota: `La matrícula ${mat} no está en Vehículos` };
  const vh = { id: String(v._id), nombre: v.nombre || '', matricula: mat };
  const f = fecha || hoyISO();
  const hist = v.historialConductor || [];
  let h = hist.filter(x => x.userId && (!x.desde || x.desde <= f) && (!x.hasta || x.hasta >= f)).pop();
  // El historial empezó en oct 2026: si la multa es de antes de que hubiera nada apuntado, se propone quien la llevó primero.
  let aprox = '';
  if (!h) {
    const primero = hist.filter(x => x.userId && x.desde).sort((a, b) => a.desde.localeCompare(b.desde))[0];
    if (primero && primero.desde > f) { h = primero; aprox = `no hay historial de esa fecha: es quien la lleva desde el ${fmt(primero.desde)}`; }
    else if (!hist.length && v.conductor) { h = v.conductor; aprox = 'es quien la lleva ahora (sin historial)'; }
  }
  if (!h) return { vehiculo: vh, conductor: null, nota: 'Ese día no tenía conductor asignado en Vehículos' };
  const at = fecha ? await db.collection('attendance').findOne({ workerId: String(h.userId), date: fecha }) : null;
  const sinTrabajo = require('./config').estadosSinHorasProductivas || [];
  const trabajo = at ? !sinTrabajo.includes(at.estado) : null;
  return { vehiculo: vh, conductor: { userId: String(h.userId), name: h.name || '' }, trabajo, aprox: !!aprox,
    nota: aprox && trabajo !== false ? aprox : trabajo === false ? `ojo: ese día ${h.name} no trabajó (${at.estado}); mira quién más la usó` : trabajo === null && fecha ? `${h.name} no tiene presencia apuntada ese día` : '' };
}

// ── Textos de WhatsApp ────────────────────────────────────────────────────────────────────────────────────────────────────
function textoAviso(n, { recordatorio = '' } = {}) {
  const hoy = hoyISO();
  const lin = [];
  if (n.tipo === 'multa') {
    const m = n.multa || {};
    lin.push(`🚨 *Multa* de ${n.organismo || 'tráfico'}${n.identificador ? ` (exp. ${n.identificador})` : ''}${recordatorio ? ' — ' + recordatorio : ''}`);
    if (m.matricula) lin.push(`🚐 ${m.matricula}${n.conductorPropuesto && n.conductorPropuesto.vehiculo ? ' · ' + n.conductorPropuesto.vehiculo.nombre : ''}${m.fechaInfraccion ? ' · día ' + fmt(m.fechaInfraccion) : ''}`);
    if (m.infraccion || m.importe) lin.push(`${m.infraccion || ''}${m.importe ? ` · ${String(m.importe).replace('.', ',')} €` : ''}${m.puntos ? ` · ${m.puntos} punto${m.puntos > 1 ? 's' : ''}` : ''}`);
    const c = n.conductorPropuesto;
    if (c && c.conductor) lin.push(`👤 La llevaba *${c.conductor.name}*${c.nota ? ` (${c.nota})` : ''}.`);
    else if (c && c.nota) lin.push(`👤 ${c.nota}.`);
    else if (!m.matricula) lin.push('Ábrela para ver la matrícula y el día; dímelos y te digo quién la llevaba.');
    if (n.plazoIdentificar) lin.push(`⏰ Identificar al conductor antes del *${fmt(n.plazoIdentificar)}* (${entre(hoy, n.plazoIdentificar)} días). Si no, la multa por no identificar es el doble o el triple.`);
  } else {
    lin.push(`📬 *${n.tipo === 'comunicacion' ? 'Comunicación' : 'Notificación'} oficial* de ${n.organismo || '¿?'}${recordatorio ? ' — ' + recordatorio : ''}`);
    if (n.concepto) lin.push(n.concepto);
  }
  if (n.vence && n.estado === 'pendiente') { const d = entre(hoy, n.vence); lin.push(`📅 Hay que abrirla antes del *${fmt(n.vence)}* (${d <= 0 ? 'HOY es el último día' : d === 1 ? 'mañana es el último día' : `quedan ${d} días`}). Si no, se da por notificada igual.`); }
  if (n.enlace) lin.push(n.enlace);
  return lin.join('\n');
}

// ── Guardar (sin repetir) y avisar ────────────────────────────────────────────────────────────────────────────────────────
async function registrar(p, { gmailId = null, avisar = true, _db = null, _enviar = null } = {}) {
  if (!p) return null;
  const db = _db || await getDB(); const col = db.collection('notifOficiales');
  // La misma notificación llega por varias vías (Red.es y DEHú; TITULAR y DESTINATARIO; recordatorios de e-NOTUM).
  const igual = (p.identificador && await col.findOne({ fuente: p.fuente, identificador: p.identificador }))
    || (p.concepto && await col.findOne({ conceptoNorm: norm(p.concepto), recibida: { $gte: masDias(p.recibida, -3), $lte: masDias(p.recibida, 3) } }));
  if (igual) { if (gmailId) await col.updateOne({ _id: igual._id }, { $addToSet: { gmailIds: gmailId } }); return { ...igual, repetida: true }; }
  const doc = { ...p, conceptoNorm: norm(p.concepto), gmailIds: gmailId ? [gmailId] : [], estado: p.vence && p.vence < hoyISO() ? 'caducada' : 'pendiente', avisos: {}, creado: new Date() };
  if (doc.tipo === 'comunicacion' || (doc.estado === 'pendiente' && RE_RUTINA.test(doc.concepto))) doc.estado = 'informativa';
  const rutina = RE_RUTINA.test(doc.concepto);
  if (doc.tipo === 'multa' && doc.multa && doc.multa.matricula) {
    doc.conductorPropuesto = await conductorEn(doc.multa.matricula, doc.multa.fechaInfraccion, { _db: db }).catch(() => null);
    // Multivia avisa cuando ya ha abierto la notificación: el plazo de 20 días corre desde entonces (aprox., el día del correo).
    if (doc.fuente === 'multivia') { doc.plazoIdentificar = masDias(doc.recibida, PLAZO_IDENTIFICAR); doc.estado = doc.plazoIdentificar < hoyISO() ? 'caducada' : 'abierta'; }
  }
  delete doc.recordatorio;
  const r = await col.insertOne(doc); doc._id = r.insertedId;
  if (avisar && doc.estado !== 'caducada' && !rutina) {
    try { await (_enviar || (t => require('./notifications').sendWhatsApp(t)))(textoAviso(doc)); await col.updateOne({ _id: doc._id }, { $set: { 'avisos.llegada': new Date() } }); }
    catch (e) { console.warn('[NotifOficiales] WhatsApp:', e.message); }
  }
  return doc;
}

const esCorreo = ({ de = '', asunto = '', cuerpo = '' } = {}) => /noreply\.dehu@correo\.gob\.es|enotum\.cat/i.test(de)
  || (/acelerapyme\.gob\.es/i.test(de) && /nueva (notificaci|comunicaci)/i.test(limpio(cuerpo)))
  || (/xvia-serviciosjuridicos|multivia/i.test(de) && /datos? (del )?conductor/i.test(asunto));
async function desdeCorreo({ de, asunto, cuerpo, payload = null, fecha, gmailId }) {
  if (process.env.NOTIF_OFICIALES === 'off' || !esCorreo({ de, asunto, cuerpo })) return null;
  return registrar(leer({ de, asunto, cuerpo: crudo(payload) || cuerpo, fecha }), { gmailId });
}

// ── Cada mañana: lo que vence y las multas sin identificar ───────────────────────────────────────────────────────────────
async function recordatorios({ hoy = hoyISO(), _db = null, _enviar = null, dryRun = false } = {}) {
  const db = _db || await getDB(); const col = db.collection('notifOficiales');
  const enviar = _enviar || (t => require('./notifications').sendWhatsApp(t));
  const out = [];
  for (const n of await col.find({ estado: { $in: ['pendiente', 'abierta'] } }).toArray()) {
    let clave = null, txt = null;
    if (n.estado === 'pendiente' && n.vence) {
      const d = entre(hoy, n.vence);
      if (d < 0) { if (!dryRun) await col.updateOne({ _id: n._id }, { $set: { estado: 'caducada' } }); continue; }
      if (d === 2 || d === 0) { clave = 'vence' + d; txt = textoAviso(n, { recordatorio: d === 0 ? 'último día para abrirla' : 'quedan 2 días' }); }
    } else if (n.tipo === 'multa' && n.plazoIdentificar && !(n.multa && n.multa.identificado)) {
      const d = entre(hoy, n.plazoIdentificar);
      if ([7, 2, 0].includes(d)) { clave = 'ident' + d; txt = textoAviso(n, { recordatorio: d === 0 ? 'HOY acaba el plazo para identificar' : `quedan ${d} días para identificar` }); }
    }
    if (!clave || (n.avisos && n.avisos[clave])) continue;
    out.push({ id: String(n._id), clave });
    if (dryRun) continue;
    try { await enviar(txt); await col.updateOne({ _id: n._id }, { $set: { ['avisos.' + clave]: new Date() } }); } catch (e) { console.warn('[NotifOficiales] recordatorio:', e.message); }
  }
  return { avisos: out };
}

// ── Para Inicio y los botones ─────────────────────────────────────────────────────────────────────────────────────────────
async function pendientes({ _db = null } = {}) {
  const db = _db || await getDB();
  const l = await db.collection('notifOficiales').find({ $or: [{ estado: 'pendiente' }, { estado: 'abierta', tipo: 'multa', 'multa.identificado': { $exists: false } }] }).toArray();
  return l.map(n => ({ id: String(n._id), fuente: n.fuente, tipo: n.tipo, estado: n.estado, organismo: n.organismo, concepto: n.concepto, identificador: n.identificador, recibida: n.recibida, vence: n.vence,
    enlace: n.enlace, multa: n.multa || null, conductorPropuesto: n.conductorPropuesto || null, plazoIdentificar: n.plazoIdentificar || null }))
    .sort((a, b) => String(a.vence || a.plazoIdentificar || '9').localeCompare(String(b.vence || b.plazoIdentificar || '9')));
}

async function marcar(id, { accion, matricula, fechaInfraccion, conductor } = {}, por = '', { _db = null } = {}) {
  const db = _db || await getDB(); const col = db.collection('notifOficiales');
  const { ObjectId } = require('mongodb');
  let _id; try { _id = new ObjectId(String(id)); } catch (e) { throw new Error('Notificación no válida'); }
  const n = await col.findOne({ _id }); if (!n) throw new Error('No encuentro esa notificación');
  const set = {}; const hoy = hoyISO();
  if (accion === 'abierta') { set.estado = 'abierta'; set.abiertaEn = hoy; set.abiertaPor = por; if (n.tipo === 'multa') set.plazoIdentificar = masDias(hoy, PLAZO_IDENTIFICAR); else set.estado = 'hecha'; }
  else if (accion === 'datos') {
    const mat = require('./vehiculos').matNorm(matricula); if (!mat) throw new Error('Falta la matrícula');
    const f = /^\d{4}-\d{2}-\d{2}$/.test(String(fechaInfraccion || '')) ? fechaInfraccion : null;
    set.tipo = 'multa'; set.multa = { ...(n.multa || {}), matricula: mat, fechaInfraccion: f };
    set.conductorPropuesto = await conductorEn(mat, f, { _db: db });
  } else if (accion === 'identificado') { set['multa.identificado'] = { name: String((conductor && conductor.name) || (n.conductorPropuesto && n.conductorPropuesto.conductor && n.conductorPropuesto.conductor.name) || ''), en: hoy, por }; set.estado = 'hecha'; }
  else if (accion === 'ignorar') { set.estado = 'ignorada'; set.ignoradaPor = por; }
  else throw new Error('Acción no válida');
  await col.updateOne({ _id }, { $set: set });
  return { ok: true, ...set };
}

// ── Cargar los avisos que ya hay en el correo (una vez, sin WhatsApp) ────────────────────────────────────────────────────
async function desdeHistorial({ dias = 120 } = {}) {
  const EI = require('./email-intelligence'); const gmail = EI.getGmailClient();
  const q = `newer_than:${dias}d (from:noreply.dehu@correo.gob.es OR from:enotum.cat OR from:avisos-pkd@acelerapyme.gob.es OR (from:xvia-serviciosjuridicos.com subject:conductor))`;
  const ids = []; let pageToken;
  do { const r = await gmail.users.messages.list({ userId: 'me', q, maxResults: 100, pageToken }); (r.data.messages || []).forEach(m => ids.push(m.id)); pageToken = r.data.nextPageToken; } while (pageToken && ids.length < 500);
  const res = { leidos: ids.length, nuevas: 0, repetidas: 0, sinLeer: 0 };
  for (const id of ids.reverse()) {
    const m = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const h = m.data.payload.headers; const hv = n => (h.find(x => x.name === n) || {}).value || '';
    const p = leer({ de: hv('From'), asunto: hv('Subject'), cuerpo: crudo(m.data.payload), fecha: new Date(Number(m.data.internalDate)) });
    if (!p) { res.sinLeer++; continue; }
    const d = await registrar(p, { gmailId: id, avisar: false });
    if (d && d.repetida) res.repetidas++; else res.nuevas++;
  }
  return res;
}

module.exports = { leer, limpio, crudo, conductorEn, textoAviso, registrar, esCorreo, desdeCorreo, recordatorios, pendientes, marcar, desdeHistorial, PLAZO_IDENTIFICAR };
