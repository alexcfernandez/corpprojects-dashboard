// src/obras.js — Módulo de obras y rentabilidad
const { MongoClient, ObjectId } = require('mongodb');

let db = null;

async function getDB() {
  if (db) return db;
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  db = client.db('corpprojects');
  await db.collection('obras').createIndex({ clientName: 1 });
  await db.collection('obras').createIndex({ status: 1 });
  await db.collection('obras').createIndex({ createdAt: -1 });
  console.log('[Obras] MongoDB conectado');
  return db;
}

const ESTADOS_OBRA = {
  activa:     { label: 'En curso',    color: '#22c487', emoji: '🏗️' },
  pausada:    { label: 'Pausada',     color: '#f59e0b', emoji: '⏸️' },
  terminada:  { label: 'Terminada',   color: '#4d9cf8', emoji: '✅' },
  facturada:  { label: 'Facturada',   color: '#a78bfa', emoji: '💰' },
};

// ── CRUD OBRAS ───────────────────────────────────────────────────
async function createObra(data) {
  const db = await getDB();
  const obra = {
    // Identificación
    clientName:   data.clientName?.trim() || '',
    reference:    data.reference?.trim() || '',   // "Calle Mayor 12 - Fachada"
    description:  data.description?.trim() || '',
    address:      data.address?.trim() || '',

    // Estado y fechas
    status:       data.status || 'activa',
    startDate:    data.startDate || new Date().toISOString().slice(0, 10),
    endDate:      data.endDate || null,

    // Presupuesto
    budgetAmount: parseFloat(data.budgetAmount || 0),  // Precio presupuestado
    invoicedAmount: 0,  // Se calcula cruzando con StelOrder

    // Control
    notes:        data.notes || '',
    tags:         data.tags || [],  // Weber, Nutersa, etc.
    createdAt:    new Date(),
    updatedAt:    new Date(),
  };

  if (!obra.clientName) throw new Error('El cliente es obligatorio');
  if (!obra.reference)  throw new Error('La referencia de obra es obligatoria');

  const result = await db.collection('obras').insertOne(obra);
  console.log(`[Obras] Nueva obra: ${obra.reference} — ${obra.clientName}`);
  return { id: result.insertedId, ...obra };
}

async function getObras({ clientName, status, search } = {}) {
  const db = await getDB();
  const query = {};
  if (status)     query.status = status;
  if (clientName) query.clientName = { $regex: clientName, $options: 'i' };
  if (search)     query.$or = [
    { reference:   { $regex: search, $options: 'i' } },
    { clientName:  { $regex: search, $options: 'i' } },
    { address:     { $regex: search, $options: 'i' } },
  ];
  return db.collection('obras').find(query).sort({ createdAt: -1 }).toArray();
}

async function getObra(id) {
  const db = await getDB();
  return db.collection('obras').findOne({ _id: new ObjectId(id) });
}

async function updateObra(id, data) {
  const db = await getDB();
  const allowed = ['clientName','reference','description','address','status','startDate','endDate','budgetAmount','notes','tags'];
  const set = { updatedAt: new Date() };
  allowed.forEach(k => { if (data[k] !== undefined) set[k] = data[k]; });
  return db.collection('obras').updateOne({ _id: new ObjectId(id) }, { $set: set });
}

// ── RENTABILIDAD ─────────────────────────────────────────────────
// Cruza partes de trabajo con facturas de StelOrder para calcular
// coste real vs facturado por obra

async function getRentabilidad(obraId) {
  const db = await getDB();
  const obra = await db.collection('obras').findOne({ _id: new ObjectId(obraId) });
  if (!obra) throw new Error('Obra no encontrada');

  // 1. Obtener todos los partes asociados a esta obra
  // Los partes se asocian por clientName + referencia en el campo clientName del parte
  // Buscar partes que mencionen el nombre de la obra o el cliente
  const partes = await db.collection('partes').find({
    $or: [
      { clientName: { $regex: obra.reference, $options: 'i' } },
      { clientName: { $regex: obra.clientName, $options: 'i' } },
    ]
  }).sort({ date: 1 }).toArray();

  // 2. Calcular coste de personal
  const RATES = {
    jose:     26.72,
    diego:    19.05,
    abdellah: 13.28,
    mamadou:  13.28,
    paula:    8.66,
  };

  let totalHoras = 0;
  let totalCostePersonal = 0;
  let totalMateriales = 0;
  const byWorker = {};
  const byDate = {};

  partes.forEach(p => {
    const rate = RATES[p.workerId] || 15;
    const coste = (p.horas || 8) * rate;
    totalHoras += p.horas || 8;
    totalCostePersonal += coste;

    // Por trabajador
    if (!byWorker[p.workerId]) byWorker[p.workerId] = { name: p.workerName, dias: 0, horas: 0, coste: 0 };
    byWorker[p.workerId].dias++;
    byWorker[p.workerId].horas += p.horas || 8;
    byWorker[p.workerId].coste += coste;

    // Por fecha
    byDate[p.date] = (byDate[p.date] || []);
    byDate[p.date].push({ worker: p.workerName, horas: p.horas || 8, coste });

    // Materiales de los partes
    (p.materiales || []).forEach(m => {
      totalMateriales += (m.cantidad || 0) * (m.precio || 0);
    });
  });

  const totalCoste = totalCostePersonal + totalMateriales;
  const facturado  = obra.invoicedAmount || obra.budgetAmount || 0;
  const beneficio  = facturado - totalCoste;
  const margen     = facturado > 0 ? (beneficio / facturado * 100) : 0;

  // 3. Diagnóstico automático
  let diagnostico = null;
  if (facturado > 0) {
    if (margen < 0) {
      diagnostico = {
        tipo: 'perdida',
        emoji: '🚨',
        color: '#f05252',
        mensaje: `Pérdida de ${Math.abs(beneficio).toFixed(0)}€. El coste supera lo facturado en un ${Math.abs(margen).toFixed(1)}%.`,
        recomendacion: `Para cubrir costes necesitas facturar al menos ${(totalCoste * 1.2).toFixed(0)}€ (margen 20%).`
      };
    } else if (margen < 15) {
      diagnostico = {
        tipo: 'ajustado',
        emoji: '⚠️',
        color: '#f59e0b',
        mensaje: `Margen muy ajustado del ${margen.toFixed(1)}%. Beneficio de ${beneficio.toFixed(0)}€.`,
        recomendacion: 'Revisar si hay materiales no registrados o horas adicionales no facturadas.'
      };
    } else if (margen < 30) {
      diagnostico = {
        tipo: 'correcto',
        emoji: '✅',
        color: '#22c487',
        mensaje: `Obra rentable con ${margen.toFixed(1)}% de margen. Beneficio de ${beneficio.toFixed(0)}€.`,
        recomendacion: null
      };
    } else {
      diagnostico = {
        tipo: 'excelente',
        emoji: '🌟',
        color: '#4d9cf8',
        mensaje: `Excelente margen del ${margen.toFixed(1)}%. Beneficio de ${beneficio.toFixed(0)}€.`,
        recomendacion: null
      };
    }
  }

  return {
    obra,
    partes: partes.length,
    totalHoras,
    totalCostePersonal,
    totalMateriales,
    totalCoste,
    facturado,
    beneficio,
    margen,
    byWorker: Object.values(byWorker),
    byDate,
    diagnostico,
  };
}

// ── RESUMEN GENERAL ───────────────────────────────────────────────
async function getResumenGeneral() {
  const db = await getDB();
  const obras = await db.collection('obras').find({}).sort({ createdAt: -1 }).toArray();

  const resumen = await Promise.all(obras.map(async obra => {
    try {
      const r = await getRentabilidad(String(obra._id));
      return { ...r, obraId: String(obra._id) };
    } catch(e) {
      return { obra, partes: 0, totalCoste: 0, facturado: 0, beneficio: 0, margen: 0, diagnostico: null };
    }
  }));

  return resumen;
}

module.exports = { ESTADOS_OBRA, createObra, getObras, getObra, updateObra, getRentabilidad, getResumenGeneral };
