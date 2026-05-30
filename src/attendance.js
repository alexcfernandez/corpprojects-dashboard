
// src/attendance.js — Gestión de presencia y partes de horas
// Usa MongoDB Atlas para persistencia permanente

const { MongoClient, ObjectId } = require('mongodb');

let db = null;

async function getDB() {
  if (db) return db;
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI no configurada en Railway Variables');
  }
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  db = client.db('corpprojects');
  console.log('[MongoDB] Conectado correctamente');
  return db;
}

// ── TRABAJADORES ──────────────────────────────────────────────────
const WORKERS = [
  { id: 'jose',     name: 'Jose Beliard',    color: '#4d9cf8' },
  { id: 'diego',    name: 'Diego Campillo',  color: '#22c487' },
  { id: 'abdellah', name: 'Abdellah Souiri', color: '#f59e0b' },
  { id: 'mamadou',  name: 'Mamadou Barry',   color: '#a78bfa' },
  { id: 'paula',    name: 'Paula Morales',   color: '#f05252' },
];

const ESTADOS = {
  obra:       { label: 'En obra',          color: '#22c487', emoji: '🏗️' },
  oficina:    { label: 'Oficina/almacén',  color: '#4d9cf8', emoji: '🏢' },
  vacaciones: { label: 'Vacaciones',       color: '#a78bfa', emoji: '🌴' },
  baja:       { label: 'Baja médica',      color: '#f59e0b', emoji: '🏥' },
  falta_j:    { label: 'Falta justificada',color: '#f59e0b', emoji: '📋' },
  falta_i:    { label: 'Falta injustificada',color:'#f05252',emoji: '❌' },
  libre:      { label: 'Libre/descanso',   color: '#5a6278', emoji: '⏸️' },
};

// ── CRUD ENTRADAS DE PRESENCIA ────────────────────────────────────

// Guardar/actualizar entrada
// entry = { workerId, date (YYYY-MM-DD), estado, clientId, clientName, horas, notas }
async function saveAttendance(entry) {
  const db = await getDB();
  const col = db.collection('attendance');
  
  // Clave única: trabajador + fecha
  const filter = { workerId: entry.workerId, date: entry.date };
  const update  = { $set: { ...entry, updatedAt: new Date() } };
  const result  = await col.updateOne(filter, update, { upsert: true });
  return result;
}

// Borrar entrada
async function deleteAttendance(workerId, date) {
  const db = await getDB();
  return db.collection('attendance').deleteOne({ workerId, date });
}

// Obtener entradas por rango de fechas
async function getAttendance({ workerId, from, to, clientName }) {
  const db    = await getDB();
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

// Resumen mensual: horas por trabajador + cliente
async function getMonthlySummary(year, month) {
  const db   = await getDB();
  const from = `${year}-${String(month).padStart(2,'0')}-01`;
  const to   = `${year}-${String(month).padStart(2,'0')}-31`;
  
  const entries = await db.collection('attendance')
    .find({ date: { $gte: from, $lte: to } })
    .sort({ date: 1 })
    .toArray();

  // Agrupar por trabajador
  const byWorker = {};
  WORKERS.forEach(w => {
    byWorker[w.id] = {
      ...w, dias: 0, horas: 0, dias_obra: 0, dias_falta: 0,
      clientes: {}, entries: []
    };
  });

  entries.forEach(e => {
    const w = byWorker[e.workerId];
    if (!w) return;
    w.dias++;
    w.horas += parseFloat(e.horas || 8);
    w.entries.push(e);
    
    if (e.estado === 'obra') {
      w.dias_obra++;
      const k = e.clientName || 'Sin cliente';
      if (!w.clientes[k]) w.clientes[k] = { dias: 0, horas: 0 };
      w.clientes[k].dias++;
      w.clientes[k].horas += parseFloat(e.horas || 8);
    }
    if (['falta_i', 'falta_j', 'baja'].includes(e.estado)) w.dias_falta++;
  });

  return { year, month, byWorker: Object.values(byWorker), entries };
}

// Extracto por cliente: qué trabajadores y cuántos días
async function getClientExtract(clientName, from, to) {
  const db = await getDB();
  const entries = await db.collection('attendance').find({
    clientName: { $regex: clientName, $options: 'i' },
    estado: 'obra',
    date: { $gte: from, $lte: to }
  }).sort({ date: 1 }).toArray();

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
