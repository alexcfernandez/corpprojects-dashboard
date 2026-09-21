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
  const marcas = (marcasRaw || [])
    .filter(m => m && m.estado !== 'rechazado' && TIPOS.includes(m.tipo) && m.hora)
    .slice()
    .sort((a, b) => new Date(a.hora) - new Date(b.hora));

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
    const fin = t.salida ? new Date(t.salida).getTime() : now;
    if (fin > ini) min += (fin - ini) / 60000;
  }
  const ultimoAbierto = tramos.length && !tramos[tramos.length - 1].salida ? tramos[tramos.length - 1] : null;

  return {
    fecha: fecha || fechaHoy(),
    estado,                                  // fuera | dentro | pausa
    dentro: estado === 'dentro',             // compat con vistas viejas
    enPausa: estado === 'pausa',
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
async function marcar(userId, userName, tipo, { loc, obraId } = {}) {
  if (!TIPOS.includes(tipo)) throw new Error('Tipo de marca no válido');
  const db = await getDB();
  const now = new Date();
  const fecha = fechaHoy();
  const est = await estadoActual(userId, fecha);
  if (!est.acciones[tipo]) {
    const nombres = { entrada: 'entrar', pausa_inicio: 'pausar', pausa_fin: 'volver de la pausa', salida: 'salir' };
    throw new Error(`Ahora mismo no puedes ${nombres[tipo] || tipo} (estás: ${est.estado}).`);
  }
  const doc = {
    empresaId: EMPRESA,
    userId: String(userId),
    userName: userName || '',
    tipo,
    hora: now,                              // hora del SERVIDOR (la que cuenta) — UTC en BD
    horaDispositivo: null,                  // se usará en offline (Fase 4)
    fecha,                                  // YYYY-MM-DD Europe/Madrid
    origen: 'app',
    obraId: (tipo === 'entrada' && obraId) ? String(obraId) : (est.obraId || null),
    ubicacion: limpiarLoc(loc),
    corrigeA: null,
    motivo: null,
    estado: 'valido',
    creadoPor: String(userId),
    aprobadoPor: null,
    createdAt: now,
  };
  await db.collection(COL).insertOne(doc);

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

  return { accion: tipo, ...nuevo };
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
    .map(u => ({ userId: u.userId, userName: u.userName, ...reconstruir(u.marcas, f) }))
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

module.exports = {
  fechaHoy, TIPOS, reconstruir,
  marcar, estadoActual, getDia, getMarcasTrabajador,
  migrarDesdeTramos,
};
