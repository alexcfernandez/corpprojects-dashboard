// src/docsGestoriaCorreo.js — El paquete mensual de la gestoría («documentació mensual»: ITA, RNT/RLC, certificados de
// estar al corriente con la Seguridad Social y Hacienda) entra solo en Personal → Empresa como la versión nueva (9/10/2026).
// Por el nombre del archivo cuando es inequívoco (InSeNaCoder = ITA, 10 dígitos = RNT/RLC); los certificados, por su
// contenido con la IA (el «Certificadogenérico» unas veces es de la SS y otras de Hacienda).
'use strict';
async function getDB() { return require('./db').getDB(); }
const esPdf = a => /pdf$/i.test(a.mimeType || '') || /\.pdf$/i.test(a.filename || '');
const RE_DOC = /InSeNaCoder|certificad|ViewDocUtf8|CotejoDocIdSv|^\d{9,11}\.pdf$|\bRNT\b|\bRLC\b|\bITA\b|corrent|corriente/i;

function esCorreoDocs({ de, asunto, adjuntos }) {
  if (!/somassessors|gc4\.cat|atec\.cat/i.test(String(de || '')) && !(process.env.GESTORIA_EMAILS || '').split(',').some(e => e.trim() && String(de || '').toLowerCase().includes(e.trim().toLowerCase()))) return false;
  const pdfs = (adjuntos || []).filter(esPdf);
  return pdfs.some(a => RE_DOC.test(a.filename || '')) || (/documentaci|certificat|certificado|\bita\b|\brnt\b|\brlc\b/i.test(String(asunto || '')) && pdfs.length > 0);
}
// Mes anterior al del correo (el RNT/RLC que llega el día 1-5 es el del mes pasado).
const mesAnterior = f => { const d = new Date(f || Date.now()); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };

function tipoPorNombre(nombre) {
  if (/InSeNaCoder|\bITA\b/i.test(nombre)) return 'ita';
  if (/^\d{9,11}\.pdf$/i.test(nombre) || /\bRNT\b|\bRLC\b/i.test(nombre)) return 'rnt_rlc';
  return null;
}

async function desdeCorreo(messageId, adjuntos, { de, asunto, fecha } = {}, { _clasificar = null } = {}) {
  const db = await getDB();
  if (await db.collection('docsPersonal').findOne({ 'origen.gmailId': messageId, ambito: 'empresa' }, { projection: { _id: 1 } })) return { yaEstaba: true };
  const EI = require('./email-intelligence'); const PD = require('./personalDocs');
  const dia = new Date(fecha || Date.now()).toISOString().slice(0, 10);
  const guardados = [];
  for (const a of (adjuntos || []).filter(esPdf).filter(a => !/^image0/i.test(a.filename || '')).slice(0, 10)) {
    const buf = await EI.getAttachment(messageId, a.attachmentId);
    if (!buf || !buf.length) continue;
    const archivo = { buffer: buf, mimetype: 'application/pdf', originalname: a.filename || 'documento.pdf', size: buf.length };
    let tipo = tipoPorNombre(a.filename || '');
    if (!tipo) {
      const r = await (_clasificar || (x => PD._clasificarIA(x, [])))(archivo).catch(() => null);
      const d = r && r.ok && r.documentos && r.documentos[0];
      tipo = d && d.ambito === 'empresa' && PD.TIPOS_EMPRESA[d.tipo] ? d.tipo : null;
    }
    if (!tipo) continue;   // lo que no se reconozca se queda en el correo (no se inventa)
    const doc = await PD.subir({ ambito: 'empresa', tipo, archivo, fecha: tipo === 'rnt_rlc' ? null : dia, mes: tipo === 'rnt_rlc' ? mesAnterior(fecha) : null, notas: `Llegó por correo de la gestoría el ${dia.split('-').reverse().join('/')} («${String(asunto || '').slice(0, 60)}»)` }, 'correo gestoría');
    await db.collection('docsPersonal').updateOne({ _id: require('mongodb').ObjectId.createFromHexString(doc.id) }, { $set: { origen: { gmailId: messageId, archivo: a.filename } } });
    guardados.push(`${PD.TIPOS_EMPRESA[tipo].nombre}${tipo === 'rnt_rlc' ? ' (' + mesAnterior(fecha) + ')' : ''}`);
  }
  if (guardados.length) { try { await require('./notifications').sendWhatsApp(`📁 Guardado en Personal → Empresa (de la gestoría):\n${[...new Set(guardados)].map(g => '• ' + g).join('\n')}`); } catch (e) {} }
  return { guardados: guardados.length };
}
module.exports = { esCorreoDocs, desdeCorreo, _tipoPorNombre: tipoPorNombre, _mesAnterior: mesAnterior };
