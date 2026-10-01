// test/remesas.test.js — recibos que pagan varias facturas (Oliveras, Saltoki…) y lectura de importes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { conciliar } = require('../src/conciliacion');
const { n2, nCant } = require('../src/compras');

const mov = (id, fecha, importe, concepto) => ({ id, fecha, importe, concepto });
const fac = (id, proveedor, fecha, total, refProveedor = id, extra = {}) => ({ id, numero: 'FPR' + id, proveedor, fecha, total, refProveedor, ...extra });

test('Saltoki: factura + abono de la semana que cita el recibo (Fecha Factura)', () => {
  const r = conciliar({ emitidas: [], movimientos: [mov('m1', '2026-09-25', -740.35, 'Recibo Saltoki Girona S.a., Concepto: Factura N: 4/151666 Fecha Factura: 24/08/2026 Vto.: 001')],
    recibidas: [fac('1', 'Saltoki girona S.A', '2026-08-22', 1015.37), fac('2', 'Saltoki girona S.A', '2026-08-22', -275.02), fac('3', 'Saltoki girona S.A', '2026-07-10', 740.35)] });
  const f = r.filas[0];
  assert.equal(f.estado, 'punteado');
  assert.deepEqual(f.docs.map(d => d.refProveedor).sort(), ['1', '2']);   // no la de julio por el mismo importe
});

test('Oliveras: remesa con dos facturas seguidas', () => {
  const r = conciliar({ emitidas: [], movimientos: [mov('m1', '2026-08-25', -181.29, 'Recibo Oliveras Derivats I Materials, S.l.u Nº Recibo 0049 Ref. Mandato 905366')],
    recibidas: [fac('a', 'OLIVERAS DERIVATS I MATERIALS, SLU', '2026-07-20', 156.71), fac('b', 'OLIVERAS DERIVATS I MATERIALS, SLU', '2026-07-31', 24.58)] });
  assert.equal(r.filas[0].estado, 'punteado');
  assert.equal(r.filas[0].docs.length, 2);
});

test('Sin cuadre: dice cuánto falta y deja las candidatas para elegir', () => {
  const r = conciliar({ emitidas: [], movimientos: [mov('m1', '2026-09-25', -2850.83, 'Recibo Oliveras Derivats I Materials, S.l.u Nº Recibo 0049')],
    recibidas: [fac('a', 'OLIVERAS DERIVATS I MATERIALS, SLU', '2026-08-20', 1295.93), fac('b', 'OLIVERAS DERIVATS I MATERIALS, SLU', '2026-09-10', 328.56)] });
  const f = r.filas[0];
  assert.notEqual(f.estado, 'punteado');
  assert.match(f.nota, /faltan facturas por 1226\.34/);
  assert.equal(f.candidatas.length, 2);
});

test('No mezcla proveedores que comparten palabra (Pintures Sant Narcis / Pintures Vic)', () => {
  const r = conciliar({ emitidas: [], movimientos: [mov('m1', '2026-04-27', -122.93, 'Recibo Pintures Sant Narcis S.l. Nº Recibo 0049')],
    recibidas: [fac('a', 'Pintures Sant Narcis', '2026-04-01', 76.79), fac('b', 'Pintures Vic', '2026-04-20', 46.14)] });
  assert.notEqual(r.filas[0].estado, 'punteado');
});

test('Las ya pagadas según StelOrder no entran en la combinación', () => {
  const r = conciliar({ emitidas: [], movimientos: [mov('m1', '2026-08-25', -181.29, 'Recibo Oliveras Derivats I Materials')],
    recibidas: [fac('a', 'OLIVERAS DERIVATS I MATERIALS, SLU', '2026-07-20', 156.71, 'a', { pendienteStel: 0 }), fac('b', 'OLIVERAS DERIVATS I MATERIALS, SLU', '2026-07-31', 24.58)] });
  assert.notEqual(r.filas[0].estado, 'punteado');
});

test('Elegidas a mano: punteado manual con sus facturas y lo que falta', () => {
  const m = mov('m1', '2026-09-25', -2850.83, 'Recibo Oliveras');
  m.manual = { decision: 'facturas', total: 2024.27, recibidas: [{ id: 'a', ref: 'FPR1', tercero: 'OLIVERAS', total: 1295.93 }, { id: 'b', ref: 'FPR2', tercero: 'OLIVERAS', total: 728.34 }] };
  const r = conciliar({ emitidas: [], movimientos: [m], recibidas: [fac('a', 'OLIVERAS', '2026-08-20', 1295.93)] });
  assert.equal(r.filas[0].estado, 'punteado');
  assert.equal(r.filas[0].confianza, 'manual');
  assert.match(r.filas[0].nota, /faltan 826\.56/);
  assert.ok(r.recibidasUsadas.has('a'));
});

test('Importes del formulario de Compras: punto decimal, coma decimal y miles', () => {
  assert.equal(n2('399.78'), 399.78);   // antes se guardaba 39978
  assert.equal(n2('330.4'), 330.4);
  assert.equal(n2('1.234,56'), 1234.56);
  assert.equal(n2('399,78'), 399.78);
  assert.equal(n2('12.500'), 12500);
  assert.equal(n2('-48.29'), -48.29);
  assert.equal(n2(''), null);
  assert.equal(nCant('1.250'), 1.25);
  assert.equal(nCant('0,5'), 0.5);
});

test('Comida de trabajo (dieta): no necesita factura y dice quién comió', () => {
  const m = mov('m1', '2026-09-01', -40.96, 'Muriel');
  m.manual = { decision: 'dieta', personas: ['Manolo', 'David'], obraRef: 'Alella' };
  const f = conciliar({ emitidas: [], recibidas: [], movimientos: [m] }).filas[0];
  assert.equal(f.estado, 'no_requiere');
  assert.equal(f.tipo, 'dieta');
  assert.match(f.nota, /Manolo, David · Alella/);
});
