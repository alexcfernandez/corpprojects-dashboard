// src/expedientes.js — Expedientes de trabajo + Asignaciones + Externos
const { MongoClient, ObjectId } = require('mongodb');

async function getDB() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db('corpprojects');
  await db.collection('expedientes').createIndex({ clientName: 1, estado: 1 });
  await db.collection('expedientes').createIndex({ fechaApertura: -1 });
  await db.collection('asignaciones').createIndex({ fecha: -1 });
  await db.collection('asignaciones').createIndex({ 'equipo.id': 1 });
  await db.collection('externos').createIndex({ nombre: 1 });
  return { db, client };
}

// ══════════════════════════════════════════════════════════════════
// EXTERNOS
// ══════════════════════════════════════════════════════════════════

async function getExternos() {
  const { db, client } = await getDB();
  const lista = await db.collection('externos').find({}).sort({ nombre: 1 }).toArray();
  await client.close();
  return lista;
}

async function createExterno(data) {
  const { db, client } = await getDB();
  const externo = {
    nombre:    data.nombre.trim(),
    telefono:  data.telefono || '',
    oficio:    data.oficio || '',   // albañil, pintor, electricista...
    notas:     data.notas || '',
    activo:    true,
    creadoEn:  new Date()
  };
  const result = await db.collection('externos').insertOne(externo);
  await client.close();
  return { _id: result.insertedId, ...externo };
}

async function updateExterno(id, data) {
  const { db, client } = await getDB();
  await db.collection('externos').updateOne(
    { _id: new ObjectId(id) },
    { $set: { nombre: data.nombre, telefono: data.telefono, oficio: data.oficio, notas: data.notas } }
  );
  await client.close();
}

async function deleteExterno(id) {
  const { db, client } = await getDB();
  await db.collection('externos').updateOne(
    { _id: new ObjectId(id) },
    { $set: { activo: false } }
  );
  await client.close();
}

// ══════════════════════════════════════════════════════════════════
// ASIGNACIONES
// ══════════════════════════════════════════════════════════════════

async function getAsignaciones({ fecha, workerId } = {}) {
  const { db, client } = await getDB();
  const query = {};
  if (fecha) query.fecha = fecha;
  if (workerId) query['equipo.id'] = workerId;
  const lista = await db.collection('asignaciones').find(query).sort({ fecha: -1, horaInicio: 1 }).toArray();
  await client.close();
  return lista;
}

async function getAsignacionesDelDia(fecha) {
  const { db, client } = await getDB();
  const lista = await db.collection('asignaciones')
    .find({ fecha })
    .sort({ horaInicio: 1 })
    .toArray();
  await client.close();
  return lista;
}

async function createAsignacion(data) {
  const { db, client } = await getDB();

  // equipo: [{id, nombre, tipo: 'plantilla'|'externo', esResponsable: bool}]
  const asignacion = {
    fecha:       data.fecha,           // 'YYYY-MM-DD'
    horaInicio:  data.horaInicio || '',
    horaFin:     data.horaFin || '',
    clientName:  data.clientName || '',
    descripcion: data.descripcion || '',
    tipoJornada: data.tipoJornada || 'NORMAL', // NORMAL | EXTRA | GUARDIA
    equipo:      data.equipo || [],    // array de miembros
    estado:      'PENDIENTE',          // PENDIENTE | EN_CURSO | COMPLETADA | CANCELADA
    expedienteId: data.expedienteId || null,
    notas:       data.notas || '',
    creadoEn:    new Date(),
    actualizadoEn: new Date()
  };

  const result = await db.collection('asignaciones').insertOne(asignacion);
  await client.close();
  console.log(`[Asignaciones] Nueva: ${data.clientName} — ${data.fecha}`);
  return { _id: result.insertedId, ...asignacion };
}

async function updateAsignacion(id, data) {
  const { db, client } = await getDB();
  const allowed = ['fecha','horaInicio','horaFin','clientName','descripcion','tipoJornada','equipo','estado','notas','expedienteId'];
  const set = { actualizadoEn: new Date() };
  allowed.forEach(k => { if (data[k] !== undefined) set[k] = data[k]; });
  await db.collection('asignaciones').updateOne({ _id: new ObjectId(id) }, { $set: set });
  await client.close();
}

async function deleteAsignacion(id) {
  const { db, client } = await getDB();
  await db.collection('asignaciones').deleteOne({ _id: new ObjectId(id) });
  await client.close();
}

// Devuelve asignaciones del día para un trabajador concreto
async function getAsignacionesWorker(workerId, fecha) {
  const { db, client } = await getDB();
  const hoy = fecha || new Date().toISOString().slice(0, 10);
  const lista = await db.collection('asignaciones').find({
    fecha: hoy,
    'equipo.id': workerId,
    estado: { $ne: 'CANCELADA' }
  }).sort({ horaInicio: 1 }).toArray();
  await client.close();
  return lista;
}

// ══════════════════════════════════════════════════════════════════
// EXPEDIENTES
// ══════════════════════════════════════════════════════════════════

async function getExpedientes({ estado, clientName } = {}) {
  const { db, client } = await getDB();
  const query = {};
  if (estado) query.estado = estado;
  if (clientName) query.clientName = { $regex: clientName, $options: 'i' };
  const lista = await db.collection('expedientes').find(query).sort({ fechaApertura: -1 }).toArray();
  await client.close();
  return lista;
}

async function getExpediente(id) {
  const { db, client } = await getDB();
  const exp = await db.collection('expedientes').findOne({ _id: new ObjectId(id) });
  if (!exp) { await client.close(); return null; }
  // Cargar todos los partes vinculados ordenados por fecha
  const partes = await db.collection('partes')
    .find({ expedienteId: id })
    .sort({ date: 1, '_meta.submittedAt': 1 })
    .toArray();
  await client.close();
  return { ...exp, partes };
}

async function createExpediente(data) {
  const { db, client } = await getDB();
  // Generar número de expediente
  const count = await db.collection('expedientes').countDocuments();
  const numero = `EXP-${String(count + 1).padStart(4, '0')}`;

  const expediente = {
    numero,
    clientName:      data.clientName || '',
    descripcion:     data.descripcion || '',
    estado:          'EN_CURSO',  // EN_CURSO | COMPLETADO | PAUSADO
    fechaApertura:   new Date(),
    fechaCierre:     null,
    stelOrderRef:    null,
    totalHoras:      0,
    notas:           data.notas || '',
    creadoEn:        new Date(),
    actualizadoEn:   new Date()
  };

  const result = await db.collection('expedientes').insertOne(expediente);
  await client.close();
  console.log(`[Expedientes] Nuevo: ${numero} — ${data.clientName}`);
  return { _id: result.insertedId, ...expediente };
}

async function updateExpediente(id, data) {
  const { db, client } = await getDB();
  const allowed = ['clientName','descripcion','estado','notas','stelOrderRef'];
  const set = { actualizadoEn: new Date() };
  allowed.forEach(k => { if (data[k] !== undefined) set[k] = data[k]; });
  if (data.estado === 'COMPLETADO') set.fechaCierre = new Date();
  await db.collection('expedientes').updateOne({ _id: new ObjectId(id) }, { $set: set });
  await client.close();
}

// Recalcula totalHoras del expediente sumando todos sus partes
async function recalcularHorasExpediente(expedienteId) {
  const { db, client } = await getDB();
  const partes = await db.collection('partes').find({ expedienteId }).toArray();
  const totalHoras = partes.reduce((acc, p) => acc + (p.horas || 0), 0);
  await db.collection('expedientes').updateOne(
    { _id: new ObjectId(expedienteId) },
    { $set: { totalHoras, actualizadoEn: new Date() } }
  );
  await client.close();
  return totalHoras;
}

// ══════════════════════════════════════════════════════════════════
// GENERACIÓN AUTOMÁTICA DE PARTES para el equipo
// Cuando Jose envía su parte con equipo → se clonan partes para el resto
// ══════════════════════════════════════════════════════════════════

async function generarPartesEquipo(parteOrigen, equipo) {
  const { db, client } = await getDB();
  const generados = [];

  for (const miembro of equipo) {
    // No generar para el responsable (ya tiene su parte)
    if (miembro.id === parteOrigen.workerId) continue;
    // No generar si ya existe un parte de este miembro para esta asignación
    if (parteOrigen.asignacionId) {
      const existe = await db.collection('partes').findOne({
        asignacionId: parteOrigen.asignacionId,
        workerId: miembro.id
      });
      if (existe) continue;
    }

    const parteClonado = {
      // Datos del miembro del equipo
      workerId:      miembro.id,
      workerName:    miembro.nombre,
      esExterno:     miembro.tipo === 'externo',

      // Datos del trabajo — igual que el original
      date:          parteOrigen.date,
      clientName:    parteOrigen.clientName,
      description:   parteOrigen.description,
      horas:         parteOrigen.horas,
      materiales:    [],   // materiales solo del responsable
      notas:         `Parte generado automáticamente desde parte de ${parteOrigen.workerName}`,

      // Vinculaciones
      asignacionId:  parteOrigen.asignacionId || null,
      expedienteId:  parteOrigen.expedienteId || null,
      parteOrigenId: String(parteOrigen._id || parteOrigen.id),
      generadoAuto:  true,

      // Estado trabajo — hereda del original
      estadoTrabajo:     parteOrigen.estadoTrabajo || 'completado',
      pendienteDetalle:  parteOrigen.pendienteDetalle || '',
      tipoJornada:       parteOrigen.tipoJornada || 'NORMAL',

      _meta: {
        submittedAt:  new Date(),
        submittedBy:  'auto',
        fotosTrabajo: [],
        fotosAlbaran: [],
        gpsLat: null, gpsLng: null, gpsAccuracy: null
      },

      status:      'pendiente',
      adminNotes:  '',
      verifiedAt:  null,
      verifiedBy:  null,
      facturaRef:  null,
      createdAt:   new Date(),
      updatedAt:   new Date()
    };

    const result = await db.collection('partes').insertOne(parteClonado);
    generados.push({ id: result.insertedId, workerName: miembro.nombre });
    console.log(`[Expedientes] Parte auto-generado para ${miembro.nombre}`);
  }

  await client.close();
  return generados;
}

// Si el parte dice "continúa" → busca o crea expediente y lo vincula
async function vincularOCrearExpediente(parteId, clientName, descripcion, expedienteIdExistente) {
  const { db, client } = await getDB();

  let expedienteId = expedienteIdExistente;

  if (!expedienteId) {
    // Buscar si hay expediente EN_CURSO para este cliente
    const expExistente = await db.collection('expedientes').findOne({
      clientName,
      estado: 'EN_CURSO'
    });

    if (expExistente) {
      expedienteId = String(expExistente._id);
    } else {
      // Crear expediente nuevo
      const count = await db.collection('expedientes').countDocuments();
      const numero = `EXP-${String(count + 1).padStart(4, '0')}`;
      const result = await db.collection('expedientes').insertOne({
        numero,
        clientName,
        descripcion,
        estado:        'EN_CURSO',
        fechaApertura: new Date(),
        fechaCierre:   null,
        stelOrderRef:  null,
        totalHoras:    0,
        notas:         '',
        creadoEn:      new Date(),
        actualizadoEn: new Date()
      });
      expedienteId = String(result.insertedId);
      console.log(`[Expedientes] Creado automáticamente: ${numero} — ${clientName}`);
    }
  }

  // Vincular el parte al expediente
  await db.collection('partes').updateOne(
    { _id: new ObjectId(parteId) },
    { $set: { expedienteId, updatedAt: new Date() } }
  );

  await client.close();
  await recalcularHorasExpediente(expedienteId);
  return expedienteId;
}

module.exports = {
  // Externos
  getExternos, createExterno, updateExterno, deleteExterno,
  // Asignaciones
  getAsignaciones, getAsignacionesDelDia, createAsignacion,
  updateAsignacion, deleteAsignacion, getAsignacionesWorker,
  // Expedientes
  getExpedientes, getExpediente, createExpediente,
  updateExpediente, recalcularHorasExpediente,
  // Automatismos
  generarPartesEquipo, vincularOCrearExpediente
};
