// src/facturaWhatsApp.js — Foto/PDF de factura → reenvío al buzón que vigila n8n
// (que ya la sube a StelOrder). NO reimplementa la lógica de facturas.
//
// Dos orígenes, un solo camino:
//   · WhatsApp: la palabra "factura" en el pie del mensaje + hay adjunto (foto/PDF).
//   · App de oficina (public/subir-factura.html): foto(s)/PDF + obra elegida.
// El dashboard baja/recibe el media, monta el/los adjunto(s) y los reenvía por
// email a INVOICE_INBOX_EMAIL. Si viene una obra, va en el asunto para que n8n
// la pueda leer y etiquetar la factura por obra (rentabilidad real por obra).

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

// ── Núcleo reutilizable: monta el email y lo reenvía al buzón de n8n ────────────
// Acepta adjuntos YA preparados ([{filename, content:Buffer, contentType}]) y,
// opcionalmente, una obra. Registra en Mongo (colección `facturasObra`) para dar
// atribución por obra en el dashboard aunque StelOrder aún no tenga el proyecto.
//   obraRef: texto de la obra (p.ej. "Calle Mayor 12 - Fachada") o null.
//   origen : 'whatsapp' | 'app-oficina'.
// Devuelve {ok, reply}.
async function reenviarFacturaMail({ attachments, obraRef = null, obraId = null, origen = 'whatsapp', from = null, nota = null }) {
  const to = process.env.INVOICE_INBOX_EMAIL || 'corpprojectsholding@gmail.com';
  if (!attachments || !attachments.length) {
    return { ok: false, reply: 'No he podido leer el adjunto de la factura. Inténtalo de nuevo.' };
  }

  const obra = (obraRef && String(obraRef).trim()) ? String(obraRef).trim() : null;
  const subject = obra
    ? `Factura — obra: ${obra}`
    : (origen === 'whatsapp' ? 'Factura (WhatsApp)' : 'Factura (oficina)');

  const partesTexto = [
    `Factura reenviada (${origen}).`,
    obra ? `Obra: ${obra}.` : null,
    (nota && String(nota).trim()) ? `Nota: ${String(nota).trim()}.` : null,
    `${attachments.length} adjunto(s).`,
    from ? `Origen: ${from}.` : null,
  ].filter(Boolean);

  let ok = false;
  try {
    ok = await require('./notifications').sendEmail({ to, subject, text: partesTexto.join(' '), attachments });
  } catch (e) { console.error('[Factura] sendEmail:', e.message); }

  // Trazabilidad + atribución por obra (best-effort; no rompe el flujo si falla).
  try {
    const db = await require('./db').getDB();
    await db.collection('facturasObra').insertOne({
      obraId:    obraId || null,
      obraRef:   obra,
      origen,
      from:      from || null,
      nFiles:    attachments.length,
      filenames: attachments.map(a => a.filename),
      nota:      (nota && String(nota).trim()) ? String(nota).trim() : null,
      ts:        new Date(),
      emailOk:   !!ok,
    });
  } catch (e) { /* trazabilidad best-effort */ }

  const reply = ok
    ? (obra
        ? `📎 Recibida — obra: ${obra}. La subo a StelOrder.`
        : '📎 Recibida — la mando a StelOrder. En un momento estará subida.')
    : 'No he podido reenviarla ahora, inténtalo de nuevo.';
  return { ok: !!ok, reply };
}

// ── WhatsApp: baja los adjuntos de Twilio, los monta y delega en reenviarFacturaMail ──
// Wrapper del camino de WhatsApp. Comportamiento intacto: sin obra (obraRef=null).
async function reenviarFactura({ from, pdf, fotos, descargarArchivo, descargarFoto }) {
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

  return reenviarFacturaMail({ attachments, obraRef: null, origen: 'whatsapp', from });
}

module.exports = { esReenvioFactura, reenviarFactura, reenviarFacturaMail, fotosAPdf };
