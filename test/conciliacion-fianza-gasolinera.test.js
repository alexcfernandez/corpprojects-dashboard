// test/conciliacion-fianza-gasolinera.test.js — Loxam (alquiler + fianza que devuelven) y la factura mensual de la
// gasolinera pagada en el surtidor con más repostajes de los que salen en la factura.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/conciliacion.js');
const CP = require('../src/cuentasProveedor.js');

test('Loxam: pago − fianza devuelta = factura; la devolución no cuenta como pago', () => {
  const rec = [{ id: 's1', numero: 'FPR00853', refProveedor: 'FPRAL2607-00404', proveedor: 'LOXAM ALQUILER DE MAQUINARIA S.L.U.', fecha: '2026-07-07', total: 37.61 },
    { id: 's2', numero: 'FPR00890', refProveedor: 'FPRAL2608-03395', proveedor: 'LOXAM ALQUILER DE MAQUINARIA S.L.U.', fecha: '2026-08-24', total: 36.25 }];
  const movs = [
    { id: 'p1', fecha: '2026-07-03', importe: -187.61, concepto: 'Transferencia A Favor De Loxam Hune Concepto: Pago Factura', codigo: '072' },
    { id: 'd1', fecha: '2026-07-10', importe: 150, concepto: 'Transferencia Inmediata De Loxam Alquiler De Maquinaria S.l.u, Concepto Emp8e49 Devolucion A Clientes', codigo: '073' },
    { id: 'p2', fecha: '2026-08-19', importe: -186.25, concepto: 'Loxam Girona', origen: 'Revolut …6439', fijo: { tipo: 'pago_tarjeta' } },
    { id: 'd2', fecha: '2026-08-24', importe: 150, concepto: 'Refund from Loxam Girona', origen: 'Revolut …6439' },
  ];
  const f = C.conciliar({ movimientos: movs, emitidas: [], recibidas: rec }).filas;
  const by = id => f.find(x => x.id === id);
  assert.equal(by('p1').estado, 'punteado'); assert.equal(by('p1').docs[0].ref, 'FPR00853'); assert.match(by('p1').nota, /fianza devuelta 150\.00/);
  assert.equal(by('d1').tipo, 'fianza_devuelta'); assert.equal(by('d1').docs.length, 0);
  assert.equal(by('p2').estado, 'punteado'); assert.equal(by('p2').docs[0].ref, 'FPR00890');
});

test('gasolinera: factura del mes pagada en el surtidor aunque con tarjeta se pagara más', () => {
  const rec = [{ id: 's3', numero: 'FPR00876', refProveedor: 'B113360', proveedor: 'FEIXAS AULET, S.A.', fecha: '2026-07-31', total: 154.99 }];
  const t = (id, fecha, imp) => ({ id, fecha, importe: imp, concepto: 'Compra Feixas Aulet S. Caldes De Males', origen: 'Crédito …6302', fijo: { tipo: 'pago_tarjeta' } });
  const movs = [t('a', '2026-07-13', -80), t('b', '2026-07-20', -80), t('c', '2026-07-24', -30), t('d', '2026-07-31', -25)];
  const f = C.conciliar({ movimientos: movs, emitidas: [], recibidas: rec }).filas;
  assert.ok(f.every(x => x.estado === 'punteado')); assert.match(f[0].nota, /más con tarjeta/);
});

test('domiciliado: si sus facturas se pagan por recibo, lo pendiente se cargará solo', () => {
  assert.equal(CP._domiciliado([{ pagos: [{ concepto: 'Recibo Gerard Codina Mas Nº Recibo 0049' }] }]), true);
  assert.equal(CP._domiciliado([{ pagos: [] }], [{ concepto: 'Recibo Quartix Nº Recibo 0049 2439' }]), true);
  assert.equal(CP._domiciliado([{ pagos: [{ concepto: 'Transferencia a favor de X' }] }]), false);
});

test('recibo: paga la factura anterior del mismo importe, no una posterior más cercana', () => {
  const P = 'RECUPERACIONS MARCEL NAVARRO I FILLS, SL';
  const rec = [{ id: 'a', numero: 'A-00113337', refProveedor: 'A-00113337', proveedor: P, fecha: '2026-06-30', total: 22.87 },
    { id: 'b', numero: 'A-00115339', refProveedor: 'A-00115339', proveedor: P, fecha: '2026-08-31', total: 22.87 }];
  const f = C.conciliar({ movimientos: [{ id: 'm', fecha: '2026-08-25', importe: -22.87, concepto: 'Recibo Recuperacions Marcel Navarro I Fills,sl Nº Recibo 0049 2439 755', codigo: '061' }], emitidas: [], recibidas: rec }).filas[0];
  assert.equal(f.estado, 'punteado'); assert.equal(f.docs[0].ref, 'A-00113337');
});

test('mismo proveedor con varios nombres: una sola cuenta (prefijo propio o razón social)', () => {
  const rec = [{ proveedor: 'SPASS, SLU' }, { proveedor: 'SPASS, SLU' }, { proveedor: 'SPASS-SERVICIO DE PREVENCIÓN AJENO EN SEGURIDAD Y SALUD LABORAL SLU' },
    { proveedor: 'COSSI COWORKING', alias: 'Gerard Codina Mas' }, { proveedor: 'Gerard Codina Mas' },
    { proveedor: 'Pintures Sant Narcis S.L.U' }, { proveedor: 'Pintures Bruguer SA' }];
  const g = CP._agrupador(rec);
  assert.equal(g(rec[0]), g(rec[2])); assert.equal(g(rec[3]), g(rec[4]));
  assert.notEqual(g(rec[5]), g(rec[6]));   // «pintures» es genérico: no se juntan
});

test('Amazon: un cargo con tarjeta paga un pedido con varias facturas', () => {
  const rec = [{ id: 'z1', numero: 'FPR00856', refProveedor: 'ES612QLC1AEUS', proveedor: 'Amazon EU S.à r.l., Sucursal en España', fecha: '2026-06-18', total: 22.74 },
    { id: 'z2', numero: 'FPR00857', refProveedor: 'ES612QLC2', proveedor: 'Amazon EU S.à r.l., Sucursal en España', fecha: '2026-06-17', total: 60 }];
  const f = C.conciliar({ movimientos: [{ id: 'k', fecha: '2026-06-18', importe: -98.01, concepto: 'Compra Www.amazon* Nf4752sa5, Luxembourg, Tarjeta 4176570174907925', fijo: { tipo: 'pago_tarjeta' } }], emitidas: [], recibidas: rec }).filas[0];
  assert.equal(f.estado, 'punteado'); assert.equal(f.docs.length, 2); assert.match(f.nota, /faltan facturas por 15\.27/);
});

test('Saltoki: recibo con «Fecha Factura» paga también las que StelOrder ya daba por pagadas', () => {
  const P = 'Saltoki girona S.A';
  const rec = [{ id: 'a', numero: 'FPR00665', refProveedor: '19815', proveedor: P, fecha: '2026-04-11', total: 97.39, pendienteStel: 0 },
    { id: 'b', numero: 'FPR00676', refProveedor: '21166', proveedor: P, fecha: '2026-04-18', total: 192.06 }];
  const f = C.conciliar({ movimientos: [{ id: 'm', fecha: '2026-05-25', importe: -289.45, concepto: 'Recibo Saltoki Girona S.a., Concepto: Factura N: 4/147359 Fecha Factura: 20/04/2026 Vto.: 001', codigo: '061' }], emitidas: [], recibidas: rec }).filas[0];
  assert.equal(f.estado, 'punteado'); assert.deepEqual(f.docs.map(d => d.refProveedor), ['19815', '21166']);
});
