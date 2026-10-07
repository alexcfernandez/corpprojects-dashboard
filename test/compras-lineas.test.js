// test/compras-lineas.test.js — Factura mezclada (Palahí): cada línea a su sitio. Lo de obra cuenta en su obra
// (reparto), las herramientas y EPIs aparte; la propuesta sale del albarán de cada línea y del nombre.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');
const { ObjectId } = require('mongodb');

const O16 = new ObjectId(), CREU = new ObjectId(), FACT = new ObjectId();
const OBRAS = [{ _id: O16, reference: 'Oviedo 16' }, { _id: CREU, reference: 'Creu 5' }];
const FACTURA = { _id: FACT, empresaId: 'corp', tipo: 'factura', proveedor: 'X-Palahí', proveedorNorm: 'x palahi', base: 120, lineas: [
  { descripcion: 'GUANTS DELTA PLUS NITRILO', cantidad: 3, importe: 3, albaran: '85789' },
  { descripcion: 'BIG-BAG ESCOMBROS 90x90x90', cantidad: 6, importe: 21, albaran: '85803' },
  { descripcion: 'PALETI BELLOTA 5842-H', cantidad: 1, importe: 20.87, albaran: '85803' },
  { descripcion: 'DANODREN H15 PLUS', cantidad: 37.8, importe: 128.9, albaran: '85914' },
  { descripcion: 'BROCA SDS-PLUS 12x250MM', cantidad: 1, importe: 14.9, albaran: '85937' },
] };
const ALBARANES = [{ _id: new ObjectId(), tipo: 'albaran', numero: '85803', obraId: String(O16), obraRef: 'Oviedo 16', proveedor: 'X-Palahí', proveedorNorm: 'x palahi' }];
const cur = arr => { const c = { project: () => c, sort: () => c, limit: () => c, toArray: async () => arr }; return c; };
const db = { collection: n => ({
  findOne: async q => n === 'obras' ? OBRAS.find(o => String(o._id) === String(q._id)) || null : n === 'compras' && String(q._id) === String(FACT) ? FACTURA : null,
  find: q => cur(n === 'compras' && q.tipo === 'albaran' ? ALBARANES : []),
}) };
const dbPath = require.resolve(path.join(root, 'src/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDB: async () => db } };
const obPath = require.resolve(path.join(root, 'src/obras.js'));
require.cache[obPath] = { id: obPath, filename: obPath, loaded: true, exports: { getSelector: async () => OBRAS.map(o => ({ id: String(o._id), reference: o.reference, clientName: '', address: '', aliases: [] })) } };
const C = require(path.join(root, 'src/compras.js'));

test('lo de obra se suma por obra en el reparto; herramientas y EPIs aparte, por persona', async () => {
  const r = await C._repartoDeLineas(db, [
    { importe: 21, para: { t: 'obra', obraId: String(O16) } }, { importe: 128.9, para: { t: 'obra', obraId: String(O16) } },
    { importe: 14.9, para: { t: 'obra', obraId: String(CREU) } },
    { importe: 3, para: { t: 'ropa', workerId: 'w1', workerName: 'David' } }, { importe: 20.87, para: { t: 'herramientas' } },
    { importe: 5, para: null },
  ]);
  assert.deepEqual(r.reparto.map(p => [p.obraRef, p.importe]), [['Oviedo 16', 149.9], ['Creu 5', 14.9]]);
  assert.deepEqual(r.repartoOtros, [{ t: 'ropa', quien: 'David', importe: 3 }, { t: 'herramientas', quien: null, importe: 20.87 }]);
  assert.equal(r.sinDestino, 1); assert.equal(r.varias, true); assert.equal(r.obraId, null);
});

test('propuesta: EPI por el nombre, obra por su albarán, herramienta aunque venga en el albarán de la obra', async () => {
  const p = await C.propuestaLineas(String(FACT));
  assert.equal(p[0].para.t, 'ropa');                                   // guantes
  assert.deepEqual(p[1].para, { t: 'obra', obraId: String(O16) });     // big-bag, albarán 85803 está en Oviedo 16
  assert.equal(p[2].para.t, 'herramientas');                           // paletín: no se carga a la obra
  assert.equal(p[3].para, null);                                       // sin pista: se deja vacía
  assert.equal(p[4].para, null);
});
