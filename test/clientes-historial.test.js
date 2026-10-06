// test/clientes-historial.test.js — Cuentas de un cliente: facturado, gasto en sus obras y gastos sueltos
// a su nombre (Compras → «Un cliente»), casando el nombre sin acentos ni mayúsculas.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');

const cur = arr => { const c = { project: () => c, sort: () => c, toArray: async () => arr }; return c; };
const COMPRAS = [
  { _id: 'c1', destino: 'cliente', clienteNombre: 'CTAT. PROP. CREU 5', proveedor: 'Rubén Esteban', numero: '20260008', fecha: '2026-09-03', base: 60, total: 72.6, estado: 'por_revisar' },
  { _id: 'c2', destino: 'cliente', clienteNombre: 'Otra comunidad', base: 999, estado: 'revisada' },
];
const OBRAS = [{ _id: 'o1', reference: 'Creu 5 bajantes', clientName: 'Ctat. Prop. Creu 5', status: 'activa', budgetAmount: 2000 }, { _id: 'o2', reference: 'Otra', clientName: 'Otro', status: 'activa' }];
const db = { collection: n => ({ find: () => cur(n === 'compras' ? COMPRAS : n === 'obras' ? OBRAS : []) }) };
const dbPath = require.resolve(path.join(root, 'src/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDB: async () => db } };
const trPath = require.resolve(path.join(root, 'src/trimestre.js'));
require.cache[trPath] = { id: trPath, filename: trPath, loaded: true, exports: { todasEmitidas: async () => [
  { numero: 'FAC00901', fecha: '2026-09-10', cliente: 'Ctat. Prop. Creu 5', base: 1500, total: 1815, pendiente: 1815 },
  { numero: 'FAC00800', fecha: '2026-05-10', cliente: 'Ctat. Prop. Creu 5', base: 300, total: 363, pendiente: 0 },
  { numero: 'FAC00700', fecha: '2026-05-10', cliente: 'Otro', base: 50, total: 60.5, pendiente: 0 },
] } };
const C = require(path.join(root, 'src/compras.js'));
C.deObra = async id => (id === 'o1' ? [{ importe: 400 }, { importe: 250 }] : [{ importe: 1 }]);
const H = require(path.join(root, 'src/clientes.js'));

test('suma lo facturado, sus obras y lo suelto a su nombre (sin acentos/mayúsculas)', async () => {
  const d = await H.historial('Ctat. Prop. Creu 5');
  assert.equal(d.totales.facturado, 1800);
  assert.equal(d.totales.pendienteCobro, 1815);
  assert.equal(d.totales.gastoObras, 650);
  assert.equal(d.totales.gastoDirecto, 60);
  assert.equal(d.totales.margenSinManoObra, 1090);
  assert.equal(d.obras.length, 1); assert.equal(d.compras.length, 1); assert.equal(d.nFacturas, 2);
});
