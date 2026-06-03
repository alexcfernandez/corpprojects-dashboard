// src/partes.js — Módulo de partes de trabajo
// Dos roles: admin (acceso total) y worker (solo crear, no editar)

const { MongoClient, ObjectId } = require('mongodb');

let db = null;

async function getDB() {
  if (db) return db;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI no configurada');
  const client = new MongoClient(uri);
  await client.connect();
  db = client.db('corpprojects');
  // Índices para búsquedas rápidas
  await db.collection('partes').createIndex({ date: -1 });
  await db.collection('partes').createIndex({ workerId: 1, date: -1 });
  await db.collection('partes').createIndex({ clientName: 1 });
  await db.collection('partes').createIndex({ status: 1 });
  // Tokens de acceso para trabajadores
  await db.collection('worker_tokens').createIndex({ token: 1 }, { unique: true });
  console.log('[Partes] MongoDB conectado');
  return db;
}

// ── WORKERS (mismos que en presencia) ────────────────────────────
const WORKERS = [
  { id: 'jose',     name: 'Jose Beliard',    pin: '1234' },
  { id: 'diego',    name: 'Diego Campillo',  pin: '2345' },
  { id: 'abdellah', name: 'Abdellah Souiri', pin: '3456' },
  { id: 'mamadou',  name: 'Mamadou Barry',   pin: '4567' },
  { id: 'paula',    name: 'Paula Morales',   pin: '5678' },
];

// ── ESTADOS DEL PARTE ────────────────────────────────────────────
const ESTADOS_PARTE = {
  pendiente:  { label: 'Pendiente revisión', color: '#f59e0b', emoji: '⏳' },
  verificado: { label: 'Verificado',         color: '#22c487', emoji: '✅' },
  facturado:  { label: 'Facturado',          color: '#4d9cf8', emoji: '💰' },
  incidencia: { label: 'Con incidencia',     color: '#f05252', emoji: '⚠️' },
};

// ── LOGIN DE TRABAJADOR (por PIN) ────────────────────────────────
async function workerLogin(workerId, pin) {
  const worker = WORKERS.find(w => w.id === workerId && w.pin === pin);
  if (!worker) throw new Error('PIN incorrecto');
  
  // Generar token simple para el trabajador (válido 12h)
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
  const doc = await db.collection('worker_tokens').findOne({
    token, expiresAt: { $gt: new Date() }
  });
  return doc || null;
}

// ── CREAR PARTE (trabajador o admin) ────────────────────────────
async function createParte(data, workerInfo) {
  const db = await getDB();
  
  const parte = {
    // Datos del trabajador
    workerId:    workerInfo.workerId,
    workerName:  workerInfo.workerName,
    
    // Datos del trabajo
    date:        data.date,           // fecha que declara el trabajador
    clientName:  data.clientName || '',
    description: data.description || '',
    horas:       parseFloat(data.horas || 8),
    materiales:  data.materiales || [],  // [{nombre, cantidad, unidad, precio}]
    notas:       data.notas || '',
    
    // Metadatos de control (solo admin puede ver)
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
    
    // Control de admin
    status:         'pendiente',
    adminNotes:     '',
    verifiedAt:     null,
    verifiedBy:     null,
    facturaRef:     null,
    
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await db.collection('partes').insertOne(parte);
  console.log(`[Partes] Nuevo parte: ${result.insertedId} — ${workerInfo.workerName} — ${data.clientName}`);
  return { id: result.insertedId, ...parte };
}

// ── LISTAR PARTES (admin) ────────────────────────────────────────
async function getPartes({ workerId, clientName, status, from, to, limit = 50, skip = 0 } = {}) {
  const db = await getDB();
  const query = {};
  if (workerId)   query.workerId   = workerId;
  if (status)     query.status     = status;
  if (clientName) query.clientName = { $regex: clientName, $options: 'i' };
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

// ── VER PARTE INDIVIDUAL (admin, con metadatos) ──────────────────
async function getParte(id) {
  const db = await getDB();
  return db.collection('partes').findOne({ _id: new ObjectId(id) });
}

// ── ACTUALIZAR PARTE (solo admin) ────────────────────────────────
async function updateParte(id, updates, adminName) {
  const db = await getDB();
  const allowed = ['date','clientName','description','horas','materiales','notas','status','adminNotes','facturaRef'];
  const set = { updatedAt: new Date() };
  allowed.forEach(k => { if (updates[k] !== undefined) set[k] = updates[k]; });
  
  if (updates.status === 'verificado') {
    set.verifiedAt = new Date();
    set.verifiedBy = adminName;
  }
  
  return db.collection('partes').updateOne({ _id: new ObjectId(id) }, { $set: set });
}

// ── RESUMEN PARA FACTURACIÓN ────────────────────────────────────
async function getResumenFacturacion({ from, to, clientName } = {}) {
  const db = await getDB();
  const query = { status: { $in: ['verificado', 'pendiente'] } };
  if (clientName) query.clientName = { $regex: clientName, $options: 'i' };
  if (from || to) { query.date = {}; if (from) query.date.$gte = from; if (to) query.date.$lte = to; }
  
  const partes = await db.collection('partes').find(query).toArray();
  
  // Agrupar por cliente
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
  WORKERS, ESTADOS_PARTE,
  workerLogin, verifyWorkerToken,
  createParte, getPartes, getParte, updateParte,
  getResumenFacturacion
};
