// test/movimientos-cuadre.test.js — Cada cobro/pago con sus facturas: cuadrado, a medias o sin cuadrar.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _cuadre: cuadre } = require('../src/movimientosCuadre');

test('cobro de una factura: cuadrado', () => {
  const r = cuadre({ importe: 3400 }, { estado: 'punteado', docs: [{ ref: 'FAC00975', tercero: 'CP Figueres 1', total: 3400 }] });
  assert.equal(r.estado, 'cuadrado'); assert.equal(r.texto, 'FAC00975');
});
test('pago a Prefer: 3 facturas + 1 abono que suman lo pagado', () => {
  const r = cuadre({ importe: -5190 }, { estado: 'punteado', docs: [{ ref: 'F1', total: 2000 }, { ref: 'F2', total: 1850.49 }, { ref: 'F3', total: 1500 }, { ref: 'AB1', total: -160.49 }] });
  assert.equal(r.estado, 'cuadrado'); assert.equal(r.texto, '3 facturas + 1 abono'); assert.equal(r.suma, 5190);
});
test('cobro parcial: faltan 500 €', () => {
  const r = cuadre({ importe: 2000 }, { estado: 'punteado', docs: [{ ref: 'FAC00990', total: 2500 }] });
  assert.equal(r.estado, 'parcial'); assert.match(r.nota, /Faltan 500,00 €/);
});
test('nómina: no necesita factura; transferencia desconocida: sin cuadrar', () => {
  assert.equal(cuadre({ importe: -1500 }, { estado: 'no_requiere', nota: 'Nómina' }).estado, 'no_requiere');
  assert.equal(cuadre({ importe: 800 }, { estado: 'revisar', nota: 'Puede ser FAC1, FAC2' }).texto, 'Puede ser FAC1, FAC2');
  assert.equal(cuadre({ importe: 800 }, null).estado, 'sin_datos');
});

test('cobro que completa facturas ya cobradas en parte antes: cuadrado, «con otro pago»', () => {
  const porDoc = new Map([['FAC00873', [{ movId: 'antes', importe: 35000 }]], ['FAC00986', []]]);
  const r = cuadre({ id: 'hoy', importe: 39688.9 }, { estado: 'punteado', docs: [{ ref: 'FAC00986', total: 26656.99 }, { ref: 'FAC00873', total: 48031.91 }] }, porDoc);
  assert.equal(r.estado, 'cuadrado'); assert.match(r.nota, /con otro pago de 35\.000,00 €/);
});
