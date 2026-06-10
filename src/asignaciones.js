// src/asignaciones.js — Asignación de pedidos de trabajo a trabajadores propios.
// Vive en NUESTRA base de datos (no en StelOrder, para no pagar usuarios extra).
//  · workOrderAssignments: { workOrderId, userId, userName, assignedAt, assignedBy }
// Un pedido tiene como mucho un asignado. Asignar con userId vacío = desasignar.

async function getDB() {
  return require('./db').getDB();
}

// Mapa { [workOrderId]: { userId, userName } } para fusionar con la lista de pedidos.
async function getAssignmentMap() {
  const db = await getDB();
  const rows = await db.collection('workOrderAssignments').find({}).toArray();
  const map = {};
  rows.forEach(r => { map[String(r.workOrderId)] = { userId: r.userId, userName: r.userName, priority: r.priority || 'normal' }; });
  return map;
}

// Asigna (o desasigna) un pedido a un usuario, con prioridad ('urgent'|'normal').
// Devuelve el estado resultante. Asignar con userId vacío = desasignar.
async function setAssignment(workOrderId, userId, assignedBy, priority) {
  if (!workOrderId) throw new Error('Falta el pedido');
  const db = await getDB();
  const woId = String(workOrderId);

  // Desasignar
  if (!userId) {
    await db.collection('workOrderAssignments').deleteOne({ workOrderId: woId });
    return { workOrderId: woId, userId: null, userName: null, priority: null };
  }

  // Resolver el nombre del usuario para guardarlo cacheado
  let userName = '';
  try {
    const { getUser } = require('./users');
    const u = await getUser(userId);
    userName = u ? u.name : '';
  } catch { userName = ''; }

  const prio = (priority === 'urgent') ? 'urgent' : 'normal';
  await db.collection('workOrderAssignments').updateOne(
    { workOrderId: woId },
    { $set: { workOrderId: woId, userId: String(userId), userName, priority: prio, assignedAt: new Date(), assignedBy: assignedBy || null } },
    { upsert: true }
  );
  return { workOrderId: woId, userId: String(userId), userName, priority: prio };
}

// Fusiona la info de asignación en una lista de pedidos.
async function attachAssignments(list) {
  const map = await getAssignmentMap();
  (Array.isArray(list) ? list : []).forEach(p => {
    const a = map[String(p.id)];
    p.assignedUserId   = a ? a.userId : null;
    p.assignedUserName = a ? a.userName : null;
    p.assignedPriority = a ? (a.priority || 'normal') : null;
  });
  return list;
}

// ── CRONÓMETRO DE TRABAJO (Fase 3B) ─────────────────────────────────────
// workOrderTimers: { workOrderId, workerId, workerName, startedAt, finishedAt }
// Una "sesión" por inicio. Si el trabajo continúa otro día, habrá varias sesiones.

// Inicia una sesión (si ya hay una abierta para este pedido+trabajador, la devuelve tal cual).
async function startWork(workOrderId, workerId, workerName) {
  if (!workOrderId || !workerId) throw new Error('Faltan datos');
  const db = await getDB();
  const open = await db.collection('workOrderTimers').findOne({
    workOrderId: String(workOrderId), workerId: String(workerId), finishedAt: null
  });
  if (open) return { startedAt: open.startedAt, alreadyRunning: true };
  const startedAt = new Date();
  await db.collection('workOrderTimers').insertOne({
    workOrderId: String(workOrderId), workerId: String(workerId),
    workerName: workerName || '', startedAt, finishedAt: null
  });
  return { startedAt, alreadyRunning: false };
}

// Finaliza la sesión abierta. Devuelve duración en minutos.
async function finishWork(workOrderId, workerId) {
  if (!workOrderId || !workerId) throw new Error('Faltan datos');
  const db = await getDB();
  const open = await db.collection('workOrderTimers').findOne({
    workOrderId: String(workOrderId), workerId: String(workerId), finishedAt: null
  });
  if (!open) throw new Error('No hay un trabajo iniciado en este pedido');
  const finishedAt = new Date();
  await db.collection('workOrderTimers').updateOne(
    { _id: open._id }, { $set: { finishedAt } }
  );
  const minutes = Math.max(1, Math.round((finishedAt - open.startedAt) / 60000));
  return { startedAt: open.startedAt, finishedAt, minutes };
}

// Mapa { workOrderId: startedAt } de las sesiones ABIERTAS de un trabajador.
async function getOpenTimers(workerId) {
  const db = await getDB();
  const rows = await db.collection('workOrderTimers')
    .find({ workerId: String(workerId), finishedAt: null }).toArray();
  const map = {};
  rows.forEach(r => { map[String(r.workOrderId)] = r.startedAt; });
  return map;
}

module.exports = { getAssignmentMap, setAssignment, attachAssignments, startWork, finishWork, getOpenTimers };
