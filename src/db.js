// src/db.js — Conexión ÚNICA y compartida a MongoDB
// ---------------------------------------------------------------
// Antes cada módulo (y cada petición de server.js) abría su propia
// conexión. server.js abría una nueva por petición y la cerraba
// dentro del try, así que cualquier error dejaba la conexión colgada
// hasta agotar el pool de Atlas. Ahora hay UN solo cliente con pool
// reutilizable que comparten todos los módulos.
//
// Dos contratos soportados para no romper el código existente:
//   getDB()       -> devuelve el `db` directamente (módulos nuevos/limpios)
//   getDBLegacy() -> devuelve { db, client } donde client.close() no hace
//                    nada, para el código viejo que cerraba a mano.
// ---------------------------------------------------------------
const { MongoClient } = require('mongodb');

let client     = null;
let db         = null;
let connecting = null;

// client "de mentira" para el código antiguo que llama a client.close().
// Cerrar de verdad mataría la conexión compartida, así que no hace nada.
const noopClient = { close: async () => {} };

async function getDB() {
  if (db) return db;
  if (connecting) return connecting;

  connecting = (async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI no configurada');

    client = new MongoClient(uri, {
      maxPoolSize: 10,            // reutiliza hasta 10 conexiones
      minPoolSize: 1,
      serverSelectionTimeoutMS: 10000,
      retryWrites: true,
    });
    await client.connect();
    db = client.db('corpprojects');
    console.log('[DB] ✅ Conexión única a MongoDB establecida (pool compartido)');

    await ensureIndexes(db);
    return db;
  })();

  try {
    return await connecting;
  } catch (err) {
    // si falla la conexión, reseteamos para reintentar en la próxima llamada
    client = null; db = null;
    throw err;
  } finally {
    connecting = null;
  }
}

// Contrato antiguo: { db, client }. El client es un no-op.
async function getDBLegacy() {
  const database = await getDB();
  return { db: database, client: noopClient };
}

// Todos los índices que antes creaba cada módulo, ahora en un solo sitio.
// Cada uno va envuelto para que un fallo aislado no impida arrancar.
async function ensureIndexes(db) {
  const indexes = [
    ['users',                  { pin: 1 }],
    ['users',                  { role: 1 }],
    ['user_sessions',          { token: 1 },                 { unique: true }],
    ['user_sessions',          { expiresAt: 1 },             { expireAfterSeconds: 0 }],
    ['partes',                 { date: -1 }],
    ['partes',                 { workerId: 1, date: -1 }],
    ['partes',                 { clientName: 1 }],
    ['partes',                 { status: 1 }],
    ['partes',                 { expedienteId: 1 }],
    ['partes',                 { asignacionId: 1 }],
    ['worker_tokens',          { token: 1 },                 { unique: true }],
    ['colaboradores',          { nombre: 1 }],
    ['colaborador_movimientos',{ colaboradorId: 1, fecha: -1 }],
    ['colaborador_movimientos',{ fecha: -1 }],
    ['expedientes',            { clientName: 1, estado: 1 }],
    ['expedientes',            { fechaApertura: -1 }],
    ['asignaciones',           { fecha: -1 }],
    ['asignaciones',           { 'equipo.id': 1 }],
    ['externos',               { nombre: 1 }],
    ['pagos',                  { fecha: -1 }],
    ['pagos',                  { persona: 1 }],
    ['pagos',                  { tipo: 1 }],
    ['obras',                  { clientName: 1 }],
    ['obras',                  { status: 1 }],
    ['obras',                  { createdAt: -1 }],
    // attendance ya tiene un índice ÚNICO {workerId, date} creado de antes
    // (garantiza un solo registro por trabajador y día). No lo recreamos.
    // Añadimos solo este para acelerar las consultas por fecha del calendario:
    ['attendance',             { date: 1 }],
  ];

  for (const [coll, keys, opts] of indexes) {
    try {
      await db.collection(coll).createIndex(keys, opts || {});
    } catch (e) {
      console.warn(`[DB] Aviso creando índice en ${coll}:`, e.message);
    }
  }
  console.log('[DB] Índices verificados');
}

async function close() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

module.exports = { getDB, getDBLegacy, close };
