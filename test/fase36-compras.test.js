// test/fase36-compras.test.js — §3.6 buscarEnCompras: coste de material en las
// facturas de proveedor (nivel de línea).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');

// Mock de ./db (genérico) — evita conexiones reales
const generic = { async findOne() { return null; }, async updateOne() { return {}; }, async insertOne() { return { insertedId: 'x' }; }, async deleteOne() { return {}; }, find() { return { sort() { return { async toArray() { return []; } }; } }; } };
const dbPath = require.resolve(path.join(root, 'src/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDB: async () => ({ collection: () => generic }), getDBLegacy: async () => ({ db: { collection: () => generic }, client: { async close() {} } }) } };

process.env.OWNER_NUMBERS = '+34611223344';
delete process.env.ANTHROPIC_API_KEY; // no IA en estos tests deterministas

const asistente = require(path.join(root, 'src/asistente.js'));
const stel = require(path.join(root, 'src/stelorder.js'));

// Campos como los devuelve el GET real de StelOrder: units + total-amount (+ unit-price).
const INVS = [
  { id: '214', number: 'FPR00214', supplierId: '10', supplier: 'Saltoki', date: '2026-06-12', lines: [{ 'item-name': 'METABO SB 18 LTX', units: 4, 'unit-price': 118, 'total-amount': 472 }] },
  { id: '190', number: 'FPR00190', supplierId: '10', supplier: 'Saltoki', date: '2026-03-03', lines: [{ 'item-name': 'METABO SB 18 LTX', units: 2, 'unit-price': 121.5, 'total-amount': 243 }] },
  { id: '151', number: 'FPR00151', supplierId: '11', supplier: 'Ferretería X', date: '2025-11-14', lines: [{ 'item-name': 'METABO SB 18', units: 1, 'total-amount': 129 }] }, // solo total → unitario = total/units
  { id: '099', number: 'FPR00099', supplierId: '10', supplier: 'Saltoki', date: '2026-01-01', lines: [{ 'item-description': 'Cemento gris', units: 10, 'total-amount': 0 }] }, // sin precio
];
stel.getPurchaseInvoices = async () => INVS;
stel.getSuppliers = async () => ({ suppliers: [{ id: '10', name: 'Saltoki' }, { id: '11', name: 'Ferretería X' }, { id: '12', name: 'Salto Deportes' }], supplierMap: {} });
stel.getClients = async () => ({ clientMap: {}, families: [] });

const OWNER = 'whatsapp:+34611223344';

test('material "metabo" → coincidencias ordenadas por fecha desc, con FPR/proveedor/precio', async () => {
  const r = await asistente.handlerBuscarCompras('', OWNER, { material: 'metabo' });
  assert.match(r, /🔎/);
  assert.match(r, /3 compras/);
  // orden: 214 (jun) antes que 190 (mar) antes que 151 (nov 2025)
  assert.ok(r.indexOf('FPR00214') < r.indexOf('FPR00190'));
  assert.ok(r.indexOf('FPR00190') < r.indexOf('FPR00151'));
  assert.match(r, /4 ud × 118,00\s*€ = 472,00\s*€/);
  assert.match(r, /conceptos del 214/);
});

test('filtro por proveedor "Saltoki" restringe a ese proveedor', async () => {
  const r = await asistente.handlerBuscarCompras('', OWNER, { material: 'metabo', proveedor: 'Saltoki' });
  assert.match(r, /2 compras/);
  assert.match(r, /en Saltoki/);
  assert.doesNotMatch(r, /Ferretería X/);
});

test('proveedor ambiguo ("Salto") → pregunta, no elige', async () => {
  const r = await asistente.handlerBuscarCompras('', OWNER, { material: 'metabo', proveedor: 'Salto' });
  assert.match(r, /qué proveedor/i);
});

test('material inexistente → mensaje honesto', async () => {
  const r = await asistente.handlerBuscarCompras('', OWNER, { material: 'unicornio' });
  assert.match(r, /No encuentro compras/i);
});

test('precio 0 / sin precio → "(sin precio en la línea)", no 0,00 €', async () => {
  const r = await asistente.handlerBuscarCompras('', OWNER, { material: 'cemento' });
  assert.match(r, /sin precio en la línea/);
  assert.doesNotMatch(r, /0,00\s*€/);
});

test('extraerMaterialProveedor: "cuánto nos costó el Metabo" → material metabo', () => {
  const { material } = asistente.extraerMaterialProveedor('¿cuánto nos costó el Metabo?');
  assert.match(material, /metabo/);
});

test('enrutado: "¿cuánto nos costó el Metabo?" → compras (🔎), NO gasto agregado', async () => {
  const r = await asistente.responderConsulta('¿cuánto nos costó el Metabo?', OWNER);
  assert.match(r, /🔎/);
});
