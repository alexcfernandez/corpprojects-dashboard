// src/efectosProveedor.js — QUÉ FACTURAS PAGA CADA RECIBO (10/10/2026). Saltoki manda por correo la «Renovació
// d'efectes»: los giros de cada factura y abono de unas semanas se juntan en UN recibo (p. ej. «4 148453» de 1.394,51 €
// = 025925 + 027336 + 028801 − 028800). El banco solo dice «Factura N: 4/148453». Se lee el PDF (IA), se guarda en
// `efectosProveedor` y el cuadre casa ese recibo con exactamente esas facturas, aunque StelOrder tenga algún
// importe con céntimos distintos (el abono 028800 es de 39,88 € y en StelOrder pone 39,70).
'use strict';
async function getDB() { return require('./db').getDB(); }
const COL = 'efectosProveedor';
const dig = x => String(x || '').replace(/\D/g, '').replace(/^0+/, '');

const esCorreoEfectos = ({ de = '', asunto = '', adjuntos = [] } = {}) =>
  /saltoki/i.test(de) && /renovaci[oó] d.?efectes|renovaci[oó]n de efectos|regularitzaci/i.test(asunto) && (adjuntos || []).some(a => /pdf/i.test(a.mimeType || '') || /\.pdf$/i.test(a.filename || ''));

const HERR = { name: 'efectos', description: 'Efectos regularizados y el recibo que los sustituye', input_schema: { type: 'object', properties: {
  efectos: { type: 'array', items: { type: 'object', properties: { numero: { type: 'string', description: 'Núm. efecto sin la barra final (p. ej. 025925)' }, emision: { type: 'string', description: 'AAAA-MM-DD' }, importe: { type: 'number', description: 'Importe; NEGATIVO si lleva el signo menos detrás (abono)' } }, required: ['numero', 'importe'] } },
  recibos: { type: 'array', items: { type: 'object', properties: { numero: { type: 'string', description: 'Núm. del efecto que los sustituye, sin barra final (p. ej. «4 148453»)' }, vencimiento: { type: 'string', description: 'AAAA-MM-DD' }, importe: { type: 'number' } }, required: ['numero', 'importe'] } },
}, required: ['efectos', 'recibos'] } };

async function _leer(buf) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) throw new Error('ANTHROPIC_API_KEY no configurada');
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: require('./config').ia.vision, max_tokens: 1500, tools: [HERR], tool_choice: { type: 'tool', name: HERR.name }, messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } },
      { type: 'text', text: 'Es una carta de regularización de efectos de un proveedor. Saca la lista de efectos regularizados (número, emisión, importe; los que llevan «-» detrás son negativos) y el efecto o efectos que los sustituyen (número, vencimiento, importe).' }] }] }) });
  const j = await r.json(); if (!r.ok) throw new Error(`API ${r.status}`);
  const tu = (j.content || []).find(b => b.type === 'tool_use'); return (tu && tu.input) || { efectos: [], recibos: [] };
}

async function desdeCorreo(messageId, adjuntos, { fecha } = {}, { _leer: leer = _leer } = {}) {
  const db = await getDB();
  if (await db.collection(COL).findOne({ gmailId: messageId }, { projection: { _id: 1 } })) return { ya: true };
  const EI = require('./email-intelligence');
  const out = [];
  for (const a of (adjuntos || []).filter(a => /pdf/i.test(a.mimeType || '') || /\.pdf$/i.test(a.filename || ''))) {
    const buf = await EI.getAttachment(messageId, a.attachmentId); if (!buf) continue;
    const x = await leer(buf);
    const efectos = (x.efectos || []).map(e => ({ numero: String(e.numero).trim(), clave: dig(e.numero), emision: e.emision || null, importe: Math.round(Number(e.importe) * 100) / 100 })).filter(e => e.clave);
    for (const rc of x.recibos || []) {
      const doc = { proveedor: 'saltoki', recibo: String(rc.numero).trim(), clave: dig(rc.numero), vencimiento: rc.vencimiento || null, importe: Math.round(Number(rc.importe) * 100) / 100, efectos, gmailId: messageId, fecha: fecha ? new Date(fecha) : new Date(), at: new Date() };
      if (!doc.clave || !efectos.length) continue;
      await db.collection(COL).updateOne({ proveedor: doc.proveedor, clave: doc.clave }, { $set: doc }, { upsert: true });
      out.push({ recibo: doc.recibo, importe: doc.importe, efectos: efectos.length });
    }
  }
  try { require('./trimestre').olvidarMapaPagos(); require('./cuentasProveedor').olvidar(); } catch (e) {}
  return { recibos: out };
}

// Los que ya llegaron (una vez).
async function importarDelCorreo({ meses = 12 } = {}) {
  const EI = require('./email-intelligence'); const gmail = EI.getGmailClient();
  const r = await gmail.users.messages.list({ userId: 'me', q: `from:saltoki.es (renovació OR renovacio OR regularització) has:attachment newer_than:${meses}m`, maxResults: 60 });
  const out = [];
  for (const m of r.data.messages || []) {
    try {
      const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
      const h = Object.fromEntries((msg.data.payload.headers || []).map(x => [x.name.toLowerCase(), x.value]));
      const adj = EI.extractAttachments(msg.data.payload);
      if (!esCorreoEfectos({ de: h.from, asunto: h.subject, adjuntos: adj })) continue;
      out.push({ asunto: h.subject, ...(await desdeCorreo(m.id, adj, { fecha: h.date })) });
    } catch (e) { out.push({ id: m.id, error: e.message }); }
  }
  return out;
}

// Para el cuadre: clave del recibo (solo dígitos) → claves de sus facturas/abonos.
async function mapa() {
  try { const l = await (await getDB()).collection(COL).find({}).toArray(); return new Map(l.map(x => [x.clave, x])); } catch (e) { return new Map(); }
}

module.exports = { esCorreoEfectos, desdeCorreo, importarDelCorreo, mapa, _dig: dig };
