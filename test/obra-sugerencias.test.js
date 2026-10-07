// «¿Son de esta obra?»: compras sin obra que nombran la obra (fuertes) o son de sus fechas (candidatas).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fijar = (mod, exp) => { const p = require.resolve(path.join('..', 'src', mod)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };

test('sugiere por texto y por fechas, y no lo que nombra otra obra', async () => {
  const obra = { _id: '64b7f0c2a1b2c3d4e5f60718', reference: 'Santa Eugenia 57', clientName: 'Comunidad Santa Eugenia 57', address: 'Carrer Santa Eugènia 57, Girona', aliases: [] };
  const compras = [
    { _id: 'a1', proveedor: 'Oliveras', tipo: 'factura', fecha: '2026-09-10', base: 840, obraPista: 'OBRA SANTA EUGENIA 57' },                 // fuerte
    { _id: 'a2', proveedor: 'Palahí', tipo: 'albaran', fecha: '2026-09-12', base: 310, lineas: [{ descripcion: 'Schlüter DITRA 25 m²' }] },    // por fechas (mismo día)
    { _id: 'a3', proveedor: 'Saltoki', tipo: 'factura', fecha: '2026-09-12', base: 90, obraPista: 'Obra Carles Rahola 13' },                    // nombra otra obra: fuera
    { _id: 'a4', proveedor: 'Obramat', tipo: 'ticket', fecha: '2026-03-01', base: 20 },                                                          // fuera de fechas
  ];
  const col = n => ({
    findOne: async () => (n === 'obras' ? obra : null),
    find: () => ({ project: () => ({ toArray: async () => (n === 'compras' ? compras : n === 'partes' ? [{ date: '2026-09-12' }, { date: '2026-09-20' }] : []) }) }),
  });
  fijar('db', { getDB: async () => ({ collection: col }) });
  delete require.cache[require.resolve('../src/obraSugerencias')];
  const S = require('../src/obraSugerencias');
  assert.ok(S._palabrasDe(obra).includes('eugenia'));
  assert.ok(!S._palabrasDe(obra).includes('girona'), 'girona es genérica');
  const r = await S.sugerencias(obra._id);
  assert.deepEqual(r.fuertes.map(x => x.id), ['a1']);
  assert.deepEqual(r.porFechas.map(x => x.id), ['a2']);
  assert.match(r.porFechas[0].motivo, /mismo día/);
  delete require.cache[require.resolve(path.join('..', 'src', 'db'))];
  delete require.cache[require.resolve('../src/obraSugerencias')];
});
