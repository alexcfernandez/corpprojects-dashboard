// src/attendance.js — v4 conexión simplificada
const { MongoClient } = require('mongodb');

let db = null;
let connecting = false;

async function getDB() {
  if (db) return db;
  if (connecting) {
    // Esperar a que termine la conexión en curso
    await new Promise(r => setTimeout(r, 2000));
    if (db) return db;
  }
  
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI no configurada');

  connecting = true;
  console.log('[MongoDB] Iniciando conexión...');

  // Intentar con opciones mínimas primero
  const client = new MongoClient(uri);
  
  await client.connect();
  // Verificar conexión
  await client.db('admin').command({ ping: 1 });
  db = client.db('corpprojects');
  connecting = false;
  console.log('[MongoDB] ✅ Conectado');
  return db;
}

// Workers se cargan desde MongoDB dinámicamente
const WORKERS_FALLBACK = [
  { id: 'jose',     name: 'Jose Beliard',    color: '#4d9cf8' },
  { id: 'diego',    name: 'Diego Campillo',  color: '#22c487' },
  { id: 'abdellah', name: 'Abdellah Souiri', color: '#f59e0b' },
  { id: 'mamadou',  name: 'Mamadou Barry',   color: '#a78bfa' },
  { id: 'paula',    name: 'Paula Morales',   color: '#f05252' },
];

let _workersCache = null;
let _workersCacheTime = 0;

async function getWorkers() {
  // Cache de 5 minutos
  if (_workersCache && Date.now() - _workersCacheTime < 5 * 60 * 1000) return _workersCache;
  try {
    const { getUsers } = require('./users');
    const users = await getUsers(false); // solo activos
    const workers = users
      .filter(u => u.role === 'tech' || u.role === 'office')
      .map(u => ({ id: String(u._id), name: u.name, color: u.color || '#4d9cf8' }));
    if (workers.length > 0) {
      _workersCache = workers;
      _workersCacheTime = Date.now();
      return workers;
    }
  } catch(e) {
    console.warn('[Attendance] Usando workers fallback:', e.message);
  }
  return WORKERS_FALLBACK;
}

// Para compatibilidad con código que usa WORKERS directamente
const WORKERS = WORKERS_FALLBACK;

const ESTADOS = {
  obra:       { label: 'En obra',            color: '#22c487', emoji: '🏗️' },
  oficina:    { label: 'Oficina/almacén',    color: '#4d9cf8', emoji: '🏢' },
  vacaciones: { label: 'Vacaciones',         color: '#a78bfa', emoji: '🌴' },
  baja:       { label: 'Baja médica',        color: '#f59e0b', emoji: '🏥' },
  falta_j:    { label: 'Falta justificada',  color: '#f59e0b', emoji: '📋' },
  falta_i:    { label: 'Falta injustificada',color: '#f05252', emoji: '❌' },
  libre:      { label: 'Libre/descanso',     color: '#5a6278', emoji: '⏸️' },
};

async function saveAttendance(entry) {
  const db = await getDB();
  const filter = { workerId: entry.workerId, date: entry.date };
  const update = { $set: { ...entry, updatedAt: new Date() } };
  return db.collection('attendance').updateOne(filter, update, { upsert: true });
}

async function deleteAttendance(workerId, date) {
  const db = await getDB();
  return db.collection('attendance').deleteOne({ workerId, date });
}

async function getAttendance({ workerId, from, to, clientName } = {}) {
  const db = await getDB();
  const query = {};
  if (workerId)   query.workerId = workerId;
  if (clientName) query.clientName = { $regex: clientName, $options: 'i' };
  if (from || to) {
    query.date = {};
    if (from) query.date.$gte = from;
    if (to)   query.date.$lte = to;
  }
  return db.collection('attendance').find(query).sort({ date: -1 }).toArray();
}

async function getMonthlySummary(year, month) {
  const db   = await getDB();
  const from = `${year}-${String(month).padStart(2,'0')}-01`;
  const to   = `${year}-${String(month).padStart(2,'0')}-31`;
  const entries = await db.collection('attendance')
    .find({ date: { $gte: from, $lte: to } })
    .sort({ date: 1 }).toArray();

  const workersList = await getWorkers();
  const byWorker = {};
  workersList.forEach(w => {
    byWorker[w.id] = { ...w, dias: 0, horas: 0, dias_obra: 0, dias_falta: 0, clientes: {} };
  });
  entries.forEach(e => {
    const w = byWorker[e.workerId]; if (!w) return;
    w.dias++; w.horas += parseFloat(e.horas || 8);
    if (e.estado === 'obra') {
      w.dias_obra++;
      const k = e.clientName || 'Sin cliente';
      if (!w.clientes[k]) w.clientes[k] = { dias: 0, horas: 0 };
      w.clientes[k].dias++; w.clientes[k].horas += parseFloat(e.horas || 8);
    }
    if (['falta_i','falta_j','baja'].includes(e.estado)) w.dias_falta++;
  });
  return { year, month, byWorker: Object.values(byWorker), entries };
}

async function getClientExtract(clientName, from, to) {
  const db = await getDB();
  const query = { estado: 'obra', clientName: { $regex: clientName, $options: 'i' } };
  if (from || to) { query.date = {}; if (from) query.date.$gte=from; if (to) query.date.$lte=to; }
  const entries = await db.collection('attendance').find(query).sort({ date: 1 }).toArray();
  const byWorker = {};
  entries.forEach(e => {
    if (!byWorker[e.workerId]) byWorker[e.workerId]={ name:e.workerName, dias:0, horas:0, dates:[] };
    byWorker[e.workerId].dias++; byWorker[e.workerId].horas+=parseFloat(e.horas||8);
    byWorker[e.workerId].dates.push(e.date);
  });
  return { clientName, from, to, byWorker, totalDias: entries.length };
}

module.exports = { WORKERS, ESTADOS, saveAttendance, deleteAttendance, getAttendance, getMonthlySummary, getClientExtract };
