// test/conciliacion-alias.test.js — Proveedor con nombre comercial distinto de su razón social: en Compras
// «9electric», en el banco «Rachid Ayada Ahriaouil» (y así se llama en StelOrder). El pago casa por la razón social.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/conciliacion.js');

test('el pago a Rachid casa con la factura de «9electric» por su razón social', () => {
  const rec = [
    { id: 'c:1', numero: 'IN2609-0069', refProveedor: 'IN2609-0069', proveedor: '9electric', alias: 'Rachid Ayada Ahriaouil', fecha: '2026-09-09', total: 940.04 },
    { id: 's1', numero: 'FPR00504', refProveedor: 'IN2601-0018', proveedor: 'RACHID AYADA AHRIAOUIL', fecha: '2026-01-20', total: 384.78 },
  ];
  const movs = [{ id: 'm1', fecha: '2026-10-01', importe: -940.04, concepto: 'TRANSFERENCIA A FAVOR DE Rachid Ayada Ahriaouil CONCEPTO: Factura IN2609-0069', codigo: '072' }];
  const f = C.conciliar({ movimientos: movs, emitidas: [], recibidas: rec }).filas[0];
  assert.equal(f.estado, 'punteado'); assert.equal(f.confianza, 'alta'); assert.equal(f.docs[0].ref, 'IN2609-0069');
});

test('sin razón social sigue sin casar con un pago que nombra a otro proveedor', () => {
  const rec = [{ id: 'c:1', numero: 'X1', refProveedor: 'X1', proveedor: 'Davemar', fecha: '2026-09-09', total: 100 }, { id: 's1', numero: 'F1', refProveedor: 'R1', proveedor: 'RUBEN ESTEBAN', fecha: '2026-01-01', total: 50 }];
  const movs = [{ id: 'm1', fecha: '2026-09-20', importe: -100, concepto: 'Transferencia A Favor De Ruben Esteban', codigo: '072' }];
  assert.notEqual(C.conciliar({ movimientos: movs, emitidas: [], recibidas: rec }).filas[0].estado, 'punteado');
});

test('compra con tarjeta devuelta entera: se anula con su devolución (no pide factura)', () => {
  const movs = [
    { id: 'c', fecha: '2026-10-06', importe: -108, concepto: 'Obramat Girona', codigo: '136', origen: 'Revolut …6439' },
    { id: 'd', fecha: '2026-10-07', importe: 108, concepto: 'Refund from Obramat Girona', codigo: '136', origen: 'Revolut …6439' },
    { id: 'e', fecha: '2026-10-06', importe: -114, concepto: 'Obramat Girona', codigo: '136', origen: 'Revolut …6439' },
  ];
  const f = C.conciliar({ movimientos: movs, emitidas: [], recibidas: [] }).filas;
  const by = id => f.find(x => x.id === id);
  assert.equal(by('c').estado, 'no_requiere'); assert.equal(by('c').tipo, 'compra_devuelta');
  assert.equal(by('d').estado, 'no_requiere');
  assert.notEqual(by('e').estado, 'no_requiere');
});
