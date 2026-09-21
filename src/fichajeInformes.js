// src/fichajeInformes.js — Fichaje legal · Fase 3: resumen mensual, firma, informes y export.
//
//  · resumenMensual: horas por día, pausas, total, horas de más y correcciones del mes,
//    con un HASH del contenido (la "versión exacta" que firma el trabajador).
//  · Firma mensual APPEND-ONLY (colección fichajeFirmas): conforme / no conforme con
//    comentario, con la foto del resumen firmado. Si luego cambia algo (una corrección
//    aprobada), el hash ya no coincide y se pide volver a firmar. "No firma" lo anota oficina.
//  · exportInspeccion: todas las marcas de un periodo, con correcciones y quién las hizo.
//
// Horas de más = lo que pasa de la jornada diaria (FICHAJE_HORAS_DIA, por defecto 8 h).
// El criterio legal de cómputo (diario/semanal/anual) que lo confirme la gestoría.

const crypto = require('crypto');
const fm = require('./fichajeMarcas');

const EMPRESA = process.env.EMPRESA_ID || 'corp';
const COL = 'fichajeMarcas';
const COL_FIRMAS = 'fichajeFirmas';
const JORNADA_MIN = Math.round((parseFloat(process.env.FICHAJE_HORAS_DIA) || 8) * 60);

async function getDB() { return require('./db').getDB(); }

function _rangoMes(mes) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(mes || ''))) throw new Error('Mes no válido (usa AAAA-MM)');
  const [y, m] = mes.split('-').map(Number);
  const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${mes}-01`, to: `${mes}-${String(ultimo).padStart(2, '0')}` };
}
function mesActual() { return fm.fechaHoy().slice(0, 7); }
// Lunes de la semana de una fecha 'YYYY-MM-DD' (para agrupar por semanas).
function _lunes(fecha) {
  const d = new Date(fecha + 'T12:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

function _filaDia(fecha, marcas) {
  const r = fm.reconstruir(marcas, fecha);
  const tr = r.tramos || [];
  let pausas = 0;
  for (let i = 1; i < tr.length; i++) {
    if (tr[i - 1].salida && tr[i].entrada) pausas += Math.max(0, (new Date(tr[i].entrada) - new Date(tr[i - 1].salida)) / 60000);
  }
  const ultimo = tr[tr.length - 1];
  return {
    fecha, semana: _lunes(fecha),
    entrada: tr.length ? tr[0].entrada : null,
    salida: ultimo && ultimo.salida ? ultimo.salida : null,
    tramos: tr.length,
    pausasMin: Math.round(pausas),
    minutos: r.minutos,
    extraMin: Math.max(0, r.minutos - JORNADA_MIN),
    sinCerrar: !!r.sinCerrar,
    enCurso: r.estado !== 'fuera' && !r.sinCerrar,
    correcciones: marcas.filter(m => (m.origen || 'app') !== 'app' && (m.estado || 'valido') === 'valido').length,
  };
}

function _hash(userId, mes, dias) {
  const canon = JSON.stringify({ userId: String(userId), mes, dias: dias.map(d => [d.fecha, d.entrada ? new Date(d.entrada).toISOString() : null, d.salida ? new Date(d.salida).toISOString() : null, d.pausasMin, d.minutos]) });
  return crypto.createHash('sha256').update(canon).digest('hex');
}

function _resumenDesdeMarcas(userId, userName, mes, marcas) {
  const porDia = {};
  for (const m of marcas) (porDia[m.fecha] = porDia[m.fecha] || []).push(m);
  const dias = Object.keys(porDia).sort().map(f => _filaDia(f, porDia[f])).filter(d => d.tramos > 0);
  const tot = dias.reduce((a, d) => ({ min: a.min + d.minutos, extra: a.extra + d.extraMin, pausas: a.pausas + d.pausasMin }), { min: 0, extra: 0, pausas: 0 });
  const cambios = marcas.filter(m => (m.origen || 'app') !== 'app').map(m => ({
    fecha: m.fecha, tipo: m.tipo, hora: m.hora, origen: m.origen, estado: m.estado || 'valido', motivo: m.motivo || null,
    pedidaPor: m.creadoPorNombre || null, resueltaPor: m.aprobadoPor || null, resueltaAt: m.aprobadoAt || null, sustituye: !!m.corrigeA,
  }));
  return {
    userId: String(userId), userName: userName || (marcas[0] && marcas[0].userName) || '', mes,
    jornadaMin: JORNADA_MIN,
    dias,
    totales: { dias: dias.length, minutos: tot.min, extraMin: tot.extra, pausasMin: tot.pausas, sinCerrar: dias.filter(d => d.sinCerrar).length },
    correcciones: cambios,
    correccionesPendientes: cambios.filter(c => c.estado === 'pendiente').length,
    hash: _hash(userId, mes, dias),
  };
}

async function resumenMensual(userId, mes, userName) {
  const { from, to } = _rangoMes(mes);
  const db = await getDB();
  const marcas = await db.collection(COL).find({ empresaId: EMPRESA, userId: String(userId), fecha: { $gte: from, $lte: to } }).sort({ hora: 1 }).toArray();
  return _resumenDesdeMarcas(userId, userName, mes, marcas);
}

// ── FIRMA MENSUAL (append-only) ───────────────────────────────────
function _estadoFirma(ultima, hashActual) {
  if (!ultima) return { estado: 'pendiente' };
  if (ultima.tipo === 'no_firma') return { estado: 'no_firma', fecha: ultima.createdAt, por: ultima.por };
  const vigente = ultima.hash === hashActual;
  return {
    estado: !vigente ? 'cambiado' : (ultima.conforme ? 'firmado' : 'no_conforme'),
    fecha: ultima.createdAt, comentario: ultima.comentario || null, conforme: !!ultima.conforme, vigente,
  };
}
async function _ultimaFirma(db, userId, mes) {
  const l = await db.collection(COL_FIRMAS).find({ empresaId: EMPRESA, userId: String(userId), mes }).sort({ createdAt: -1 }).limit(1).toArray();
  return l[0] || null;
}
async function miMes(userId, mes, userName) {
  const m = mes || mesActual();
  const db = await getDB();
  const resumen = await resumenMensual(userId, m, userName);
  const firma = _estadoFirma(await _ultimaFirma(db, userId, m), resumen.hash);
  return { ...resumen, firma, sePuedeFirmar: m < mesActual(), mesActual: mesActual() };
}

// El trabajador firma (conforme) o deja constancia de que NO está de acuerdo (con comentario).
async function firmar(userId, userName, { mes, conforme, comentario, firma, hash } = {}, meta = {}) {
  _rangoMes(mes);
  if (mes >= mesActual()) throw new Error('El resumen se firma cuando el mes ha terminado');
  const resumen = await resumenMensual(userId, mes, userName);
  if (!resumen.dias.length) throw new Error('Ese mes no tiene jornadas registradas');
  if (hash && hash !== resumen.hash) throw new Error('El resumen ha cambiado mientras lo mirabas. Vuelve a abrirlo y revísalo.');
  const ok = !!conforme;
  const com = String(comentario || '').trim().slice(0, 1000);
  if (!ok && com.length < 5) throw new Error('Explica con qué no estás de acuerdo');
  const img = (typeof firma === 'string' && /^data:image\/png;base64,/.test(firma) && firma.length < 400000) ? firma : null;
  if (ok && !img) throw new Error('Falta la firma');
  const db = await getDB();
  await db.collection(COL_FIRMAS).insertOne({
    empresaId: EMPRESA, userId: String(userId), userName: userName || resumen.userName, mes,
    tipo: 'firma', conforme: ok, comentario: com || null, firma: img,
    hash: resumen.hash, resumen,               // la versión EXACTA que se firmó
    ip: meta.ip || null, userAgent: String(meta.userAgent || '').slice(0, 300) || null,
    createdAt: new Date(),
  });
  return { ok: true, estado: ok ? 'firmado' : 'no_conforme' };
}

// Oficina deja constancia de que el trabajador NO firma (con la fecha). No sustituye a una firma.
async function anotarNoFirma(userId, mes, por) {
  _rangoMes(mes);
  const db = await getDB();
  const resumen = await resumenMensual(userId, mes);
  await db.collection(COL_FIRMAS).insertOne({
    empresaId: EMPRESA, userId: String(userId), userName: resumen.userName, mes,
    tipo: 'no_firma', conforme: false, comentario: null, firma: null,
    hash: resumen.hash, resumen, por: String(por || 'oficina'), createdAt: new Date(),
  });
  return { ok: true, estado: 'no_firma' };
}

// ── INFORMES DE OFICINA ───────────────────────────────────────────
// Resumen del mes de TODA la plantilla (para la tabla, el Excel de gestoría y nóminas).
async function informeMes(mes) {
  const m = mes || mesActual();
  const { from, to } = _rangoMes(m);
  const db = await getDB();
  const [marcas, firmas, plantilla] = await Promise.all([
    db.collection(COL).find({ empresaId: EMPRESA, fecha: { $gte: from, $lte: to } }).sort({ hora: 1 }).toArray(),
    db.collection(COL_FIRMAS).find({ empresaId: EMPRESA, mes: m }).sort({ createdAt: 1 }).toArray(),
    fm.trabajadoresQueFichan().catch(() => []),
  ]);
  const porUser = {};
  for (const x of marcas) (porUser[x.userId] = porUser[x.userId] || []).push(x);
  const ultFirma = {}; firmas.forEach(f => { ultFirma[f.userId] = f; });
  const nombres = {}; plantilla.forEach(w => { nombres[w.id] = w.name; });
  const ids = [...new Set([...Object.keys(porUser), ...plantilla.map(w => w.id)])];
  const trabajadores = ids.map(id => {
    const r = _resumenDesdeMarcas(id, nombres[id], m, porUser[id] || []);
    return { ...r, firma: _estadoFirma(ultFirma[id], r.hash) };
  }).sort((a, b) => String(a.userName).localeCompare(String(b.userName)));
  return { mes: m, from, to, jornadaMin: JORNADA_MIN, cerrado: m < mesActual(), trabajadores };
}

// Informe completo de un trabajador (para el PDF a firmar): resumen + última firma con su imagen.
async function informeTrabajador(userId, mes) {
  const db = await getDB();
  const u = await require('./users').getUser(String(userId)).catch(() => null);
  const resumen = await resumenMensual(userId, mes, u && u.name);
  const ult = await _ultimaFirma(db, userId, mes);
  return { ...resumen, firma: { ..._estadoFirma(ult, resumen.hash), imagen: ult && ult.tipo === 'firma' ? ult.firma : null, hashFirmado: ult ? ult.hash : null } };
}

// Export para la Inspección: TODAS las marcas del periodo tal cual están guardadas
// (incluye correcciones pendientes/rechazadas y las marcas sustituidas).
async function exportInspeccion(from, to) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(to || ''))) throw new Error('Indica el periodo (desde / hasta)');
  if (from > to) throw new Error('El periodo no es válido');
  const db = await getDB();
  const marcas = await db.collection(COL).find({ empresaId: EMPRESA, fecha: { $gte: from, $lte: to } }).sort({ userName: 1, hora: 1 }).toArray();
  const validas = marcas.filter(m => (m.estado || 'valido') === 'valido');
  const sustituidas = new Set(validas.filter(m => m.corrigeA).map(m => String(m.corrigeA)));
  const porId = {}; marcas.forEach(m => { porId[String(m._id)] = m; });
  return {
    from, to, generado: new Date(), total: marcas.length,
    marcas: marcas.map(m => ({
      id: String(m._id), trabajador: m.userName, trabajadorId: m.userId, fecha: m.fecha, tipo: m.tipo,
      hora: m.hora, horaDispositivo: m.horaDispositivo || null,
      origen: m.origen || 'app', offline: !!m.offline, relojDudoso: !!m.relojDudoso, estado: m.estado || 'valido',
      cuenta: (m.estado || 'valido') === 'valido' && !sustituidas.has(String(m._id)),
      sustituidaPorCorreccion: sustituidas.has(String(m._id)),
      corrigeA: m.corrigeA || null, corrigeHoraOriginal: m.corrigeA && porId[String(m.corrigeA)] ? porId[String(m.corrigeA)].hora : null,
      motivo: m.motivo || null, creadoPor: m.creadoPorNombre || ((m.origen || 'app') === 'app' ? m.userName : m.creadoPor) || null,
      resueltaPor: m.aprobadoPor || null, resueltaAt: m.aprobadoAt || null, resolucionMotivo: m.resolucionMotivo || null,
      ubicacion: m.ubicacion ? `${m.ubicacion.lat},${m.ubicacion.lng}` : null, registradaAt: m.createdAt || null,
    })),
  };
}

module.exports = { resumenMensual, miMes, firmar, anotarNoFirma, informeMes, informeTrabajador, exportInspeccion, mesActual, JORNADA_MIN };
