// src/presupuestos.js — Motor de presupuestos. Empieza por la BASE DE PRECIOS:
// el catálogo de PARTIDAS (tu lista de precios). Una partida es un trabajo con
// su unidad y su precio (p.ej. "Pintar pared" — m² — 8,50 €/m²), opcionalmente
// con el coste real para ver el margen. Sobre esto irá el presupuesto (medición
// × partidas). Multi-empresa desde el diseño (cada partida lleva empresaId).
const { ObjectId } = require('mongodb');
const crypto = require('crypto');
const EMPRESA = process.env.EMPRESA_ID || 'corp';

// Datos de la empresa que emite el presupuesto (cabecera del PDF).
// Multi-empresa-ready: se sobreescriben por variables de entorno.
const DATOS_EMPRESA = {
  nombre:    process.env.EMPRESA_NOMBRE    || 'Corp. Projects Holding, S.L.',
  cif:       process.env.EMPRESA_CIF       || 'B09899253',
  direccion: process.env.EMPRESA_DIRECCION || 'Carrer Nou 12, 2n 2n B · 17001 Girona',
  telefono:  process.env.EMPRESA_TELEFONO  || '674 013 723',
  email:     process.env.EMPRESA_EMAIL     || 'hola@corpprojects.es',
  web:       process.env.EMPRESA_WEB       || 'corpprojects.es',
};
function getEmpresa() { return { ...DATOS_EMPRESA }; }

function limpiarCliente(c) {
  c = c || {};
  return {
    direccion: String(c.direccion || '').trim(),
    nif:       String(c.nif || '').trim(),
    telefono:  String(c.telefono || '').trim(),
    email:     String(c.email || '').trim(),
  };
}
// Numeración correlativa por empresa y año: PRES-2026-0001
async function siguienteNumero(db) {
  const year = new Date().getFullYear();
  const prefix = `PRES-${year}-`;
  const n = await db.collection('presupuestos').countDocuments({ empresaId: EMPRESA, numero: { $regex: '^' + prefix } });
  return prefix + String(n + 1).padStart(4, '0');
}

async function getDB() { return require('./db').getDB(); }
const num = v => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : 0; };

const UNIDADES = ['m²', 'ml', 'ud', 'h', 'kg', 'm³', 'global'];

// Unidades de MATERIAL (cómo se mide su consumo). Distinto de las unidades de
// partida: aquí entran saco/rollo/bote además de m²/ml/ud…
// 'h' = mano de obra (hora). Es un "material" más (entra en el coste de la
// receta), pero se EXCLUYE de la lista de la compra (las horas no se compran).
const MAT_UNIDADES = ['m²', 'ml', 'ud', 'kg', 'l', 'saco', 'rollo', 'm³', 'h'];

// La RECETA (descompuesto) de una partida: lista de materiales con su consumo
// por unidad de partida. Cada línea guarda una COPIA del precio del material
// (snapshot), como las líneas de presupuesto, para que la partida no cambie
// sola si luego retocas el material; se puede refrescar reeditando.
function limpiarReceta(receta) {
  return (Array.isArray(receta) ? receta : []).map(r => ({
    materialId: r.materialId ? String(r.materialId) : null,
    nombre:     String(r.nombre || '').trim() || 'Material',
    unidad:     String(r.unidad || 'ud'),
    precio:     Math.round(num(r.precio) * 10000) / 10000, // € por unidad (snapshot, 4 dec)
    consumo:    num(r.consumo),                           // unidades de material por unidad de partida
    merma:      Math.max(0, num(r.merma)),                // % desperdicio
  }));
}
// Coste de la partida a partir de su receta: Σ consumo × precio × (1 + merma%).
function costeReceta(receta) {
  return Math.round((receta || []).reduce(
    (s, r) => s + num(r.consumo) * (Number(r.precio) || 0) * (1 + (num(r.merma) || 0) / 100), 0
  ) * 100) / 100;
}

function limpiar(data) {
  const unidad = UNIDADES.includes(data.unidad) ? data.unidad : 'ud';
  const receta = limpiarReceta(data.receta);
  const costeManual = Math.round(num(data.coste) * 100) / 100;
  return {
    nombre:      String(data.nombre || '').trim(),
    capitulo:    String(data.capitulo || '').trim(),   // agrupador: Pintura, Suelos, Fontanería…
    unidad,
    precioVenta: Math.round(num(data.precioVenta) * 100) / 100,
    receta,
    // si hay receta, el coste lo MANDA la receta (calculado); si no, coste manual.
    coste:       receta.length ? costeReceta(receta) : costeManual,
    notas:       String(data.notas || '').trim(),
  };
}

async function getPartidas({ search } = {}) {
  const db = await getDB();
  const q = { empresaId: EMPRESA };
  if (search) q.$or = [
    { nombre:   { $regex: search, $options: 'i' } },
    { capitulo: { $regex: search, $options: 'i' } },
  ];
  return db.collection('partidas').find(q).sort({ capitulo: 1, nombre: 1 }).toArray();
}

async function crearPartida(data, by) {
  const db = await getDB();
  const p = limpiar(data);
  if (!p.nombre) throw new Error('Ponle un nombre a la partida');
  if (p.precioVenta <= 0) throw new Error('El precio de venta debe ser mayor que 0');
  const doc = { empresaId: EMPRESA, ...p, by: by || '', createdAt: new Date(), updatedAt: new Date() };
  const r = await db.collection('partidas').insertOne(doc);
  return { ok: true, id: String(r.insertedId) };
}

async function editarPartida(id, data) {
  const db = await getDB();
  const p = limpiar(data);
  if (!p.nombre) throw new Error('Ponle un nombre a la partida');
  await db.collection('partidas').updateOne(
    { _id: new ObjectId(id), empresaId: EMPRESA },
    { $set: { ...p, updatedAt: new Date() } }
  );
  return { ok: true };
}

async function eliminarPartida(id) {
  const db = await getDB();
  await db.collection('partidas').deleteOne({ _id: new ObjectId(id), empresaId: EMPRESA });
  return { ok: true };
}

// ── MATERIALES (base de precios de compra) ───────────────────────
// Cada material es un producto que compras (placa, canal, montante, pintura…)
// con su unidad y precio. Sobre ellos se montan las recetas de las partidas.
function limpiarMaterial(data) {
  return {
    nombre:   String(data.nombre || '').trim(),
    unidad:   MAT_UNIDADES.includes(data.unidad) ? data.unidad : 'ud',
    precio:   Math.round(num(data.precio) * 10000) / 10000, // € por unidad (4 dec: materiales baratos como tornillos)
    merma:    Math.max(0, num(data.merma)),                 // % desperdicio por defecto
    formato:  String(data.formato || '').trim(),            // opcional: "Placa 1,2×2,5 m", "Perfil 3 m"
    contenido: Math.max(0, num(data.contenido)),            // unidades por pieza de compra (3 m²/placa); 0 = sin redondeo (1)
  };
}

async function getMateriales({ search } = {}) {
  const db = await getDB();
  const q = { empresaId: EMPRESA };
  if (search) q.nombre = { $regex: search, $options: 'i' };
  return db.collection('materiales').find(q).sort({ nombre: 1 }).toArray();
}

async function crearMaterial(data, by) {
  const db = await getDB();
  const m = limpiarMaterial(data);
  if (!m.nombre) throw new Error('Ponle un nombre al material');
  // el historial empieza con el precio de alta (primer punto de la curva)
  const doc = { empresaId: EMPRESA, ...m, historial: [{ fecha: new Date(), precio: m.precio }], by: by || '', createdAt: new Date(), updatedAt: new Date() };
  const r = await db.collection('materiales').insertOne(doc);
  return { ok: true, id: String(r.insertedId) };
}

async function editarMaterial(id, data) {
  const db = await getDB();
  const m = limpiarMaterial(data);
  if (!m.nombre) throw new Error('Ponle un nombre al material');
  const prev = await db.collection('materiales').findOne({ _id: new ObjectId(id), empresaId: EMPRESA });
  const update = { $set: { ...m, updatedAt: new Date() } };
  if (data.resetHistorial) {
    // reiniciar: deja solo el precio actual (para limpiar saltos de cuando reconfiguras un material)
    update.$set.historial = [{ fecha: new Date(), precio: m.precio }];
  } else if (prev && Math.round((prev.precio || 0) * 100) !== Math.round(m.precio * 100)) {
    // si el precio CAMBIA, se apunta un nuevo punto en el historial (base del gráfico + aviso)
    update.$push = { historial: { fecha: new Date(), precio: m.precio } };
  }
  await db.collection('materiales').updateOne({ _id: new ObjectId(id), empresaId: EMPRESA }, update);
  return { ok: true };
}

async function eliminarMaterial(id) {
  const db = await getDB();
  await db.collection('materiales').deleteOne({ _id: new ObjectId(id), empresaId: EMPRESA });
  return { ok: true };
}

// ── PRESUPUESTOS ─────────────────────────────────────────────────
// Un presupuesto = líneas de partidas con su cantidad. Las cantidades pueden
// venir de una MEDICIÓN (m² de pared → pintura, m² de suelo → suelo, ml → rodapié).
// Cada línea guarda una copia del precio/coste de la partida en ese momento
// (así el presupuesto no cambia si luego retocas el catálogo).
const n2 = n => Math.round((Number(n) || 0) * 100) / 100;

// Cada línea tiene un tipo: 'seccion' (título con subtotal, no suma nada),
// 'partida' (viene del catálogo) o 'libre' (concepto a mano: puerta, lámpara…).
// Las líneas viejas sin tipo se tratan como 'partida' (retrocompatible).
function esSeccion(l) { return (l && l.tipo) === 'seccion'; }
function esNota(l)    { return (l && l.tipo) === 'nota'; }   // título/texto sin precio, no suma
// Importe de venta de una línea: en modo 'cerrado' es el precio cerrado; si no,
// cantidad × precio unitario.
function importeLinea(l) {
  if (!l || esSeccion(l) || esNota(l)) return 0;
  if (l.modo === 'cerrado') return Number(l.precioCerrado) || 0;
  return (num(l.cantidad)) * (Number(l.precioVenta) || 0);
}

// IVA: cada presupuesto tiene un tipo por defecto (ivaDefault, normalmente 10%
// en reforma de vivienda). Una línea puede llevar su propio `iva` (override);
// si es null/undefined hereda el del presupuesto. Total = base + IVA.
// Descuento GLOBAL opcional: { tipo:'pct'|'eur', valor }. null = sin descuento.
function limpiarDescuento(d) {
  if (!d || !(Number(d.valor) > 0)) return null;
  return { tipo: d.tipo === 'eur' ? 'eur' : 'pct', valor: Math.round(num(d.valor) * 100) / 100 };
}
// Equipo asignado al presupuesto (quién lo hará) y tiempo estimado.
function limpiarEquipo(e) {
  return (Array.isArray(e) ? e : []).map(w => ({ id: String(w.id || ''), name: String(w.name || '').trim() })).filter(w => w.id || w.name);
}
function limpiarTiempo(t) {
  if (!t) return null;
  const valor = num(t.valor);
  if (!(valor > 0)) return null;
  return { valor, unidad: t.unidad === 'horas' ? 'horas' : 'dias' };
}
function computeTotales(lineas, ivaDefault, descuento, costeManoObra) {
  const g = Number.isFinite(ivaDefault) ? ivaDefault : 10;
  let venta = 0, coste = Number(costeManoObra) || 0;   // arranca con la mano de obra estimada
  const filas = [];
  (lineas || []).forEach(l => {
    if (esSeccion(l) || esNota(l)) return;   // secciones y notas no suman
    const v = importeLinea(l);
    venta += v;
    coste += (num(l.cantidad)) * (Number(l.coste) || 0);
    const r = (l.iva === null || l.iva === undefined) ? g : Number(l.iva);
    filas.push({ v, r: Number.isFinite(r) ? r : g });
  });
  venta = n2(venta); coste = n2(coste);
  // descuento: si es €, no puede pasar de la base; se PRORRATEA entre líneas
  // (factor) para que el IVA por tipo siga saliendo bien.
  let desc = 0;
  if (descuento && Number(descuento.valor) > 0 && venta > 0) {
    desc = descuento.tipo === 'eur' ? Math.min(Number(descuento.valor), venta) : venta * Number(descuento.valor) / 100;
  }
  desc = n2(desc);
  const factor = venta > 0 ? (venta - desc) / venta : 1;
  let iva = 0;
  filas.forEach(f => { iva += f.v * factor * f.r / 100; });
  iva = n2(iva);
  const baseFinal = n2(venta - desc);
  return {
    totalVenta: venta, totalCoste: coste, descuento: desc, baseConDescuento: baseFinal,
    totalIva: iva, totalConIva: n2(baseFinal + iva),
    beneficio: n2(baseFinal - coste), margen: baseFinal > 0 ? Math.round((baseFinal - coste) / baseFinal * 100) : 0,
  };
}
function limpiarLineas(lineas) {
  return (Array.isArray(lineas) ? lineas : []).map(l => {
    const tipo = ['seccion', 'partida', 'libre', 'nota'].includes(l.tipo) ? l.tipo : 'partida';
    if (tipo === 'seccion') return { tipo, nombre: String(l.nombre || '').trim() || 'Sección' };
    if (tipo === 'nota')    return { tipo, nombre: String(l.nombre || '').trim(), descripcion: String(l.descripcion || '').trim() };
    const ivaOverride = (l.iva === null || l.iva === undefined || l.iva === '') ? null : Number(l.iva);
    return {
      tipo,
      partidaId:    l.partidaId ? String(l.partidaId) : null,
      nombre:       String(l.nombre || '').trim() || (tipo === 'libre' ? 'Concepto' : 'Partida'),
      descripcion:  String(l.descripcion || '').trim(),
      unidad:       String(l.unidad || 'ud'),
      cantidad:     num(l.cantidad),
      precioVenta:  n2(l.precioVenta),
      coste:        n2(l.coste),
      modo:         l.modo === 'cerrado' ? 'cerrado' : 'desglosado',
      precioCerrado: n2(l.precioCerrado),
      iva:          Number.isFinite(ivaOverride) ? ivaOverride : null,
    };
  });
}

async function getPresupuestos() {
  const db = await getDB();
  const arr = await db.collection('presupuestos').find({ empresaId: EMPRESA }).sort({ updatedAt: -1 }).toArray();
  return arr.map(p => ({ _id: p._id, nombre: p.nombre, clientName: p.clientName || '', estado: p.estado || 'borrador', creadoPor: p.by || '', obraId: p.obraId || null, nLineas: (p.lineas || []).filter(l => !esSeccion(l)).length, ...computeTotales(p.lineas, p.iva, p.descuento, p.costeManoObra), updatedAt: p.updatedAt }));
}
async function getPresupuesto(id) {
  const db = await getDB();
  const p = await db.collection('presupuestos').findOne({ _id: new ObjectId(id), empresaId: EMPRESA });
  if (!p) throw new Error('Presupuesto no encontrado');
  return { ...p, iva: Number.isFinite(p.iva) ? p.iva : 10, descuento: p.descuento || null, totales: computeTotales(p.lineas, p.iva, p.descuento, p.costeManoObra) };
}
async function crearPresupuesto(data, by) {
  const db = await getDB();
  const nombre = String(data.nombre || '').trim();
  if (!nombre) throw new Error('Ponle un nombre al presupuesto');
  const doc = {
    empresaId: EMPRESA, nombre,
    numero: await siguienteNumero(db),
    clientName: String(data.clientName || '').trim(),
    clientData: limpiarCliente(data.clientData),
    medicionId: data.medicionId ? String(data.medicionId) : null,
    medicionTotales: data.medicionTotales || null,
    iva: Number.isFinite(Number(data.iva)) ? Number(data.iva) : 10,
    descuento: limpiarDescuento(data.descuento),
    validezDias: Number.isFinite(Number(data.validezDias)) ? Number(data.validezDias) : 30,
    lineas: limpiarLineas(data.lineas),
    notas: String(data.notas || '').trim(),
    condiciones: String(data.condiciones || '').trim(),
    equipo: limpiarEquipo(data.equipo),                 // quién lo va a hacer
    tiempoEstimado: limpiarTiempo(data.tiempoEstimado), // {valor, unidad}
    costeManoObra: Math.round(num(data.costeManoObra) * 100) / 100, // mano de obra estimada (€)
    estado: 'borrador',
    by: by || '', createdAt: new Date(), updatedAt: new Date(),
  };
  const r = await db.collection('presupuestos').insertOne(doc);
  return { ok: true, id: String(r.insertedId) };
}
async function guardarPresupuesto(id, data) {
  const db = await getDB();
  const set = { updatedAt: new Date() };
  if ('nombre' in data) set.nombre = String(data.nombre || '').trim();
  if ('clientName' in data) set.clientName = String(data.clientName || '').trim();
  if ('clientData' in data) set.clientData = limpiarCliente(data.clientData);
  if ('lineas' in data) set.lineas = limpiarLineas(data.lineas);
  if ('notas' in data) set.notas = String(data.notas || '').trim();
  if ('condiciones' in data) set.condiciones = String(data.condiciones || '').trim();
  if ('validezDias' in data && Number.isFinite(Number(data.validezDias))) set.validezDias = Number(data.validezDias);
  if ('equipo' in data) set.equipo = limpiarEquipo(data.equipo);
  if ('tiempoEstimado' in data) set.tiempoEstimado = limpiarTiempo(data.tiempoEstimado);
  if ('costeManoObra' in data) set.costeManoObra = Math.round(num(data.costeManoObra) * 100) / 100;
  if ('estado' in data) set.estado = String(data.estado || 'borrador');
  if ('iva' in data && Number.isFinite(Number(data.iva))) set.iva = Number(data.iva);
  if ('descuento' in data) set.descuento = limpiarDescuento(data.descuento);
  if ('medicionId' in data) set.medicionId = data.medicionId ? String(data.medicionId) : null;
  if ('medicionTotales' in data) set.medicionTotales = data.medicionTotales || null;
  await db.collection('presupuestos').updateOne({ _id: new ObjectId(id), empresaId: EMPRESA }, { $set: set });
  return { ok: true };
}
async function eliminarPresupuesto(id) {
  const db = await getDB();
  await db.collection('presupuestos').deleteOne({ _id: new ObjectId(id), empresaId: EMPRESA });
  return { ok: true };
}
// Estados del presupuesto: borrador → enviado → aceptado/rechazado.
// Guarda la fecha de cada hito (enviadoAt/aceptadoAt/rechazadoAt) para el seguimiento.
const ESTADOS = ['borrador', 'enviado', 'aceptado', 'rechazado'];
async function setEstado(id, estado) {
  if (!ESTADOS.includes(estado)) throw new Error('Estado no válido');
  const db = await getDB();
  const now = new Date();
  const set = { estado, estadoAt: now, updatedAt: now };
  if (estado === 'enviado')   set.enviadoAt = now;
  if (estado === 'aceptado')  set.aceptadoAt = now;
  if (estado === 'rechazado') set.rechazadoAt = now;
  await db.collection('presupuestos').updateOne({ _id: new ObjectId(id), empresaId: EMPRESA }, { $set: set });
  return { ok: true, estado, estadoAt: now };
}

// ── ENLACE PÚBLICO (enviar / ver / aceptar online) ───────────────
// Genera (idempotente) el token público del presupuesto.
async function ensurePublicToken(id) {
  const db = await getDB();
  const p = await db.collection('presupuestos').findOne({ _id: new ObjectId(id), empresaId: EMPRESA });
  if (!p) throw new Error('Presupuesto no encontrado');
  if (p.publicToken) return p.publicToken;
  const token = 'q_' + crypto.randomBytes(16).toString('hex');
  await db.collection('presupuestos').updateOne({ _id: p._id }, { $set: { publicToken: token, updatedAt: new Date() } });
  return token;
}
// Datos del presupuesto para el cliente (sin coste/margen/equipo) + registra la visita.
async function getPublico(token, ip) {
  const db = await getDB();
  const p = await db.collection('presupuestos').findOne({ publicToken: String(token), empresaId: EMPRESA });
  if (!p) throw new Error('Presupuesto no encontrado');
  // Registrar visita (contador + últimas marcas de tiempo, cap 200).
  await db.collection('presupuestos').updateOne(
    { _id: p._id },
    { $push: { vistas: { $each: [{ at: new Date(), ip: ip || null }], $slice: -200 } } }
  );
  const t = computeTotales(p.lineas, p.iva, p.descuento, p.costeManoObra);
  const lineas = (p.lineas || []).map(l => { const { coste, ...r } = l; return r; }); // fuera el coste
  return {
    numero: p.numero, nombre: p.nombre, clientName: p.clientName, clientData: p.clientData || {},
    empresa: getEmpresa(), fecha: p.createdAt, validezDias: p.validezDias || 30,
    iva: Number.isFinite(p.iva) ? p.iva : 10, descuento: p.descuento || null,
    lineas, totales: t, condiciones: p.condiciones || '',
    estado: p.estado || 'borrador', respuesta: p.respuesta || null,
  };
}
// El cliente acepta o rechaza desde el enlace. Idempotente.
async function responder(token, { accion, nombre, firma } = {}) {
  const db = await getDB();
  const p = await db.collection('presupuestos').findOne({ publicToken: String(token), empresaId: EMPRESA });
  if (!p) throw new Error('Presupuesto no encontrado');
  if (!['aceptar', 'rechazar'].includes(accion)) throw new Error('Acción no válida');
  if (p.respuesta && p.respuesta.accion) return { yaRespondido: true, estado: p.estado, respuesta: p.respuesta };
  const estado = accion === 'aceptar' ? 'aceptado' : 'rechazado';
  const now = new Date();
  const respuesta = { accion, at: now, nombre: String(nombre || '').trim(), firma: firma || null };
  const set = { estado, estadoAt: now, respuesta, updatedAt: now };
  set[estado === 'aceptado' ? 'aceptadoAt' : 'rechazadoAt'] = now;
  await db.collection('presupuestos').updateOne({ _id: p._id }, { $set: set });
  return { ok: true, estado, respuesta, presupuestoId: String(p._id) };
}

// Presupuesto ACEPTADO → OBRA. Crea la obra sembrada con lo presupuestado
// (venta = presupuesto, coste esperado) y la enlaza. Idempotente: si el
// presupuesto ya tiene obra, no crea otra.
async function crearObraDesdePresupuesto(id) {
  const db = await getDB();
  const p = await db.collection('presupuestos').findOne({ _id: new ObjectId(id), empresaId: EMPRESA });
  if (!p) throw new Error('Presupuesto no encontrado');
  if (p.obraId) return { yaExistia: true, obraId: String(p.obraId), reference: p.obraRef || p.nombre };

  const t = computeTotales(p.lineas, p.iva, p.descuento, p.costeManoObra);
  const cliente = (p.clientName || '').trim() || 'Sin cliente';
  const ref = (p.nombre || p.numero || 'Obra').trim();
  const aliases = [];
  if (p.numero) aliases.push(p.numero);

  const obra = await require('./obras').createObra({
    clientName: cliente,
    reference: ref,
    description: p.nombre || '',
    address: (p.clientData && p.clientData.direccion) || '',
    budgetAmount: t.baseConDescuento,        // lo que cobramos (venta con descuento)
    costePresupuestado: t.totalCoste,        // lo que esperábamos gastar
    presupuestoId: String(p._id),
    aliases,
    tiempoEstimado: p.tiempoEstimado || null,   // estimado del presupuesto (para comparar vs real)
    equipoPresup:   p.equipo || [],
    status: 'activa',
  });
  await db.collection('presupuestos').updateOne(
    { _id: p._id },
    { $set: { obraId: String(obra.id), obraRef: ref, updatedAt: new Date() } }
  );
  return { creada: true, obraId: String(obra.id), reference: ref };
}

// ── LISTA DE LA COMPRA ───────────────────────────────────────────
// Agrega los materiales de todas las partidas (con receta) de un presupuesto,
// multiplicando consumo × cantidad × (1+merma%), suma por material y redondea
// a PIEZAS enteras según el contenido de compra (placa de 3 m² → nº de placas).
async function listaMateriales(id) {
  const db = await getDB();
  const p = await db.collection('presupuestos').findOne({ _id: new ObjectId(id), empresaId: EMPRESA });
  if (!p) throw new Error('Presupuesto no encontrado');

  const partidaIds = [...new Set((p.lineas || []).filter(l => l.partidaId && ObjectId.isValid(l.partidaId)).map(l => String(l.partidaId)))];
  const partidas = partidaIds.length
    ? await db.collection('partidas').find({ _id: { $in: partidaIds.map(x => new ObjectId(x)) }, empresaId: EMPRESA }).toArray()
    : [];
  const pById = new Map(partidas.map(x => [String(x._id), x]));

  const acc = new Map();      // clave = materialId || 'n:'+nombre
  const sinReceta = [];       // partidas sin receta (no se pueden desglosar)
  for (const l of (p.lineas || [])) {
    if ((l.tipo || 'partida') === 'seccion') continue;
    const cant = num(l.cantidad);
    if (cant <= 0) continue;
    if (!l.partidaId) { if (l.tipo === 'libre') sinReceta.push(l.nombre || 'Línea libre'); continue; }
    const part = pById.get(String(l.partidaId));
    if (!part || !(part.receta || []).length) { sinReceta.push(l.nombre || (part && part.nombre) || 'Partida'); continue; }
    for (const r of part.receta) {
      if ((r.unidad || '') === 'h') continue; // la mano de obra no se compra
      const units = cant * num(r.consumo) * (1 + (num(r.merma) || 0) / 100);
      const key = r.materialId ? ('id:' + r.materialId) : ('n:' + r.nombre);
      const cur = acc.get(key) || { materialId: r.materialId || null, nombre: r.nombre, unidad: r.unidad, precio: Number(r.precio) || 0, unidades: 0 };
      cur.unidades += units;
      acc.set(key, cur);
    }
  }

  // enriquecer con datos ACTUALES del material (precio, contenido, formato)
  const matIds = [...acc.values()].filter(m => m.materialId && ObjectId.isValid(m.materialId)).map(m => m.materialId);
  const mats = matIds.length
    ? await db.collection('materiales').find({ _id: { $in: matIds.map(x => new ObjectId(x)) }, empresaId: EMPRESA }).toArray()
    : [];
  const matById = new Map(mats.map(m => [String(m._id), m]));

  const items = [...acc.values()].map(m => {
    const mat = m.materialId ? matById.get(String(m.materialId)) : null;
    // Precio = el de la RECETA (snapshot), coherente con el coste del presupuesto.
    // El material solo se usa para el contenido/formato (redondeo a piezas).
    const precio = m.precio;
    const contenido = mat && num(mat.contenido) > 0 ? num(mat.contenido) : 0;
    const formato = mat ? (mat.formato || '') : '';
    const unidad = mat ? mat.unidad : m.unidad;
    const unidades = Math.round(m.unidades * 100) / 100;
    const piezas = contenido > 0 ? Math.ceil(unidades / contenido - 1e-9) : null;
    const coste = Math.round((piezas != null ? piezas * contenido : unidades) * precio * 100) / 100;
    return { nombre: m.nombre, unidad, unidades, contenido: contenido || null, formato, piezas, precio, coste };
  }).sort((a, b) => b.coste - a.coste);

  const totalCoste = Math.round(items.reduce((s, i) => s + i.coste, 0) * 100) / 100;
  return { items, totalCoste, sinReceta };
}

module.exports = {
  UNIDADES, MAT_UNIDADES, listaMateriales, getEmpresa,
  getPartidas, crearPartida, editarPartida, eliminarPartida,
  getMateriales, crearMaterial, editarMaterial, eliminarMaterial,
  getPresupuestos, getPresupuesto, crearPresupuesto, guardarPresupuesto, eliminarPresupuesto,
  ESTADOS, setEstado, crearObraDesdePresupuesto,
  ensurePublicToken, getPublico, responder,
};
