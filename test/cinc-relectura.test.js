// Facturas de CINC muy largas: si la IA resumió el final («… y 333 líneas más»), se relee el PDF por páginas.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fijar = (mod, exp) => { const p = require.resolve(path.join('..', 'src', mod)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };

test('relee por páginas una factura cortada y guarda todas las líneas', async () => {
  const guardado = [];
  fijar('db', { getDB: async () => ({ collection: () => ({ updateOne: async (q, u) => guardado.push(u.$set) }) }) });
  let leidas = 0;
  fijar('compras', {
    fotosDe: async () => [{ mimetype: 'application/pdf', data: Buffer.from('pdf') }],
    _partirPdf: async () => [Buffer.from('p1'), Buffer.from('p2'), Buffer.from('p3')],
    _leerConIA: async () => { leidas++; return { ok: true, datos: { lineas: [{ descripcion: `Comisión FAC0030${leidas}`, importe: 10 }, { descripcion: `Comisión FAC0031${leidas}`, importe: 5 }] } }; },
    _aplicarLectura: (doc, d) => Object.assign(doc, { lineas: d.lineas }),
  });
  delete require.cache[require.resolve('../src/comisionesCinc')];
  const C = require('../src/comisionesCinc');
  const c = { _id: '64b7f0c2a1b2c3d4e5f60718', numero: 'F24/4601309', lineas: [{ descripcion: 'Comisión FAC00300' }, { descripcion: '… y 333 líneas más (facturas F24/4601458, F24/4602036)' }] };
  const r = await C._completarLineas(c);
  assert.equal(leidas, 3, 'una lectura por página');
  assert.equal(r.lineas.length, 6);
  assert.equal(guardado[0].lineas.length, 6);
  const sinCortar = { _id: 'x', lineas: [{ descripcion: 'Comisión FAC00300' }] };
  assert.strictEqual(await C._completarLineas(sinCortar), sinCortar, 'si no está cortada no se toca');
  for (const m of ['db', 'compras']) delete require.cache[require.resolve(path.join('..', 'src', m))];
  delete require.cache[require.resolve('../src/comisionesCinc')];
});
