// src/trabajadores.js — Plantilla ÚNICA de trabajadores (fuente de verdad)
// ---------------------------------------------------------------------------
// Hoy los trabajadores están repartidos en 4 sitios que no se hablan:
//   · config.workersFallback  (id, pin, color, costeHora) → lo usan partes/presencia
//   · config.rates            (nombre → €/h)
//   · colección `colaboradores` (externos, tarifas día/semana/hora) → el alta
//   · colección `aliasTrabajadores` (apodos para voz/WhatsApp)
//   · tabla hardcodeada en la pestaña Personal (salarios)
// Por eso al añadir a alguien (Javi, David Taladros) "desaparece": se guarda en
// un sitio y la pantalla pinta otro fijo.
//
// Este módulo crea UNA colección `trabajadores` que las unifica. El alta, la
// pestaña Personal, el detector de nóminas del banco y (más adelante) los
// partes leen de aquí. El seed importa lo que ya existe SIN sobreescribir.
// ---------------------------------------------------------------------------
const { getDB } = require('./db');
const CONFIG = require('./config');

function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim(); }
function slugify(s) { return norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

// Salarios netos conocidos (de la pestaña Personal). Solo valor INICIAL editable.
const SALARIO_SEED = { jose: 2400, diego: 1650, abdellah: 1150, mamadou: 1150, paula: 750 };
// Parámetros de coste por defecto (editables; la SS real entra en Fase 2 con la nómina)
const DEFAULTS = { ssEmpresaPct: 0.439, diasLaborablesAno: 218, horasDia: 8 };

// Coste/hora estimado a partir del salario neto + SS empresa. Si no hay salario,
// usa el costeHora guardado (el del config). Mientras no haya nómina real (Fase 2)
// esto es una estimación, marcada como tal en la UI.
function calcCoste(w) {
  const dias = w.diasLaborablesAno || DEFAULTS.diasLaborablesAno;
  const horas = w.horasDia || DEFAULTS.horasDia;
  const horasMes = (dias / 12) * horas;
  if (w.salarioNeto && w.salarioNeto > 0) {
    const base = w.baseCotizacion || w.salarioNeto;
    const ssEmpresa = base * (w.ssEmpresaPct != null ? w.ssEmpresaPct : DEFAULTS.ssEmpresaPct);
    const costeMes = w.salarioNeto + ssEmpresa;
    const diasMes = dias / 12;
    return {
      salarioNeto: w.salarioNeto,
      ssEmpresa: +ssEmpresa.toFixed(2),
      costeMes: +costeMes.toFixed(2),
      costeHora: horasMes ? +(costeMes / horasMes).toFixed(2) : (w.costeHora || 0),
      costeDia: diasMes ? +(costeMes / diasMes).toFixed(2) : 0,
      horasMes: +horasMes.toFixed(1),
      estimado: !w.baseCotizacion, // true mientras no tengamos base real de la nómina
    };
  }
  return { salarioNeto: w.salarioNeto || 0, ssEmpresa: 0, costeMes: 0, costeHora: w.costeHora || 0, costeDia: 0, horasMes: +horasMes.toFixed(1), estimado: true };
}

async function getTrabajadores(soloActivos = false) {
  const db = await getDB();
  const q = soloActivos ? { activo: true } : {};
  const list = await db.collection('trabajadores').find(q).sort({ nombre: 1 }).toArray();
  return list.map(w => ({ ...w, coste: calcCoste(w) }));
}

async function getTrabajador(slugOrId) {
  const db = await getDB();
  const { ObjectId } = require('mongodb');
  let doc = await db.collection('trabajadores').findOne({ slug: slugOrId });
  if (!doc && /^[a-f0-9]{24}$/.test(slugOrId)) doc = await db.collection('trabajadores').findOne({ _id: new ObjectId(slugOrId) });
  return doc ? { ...doc, coste: calcCoste(doc) } : null;
}

async function createTrabajador(data) {
  const db = await getDB();
  const nombre = (data.nombre || '').trim();
  if (!nombre) throw new Error('El nombre es obligatorio');
  const slug = (data.slug && slugify(data.slug)) || slugify(nombre);
  const w = {
    slug,
    nombre,
    alias: Array.isArray(data.alias) ? data.alias.map(norm).filter(Boolean) : (data.alias ? String(data.alias).split(',').map(norm).filter(Boolean) : []),
    activo: data.activo !== false,
    tipo: data.tipo || 'fijo',            // fijo | externo | autonomo
    esAutonomo: !!data.esAutonomo,
    pin: data.pin || null,
    color: data.color || '#4d9cf8',
    salarioNeto: data.salarioNeto != null ? parseFloat(data.salarioNeto) : null,
    baseCotizacion: data.baseCotizacion != null ? parseFloat(data.baseCotizacion) : null,
    ssEmpresaPct: data.ssEmpresaPct != null ? parseFloat(data.ssEmpresaPct) : DEFAULTS.ssEmpresaPct,
    diasLaborablesAno: parseInt(data.diasLaborablesAno || DEFAULTS.diasLaborablesAno),
    horasDia: parseInt(data.horasDia || DEFAULTS.horasDia),
    costeHora: data.costeHora != null ? parseFloat(data.costeHora) : null,
    colaboradorId: data.colaboradorId || null,   // enlace a su cuenta de efectivo (colección colaboradores)
    fechaAlta: data.fechaAlta || new Date().toISOString().slice(0, 10),
    fechaBaja: data.fechaBaja || null,
    notas: (data.notas || '').trim(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await db.collection('trabajadores').updateOne({ slug }, { $set: w }, { upsert: true });
  return getTrabajador(slug);
}

async function updateTrabajador(slugOrId, data) {
  const db = await getDB();
  const { ObjectId } = require('mongodb');
  const allowed = ['nombre', 'alias', 'activo', 'tipo', 'esAutonomo', 'pin', 'color', 'salarioNeto',
                   'baseCotizacion', 'ssEmpresaPct', 'diasLaborablesAno', 'horasDia', 'costeHora', 'colaboradorId', 'fechaAlta', 'fechaBaja', 'notas'];
  const set = { updatedAt: new Date() };
  allowed.forEach(k => { if (data[k] !== undefined) set[k] = data[k]; });
  ['salarioNeto', 'baseCotizacion', 'ssEmpresaPct', 'costeHora'].forEach(k => { if (set[k] != null && set[k] !== '') set[k] = parseFloat(set[k]); });
  if (set.alias) set.alias = (Array.isArray(set.alias) ? set.alias : String(set.alias).split(',')).map(norm).filter(Boolean);
  const filter = /^[a-f0-9]{24}$/.test(slugOrId) ? { _id: new ObjectId(slugOrId) } : { slug: slugOrId };
  await db.collection('trabajadores').updateOne(filter, { $set: set });
  const slug = set.nombre ? null : slugOrId;
  return slug ? getTrabajador(slug) : { ok: true };
}

// Baja = desactivar (no borrar: conserva histórico de partes/nóminas)
async function bajaTrabajador(slugOrId, fecha) {
  return updateTrabajador(slugOrId, { activo: false, fechaBaja: fecha || new Date().toISOString().slice(0, 10) });
}

// Resolver por nombre o apodo (reutilizable por banco/voz). Devuelve el doc o null.
async function resolverTrabajador(texto) {
  const n = norm(texto);
  if (!n) return null;
  const all = await getTrabajadores(false);
  for (const w of all) {
    if (n === norm(w.nombre)) return w;
    if ((w.alias || []).some(a => n === a)) return w;
  }
  for (const w of all) {
    const toks = norm(w.nombre).split(/\s+/).filter(t => t.length > 2);
    if (toks.some(t => n.includes(t))) return w;
    if ((w.alias || []).some(a => a && n.includes(a))) return w;
  }
  return null;
}

// SEED idempotente: importa lo que ya existe SIN pisar ediciones manuales.
// $setOnInsert solo escribe al crear; si ya existe el trabajador, no toca nada.
// Re-sincroniza los apodos (aliasTrabajadores) sobre la plantilla. Los apodos
// apuntan a workerName/workerId, así que mapeamos por ambos.
async function resyncAliases() {
  const db = await getDB();
  const aliasMap = {};
  try {
    const docs = await db.collection('aliasTrabajadores').find({}).toArray();
    for (const a of docs) {
      const k1 = norm(a.workerName), k2 = norm(a.workerId);
      if (k1) (aliasMap[k1] = aliasMap[k1] || []).push(norm(a.alias));
      if (k2) (aliasMap[k2] = aliasMap[k2] || []).push(norm(a.alias));
    }
  } catch (e) {}
  const all = await db.collection('trabajadores').find({}).toArray();
  let tocados = 0;
  for (const w of all) {
    const al = [...new Set([...(w.alias || []), ...(aliasMap[norm(w.nombre)] || []), ...(aliasMap[w.slug] || [])])];
    if (al.length !== (w.alias || []).length) { await db.collection('trabajadores').updateOne({ _id: w._id }, { $set: { alias: al, updatedAt: new Date() } }); tocados++; }
  }
  return tocados;
}

// Aplica las decisiones confirmadas (idempotente): apodos, alta Javi el largo,
// David Taladros a fijo. Re-ejecutable sin efectos secundarios.
async function aplicarReconciliacion() {
  const db = await getDB();
  const aliasTocados = await resyncAliases();
  await db.collection('trabajadores').updateOne(
    { slug: 'javi-el-largo' },
    { $setOnInsert: {
        slug: 'javi-el-largo', nombre: 'Javi el largo', alias: [], activo: true,
        tipo: 'externo', esAutonomo: false, pin: null, color: '#0ea5e9',
        salarioNeto: null, baseCotizacion: null, ssEmpresaPct: DEFAULTS.ssEmpresaPct,
        diasLaborablesAno: DEFAULTS.diasLaborablesAno, horasDia: DEFAULTS.horasDia,
        costeHora: 18, fechaAlta: new Date().toISOString().slice(0, 10), fechaBaja: null,
        notas: 'Por horas', createdAt: new Date(),
      }, $set: { updatedAt: new Date() } },
    { upsert: true }
  );
  await db.collection('trabajadores').updateOne({ slug: 'david' }, { $set: { tipo: 'fijo', activo: true, notas: '', updatedAt: new Date() } });
  // Huaca Javier: externo por horas. Su cuenta de efectivo (191 mov) es el colaborador "Javier" — se enlaza desde la ficha.
  await db.collection('trabajadores').updateOne(
    { slug: 'huaca-javier' },
    { $setOnInsert: {
        slug: 'huaca-javier', nombre: 'Huaca Javier', alias: [], activo: true,
        tipo: 'externo', esAutonomo: false, pin: null, color: '#8b5cf6',
        salarioNeto: null, baseCotizacion: null, ssEmpresaPct: DEFAULTS.ssEmpresaPct,
        diasLaborablesAno: DEFAULTS.diasLaborablesAno, horasDia: DEFAULTS.horasDia,
        costeHora: 7.5, colaboradorId: null,
        fechaAlta: new Date().toISOString().slice(0, 10), fechaBaja: null, notas: '', createdAt: new Date(),
      }, $set: { updatedAt: new Date() } },
    { upsert: true }
  );
  // Javi el largo ya es fijo: quitamos la nota "Por horas" que arrastraba.
  await db.collection('trabajadores').updateOne({ slug: 'javi-el-largo' }, { $set: { notas: '', updatedAt: new Date() } });
  return { ok: true, aliasTocados };
}

async function seedDesdeConfig() {
  const db = await getDB();
  // apodos guardados → mapa slug→[alias]
  let aliasPorNombre = {};
  try {
    const aliasDocs = await db.collection('aliasTrabajadores').find({}).toArray();
    for (const a of aliasDocs) {
      const target = norm(a.nombre || a.trabajador || a.target || '');
      if (!target) continue;
      (aliasPorNombre[target] = aliasPorNombre[target] || []).push(norm(a.alias));
    }
  } catch (e) {}

  let creados = 0, existentes = 0;
  for (const w of (CONFIG.workersFallback || [])) {
    const slug = slugify(w.id || w.name);
    const alias = aliasPorNombre[norm(w.name)] || [];
    const doc = {
      slug, nombre: w.name, alias,
      activo: !/pendiente|baja/i.test(w.nota || '') ? true : true,
      tipo: 'fijo', esAutonomo: false,
      pin: w.pin || null, color: w.color || '#4d9cf8',
      salarioNeto: SALARIO_SEED[slug] != null ? SALARIO_SEED[slug] : null,
      baseCotizacion: null, ssEmpresaPct: DEFAULTS.ssEmpresaPct,
      diasLaborablesAno: DEFAULTS.diasLaborablesAno, horasDia: DEFAULTS.horasDia,
      costeHora: w.costeHora != null ? w.costeHora : null,
      fechaAlta: new Date().toISOString().slice(0, 10), fechaBaja: null,
      notas: w.nota || '', createdAt: new Date(),
    };
    const res = await db.collection('trabajadores').updateOne(
      { slug },
      { $setOnInsert: doc, $set: { updatedAt: new Date() } },
      { upsert: true }
    );
    if (res.upsertedCount) creados++; else existentes++;
  }
  await db.collection('trabajadores').createIndex({ slug: 1 }, { unique: true }).catch(() => {});
  await db.collection('trabajadores').createIndex({ activo: 1 }).catch(() => {});
  return { creados, existentes };
}

// Diagnóstico: reconcilia las 4 fuentes para ver solapes y quién falta dónde.
async function diag() {
  const db = await getDB();
  const safe = async (fn) => { try { return await fn(); } catch (e) { return { error: e.message }; } };
  const config = (CONFIG.workersFallback || []).map(w => ({ id: w.id, nombre: w.name, costeHora: w.costeHora, nota: w.nota || null }));
  const colaboradores = await safe(async () => (await db.collection('colaboradores').find({}).toArray()).map(c => ({ nombre: c.nombre, activo: c.activo, tarifaHora: c.tarifaHora, oficio: c.oficio })));
  const users = await safe(async () => (await db.collection('users').find({}).toArray()).map(u => ({ name: u.name, role: u.role, costeHora: u.costeHora })));
  const aliases = await safe(async () => (await db.collection('aliasTrabajadores').find({}).toArray()).map(a => ({ alias: a.alias, nombre: a.nombre || a.trabajador || a.target })));
  const trabajadores = await safe(async () => (await db.collection('trabajadores').find({}).toArray()).map(w => ({ slug: w.slug, nombre: w.nombre, activo: w.activo, salarioNeto: w.salarioNeto, costeHora: w.costeHora, alias: w.alias })));
  return {
    resumen: {
      config: config.length,
      colaboradores: Array.isArray(colaboradores) ? colaboradores.length : 'error',
      users: Array.isArray(users) ? users.length : 'error',
      aliasTrabajadores: Array.isArray(aliases) ? aliases.length : 'error',
      trabajadores_plantilla: Array.isArray(trabajadores) ? trabajadores.length : 'error',
    },
    config, colaboradores, users, aliases, trabajadores,
  };
}

// ── LIBRO DE EFECTIVO POR TRABAJADOR ────────────────────────────────────────
// Adelantos, pagos en mano y devengado (lo trabajado). Saldo = devengado − entregado.
// Es la cara que el banco NO ve (Javi y quien cobre en efectivo).
async function addMovimientoTrab(slug, data) {
  const db = await getDB();
  const w = await db.collection('trabajadores').findOne({ slug });
  if (!w) throw new Error('Trabajador no encontrado');
  const tipo = data.tipo || 'adelanto'; // devengado | adelanto | pago | descuento | devolucion
  const mov = {
    trabajadorSlug: slug,
    trabajadorNombre: w.nombre,
    fecha: data.fecha || new Date().toISOString().slice(0, 10),
    tipo,
    importe: Math.abs(parseFloat(data.importe || 0)),
    concepto: (data.concepto || '').trim(),
    origen: data.origen || 'dashboard', // dashboard | whatsapp (paso 2)
    createdAt: new Date(),
  };
  if (!mov.importe || mov.importe <= 0) throw new Error('El importe debe ser mayor que 0');
  await db.collection('trabajadorMovimientos').createIndex({ trabajadorSlug: 1, fecha: -1 }).catch(() => {});
  const r = await db.collection('trabajadorMovimientos').insertOne(mov);
  console.log(`[Trabajadores] ${w.nombre}: ${tipo} ${mov.importe}€`);
  return { id: r.insertedId, ...mov };
}

async function getMovimientosTrab(slug, { limit = 200 } = {}) {
  const db = await getDB();
  return db.collection('trabajadorMovimientos').find({ trabajadorSlug: slug }).sort({ fecha: -1, createdAt: -1 }).limit(limit).toArray();
}

async function getSaldoTrab(slug) {
  const db = await getDB();
  const movs = await db.collection('trabajadorMovimientos').find({ trabajadorSlug: slug }).toArray();
  let devengado = 0, entregado = 0, descuentos = 0;
  for (const m of movs) {
    if (m.tipo === 'devengado') devengado += m.importe;
    else if (m.tipo === 'adelanto' || m.tipo === 'pago') entregado += m.importe;
    else if (m.tipo === 'descuento') { entregado += m.importe; descuentos += m.importe; }
    else if (m.tipo === 'devolucion') entregado -= m.importe;
  }
  // pendiente > 0 = le debemos | < 0 = ha recibido de más (adelantos por descontar)
  return { devengado, entregado, descuentos, pendiente: +(devengado - entregado).toFixed(2), n: movs.length };
}

async function deleteMovimientoTrab(movId) {
  const db = await getDB();
  const { ObjectId } = require('mongodb');
  return db.collection('trabajadorMovimientos').deleteOne({ _id: new ObjectId(movId) });
}

module.exports = {
  getTrabajadores, getTrabajador, createTrabajador, updateTrabajador, bajaTrabajador,
  resolverTrabajador, seedDesdeConfig, resyncAliases, aplicarReconciliacion, diag, calcCoste, slugify, norm, DEFAULTS,
  addMovimientoTrab, getMovimientosTrab, getSaldoTrab, deleteMovimientoTrab,
};
