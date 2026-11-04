// src/archivosDisco.js — FOTOS Y PDF FUERA DE MONGO (4/11/2026).
//
// El clúster gratis de Atlas tiene 512 MB y casi todo eran archivos (nóminas, tickets, fotos de grupos, papeles de
// las furgonetas). Ahora el archivo va al disco del servidor (volumen de Railway montado en /data) y en Mongo queda
// solo la referencia:   disco: { ruta: '<colección>/<id>', sha256, bytes, at }
//
//   · guardar  → antes de insertar: escribe el archivo, lo relee y comprueba el SHA-256; si todo va bien quita `data`
//                del documento. Si no hay volumen o algo falla, el archivo se queda en Mongo como antes (nunca se pierde).
//   · hidratar → después de leer: si el documento tiene `disco` y no `data`, rellena `data` desde el disco con el mismo
//                tipo (Binary) que da Mongo, así el resto del código no cambia.
//   · borrarDe → antes de borrar registros: borra también sus archivos del disco.
//
// (No confundir con almacen.js, que es el stock de material.)
// Copia: backup.js sube cada noche a Drive los archivos nuevos del disco (carpeta «Archivos/disco»).
// Pasar lo que ya había en Mongo: scripts/archivos-a-disco.js (copiar → verificar → y solo con OK, vaciar).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Solo con un volumen de verdad: sin él, /data sería del contenedor y se perdería en cada despliegue.
function raiz() {
  const base = process.env.ARCHIVOS_DIR || (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'archivos') : null);
  if (!base) return null;
  try { fs.mkdirSync(base, { recursive: true }); return base; } catch (e) { return null; }
}
const activo = () => !!raiz();
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const _seguro = s => /^[A-Za-z0-9_-]+$/.test(String(s));
function _ruta(rel) {
  const [col, id] = String(rel || '').split('/');
  if (!_seguro(col) || !_seguro(id)) throw new Error('Ruta de archivo no válida');
  return path.join(raiz(), col, id);
}
const _buf = d => (d == null ? null : Buffer.isBuffer(d) ? d : ArrayBuffer.isView(d) ? Buffer.from(d.buffer, d.byteOffset, d.byteLength) : d.buffer ? _buf(d.buffer) : Buffer.from(d));

// Escribe el contenido en <colección>/<id> y lo comprueba. Devuelve la referencia o null.
async function escribir(col, id, contenido) {
  if (!activo()) return null;
  const buf = _buf(contenido); if (!buf || !buf.length) return null;
  const rel = `${col}/${id}`, f = _ruta(rel), tmp = f + '.tmp';
  await fs.promises.mkdir(path.dirname(f), { recursive: true });
  const h = sha(buf);
  await fs.promises.writeFile(tmp, buf);
  const vuelta = await fs.promises.readFile(tmp);
  if (vuelta.length !== buf.length || sha(vuelta) !== h) { await fs.promises.unlink(tmp).catch(() => {}); throw new Error('El archivo no se escribió bien'); }
  await fs.promises.rename(tmp, f);
  return { ruta: rel, sha256: h, bytes: buf.length, at: new Date() };
}

// Antes de insertar: saca `data` al disco. Pone _id si no lo tiene (hace falta para el nombre del archivo).
async function guardar(col, doc) {
  if (!doc || doc.data == null || !activo()) return doc;
  try {
    if (!doc._id) doc._id = new (require('mongodb').ObjectId)();
    const ref = await escribir(col, String(doc._id), doc.data);
    if (ref) { doc.disco = ref; delete doc.data; }
  } catch (e) { console.warn(`[Disco] ${col}: se queda en Mongo (${e.message})`); }
  return doc;
}

// El contenido de un documento: del disco o, si aún no se ha pasado, de Mongo.
async function leer(doc) {
  if (!doc) return null;
  if (doc.data != null) return _buf(doc.data);
  if (doc.disco && doc.disco.ruta && raiz()) {
    try { return await fs.promises.readFile(_ruta(doc.disco.ruta)); }
    catch (e) { console.warn(`[Disco] no se encuentra ${doc.disco.ruta}: ${e.message}`); }
  }
  return null;
}

// Después de leer: rellena `data` (como Binary, igual que Mongo) para que el código de siempre funcione.
async function hidratar(docs) {
  const lista = Array.isArray(docs) ? docs : [docs];
  for (const d of lista) {
    if (!d || d.data != null || !d.disco) continue;
    const buf = await leer(d);
    if (buf) d.data = new (require('mongodb').Binary)(buf);
  }
  return docs;
}

// Antes de borrar registros de Mongo: sus archivos del disco también.
async function borrarDe(db, col, filtro) {
  if (!raiz()) return 0;
  let n = 0;
  for (const d of await db.collection(col).find({ ...filtro, disco: { $exists: true } }).project({ disco: 1 }).toArray()) {
    try { await fs.promises.unlink(_ruta(d.disco.ruta)); n++; } catch (e) {}
  }
  return n;
}

// Todos los archivos del disco (para la copia a Drive y las comprobaciones).
async function listar() {
  const base = raiz(); if (!base) return [];
  const out = [];
  for (const col of await fs.promises.readdir(base).catch(() => [])) {
    if (!_seguro(col)) continue;
    for (const id of await fs.promises.readdir(path.join(base, col)).catch(() => [])) {
      if (!_seguro(id)) continue;
      const st = await fs.promises.stat(path.join(base, col, id)).catch(() => null);
      if (st && st.isFile()) out.push({ ruta: `${col}/${id}`, bytes: st.size, mtime: st.mtime });
    }
  }
  return out;
}

module.exports = { activo, raiz, sha, escribir, guardar, leer, hidratar, borrarDe, listar, _ruta };
