// src/colaboradores.js — Gestión de colaboradores externos y sus pagos
const { MongoClient, ObjectId } = require('mongodb');

let db = null;

async function getDB() {
  return require('./db').getDB();
}

async function getColaboradores(soloActivos = false) {
  const db    = await getDB();
  const query = soloActivos ? { activo: true } : {};
  return db.collection('colaboradores').find(query).sort({ nombre: 1 }).toArray();
}

async function getColaborador(id) {
  const db = await getDB();
  return db.collection('colaboradores').findOne({ _id: new ObjectId(id) });
}

async function createColaborador(data) {
  const db = await getDB();
  const col = {
    nombre:        data.nombre?.trim(),
    alias:         data.alias?.trim() || '',
    tarifaDia:     parseFloat(data.tarifaDia || 0),
    tarifaSemana:  parseFloat(data.tarifaSemana || 0),
    tarifaHora:    parseFloat(data.tarifaHora || 0),
    tipoTarifa:    data.tipoTarifa || 'semana',
    diasSemanales: parseInt(data.diasSemanales || 5),
    horasDia:      parseInt(data.horasDia || 8),
    oficio:        data.oficio?.trim() || '',
    telefono:      data.telefono?.trim() || '',
    notas:         data.notas?.trim() || '',
    activo:        true,
    fechaAlta:     data.fechaAlta || new Date().toISOString().slice(0,10),
    createdAt:     new Date(),
    updatedAt:     new Date(),
  };

  if (!col.nombre) throw new Error('El nombre es obligatorio');

  if (col.tipoTarifa === 'semana' && col.tarifaSemana > 0) {
    col.tarifaDia  = parseFloat((col.tarifaSemana / col.diasSemanales).toFixed(2));
    col.tarifaHora = parseFloat((col.tarifaDia / col.horasDia).toFixed(2));
  } else if (col.tipoTarifa === 'dia' && col.tarifaDia > 0) {
    col.tarifaSemana = parseFloat((col.tarifaDia * col.diasSemanales).toFixed(2));
    col.tarifaHora   = parseFloat((col.tarifaDia / col.horasDia).toFixed(2));
  } else if (col.tipoTarifa === 'hora' && col.tarifaHora > 0) {
    col.tarifaDia    = parseFloat((col.tarifaHora * col.horasDia).toFixed(2));
    col.tarifaSemana = parseFloat((col.tarifaDia * col.diasSemanales).toFixed(2));
  }

  const result = await db.collection('colaboradores').insertOne(col);
  console.log(`[Colaboradores] Nuevo: ${col.nombre} — ${col.tarifaSemana}€/semana`);
  return { id: result.insertedId, ...col };
}

async function updateColaborador(id, data) {
  const db      = await getDB();
  const allowed = ['nombre','alias','tarifaDia','tarifaSemana','tarifaHora','tipoTarifa',
                   'diasSemanales','horasDia','oficio','telefono','notas','activo','fechaAlta'];
  const set     = { updatedAt: new Date() };
  allowed.forEach(k => { if (data[k] !== undefined) set[k] = data[k]; });

  const tipo  = set.tipoTarifa || data.tipoTarifa;
  const dias  = parseInt(set.diasSemanales || data.diasSemanales || 5);
  const horas = parseInt(set.horasDia || data.horasDia || 8);
  if (tipo === 'semana' && set.tarifaSemana) {
    set.tarifaDia  = parseFloat((set.tarifaSemana / dias).toFixed(2));
    set.tarifaHora = parseFloat((set.tarifaDia / horas).toFixed(2));
  } else if (tipo === 'dia' && set.tarifaDia) {
    set.tarifaSemana = parseFloat((set.tarifaDia * dias).toFixed(2));
    set.tarifaHora   = parseFloat((set.tarifaDia / horas).toFixed(2));
  }

  return db.collection('colaboradores').updateOne({ _id: new ObjectId(id) }, { $set: set });
}

async function getMovimientos(colaboradorId, { from, to, limit = 200 } = {}) {
  const db    = await getDB();
  const query = { colaboradorId };
  if (from || to) {
    query.fecha = {};
    if (from) query.fecha.$gte = from;
    if (to)   query.fecha.$lte = to;
  }
  return db.collection('colaborador_movimientos')
    .find(query).sort({ fecha: -1 }).limit(limit).toArray();
}

async function createMovimiento(colaboradorId, data) {
  const db  = await getDB();
  const col = await db.collection('colaboradores').findOne({ _id: new ObjectId(colaboradorId) });
  if (!col) throw new Error('Colaborador no encontrado');

  const mov = {
    colaboradorId,
    colaboradorNombre: col.nombre,
    fecha:          data.fecha || new Date().toISOString().slice(0,10),
    tipo:           data.tipo  || 'pago_semana',
    importe:        parseFloat(data.importe || 0),
    semanaDesde:    data.semanaDesde || '',
    semanaHasta:    data.semanaHasta || '',
    diasTrabajados: parseFloat(data.diasTrabajados || 0),
    horasExtra:     parseFloat(data.horasExtra || 0),
    clienteObra:    data.clienteObra?.trim() || '',
    concepto:       data.concepto?.trim()    || '',
    notas:          data.notas?.trim()       || '',
    esDescuento:    data.tipo === 'descuento',
    esDevolucion:   data.tipo === 'devolucion',
    createdAt:      new Date(),
  };

  if (!mov.importe || mov.importe <= 0) throw new Error('El importe debe ser mayor que 0');

  const result = await db.collection('colaborador_movimientos').insertOne(mov);
  console.log(`[Colaboradores] Movimiento: ${col.nombre} — ${data.tipo} ${mov.importe}€`);
  return { id: result.insertedId, ...mov };
}

async function deleteMovimiento(id) {
  const db = await getDB();
  return db.collection('colaborador_movimientos').deleteOne({ _id: new ObjectId(id) });
}

async function getSaldoColaborador(colaboradorId) {
  const db  = await getDB();
  const col = await db.collection('colaboradores').findOne({ _id: new ObjectId(colaboradorId) });
  if (!col) throw new Error('Colaborador no encontrado');

  const movs = await db.collection('colaborador_movimientos')
    .find({ colaboradorId }).sort({ fecha: 1 }).toArray();

  let totalDevengado  = 0;
  let totalEntregado  = 0;
  let totalDescuentos = 0;

movs.forEach(m => {
  if (m.tipo === 'semana_trabajada') {
    // Solo devengado — trabajo registrado, no dinero entregado
    totalDevengado += m.importe;
  } else if (m.tipo === 'pago_semana' || m.tipo === 'pago_dias') {
    // Dinero entregado como pago
    totalEntregado += m.importe;
  } else if (m.tipo === 'adelanto') {
    totalEntregado += m.importe;
  } else if (m.tipo === 'descuento') {
    totalDescuentos += m.importe;
    totalEntregado  += m.importe;
  } else if (m.tipo === 'devolucion') {
    totalEntregado -= m.importe;
  }
});

  // positivo = le debemos | negativo = nos debe él
  const saldoPendiente = totalDevengado - totalEntregado;

  return {
    colaborador:      col,
    totalDevengado,
    totalEntregado,
    totalPagado:      totalEntregado,
    totalDescuentos,
    saldoPendiente,
    movimientos:      movs.length,
    ultimoMovimiento: movs[movs.length - 1]?.fecha || null,
  };
}

async function getResumenTodosColaboradores() {
  const db   = await getDB();
  const cols = await db.collection('colaboradores').find({ activo: true }).toArray();

  const resumen = await Promise.all(
    cols.map(col => getSaldoColaborador(String(col._id)))
  );

  return resumen.sort((a, b) => Math.abs(b.saldoPendiente) - Math.abs(a.saldoPendiente));
}

async function getProyectos() {
  const db = await getDB();
  return db.collection('proyectos_inversion').find({}).sort({ createdAt: -1 }).toArray();
}

async function getProyecto(id) {
  const db      = await getDB();
  const proyecto = await db.collection('proyectos_inversion').findOne({ _id: new ObjectId(id) });
  if (!proyecto) throw new Error('Proyecto no encontrado');

  const movs = await db.collection('proyecto_movimientos')
    .find({ proyectoId: id }).sort({ fecha: 1 }).toArray();

  const totalInvertido = movs.filter(m => m.tipo === 'gasto').reduce((s, m) => s + m.importe, 0);
  const totalCobrado   = movs.filter(m => m.tipo === 'ingreso').reduce((s, m) => s + m.importe, 0);

  return {
    ...proyecto,
    movimientos:       movs,
    totalInvertido,
    totalCobrado,
    beneficioEstimado: (proyecto.precioVentaPactado || 0) - totalInvertido,
    beneficioReal:     totalCobrado > 0 ? totalCobrado - totalInvertido : null,
  };
}

async function createProyecto(data) {
  const db      = await getDB();
  const proyecto = {
    nombre:             data.nombre?.trim(),
    descripcion:        data.descripcion?.trim() || '',
    tipo:               data.tipo    || 'inmobiliario',
    estado:             data.estado  || 'en_curso',
    fechaInicio:        data.fechaInicio || new Date().toISOString().slice(0,10),
    precioVentaPactado: parseFloat(data.precioVentaPactado || 0),
    notas:              data.notas?.trim() || '',
    createdAt:          new Date(),
    updatedAt:          new Date(),
  };
  if (!proyecto.nombre) throw new Error('El nombre es obligatorio');
  const result = await db.collection('proyectos_inversion').insertOne(proyecto);
  return { id: result.insertedId, ...proyecto };
}

async function updateProyecto(id, data) {
  const db      = await getDB();
  const allowed = ['nombre','descripcion','estado','precioVentaPactado','notas','fechaVenta','precioVentaFinal'];
  const set     = { updatedAt: new Date() };
  allowed.forEach(k => { if (data[k] !== undefined) set[k] = data[k]; });
  return db.collection('proyectos_inversion').updateOne({ _id: new ObjectId(id) }, { $set: set });
}

async function addMovimientoProyecto(proyectoId, data) {
  const db  = await getDB();
  const mov = {
    proyectoId,
    fecha:        data.fecha || new Date().toISOString().slice(0,10),
    tipo:         data.tipo  || 'gasto',
    concepto:     data.concepto?.trim()  || '',
    importe:      parseFloat(data.importe || 0),
    formaPago:    data.formaPago || 'efectivo',
    importeCash:  parseFloat(data.importeCash  || 0),
    importeBanco: parseFloat(data.importeBanco || 0),
    referencia:   data.referencia?.trim() || '',
    notas:        data.notas?.trim()      || '',
    createdAt:    new Date(),
  };
  if (!mov.importe || mov.importe <= 0) throw new Error('El importe debe ser mayor que 0');
  const result = await db.collection('proyecto_movimientos').insertOne(mov);
  return { id: result.insertedId, ...mov };
}

async function deleteMovimientoProyecto(id) {
  const db = await getDB();
  return db.collection('proyecto_movimientos').deleteOne({ _id: new ObjectId(id) });
}

module.exports = {
  getColaboradores, getColaborador, createColaborador, updateColaborador,
  getMovimientos, createMovimiento, deleteMovimiento,
  getSaldoColaborador, getResumenTodosColaboradores,
  getProyectos, getProyecto, createProyecto, updateProyecto,
  addMovimientoProyecto, deleteMovimientoProyecto,
};
