const test = require('node:test');
const assert = require('node:assert');
const T = require('../src/trimestre');

test('reglas de la gestoría: NIF, comunidades con H, sin IVA y albaranes de Palahí', async () => {
  const stel = {
    getAllOrdinaryInvoices: async () => ({
      1: { date: '2026-10-05', number: 'FAC01', accountId: '1', total: 100, iva: 21 },   // sin NIF
      2: { date: '2026-10-06', number: 'FAC02', accountId: '2', total: 100, iva: 21 },   // nuestro CIF
      3: { date: '2026-10-07', number: 'FAC03', accountId: '3', total: 100, iva: 21 },   // comunidad con B
      4: { date: '2026-10-08', number: 'FAC04', accountId: '4', total: 100, iva: 0 },    // comunidad sin IVA
      5: { date: '2026-10-09', number: 'FAC05', accountId: '5', total: 100, iva: 0 },    // empresa sin IVA, ya con mención
      6: { date: '2026-10-10', number: 'FAC06', accountId: '5', total: 121, iva: 21 },   // bien
      7: { date: '2026-07-10', number: 'FAC07', accountId: '1', total: 121, iva: 21 },   // otro trimestre
    }),
    getClients: async () => ({ clients: [
      { id: 1, 'legal-name': 'CLAUDIA', 'tax-identification-number': 'XXXXXXXX' },
      { id: 2, 'legal-name': 'CTAT PROP RUTLLA, 200-202', 'tax-identification-number': 'B09899253' },
      { id: 3, 'legal-name': 'Comunitat de Propietaris Y', 'tax-identification-number': 'B12345678' },
      { id: 4, 'legal-name': 'Ctat. Prop. Z', 'tax-identification-number': 'H17053380' },
      { id: 5, 'legal-name': 'OMAT S.L', 'tax-identification-number': 'B17396862' },
    ] }),
  };
  const docs = { ispFacturas: [{ id: '5', que: 'ya_lleva' }], compras: [
    { proveedor: 'X. Palahí', numero: '264446', fecha: '2026-10-15', total: 611.26 },
    { proveedor: 'X. Palahí', numero: '85130', fecha: '2026-10-01', total: 50 },
    { proveedor: 'Obramat', numero: 'Pedido 123', fecha: '2026-10-02', total: 20 },
  ] };
  const db = { collection: n => ({ find: () => ({ toArray: async () => docs[n], project: () => ({ toArray: async () => docs[n] }) }) }) };
  const r = await T.reglasGestoria({ from: '2026-10-01', to: '2026-12-31' }, { stel, db });
  const por = Object.fromEntries(r.map(x => [x.ref + x.que.slice(0, 12), x.que]));
  const refs = r.map(x => x.ref).sort();
  assert.deepStrictEqual(refs, ['85130', 'FAC01', 'FAC02', 'FAC03', 'FAC04', 'Pedido 123']);
  assert.ok(r.find(x => x.ref === 'FAC02').que.includes('NUESTRO CIF'));
  assert.ok(r.find(x => x.ref === 'FAC03').que.includes('empieza por H'));
  assert.ok(r.find(x => x.ref === 'FAC04').que.includes('no es empresa'));
  assert.ok(r.find(x => x.ref === '85130').que.includes('Palahí'));
  assert.ok(por);
});
