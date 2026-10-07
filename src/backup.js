// src/backup.js — COPIAS DE SEGURIDAD de todo el programa en Google Drive (cada noche).
//
// Si algún día pasa algo con el servidor o la base de datos, aquí está todo para recuperarlo:
//   Drive / «Copias Corp Projects» /
//      Diario/AAAA-MM-DD/<colección>.json.gz   ← copia COMPLETA de cada colección (datos, sin archivos pesados)
//      Archivos/<colección>/<desde>_<n>.json.gz ← fotos y PDF (compras, nóminas, vehículos…): solo lo nuevo de
//                                                 cada noche, así el Drive no se llena con lo mismo cada día
// Se guardan 14 días de copias diarias y la del día 1 de cada mes durante 12 meses.
// Formato: EJSON (el de MongoDB: conserva fechas, ids y binarios) comprimido; se restaura con
// `node scripts/restaurar-backup.js <carpeta> <MONGO_URI>`.
//
// Drive se autoriza una vez (dueño): /api/backup/drive/conectar → Google → /auth/google/callback (state «backup:»).
// El token se guarda en la colección `config` (_id 'driveBackup'); no hace falta tocar variables de Railway.
'use strict';
const zlib = require('zlib');
const crypto = require('crypto');
const { BSON } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const CARPETA = process.env.BACKUP_CARPETA || 'Copias Corp Projects';
// Colecciones con archivos (fotos, PDF): copia incremental por _id.
const PESADAS = new Set(['comprasFotos', 'docsPersonal', 'vehiculoDocs', 'documentosArchivos', 'fotos', 'partesFotos', 'medicionesFotos', 'obraFotos']);
const NO_COPIAR = new Set(['sessions', 'worker_tokens', 'bancoAuthPendiente']);
const TROZO = 40 * 1024 * 1024;   // ~40 MB por archivo de Drive

function _oauth() {
  const { google } = require('googleapis');
  return new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET, process.env.GMAIL_REDIRECT_URI);
}
async function urlConectar() {
  const db = await getDB();
  const state = 'backup:' + crypto.randomBytes(12).toString('hex');
  await db.collection('config').updateOne({ _id: 'driveBackupState' }, { $set: { state, at: new Date() } }, { upsert: true });
  return _oauth().generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/userinfo.email'], state });
}
async function callback(code, state) {
  const db = await getDB();
  const st = await db.collection('config').findOne({ _id: 'driveBackupState' });
  if (!st || st.state !== state || Date.now() - new Date(st.at).getTime() > 30 * 60000) throw new Error('El enlace ha caducado: vuelve a pulsar «Conectar Drive»');
  const o = _oauth();
  const { tokens } = await o.getToken(code);
  if (!tokens.refresh_token) throw new Error('Google no devolvió permiso permanente: vuelve a intentarlo');
  o.setCredentials(tokens);
  let email = null; try { const { google } = require('googleapis'); email = (await google.oauth2({ version: 'v2', auth: o }).userinfo.get()).data.email; } catch (e) {}
  await db.collection('config').updateOne({ _id: 'driveBackup' }, { $set: { refreshToken: tokens.refresh_token, email, conectadoAt: new Date() } }, { upsert: true });
  await db.collection('config').deleteOne({ _id: 'driveBackupState' });
  return { email };
}
async function _drive() {
  const db = await getDB();
  const c = await db.collection('config').findOne({ _id: 'driveBackup' });
  if (!c || !c.refreshToken) throw new Error('Drive sin conectar (Copias de seguridad → «Conectar Drive»)');
  const o = _oauth(); o.setCredentials({ refresh_token: c.refreshToken });
  return require('googleapis').google.drive({ version: 'v3', auth: o });
}
async function _carpeta(drive, nombre, padre) {
  const q = `mimeType='application/vnd.google-apps.folder' and name='${nombre.replace(/'/g, "\\'")}' and trashed=false` + (padre ? ` and '${padre}' in parents` : '');
  const r = await drive.files.list({ q, fields: 'files(id,name)', spaces: 'drive' });
  if (r.data.files && r.data.files[0]) return r.data.files[0].id;
  const c = await drive.files.create({ requestBody: { name: nombre, mimeType: 'application/vnd.google-apps.folder', parents: padre ? [padre] : undefined }, fields: 'id' });
  return c.data.id;
}
async function _subir(drive, padre, nombre, buf) {
  const { Readable } = require('stream');
  await drive.files.create({ requestBody: { name: nombre, parents: [padre] }, media: { mimeType: 'application/gzip', body: Readable.from(buf) }, fields: 'id' });
}
// Una colección a uno o varios .json.gz (una línea EJSON por documento).
async function _volcar(cursor, alTrozo) {
  let partes = [], tam = 0, n = 0, total = 0;
  const cerrar = async () => { if (!partes.length) return; await alTrozo(zlib.gzipSync(Buffer.from(partes.join('\n'))), n++); partes = []; tam = 0; };
  for await (const d of cursor) { const l = BSON.EJSON.stringify(d, { relaxed: false }); partes.push(l); tam += l.length; total++; if (tam >= TROZO) await cerrar(); }
  await cerrar();
  return total;
}

let _enCurso = false;
async function hacerCopia({ por = 'automática' } = {}) {
  if (_enCurso) return { enCurso: true };
  _enCurso = true;
  const db = await getDB();
  const inicio = new Date(), hoy = inicio.toISOString().slice(0, 10);
  const log = { inicio, por, colecciones: [], error: null };
  try {
    const drive = await _drive();
    const raiz = await _carpeta(drive, CARPETA);
    const diario = await _carpeta(drive, hoy, await _carpeta(drive, 'Diario', raiz));
    const archivos = await _carpeta(drive, 'Archivos', raiz);
    const estado = (await db.collection('config').findOne({ _id: 'backupEstado' })) || { ultimoId: {} };
    const cols = (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).filter(n => !NO_COPIAR.has(n) && !n.startsWith('system.'));
    for (const nombre of cols) {
      try {
        if (PESADAS.has(nombre)) {
          const desde = estado.ultimoId[nombre];
          const q = desde ? { _id: { $gt: BSON.EJSON.parse(desde) } } : {};
          let ultimo = null;
          const carpeta = await _carpeta(drive, nombre, archivos);
          const cur = db.collection(nombre).find(q).sort({ _id: 1 });
          const total = await _volcar({ [Symbol.asyncIterator]: async function* () { for await (const d of cur) { ultimo = d._id; yield d; } } }, (buf, i) => _subir(drive, carpeta, `${hoy}_${i}.json.gz`, buf));
          if (ultimo != null) estado.ultimoId[nombre] = BSON.EJSON.stringify(ultimo);
          // Y cada noche, todos sus datos SIN el archivo (estado, importes, a quién es…), por si han cambiado.
          const meta = await _volcar(db.collection(nombre).find({}).project({ data: 0 }), (buf, i) => _subir(drive, diario, `${nombre}.meta${i ? '_' + i : ''}.json.gz`, buf));
          log.colecciones.push({ nombre, nuevos: total, docs: meta, incremental: true });
        } else {
          const total = await _volcar(db.collection(nombre).find({}), (buf, i) => _subir(drive, diario, `${nombre}${i ? '_' + i : ''}.json.gz`, buf));
          log.colecciones.push({ nombre, docs: total });
        }
      } catch (e) { log.colecciones.push({ nombre, error: e.message }); }
    }
    await db.collection('config').updateOne({ _id: 'backupEstado' }, { $set: { ultimoId: estado.ultimoId, ultimaCopia: new Date() } }, { upsert: true });
    await _limpiar(drive, raiz).catch(e => console.warn('[Backup] limpieza:', e.message));
  } catch (e) { log.error = e.message; }
  finally { _enCurso = false; }
  log.fin = new Date(); log.segundos = Math.round((log.fin - inicio) / 1000);
  log.ok = !log.error && !log.colecciones.some(c => c.error);
  await db.collection('backupLog').insertOne(log).catch(() => {});
  console.log(`[Backup] ${log.ok ? 'OK' : 'CON ERRORES'} · ${log.colecciones.length} colecciones · ${log.segundos}s${log.error ? ' · ' + log.error : ''}`);
  if (!log.ok) { try { await require('./push').sendToOficina({ title: '⚠️ Copia de seguridad con errores', body: (log.error || log.colecciones.filter(c => c.error).map(c => c.nombre + ': ' + c.error).join(' · ')).slice(0, 140), url: '/copias' }); } catch (e) {} }
  return log;
}
// Diarias: 14 días; mensuales (día 01): 12 meses.
async function _limpiar(drive, raiz) {
  const diario = await _carpeta(drive, 'Diario', raiz);
  const r = await drive.files.list({ q: `'${diario}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder'`, fields: 'files(id,name)', pageSize: 500 });
  const hoy = Date.now();
  for (const f of r.data.files || []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.name)) continue;
    const dias = (hoy - new Date(f.name + 'T00:00:00Z').getTime()) / 86400000;
    const mensual = f.name.endsWith('-01');
    if ((mensual && dias > 370) || (!mensual && dias > 14)) await drive.files.delete({ fileId: f.id });
  }
}
async function estado() {
  const db = await getDB();
  const [c, ult] = await Promise.all([db.collection('config').findOne({ _id: 'driveBackup' }), db.collection('backupLog').find({}).sort({ inicio: -1 }).limit(10).toArray()]);
  return { drive: c ? { conectado: !!c.refreshToken, email: c.email || null, desde: c.conectadoAt } : { conectado: false }, carpeta: CARPETA, enCurso: _enCurso,
    copias: ult.map(l => ({ inicio: l.inicio, ok: l.ok, segundos: l.segundos, error: l.error, colecciones: (l.colecciones || []).length, conError: (l.colecciones || []).filter(x => x.error).map(x => x.nombre), por: l.por })) };
}

module.exports = { urlConectar, callback, hacerCopia, estado };
