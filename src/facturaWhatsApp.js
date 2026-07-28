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

// Baja los adjuntos (con las funciones de descarga de Twilio inyectadas), reenvía
// al INVOICE_INBOX_EMAIL y registra en `facturasWhatsApp`. Devuelve {ok, reply}.
async function reenviarFactura({ from, pdf, fotos, descargarArchivo, descargarFoto }) {
  const to = process.env.INVOICE_INBOX_EMAIL || 'corpprojectsholding@gmail.com';
  const attachments = [];
  try {
    if (pdf && pdf.url) {
      const b64 = await descargarArchivo(pdf.url);
      if (b64) attachments.push({ filename: 'factura.pdf', content: Buffer.from(b64, 'base64'), contentType: 'application/pdf' });
    }
    let i = 0;
    for (const f of (fotos || [])) {
      const img = await descargarFoto(f.url, f.type);
      if (img && img.data) {
        const ext = (String(img.media_type || 'image/jpeg').split('/')[1] || 'jpg');
        attachments.push({ filename: `factura-${++i}.${ext}`, content: Buffer.from(img.data, 'base64'), contentType: img.media_type });
      }
    }
  } catch (e) { console.error('[FacturaWA] descarga:', e.message); }

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
