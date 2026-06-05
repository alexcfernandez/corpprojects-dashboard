// src/attendance.js — v5 con cálculo correcto de bajas, costes y días cliente
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

const WORKERS = CONFIG.workersFallback;
const ESTADOS = CONFIG.estadosPresencia;

let _workersCache     = null;
let _workersCacheTime = 0;

function _invalidateWorkersCache() {
  _workersCache     = null;
  _workersCacheTime = 0;
  console.log('[Attendance] Caché de workers invalidada');
}

async function getWorkers() {
  if (_workersCache && Date.now() - _workersCacheTime < 5 * 60 * 1000) return _workersCache;
  try {
    const { getUsers } = require('./users');
    const users   = await getUsers(false);
    const workers = users
      .filter(u => u.role === 'tech' || u.role === 'office')
      .map(u => ({
        id:        String(u._id),
        name:      u.name,
        color:     u.color     || '#4d9cf8',
        costeHora: u.costeHora || CONFIG.getRateForWorker(u),
        nota:      u.nota      || '',
      }));
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
    byWorker[w.id] = {
      ...w,
      dias:              0,
      horas_productivas: 0,
      horas_coste:       0,
      coste_real:        0,
      dias_obra:         0,
      dias_falta:        0,
      dias_baja:         0,
      dias_vacaciones:   0,
      clientes:          {},
      ayudantes:         {},
    };
  });

  entries.forEach(e => {
    const w = byWorker[e.workerId];
    if (!w) return;

    const costeHora = w.costeHora || CONFIG.getRateForWorker(w);
    const horas     = parseFloat(e.horas || 8);
    const estado    = e.estado;

    w.dias++;

    if (CONFIG.estadosSinCoste.includes(estado)) {
      // libre — no suma nada

    } else if (CONFIG.estadosSinHorasProductivas.includes(estado)) {
      // baja / vacaciones / falta — coste real pero 0 horas productivas
      w.horas_coste += 8;
      w.coste_real  += 8 * costeHora;
      if (estado === 'baja')                           w.dias_baja++;
      if (estado === 'vacaciones')                     w.dias_vacaciones++;
      if (estado === 'falta_i' || estado === 'falta_j') w.dias_falta++;

    } else {
      // obra / oficina — horas productivas reales
      w.horas_productivas += horas;
      w.horas_coste       += horas;
      w.coste_real        += horas * costeHora;
    }

    // Clientes — solo días en obra
    if (estado === 'obra') {
      w.dias_obra++;
      const k = e.clientName || 'Sin cliente';
      if (!w.clientes[k]) w.clientes[k] = { dias: 0, horas: 0, fechas: [] };
      w.clientes[k].dias++;
      w.clientes[k].horas += horas;
      if (!w.clientes[k].fechas.includes(e.date)) {
        w.clientes[k].fechas.push(e.date);
      }

      // Ayudantes externos de este día
      if (Array.isArray(e.equipo)) {
        e.equipo.forEach(m => {
          if (m.tipo === 'libre' || m.tipo === 'externo') {
            const nombre = m.nombre || '?';
            if (!w.ayudantes[nombre]) w.ayudantes[nombre] = { dias: 0, costeHora: m.costeHora || 0 };
            w.ayudantes[nombre].dias++;
          }
        });
      }
    }
  });

  const result = Object.values(byWorker).map(w => ({
    ...w,
    horas: w.horas_productivas, // compatibilidad con código existente
  }));

  return { year, month, byWorker: result, entries };
}

function buildClientSummary(byWorker) {
  const clientMap = {};

  byWorker.forEach(w => {
    const costeHora = w.costeHora || CONFIG.getRateForWorker(w);
    Object.entries(w.clientes || {}).forEach(([client, v]) => {
      if (!clientMap[client]) {
        clientMap[client] = {
          horas:        0,
          workers:      {},
          fechas:       new Set(),
          coste:        0,
        };
      }
      clientMap[client].horas += v.horas;
      clientMap[client].workers[w.name] = (clientMap[client].workers[w.name] || 0) + v.dias;
      clientMap[client].coste += v.horas * costeHora;
      (v.fechas || []).forEach(f => clientMap[client].fechas.add(f));
    });
  });

  return Object.entries(clientMap)
    .map(([client, v]) => ({
      client,
      horas:       v.horas,
      workers:     v.workers,
      coste:       Math.round(v.coste),
      dias_unicos: v.fechas.size,
      dias_persona: Object.values(v.workers).reduce((s, d) => s + d, 0),
    }))
    .sort((a, b) => b.horas - a.horas);
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

module.exports = {
  WORKERS, ESTADOS,
  saveAttendance, deleteAttendance, getAttendance,
  getMonthlySummary, buildClientSummary, getClientExtract,
  _invalidateWorkersCache,
};
