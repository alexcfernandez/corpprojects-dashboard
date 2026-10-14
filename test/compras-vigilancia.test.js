// test/compras-vigilancia.test.js — herramientas repetidas (enrolladores) y «¿para qué obra?» al que sube la compra.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ObjectId } = require('mongodb');
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const C1 = new ObjectId();
const cols = { compras: [{ _id: C1, proveedor: 'Oliveras', fecha: '2026-09-20', obraRef: 'Aura Marques', lineas: [{ descripcion: 'ELEKTRO3 ENROLLACABLES C/PROT.3X50MT', cantidad: 1, precio: 69.82, importe: 69.82 }] }], obras: [{ _id: new ObjectId(), reference: 'Sant Fos', clientName: 'Casa Sant Fos', status: 'activa' }] };
stub('src/db.js', { getDB: async () => ({ collection: n => ({
  find: () => ({ project() { return this; }, toArray: async () => cols[n] }),
  findOne: async q => cols[n].find(d => String(d._id) === String(q._id)) || null,
  updateOne: async (q, u) => { const d = cols[n].find(x => String(x._id) === String(q._id)); if (d) Object.assign(d, u.$set || {}); },
}) }) });
const V = require(path.join(root, 'src/comprasVigilancia.js'));

test('qué es herramienta que dura y qué no', () => {
  assert.equal(V.categoria('ENROLLADOR DE CABLE ELEC.25MT 3X1.5', 30.5).id, 'enrollador');
  assert.equal(V.categoria('BULTMEIER ENROLLACABLES H05VV-F 3G1.5X25M', 39.92).id, 'enrollador');
  assert.equal(V.categoria('ML CABLE LHA RZ1-K(AS) 2X10MM (BOBINA)', 4.02), null);
  assert.equal(V.categoria('Disco radial 125 mm', 3), null);
  assert.equal(V.categoria('Broca para taladro 8mm', 20), null);
  assert.equal(V.categoria('Taladro percutor Bosch', 89).id, 'taladro');
});

test('otro enrollador al día siguiente: aviso a Álex y pregunta al trabajador (obra y qué pasó con el anterior)', async () => {
  const avisos = [], encargos = [];
  const nueva = { _id: new ObjectId(), proveedor: 'BigMat Forcemat', fecha: '2026-09-21', total: 85.49, destino: 'obra', subidaPor: { kind: 'worker', userId: '6a1c99b00faa632f1f00029a', name: 'Jose Beliard' },
    lineas: [{ descripcion: 'ENROLLADOR DE CABLE ELEC.25MT 3X1.5 H05 VV230', cantidad: 1, precio: 30.5, importe: 30.5 }] };
  const r = await V.alSubir(nueva, { _avisar: async t => avisos.push(t), _crearEncargo: async o => encargos.push(o), _hist: () => V.historial({ _stel: async () => [] }) });
  assert.equal(r.repetidas.length, 1);
  assert.match(avisos[0], /Otra compra de enrollador/); assert.match(avisos[0], /20\/09\/2026 · Oliveras · 69,82 € · Aura Marques/); assert.match(avisos[0], /Jose Beliard/);
  assert.match(r.pregunta, /para qué obra es la compra de BigMat Forcemat/); assert.match(r.pregunta, /Qué pasó con el anterior/);
  assert.equal(encargos[0].origen.tipo, 'compra'); assert.equal(encargos[0].origen.sinObra, true);
});

test('la respuesta del trabajador pone la obra en la compra', async () => {
  const c = { _id: new ObjectId(), proveedor: 'BigMat' }; cols.compras.push(c);
  const r = await V.respuestaCompra({ compraId: String(c._id), sinObra: true }, 'Es para Sant Fos, el otro se quedó en Aura', 'Jose');
  assert.equal(r.obra, 'Sant Fos'); assert.equal(c.obraRef, 'Sant Fos');
});
