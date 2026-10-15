const test = require('node:test');
const assert = require('node:assert');
const I = require('../src/ispFacturas');

test('decide: sociedad sin mención → añadir; comunidad/particular → revisar; ya la lleva → nada', () => {
  assert.strictEqual(I.decidir({}, 'B17396862', ''), 'anadir');
  assert.strictEqual(I.decidir({}, 'H17053380', ''), 'revisar');
  assert.strictEqual(I.decidir({}, '40318989N', null), 'revisar');
  assert.strictEqual(I.decidir({}, '', ''), 'revisar');
  assert.strictEqual(I.decidir({}, 'B17396862', 'Inversión del sujeto pasivo, art. 84.Uno.2º.f LIVA'), 'ya_lleva');
});

test('revisar: añade la mención a la de la empresa, avisa de la comunidad y no repite', async () => {
  const puts = [], vistos = new Map(), msgs = [];
  const raw = { '1': { id: 1, comments: 'Obra X', lines: [{ a: 1 }] }, '2': { id: 2, comments: '' }, '3': { id: 3, comments: '' } };
  const stel = {
    getAllOrdinaryInvoices: async () => ({
      '1': { date: '2026-10-20T00:00:00+0000', number: 'FAC01001', accountId: '10', total: 1000, iva: 0 },
      '2': { date: '2026-10-21T00:00:00+0000', number: 'FAC01002', accountId: '20', total: 500, iva: 0 },
      '3': { date: '2026-09-20T00:00:00+0000', number: 'FAC00999', accountId: '10', total: 800, iva: 0 }, // trimestre cerrado
      '4': { date: '2026-10-22T00:00:00+0000', number: 'FAC01003', accountId: '10', total: 121, iva: 21 },
    }),
    getClients: async () => ({ clients: [{ id: 10, 'legal-name': 'OMAT S.L', 'tax-identification-number': 'B17396862' }, { id: 20, 'legal-name': 'Ctat. Prop. X', 'tax-identification-number': 'H17053380' }] }),
    invalidate() {},
    _client: { get: async u => ({ data: [raw[u.split('/').pop()]] }), put: async (u, b) => { puts.push([u, b]); return { data: b }; } },
  };
  const db = { collection: () => ({
    find: q => ({ project: () => ({ toArray: async () => q.id.$in.filter(id => vistos.has(id)).map(id => ({ id })) }) }),
    updateOne: async (q, u) => { vistos.set(q.id, u.$set); },
  }) };
  process.env.WHATSAPP_TO = '34600000000';
  const r = await I.revisar({ _d: { stel, db, enviar: async (to, t) => msgs.push(t) } });
  assert.strictEqual(r.revisadas, 2);
  assert.deepStrictEqual(r.anadidas.map(x => x.numero), ['FAC01001']);
  assert.deepStrictEqual(r.revisar.map(x => x.numero), ['FAC01002']);
  assert.strictEqual(puts.length, 1);
  assert.match(puts[0][1].comments, /^Obra X\n\nOperación con inversión del sujeto pasivo/);
  assert.deepStrictEqual(puts[0][1].lines, [{ a: 1 }]);
  assert.strictEqual(msgs.length, 1);
  const r2 = await I.revisar({ _d: { stel, db, enviar: async (to, t) => msgs.push(t) } });
  assert.strictEqual(r2.revisadas, 0);
  assert.strictEqual(puts.length, 1);
});
