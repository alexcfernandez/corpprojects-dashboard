'use strict';
const test = require('node:test');
const assert = require('node:assert');
const V = require('../src/vehiculos');

const JOSE = { userId: 'a'.repeat(24), name: 'Jose' };
test('gasolina del coche particular: no se suma a ninguna furgoneta', () => {
  const c = { _id: 'c1', proveedor: 'Esclat', numero: 'F1', fecha: '2026-10-17', base: 100, vehiculoId: 'v1', estado: 'revisada', lineas: [
    { descripcion: 'Gasoil 30 LT', cantidad: 30, unidad: 'L', importe: 50, vehiculoId: 'v2' },
    { descripcion: 'Gasoil 18 LT', cantidad: 18, unidad: 'L', importe: 30, vehiculoId: null, personalDe: JOSE },
    { descripcion: 'Gasoil 12 LT', cantidad: 12, unidad: 'L', importe: 20, vehiculoId: null },
  ] };
  const g = V._gastosCompra(c);
  assert.deepStrictEqual(g.map(x => [x.vehiculoId, x.importe]).sort(), [['v1', 20], ['v2', 50]]);
});
test('factura entera de un coche particular: no da gasto de flota', () => {
  const c = { _id: 'c2', proveedor: 'Petroprix', base: 16.5, vehiculoId: null, personalDe: JOSE, lineas: [{ descripcion: 'Gasolina', importe: 16.5, personalDe: JOSE }] };
  assert.deepStrictEqual(V._gastosCompra(c), []);
});
