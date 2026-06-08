// src/partes.js — Módulo de partes de trabajo
const { MongoClient, ObjectId } = require('mongodb');
const CONFIG = require('./config');

let db = null;

async function getDB() {
  return require('./db').getDB();
}

// Exportamos desde config — un solo sitio para cambiarlos
const WORKERS       = CONFIG.workersFallback;
const ESTADOS_PARTE = CONFIG.estadosPartes;
const ESTADOS_TRABAJO = CONFIG.estadosTrabajo;
const TIPOS_JORNADA   = CONFIG.tiposJornada;

async function workerLogin(workerId, pin) {
  const worker = WORKERS.find(w => w.id === workerId && w.pin === pin);
  if (!worker) throw new Error('PIN incorrecto');
  const token = `w_${workerId}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const db = await getDB();
  await db.collection('worker_tokens').insertOne({
    token, workerId, workerName: worker.name,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000)
  });
  return { token, workerName: worker.name, workerId };
}

async function verifyWorkerToken(token) {
  if (!token || !token.startsWith('w_')) return null;
  const db = await getDB();
  return db.collection('worker_tokens').findOne({
    token, expiresAt: { $gt: new Date() }
  });
}

async function createParte(data, workerInfo) {
  const db = await getDB();
  const parte = {
    workerId:    workerInfo.workerId,
    workerName:  workerInfo.workerName,
    date:        data.date,
    clientName:  data.clientName || '',
    description: data.description || '',
    horas:       parseFloat(data.horas || 8),
    materiales:  data.materiales || [],
    notas:       data.notas || '',
    estadoTrabajo:    data.estadoTrabajo || 'completado',
    pendienteDetalle: data.pendienteDetalle || '',
    materialDetalle:  data.materialDetalle  || '',
    tipoJornada:      data.tipoJornada || CONFIG.tipoJornadaPorFecha(data.date),
    equipo:       data.equipo || [],
    asignacionId: data.asignacionId || null,
    expedienteId: data.expedienteId || null,
    generadoAuto: false,
    _meta: {
      submittedAt:  new Date(),
      submittedBy:  workerInfo.role,
      ipAddress:    workerInfo.ip || '',
      gpsLat:       data.gpsLat || null,
      gpsLng:       data.gpsLng || null,
      gpsAccuracy:  data.gpsAccuracy || null,
      userAgent:    workerInfo.userAgent || '',
      fotosTrabajo: data.fotosTrabajo || [],
      fotosAlbaran: data.fotosAlbaran || [],
    },
    status:          'pendiente',
    adminNotes:      '',
    verifiedAt:      null,
    verifiedBy:      null,
    facturaRef:      null,
    importante:      false,
    createdAt:       new Date(),
    updatedAt:       new Date(),
  };
  const result = await db.collection('partes').insertOne(parte);
  parte._id = result.insertedId;
  parte.id  = result.insertedId;
  console.log(`[Partes] Nuevo parte: ${result.insertedId} — ${workerInfo.workerName} — ${data.clientName}`);
  return parte;
}

async function getPartes({ workerId, clientName, status, estadoTrabajo, expedienteId, from, to, limit = 50, skip = 0 } = {}) {
  const db = await getDB();
  const query = {};
  if (workerId)      query.workerId      = workerId;
  if (status)        query.status        = status;
  if (estadoTrabajo) query.estadoTrabajo = estadoTrabajo;
  if (expedienteId)  query.expedienteId  = expedienteId;
  if (clientName)    query.clientName    = { $regex: clientName, $options: 'i' };
  if (from || to) {
    query.date = {};
    if (from) query.date.$gte = from;
    if (to)   query.date.$lte = to;
  }
  const total  = await db.collection('partes').countDocuments(query);
  const partes = await db.collection('partes').find(query)
    .sort({ date: -1, '_meta.submittedAt': -1 })
    .skip(skip).limit(limit).toArray();
  return { partes, total, limit, skip };
}

async function getParte(id) {
  const db = await getDB();
  return db.collection('partes').findOne({ _id: new ObjectId(id) });
}

async function updateParte(id, updates, adminName) {
  const db = await getDB();
  const allowed = ['date','clientName','description','horas','materiales','notas',
                   'status','adminNotes','facturaRef','estadoTrabajo','pendienteDetalle',
                   'materialDetalle','tipoJornada','expedienteId','asignacionId','importante'];
  const set = { updatedAt: new Date() };
  allowed.forEach(k => { if (updates[k] !== undefined) set[k] = updates[k]; });
  if (updates.status === 'verificado') {
    set.verifiedAt = new Date();
    set.verifiedBy = adminName;
  }
  return db.collection('partes').updateOne({ _id: new ObjectId(id) }, { $set: set });
}

async function getResumenFacturacion({ from, to, clientName } = {}) {
  const db = await getDB();
  const query = { status: { $in: ['verificado', 'pendiente'] } };
  if (clientName) query.clientName = { $regex: clientName, $options: 'i' };
  if (from || to) {
    query.date = {};
    if (from) query.date.$gte = from;
    if (to)   query.date.$lte = to;
  }
  const partes = await db.collection('partes').find(query).toArray();
  const byClient = {};
  partes.forEach(p => {
    const k = p.clientName || 'Sin cliente';
    if (!byClient[k]) byClient[k] = { client: k, partes: 0, horas: 0, workers: new Set(), materiales: [], pendiente: 0, verificado: 0 };
    byClient[k].partes++;
    byClient[k].horas += p.horas || 0;
    byClient[k].workers.add(p.workerName);
    byClient[k][p.status]++;
    (p.materiales || []).forEach(m => byClient[k].materiales.push(m));
  });
  return Object.values(byClient).map(c => ({ ...c, workers: [...c.workers] })).sort((a,b) => b.horas - a.horas);
}

module.exports = {
  WORKERS, ESTADOS_PARTE, ESTADOS_TRABAJO, TIPOS_JORNADA,
  workerLogin, verifyWorkerToken,
  createParte, getPartes, getParte, updateParte,
  getResumenFacturacion
};
