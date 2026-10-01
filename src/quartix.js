// src/quartix.js — Posición de los vehículos con localizador Quartix (QWS v2).
//
// Credenciales en variables de entorno (las pone el dueño en Railway, nunca en el código):
//   QUARTIX_CUSTOMER_ID, QUARTIX_USER, QUARTIX_PASSWORD   (un usuario de Quartix solo para la API)
//   QUARTIX_URL (opcional, por defecto https://qws.quartix.net/v2/api — Europa)
// Autenticación: POST /auth → par de JWT (acceso + refresco). Las respuestas vienen en un sobre
// { Data, Meta: { Code, Message } }. Como la documentación de campos no es pública, la lectura de
// cada vehículo es tolerante a los nombres (Latitude/Lat, Registration/RegistrationNumber…) y
// /api/vehiculos/gps/diag enseña los nombres reales que devuelve para ajustarlo si hace falta.

const BASE = () => String(process.env.QUARTIX_URL || 'https://qws.quartix.net/v2/api').replace(/\/+$/, '');
const configurado = () => !!(process.env.QUARTIX_CUSTOMER_ID && process.env.QUARTIX_USER && process.env.QUARTIX_PASSWORD);

let _token = null, _tokenAt = 0, _cookie = '';
let _cache = null, _cacheAt = 0;
const CACHE_MS = 60 * 1000;
const TOKEN_MS = 20 * 60 * 1000;

function _campo(o, nombres) {
  if (!o || typeof o !== 'object') return undefined;
  const ks = Object.keys(o);
  for (const n of nombres) { const k = ks.find(x => x.toLowerCase() === n.toLowerCase()); if (k && o[k] != null && o[k] !== '') return o[k]; }
  return undefined;
}
function _sobre(j) {
  if (j && j.Meta && j.Meta.Code && j.Meta.Code >= 400) { const e = new Error('Quartix: ' + (j.Meta.Message || j.Meta.Code)); e.code = j.Meta.Code; throw e; }
  return j && 'Data' in j ? j.Data : j;
}

async function _auth() {
  const r = await fetch(BASE() + '/auth', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ CustomerID: process.env.QUARTIX_CUSTOMER_ID, UserName: process.env.QUARTIX_USER, Password: process.env.QUARTIX_PASSWORD, Application: process.env.QUARTIX_APP || 'CorpProjectsDashboard' }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => null);
  const d = _sobre(j);
  const tok = typeof d === 'string' ? d : _campo(d, ['AccessToken', 'AuthenticationToken', 'Token', 'access_token']);
  if (!tok) throw new Error('Quartix no devolvió token (revisa cliente, usuario y contraseña, y que la cuenta tenga acceso a la API)');
  const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  _cookie = sc.map(c => c.split(';')[0]).join('; ');
  _token = tok; _tokenAt = Date.now();
  return tok;
}

async function _get(ruta, reintento = true) {
  if (!configurado()) throw new Error('Quartix sin configurar');
  if (!_token || Date.now() - _tokenAt > TOKEN_MS) await _auth();
  const h = { Accept: 'application/json', AccessToken: _token, Authorization: 'Bearer ' + _token };
  if (_cookie) h.Cookie = _cookie;
  const r = await fetch(BASE() + ruta, { headers: h, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => null);
  if ((r.status === 401 || (j && j.Meta && j.Meta.Code === 401)) && reintento) { _token = null; return _get(ruta, false); }
  if (!r.ok && !(j && j.Meta)) throw new Error('Quartix HTTP ' + r.status);
  return _sobre(j);
}
const _lista = d => (Array.isArray(d) ? d : (d && (_campo(d, ['Vehicles', 'Items', 'Results', 'List']) || [])) || []);

function _posicion(x) {
  const pos = _campo(x, ['Position', 'LastPosition', 'Location']) || {};
  const de = (nombres) => { const v = _campo(x, nombres); return v !== undefined ? v : _campo(pos, nombres); };
  const lat = Number(de(['Latitude', 'Lat'])), lon = Number(de(['Longitude', 'Lon', 'Lng', 'Long']));
  const ign = de(['Ignition', 'IgnitionOn', 'EngineOn']);
  const vel = Number(de(['Speed', 'SpeedKph', 'SpeedKmh']));
  return {
    quartixId: String(de(['VehicleID', 'VehicleId', 'Id', 'ID']) ?? ''),
    registro: String(de(['Registration', 'RegistrationNumber', 'VehicleRegistration', 'Reg', 'VehicleName', 'Name']) ?? ''),
    lat: isFinite(lat) ? lat : null, lon: isFinite(lon) ? lon : null,
    velocidad: isFinite(vel) ? Math.round(vel) : null,
    rumbo: Number(de(['Heading', 'Direction', 'Bearing'])) || null,
    fecha: de(['DateTime', 'Timestamp', 'LastUpdate', 'LastUpdated', 'GpsTime', 'EventTime', 'Date']) || null,
    direccion: (() => { const a = de(['Address', 'LocationText', 'Location', 'Place', 'Street']); return typeof a === 'string' ? a : (a && typeof a === 'object' ? Object.values(a).filter(v => typeof v === 'string').join(', ') : ''); })(),
    km: (() => { const k = Number(de(['Odometer', 'OdometerKm', 'Mileage', 'Distance'])); return isFinite(k) && k > 0 ? Math.round(k) : null; })(),
    encendido: ign == null ? (isFinite(vel) ? vel > 0 : null) : !!ign && !/off|false|0/i.test(String(ign)),
    conductor: (() => { const c = de(['DriverName', 'Driver']); return typeof c === 'string' ? c : (c && _campo(c, ['Name', 'DriverName'])) || ''; })(),
  };
}

// Posición actual de todos los vehículos de la cuenta (caché 60 s para no machacar la API).
async function posiciones({ fresco = false } = {}) {
  if (!fresco && _cache && Date.now() - _cacheAt < CACHE_MS) return _cache;
  const d = await _get('/vehicles/live');
  _cache = _lista(d).map(_posicion).filter(p => p.quartixId || p.registro);
  _cacheAt = Date.now();
  return _cache;
}

// Une las posiciones con nuestra flota: por quartixId guardado o, si no, por matrícula.
async function mapa() {
  if (!configurado()) return { configurado: false, puntos: [], sinVincular: [] };
  const vehiculos = require('./vehiculos');
  const db = await require('./db').getDB();
  const [pos, vs] = await Promise.all([posiciones(), db.collection('vehiculos').find({ estado: 'activo' }).toArray()]);
  const usados = new Set();
  const puntos = vs.map(v => {
    let p = v.quartixId ? pos.find(x => x.quartixId === String(v.quartixId)) : null;
    if (!p && v.matricula) p = pos.find(x => vehiculos.matNorm(x.registro) === v.matricula);
    if (p) usados.add(p);
    return { id: String(v._id), nombre: v.nombre, matricula: v.matricula, conductor: v.conductor ? v.conductor.name : null, posicion: p || null };
  });
  return { configurado: true, actualizado: new Date(_cacheAt), puntos, sinVincular: pos.filter(p => !usados.has(p)) };
}

// Para la configuración inicial: ¿conecta? ¿qué campos devuelve?
async function diagnostico() {
  if (!configurado()) return { configurado: false, faltan: ['QUARTIX_CUSTOMER_ID', 'QUARTIX_USER', 'QUARTIX_PASSWORD'].filter(k => !process.env[k]) };
  try {
    _token = null;
    await _auth();
    const d = await _get('/vehicles/live');
    const l = _lista(d);
    return { configurado: true, ok: true, url: BASE(), vehiculos: l.length, campos: l[0] ? Object.keys(l[0]) : [], ejemplo: l[0] ? _posicion(l[0]) : null };
  } catch (e) { return { configurado: true, ok: false, url: BASE(), error: e.message }; }
}

module.exports = { configurado, posiciones, mapa, diagnostico, _posicion };
