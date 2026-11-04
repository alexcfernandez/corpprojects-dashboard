// test/archivos-disco.test.js — Fotos y PDF fuera de Mongo: el archivo va al disco con su SHA-256, el documento se queda
// sin `data`, al leerlo vuelve igual (como Binary, lo que daba Mongo) y sin volumen todo sigue como antes (en Mongo).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ObjectId, Binary } = require('mongodb');
const D = require(path.join(__dirname, '..', 'src/archivosDisco.js'));

const conDir = async fn => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disco-'));
  process.env.ARCHIVOS_DIR = dir;
  try { await fn(dir); } finally { delete process.env.ARCHIVOS_DIR; fs.rmSync(dir, { recursive: true, force: true }); }
};

test('guardar saca el archivo al disco y hidratar lo devuelve igual', () => conDir(async dir => {
  const buf = Buffer.from('%PDF-1.4 nómina de prueba ' + 'x'.repeat(5000));
  const doc = await D.guardar('docsPersonal', { tipo: 'nomina', data: buf });
  assert.ok(doc._id instanceof ObjectId);
  assert.equal(doc.data, undefined);
  assert.equal(doc.disco.ruta, `docsPersonal/${doc._id}`);
  assert.equal(doc.disco.bytes, buf.length);
  assert.equal(doc.disco.sha256, D.sha(buf));
  assert.deepEqual(fs.readFileSync(path.join(dir, 'docsPersonal', String(doc._id))), buf);
  await D.hidratar(doc);
  assert.ok(doc.data instanceof Binary);
  assert.deepEqual(Buffer.from(doc.data.buffer || doc.data), buf);   // como lo lee el código de siempre
}));

test('un Binary de Mongo se guarda tal cual (lo que hará la migración)', () => conDir(async () => {
  const buf = Buffer.from([1, 2, 3, 4, 5, 250]);
  const doc = await D.guardar('comprasFotos', { _id: new ObjectId(), data: new Binary(buf) });
  assert.deepEqual(await D.leer(doc), buf);
}));

test('sin volumen el archivo se queda en Mongo', async () => {
  delete process.env.ARCHIVOS_DIR; delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
  const buf = Buffer.from('foto');
  const doc = await D.guardar('grupoFotos', { data: buf });
  assert.equal(doc.data, buf);
  assert.equal(doc.disco, undefined);
  assert.equal(D.activo(), false);
});

test('documentos antiguos (aún en Mongo) se siguen leyendo; rutas raras se rechazan', () => conDir(async () => {
  assert.deepEqual(await D.leer({ data: new Binary(Buffer.from('viejo')) }), Buffer.from('viejo'));
  assert.equal(await D.leer({ disco: { ruta: '../etc/passwd' } }), null);
  assert.throws(() => D._ruta('../../x'));
}));

test('listar y borrarDe', () => conDir(async () => {
  const a = await D.guardar('vehiculoDocs', { data: Buffer.from('poliza') });
  const b = await D.guardar('vehiculoDocs', { data: Buffer.from('itv') });
  assert.equal((await D.listar()).length, 2);
  const db = { collection: () => ({ find: () => ({ project: () => ({ toArray: async () => [a] }) }) }) };
  assert.equal(await D.borrarDe(db, 'vehiculoDocs', { _id: a._id }), 1);
  assert.deepEqual((await D.listar()).map(f => f.ruta), [b.disco.ruta]);
}));
