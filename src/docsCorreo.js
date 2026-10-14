// src/docsCorreo.js — DOCUMENTOS QUE LLEGAN POR CORREO → a su carpeta (13/10/2026; sustituye a docsGestoriaCorreo).
// Antes solo se guardaba el paquete mensual de la gestoría y por el NOMBRE del archivo («InSeNaCoder» = ITA), y se
// equivocaba (el 13/10 un TA.7 entró como ITA y el certificado de Hacienda específico para Seranco como uno genérico).
// Ahora: cualquier correo con PDFs de papeles (gestoría, SPASS, aseguradoras, contratistas, trabajadores…) → la IA lee
// CADA PDF por su contenido y lo guarda donde toca:
//   · empresa (certificados, ITA, RNT/RLC, TA.7, IAE, pólizas, mutua…),
//   · trabajador (contrato, alta SS, reconocimiento, cursos PRL, EPIs…) — por nombre/DNI,
//   · obra (el certificado de Hacienda «para contratistas» va a la obra de ese contratista, p. ej. Seranco).
// De remitentes de confianza (gestoría, SPASS) entra como bueno; del resto, o si no se sabe de quién es, queda como
// PROPUESTA en Personal para que oficina lo confirme con un clic. Nada se tira: lo que no se reconoce se avisa.
// Las nóminas y las facturas no pasan por aquí (tienen su propio camino).
'use strict';
async function getDB() { return require('./db').getDB(); }
const esPdf = a => /pdf$/i.test(a.mimeType || '') || /\.pdf$/i.test(a.filename || '');
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const RE_ASUNTO = /document|certificad|certificat|poliza|polissa|contrat|reconocimiento|reconeixement|aptitud|apte|formaci|curs|prl|\bepis?\b|\bita\b|\brnt\b|\brlc\b|\balta\b|\bta\.?7\b|iae|mutua|seguro|asseguran|nomin/i;
const sinAcentos = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

function confiable(de) {
  const d = String(de || '').toLowerCase();
  const extra = String(process.env.DOCS_CORREO_CONFIABLES || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  const gest = String(process.env.GESTORIA_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  return /somassessors|gc4\.cat|atec\.cat|spass\.es/.test(d) || [...extra, ...gest].some(e => d.includes(e));
}

// ¿Este correo trae papeles para guardar? (las facturas y las nóminas van por su lado)
function esCorreoDocs({ de, asunto, adjuntos, clasificacion = {} }) {
  const pdfs = (adjuntos || []).filter(esPdf).filter(a => !/^image0/i.test(a.filename || ''));
  if (!pdfs.length) return false;
  if (['FACTURA_PROVEEDOR', 'PUBLICIDAD', 'SPAM', 'PRESUPUESTO'].includes(clasificacion.categoria)) return false;
  // Condiciones comerciales, tarifas y descuentos de proveedores (Weber, 14/10/2026) no son papeles del personal.
  if (/condiciones comerciales|descuento|tarifa|oferta|promoci/.test(sinAcentos(asunto).toLowerCase())) return false;
  return confiable(de) || clasificacion.documentos === true || RE_ASUNTO.test(sinAcentos(asunto)) || pdfs.some(a => RE_ASUNTO.test(sinAcentos(a.filename)));
}

// Obra de contratista a la que va un certificado «para contratistas» (por el nombre del contratista).
async function obraDeContratista(db, nombre) {
  const pal = norm(nombre).split(' ').filter(w => w.length >= 4 && !/^(sociedad|limitada|anonima|unipersonal)$/.test(w));
  if (!pal.length) return null;
  const os = await db.collection('obras').find({ 'docsEntrada.plantilla': { $exists: true }, status: { $nin: ['terminada', 'facturada', 'archivada', 'descartada'] } }, { projection: { clientName: 1, reference: 1 } }).toArray();
  return os.find(o => { const c = norm(o.clientName + ' ' + o.reference); return pal.some(w => c.includes(w)); }) || null;
}

async function desdeCorreo(messageId, adjuntos, { de, asunto, fecha } = {}, { _clasificar = null, _bajar = null, _avisar = null } = {}) {
  const db = await getDB();
  if (await db.collection('docsPersonal').findOne({ 'origen.gmailId': messageId }, { projection: { _id: 1 } })) return { yaEstaba: true };
  const PD = require('./personalDocs');
  const deConfianza = confiable(de);
  const dia = new Date(fecha || Date.now()).toISOString().slice(0, 10);
  const quien = String(de || '').replace(/<.*>/, '').replace(/"/g, '').trim() || String(de || '');
  const plantilla = await PD._plantilla();
  const guardados = [], propuestas = [], sinLeer = [];
  const pdfs = (adjuntos || []).filter(esPdf).filter(a => !/^image0/i.test(a.filename || '')).slice(0, 10);
  for (const a of pdfs) {
    const buf = await (_bajar || ((id, att) => require('./email-intelligence').getAttachment(id, att)))(messageId, a.attachmentId);
    if (!buf || !buf.length) continue;
    const archivo = { buffer: buf, mimetype: 'application/pdf', originalname: a.filename || 'documento.pdf', size: buf.length };
    const r = await (_clasificar || (x => PD._clasificarIA(x, plantilla)))(archivo).catch(() => null);
    const lista = (r && r.ok && r.documentos) || [];
    if (!lista.length) { sinLeer.push(a.filename); continue; }
    for (const d of lista.slice(0, 20)) {
      if (d.tipo === 'nomina') continue;   // las nóminas entran por nominasCorreo
      let ambito = d.ambito === 'empresa' ? 'empresa' : 'trabajador', tipo = d.tipo, obraId = null, userId = null, para = '';
      if (ambito === 'empresa' && tipo === 'cert_hacienda' && d.contratista) {
        const o = await obraDeContratista(db, d.contratista);
        if (o) { ambito = 'obra'; tipo = 'cert_hacienda_contratista'; obraId = String(o._id); para = ` (para ${o.reference})`; }
      }
      if (ambito === 'empresa' && !PD.TIPOS_EMPRESA[tipo]) tipo = 'otro_empresa';
      if (ambito === 'trabajador') {
        if (!PD.TIPOS[tipo]) tipo = 'otro';
        const w = PD._matchTrabajador(plantilla, d.trabajador, d.dni);
        if (w) { userId = w.id; para = ` de ${w.name}`; } else if (d.trabajador) para = ` de «${d.trabajador}» (¿quién es?)`;
      }
      const seguro = deConfianza && (ambito !== 'trabajador' || userId) && !/^otro/.test(tipo);
      let b = buf;
      if (lista.length > 1 && Array.isArray(d.paginas) && d.paginas.length) { try { b = await PD._extraerPaginas(buf, d.paginas); } catch (e) {} }
      const nombre = (a.filename || 'documento.pdf') + (lista.length > 1 && d.paginas && d.paginas.length ? ` (pág. ${d.paginas.join(',')})` : '');
      const doc = await PD.subir({ ambito, userId, obraId, tipo, archivo: { ...archivo, buffer: b, size: b.length, originalname: nombre }, fecha: d.fecha || dia, caduca: d.caduca, mes: d.mes,
        notas: `${String(d.resumen || '').slice(0, 160)} — llegó por correo de ${quien.slice(0, 50)} el ${dia.split('-').reverse().join('/')}`.trim(), estado: seguro ? 'ok' : 'propuesta' }, 'correo');
      await db.collection('docsPersonal').updateOne({ _id: require('mongodb').ObjectId.createFromHexString(doc.id) }, { $set: { origen: { gmailId: messageId, archivo: a.filename, de: String(de || '').slice(0, 120) } } });
      const nom = ((ambito === 'obra' ? PD.TIPOS_OBRA : ambito === 'empresa' ? PD.TIPOS_EMPRESA : PD.TIPOS)[tipo] || {}).nombre || tipo;
      (seguro ? guardados : propuestas).push(nom + para);
    }
  }
  if (guardados.length || propuestas.length || sinLeer.length) {
    const t = [`📁 *Papeles del correo* de ${quien.slice(0, 40)} («${String(asunto || '').slice(0, 50)}»):`];
    if (guardados.length) t.push('Guardado:\n' + [...new Set(guardados)].map(g => '• ' + g).join('\n'));
    if (propuestas.length) t.push('Para confirmar en Personal (revisa que esté bien):\n' + [...new Set(propuestas)].map(g => '• ' + g).join('\n'));
    if (sinLeer.length) t.push('No he sabido qué es: ' + sinLeer.join(', ') + ' (sigue en el correo).');
    try { await (_avisar || require('./notifications').sendWhatsApp)(t.join('\n\n')); } catch (e) {}
  }
  return { guardados: guardados.length, propuestas: propuestas.length, sinLeer: sinLeer.length };
}

module.exports = { esCorreoDocs, desdeCorreo, confiable, _obraDeContratista: obraDeContratista };
