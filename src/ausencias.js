// src/ausencias.js — AUSENCIAS LARGAS (10/10/2026): maternidad/paternidad, bajas médicas, lactancia… con su fecha de fin.
// Para que nadie tenga que apuntar cada día en presencia: los laborables de dentro cuentan como esa ausencia (no como
// «sin nada apuntado») y la respuesta de absentismes a la gestoría dice el tipo («baixa per maternitat»).
// appSettings { key: 'ausenciasLargas', lista: [{ id, userId, nombre, tipo, desde, hasta, nota, por, at }] }.
'use strict';
async function getDB() { return require('./db').getDB(); }
const KEY = 'ausenciasLargas';
const TIPOS = { maternidad: 'Maternidad / paternidad', baja: 'Baja médica', accidente: 'Baja por accidente laboral', lactancia: 'Lactancia', excedencia: 'Excedencia', otra: 'Otra ausencia' };
const fOk = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

async function lista() {
  try { const d = await (await getDB()).collection('appSettings').findOne({ key: KEY }); return (d && d.lista) || []; } catch (e) { return []; }
}

async function poner({ userId = null, nombre = '', tipo = 'baja', desde, hasta = null, nota = '' } = {}, por = '') {
  if (!TIPOS[tipo]) throw new Error('Tipo de ausencia no válido');
  if (!fOk(desde)) throw new Error('¿Desde qué día?');
  if (hasta && !fOk(hasta)) throw new Error('Fecha de fin no válida');
  if (!userId && nombre) {
    const us = await require('./users').getUsers(false);
    const n = norm(nombre); const c = us.filter(u => norm(u.name).includes(n) || n.includes(norm(u.name)));
    if (c.length !== 1) throw new Error(c.length ? `¿Quién? Hay varios: ${c.map(u => u.name).join(', ')}` : `No encuentro a «${nombre}»`);
    userId = String(c[0]._id); nombre = c[0].name;
  }
  if (!userId) throw new Error('¿De quién es la ausencia?');
  const l = await lista();
  const x = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), userId: String(userId), nombre: String(nombre).slice(0, 80), tipo, desde, hasta: hasta || null, nota: String(nota || '').slice(0, 300), por, at: new Date() };
  l.push(x);
  await (await getDB()).collection('appSettings').updateOne({ key: KEY }, { $set: { lista: l, at: new Date() } }, { upsert: true });
  return x;
}

async function quitar(id) {
  const l = (await lista()).filter(x => x.id !== id);
  await (await getDB()).collection('appSettings').updateOne({ key: KEY }, { $set: { lista: l, at: new Date() } }, { upsert: true });
  return { ok: true };
}

// La ausencia de esa persona ese día (o null).
function deDia(listaAus, userId, fecha) {
  return listaAus.find(x => String(x.userId) === String(userId) && x.desde <= fecha && (!x.hasta || x.hasta >= fecha)) || null;
}

module.exports = { TIPOS, lista, poner, quitar, deDia };
