// test/banco-sync.test.js — Banco automático (Enable Banking): un movimiento del banco entra con el mismo
// formato que el Excel de Santander y no se duplica con lo ya subido a mano (ni al revés).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');

// Mongo en memoria con lo justo ($or, $in, $gte/$lte, null = falta el campo).
const cols = {};
const col = n => (cols[n] = cols[n] || []);
const val = (d, k) => d[k] === undefined ? null : d[k];
const cumple = (d, q) => Object.entries(q).every(([k, c]) => {
  if (k === '$or') return c.some(x => cumple(d, x));
  const v = val(d, k);
  if (c && typeof c === 'object' && !Array.isArray(c) && !(c instanceof Date)) {
    return (!('$in' in c) || c.$in.includes(v)) && (!('$nin' in c) || !c.$nin.includes(v)) && (!('$ne' in c) || v !== c.$ne)
      && (!('$regex' in c) || new RegExp(c.$regex).test(v || '')) && ('$gte' in c ? v >= c.$gte : true) && ('$lte' in c ? v <= c.$lte : true);
  }
  return v === c;
});
let seq = 0;
const db = { collection: n => ({
  find: q => { let arr = col(n).filter(d => cumple(d, q || {})); const c = { limit: k => { arr = arr.slice(0, k); return c; }, sort: () => c, project: () => c, toArray: async () => arr }; return c; },
  findOne: async q => col(n).find(d => cumple(d, q)) || null,
  insertOne: async d => { const _id = 'id' + (++seq); col(n).push({ _id, ...d }); return { insertedId: _id }; },
  updateOne: async (q, u, o = {}) => { let d = col(n).find(x => cumple(x, q)); if (!d && o.upsert) { d = { _id: 'id' + (++seq), ...q, ...(u.$setOnInsert || {}) }; col(n).push(d); Object.assign(d, u.$set || {}); return { upsertedCount: 1 }; } if (d) Object.assign(d, u.$set || {}); return { upsertedCount: 0 }; },
  deleteOne: async q => { const i = col(n).findIndex(x => cumple(x, q)); if (i >= 0) col(n).splice(i, 1); },
  createIndex: async () => {},
}) };
const dbPath = require.resolve(path.join(root, 'src/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDB: async () => db } };
const S = require(path.join(root, 'src/bancoSync.js'));

const IBAN = 'ES1200490000000000000001';
const SANT = { uid: 'u-sant', iban: IBAN, nombre: 'Cuenta empresa', destino: 'banco' };
const tx = (o) => ({ transaction_amount: { amount: String(o.imp), currency: 'EUR' }, credit_debit_indicator: o.imp < 0 ? 'DBIT' : 'CRDT', booking_date: o.fecha, value_date: o.fecha, status: 'BOOK', entry_reference: o.ref, remittance_information: o.rem ? [o.rem] : [], creditor: o.a ? { name: o.a } : null, debtor: o.de ? { name: o.de } : null, balance_after_transaction: o.saldo != null ? { balance_amount: { amount: String(o.saldo) } } : null });

test('formato como el Excel: transferencia a un trabajador se reconoce como nómina', () => {
  const m = S.aBanco(SANT, tx({ imp: -1450, fecha: '2026-09-30', ref: 'R1', a: 'JOSE ANTONIO BELIARD', rem: 'NOMINA SEPTIEMBRE', saldo: 8000 }));
  assert.equal(m.importe, -1450); assert.equal(m.fechaOperacion, '2026-09-30'); assert.equal(m.mes, '2026-09');
  assert.match(m.concepto, /^Transferencia A Favor De JOSE ANTONIO BELIARD Concepto: NOMINA/);
  assert.equal(m.codigo, '072'); assert.equal(m.categoria, 'nomina'); assert.equal(m.saldo, 8000);
});

test('lo ya subido en Excel no se duplica, y lo nuevo entra solo una vez', async () => {
  col('bancoMovimientos').push({ _id: 'x1', huella: `${IBAN}|2026-09-26|-300.00|9450.00|transferencia a favor de rachid`, iban: IBAN, fechaOperacion: '2026-09-26', importe: -300, saldo: 9450, concepto: 'Transferencia A Favor De Rachid' });
  const txs = [tx({ imp: -300, fecha: '2026-09-26', ref: 'R2', a: 'RACHID', saldo: 9450 }), tx({ imp: -484, fecha: '2026-10-03', ref: 'R3', a: 'RACHID EL', rem: 'IN2609-0069', saldo: 8966 }), { ...tx({ imp: -5, fecha: '2026-10-06', ref: 'R4' }), status: 'PDNG' }];
  const r1 = await S.guardarMovimientos(db, SANT, txs, new Set());
  assert.equal(r1.nuevos, 1); assert.equal(r1.repetidos, 1); assert.equal(r1.ids.length, 1);                       // el pendiente no entra
  assert.equal(col('bancoMovimientos').find(d => d._id === 'x1').ebRef, `eb|${IBAN}|R2`);  // enlazado con el del Excel
  const r2 = await S.guardarMovimientos(db, SANT, txs, new Set());          // segunda lectura: nada nuevo
  assert.equal(r2.nuevos, 0); assert.equal(r2.repetidos, 2);
  // Y si luego se sube el Excel con el pago del 3/10, se enlaza con el que entró solo.
  const gem = await S.gemelaDeExcel(db, { iban: IBAN, fechaOperacion: '2026-10-03', fechaValor: '2026-10-03', importe: -484, saldo: 8966 });
  assert.ok(gem && gem.ebRef === `eb|${IBAN}|R3`);
});

test('Revolut va con las tarjetas aunque tenga IBAN; los traspasos entre cuentas propias no son gasto', () => {
  const c = S._cuenta({ uid: 'u-rev', account_id: { iban: 'LT000000' }, name: 'Main', currency: 'EUR' }, 'Revolut');
  assert.equal(c.destino, 'tarjeta');
  const m = S.aTarjeta({ ...c, banco: 'Revolut' }, tx({ imp: -500, fecha: '2026-10-01', ref: 'T1', rem: 'To Compras' }), new Set(['compras']));
  assert.equal(m.fuente, 'revolut'); assert.equal(m.tipo, 'TRANSFER'); assert.equal(m.interno, true);
  const p = S.aTarjeta({ ...c, banco: 'Revolut' }, tx({ imp: -63.2, fecha: '2026-10-01', ref: 'T2', rem: 'Obramat Girona' }), new Set(['compras']));
  assert.equal(p.tipo, 'CARD_PAYMENT'); assert.equal(p.interno, false);
});

test('la misma cuenta enlazada dos veces (Revolut repetida) no duplica movimientos', async () => {
  const a = { uid: 'r1', iban: 'ES9115830001199300813708', nombre: 'Main', destino: 'tarjeta', banco: 'Revolut' }, b = { ...a, uid: 'r2' };
  const t = [tx({ imp: -63.2, fecha: '2026-10-02', ref: 'TX9', rem: 'Obramat Girona' })];
  assert.equal((await S.guardarMovimientos(db, a, t, new Set())).nuevos, 1);
  assert.equal((await S.guardarMovimientos(db, b, t, new Set())).repetidos, 1);
});

test('Santander cambia la referencia de un día para otro: no se guarda dos veces; dos pagos iguales de verdad sí', async () => {
  const C = { uid: 'u-s2', iban: 'ES1200490000000000000002', nombre: 'Cuenta', destino: 'banco' };
  const tarde = [tx({ imp: 3366.22, fecha: '2026-10-08', ref: 'TARDE1', de: 'RESIDENCIA GERIATRICA SANT JORDI', rem: 'FACT 958' }), tx({ imp: -76, fecha: '2026-10-08', ref: 'TARDE2', a: 'BONPREU' })];
  assert.equal((await S.guardarMovimientos(db, C, tarde, new Set())).nuevos, 2);
  // a la mañana siguiente el banco devuelve los mismos con otra referencia, y uno nuevo de 76 € el mismo día
  const manana = [tx({ imp: 3366.22, fecha: '2026-10-08', ref: 'MAN1', de: 'RESIDENCIA GERIATRICA SANT JORDI', rem: 'FACT 958' }), tx({ imp: -76, fecha: '2026-10-08', ref: 'MAN2', a: 'BONPREU' }), tx({ imp: -76, fecha: '2026-10-08', ref: 'MAN3', a: 'BONPREU' })];
  const r = await S.guardarMovimientos(db, C, manana, new Set());
  assert.equal(r.nuevos, 1); assert.equal(r.repetidos, 2);
  const de = col('bancoMovimientos').filter(d => d.iban === C.iban);
  assert.equal(de.length, 3);
  assert.equal(de.filter(d => d.importe === 3366.22).length, 1);
  assert.equal(de.find(d => d.importe === 3366.22).ebRef, `eb|${C.iban}|MAN1`);
});

test('limpiar repetidos ya guardados: quita la copia de otra sincronización y pasa lo apuntado a la buena', async () => {
  const I = 'ES1200490000000000000003', b = 'bancoMovimientos';
  col(b).push({ _id: 'o1', origen: 'enablebanking', iban: I, fechaOperacion: '2026-10-08', importe: -493, concepto: 'Transferencia a favor de Melvin', ebRef: 'eb|' + I + '|A', importadoEl: new Date('2026-10-08T17:15:03Z') });
  col(b).push({ _id: 'd1', origen: 'enablebanking', iban: I, fechaOperacion: '2026-10-08', importe: -493, concepto: 'Transferencia a favor de Melvin', ebRef: 'eb|' + I + '|B', importadoEl: new Date('2026-10-09T05:15:04Z') });
  col(b).push({ _id: 'p1', origen: 'enablebanking', iban: I, fechaOperacion: '2026-10-08', importe: -76, concepto: 'Bonpreu', ebRef: 'eb|' + I + '|C', importadoEl: new Date('2026-10-08T09:15:03Z') });
  col(b).push({ _id: 'p2', origen: 'enablebanking', iban: I, fechaOperacion: '2026-10-08', importe: -76, concepto: 'Bonpreu', ebRef: 'eb|' + I + '|D', importadoEl: new Date('2026-10-08T09:15:04Z') });
  col('punteoManual').push({ _id: 'd1', decision: 'sin_factura', nota: 'nómina' });
  const prueba = await S.limpiarDuplicados();
  assert.deepEqual(prueba.duplicados.filter(x => x.id.length === 2).map(x => x.id), ['d1']);   // los dos de 76 € llegaron juntos: son dos
  await S.limpiarDuplicados({ aplicar: true });
  assert.ok(!col(b).some(d => d._id === 'd1')); assert.ok(col(b).some(d => d._id === 'p2'));
  assert.equal(col('punteoManual').find(d => d._id === 'o1').decision, 'sin_factura');
  assert.ok(col('bancoMovimientosDuplicados').some(d => d._id === 'd1'));
});
