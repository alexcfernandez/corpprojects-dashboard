// src/fichajes.js — Registro de jornada (fichaje entrada/salida) de los trabajadores.
// OBLIGATORIO por ley en España (RD-ley 8/2019). Es DISTINTO del cronómetro por
// obra (workOrderTimers): esto es la jornada laboral de la persona, no de un trabajo.
//
// Modelo: un documento por trabajador y día:
//   { empresaId, userId, userName, fecha:'YYYY-MM-DD',
//     tramos:[{entrada:Date, salida:Date|null}], updatedAt }
// Cada "Fichar" alterna: si hay un tramo abierto lo cierra (salida); si no, abre
// uno nuevo (entrada). Las pausas = salir y volver a entrar (varios tramos). Las
// horas del día = suma de todos los tramos. Datos siempre desde `users`.
const EMPRESA = process.env.EMPRESA_ID || 'corp';
async function getDB() { return require('./db').getDB(); }

// Fecha de HOY en Europe/Madrid (en-CA da formato ISO YYYY-MM-DD).
function fechaHoy() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
}
function minutosDe(tramos) {
  let m = 0; const now = Date.now();
  (tramos || []).forEach(t => {
    if (!t || !t.entrada) return;
    const ini = new Date(t.entrada).getTime();
    const fin = t.salida ? new Date(t.salida).getTime() : now;
    if (fin > ini) m += (fin - ini) / 60000;
  });
  return Math.round(m);
}
function estadoDe(doc) {
  const tramos = (doc && doc.tramos) || [];
  const ultimo = tramos[tramos.length - 1];
  const dentro = !!(ultimo && !ultimo.salida);
  return {
    dentro,
    desde:   dentro ? ultimo.entrada : null,
    minutos: minutosDe(tramos),
    tramos,
    fecha:   (doc && doc.fecha) || fechaHoy(),
  };
}

async function estadoActual(userId, fecha) {
  const db = await getDB();
  const f = fecha || fechaHoy();
  const doc = await db.collection('fichajes').findOne({ empresaId: EMPRESA, userId: String(userId), fecha: f });
  return estadoDe(doc || { fecha: f });
}

// Normaliza la ubicación recibida del móvil a {lat,lng,acc} o null.
function limpiarLoc(loc) {
  if (!loc) return null;
  const lat = Number(loc.lat), lng = Number(loc.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, acc: Number(loc.acc) || null };
}

// Alterna entrada/salida. Devuelve la acción y el nuevo estado.
// loc = ubicación GPS opcional del momento de fichar {lat,lng,acc}.
async function fichar(userId, userName, loc) {
  const db = await getDB();
  const fecha = fechaHoy();
  const now = new Date();
  const ubi = limpiarLoc(loc);
  const doc = await db.collection('fichajes').findOne({ empresaId: EMPRESA, userId: String(userId), fecha });
  const tramos = (doc && Array.isArray(doc.tramos)) ? doc.tramos : [];
  const ultimo = tramos[tramos.length - 1];
  const abierto = !!(ultimo && !ultimo.salida);

  let accion;
  if (abierto) { ultimo.salida = now; ultimo.salidaLoc = ubi; accion = 'salida'; }
  else { tramos.push({ entrada: now, salida: null, entradaLoc: ubi }); accion = 'entrada'; }

  await db.collection('fichajes').updateOne(
    { empresaId: EMPRESA, userId: String(userId), fecha },
    { $set: { tramos, userName: userName || (doc && doc.userName) || '', updatedAt: now },
      $setOnInsert: { empresaId: EMPRESA, userId: String(userId), fecha, createdAt: now } },
    { upsert: true }
  );

  // Al fichar la PRIMERA entrada del día, reflejamos su presencia (sin pisar lo
  // que ya hubiera del parte o lo puesto a mano por el admin).
  if (accion === 'entrada' && tramos.length === 1) {
    try { await require('./attendance').marcarPresenciaFichaje(String(userId), userName, fecha); }
    catch (e) { console.warn('[Fichaje] marcarPresencia:', e.message); }
  }
  return { accion, ...estadoDe({ tramos, fecha }) };
}

// Todos los fichajes de un día (para el admin). Enriquecido con minutos.
async function getFichajesDia(fecha) {
  const db = await getDB();
  const f = fecha || fechaHoy();
  const docs = await db.collection('fichajes').find({ empresaId: EMPRESA, fecha: f }).toArray();
  return docs.map(d => ({ ...d, ...estadoDe(d) })).sort((a, b) => String(a.userName).localeCompare(String(b.userName)));
}
// Historial de un trabajador entre fechas.
async function getFichajesTrabajador(userId, from, to) {
  const db = await getDB();
  const q = { empresaId: EMPRESA, userId: String(userId) };
  if (from || to) { q.fecha = {}; if (from) q.fecha.$gte = from; if (to) q.fecha.$lte = to; }
  const docs = await db.collection('fichajes').find(q).sort({ fecha: -1 }).toArray();
  return docs.map(d => ({ ...d, ...estadoDe(d) }));
}

module.exports = { fichar, estadoActual, getFichajesDia, getFichajesTrabajador, fechaHoy };
