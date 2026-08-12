// src/activos.js — Custodia de activos físicos: LLAVES y HERRAMIENTAS.
// Patrón único "el objeto tiene un dueño temporal y un historial de manos".
//   · activos            → un registro por llave/herramienta (código en la etiqueta).
//   · activoMovimientos  → cadena de custodia (quién → a quién, cuándo, quién lo apunta).
// La LLAVE solo lleva su CÓDIGO impreso; la dirección/cliente viven aquí (si se
// pierde el llavero, no delata la puerta). Estados: oficina | operario | cliente | perdida.
const { ObjectId } = require('mongodb');

async function getDB() { return require('./db').getDB(); }

const TIPOS = ['llave', 'herramienta'];
const PREFIJO = { llave: 'L', herramienta: 'H' };
const ESTADOS = ['oficina', 'operario', 'cliente', 'perdida'];

// Campos que se pueden editar por tipo (más los comunes).
const CAMPOS_COMUNES = ['nombre', 'obraId', 'obraRef', 'foto', 'notas'];
const CAMPOS_LLAVE   = ['clientName', 'direccion', 'copias', 'fechaEntrega'];
const CAMPOS_HERR    = ['marca', 'modelo', 'numeroSerie', 'valor', 'fechaCompra'];

// Siguiente código libre para un tipo: prefijo + número correlativo (L-001…).
async function siguienteCodigo(db, tipo) {
  const pref = PREFIJO[tipo] || 'A';
  const rx = new RegExp('^' + pref + '-(\\d+)$');
  const arr = await db.collection('activos').find({ tipo }, { projection: { codigo: 1 } }).toArray();
  let max = 0;
  arr.forEach(a => { const m = rx.exec(a.codigo || ''); if (m) max = Math.max(max, parseInt(m[1], 10)); });
  return `${pref}-${String(max + 1).padStart(3, '0')}`;
}

async function logMovimiento(db, activo, accion, { de, a, by, nota } = {}) {
  await db.collection('activoMovimientos').insertOne({
    activoId: String(activo._id), codigo: activo.codigo, accion,
    deTipo: de?.tipo || null, deId: de?.id || null, deName: de?.name || null,
    aTipo:  a?.tipo  || null, aId:  a?.id  || null, aName:  a?.name  || null,
    ts: new Date(), by: by || '', nota: nota || '',
  });
}

// Listado ligero (SIN foto, para no pesar). Filtros opcionales.
async function getActivos({ tipo, estado, holderId, search } = {}) {
  const db = await getDB();
  const q = {};
  if (tipo)     q.tipo = tipo;
  if (estado)   q.estado = estado;
  if (holderId) q.holderId = String(holderId);
  if (search)   q.$or = [
    { codigo:     { $regex: search, $options: 'i' } },
    { nombre:     { $regex: search, $options: 'i' } },
    { clientName: { $regex: search, $options: 'i' } },
    { direccion:  { $regex: search, $options: 'i' } },
    { holderName: { $regex: search, $options: 'i' } },
  ];
  return db.collection('activos').find(q, { projection: { foto: 0 } }).sort({ tipo: 1, codigo: 1 }).toArray();
}

// Ficha completa (con foto) + su historial de movimientos.
async function getActivo(id) {
  const db = await getDB();
  const activo = await db.collection('activos').findOne({ _id: new ObjectId(id) });
  if (!activo) throw new Error('Activo no encontrado');
  const movimientos = await db.collection('activoMovimientos').find({ activoId: String(id) }).sort({ ts: -1 }).toArray();
  return { activo, movimientos };
}

async function crearActivo(data, by) {
  const db = await getDB();
  const tipo = TIPOS.includes(data.tipo) ? data.tipo : null;
  if (!tipo) throw new Error('Tipo no válido (llave o herramienta)');
  if (tipo === 'llave' && !data.clientName) throw new Error('La llave necesita el cliente');
  if (tipo === 'herramienta' && !String(data.nombre || '').trim()) throw new Error('La herramienta necesita un nombre');

  const codigo = (data.codigo && String(data.codigo).trim()) || await siguienteCodigo(db, tipo);
  const dup = await db.collection('activos').findOne({ codigo });
  if (dup) throw new Error(`El código ${codigo} ya existe`);

  const activo = {
    tipo, codigo,
    nombre:      String(data.nombre || '').trim() || (tipo === 'llave' ? `Llave ${data.clientName || ''}`.trim() : ''),
    clientName:  String(data.clientName || '').trim(),
    direccion:   String(data.direccion || '').trim(),
    copias:      Number(data.copias) || 1,
    fechaEntrega: data.fechaEntrega || null,
    marca:       String(data.marca || '').trim(),
    modelo:      String(data.modelo || '').trim(),
    numeroSerie: String(data.numeroSerie || '').trim(),
    valor:       Number(data.valor) || 0,
    fechaCompra: data.fechaCompra || null,
    obraId:      data.obraId ? String(data.obraId) : null,
    obraRef:     String(data.obraRef || '').trim(),
    foto:        data.foto || '',
    notas:       String(data.notas || '').trim(),
    estado:      'oficina',
    holderType:  'oficina', holderId: null, holderName: 'Oficina',
    createdAt:   new Date(), updatedAt: new Date(), by: by || '',
  };
  const r = await db.collection('activos').insertOne(activo);
  activo._id = r.insertedId;
  await logMovimiento(db, activo, 'alta', { a: { tipo: 'oficina', name: 'Oficina' }, by });
  return { ok: true, id: String(r.insertedId), codigo };
}

async function editarActivo(id, data, by) {
  const db = await getDB();
  const activo = await db.collection('activos').findOne({ _id: new ObjectId(id) });
  if (!activo) throw new Error('Activo no encontrado');
  const permitidos = [...CAMPOS_COMUNES, ...(activo.tipo === 'llave' ? CAMPOS_LLAVE : CAMPOS_HERR)];
  const set = { updatedAt: new Date() };
  permitidos.forEach(k => { if (k in data) set[k] = data[k]; });
  await db.collection('activos').updateOne({ _id: activo._id }, { $set: set });
  return { ok: true };
}

// Dar el activo a alguien: operario (holderId+name) o cliente/otro (solo name).
async function darActivo(id, { holderType, holderId, holderName, nota }, by) {
  const db = await getDB();
  const activo = await db.collection('activos').findOne({ _id: new ObjectId(id) });
  if (!activo) throw new Error('Activo no encontrado');
  const tipoDest = (holderType === 'operario' || holderType === 'cliente') ? holderType : 'operario';
  if (!String(holderName || '').trim()) throw new Error('Indica a quién se lo das');
  const de = { tipo: activo.holderType, id: activo.holderId, name: activo.holderName };
  const a  = { tipo: tipoDest, id: holderId ? String(holderId) : null, name: String(holderName).trim() };
  await db.collection('activos').updateOne({ _id: activo._id }, { $set: {
    estado: tipoDest, holderType: tipoDest, holderId: a.id, holderName: a.name, updatedAt: new Date(),
  } });
  await logMovimiento(db, activo, 'dar', { de, a, by, nota });
  return { ok: true };
}

// Devolver a oficina.
async function devolverActivo(id, { nota }, by) {
  const db = await getDB();
  const activo = await db.collection('activos').findOne({ _id: new ObjectId(id) });
  if (!activo) throw new Error('Activo no encontrado');
  const de = { tipo: activo.holderType, id: activo.holderId, name: activo.holderName };
  await db.collection('activos').updateOne({ _id: activo._id }, { $set: {
    estado: 'oficina', holderType: 'oficina', holderId: null, holderName: 'Oficina', updatedAt: new Date(),
  } });
  await logMovimiento(db, activo, 'devolver', { de, a: { tipo: 'oficina', name: 'Oficina' }, by, nota });
  return { ok: true };
}

async function marcarPerdida(id, { nota }, by) {
  const db = await getDB();
  const activo = await db.collection('activos').findOne({ _id: new ObjectId(id) });
  if (!activo) throw new Error('Activo no encontrado');
  const de = { tipo: activo.holderType, id: activo.holderId, name: activo.holderName };
  await db.collection('activos').updateOne({ _id: activo._id }, { $set: {
    estado: 'perdida', updatedAt: new Date(),
  } });
  await logMovimiento(db, activo, 'perdida', { de, by, nota });
  return { ok: true };
}

async function eliminarActivo(id) {
  const db = await getDB();
  await db.collection('activos').deleteOne({ _id: new ObjectId(id) });
  await db.collection('activoMovimientos').deleteMany({ activoId: String(id) });
  return { ok: true };
}

module.exports = {
  TIPOS, ESTADOS,
  getActivos, getActivo, crearActivo, editarActivo,
  darActivo, devolverActivo, marcarPerdida, eliminarActivo, siguienteCodigo,
};
