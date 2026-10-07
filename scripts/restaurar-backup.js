#!/usr/bin/env node
// scripts/restaurar-backup.js — Restaura una copia de seguridad de Google Drive en una base de datos MongoDB.
//
// 1) Descarga de Drive la carpeta «Copias Corp Projects» (Diario/<fecha> y Archivos) a tu ordenador.
// 2) node scripts/restaurar-backup.js "<ruta a Copias Corp Projects>" <fecha AAAA-MM-DD> "<MONGO_URI destino>" [nombreBD]
//
// Restaura cada colección de Diario/<fecha>. Las de archivos (fotos, PDF) se rehacen juntando todos los trozos de
// Archivos/<colección> (hasta esa fecha) y aplicando encima sus datos del día (<colección>.meta.json.gz).
// Recomendado restaurar primero en una base de datos NUEVA y comprobar antes de apuntar el programa a ella.
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { MongoClient, BSON } = require('mongodb');
const [, , raiz, fecha, uri, nombreBD] = process.argv;
if (!raiz || !fecha || !uri) { console.log('Uso: node scripts/restaurar-backup.js "<carpeta Copias Corp Projects>" AAAA-MM-DD "<MONGO_URI>" [BD]'); process.exit(1); }
const leer = f => zlib.gunzipSync(fs.readFileSync(f)).toString('utf8').split('\n').filter(Boolean).map(l => BSON.EJSON.parse(l, { relaxed: false }));
(async () => {
  const cli = await MongoClient.connect(uri); const db = cli.db(nombreBD || undefined);
  const dia = path.join(raiz, 'Diario', fecha);
  const archivos = fs.readdirSync(dia).filter(f => f.endsWith('.json.gz'));
  const cols = {};
  for (const f of archivos) { const m = /^(.+?)(\.meta)?(?:_\d+)?\.json\.gz$/.exec(f); const c = m[1]; (cols[c] = cols[c] || { datos: [], meta: [] })[m[2] ? 'meta' : 'datos'].push(path.join(dia, f)); }
  for (const [c, x] of Object.entries(cols)) {
    if (x.meta.length) {
      const dir = path.join(raiz, 'Archivos', c); const docs = new Map();
      if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json.gz') && f.slice(0, 10) <= fecha).sort()) for (const d of leer(path.join(dir, f))) docs.set(String(d._id), d);
      for (const f of x.meta) for (const m of leer(f)) docs.set(String(m._id), { ...(docs.get(String(m._id)) || {}), ...m });
      const l = [...docs.values()]; if (l.length) await db.collection(c).insertMany(l, { ordered: false });
      console.log(`${c}: ${l.length} (con archivos)`);
    } else {
      let n = 0; for (const f of x.datos) { const l = leer(f); if (l.length) { await db.collection(c).insertMany(l, { ordered: false }); n += l.length; } }
      console.log(`${c}: ${n}`);
    }
  }
  await cli.close(); console.log('Restauración terminada.');
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
