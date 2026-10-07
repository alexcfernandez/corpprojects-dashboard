// src/nominasCorreo.js — Las NÓMINAS que manda la gestoría por correo entran solas en el programa.
//
// Som Assessors (eduard@somassessors.com) envía cada mes un PDF con todas («342 setembre.pdf») y alguna suelta
// («nomina judit»). Cada PDF va a personalDocs.analizar: la IA lo parte por trabajador y saca mes, líquido, IRPF y
// SS. Las nóminas con trabajador reconocido quedan confirmadas; el resto, en /personal «Por confirmar».
// Contratos, cartas, simulaciones y absentismos no se tocan. Cada correo, una sola vez (docsPersonal.origen.gmailId).
'use strict';
async function getDB() { return require('./db').getDB(); }
const REMITENTE = new RegExp(process.env.NOMINAS_REMITENTE || 'somassessors', 'i');
const NO = /contra[ct]|carta|simulaci|absent|baixa|alta\b|finiquito|certificat/i;

function esCorreoNominas({ de, asunto, adjuntos }) {
  if (!REMITENTE.test(de || '')) return false;
  if (/contra[ct]|simulaci/i.test(asunto || '')) return false;   // contratos (traen previsiones de nóminas futuras) y simulaciones
  const pdfs = (adjuntos || []).filter(a => /\.pdf$/i.test(a.filename || '') || /pdf/i.test(a.mimeType || ''));
  if (!pdfs.length) return false;
  return /n[oòó]min/i.test(asunto || '') || pdfs.some(a => /n[oòó]min|^\s*342\b/i.test(a.filename || ''));
}
function pdfsNomina(adjuntos) {
  return (adjuntos || []).filter(a => (/\.pdf$/i.test(a.filename || '') || /pdf/i.test(a.mimeType || '')) && !NO.test(a.filename || '') || /baixa metge/i.test(a.filename || '') && /n[oòó]min|^\s*342\b/i.test(a.filename || ''));
}

async function desdeCorreo(messageId, adjuntos, { de, asunto, fecha } = {}, { avisar = true } = {}) {
  const db = await getDB();
  if (await db.collection('docsPersonal').findOne({ 'origen.gmailId': messageId }, { projection: { _id: 1 } })) return { yaEstaba: true };
  const EI = require('./email-intelligence');
  const archivos = [];
  for (const a of pdfsNomina(adjuntos)) {
    const buf = await EI.getAttachment(messageId, a.attachmentId);
    if (buf && buf.length && buf.length < 12 * 1024 * 1024) archivos.push({ buffer: buf, mimetype: 'application/pdf', originalname: a.filename || 'nomina.pdf', size: buf.length });
  }
  if (!archivos.length) return { nominas: 0 };
  const PD = require('./personalDocs');
  const docs = await PD.analizar(archivos, 'correo ' + (de || 'gestoría').replace(/.*<|>.*/g, ''));
  let confirmadas = 0;
  for (const d of docs) {
    await db.collection('docsPersonal').updateOne({ _id: new (require('mongodb').ObjectId)(d.id) }, { $set: { origen: { gmailId: messageId, asunto: asunto || null, fecha: fecha || null } } });
    if (d.tipo === 'nomina' && d.userId) { try { await PD.editar(d.id, { confirmar: true }, 'correo gestoría'); confirmadas++; } catch (e) { /* queda por confirmar */ } }
  }
  const noms = docs.filter(d => d.tipo === 'nomina');
  const liquido = noms.reduce((a, d) => a + ((d.importes && d.importes.liquido) || 0), 0);
  const res = { nominas: noms.length, confirmadas, porConfirmar: docs.length - confirmadas, liquido: Math.round(liquido * 100) / 100, meses: [...new Set(noms.map(d => d.mes).filter(Boolean))] };
  if (avisar && docs.length) {
    const txt = `📥 *Nóminas de la gestoría*${res.meses.length ? ' (' + res.meses.join(', ') + ')' : ''}: ${noms.length} nómina${noms.length === 1 ? '' : 's'}${liquido ? ` · líquido ${liquido.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' })} €` : ''}` +
      `${res.porConfirmar ? `\n${res.porConfirmar} documento(s) por confirmar en Personal → Subir documentos.` : ''}\nLo pagado y lo que falta: Personal → «Nóminas y pagos».`;
    const dest = String(process.env.BANCO_AVISOS_TO || process.env.FICHAJE_AVISOS_TO || process.env.WHATSAPP_TO || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const to of dest) { try { await require('./notifications').sendWhatsAppTo(to, txt); } catch (e) {} }
    try { await require('./push').sendToOficina({ title: '📥 Nóminas de la gestoría', body: txt.split('\n')[0].replace(/\*/g, ''), url: '/personal' }); } catch (e) {}
  }
  return res;
}

// Recupera las nóminas que ya llegaron por correo (desde una fecha), sin avisar de cada una.
async function importarDelCorreo({ desde = '2026-01-01' } = {}) {
  const EI = require('./email-intelligence');
  const g = EI.getGmailClient();
  const q = `from:(${process.env.NOMINAS_REMITENTE || 'somassessors.com'}) has:attachment after:${desde.replace(/-/g, '/')}`;
  const ids = []; let pageToken;
  do { const r = await g.users.messages.list({ userId: 'me', q, maxResults: 100, pageToken }); (r.data.messages || []).forEach(m => ids.push(m.id)); pageToken = r.data.nextPageToken; } while (pageToken && ids.length < 400);
  const out = [];
  for (const id of ids.reverse()) {
    const m = await g.users.messages.get({ userId: 'me', id, format: 'full' });
    const h = m.data.payload.headers || []; const v = k => (h.find(x => x.name.toLowerCase() === k) || {}).value || '';
    const adjuntos = EI.extractAttachments(m.data.payload);
    const meta = { de: v('from'), asunto: v('subject'), fecha: new Date(Number(m.data.internalDate)) };
    if (!esCorreoNominas({ ...meta, adjuntos })) continue;
    try { out.push({ asunto: meta.asunto, ...(await desdeCorreo(id, adjuntos, meta, { avisar: false })) }); } catch (e) { out.push({ asunto: meta.asunto, error: e.message }); }
  }
  return out;
}

module.exports = { esCorreoNominas, pdfsNomina, desdeCorreo, importarDelCorreo };
