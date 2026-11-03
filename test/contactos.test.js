// Personas de contacto de cada comunidad (3/11/2026): normalizar teléfonos, juntar duplicados y pasar a StelOrder.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/contactos');

function fakeDb() {
  const rows = []; let n = 0;
  const match = (r, q) => Object.entries(q).every(([k, v]) => {
    if (k === '$or') return v.some(x => match(r, x));
    if (k === '$and') return v.every(x => match(r, x));
    const val = k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), r);
    if (v && typeof v === 'object' && !(v instanceof RegExp)) {
      if ('$ne' in v) return val !== v.$ne && !(Array.isArray(val) && val.includes(v.$ne));
      if ('$exists' in v) return (val !== undefined) === v.$exists;
      if ('$in' in v) return (Array.isArray(val) ? val : [val]).some(x => v.$in.includes(x));
      if ('$regex' in v) return (Array.isArray(val) ? val : [val]).some(x => new RegExp(v.$regex).test(x));
    }
    return Array.isArray(val) ? val.includes(v) : val === v;
  });
  const col = { rows,
    find: q => ({ sort: () => ({ limit: () => ({ toArray: async () => rows.filter(r => match(r, q)) }), toArray: async () => rows.filter(r => match(r, q)) }) }),
    findOne: async q => rows.find(r => match(r, q)) || null,
    insertOne: async d => { const _id = new (require('mongodb').ObjectId)(); rows.push({ ...d, _id }); n++; return { insertedId: _id }; },
    updateOne: async (q, u) => { const r = rows.find(x => match(x, q)); if (r) for (const [k, v] of Object.entries(u.$set)) r[k] = v; },
    countDocuments: async q => rows.filter(r => match(r, q)).length };
  return { rows, collection: () => col };
}
const S = { getClients: async () => ({ clientMap: { 12043730: { name: 'Zaragoza 81-89' }, 12043775: { name: 'Assessoria Palomares' } } }) };

test('teléfonos: 9 cifras, con o sin +34, y extranjeros con prefijo', () => {
  assert.strictEqual(C.tel('+34 636 98 41 17'), '636984117');
  assert.strictEqual(C.tel('601.26.48.92'), '601264892');
  assert.strictEqual(C.tel('0033681378736'), '0033681378736');
  assert.strictEqual(C.tel('12345'), '');
  assert.strictEqual(C.telBonito('636984117'), '636 98 41 17');
});

test('importar junta por teléfono en el mismo cliente y no duplica', async () => {
  const db = fakeDb();
  let r = await C.importar([{ nombre: 'Mari', rol: 'presidente', clienteId: '12043730', telefonos: ['636 98 41 17'] }, { nombre: 'Jenny Cayuela', rol: 'administrador', clienteId: '12043775', emails: ['jenny@palomares.cat'] }], 'test', { _db: db, _S: S });
  assert.deepStrictEqual(r, { nuevos: 2, juntados: 0, saltados: 0 });
  r = await C.importar([{ nombre: 'Mari López', rol: 'presidente', clienteId: '12043730', telefonos: ['636984117', '972000000'], piso: '1º 1ª' }, { nombre: '', telefonos: ['600000000'] }], 'test', { _db: db, _S: S });
  assert.deepStrictEqual(r, { nuevos: 0, juntados: 1, saltados: 1 });
  assert.deepStrictEqual(db.rows[0].telefonos, ['636984117', '972000000']);
  assert.strictEqual(db.rows[0].piso, '1º 1ª');
  assert.strictEqual(db.rows[0].cliente, 'Zaragoza 81-89');
});

test('pasar a StelOrder: una vez por contacto y para en el primer fallo', async () => {
  const db = fakeDb(); const creados = [];
  await C.importar([{ nombre: 'A', rol: 'vecino', clienteId: '12043730', telefonos: ['611111111'], piso: '2º 1ª' }, { nombre: 'B', rol: 'vecino', clienteId: '12043730', telefonos: ['622222222'] },
    { nombre: 'Sin tel', rol: 'vecino', clienteId: '12043730' }, { nombre: 'Sin cliente', rol: 'vecino', telefonos: ['633333333'] }], 'test', { _db: db, _S: S });
  let falla = false;
  const S2 = { ...S, crearContacto: async a => { if (falla) { const e = new Error('no contesta'); e.sinRespuesta = true; throw e; } creados.push(a); return { id: String(900 + creados.length) }; } };
  let r = await C.subirStel({ max: 1 }, 'Álex', { _db: db, _S: S2, _pausa: 0 });
  assert.strictEqual(r.subidos, 1); assert.strictEqual(r.quedan, 1);
  assert.deepStrictEqual([creados[0].accId, creados[0].nombre, creados[0].telefono, creados[0].cargo], ['12043730', 'A', '611 11 11 11', 'Vecino/a · 2º 1ª']);
  falla = true;
  r = await C.subirStel({}, 'Álex', { _db: db, _S: S2, _pausa: 0 });
  assert.strictEqual(r.subidos, 0); assert.strictEqual(r.fallos.length, 1);
  assert.strictEqual(r.quedan, 0);   // el que no contestó queda «revisar», no se repite solo
  assert.strictEqual(db.rows.find(x => x.nombre === 'B').stel.estado, 'revisar');
});
