// src/planning.js — Agenda de planificación (lo PREVISTO).
// Separada de attendance (que es lo REAL/pasado). Un registro = una asignación:
// un trabajador (o una visita propia) en una fecha, opcionalmente en una obra
// y enlazado a un pedido de trabajo.
// Colección: planning
//   { _id, date:'YYYY-MM-DD', workerId, workerName, color,
//     tipo:'trabajo'|'visita', client, address, workOrderId, workOrderNumber,
//     nota, horaInicio, createdAt, updatedAt }

async function getDB() {
  const { db } = await require('./db').getDBLegacy();
  return db;
}

// Listar planificaciones entre dos fechas (incluidas).
async function getPlanning(from, to) {
  const db = await getDB();
  const q = {};
  if (from || to) {
    q.date = {};
    if (from) q.date.$gte = from;
    if (to)   q.date.$lte = to;
  }
  return db.collection('planning').find(q).sort({ date: 1, horaInicio: 1 }).toArray();
}

// Crear una planificación.
async function createPlanning(data) {
  const db = await getDB();
  const doc = {
    date:            String(data.date || '').slice(0, 10),
    workerId:        data.workerId || null,
    workerName:      data.workerName || '',
    color:           data.color || '#4d9cf8',
    tipo:            data.tipo === 'visita' ? 'visita' : 'trabajo',
    client:          data.client || '',
    address:         data.address || '',
    workOrderId:     data.workOrderId || null,
    workOrderNumber: data.workOrderNumber || '',
    nota:            data.nota || '',
    horaInicio:      data.horaInicio || '',
    createdAt:       new Date(),
    updatedAt:       new Date()
  };
  if (!doc.date) throw new Error('Falta la fecha');
  const r = await db.collection('planning').insertOne(doc);
  doc._id = r.insertedId;
  return doc;
}

// Actualizar (solo los campos enviados).
async function updatePlanning(id, data) {
  const db = await getDB();
  const { ObjectId } = require('mongodb');
  const allowed = ['date','workerId','workerName','color','tipo','client','address','workOrderId','workOrderNumber','nota','horaInicio'];
  const set = { updatedAt: new Date() };
  for (const k of allowed) if (k in data) set[k] = data[k];
  if (set.date) set.date = String(set.date).slice(0, 10);
  await db.collection('planning').updateOne({ _id: new ObjectId(id) }, { $set: set });
  return { ok: true };
}

async function deletePlanning(id) {
  const db = await getDB();
  const { ObjectId } = require('mongodb');
  await db.collection('planning').deleteOne({ _id: new ObjectId(id) });
  return { deleted: true };
}

module.exports = { getPlanning, createPlanning, updatePlanning, deletePlanning };
