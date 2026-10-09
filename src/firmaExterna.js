// src/firmaExterna.js — Firma con el dedo para quien NO tiene la app de fichar (9/10/2026): el administrador (Alfonso)
// para el contrato y los formularios del contratista, la portada de SPASS, la declaración responsable…
//
// La oficina elige documentos (de una obra o de empresa) y a quién; Corpy le manda UN enlace /firmar/<token> (7 días).
// Ahí ve la lista, abre cada documento, firma una vez con el dedo y esa firma se estampa en todos los marcados: hoja
// final con nombre, DNI, cargo, sello de la empresa, fecha y hora, huella SHA-256 del original e IP, y marca en el pie
// de cada página. Las copias firmadas se guardan junto al original (mismo ámbito y obra) con el tipo que toque
// (contrato de obra, adhesión al PSS…). Colección `firmasLotes`.
'use strict';
const crypto = require('crypto');
const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const COL = 'firmasLotes';
const SELLO = ['CORP PROJECTS HOLDING, S.L.', 'CIF B09899253', 'C/ Nou 12, 2º 2B · 17001 Girona'];
const ansi = s => String(s == null ? '' : s).normalize('NFC').replace(/[^\x20-\x7E -ÿ€–—‘’“”•…]/g, '');
const ahora = () => new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const hoyIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });

async function crear({ nombre, telefono, dni = '', cargo = 'Administrador único', docs = [], obraId = null, mensaje = '' }, por, { _enviar = null } = {}) {
  const db = await getDB();
  const movil = require('./recordatoriosCobro')._movil(telefono);
  if (!movil) throw new Error('Teléfono no válido');
  if (!String(nombre || '').trim()) throw new Error('¿Quién firma?');
  const ids = (docs || []).map(d => String(d.docId || '')).filter(x => /^[a-f0-9]{24}$/.test(x)).slice(0, 15);
  const enc = await db.collection('docsPersonal').find({ _id: { $in: ids.map(x => new ObjectId(x)) }, ambito: { $in: ['obra', 'empresa'] } }, { projection: { nombre: 1, ambito: 1, obraId: 1, tipo: 1, mime: 1 } }).toArray();
  if (!enc.length) throw new Error('Elige qué documentos tiene que firmar');
  const P = require('./personalDocs');
  const items = enc.map(d => {
    const pedido = (docs || []).find(x => String(x.docId) === String(d._id)) || {};
    const tipos = d.ambito === 'obra' ? P.TIPOS_OBRA : P.TIPOS_EMPRESA;
    return { docId: String(d._id), nombre: d.nombre, ambito: d.ambito, obraId: d.obraId || obraId || null, tipoDestino: tipos[pedido.tipoDestino] ? pedido.tipoDestino : d.tipo, estado: 'pendiente' };
  });
  const lote = { nombre: ansi(nombre).slice(0, 80), movil, dni: ansi(dni).slice(0, 20), cargo: ansi(cargo).slice(0, 60), obraId: obraId || items[0].obraId || null, items, por: por || '', at: new Date(), estado: 'pendiente' };
  const r = await db.collection(COL).insertOne(lote);
  const token = require('./enlaceDoc').crear(String(r.insertedId), { dias: 7, uso: 'firma' });
  const url = `${process.env.DASHBOARD_URL || 'https://dashboard.corpprojects.es'}/firmar/${token}`;
  const txt = `${String(mensaje || '').trim() ? String(mensaje).trim() + '\n\n' : ''}Hola ${lote.nombre.split(/\s+/)[0]} 👋 Tienes ${items.length} documento${items.length > 1 ? 's' : ''} de Corp Projects para firmar con el dedo desde el móvil (se pueden leer antes):\n${url}\n\n(El enlace vale 7 días.)`;
  const ok = await (_enviar || require('./notifications').sendWhatsAppTo)(movil, txt);
  if (ok === false) throw new Error('No se pudo enviar el WhatsApp');
  return { ok: true, id: String(r.insertedId), url, a: movil };
}

async function _lote(token) {
  const id = require('./enlaceDoc').verificar(token, { uso: 'firma' });
  if (!id) throw new Error('Enlace caducado o no válido. Pide uno nuevo a la oficina de Corp Projects.');
  const db = await getDB();
  const l = await db.collection(COL).findOne({ _id: new ObjectId(id) });
  if (!l) throw new Error('No encontrado');
  return l;
}
async function ver(token) {
  const l = await _lote(token);
  return { nombre: l.nombre, cargo: l.cargo, dni: l.dni, items: l.items.map((i, n) => ({ n, nombre: i.nombre, estado: i.estado, firmadoAt: i.firmadoAt || null })) };
}
async function documento(token, n) {
  const l = await _lote(token);
  const it = l.items[Number(n)];
  if (!it) throw new Error('No encontrado');
  const d = await require('./personalDocs').archivo(it.firmadoId || it.docId);
  if (!d) throw new Error('Documento no encontrado');
  return { mime: d.mime, nombre: d.nombre, buffer: Buffer.from(d.data.buffer || d.data) };
}

async function _estampar(original, mime, { nombreDoc, firmante, dni, cargo, cuando, ip, ua, png, notas, ref }) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  let pdf;
  if (/pdf/.test(mime)) pdf = await PDFDocument.load(original, { ignoreEncryption: true });
  else { pdf = await PDFDocument.create(); const img = /png/.test(mime) ? await pdf.embedPng(original) : await pdf.embedJpg(original); const pg = pdf.addPage([595, 842]); const sc = Math.min(515 / img.width, 762 / img.height); pg.drawImage(img, { x: 40, y: 842 - 40 - img.height * sc, width: img.width * sc, height: img.height * sc }); }
  const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const huella = crypto.createHash('sha256').update(original).digest('hex');
  const marca = ansi(`Firmado por ${firmante} (${cargo}) el ${cuando} · Corp Projects Holding, S.L. · ref. ${ref}`);
  for (const pg of pdf.getPages()) { const { width } = pg.getSize(); pg.drawText(marca, { x: 30, y: 12, size: 7, font, color: rgb(0.35, 0.35, 0.4), maxWidth: width - 60 }); }
  const hoja = pdf.addPage([595, 842]); let y = 780;
  const t = (s, size = 10, f2 = font) => { hoja.drawText(ansi(s), { x: 50, y, size, font: f2, color: rgb(0.1, 0.1, 0.12), maxWidth: 495 }); y -= size + 8; };
  t('HOJA DE FIRMA', 14, bold); y -= 4;
  t(`Documento: ${nombreDoc}`, 10, bold);
  t(`Firmante: ${firmante}${dni ? ' · DNI ' + dni : ''}`, 11, bold);
  t(`En calidad de: ${cargo} de Corp Projects Holding, S.L. (CIF B09899253)`);
  t(`Fecha y hora: ${cuando} (hora de Madrid)`);
  t(`Huella SHA-256 del documento original: ${huella}`, 7.5);
  t(`Desde la IP ${ip || '¿?'} · ${String(ua).slice(0, 90)}`, 7.5);
  if (notas) { y -= 4; t('Datos / observaciones del firmante:', 10, bold); for (const l of String(notas).match(/.{1,95}(\s|$)/g) || []) t(l.trim(), 10); }
  y -= 6; t('El firmante declara haber leído el documento y estar conforme con su contenido.', 10);
  const img = await pdf.embedPng(png); const w = 230, h = Math.min(110, img.height * (w / img.width));
  hoja.drawImage(img, { x: 50, y: y - h, width: w, height: h });
  // Sello de la empresa (recuadro) al lado de la firma
  const sx = 330, sy = y - 95;
  hoja.drawRectangle({ x: sx, y: sy, width: 215, height: 80, borderColor: rgb(0.1, 0.3, 0.6), borderWidth: 1.5, color: rgb(1, 1, 1) });
  SELLO.forEach((l, i) => hoja.drawText(ansi(l), { x: sx + 10, y: sy + 58 - i * 16, size: i === 0 ? 11 : 9, font: i === 0 ? bold : font, color: rgb(0.1, 0.3, 0.6) }));
  hoja.drawText(ansi(cargo), { x: sx + 10, y: sy + 8, size: 8, font, color: rgb(0.1, 0.3, 0.6) });
  return { pdf: await pdf.save(), huella };
}

// Firma: una firma para los documentos marcados (n = índices; vacío = todos los pendientes).
async function firmar(token, { firmaDataUrl, n = null, notas = {}, ip = '', ua = '' } = {}) {
  const l = await _lote(token);
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(firmaDataUrl || ''));
  if (!m) throw new Error('Falta la firma');
  const png = Buffer.from(m[1], 'base64');
  if (png.length < 800) throw new Error('La firma está vacía: firma con el dedo en el recuadro');
  const idx = (Array.isArray(n) && n.length ? n.map(Number) : l.items.map((_, i) => i)).filter(i => l.items[i] && l.items[i].estado === 'pendiente');
  if (!idx.length) throw new Error('No queda nada por firmar');
  const db = await getDB(); const P = require('./personalDocs');
  const cuando = ahora(); const hechos = [];
  for (const i of idx) {
    const it = l.items[i];
    const d = await P.archivo(it.docId);
    if (!d) continue;
    const original = Buffer.from(d.data.buffer || d.data);
    const { pdf, huella } = await _estampar(original, d.mime, { nombreDoc: d.nombre, firmante: l.nombre, dni: l.dni, cargo: l.cargo, cuando, ip, ua, png, notas: ansi((notas || {})[i] || '').slice(0, 600), ref: String(l._id).slice(-8) + '-' + i });
    const nombre = String(d.nombre || 'documento').replace(/\s*\(SIN FIRMAR\)/i, '').replace(/\.(pdf|jpe?g|png|webp)$/i, '') + ` (firmado por ${l.nombre.split(/\s+/)[0]}).pdf`;
    const g = await P.subir({ ambito: it.ambito, obraId: it.obraId, tipo: it.tipoDestino, archivo: { buffer: Buffer.from(pdf), mimetype: 'application/pdf', originalname: nombre }, fecha: hoyIso(), notas: `Firmado con el dedo por ${l.nombre} (${l.cargo}) el ${cuando}` }, `${l.nombre} (firma por enlace)`);
    await db.collection(COL).updateOne({ _id: l._id }, { $set: { [`items.${i}.estado`]: 'firmado', [`items.${i}.firmadoAt`]: new Date(), [`items.${i}.firmadoId`]: g.id, [`items.${i}.huella`]: huella, [`items.${i}.ip`]: ip } });
    hechos.push(d.nombre);
  }
  await db.collection(COL).updateOne({ _id: l._id }, { $set: { firmaPng: png, ultimaFirma: new Date() } });
  try { await require('./notifications').sendWhatsApp(`✍️ *${l.nombre}* ha firmado ${hechos.length} documento${hechos.length > 1 ? 's' : ''}:\n${hechos.map(h => '• ' + h).join('\n')}${l.obraId ? `\n\nhttps://dashboard.corpprojects.es/docs-obra?obra=${l.obraId}` : ''}`); } catch (e) {}
  return { ok: true, firmados: hechos.length };
}

module.exports = { crear, ver, documento, firmar };
