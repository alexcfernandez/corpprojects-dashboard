#!/usr/bin/env node
// scripts/archivos-a-disco.js — Pasa las fotos y PDF que ya había en Mongo al disco del servidor (src/archivosDisco.js).
//
// Se ejecuta DENTRO del servidor (donde está el volumen):  railway ssh -s corpprojects-dashboard -- node scripts/archivos-a-disco.js <paso>
//
//   estado    → cuántos archivos hay en Mongo, cuántos en disco y cuánto ocupan. No cambia nada.
//   copiar    → escribe cada archivo en el disco (relee y comprueba el SHA-256) y apunta `disco` en el documento.
//               NO quita nada de Mongo: mientras el documento tenga `data`, se sigue leyendo de Mongo.
//   verificar → vuelve a leer TODOS los archivos del disco y los compara byte a byte (SHA-256) con lo de Mongo.
//   vaciar --si-he-comprobado
//             → solo para los que vuelven a cuadrar en ese momento: quita `data` (y el trozo de GridFS) de Mongo.
//               Si uno no cuadra, se deja como está y sale en la lista.
'use strict';
const path = require('path');
const { MongoClient, GridFSBucket } = require('mongodb');
const disco = require(path.join(__dirname, '..', 'src/archivosDisco.js'));

const COLS = ['docsPersonal', 'comprasFotos', 'grupoFotos', 'vehiculoDocs'];
const paso = process.argv[2];
const MB = n => (n / 1e6).toFixed(1) + ' MB';

async function contenidoMongo(db, col, d) {
  if (d.data != null) return Buffer.from(d.data.buffer || d.data);
  if (col === 'docsPersonal' && d.gridId) {
    const b = new GridFSBucket(db, { bucketName: 'docsPersonalArchivos' }), trozos = [];
    await new Promise((ok, ko) => b.openDownloadStream(d.gridId).on('data', c => trozos.push(c)).on('error', ko).on('end', ok));
    return Buffer.concat(trozos);
  }
  return null;
}
const enMongo = { $or: [{ data: { $exists: true, $ne: null } }, { gridId: { $exists: true, $ne: null } }] };

(async () => {
  if (!['estado', 'copiar', 'verificar', 'vaciar'].includes(paso)) { console.log('Uso: node scripts/archivos-a-disco.js estado|copiar|verificar|vaciar --si-he-comprobado'); process.exit(1); }
  if (!disco.activo()) { console.error('No hay volumen (RAILWAY_VOLUME_MOUNT_PATH / ARCHIVOS_DIR): esto hay que ejecutarlo en el servidor.'); process.exit(1); }
  if (paso === 'vaciar' && !process.argv.includes('--si-he-comprobado')) { console.error('Para vaciar hace falta --si-he-comprobado (y antes «verificar» sin fallos).'); process.exit(1); }
  const client = await MongoClient.connect(process.env.MONGODB_URI);
  const db = client.db('corpprojects');
  const resumen = [];
  try {
    for (const col of COLS) {
      const c = db.collection(col);
      if (paso === 'estado') {
        const [total, mongo, enDisco] = await Promise.all([c.countDocuments({}), c.countDocuments(enMongo), c.countDocuments({ disco: { $exists: true } })]);
        const st = await db.command({ collStats: col });
        resumen.push({ col, total, enMongo: mongo, enDisco, mongoMB: MB(st.size) });
        continue;
      }
      const r = { col, ok: 0, mal: [], vaciados: 0, liberado: 0 };
      const q = paso === 'copiar' ? { ...enMongo, disco: { $exists: false } } : { disco: { $exists: true } };
      const ids = (await c.find(q).project({ _id: 1 }).toArray()).map(d => d._id);
      for (const _id of ids) {                                     // de uno en uno: no cargar 130 MB en memoria
        const d = await c.findOne({ _id });
        try {
          const enM = await contenidoMongo(db, col, d);
          if (paso === 'copiar') {
            if (!enM) continue;
            const ref = await disco.escribir(col, String(_id), enM);
            await c.updateOne({ _id }, { $set: { disco: ref } });
            r.ok++; continue;
          }
          const enD = await disco.leer({ disco: d.disco });
          const cuadra = enD && enD.length === d.disco.bytes && disco.sha(enD) === d.disco.sha256 && (!enM || disco.sha(enM) === d.disco.sha256);
          if (!cuadra) { r.mal.push(String(_id)); continue; }
          r.ok++;
          if (paso === 'vaciar' && enM) {
            if (d.gridId) await new GridFSBucket(db, { bucketName: 'docsPersonalArchivos' }).delete(d.gridId);
            await c.updateOne({ _id, 'disco.sha256': d.disco.sha256 }, { $unset: { data: '', gridId: '' } });
            r.vaciados++; r.liberado += enM.length;
          }
        } catch (e) { r.mal.push(`${_id} (${e.message})`); }
      }
      resumen.push({ col, revisados: ids.length, ok: r.ok, mal: r.mal.length, ...(paso === 'vaciar' ? { vaciados: r.vaciados, liberado: MB(r.liberado) } : {}) });
      if (r.mal.length) console.log(`${col}: NO cuadran → ${r.mal.slice(0, 20).join(', ')}${r.mal.length > 20 ? '…' : ''}`);
    }
    console.table(resumen);
    const f = await disco.listar();
    console.log(`Disco: ${f.length} archivos, ${MB(f.reduce((s, x) => s + x.bytes, 0))}`);
  } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
