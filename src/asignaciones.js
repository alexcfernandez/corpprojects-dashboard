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
  rows.forEach(r => { map[String(r.workOrderId)] = { userId: r.userId, userName: r.userName }; });
  return map;
}

// Asigna (o desasigna) un pedido a un usuario. Devuelve el estado resultante.
async function setAssignment(workOrderId, userId, assignedBy) {
  if (!workOrderId) throw new Error('Falta el pedido');
  const db = await getDB();
  const woId = String(workOrderId);

  // Desasignar
  if (!userId) {
    await db.collection('workOrderAssignments').deleteOne({ workOrderId: woId });
    return { workOrderId: woId, userId: null, userName: null };
  }

  // Resolver el nombre del usuario para guardarlo cacheado
  let userName = '';
  try {
    const { getUser } = require('./users');
    const u = await getUser(userId);
    userName = u ? u.name : '';
  } catch { userName = ''; }

  await db.collection('workOrderAssignments').updateOne(
    { workOrderId: woId },
    { $set: { workOrderId: woId, userId: String(userId), userName, assignedAt: new Date(), assignedBy: assignedBy || null } },
    { upsert: true }
  );
  return { workOrderId: woId, userId: String(userId), userName };
}

// Fusiona la info de asignación en una lista de pedidos (añade assignedUserId / assignedUserName).
async function attachAssignments(list) {
  const map = await getAssignmentMap();
  (Array.isArray(list) ? list : []).forEach(p => {
    const a = map[String(p.id)];
    p.assignedUserId   = a ? a.userId : null;
    p.assignedUserName = a ? a.userName : null;
  });
  return list;
}

module.exports = { getAssignmentMap, setAssignment, attachAssignments };
