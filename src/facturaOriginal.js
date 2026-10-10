// src/facturaOriginal.js — LA FACTURA ORIGINAL DEL PROVEEDOR (10/10/2026). El PDF de StelOrder de una factura recibida
// es el documento que genera StelOrder (con nuestro FPR), no el del proveedor. El original llegó por correo (de ahí la
// subió n8n a StelOrder): se busca en Gmail por su número (Gmail lee también el texto de los PDF adjuntos), se trae a
// Compras («archivo», sin avisos) y se abre desde allí. La próxima vez ya está en Compras.
'use strict';
const dig = x => String(x || '').replace(/\D/g, '');
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

async function _compraDe(db, ref, total) {
  const d = dig(ref);
  if (d.length < 4) return null;
  const cs = await db.collection('compras').find({ estado: { $ne: 'descartada' }, numero: { $ne: null } }).project({ numero: 1, total: 1 }).toArray();
  const c = cs.find(x => { const dc = dig(x.numero); return dc && (dc === d || (Math.min(dc.length, d.length) >= 5 && (dc.endsWith(d) || d.endsWith(dc)))) && (total == null || x.total == null || Math.abs(Math.abs(x.total) - Math.abs(total)) < 0.05); });
  return c ? String(c._id) : null;
}

async function buscar({ ref, proveedor = '', total = null } = {}) {
  ref = String(ref || '').trim();
  if (dig(ref).length < 4) throw new Error('Sin número de factura del proveedor no lo puedo buscar');
  const db = await require('./db').getDB();
  const ya = await _compraDe(db, ref, total);
  if (ya) return { compraId: ya, ya: true };
  const EI = require('./email-intelligence');
  const gmail = EI.getGmailClient();
  // Primero el número tal cual; si no, solo su parte numérica larga (los proveedores lo escriben distinto).
  // (también sin ceros delante y con punto de miles, como Saltoki: «Factura nº 30.629» y «30629.pdf»).
  const sinCeros = dig(ref).replace(/^0+/, ''), conPunto = sinCeros.length > 3 ? sinCeros.slice(0, -3) + '.' + sinCeros.slice(-3) : null;
  const consultas = [...new Set([`"${ref.replace(/"/g, '')}" has:attachment`, ...(dig(ref).length >= 5 && dig(ref) !== ref ? [`"${dig(ref)}" has:attachment`] : []),
    ...(sinCeros.length >= 4 && sinCeros !== ref ? [`"${sinCeros}" has:attachment`] : []), ...(conPunto ? [`"${conPunto}" has:attachment`] : [])])];
  const vistos = new Set();
  for (const q of consultas) {
    const r = await gmail.users.messages.list({ userId: 'me', q, maxResults: 6 });
    for (const m of r.data.messages || []) {
      if (vistos.has(m.id)) continue; vistos.add(m.id);
      const prev = await db.collection('compras').findOne({ gmailId: m.id, estado: { $ne: 'descartada' } }, { projection: { _id: 1, numero: 1 } });
      if (prev && dig(prev.numero) && (dig(prev.numero).endsWith(dig(ref)) || dig(ref).endsWith(dig(prev.numero)))) return { compraId: String(prev._id), ya: true };
      const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
      const h = Object.fromEntries((msg.data.payload.headers || []).map(x => [x.name.toLowerCase(), x.value]));
      if (/corpprojects|corp projects/i.test(h.from || '') && !norm(h.from).includes(norm(proveedor).split(' ')[0] || '~')) continue;   // los que mandamos nosotros
      const adj = EI.extractAttachments(msg.data.payload).filter(a => /pdf|image\//i.test(a.mimeType || '') || /\.(pdf|jpe?g|png)$/i.test(a.filename || ''));
      if (!adj.length) continue;
      const ids = await EI.comprasDesdeCorreo(m.id, adj, { de: h.from || '', asunto: h.subject || '', fecha: h.date ? new Date(h.date) : new Date() }, { estadoInicial: 'archivo', silencioso: true });
      const c = await _compraDe(db, ref, total);
      if (c) { try { require('./trimestre').olvidarMapaPagos(); require('./cuentasProveedor').olvidar(); } catch (e) {} return { compraId: c, deCorreo: h.subject || '' }; }
      // Leído pero con otro número: se deja en archivo (sirve igual para el cuadre) y se sigue buscando.
      void ids;
    }
  }
  return { compraId: null };
}

module.exports = { buscar };
