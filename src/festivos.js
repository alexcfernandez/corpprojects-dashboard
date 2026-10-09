// src/festivos.js — Festivos (nacionales, de Cataluña y locales de Girona) para el calendario de presencia y el
// fichaje (9/10/2026). Vienen de serie los de 2026 y 2027; la oficina puede añadir o quitar días desde el propio
// calendario (clic en el número del día), y también cuentan los de FICHAJE_FESTIVOS=AAAA-MM-DD,... por compatibilidad.
// Se guardan en appSettings { key: 'festivos', anadidos: { fecha: nombre }, quitados: [fecha] }.
'use strict';
async function getDB() { return require('./db').getDB(); }

const DE_SERIE = {
  // 2026
  '2026-01-01': 'Año Nuevo', '2026-01-06': 'Reyes', '2026-04-03': 'Viernes Santo', '2026-04-06': 'Lunes de Pascua',
  '2026-05-01': 'Fiesta del Trabajo', '2026-05-25': 'Lunes de Pascua Granada (local Girona)', '2026-06-24': 'Sant Joan',
  '2026-08-15': 'La Asunción', '2026-09-11': 'Diada de Catalunya', '2026-10-12': 'Fiesta Nacional (El Pilar)',
  '2026-10-29': 'Sant Narcís (local Girona)', '2026-12-08': 'La Inmaculada', '2026-12-25': 'Navidad', '2026-12-26': 'Sant Esteve',
  // 2027
  '2027-01-01': 'Año Nuevo', '2027-01-06': 'Reyes', '2027-03-26': 'Viernes Santo', '2027-03-29': 'Lunes de Pascua',
  '2027-05-01': 'Fiesta del Trabajo', '2027-05-17': 'Lunes de Pascua Granada (local Girona)', '2027-06-24': 'Sant Joan',
  '2027-08-15': 'La Asunción', '2027-09-11': 'Diada de Catalunya', '2027-10-12': 'Fiesta Nacional (El Pilar)',
  '2027-10-29': 'Sant Narcís (local Girona)', '2027-11-01': 'Todos los Santos', '2027-12-06': 'Día de la Constitución',
  '2027-12-08': 'La Inmaculada', '2027-12-25': 'Navidad', '2027-12-26': 'Sant Esteve',
};
const ISO = /^\d{4}-\d{2}-\d{2}$/;

async function _ajustes() {
  try { const db = await getDB(); return (await db.collection('appSettings').findOne({ key: 'festivos' })) || {}; } catch (e) { return {}; }
}
// { 'AAAA-MM-DD': 'nombre' } del año (o de todos si no se dice).
async function lista(anio) {
  const a = await _ajustes();
  const out = { ...DE_SERIE };
  String(process.env.FICHAJE_FESTIVOS || '').split(',').map(s => s.trim()).filter(f => ISO.test(f)).forEach(f => { out[f] = out[f] || 'Festivo'; });
  Object.entries(a.anadidos || {}).forEach(([f, n]) => { if (ISO.test(f)) out[f] = n || 'Festivo'; });
  (a.quitados || []).forEach(f => { delete out[f]; });
  return anio ? Object.fromEntries(Object.entries(out).filter(([f]) => f.startsWith(String(anio)))) : out;
}
async function esFestivo(fecha) { return !!(await lista(String(fecha).slice(0, 4)))[fecha]; }

async function poner(fecha, nombre, por) {
  if (!ISO.test(String(fecha || ''))) throw new Error('Fecha no válida');
  const db = await getDB();
  await db.collection('appSettings').updateOne({ key: 'festivos' }, { $set: { [`anadidos.${fecha}`]: String(nombre || 'Festivo').trim().slice(0, 60) || 'Festivo', por: por || '', at: new Date() }, $pull: { quitados: fecha } }, { upsert: true });
  return { ok: true };
}
async function quitar(fecha, por) {
  if (!ISO.test(String(fecha || ''))) throw new Error('Fecha no válida');
  const db = await getDB();
  await db.collection('appSettings').updateOne({ key: 'festivos' }, { $unset: { [`anadidos.${fecha}`]: '' }, $addToSet: { quitados: fecha }, $set: { por: por || '', at: new Date() } }, { upsert: true });
  return { ok: true };
}

module.exports = { lista, esFestivo, poner, quitar, DE_SERIE };
