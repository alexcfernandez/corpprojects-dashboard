// Botón «Facturar» del tablero del ciclo: propuesta desde el parte y factura desde el pedido, una sola vez (2/11/2026).
const test = require('node:test');
const assert = require('node:assert');

// asignaciones.markInvoiced escribe en Mongo y StelOrder: aquí solo se apunta
const marcados = [];
require.cache[require.resolve('../src/asignaciones')] = { exports: { markInvoiced: async (id, ref) => { marcados.push([id, ref]); } } };
const F = require('../src/facturarParte');

function fakeDb(datos) {
  const cols = {};
  const match = (d, q) => Object.entries(q).every(([k, v]) => v && typeof v === 'object' && v.$in ? v.$in.includes(d[k]) : d[k] === v);
  const col = n => (cols[n] = cols[n] || {
    rows: datos[n] || [],
    async findOne(q) { return this.rows.find(d => match(d, q)) || null; },
    find(q) { const l = this.rows.filter(d => match(d, q || {})); const c = { sort: () => c, toArray: async () => l }; return c; },
    async updateOne(q, u, o = {}) { let d = this.rows.find(x => match(x, q)); if (!d && o.upsert) { d = { ...q }; this.rows.push(d); } if (d) Object.assign(d, u.$set || {}); return { matchedCount: d ? 1 : 0 }; },
    async updateMany(q, u) { this.rows.filter(x => match(x, q)).forEach(d => Object.assign(d, u.$set || {})); },
  });
  return { collection: col, _cols: cols };
}

const S = (log) => ({
  getAllWorkOrders: async () => [{ id: 61, 'full-reference': 'PDT00600', 'account-id': 7, lines: [{ 'line-type': 'ITEM', 'item-name': 'Actuación', 'item-description': 'Gotera', units: 1, 'item-base-price': 0 }] }],
  getClients: async () => ({ clientMap: { 7: { name: 'Ctat. Bellpuig 41', family: 'CINC Administradors' } } }),
  ponerLineasPedido: async (id, L) => { log.push(['pedido', id, L.length]); return { ok: true }; },
  crearFacturaDesdePedido: async (x) => { log.push(['factura', x.workOrderId, x.accId, x.lineas.length]); return { id: '900', ref: 'FAC01000', total: x.lineas.reduce((s, l) => s + l.unidades * l.precio, 0) * 1.1 }; },
});
const datos = () => ({
  workOrderAssignments: [{ workOrderId: '61', userId: 'u1', userName: 'David', equipo: ['Diego'], incidenciaRef: 'INC00700', resumen: 'Gotera en el 3-1', direccion: 'Bellpuig 41' }],
  partes: [{ workOrderId: '61', workerName: 'David', date: '2026-11-03', horas: 1, equipo: ['Diego'], description: 'Cambio de bajante', materiales: [{ nombre: 'Tubo PVC 110', cantidad: 2, precio: 10 }] }],
  facturasParte: [],
});
const valorar = async m => m.map(x => ({ ...x, precioFuente: 'operario' }));

test('la propuesta sale del parte: mínimo 2 h × 2 personas, material +30 %, desplazamiento, +10 % CINC y IVA 10 % en comunidad', async () => {
  const p = await F.propuesta('61', { _S: S([]), _db: fakeDb(datos()), _valorar: valorar });
  const [mano, mat, desp] = p.lineas;
  assert.strictEqual(mano.unidades, 4);                         // 1 h → 2 h mínimo × 2 personas
  assert.strictEqual(mano.precio, 61.88);                       // 56,25 €/h × 1,10 CINC
  assert.match(mano.descripcion, /03\/11: 2 h × 2 operarios — Cambio de bajante/);
  assert.deepStrictEqual([mat.concepto, mat.unidades, mat.precio], ['Tubo PVC 110', 2, 14.3]);   // 10 × 1,30 × 1,10
  assert.deepStrictEqual([desp.unidades, desp.precio], [1, 22]);
  assert.strictEqual(p.iva, 10);
  assert.ok(p.avisos.some(a => /cuento 2 h/.test(a)) && p.avisos.some(a => /CINC/.test(a)));
  assert.strictEqual(p.titulo, 'Gotera en el 3-1 · Bellpuig 41');
});

test('facturar: líneas al pedido, factura desde el pedido, partes facturados, y no deja repetir', async () => {
  const log = []; const db = fakeDb(datos());
  const L = [{ concepto: 'Mano de obra', unidades: 4, precio: 56.25 }, { concepto: 'Tubo', unidades: 2, precio: '13,00' }];
  const r = await F.facturar('61', { lineas: L, iva: 10 }, 'Álex', { _S: S(log), _db: db });
  assert.deepStrictEqual(log, [['pedido', '61', 2], ['factura', '61', 7, 2]]);
  assert.strictEqual(r.factura.ref, 'FAC01000');
  assert.strictEqual(r.total, 276.1);                           // (225 + 26) × 1,10 IVA
  assert.deepStrictEqual(marcados.pop(), ['61', 'FAC01000']);
  assert.strictEqual(db._cols.partes.rows[0].status, 'facturado');
  await assert.rejects(() => F.facturar('61', { lineas: L, iva: 10 }, 'Álex', { _S: S(log), _db: db }), /Ya se facturó \(FAC01000\)/);
  assert.strictEqual(log.length, 2);
});

test('si StelOrder no contesta, queda bloqueado para revisar y no se vuelve a mandar', async () => {
  const log = []; const db = fakeDb(datos());
  const s = S(log); s.crearFacturaDesdePedido = async () => { const e = new Error('StelOrder no contestó'); e.sinRespuesta = true; throw e; };
  await assert.rejects(() => F.facturar('61', { lineas: [{ concepto: 'Mano de obra', unidades: 2, precio: 50 }], iva: 21 }, 'Álex', { _S: s, _db: db }), /no contestó/);
  assert.strictEqual(db._cols.facturasParte.rows[0].estado, 'revisar');
  await assert.rejects(() => F.facturar('61', { lineas: [{ concepto: 'Mano de obra', unidades: 2, precio: 50 }], iva: 21 }, 'Álex', { _S: S(log), _db: db }), /mira en StelOrder/);
  assert.deepStrictEqual(log, [['pedido', '61', 1]]);           // las líneas del pedido no se repiten
});

test('no factura a 0 € ni con un IVA raro', async () => {
  await assert.rejects(() => F.facturar('61', { lineas: [{ concepto: 'x', unidades: 1, precio: 0 }], iva: 21 }, 'Álex', { _S: S([]), _db: fakeDb(datos()) }), /0 €/);
  await assert.rejects(() => F.facturar('61', { lineas: [{ concepto: 'x', unidades: 1, precio: 5 }], iva: 7 }, 'Álex', { _S: S([]), _db: fakeDb(datos()) }), /IVA/);
});
