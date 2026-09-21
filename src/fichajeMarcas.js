// src/fichajeMarcas.js — Registro de jornada LEGAL (RD-ley 8/2019), modelo APPEND-ONLY.
//
// A diferencia del viejo `fichajes` (un doc/día con tramos que se MODIFICAN), aquí
// cada marca es un DOCUMENTO NUEVO que NO se borra ni se toca. Corregir = otra marca
// que apunta a la original (corrigeA + motivo + aprobadoPor). Eso da validez ante
// Inspección. Los "tramos/horas" se RECONSTRUYEN al vuelo desde las marcas.
//
// Fase 1: marcar (4 estados tipados), estado actual, día (admin), mis marcas, migración.

const EMPRESA = process.env.EMPRESA_ID || 'corp';
const COL = 'fichajeMarcas';
const TIPOS = ['entrada', 'pausa_inicio', 'pausa_fin', 'salida'];

async function getDB() { return require('./db').getDB(); }

// Fecha de HOY en Europe/Madrid (YYYY-MM-DD).
// Una marca offline más vieja que esto ya no entra sola: tiene que ir por corrección.
const OFFLINE_MAX_DIAS = Number(process.env.FICHAJE_OFFLINE_MAX_DIAS) || 7;

function fechaHoy() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
}
function fechaDe(d) {
  return new Date(d).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
}
function limpiarLoc(loc) {
  if (!loc) return null;
  const lat = Number(loc.lat), lng = Number(loc.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, acc: Number(loc.acc) || null };
}

// ── RECONSTRUCCIÓN ────────────────────────────────────────────────
// De las marcas VÁLIDAS de un día (ordenadas por hora) saca:
//  · tramos [{entrada,salida,entradaLoc,salidaLoc}] = intervalos TRABAJANDO
//    (una pausa parte el tramo, igual que el viejo "salir y volver")
//  · minutos trabajados (excluye pausas)
//  · estado: 'fuera' | 'dentro' | 'pausa', y desde (inicio del tramo abierto)
//  · obraId de la jornada (de la entrada)
function reconstruir(marcasRaw, fecha) {
  // Solo cuentan las marcas VÁLIDAS (una corrección pendiente o rechazada no cuenta).
  const validas = (marcasRaw || []).filter(m => m && (m.estado || 'valido') === 'valido' && TIPOS.includes(m.tipo) && m.hora);
  // Una corrección aprobada SUSTITUYE a la marca que corrige: la original sigue en la
  // BD intacta (registro legal), pero deja de contar en el cálculo.
  const sustituidas = new Set(validas.filter(m => m.corrigeA).map(m => String(m.corrigeA)));
  const marcas = validas
    .filter(m => !sustituidas.has(String(m._id)))
    .slice()
    .sort((a, b) => new Date(a.hora) - new Date(b.hora));
  const esDiaPasado = !!fecha && fecha < fechaHoy();

  const tramos = [];
  let abierto = null;      // tramo trabajando en curso
  let estado = 'fuera';    // fuera | dentro | pausa
  let obraId = null;

  for (const m of marcas) {
    if (m.tipo === 'entrada') {
      if (!abierto) { abierto = { entrada: m.hora, salida: null, entradaLoc: m.ubicacion || null, salidaLoc: null }; }
      if (m.obraId) obraId = m.obraId;
      estado = 'dentro';
    } else if (m.tipo === 'pausa_inicio') {
      if (abierto) { abierto.salida = m.hora; abierto.salidaLoc = m.ubicacion || null; tramos.push(abierto); abierto = null; }
      estado = 'pausa';
    } else if (m.tipo === 'pausa_fin') {
      if (!abierto) { abierto = { entrada: m.hora, salida: null, entradaLoc: m.ubicacion || null, salidaLoc: null }; }
      estado = 'dentro';
    } else if (m.tipo === 'salida') {
      if (abierto) { abierto.salida = m.hora; abierto.salidaLoc = m.ubicacion || null; tramos.push(abierto); abierto = null; }
      estado = 'fuera';
    }
  }
  if (abierto) tramos.push(abierto); // tramo aún sin cerrar

  let min = 0; const now = Date.now();
  for (const t of tramos) {
    const ini = new Date(t.entrada).getTime();
    // Tramo abierto: HOY cuenta hasta ahora; en un día PASADO no se inventan horas
    // (se olvidó de salir) → 0 y se marca `sinCerrar` para que se corrija.
    if (!t.salida && esDiaPasado) continue;
    const fin = t.salida ? new Date(t.salida).getTime() : now;
    if (fin > ini) min += (fin - ini) / 60000;
  }
  const ultimoAbierto = tramos.length && !tramos[tramos.length - 1].salida ? tramos[tramos.length - 1] : null;

  return {
    fecha: fecha || fechaHoy(),
    estado,                                  // fuera | dentro | pausa
    dentro: estado === 'dentro',             // compat con vistas viejas
    enPausa: estado === 'pausa',
    sinCerrar: esDiaPasado && estado !== 'fuera', // día pasado que quedó abierto (o en pausa)
    desde: ultimoAbierto ? ultimoAbierto.entrada : null,
    minutos: Math.round(min),
    tramos,
    obraId,
    // Qué puede pulsar ahora (para el botón de 4 estados)
    acciones: {
      entrada: estado === 'fuera',
      pausa_inicio: estado === 'dentro',
      pausa_fin: estado === 'pausa',
      salida: estado === 'dentro' || estado === 'pausa',
    },
  };
}

async function marcasDelDia(userId, fecha) {
  const db = await getDB();
  return db.collection(COL).find({ empresaId: EMPRESA, userId: String(userId), fecha }).sort({ hora: 1 }).toArray();
}

async function estadoActual(userId, fecha) {
  const f = fecha || fechaHoy();
  const marcas = await marcasDelDia(userId, f);
  return reconstruir(marcas, f);
}

// ── AÑADIR UNA MARCA (append-only) ────────────────────────────────
// Valida la transición según el estado actual. tipo ∈ TIPOS.
async function marcar(userId, userName, tipo, { loc, obraId, opId, offline, horaDispositivo } = {}) {
  if (!TIPOS.includes(tipo)) throw new Error('Tipo de marca no válido');
  const db = await getDB();
  const now = new Date();
  const op = (typeof opId === 'string' && /^[\w-]{8,64}$/.test(opId)) ? opId : null;

  // IDEMPOTENCIA: el móvil reintenta la misma marca si se quedó sin cobertura a medias
  // (la petición llegó pero la respuesta no). Misma opId ⇒ no se duplica.
  if (op) {
    const ya = await db.collection(COL).findOne({ empresaId: EMPRESA, userId: String(userId), opId: op });
    if (ya) return { accion: ya.tipo, duplicada: true, ...(await estadoActual(userId, fechaHoy())) };
  }

  // OFFLINE (Fase 4): la marca se hizo sin cobertura y llega después. Cuenta la hora del
  // MÓVIL (cuando pulsó), y queda anotado que es offline y cuándo la recibió el servidor.
  let hora = now, hd = null, relojDudoso = false;
  if (offline) {
    hd = new Date(horaDispositivo);
    if (isNaN(hd.getTime())) throw new Error('Hora del móvil no válida');
    if (now - hd > OFFLINE_MAX_DIAS * 86400000) throw new Error(`Ese fichaje tiene más de ${OFFLINE_MAX_DIAS} días. Pide una corrección a oficina.`);
    // Reloj del móvil adelantado: no se aceptan horas futuras → se usa la del servidor y se anota.
    if (hd - now > 2 * 60000) relojDudoso = true; else hora = hd > now ? now : hd;
  }
  const fecha = fechaDe(hora);
  // Estado en el momento de la marca (solo lo anterior a esa hora), para validar la transición.
  const previas = (await marcasDelDia(userId, fecha)).filter(m => new Date(m.hora) <= hora);
  const est = reconstruir(previas, fecha);
  if (!est.acciones[tipo]) {
    const nombres = { entrada: 'entrar', pausa_inicio: 'pausar', pausa_fin: 'volver de la pausa', salida: 'salir' };
    throw new Error(`Ahora mismo no puedes ${nombres[tipo] || tipo} (estás: ${est.estado}).`);
  }
  const doc = {
    empresaId: EMPRESA,
    userId: String(userId),
    userName: userName || '',
    tipo,
    hora,                                   // la que cuenta — UTC en BD (servidor; en offline, la del móvil)
    horaDispositivo: hd,                    // solo en marcas offline
    fecha,                                  // YYYY-MM-DD Europe/Madrid
    origen: 'app',
    offline: !!offline,
    recibidaAt: now,                        // cuándo llegó al servidor (en offline ≠ hora)
    obraId: (tipo === 'entrada' && obraId) ? String(obraId) : (est.obraId || null),
    ubicacion: limpiarLoc(loc),
    corrigeA: null,
    motivo: null,
    estado: 'valido',
    creadoPor: String(userId),
    aprobadoPor: null,
    createdAt: now,
  };
  if (op) doc.opId = op;
  if (relojDudoso) doc.relojDudoso = true;
  try { await db.collection(COL).insertOne(doc); }
  catch (e) { // dos reintentos a la vez de la misma pulsación → gana el primero
    if (e && e.code === 11000 && op) return { accion: tipo, duplicada: true, ...(await estadoActual(userId, fechaHoy())) };
    throw e;
  }

  // Enganches con la PRESENCIA (igual que el fichaje viejo):
  //  · primera ENTRADA del día → marca presencia
  //  · SALIDA → vuelca las horas trabajadas a la presencia
  try {
    if (tipo === 'entrada') {
      const previas = await db.collection(COL).countDocuments({ empresaId: EMPRESA, userId: String(userId), fecha, tipo: 'entrada' });
      if (previas === 1) await require('./attendance').marcarPresenciaFichaje(String(userId), userName, fecha);
    }
  } catch (e) { console.warn('[FichajeMarcas] presencia:', e.message); }

  const nuevo = await estadoActual(userId, fecha);
  try {
    if (tipo === 'salida') {
      await require('./attendance').actualizarHorasFichaje(String(userId), fecha, Math.round(nuevo.minutos / 6) / 10);
    }
  } catch (e) { console.warn('[FichajeMarcas] horas:', e.message); }

  // La app pinta siempre el día de HOY (una marca offline puede ser de ayer).
  const hoy = fechaHoy();
  return { accion: tipo, offline: !!offline, ...(fecha === hoy ? nuevo : await estadoActual(userId, hoy)) };
}

// ── VISTA ADMIN DEL DÍA ───────────────────────────────────────────
// Un objeto por trabajador con su jornada reconstruida (compat con fichajes.html).
async function getDia(fecha) {
  const db = await getDB();
  const f = fecha || fechaHoy();
  const marcas = await db.collection(COL).find({ empresaId: EMPRESA, fecha: f }).sort({ hora: 1 }).toArray();
  const porUser = {};
  for (const m of marcas) {
    (porUser[m.userId] = porUser[m.userId] || { userId: m.userId, userName: m.userName, marcas: [] }).marcas.push(m);
    if (m.userName) porUser[m.userId].userName = m.userName;
  }
  return Object.values(porUser)
    .map(u => ({
      userId: u.userId, userName: u.userName, ...reconstruir(u.marcas, f),
      // Registro tal cual quedó guardado (incluye correcciones y marcas sustituidas).
      registro: u.marcas.map(m => ({ id: String(m._id), tipo: m.tipo, hora: m.hora, origen: m.origen || 'app', estado: m.estado || 'valido', corrigeA: m.corrigeA || null, motivo: m.motivo || null, por: m.creadoPorNombre || null, offline: !!m.offline, recibidaAt: m.offline ? (m.recibidaAt || m.createdAt || null) : null, relojDudoso: !!m.relojDudoso })),
    }))
    .sort((a, b) => String(a.userName).localeCompare(String(b.userName)));
}

// Mis marcas en un rango (para semana/mes del trabajador — Fase 3 usará esto).
async function getMarcasTrabajador(userId, from, to) {
  const db = await getDB();
  const q = { empresaId: EMPRESA, userId: String(userId) };
  if (from || to) { q.fecha = {}; if (from) q.fecha.$gte = from; if (to) q.fecha.$lte = to; }
  const marcas = await db.collection(COL).find(q).sort({ hora: 1 }).toArray();
  const porDia = {};
  for (const m of marcas) (porDia[m.fecha] = porDia[m.fecha] || []).push(m);
  return Object.keys(porDia).sort().map(fecha => ({ fecha, ...reconstruir(porDia[fecha], fecha) }));
}

// ── CORRECCIONES (Fase 2) ─────────────────────────────────────────
// Ninguna marca se edita ni se borra. Corregir = una marca NUEVA (origen 'correccion'
// o 'admin') con motivo obligatorio; si sustituye a otra, apunta a ella con corrigeA.
// La del trabajador nace 'pendiente' y no cuenta hasta que oficina la aprueba.

// 'YYYY-MM-DD' + 'HH:MM' en hora de Madrid → Date (UTC). Sin librerías: se calcula
// el desfase real de Madrid ese día (verano/invierno) con Intl.
function madridAUTC(fecha, hhmm) {
  const [y, mo, d] = String(fecha).split('-').map(Number);
  const [h, mi] = String(hhmm).split(':').map(Number);
  if (![y, mo, d, h, mi].every(Number.isFinite) || h > 23 || mi > 59) throw new Error('Fecha u hora no válidas');
  const comoUTC = Date.UTC(y, mo - 1, d, h, mi);
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(comoUTC)).forEach(x => { p[x.type] = Number(x.value); });
  const desfase = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - comoUTC; // lo que Madrid va por delante
  return new Date(comoUTC - desfase);
}

function _validarCorreccion({ fecha, hora, tipo, motivo }) {
  if (!TIPOS.includes(tipo)) throw new Error('Elige qué quieres corregir (entrada, pausa, vuelta o salida)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha || ''))) throw new Error('Falta el día');
  if (!/^\d{1,2}:\d{2}$/.test(String(hora || ''))) throw new Error('Falta la hora');
  if (String(motivo || '').trim().length < 5) throw new Error('Explica el motivo (es obligatorio en una corrección)');
  if (fecha > fechaHoy()) throw new Error('No se puede corregir un día futuro');
  const cuando = madridAUTC(fecha, hora);
  if (cuando.getTime() > Date.now() + 60000) throw new Error('Esa hora todavía no ha llegado');
  const limite = new Date(); limite.setDate(limite.getDate() - 62);
  if (cuando < limite) throw new Error('Ese día es demasiado antiguo; háblalo con oficina');
  return cuando;
}

async function _marcaPropia(db, corrigeA, userId) {
  if (!corrigeA) return null;
  const { ObjectId } = require('mongodb');
  if (!ObjectId.isValid(String(corrigeA))) throw new Error('La marca a corregir no es válida');
  const orig = await db.collection(COL).findOne({ _id: new ObjectId(String(corrigeA)), empresaId: EMPRESA });
  if (!orig || String(orig.userId) !== String(userId)) throw new Error('La marca a corregir no existe');
  return orig;
}

// El TRABAJADOR pide una corrección ("me olvidé de fichar"). Queda pendiente.
async function pedirCorreccion(userId, userName, { fecha, hora, tipo, motivo, corrigeA } = {}) {
  const cuando = _validarCorreccion({ fecha, hora, tipo, motivo });
  const db = await getDB();
  const orig = await _marcaPropia(db, corrigeA, userId);
  const yaPend = await db.collection(COL).countDocuments({ empresaId: EMPRESA, userId: String(userId), estado: 'pendiente' });
  if (yaPend >= 10) throw new Error('Tienes muchas correcciones pendientes; espera a que oficina las revise');
  const now = new Date();
  const doc = {
    empresaId: EMPRESA, userId: String(userId), userName: userName || '',
    tipo, hora: cuando, horaDispositivo: null, fecha,
    origen: 'correccion', obraId: null, ubicacion: null,
    corrigeA: orig ? String(orig._id) : null,
    motivo: String(motivo).trim().slice(0, 500),
    estado: 'pendiente',
    creadoPor: String(userId), creadoPorNombre: userName || '',
    aprobadoPor: null, aprobadoAt: null, resolucionMotivo: null,
    createdAt: now,
  };
  const r = await db.collection(COL).insertOne(doc);
  return { ok: true, id: String(r.insertedId), estado: 'pendiente' };
}

// OFICINA añade/corrige una marca directamente (queda válida, con su firma y motivo).
async function marcaAdmin({ userId, fecha, hora, tipo, motivo, corrigeA }, por) {
  if (!userId) throw new Error('Falta el trabajador');
  const cuando = _validarCorreccion({ fecha, hora, tipo, motivo });
  const db = await getDB();
  const orig = await _marcaPropia(db, corrigeA, userId);
  const u = await require('./users').getUser(String(userId)).catch(() => null);
  const now = new Date();
  await db.collection(COL).insertOne({
    empresaId: EMPRESA, userId: String(userId), userName: (u && u.name) || '',
    tipo, hora: cuando, horaDispositivo: null, fecha,
    origen: 'admin', obraId: null, ubicacion: null,
    corrigeA: orig ? String(orig._id) : null,
    motivo: String(motivo).trim().slice(0, 500),
    estado: 'valido',
    creadoPor: String(por || 'oficina'), creadoPorNombre: String(por || 'oficina'),
    aprobadoPor: String(por || 'oficina'), aprobadoAt: now, resolucionMotivo: null,
    createdAt: now,
  });
  return _trasCambio(userId, fecha);
}

// Tras aprobar/añadir: recalcula el día y, si quedó cerrado, vuelca las horas a la presencia.
async function _trasCambio(userId, fecha) {
  const dia = reconstruir(await marcasDelDia(userId, fecha), fecha);
  try {
    if (dia.estado === 'fuera' && dia.minutos > 0) {
      await require('./attendance').actualizarHorasFichaje(String(userId), fecha, Math.round(dia.minutos / 6) / 10);
    }
  } catch (e) { console.warn('[FichajeMarcas] horas tras corrección:', e.message); }
  return { ok: true, dia };
}

// Oficina aprueba o rechaza una corrección pendiente (rechazar exige motivo).
async function resolverCorreccion(id, { aprobar, motivo } = {}, por) {
  const { ObjectId } = require('mongodb');
  if (!ObjectId.isValid(String(id))) throw new Error('Corrección no válida');
  const db = await getDB();
  const c = await db.collection(COL).findOne({ _id: new ObjectId(String(id)), empresaId: EMPRESA, origen: 'correccion' });
  if (!c) throw new Error('Corrección no encontrada');
  if (c.estado !== 'pendiente') throw new Error('Esa corrección ya estaba resuelta');
  if (!aprobar && String(motivo || '').trim().length < 3) throw new Error('Para rechazar hay que explicar el motivo');
  // Solo cambia el ESTADO de la propia corrección (y quién la resolvió); la marca
  // original y la hora solicitada no se tocan.
  await db.collection(COL).updateOne(
    { _id: c._id, estado: 'pendiente' },
    { $set: { estado: aprobar ? 'valido' : 'rechazado', aprobadoPor: String(por || 'oficina'), aprobadoAt: new Date(), resolucionMotivo: String(motivo || '').trim().slice(0, 500) || null } }
  );
  const r = await _trasCambio(c.userId, c.fecha);
  return { ...r, estado: aprobar ? 'valido' : 'rechazado', userId: c.userId, userName: c.userName, fecha: c.fecha };
}

function _vistaCorreccion(c, origMap) {
  const o = c.corrigeA ? origMap[String(c.corrigeA)] : null;
  return {
    id: String(c._id), userId: c.userId, userName: c.userName, fecha: c.fecha,
    tipo: c.tipo, hora: c.hora, motivo: c.motivo, estado: c.estado, origen: c.origen,
    pedidaAt: c.createdAt, resueltaPor: c.aprobadoPor || null, resueltaAt: c.aprobadoAt || null,
    resolucionMotivo: c.resolucionMotivo || null,
    corrige: o ? { id: String(o._id), tipo: o.tipo, hora: o.hora } : null,
  };
}
async function _conOriginales(db, lista) {
  const { ObjectId } = require('mongodb');
  const ids = [...new Set(lista.filter(c => c.corrigeA && ObjectId.isValid(String(c.corrigeA))).map(c => String(c.corrigeA)))];
  const origs = ids.length ? await db.collection(COL).find({ _id: { $in: ids.map(x => new ObjectId(x)) } }).toArray() : [];
  const map = {}; origs.forEach(o => { map[String(o._id)] = o; });
  return lista.map(c => _vistaCorreccion(c, map));
}
async function getCorrecciones({ estado = 'pendiente', limit = 100 } = {}) {
  const db = await getDB();
  const q = { empresaId: EMPRESA, origen: 'correccion' };
  if (estado && estado !== 'todas') q.estado = estado;
  const lista = await db.collection(COL).find(q).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 100, 300)).toArray();
  return _conOriginales(db, lista);
}
async function misCorrecciones(userId) {
  const db = await getDB();
  const lista = await db.collection(COL).find({ empresaId: EMPRESA, userId: String(userId), origen: 'correccion' }).sort({ createdAt: -1 }).limit(15).toArray();
  return _conOriginales(db, lista);
}

// ── ALERTAS (Fase 2) ──────────────────────────────────────────────
// Quién debe fichar: plantilla activa (técnico / encargado / oficina). El dueño no.
async function trabajadoresQueFichan() {
  const { getUsers, normalizeRole } = require('./users');
  const us = await getUsers(false);
  return (us || [])
    .filter(u => u.role !== 'client' && ['tecnico', 'encargado', 'oficina'].includes(normalizeRole(u.role)))
    .map(u => ({ id: String(u._id), name: u.name, whatsapp: _tel(u.whatsapp || u.telefono) }));
}
function _tel(t) {
  const d = String(t || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 9) return '+34' + d;
  return '+' + d.replace(/^00/, '');
}
function _horaMadrid() {
  return new Date().toLocaleTimeString('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}
function _esLaborable(fecha) {
  const dow = new Date(fecha + 'T12:00:00Z').getUTCDay();
  return dow >= 1 && dow <= 5;
}

// Quién de la plantilla NO ha fichado ese día y DEBERÍA: solo laborables (y no festivos
// de FICHAJE_FESTIVOS=AAAA-MM-DD,...), y nunca quien en presencia esté de vacaciones,
// baja, falta o libre. Devuelve también cuánta gente sí ha fichado (para detectar un
// festivo no configurado: si no ha fichado NADIE, lo más probable es que no se trabaje).
async function sinFichar(fecha, pre = {}) {
  const f = fecha || fechaHoy();
  const festivos = String(process.env.FICHAJE_FESTIVOS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!_esLaborable(f) || festivos.includes(f)) return { fecha: f, laborable: false, faltan: [], fichados: 0, plantilla: 0 };
  const db = await getDB();
  const [dia, plantilla] = await Promise.all([pre.dia || getDia(f), pre.plantilla || trabajadoresQueFichan()]);
  const conMarcas = new Set(dia.map(d => String(d.userId)));
  const pres = await db.collection('attendance').find({ date: f }).toArray();
  const ausente = {}; pres.forEach(p => { if (p.estado && !['obra', 'oficina'].includes(p.estado)) ausente[String(p.workerId)] = p.estado; });
  const esperados = plantilla.filter(w => !ausente[w.id]);
  return {
    fecha: f, laborable: true,
    faltan: esperados.filter(w => !conMarcas.has(w.id)),
    fichados: esperados.filter(w => conMarcas.has(w.id)).length,
    plantilla: esperados.length,
  };
}

// Alertas de un día: no fichó (a partir de las 9:00, laborables, y solo quien NO está
// de vacaciones/baja/etc. en presencia) · sigue dentro (desde las 20:00, o día pasado
// sin cerrar) · días de más de 10 h. Más los días sin cerrar de la última semana.
async function alertas(fecha, { forzarHora } = {}) {
  const db = await getDB();
  const f = fecha || fechaHoy();
  const esHoy = f === fechaHoy();
  const ahora = forzarHora || _horaMadrid();
  const [dia, plantilla] = await Promise.all([getDia(f), trabajadoresQueFichan()]);
  const porId = {}; dia.forEach(d => { porId[String(d.userId)] = d; });

  let noFicho = [];
  if (!esHoy || ahora >= '09:00') {
    noFicho = (await sinFichar(f, { dia, plantilla })).faltan.map(w => ({ userId: w.id, userName: w.name }));
  }
  const sigueDentro = dia
    .filter(d => (esHoy ? (ahora >= '20:00' && d.estado !== 'fuera') : d.sinCerrar))
    .map(d => ({ userId: d.userId, userName: d.userName, desde: d.desde || (d.tramos[0] && d.tramos[0].entrada) || null, estado: d.estado }));
  const masDe10h = dia.filter(d => d.minutos > 600).map(d => ({ userId: d.userId, userName: d.userName, minutos: d.minutos }));

  // Días de la última semana que se quedaron abiertos (para que no se pierdan)
  const desde = new Date(); desde.setDate(desde.getDate() - 7);
  const fDesde = fechaDe(desde);
  const recientes = await db.collection(COL).find({ empresaId: EMPRESA, fecha: { $gte: fDesde, $lt: fechaHoy() } }).sort({ hora: 1 }).toArray();
  const grupos = {};
  for (const m of recientes) (grupos[m.userId + '|' + m.fecha] = grupos[m.userId + '|' + m.fecha] || []).push(m);
  const sinCerrarPrevios = Object.entries(grupos)
    .map(([k, ms]) => ({ k, r: reconstruir(ms, k.split('|')[1]), ms }))
    .filter(x => x.r.sinCerrar)
    .map(x => ({ userId: x.k.split('|')[0], userName: x.ms[0].userName, fecha: x.k.split('|')[1] }))
    .sort((a, b) => (a.fecha < b.fecha ? 1 : -1));

  const pendientes = await db.collection(COL).countDocuments({ empresaId: EMPRESA, origen: 'correccion', estado: 'pendiente' });
  return { fecha: f, hora: ahora, noFicho, sigueDentro, masDe10h, sinCerrarPrevios, correccionesPendientes: pendientes };
}

// ── MIGRACIÓN una vez: viejo `fichajes` (tramos) → marcas ─────────
// Idempotente: marca el doc viejo con `_migradoMarcas` y no lo repite.
async function migrarDesdeTramos() {
  const db = await getDB();
  const viejos = await db.collection('fichajes').find({ empresaId: EMPRESA, _migradoMarcas: { $ne: true } }).toArray();
  if (!viejos.length) return { migrados: 0 };
  let nMarcas = 0;
  for (const d of viejos) {
    const marcas = [];
    for (const t of (d.tramos || [])) {
      if (t && t.entrada) {
        marcas.push(_marcaMigrada(d, 'entrada', t.entrada, t.entradaLoc));
        if (t.salida) marcas.push(_marcaMigrada(d, 'salida', t.salida, t.salidaLoc));
      }
    }
    if (marcas.length) { await db.collection(COL).insertMany(marcas); nMarcas += marcas.length; }
    await db.collection('fichajes').updateOne({ _id: d._id }, { $set: { _migradoMarcas: true } });
  }
  console.log(`[FichajeMarcas] Migración: ${viejos.length} días → ${nMarcas} marcas`);
  return { migrados: viejos.length, marcas: nMarcas };
}
function _marcaMigrada(d, tipo, hora, loc) {
  return {
    empresaId: EMPRESA, userId: String(d.userId), userName: d.userName || '',
    tipo, hora: new Date(hora), horaDispositivo: null,
    fecha: d.fecha || fechaDe(hora), origen: 'app', obraId: null,
    ubicacion: limpiarLoc(loc), corrigeA: null, motivo: null,
    estado: 'valido', creadoPor: String(d.userId), aprobadoPor: null,
    createdAt: new Date(hora), _migrada: true,
  };
}

// Marcas válidas de un día del propio trabajador (para elegir cuál corrige).
async function misMarcasDia(userId, fecha) {
  const ms = await marcasDelDia(userId, fecha || fechaHoy());
  const validas = ms.filter(m => (m.estado || 'valido') === 'valido');
  const sust = new Set(validas.filter(m => m.corrigeA).map(m => String(m.corrigeA)));
  return validas.filter(m => !sust.has(String(m._id))).map(m => ({ id: String(m._id), tipo: m.tipo, hora: m.hora }));
}

module.exports = {
  fechaHoy, TIPOS, reconstruir, madridAUTC,
  marcar, estadoActual, getDia, getMarcasTrabajador, misMarcasDia,
  pedirCorreccion, marcaAdmin, resolverCorreccion, getCorrecciones, misCorrecciones,
  alertas, sinFichar, trabajadoresQueFichan,
  migrarDesdeTramos,
};
