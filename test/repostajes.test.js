// test/repostajes.test.js — Combustible por vehículo: correo de Esclat, tiquets de la app, líneas de la
// factura quincenal repartidas por vehículo y gasto por vehículo línea a línea.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');

// Mock de ./db: find() devuelve toda la colección (las funciones filtran en JS lo que importa aquí).
const datos = { vehiculos: [], repostajes: [], compras: [], punteoManual: [] };
const cursor = arr => { const c = { project: () => c, sort: () => c, limit: () => c, toArray: async () => arr.slice() }; return c; };
const db = { collection: n => ({ find: () => cursor(datos[n] || []) }) };
const dbPath = require.resolve(path.join(root, 'src/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDB: async () => db } };

const R = require(path.join(root, 'src/repostajes.js'));
const V = require(path.join(root, 'src/vehiculos.js'));

const DOBLO = 'aaaaaaaaaaaaaaaaaaaaaaaa', MOTO = 'bbbbbbbbbbbbbbbbbbbbbbbb', BERLINGO = 'cccccccccccccccccccccccc';

test('correo de Esclat: importe, gasolinera, fecha y hora', () => {
  const t = "Hola Corp. Projects Holding Sl, Gràcies per confiar en EsclatOil! Has efectuat una nova transacció a través de l'App de Mobilitat. * Import: 100,00 * Establiment: EsclatOil Girona I * Data i hora: 05/10/2026 10:59 Aquest avís";
  assert.deepEqual(R.leerCorreoEsclat('Subministrament Completat | App Mobilitat', t), { importe: 100, establecimiento: 'EsclatOil Girona I', fecha: '2026-10-05', hora: '10:59' });
  assert.equal(R.leerCorreoEsclat('Corp. Projects Holding, el teu val de descompte', 'Targeta Client'), null);
});

test('tiquet de la app = tiquet de la factura (planta + número)', () => {
  assert.deepEqual(R.partesTicket('4063A0321313'), { ticket: '4063A0321313', planta: '4063', num: '321313' });
  const l = R.leerLinea({ descripcion: 'GAS-OIL A 1 LT - Tiquet 321313 (18-09-2026)', cantidad: 39.8, unidad: 'L', importe: 57.85 });
  assert.equal(l.ticket.num, '321313'); assert.equal(l.fecha, '2026-09-18'); assert.equal(l.combustible, 'diésel'); assert.equal(l.litros, 39.8);
});

test('propuesta por línea: app Esclat, correo por importe con IVA, único de gasolina', async () => {
  datos.vehiculos = [
    { _id: DOBLO, nombre: 'Doblo', combustible: 'diésel', estado: 'activo' },
    { _id: BERLINGO, nombre: 'Berlingo', combustible: 'diésel', estado: 'activo', aliasEsclat: ['Citroën berlingo'] },
    { _id: MOTO, nombre: 'Motoreta', combustible: 'gasolina', estado: 'activo' },
  ];
  datos.repostajes = [
    { _id: 'r1', ticket: '4063A0321313', numTicket: '321313', fecha: '2026-09-18', alias: 'Citroën berlingo', vehiculoId: BERLINGO, origen: 'esclat_app' },
    { _id: 'r2', gmailId: 'g1', fecha: '2026-09-22', hora: '08:10', importe: 70.0, vehiculoId: DOBLO, origen: 'esclat_email' },
  ];
  const p = await R.propuestaLineas({ fecha: '2026-09-30', lineas: [
    { descripcion: 'GAS-OIL A 1 LT - Tiquet 321313 (18-09-2026)', cantidad: 39.8, unidad: 'L', importe: 57.85 },
    { descripcion: 'GASOLINA S/PLOM 95 1 LT - Tiquet 168775 (19-09-2026)', cantidad: 5.65, unidad: 'L', importe: 8.12 },
    { descripcion: 'GAS-OIL A 1 LT - Tiquet 324072 (22-09-2026)', cantidad: 39.8, unidad: 'L', importe: 57.85 },   // 57,85 × 1,21 = 70,00
    { descripcion: 'GAS-OIL A 1 LT - Tiquet 999999 (25-09-2026)', cantidad: 20, unidad: 'L', importe: 29 },
  ] });
  assert.equal(p[0].vehiculoId, BERLINGO); assert.match(p[0].motivo, /app Esclat/);
  assert.equal(p[1].vehiculoId, MOTO); assert.match(p[1].motivo, /único de gasolina/);
  assert.equal(p[2].vehiculoId, DOBLO); assert.match(p[2].motivo, /correo de Esclat/);
  assert.equal(p[3].vehiculoId, null);   // dos diésel y sin pistas: lo elige oficina
});

test('vehículo por el nombre de la app (alias aprendido)', () => {
  assert.equal(String(R.vehiculoPorAlias(datos.vehiculos, 'citroen  Berlingo')._id), BERLINGO);
  assert.equal(R.vehiculoPorAlias(datos.vehiculos, 'coche alfonso'), null);
});

test('gasto por vehículo: cada uno se lleva sus líneas y el resto va al de la compra', async () => {
  datos.compras = [{ _id: 'c1', destino: 'vehiculo', vehiculoId: DOBLO, proveedor: 'Esclat', numero: 'VEB-1', fecha: '2026-09-30', base: 100, categoria: 'combustible', estado: 'revisada',
    lineas: [{ descripcion: 'GAS-OIL A 1 LT', cantidad: 30, unidad: 'L', importe: 40, vehiculoId: BERLINGO }, { descripcion: 'GASOLINA 1 LT', cantidad: 5, unidad: 'L', importe: 8, vehiculoId: MOTO }, { descripcion: 'GAS-OIL A 1 LT', cantidad: 35, unidad: 'L', importe: 52 }] }];
  datos.punteoManual = [];
  const g = await V.gastos({});
  const de = id => g.find(x => x.vehiculoId === id);
  assert.equal(de(BERLINGO).importe, 40); assert.equal(de(BERLINGO).litros, 30);
  assert.equal(de(MOTO).importe, 8);
  assert.equal(de(DOBLO).importe, 52); assert.equal(de(DOBLO).litros, 35);
  assert.equal(g.reduce((a, x) => a + x.importe, 0), 100);
});
