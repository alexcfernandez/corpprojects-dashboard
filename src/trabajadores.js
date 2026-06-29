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
    alias: Array.isArray(data.alias) ? data.alias.map(norm).filter(Boolean) : [],
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
                   'baseCotizacion', 'ssEmpresaPct', 'diasLaborablesAno', 'horasDia', 'costeHora', 'fechaAlta', 'fechaBaja', 'notas'];
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

module.exports = {
  getTrabajadores, getTrabajador, createTrabajador, updateTrabajador, bajaTrabajador,
  resolverTrabajador, seedDesdeConfig, diag, calcCoste, slugify, norm, DEFAULTS,
};
