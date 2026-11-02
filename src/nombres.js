// src/nombres.js — Casar nombres de trabajadores y de obras tal como los dice Álex (2/11/2026).
//
// Trabajadores: por el nombre corto (users.name), el nombre completo (users.nombreCompleto) y los apodos
// (aliasTrabajadores). Antes solo se miraba users.name y «el contrato de David Valencia» preguntaba «¿qué David?» aunque
// solo hay uno (David Taladros = David Valencia Roca), y «Manolo Rivero» no salía (Manuel Rivero Ramos).
// Obras: por TODAS las palabras en cualquier orden («Claudia Bar» = «Bar Claudia · Sant Pere Pescador»).
'use strict';

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
const VACIAS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'en', 'y', 'a', 'obra', 'obras', 'casa', 'piso']);
const palabras = s => norm(s).split(' ').filter(w => w.length >= 2 && !VACIAS.has(w));

// Todas las palabras de q están en el texto (como palabra o principio de palabra: «Diego» casa con «Diego Campillo»).
function casa(texto, q) {
  const t = ' ' + norm(texto) + ' ', ws = palabras(q);
  return !!ws.length && ws.every(w => t.includes(' ' + w));
}

// users: [{ _id, name, nombreCompleto, active }]; alias: [{ alias, workerId }]
// Devuelve el usuario, { varios:[nombres] } o null.
function casarTrabajador(nombre, users = [], alias = [], { inactivos = false } = {}) {
  const q = norm(nombre);
  if (!q) return null;
  const lista = (users || []).filter(u => inactivos || u.active !== false);
  const apodos = id => (alias || []).filter(a => String(a.workerId) === String(id)).map(a => a.alias);
  const texto = u => [u.name, u.nombreCompleto, ...apodos(u._id)].join(' ');
  const una = l => l.length === 1 ? l[0] : null;
  // 1) Apodo exacto («el taladros»).
  const porApodo = lista.filter(u => apodos(u._id).some(a => norm(a) === q));
  if (una(porApodo)) return porApodo[0];
  // 2) Todas las palabras en nombre + nombre completo + apodos.
  const c = lista.filter(u => casa(texto(u), nombre));
  if (una(c)) return c[0];
  // 3) Si varios casan, el que lo tiene en el nombre corto.
  if (c.length > 1) { const corto = c.filter(u => casa(u.name, nombre)); if (una(corto)) return corto[0]; }
  // 4) Solo el nombre de pila.
  const pila = q.split(' ')[0];
  const p = lista.filter(u => [u.name, u.nombreCompleto].some(n => norm(n).split(' ')[0] === pila));
  if (una(p)) return p[0];
  const varios = (c.length ? c : p).map(u => u.name);
  return varios.length ? { varios } : null;
}

// obras: [{ _id, reference, aliases, clientName, address, status }]. Devuelve la obra, { varias:[refs] } o null.
function casarObra(texto, obras = []) {
  if (!palabras(texto).length) return null;
  const c = (obras || []).filter(o => o.status !== 'descartada' && casa([o.reference, ...(o.aliases || []), o.clientName, o.address].join(' '), texto));
  if (c.length === 1) return c[0];
  const vivas = c.filter(o => !o.status || o.status === 'activa');
  if (vivas.length === 1) return vivas[0];
  return c.length ? { varias: c.map(o => o.reference) } : null;
}

async function aliasDeTrabajadores(db) {
  try { return await db.collection('aliasTrabajadores').find({}).project({ alias: 1, workerId: 1 }).toArray(); } catch (e) { return []; }
}

module.exports = { norm, palabras, casa, casarTrabajador, casarObra, aliasDeTrabajadores };
