// src/pagos.js — Pagos en efectivo y adelantos a colaboradores
const { MongoClient, ObjectId } = require('mongodb');

let db = null;

async function getDB() {
  return require('./db').getDB();
}

async function getPagos({ persona, tipo, from, to, limit = 100, skip = 0 } = {}) {
  const db    = await getDB();
  const query = {};
  if (persona) query.persona = { $regex: persona, $options: 'i' };
  if (tipo)    query.tipo    = tipo;
  if (from || to) {
    query.fecha = {};
    if (from) query.fecha.$gte = from;
    if (to)   query.fecha.$lte = to;
  }
  const total = await db.collection('pagos').countDocuments(query);
  const pagos = await db.collection('pagos').find(query)
    .sort({ fecha: -1 }).skip(skip).limit(limit).toArray();
  return { pagos, total };
}

async function getPago(id) {
  const db = await getDB();
  return db.collection('pagos').findOne({ _id: new ObjectId(id) });
}

async function createPago(data) {
  const db   = await getDB();
  const pago = {
    fecha:          data.fecha || new Date().toISOString().slice(0,10),
    persona:        data.persona?.trim(),
    tipo:           data.tipo || 'efectivo',
    concepto:       data.concepto?.trim()    || '',
    importe:        parseFloat(data.importe  || 0),
    diasTrabajados: parseFloat(data.diasTrabajados || 0),
    costeHoraReal:  parseFloat(data.costeHoraReal  || 0),
    clienteObra:    data.clienteObra?.trim() || '',
    notas:          data.notas?.trim()       || '',
    registradoPor:  data.registradoPor || 'admin',
    createdAt:      new Date(),
    updatedAt:      new Date(),
  };

  if (!pago.persona) throw new Error('El nombre de la persona es obligatorio');
  if (!pago.importe || pago.importe <= 0) throw new Error('El importe debe ser mayor que 0');

  const result = await db.collection('pagos').insertOne(pago);
  console.log(`[Pagos] Nuevo pago: ${pago.persona} — ${pago.importe}€ (${pago.tipo})`);
  return { id: result.insertedId, ...pago };
}

async function updatePago(id, data) {
  const db      = await getDB();
  const allowed = ['fecha','persona','tipo','concepto','importe','diasTrabajados','costeHoraReal','clienteObra','notas'];
  const set     = { updatedAt: new Date() };
  allowed.forEach(k => { if (data[k] !== undefined) set[k] = data[k]; });
  if (set.importe)        set.importe        = parseFloat(set.importe);
  if (set.diasTrabajados) set.diasTrabajados = parseFloat(set.diasTrabajados);
  if (set.costeHoraReal)  set.costeHoraReal  = parseFloat(set.costeHoraReal);
  return db.collection('pagos').updateOne({ _id: new ObjectId(id) }, { $set: set });
}

async function deletePago(id) {
  const db = await getDB();
  return db.collection('pagos').deleteOne({ _id: new ObjectId(id) });
}

async function getResumenPagos({ from, to } = {}) {
  const db    = await getDB();
  const query = {};
  if (from || to) {
    query.fecha = {};
    if (from) query.fecha.$gte = from;
    if (to)   query.fecha.$lte = to;
  }
  const pagos = await db.collection('pagos').find(query).sort({ fecha: -1 }).toArray();

  const salidas  = pagos.filter(p => p.tipo !== 'ingreso' && p.tipo !== 'devolucion');
  const entradas = pagos.filter(p => p.tipo === 'ingreso' || p.tipo === 'devolucion');

  const bySalida = {};
  salidas.forEach(p => {
    if (!bySalida[p.persona]) bySalida[p.persona] = { persona: p.persona, totalPagado: 0, pagos: [] };
    bySalida[p.persona].totalPagado += p.importe;
    bySalida[p.persona].pagos.push(p);
  });

  const byEntrada = {};
  entradas.forEach(p => {
    if (!byEntrada[p.persona]) byEntrada[p.persona] = { persona: p.persona, totalCobrado: 0, pagos: [] };
    byEntrada[p.persona].totalCobrado += p.importe;
    byEntrada[p.persona].pagos.push(p);
  });

  const totalEfectivo  = salidas.filter(p=>p.tipo==='efectivo').reduce((s,p)=>s+p.importe,0);
  const totalAdelantos = salidas.filter(p=>p.tipo==='adelanto').reduce((s,p)=>s+p.importe,0);
  const totalMaterial  = salidas.filter(p=>p.tipo==='material').reduce((s,p)=>s+p.importe,0);
  const totalSalidas   = salidas.reduce((s,p)=>s+p.importe,0);
  const totalEntradas  = entradas.reduce((s,p)=>s+p.importe,0);

  return {
    pagos,
    salidas,
    entradas,
    bySalida:  Object.values(bySalida).sort((a,b) => b.totalPagado  - a.totalPagado),
    byEntrada: Object.values(byEntrada).sort((a,b) => b.totalCobrado - a.totalCobrado),
    totales: {
      efectivo:  totalEfectivo,
      adelantos: totalAdelantos,
      material:  totalMaterial,
      salidas:   totalSalidas,
      entradas:  totalEntradas,
      balance:   totalEntradas - totalSalidas,
    },
  };
}

module.exports = { getPagos, getPago, createPago, updatePago, deletePago, getResumenPagos };
