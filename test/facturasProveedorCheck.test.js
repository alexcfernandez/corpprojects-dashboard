'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/facturasProveedorCheck');

test('detecta el «descontar paga y señal» en positivo y el total doble (FPR00968)', () => {
  const f = { number: 'FPR00968', supplier: 'WERKHAUS S.L ', total: 920.23, extraReference: '1/804/10/32843', lines: [
    { 'line-type': 'ITEM', 'item-name': '22589309 DESCONTAR PAGA Y SEÑ', 'total-amount': 380.26 },
    { 'line-type': 'ITEM', 'item-name': 'MORTERO M-7,5', 'total-amount': 84.48 },
  ] };
  const ps = P.problemas(f, [{ proveedor: 'Bauhaus', numero: '1/804/10/32843', total: 460.11 }]);
  assert.strictEqual(ps.length, 2);
  assert.match(ps[0].que, /debería RESTAR/);
  assert.match(ps[1].que, /DOBLE/);
});

test('no avisa de lo que está bien', () => {
  // Factura de anticipo («paga y señal» en positivo), palet retornable, abono con descuento y proveedor distinto con nº parecido.
  assert.deepStrictEqual(P.problemas({ supplier: 'WERKHAUS', total: 553.45, lines: [{ 'item-name': 'PAGA Y SEÑAL', 'total-amount': 553.45 }] }), []);
  assert.deepStrictEqual(P.problemas({ supplier: 'OBRAMAT', total: 1939, lines: [{ 'item-name': 'COSTE PALET RETORNABLE', 'total-amount': 10 }] }), []);
  assert.deepStrictEqual(P.problemas({ supplier: 'Weber', total: -2000, lines: [{ 'item-name': 'DESCUENTO', 'total-amount': 10 }] }), []);
  assert.deepStrictEqual(P.problemas({ supplier: 'X-PALAHÍ, SL', total: 575.52, extraReference: '261525', lines: [] }, [{ proveedor: 'Yattabare Makan', numero: '26-15', total: 493 }]), []);
  assert.strictEqual(P.provKey('BRICOLAJE BRICOMAN, S.L.U.'), P.provKey('Obramat'));
});
