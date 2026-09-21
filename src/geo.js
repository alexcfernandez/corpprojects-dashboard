// geo.js — Ubicación de las OBRAS (dirección → coordenadas) y distancias.
//
// Sirve para comparar dónde se ficha con dónde está la obra elegida. Es solo
// INFORMATIVO para oficina: nunca impide fichar.
//
// Geocodificador: Google si hay GOOGLE_MAPS_KEY; si no, Nominatim (OpenStreetMap,
// gratis, máx. 1 petición/segundo → cola). El resultado se GUARDA en la obra
// (`geo`), así que cada dirección se consulta una sola vez.
//
//   obra.geo = { lat, lng, fuente:'auto'|'manual'|'fichajes', direccion, etiqueta, at }
//   obra.geoIntento = dirección que ya se intentó sin éxito (para no repetir)

const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }

const RADIO_M = Number(process.env.FICHAJE_RADIO_OBRA_M) || 300;          // margen "está en la obra"
const ZONA = process.env.OBRA_GEO_ZONA || 'Girona';                       // se añade si la dirección no trae población
// Caja de preferencia (no excluyente) para Nominatim: provincia de Girona por defecto. lonO,latN,lonE,latS
const VIEWBOX = process.env.OBRA_GEO_VIEWBOX || '2.30,42.50,3.35,41.60';

function distanciaM(a, b) {
  if (!a || !b) return null;
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}
// "Lejos" = fuera del radio aun descontando el error del GPS del móvil (acotado).
function estaLejos(dist, acc) {
  if (dist == null) return false;
  return dist > RADIO_M + Math.min(Number(acc) || 0, 500);
}

// Acepta "41.9794, 2.8214" o un enlace de Google Maps (…/@41.97,2.82,17z · ?q=41.97,2.82 · !3d41.97!4d2.82)
function parseCoordenadas(txt) {
  const s = String(txt || '').trim(); if (!s) return null;
  const pats = [/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, /@(-?\d+\.\d+),(-?\d+\.\d+)/, /[?&](?:q|ll|query|destination)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)/i, /^\(?\s*(-?\d+(?:[.,]\d+)?)\s*[,; ]\s*(-?\d+(?:[.,]\d+)?)\s*\)?$/];
  for (const p of pats) {
    const m = p.exec(s); if (!m) continue;
    const lat = Number(String(m[1]).replace(',', '.')), lng = Number(String(m[2]).replace(',', '.'));
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat || lng)) return { lat, lng };
  }
  return null;
}

// ── Geocodificadores ─────────────────────────────────────────────
let _cola = Promise.resolve(), _ultimo = 0;
function enCola(fn) { // Nominatim: 1 petición por segundo como mucho
  const r = _cola.then(async () => {
    const espera = 1100 - (Date.now() - _ultimo); if (espera > 0) await new Promise(ok => setTimeout(ok, espera));
    try { return await fn(); } finally { _ultimo = Date.now(); }
  });
  _cola = r.catch(() => {}); return r;
}
async function _json(url, headers) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 10000);
  try { const r = await fetch(url, { headers, signal: c.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
async function _nominatim(q) {
  const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ q, format: 'jsonv2', limit: '1', countrycodes: 'es', viewbox: VIEWBOX, bounded: '0', 'accept-language': 'es' });
  const j = await enCola(() => _json(url, { 'User-Agent': 'corpprojects-dashboard/1.0 (' + (process.env.VAPID_SUBJECT || 'mailto:hola@corpprojects.es') + ')' }));
  const r = Array.isArray(j) && j[0]; if (!r) return null;
  return { lat: Number(r.lat), lng: Number(r.lon), etiqueta: r.display_name || '' };
}
async function _google(q) {
  const url = 'https://maps.googleapis.com/maps/api/geocode/json?' + new URLSearchParams({ address: q, region: 'es', language: 'es', key: process.env.GOOGLE_MAPS_KEY });
  const j = await _json(url); const r = j && j.results && j.results[0]; if (!r) return null;
  return { lat: r.geometry.location.lat, lng: r.geometry.location.lng, etiqueta: r.formatted_address || '' };
}
async function geocodificar(direccion) {
  const d = String(direccion || '').trim(); if (d.length < 5) return null;
  const buscar = process.env.GOOGLE_MAPS_KEY ? _google : _nominatim;
  // Sin población ("Carrer Gerani 24") se prueba primero con la zona habitual.
  const intentos = /,/.test(d) ? [d] : [`${d}, ${ZONA}`, d];
  for (const q of intentos) {
    try { const r = await buscar(q); if (r && Number.isFinite(r.lat) && Number.isFinite(r.lng)) return r; }
    catch (e) { console.warn('[Geo] geocodificar:', e.message); }
  }
  return null;
}

// ── Obras ────────────────────────────────────────────────────────
// Calcula y guarda la ubicación de una obra a partir de su dirección. No pisa una
// ubicación puesta A MANO salvo `forzar`. Devuelve el `geo` resultante (o null).
async function ubicarObra(obraId, { forzar = false } = {}) {
  const db = await getDB();
  const o = await db.collection('obras').findOne({ _id: new ObjectId(String(obraId)) }, { projection: { address: 1, geo: 1, geoIntento: 1 } });
  if (!o) return null;
  const dir = String(o.address || '').trim();
  if (!dir) return o.geo || null;
  if (!forzar) {
    if (o.geo && (o.geo.fuente !== 'auto' || o.geo.direccion === dir)) return o.geo;   // ya está (o es manual)
    if (o.geoIntento === dir) return null;                                              // ya se intentó y no salió
  }
  const r = await geocodificar(dir);
  if (!r) { await db.collection('obras').updateOne({ _id: o._id }, { $set: { geoIntento: dir } }); return null; }
  const geo = { lat: r.lat, lng: r.lng, fuente: 'auto', direccion: dir, etiqueta: r.etiqueta, at: new Date() };
  await db.collection('obras').updateOne({ _id: o._id }, { $set: { geo, geoIntento: null } });
  return geo;
}
async function fijarUbicacionObra(obraId, texto, por) {
  const c = parseCoordenadas(texto);
  if (!c) throw new Error('No he entendido la ubicación. Pega las coordenadas (41.9794, 2.8214) o el enlace de Google Maps.');
  const db = await getDB();
  const geo = { lat: c.lat, lng: c.lng, fuente: 'manual', direccion: null, etiqueta: '', por: por || '', at: new Date() };
  await db.collection('obras').updateOne({ _id: new ObjectId(String(obraId)) }, { $set: { geo } });
  return geo;
}
// La ubicación REAL de la obra según dónde se ha fichado la entrada (mediana: ignora despistes).
async function ubicarObraPorFichajes(obraId, por) {
  const db = await getDB();
  const ms = await db.collection('fichajeMarcas').find({ obraId: String(obraId), tipo: 'entrada', estado: 'valido' }).sort({ hora: -1 }).limit(60).toArray();
  const pts = ms.map(m => m.ubicacion).filter(u => u && Number.isFinite(u.lat) && Number.isFinite(u.lng) && (!u.acc || u.acc <= 150));
  if (pts.length < 3) throw new Error('Todavía hay pocos fichajes con ubicación en esta obra (hacen falta 3).');
  const med = a => { const s = [...a].sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
  const geo = { lat: med(pts.map(p => p.lat)), lng: med(pts.map(p => p.lng)), fuente: 'fichajes', direccion: null, etiqueta: `Según ${pts.length} fichajes`, por: por || '', at: new Date() };
  await db.collection('obras').updateOne({ _id: new ObjectId(String(obraId)) }, { $set: { geo } });
  return geo;
}
async function quitarUbicacionObra(obraId) {
  const db = await getDB();
  await db.collection('obras').updateOne({ _id: new ObjectId(String(obraId)) }, { $set: { geo: null, geoIntento: null } });
  return { ok: true };
}

// Al arrancar: ubica poco a poco las obras abiertas con dirección y sin coordenadas.
async function ubicarPendientes({ max = 40 } = {}) {
  const db = await getDB();
  const lista = await db.collection('obras').find({ status: { $in: ['activa', 'pausada'] }, address: { $nin: [null, ''] }, geo: { $in: [null] } })
    .project({ address: 1, geoIntento: 1 }).limit(max * 2).toArray();
  let ok = 0, n = 0;
  for (const o of lista) {
    if (o.geoIntento === String(o.address || '').trim()) continue;
    if (++n > max) break;
    if (await ubicarObra(o._id)) ok++;
  }
  if (n) console.log(`[Geo] Obras ubicadas por su dirección: ${ok}/${n}`);
  return { ok, n };
}

// Distancia de un punto a una obra. { dist, lejos } o null si no se puede saber.
async function compararConObra(obraId, loc) {
  if (!obraId || !loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return null;
  let o = null;
  try { o = await (await getDB()).collection('obras').findOne({ _id: new ObjectId(String(obraId)) }, { projection: { geo: 1 } }); } catch (e) { return null; }
  if (!o || !o.geo || !Number.isFinite(o.geo.lat)) return null;
  const dist = distanciaM(loc, o.geo);
  return { dist, lejos: estaLejos(dist, loc.acc) };
}

module.exports = { RADIO_M, distanciaM, estaLejos, parseCoordenadas, geocodificar, ubicarObra, fijarUbicacionObra, ubicarObraPorFichajes, quitarUbicacionObra, ubicarPendientes, compararConObra };
