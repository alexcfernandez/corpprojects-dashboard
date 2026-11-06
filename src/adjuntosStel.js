// src/adjuntosStel.js — Las fotos de las peticiones, adjuntas en StelOrder (6/11/2026, Álex: «las fotos y todo, que las
// ponga, las adjunte en todo lo posible, en StelOrder»).
// Cada foto de una petición (fotoIds → grupoFotos) se sube a su incidencia y, cuando tiene pedido, también al pedido.
// Lo subido queda en la petición (`fotosStel: { inc: [fotoId], ped: [fotoId] }`) para no repetir. Se llama al crear la
// incidencia y el pedido, y un cron recoge lo que llegue después (fotos que mandan más tarde al grupo).
// Se apaga con ADJUNTOS_STEL=off.
'use strict';
const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const DIAS = 14, MAX_FOTOS = 10;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf', 'video/mp4': 'mp4' };

// Sube lo que falte de una petición. Devuelve cuántas fotos se han subido a cada sitio.
async function subir(p, { _db = null, _stel = null, por = 'Corpy' } = {}) {
  if (process.env.ADJUNTOS_STEL === 'off') return { apagado: true };
  const db = _db || await getDB();
  if (!p || !(p.fotoIds || []).length) return { inc: 0, ped: 0 };
  const hechas = p.fotosStel || {};
  const destinos = [
    p.incidenciaId && { clave: 'inc', tipo: 'INCIDENT', id: p.incidenciaId, ref: p.incidencia },
    p.pedido && p.pedido.id && { clave: 'ped', tipo: 'WORKORDER', id: p.pedido.id, ref: p.pedido.ref },
  ].filter(Boolean);
  const faltan = d => (p.fotoIds || []).slice(0, MAX_FOTOS).filter(f => !(hechas[d.clave] || []).includes(String(f)));
  const ids = [...new Set(destinos.flatMap(faltan))].filter(f => ObjectId.isValid(String(f)));
  const res = { inc: 0, ped: 0 };
  if (!ids.length) return res;
  const fotos = await require('./archivosDisco').hidratar(await db.collection('grupoFotos').find({ _id: { $in: ids.map(f => new ObjectId(String(f))) } }).toArray());
  const S = _stel || require('./stelorder');
  for (const d of destinos) {
    for (const fid of faltan(d)) {
      const f = fotos.find(x => String(x._id) === String(fid));
      if (!f || !f.data) continue;
      const fecha = new Date(f.ts || Date.now()).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
      const nombre = `${d.ref || d.tipo} ${fecha} ${String(f.quien || 'foto').replace(/[^\p{L}\p{N} ]/gu, '').slice(0, 30).trim()} ${String(fid).slice(-4)}.${EXT[f.mimetype] || 'jpg'}`;
      try {
        await S.adjuntar({ entityType: d.tipo, entityId: d.id, data: Buffer.from(f.data.buffer || f.data), nombre, requestedBy: `${por} (fotos de la petición)` });
        await db.collection('peticionesGrupo').updateOne({ _id: p._id }, { $addToSet: { [`fotosStel.${d.clave}`]: String(fid) } });
        (hechas[d.clave] = hechas[d.clave] || []).push(String(fid));
        res[d.clave]++;
      } catch (e) { console.warn('[AdjuntosStel]', d.ref, e.message); return { ...res, error: e.message }; }
    }
  }
  return res;
}

async function subirPorId(id, opts = {}) {
  if (!ObjectId.isValid(String(id))) return null;
  const db = opts._db || await getDB();
  return subir(await db.collection('peticionesGrupo').findOne({ _id: new ObjectId(String(id)) }), { ...opts, _db: db });
}

// Cron: peticiones recientes con incidencia y fotos que aún no están todas en StelOrder.
async function revisar({ _db = null, _stel = null } = {}) {
  if (process.env.ADJUNTOS_STEL === 'off') return { apagado: true };
  const db = _db || await getDB();
  const ps = await db.collection('peticionesGrupo').find({ incidenciaId: { $nin: [null, ''] }, 'fotoIds.0': { $exists: true }, fecha: { $gte: new Date(Date.now() - DIAS * 86400000) } }).toArray();
  const out = [];
  for (const p of ps) {
    const n = Math.min((p.fotoIds || []).length, MAX_FOTOS);
    const listo = (p.fotosStel && p.fotosStel.inc || []).length >= n && (!(p.pedido && p.pedido.id) || (p.fotosStel && p.fotosStel.ped || []).length >= n);
    if (listo) continue;
    const r = await subir(p, { _db: db, _stel });
    if (r.inc || r.ped || r.error) out.push({ incidencia: p.incidencia, ...r });
    if (r.error) break;   // StelOrder no contesta o está en pausa: la próxima vuelta
  }
  return out;
}

module.exports = { subir, subirPorId, revisar };
