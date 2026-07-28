// src/facturaWhatsApp.js — Foto/PDF de factura por WhatsApp → reenvío al buzón que
// vigila n8n (que ya la sube a StelOrder). NO reimplementa la lógica de facturas.
//
// Disparador: la palabra "factura" en el pie del mensaje + hay adjunto (foto/PDF).
// Sin la palabra, NO se asume (lo gestiona el flujo normal de imagen). El dashboard
// baja el media de Twilio y lo reenvía por email con el/los adjunto(s).

// ¿El texto pide reenviar una factura? (la palabra "factura" enruta a este camino)
function esReenvioFactura(texto) {
  const n = String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return /\bfactura(s)?\b/.test(n);
}

// Convierte una o varias imágenes (jpg/png) en UN PDF (una foto por página →
// factura multipágina en un solo archivo). pdf-lib es JS puro (va en Railway).
// Devuelve un Buffer PDF, o null si no se pudo embeber ninguna imagen.
async function fotosAPdf(imagenes) {
  const { PDFDocument } = require('pdf-lib');
  const pdf = await PDFDocument.create();
  for (const img of (imagenes || [])) {
    try {
      const bytes = Buffer.from(img.data, 'base64');
      const emb = /png/i.test(img.media_type || '') ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      const page = pdf.addPage([emb.width, emb.height]);
      page.drawImage(emb, { x: 0, y: 0, width: emb.width, height: emb.height });
    } catch (e) { console.error('[FacturaWA] embed imagen:', e.message); }
  }
  if (pdf.getPageCount() === 0) return null;
  return Buffer.from(await pdf.save());
}

// Baja los adjuntos (con las funciones de descarga de Twilio inyectadas), reenvía
// al INVOICE_INBOX_EMAIL y registra en `facturasWhatsApp`. Devuelve {ok, reply}.
async function reenviarFactura({ from, pdf, fotos, descargarArchivo, descargarFoto }) {
  const to = process.env.INVOICE_INBOX_EMAIL || 'corpprojectsholding@gmail.com';
  const attachments = [];
  try {
    // Un PDF ya viene en formato correcto → se reenvía tal cual.
    if (pdf && pdf.url) {
      const b64 = await descargarArchivo(pdf.url);
      if (b64) attachments.push({ filename: 'factura.pdf', content: Buffer.from(b64, 'base64'), contentType: 'application/pdf' });
    }
    // Las fotos (jpg/png) se embeben en UN solo PDF (una por página).
    const imgs = [];
    for (const f of (fotos || [])) {
      const img = await descargarFoto(f.url, f.type);
      if (img && img.data) imgs.push(img);
    }
    if (imgs.length) {
      const pdfBuf = await fotosAPdf(imgs);
      if (pdfBuf && pdfBuf.length) {
        const nombre = attachments.some(a => a.filename === 'factura.pdf') ? 'factura-fotos.pdf' : 'factura.pdf';
        attachments.push({ filename: nombre, content: pdfBuf, contentType: 'application/pdf' });
      } else {
        // Fallback: si no se pudo generar el PDF, adjuntar las imágenes crudas (no perder la factura).
        let i = 0;
        for (const img of imgs) {
          const ext = (String(img.media_type || 'image/jpeg').split('/')[1] || 'jpg');
          attachments.push({ filename: `factura-${++i}.${ext}`, content: Buffer.from(img.data, 'base64'), contentType: img.media_type });
        }
      }
    }
  } catch (e) { console.error('[FacturaWA] preparar adjuntos:', e.message); }

  if (!attachments.length) return { ok: false, reply: 'No he podido leer el adjunto de la factura. Inténtalo de nuevo.' };

  let ok = false;
  try {
    ok = await require('./notifications').sendEmail({
      to,
      subject: 'Factura (WhatsApp)',
      text: `Factura reenviada desde WhatsApp (${from}). ${attachments.length} adjunto(s).`,
      attachments,
    });
  } catch (e) { console.error('[FacturaWA] sendEmail:', e.message); }

  try {
    const db = await require('./db').getDB();
    await db.collection('facturasWhatsApp').insertOne({ from, ts: new Date(), nAdjuntos: attachments.length, to, ok: !!ok });
  } catch (e) { /* trazabilidad best-effort */ }

  return { ok: !!ok, reply: ok ? '📎 Recibida — la mando a StelOrder. En un momento estará subida.' : 'No he podido reenviarla ahora, inténtalo de nuevo.' };
}

module.exports = { esReenvioFactura, reenviarFactura };
