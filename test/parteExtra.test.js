'use strict';
const test = require('node:test');
const assert = require('node:assert');
const X = require('../src/parteExtra');

const fakeDb = (cols) => ({ collection: n => ({
  find: () => { const r = { project: () => r, sort: () => r, limit: () => r, toArray: async () => cols[n] || [] }; return r; },
  findOne: async q => (cols[n] || []).find(d => Object.entries(q).every(([k, v]) => String(d[k]) === String(v))) || null,
}) });

test('firma: solo un PNG válido y no enorme; sin firma = null', () => {
  assert.strictEqual(X.firma(null), null);
  assert.strictEqual(X.firma({ png: 'data:image/jpeg;base64,AAAA' }), null);
  const png = 'data:image/png;base64,' + 'A'.repeat(400);
  const f = X.firma({ nombre: ' Marta ', png });
  assert.strictEqual(f.nombre, 'Marta');
  assert.strictEqual(f.png, png);
  assert.strictEqual(X.firma({ png: 'data:image/png;base64,' + 'A'.repeat(400000) }), null);
});

test('material: precio del almacén, si no de la última compra; el del operario se respeta', async () => {
  const db = fakeDb({
    almacen: [{ nombre: 'Saco mortero M-7,5 25kg', precioUd: 1.88 }],
    compras: [{ proveedor: 'Obramat', fecha: '2026-10-10', lineas: [{ descripcion: 'SIKAFLEX 11 FC BLANCO 300ML', cantidad: 2, importe: 15.58 }] }],
  });
  const r = await X.valorarMateriales([{ nombre: 'saco mortero m 7,5 25 kg', cantidad: 3 }, { nombre: 'Sikaflex 11 fc', cantidad: 1 }, { nombre: 'Tornillos', cantidad: 10, precio: 0.1 }, { nombre: 'Cosa rara', cantidad: 1 }], { _db: db });
  assert.strictEqual(r[0].precio, 1.88); assert.match(r[0].precioFuente, /almacén/);
  assert.strictEqual(r[1].precio, 7.79); assert.match(r[1].precioFuente, /compra Obramat/);
  assert.strictEqual(r[2].precio, 0.1); assert.strictEqual(r[2].precioFuente, 'operario');
  assert.strictEqual(r[3].precio, 0); assert.strictEqual(r[3].precioFuente, null);
});

test('obra: la elegida, la del trabajo o la única que se llama como el cliente', async () => {
  const db = fakeDb({
    workOrderAssignments: [{ workOrderId: '77', obraId: 'aaaaaaaaaaaaaaaaaaaaaaaa' }, { workOrderId: '78', cliente: 'CTAT PROP. carrer Major de Salt 75, 77' }],
    obras: [{ _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', reference: 'Major 75-77 Salt', clientName: 'CTAT PROP. carrer Major de Salt 75, 77' }, { _id: 'cccccccccccccccccccccccc', reference: 'carme 60 portal', aliases: ['carme 60'] }],
  });
  assert.strictEqual((await X.obra({ obraId: 'dddddddddddddddddddddddd' }, { _db: db })).fuente, 'elegida');
  assert.strictEqual((await X.obra({ workOrderId: '77' }, { _db: db })).obraId, 'aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.strictEqual((await X.obra({ workOrderId: '78' }, { _db: db })).obraId, 'bbbbbbbbbbbbbbbbbbbbbbbb');
  assert.strictEqual((await X.obra({ clientName: 'Carme 60' }, { _db: db })).obraId, 'cccccccccccccccccccccccc');
  assert.strictEqual((await X.obra({ clientName: 'Bellpuig 41' }, { _db: db })).obraId, null);
});
