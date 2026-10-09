// src/firmas.js — Firma de documentos por el trabajador en su app de fichar (9/10/2026).
//
// La oficina pide la firma de un documento de su carpeta (contrato, nómina…) o de una ENTREGA DE EPIs (se genera el
// PDF con lo entregado). Corpy le avisa por WhatsApp con su enlace; en la app lo ve, firma con el dedo y la firma se
// estampa en el PDF: hoja final con la firma, nombre, fecha y hora, la huella SHA-256 del original y la IP, y una
// marca en el pie de cada página. La copia firmada se guarda en su carpeta (el original no se toca).
// Colección `firmasPedidas`.
'use strict';
const crypto = require('crypto');
const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const COL = 'firmasPedidas';
const EMPRESA = 'Corp Projects Holding, S.L. · CIF B09899253 · C/ Nou 12, 2º 2B, 17001 Girona';

const ahora = () => new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const hoyIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
// Helvetica de pdf-lib solo pinta WinAnsi: fuera emojis y raros, se quedan acentos, ñ, €, «».
const ansi = s => String(s == null ? '' : s).normalize('NFC').replace(/[^\x20-\x7E -ÿ€–—‘’“”•…]/g, '');

// Lo que se entrega en un kit para su trabajo (herramienta de mano, polvo, ruido). La oficina marca y ajusta.
const KIT_EPIS = [
  { k: 'botas', nombre: 'Botas de seguridad S3', talla: 'calzado' },
  { k: 'casco', nombre: 'Casco de seguridad' },
  { k: 'gafas', nombre: 'Gafas de protección' },
  { k: 'guantes', nombre: 'Guantes de protección mecánica (pares)', cantidad: 2 },
  { k: 'auditivos', nombre: 'Protección auditiva (orejeras o tapones)' },
  { k: 'mascarillas', nombre: 'Mascarillas FFP2/FFP3 (polvo)', cantidad: 10 },
  { k: 'chaleco', nombre: 'Chaleco de alta visibilidad', talla: 'ropa' },
  { k: 'pantalon', nombre: 'Pantalón de trabajo', talla: 'pantalon', cantidad: 2 },
  { k: 'camiseta', nombre: 'Camiseta de trabajo', talla: 'ropa', cantidad: 2 },
  { k: 'sudadera', nombre: 'Sudadera / chaqueta de trabajo', talla: 'ropa' },
];

async function _usuario(db, userId) { return db.collection('users').findOne({ _id: new ObjectId(String(userId)) }, { projection: { name: 1, whatsapp: 1, telefono: 1, tallas: 1, dni: 1 } }); }

// Oficina: pedir firma. tipo 'documento' (docId de su carpeta) o 'epis' (items [{nombre, cantidad, talla}]).
async function pedir({ userId, tipo = 'documento', docId = null, items = [], titulo = '', avisar = true }, por, { _enviar = null } = {}) {
  const db = await getDB();
  const u = await _usuario(db, userId);
  if (!u) throw new Error('No encuentro el trabajador');
  let doc = null;
  if (tipo === 'documento') {
    doc = docId && /^[a-f0-9]{24}$/.test(String(docId)) ? await db.collection('docsPersonal').findOne({ _id: new ObjectId(String(docId)) }, { projection: { nombre: 1, tipo: 1, userId: 1, mime: 1 } }) : null;
    if (!doc || doc.userId !== String(userId)) throw new Error('Ese documento no es de su carpeta');
    if (!/pdf|image\//.test(doc.mime || '')) throw new Error('Solo se pueden firmar PDF o fotos');
  } else if (tipo === 'epis') {
    items = (Array.isArray(items) ? items : []).map(i => ({ nombre: ansi(i.nombre).slice(0, 80), cantidad: Math.max(1, Math.min(50, parseInt(i.cantidad, 10) || 1)), talla: ansi(i.talla || '').slice(0, 12) })).filter(i => i.nombre).slice(0, 30);
    if (!items.length) throw new Error('Marca qué se le entrega');
  } else throw new Error('Tipo no válido');
  const f = { userId: String(userId), nombre: u.name, tipo, docId: doc ? String(doc._id) : null, docTipo: doc ? doc.tipo : 'epis', titulo: ansi(titulo || (doc ? doc.nombre : 'Entrega de EPIs y ropa de trabajo')).slice(0, 120), items, estado: 'pendiente', por: por || '', at: new Date() };
  const r = await db.collection(COL).insertOne(f);
  let avisado = false;
  if (avisar) {
    const movil = require('./recordatoriosCobro')._movil(u.whatsapp || u.telefono);
    let enlace = null; try { enlace = await require('./fichajeAvisos').enlacePersonal(String(userId)); } catch (e) {}
    if (movil) {
      const txt = `Hola ${String(u.name || '').split(/\s+/)[0]} 👋 Tienes un documento para firmar en tu app: *${f.titulo}*.\n\nÁbrelo desde tu enlace de fichar, léelo y firma con el dedo en la pantalla.${enlace ? '\n' + enlace : ''}`;
      try { avisado = (await (_enviar || require('./notifications').sendWhatsAppTo)(movil, txt)) !== false; } catch (e) {}
    }
  }
  return { ok: true, id: String(r.insertedId), avisado };
}

async function pendientesDe(userId) {
  const db = await getDB();
  return (await db.collection(COL).find({ userId: String(userId), estado: 'pendiente' }).sort({ at: 1 }).toArray()).map(f => ({ id: String(f._id), tipo: f.tipo, titulo: f.titulo, items: f.items || [], at: f.at }));
}
async function lista({ userId } = {}) {
  const db = await getDB();
  const q = userId ? { userId: String(userId) } : {};
  return (await db.collection(COL).find(q, { projection: { firmaPng: 0 } }).sort({ at: -1 }).limit(100).toArray()).map(f => ({ id: String(f._id), userId: f.userId, nombre: f.nombre, tipo: f.tipo, titulo: f.titulo, estado: f.estado, at: f.at, firmadoAt: f.firmadoAt || null, docFirmadoId: f.docFirmadoId || null }));
}
async function anular(id) { const db = await getDB(); await db.collection(COL).updateOne({ _id: new ObjectId(String(id)), estado: 'pendiente' }, { $set: { estado: 'anulada', anuladaAt: new Date() } }); return { ok: true }; }

// El PDF a firmar (para que lo lea antes): el documento original o la entrega de EPIs sin firmar.
async function documentoParaFirmar(id, userId) {
  const db = await getDB();
  const f = await db.collection(COL).findOne({ _id: new ObjectId(String(id)), userId: String(userId) });
  if (!f) throw new Error('No encontrado');
  if (f.tipo === 'epis') return { mime: 'application/pdf', nombre: 'Entrega de EPIs.pdf', buffer: Buffer.from(await _pdfEpis(f, null)) };
  const d = await require('./personalDocs').archivo(f.docId);
  if (!d) throw new Error('Documento no encontrado');
  return { mime: d.mime, nombre: d.nombre, buffer: Buffer.from(d.data.buffer || d.data) };
}

async function _pdfEpis(f, firma) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const p = pdf.addPage([595, 842]); let y = 790;
  const t = (s, x, yy, size = 10, f2 = font) => p.drawText(ansi(s), { x, y: yy, size, font: f2, color: rgb(0.1, 0.1, 0.12) });
  t('ENTREGA DE EQUIPOS DE PROTECCIÓN INDIVIDUAL Y ROPA DE TRABAJO', 50, y, 13, bold); y -= 18;
  t(EMPRESA, 50, y, 9); y -= 26;
  t(`Trabajador/a: ${f.nombre}`, 50, y, 11, bold); y -= 16;
  t(`Fecha de entrega: ${firma ? firma.cuando : hoyIso().split('-').reverse().join('/')}`, 50, y, 10); y -= 24;
  t('Cantidad', 50, y, 10, bold); t('Equipo', 110, y, 10, bold); t('Talla', 470, y, 10, bold); y -= 6;
  p.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 0.6, color: rgb(0.6, 0.6, 0.6) }); y -= 14;
  for (const i of f.items || []) { t(String(i.cantidad || 1), 60, y); t(i.nombre, 110, y); t(i.talla || '', 470, y); y -= 16; }
  y -= 12;
  const legal = ['El trabajador/a declara haber recibido los equipos indicados en buen estado, así como la información sobre su',
    'uso correcto, mantenimiento y los riesgos de los que le protegen (art. 17 y 29 de la Ley 31/1995 de PRL y RD 773/1997).',
    'Se compromete a utilizarlos durante el trabajo, a cuidarlos y a comunicar a la empresa cualquier defecto, pérdida o',
    'deterioro para su reposición.'];
  for (const l of legal) { t(l, 50, y, 9); y -= 13; }
  y -= 20;
  t('Firma del trabajador/a:', 50, y, 10, bold); t(`Entrega: ${f.por || 'Corp Projects'}`, 330, y, 10, bold);
  if (firma) {
    const png = await pdf.embedPng(firma.png);
    const w = 200, h = Math.min(90, png.height * (w / png.width));
    p.drawImage(png, { x: 50, y: y - h - 6, width: w, height: h });
    t(`Firmado en la app el ${firma.cuando}`, 50, y - h - 20, 8);
  }
  return pdf.save();
}

// El trabajador firma: se estampa y se guarda la copia firmada en su carpeta.
async function firmar(id, userId, { firmaDataUrl, ip = '', ua = '' } = {}) {
  const db = await getDB();
  const f = await db.collection(COL).findOne({ _id: new ObjectId(String(id)), userId: String(userId), estado: 'pendiente' });
  if (!f) throw new Error('Ya está firmado o no existe');
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(firmaDataUrl || ''));
  if (!m) throw new Error('Falta la firma');
  const png = Buffer.from(m[1], 'base64');
  if (png.length < 800) throw new Error('La firma está vacía: firma con el dedo en el recuadro');
  const cuando = ahora();
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  let salida, nombre, tipoP, original = null;
  if (f.tipo === 'epis') {
    salida = await _pdfEpis(f, { png, cuando });
    nombre = `Entrega de EPIs y ropa ${f.nombre} ${hoyIso()} (firmado).pdf`; tipoP = 'epis';
  } else {
    const d = await require('./personalDocs').archivo(f.docId);
    if (!d) throw new Error('Documento no encontrado');
    original = Buffer.from(d.data.buffer || d.data);
    let pdf;
    if (/pdf/.test(d.mime)) pdf = await PDFDocument.load(original, { ignoreEncryption: true });
    else { pdf = await PDFDocument.create(); const img = /png/.test(d.mime) ? await pdf.embedPng(original) : await pdf.embedJpg(original); const pg = pdf.addPage([595, 842]); const sc = Math.min(515 / img.width, 762 / img.height); pg.drawImage(img, { x: 40, y: 842 - 40 - img.height * sc, width: img.width * sc, height: img.height * sc }); }
    const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const huella = crypto.createHash('sha256').update(original).digest('hex');
    const marca = ansi(`Firmado por ${f.nombre} el ${cuando} en la app de Corp Projects · ref. ${String(f._id).slice(-8)}`);
    for (const pg of pdf.getPages()) { const { width } = pg.getSize(); pg.drawText(marca, { x: 30, y: 12, size: 7, font, color: rgb(0.35, 0.35, 0.4), maxWidth: width - 60 }); }
    const hoja = pdf.addPage([595, 842]); let y = 780;
    const t = (s, size = 10, f2 = font) => { hoja.drawText(ansi(s), { x: 50, y, size, font: f2, color: rgb(0.1, 0.1, 0.12), maxWidth: 495 }); y -= size + 8; };
    t('HOJA DE FIRMA', 14, bold); t(EMPRESA, 9); y -= 10;
    t(`Documento: ${d.nombre}`, 10, bold); t(`Firmante: ${f.nombre}`, 11, bold); t(`Fecha y hora: ${cuando} (hora de Madrid)`); t(`Huella SHA-256 del documento original: ${huella}`, 7.5);
    t(`Desde la IP ${ip || '¿?'} · ${String(ua).slice(0, 90)}`, 7.5); y -= 6;
    t('El firmante declara haber leído el documento y estar conforme con su contenido.', 10);
    const img = await pdf.embedPng(png); const w = 240, h = Math.min(110, img.height * (w / img.width));
    hoja.drawImage(img, { x: 50, y: y - h, width: w, height: h });
    salida = await pdf.save();
    nombre = String(d.nombre || 'documento').replace(/\.(pdf|jpe?g|png|webp)$/i, '') + ' (firmado).pdf'; tipoP = d.tipo || f.docTipo || 'otro';
  }
  const g = await require('./personalDocs').subir({ ambito: 'trabajador', userId: f.userId, tipo: tipoP, archivo: { buffer: Buffer.from(salida), mimetype: 'application/pdf', originalname: nombre }, fecha: hoyIso(), notas: `Firmado en la app el ${cuando}` }, `${f.nombre} (firma en la app)`);
  await db.collection(COL).updateOne({ _id: f._id }, { $set: { estado: 'firmado', firmadoAt: new Date(), firmaPng: png, ip, ua: String(ua).slice(0, 200), docFirmadoId: g.id, huellaOriginal: original ? crypto.createHash('sha256').update(original).digest('hex') : null } });
  try { await require('./notifications').sendWhatsApp(`✍️ *${f.nombre}* ha firmado en la app: ${f.titulo}.`); } catch (e) {}
  return { ok: true, docId: g.id };
}

module.exports = { KIT_EPIS, pedir, pendientesDe, lista, anular, documentoParaFirmar, firmar, _pdfEpis };
