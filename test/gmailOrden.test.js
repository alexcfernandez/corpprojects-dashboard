// Bandeja de entrada limpia: los automáticos van a «Corp/Automáticos» sin romper n8n (3/11/2026).
const test = require('node:test');
const assert = require('node:assert');
const G = require('../src/gmailOrden');

const AHORA = Date.parse('2026-11-03T22:00:00Z');
const hace = min => String(AHORA - min * 60 * 1000);
function fakeGmail(msgs) {
  const llamadas = { modify: [], creadas: [] };
  const gmail = { users: {
    labels: {
      list: async () => ({ data: { labels: [] } }),
      create: async ({ requestBody }) => { llamadas.creadas.push(requestBody.name); return { data: { id: 'L1' } }; },
    },
    messages: {
      // El fake devuelve todo lo de la bandeja: el módulo debe filtrar por asunto, edad y etiqueta INBOX.
      list: async () => ({ data: { messages: msgs.map(m => ({ id: m.id })) } }),
      get: async ({ id }) => { const m = msgs.find(x => x.id === id); return { data: { internalDate: m.fecha, labelIds: m.labels, payload: { headers: [{ name: 'Subject', value: m.asunto }] } } }; },
      batchModify: async ({ requestBody }) => { llamadas.modify.push(requestBody); return {}; },
    },
  } };
  return { gmail, llamadas };
}

test('mueve las facturas reenviadas (a las 2 h) y los resúmenes, los marca leídos y deja lo demás', async () => {
  const { gmail, llamadas } = fakeGmail([
    { id: 'a', asunto: 'Factura — obra: Bar Claudia', fecha: hace(150), labels: ['INBOX', 'UNREAD'] }, // n8n ya no marca leído
    { id: 'b', asunto: 'Factura — gasto: gestoria', fecha: hace(150), labels: ['INBOX'] },
    { id: 'c', asunto: 'Grupos de clientes · 2 nuevas, 5 abiertas', fecha: hace(30), labels: ['INBOX', 'UNREAD'] },
    { id: 'd', asunto: 'Fwd: presupuesto Joan', fecha: hace(600), labels: ['INBOX'] },             // manual: se queda
    { id: 'e', asunto: 'Factura — obra: Cartagena', fecha: hace(60), labels: ['INBOX'] },          // menos de 2 h: n8n
  ]);
  const r = await G.ordenar({ _gmail: gmail, _ahora: AHORA });
  assert.strictEqual(r.movidos, 3);
  assert.deepStrictEqual(llamadas.creadas, ['Corp/Automáticos']);
  assert.deepStrictEqual(llamadas.modify[0].ids.sort(), ['a', 'b', 'c']);
  assert.deepStrictEqual(llamadas.modify[0].removeLabelIds, ['INBOX', 'UNREAD']);
});

test('en seco no mueve nada y el interruptor lo apaga', async () => {
  const { gmail, llamadas } = fakeGmail([{ id: 'a', asunto: 'Factura (WhatsApp)', fecha: hace(150), labels: ['INBOX'] }]);
  const r = await G.ordenar({ seco: true, _gmail: gmail, _ahora: AHORA });
  assert.strictEqual(r.movidos, 1);
  assert.strictEqual(llamadas.modify.length, 0);
  process.env.GMAIL_ORDEN = 'off';
  try { assert.strictEqual((await G.ordenar({ _gmail: gmail, _ahora: AHORA })).apagado, true); }
  finally { delete process.env.GMAIL_ORDEN; }
});
