// src/gmailOrden.js — Bandeja de entrada limpia (Álex, 3/11/2026: «se nos llena de facturas reenviadas; que pasen a otro
// lado con una etiqueta, los automáticos»).
//   · Los correos que el dashboard se manda a sí mismo («Factura — obra: …», «Factura — gasto: …», «Factura (WhatsApp)»,
//     «Factura (oficina)» hacia INVOICE_INBOX_EMAIL, y el resumen «Grupos de clientes · …») salen de INBOX y quedan con la
//     etiqueta «Corp/Automáticos» y se marcan leídos (son nuestros: que no cuenten como correo por leer).
//   · OJO n8n: «Classificador facturas Corp» lee por IMAP solo lo que está en INBOX. Por eso NO es un filtro de Gmail:
//     las facturas reenviadas se mueven a las 2 horas, cuando n8n ya las ha cogido. Desde el 6/11/2026 n8n ya NO las marca
//     leídas (su opción «Action» está en «Nothing», porque marcaba leído TODO el correo), así que no se puede esperar a eso.
//   · Cada 10 minutos (scheduler). Se apaga con GMAIL_ORDEN=off.
'use strict';
const ETIQUETA = 'Corp/Automáticos';
const NOSOTROS = '(hola@corpprojects.es OR corpprojectsholding@gmail.com)';
// Lo que va a n8n (facturas reenviadas): a las 2 horas.
const Q_FACTURAS = `in:inbox from:${NOSOTROS} subject:("Factura — obra" OR "Factura — gasto" OR "Factura (WhatsApp)" OR "Factura (oficina)")`;
// Avisos que solo son para leer (no los procesa nadie).
const Q_AVISOS = `in:inbox from:${NOSOTROS} subject:("Grupos de clientes")`;
// Gmail busca por palabras: se confirma el asunto exacto antes de mover nada.
const ASUNTOS = [/^Factura — obra: /, /^Factura — gasto: /, /^Factura \((WhatsApp|oficina)\)$/, /^Grupos de clientes · /];
const MIN_EDAD = 20 * 60 * 1000, MIN_EDAD_FACTURA = 2 * 60 * 60 * 1000;

let _etiquetaId = null;
async function etiqueta(gmail) {
  if (_etiquetaId) return _etiquetaId;
  const l = await gmail.users.labels.list({ userId: 'me' });
  const ya = (l.data.labels || []).find(x => x.name === ETIQUETA);
  if (ya) return (_etiquetaId = ya.id);
  const c = await gmail.users.labels.create({ userId: 'me', requestBody: { name: ETIQUETA, labelListVisibility: 'labelShow', messageListVisibility: 'show' } });
  return (_etiquetaId = c.data.id);
}

async function listar(gmail, q, max = 300) {
  const out = []; let pageToken;
  do {
    const r = await gmail.users.messages.list({ userId: 'me', q, maxResults: 100, pageToken });
    out.push(...(r.data.messages || [])); pageToken = r.data.nextPageToken;
  } while (pageToken && out.length < max);
  return out.slice(0, max);
}

// Devuelve {movidos, asuntos} (en seco no mueve nada).
async function ordenar({ seco = false, _gmail = null, _ahora = Date.now() } = {}) {
  if (process.env.GMAIL_ORDEN === 'off') return { movidos: 0, asuntos: [], apagado: true };
  const gmail = _gmail || require('./email-intelligence').getGmailClient();
  const candidatos = [
    ...(await listar(gmail, Q_FACTURAS)),
    ...(await listar(gmail, Q_AVISOS)),
  ];
  const vistos = new Set(), mover = [], asuntos = [];
  for (const m of candidatos) {
    if (vistos.has(m.id)) continue; vistos.add(m.id);
    const d = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['Subject'] });
    const asunto = ((d.data.payload && d.data.payload.headers) || []).find(h => h.name === 'Subject')?.value || '';
    if (!ASUNTOS.some(r => r.test(asunto))) continue;
    const edad = /^Factura/.test(asunto) ? MIN_EDAD_FACTURA : MIN_EDAD;
    if (_ahora - Number(d.data.internalDate || 0) < edad) continue;        // que n8n tenga tiempo
    if (!(d.data.labelIds || []).includes('INBOX')) continue;
    mover.push(m.id); asuntos.push(asunto);
  }
  if (!seco && mover.length) {
    const id = await etiqueta(gmail);
    for (let i = 0; i < mover.length; i += 500) {
      await gmail.users.messages.batchModify({ userId: 'me', requestBody: { ids: mover.slice(i, i + 500), addLabelIds: [id], removeLabelIds: ['INBOX', 'UNREAD'] } });
    }
  }
  return { movidos: mover.length, asuntos };
}

module.exports = { ordenar, ETIQUETA, ASUNTOS };
