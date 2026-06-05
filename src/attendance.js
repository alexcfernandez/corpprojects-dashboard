// src/attendance.js — v4 con config central
const { MongoClient } = require('mongodb');
const CONFIG = require('./config');

let db = null;
let connecting = false;

async function getDB() {
  if (db) return db;
  if (connecting) {
    await new Promise(r => setTimeout(r, 2000));
    if (db) return db;
  }
  connecting = true;
  console.log('[MongoDB] Iniciando conexión...');
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  await client.db('admin').command({ ping: 1 });
  db = client.db('corpprojects');
  connecting = false;
  console.log('[MongoDB] ✅ Conectado');
  return db;
}

// Desde config — un solo sitio
const WORKERS = CONFIG.workersFallback;
const ESTADOS = CONFIG.estadosPresencia;

let _workersCache     = null;
let _workersCacheTime = 0;

async function getWorkers() {
  if (_workersCache && Date.now() - _workersCacheTime < 5 * 60 * 1000) return _workersCache;
  try {
    const { getUsers } = require('./users');
    const users   = await getUsers(false);
    const workers = users
      .filter(u => u.role === 'tech' || u.role === 'office')
      .map(u => ({ id: String(u._id), name: u.name, color: u.color || '#4d9cf8' }));
    if (workers.length > 0) {
      _workersCache     = workers;
      _workersCacheTime = Date.now();
      return workers;
    }
  } catch(e) {
    console.warn('[Attendance] Usando workers fallback:', e.message);
  }
  return CONFIG.workersFallback;
}

async function saveAttendance(entry) {
  const db = await getDB();
  return db.collection('attendance').updateOne(
    { workerId: entry.workerId, date: entry.date },
    { $set: { ...entry, updatedAt: new Date() } },
    { upsert: true }
  );
}

async function deleteAttendance(workerId, date) {
  const db = await getDB();
  return db.collection('attendance').deleteOne({ workerId, date });
}

async function getAttendance({ workerId, from, to, clientName } = {}) {
  const db = await getDB();
  const query = {};
  if (workerId)   query.workerId   = workerId;
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
    w.dias++;
    w.horas += parseFloat(e.horas || 8);
    if (e.estado === 'obra') {
      w.dias_obra++;
      const k = e.clientName || 'Sin cliente';
      if (!w.clientes[k]) w.clientes[k] = { dias: 0, horas: 0 };
      w.clientes[k].dias++;
      w.clientes[k].horas += parseFloat(e.horas || 8);
    }
    if (['falta_i','falta_j','baja'].includes(e.estado)) w.dias_falta++;
  });
  return { year, month, byWorker: Object.values(byWorker), entries };
}

async function getClientExtract(clientName, from, to) {
  const db = await getDB();
  const query = { estado: 'obra', clientName: { $regex: clientName, $options: 'i' } };
  if (from || to) {
    query.date = {};
    if (from) query.date.$gte = from;
    if (to)   query.date.$lte = to;
  }
  const entries = await db.collection('attendance').find(query).sort({ date: 1 }).toArray();
  const byWorker = {};
  entries.forEach(e => {
    if (!byWorker[e.workerId]) byWorker[e.workerId] = { name: e.workerName, dias: 0, horas: 0, dates: [] };
    byWorker[e.workerId].dias++;
    byWorker[e.workerId].horas += parseFloat(e.horas || 8);
    byWorker[e.workerId].dates.push(e.date);
  });
  return { clientName, from, to, byWorker, totalDias: entries.length };
}

module.exports = { WORKERS, ESTADOS, saveAttendance, deleteAttendance, getAttendance, getMonthlySummary, getClientExtract };
