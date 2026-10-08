// test/aviso-pagos.test.js — Resumen por WhatsApp de lo nuevo del banco: cobro que paga dos facturas, cobro parcial
// con lo que falta, pagos pequeños sumados y compras con tarjeta en una línea.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');
const { ObjectId } = require('mongodb');

const id = () => new ObjectId();
const B = [
  { _id: id(), fechaOperacion: '2026-10-02', importe: 331.42, concepto: 'TRANSFERENCIA DE CTAT PROP HABITAT MIGDIA, CONCEPTO CORP.PROJ' },
  { _id: id(), fechaOperacion: '2026-10-02', importe: 2000, concepto: 'TRANSFERENCIA DE PREFORMADOS ESPINOSA, CONCEPTO FRA' },
  { _id: id(), fechaOperacion: '2026-10-03', importe: -1962.62, concepto: 'TRANSFERENCIA A FAVOR DE Rubén Esteban Díaz Aceña CONCEPTO: 20260016' },
  { _id: id(), fechaOperacion: '2026-10-03', importe: -12.10, concepto: 'Recibo Grupo Masmovil Xfera' },
];
const T = [{ _id: id(), fecha: '2026-10-03', importe: -63.2, concepto: 'Obramat Girona', tipo: 'CARD_PAYMENT' }];
const porMov = new Map([
  [String(B[0]._id), { estado: 'punteado', docs: [{ ref: 'FAC00924', total: 264.99 }, { ref: 'FAC00929', total: 66.43 }] }],
  [String(B[1]._id), { estado: 'punteado', docs: [{ ref: 'FAC00990', total: 2500 }] }],
  [String(B[2]._id), { estado: 'punteado', docs: [{ ref: 'FPR00981', total: 1962.62 }] }],
]);
const db = { collection: n => ({ find: q => ({ toArray: async () => (n === 'bancoMovimientos' ? B : T).filter(d => q._id.$in.some(x => String(x) === String(d._id))) }) }) };
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('src/db.js', { getDB: async () => db });
stub('src/trimestre.js', { olvidarMapaPagos: () => {}, mapaPagos: async () => ({ porMov }), comercio: c => String(c).replace(/^transferencia (de|a favor de) /i, '').replace(/,.*$/, '').replace(/ concepto.*$/i, '').slice(0, 30) });
const A = require(path.join(root, 'src/avisoPagos.js'));

test('un mensaje con cobros, lo que falta de una factura, pagos y tarjeta', async () => {
  const nuevos = [...B.map(m => ({ col: 'bancoMovimientos', id: String(m._id) })), { col: 'tarjetaMovimientos', id: String(T[0]._id) }];
  const txt = await A.resumen(nuevos, { hoy: new Date('2026-10-08T09:15:00Z') });
  assert.match(txt, /\*Cobros\* \(2 · 2\.331,42 €\)/);
  assert.match(txt, /✅ 331,42 € · CTAT PROP HABITAT MIGDIA → FAC00924 \+ FAC00929/);
  assert.match(txt, /🟡 2\.000,00 € · PREFORMADOS ESPINOSA → FAC00990 · \*falta 500,00 €\*/);
  assert.match(txt, /✅ 1\.962,62 € · Rubén Esteban Díaz Aceña → FPR00981/);
  assert.match(txt, /… y 1 pago más de menos de 300 €/);
  assert.match(txt, /💳 Compras con tarjeta: 1 \(63,20 €\), 0 ya con factura/);
});
test('sin movimientos nuevos no se manda nada', async () => {
  assert.equal(await A.resumen([]), null);
});

test('si StelOrder no responde, el resumen del banco sale igual (sin cuadrar con facturas)', async () => {
  const tr = require(path.join(root, 'src/trimestre.js')); const antes = tr.mapaPagos;
  tr.mapaPagos = async () => { throw new Error('StelOrder en pausa por bloqueo'); };
  try {
    const txt = await A.resumen([{ col: 'bancoMovimientos', id: String(B[1]._id) }], { hoy: new Date('2026-10-08T05:15:00Z') });
    assert.match(txt, /Banco\* · lectura de las 07:15/);
    assert.match(txt, /2\.000,00 €/);
    assert.match(txt, /Sin cruzar con las facturas/);
  } finally { tr.mapaPagos = antes; }
});
