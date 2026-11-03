// src/contactos.js — Personas de contacto de cada cliente/comunidad (3/11/2026, Álex: «mirar del grupo todos los
// contactos y personas que hay para ponerlos en StelOrder y en el dashboard»).
//   · Colección `contactos`: { clienteId, cliente, nombre, rol, piso, telefonos[], emails[], nota, origen, fuente,
//     activo, stel: { id, at, estado }, buscar, creado, actualizado, por }.
//   · Se ven y se editan en la ficha de cada comunidad (Comunidades → 👥 Contactos) y con el buscador.
//   · «Pasar a StelOrder» crea la persona de contacto en la ficha del cliente (POST /contacts), una vez por contacto.
//     StelOrder tiene un cupo de 1.000 peticiones al día para toda la cuenta: se suben en tandas, de una en una.
'use strict';
const { ObjectId } = require('mongodb');
const COL = 'contactos';

const ROLES = {
  presidente: 'Presidente/a', vicepresidente: 'Vicepresidente/a', vecino: 'Vecino/a', propietario: 'Propietario/a',
  inquilino: 'Inquilino/a', familiar: 'Familiar', administrador: 'Administración', tecnico: 'Técnico', conserje: 'Conserje',
  jardinero: 'Jardinero/a', proveedor: 'Proveedor', otro: 'Contacto',
};
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const corto = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// 9 cifras españolas (sin +34) o el número extranjero con su prefijo (0033…, +36…).
function tel(t) {
  let d = String(t || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = '00' + d.slice(1);
  if (d.startsWith('0034')) d = d.slice(4);
  if (d.length === 11 && d.startsWith('34')) d = d.slice(2);
  return /^[6789]\d{8}$/.test(d) || /^00\d{8,15}$/.test(d) ? d : '';
}
const telBonito = t => /^\d{9}$/.test(t) ? `${t.slice(0, 3)} ${t.slice(3, 5)} ${t.slice(5, 7)} ${t.slice(7)}` : t.replace(/^00/, '+');
const telWa = t => /^\d{9}$/.test(t) ? '34' + t : t.replace(/^00/, '');
const email = e => { const m = String(e || '').trim().toLowerCase().match(/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/); return m ? m[0] : ''; };
const buscar = c => norm([c.nombre, c.cliente, c.piso, c.nota, ROLES[c.rol], ...(c.telefonos || []), ...(c.emails || [])].join(' '));

async function _db(_d) { return _d || require('./db').getDB(); }
async function _clientes(_S) {
  const { clientMap } = await (_S || require('./stelorder')).getClients().catch(() => ({ clientMap: {} }));
  return clientMap || {};
}
// Nombre de la ficha de comunidad → id de cliente de StelOrder (el mismo criterio que comunidades.js).
async function idDeNombre(nombre, { _S } = {}) {
  const n = norm(nombre); if (!n) return null;
  for (const [id, c] of Object.entries(await _clientes(_S))) if (norm(c && c.name) === n) return id;
  return null;
}

function _vista(c) {
  return { id: String(c._id), clienteId: c.clienteId || null, cliente: c.cliente || '', nombre: c.nombre, rol: c.rol || 'otro', rolTxt: ROLES[c.rol] || ROLES.otro,
    piso: c.piso || '', nota: c.nota || '', origen: c.origen || 'manual',
    telefonos: (c.telefonos || []).map(t => ({ t, txt: telBonito(t), wa: telWa(t) })), emails: c.emails || [],
    fuente: c.fuente || null, stel: c.stel || null, actualizado: c.actualizado || c.creado || null };
}

async function lista({ clienteId = null, cliente = null, q = null, limite = 300 } = {}, { _db: d = null, _S = null } = {}) {
  const db = await _db(d);
  const f = { activo: { $ne: false } };
  if (cliente && !clienteId) clienteId = await idDeNombre(cliente, { _S });
  if (clienteId) f.clienteId = String(clienteId);
  else if (cliente) f.clienteNorm = norm(cliente);
  if (q) {
    const t = norm(q), dig = String(q).replace(/\D/g, '');
    const ors = t.split(' ').filter(Boolean).map(w => ({ buscar: { $regex: w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } }));
    if (dig.length >= 3) f.$or = [{ $and: ors }, { telefonos: { $regex: dig } }];
    else f.$and = ors;
  }
  const rows = await db.collection(COL).find(f).sort({ cliente: 1, rol: 1, nombre: 1 }).limit(limite).toArray();
  const orden = Object.keys(ROLES);
  rows.sort((a, b) => String(a.cliente || '').localeCompare(String(b.cliente || '')) || orden.indexOf(a.rol) - orden.indexOf(b.rol) || String(a.nombre).localeCompare(String(b.nombre)));
  return rows.map(_vista);
}

function _limpio(x) {
  const out = {
    nombre: corto(x.nombre, 80), rol: ROLES[x.rol] ? x.rol : 'otro', piso: corto(x.piso, 40), nota: corto(x.nota, 300),
    telefonos: [...new Set((Array.isArray(x.telefonos) ? x.telefonos : String(x.telefonos || '').split(/[,;\/]/)).map(tel).filter(Boolean))].slice(0, 4),
    emails: [...new Set((Array.isArray(x.emails) ? x.emails : String(x.emails || '').split(/[,;\s]+/)).map(email).filter(Boolean))].slice(0, 4),
  };
  if (!out.nombre) throw new Error('Falta el nombre');
  return out;
}

// Alta o cambio a mano (desde la ficha). Si ya hay alguien con ese teléfono en el mismo cliente, se actualiza ese.
async function guardar(datos, por, { _db: d = null, _S = null } = {}) {
  const db = await _db(d);
  const c = _limpio(datos || {});
  let clienteId = datos.clienteId ? String(datos.clienteId) : null, cliente = datos.cliente || '';
  if (!clienteId && cliente) clienteId = await idDeNombre(cliente, { _S });
  if (clienteId && !cliente) cliente = ((await _clientes(_S))[clienteId] || {}).name || '';
  const set = { ...c, clienteId, cliente, clienteNorm: norm(cliente), actualizado: new Date(), por };
  set.buscar = buscar(set);
  let id = datos.id && ObjectId.isValid(datos.id) ? new ObjectId(datos.id) : null;
  if (!id && c.telefonos.length) { const ya = await db.collection(COL).findOne({ clienteId, activo: { $ne: false }, telefonos: { $in: c.telefonos } }); if (ya) id = ya._id; }
  if (id) {
    const prev = await db.collection(COL).findOne({ _id: id });
    if (!prev) throw new Error('No encuentro el contacto');
    // Si ya estaba en StelOrder y cambia el teléfono o el nombre, lo marcamos para revisar allí (no se edita solo).
    if (prev.stel && prev.stel.id && (prev.nombre !== set.nombre || String(prev.telefonos) !== String(set.telefonos))) set['stel.cambiado'] = true;
    await db.collection(COL).updateOne({ _id: id }, { $set: set });
    return _vista(await db.collection(COL).findOne({ _id: id }));
  }
  const doc = { ...set, origen: datos.origen || 'manual', fuente: datos.fuente || null, activo: true, stel: null, creado: new Date() };
  const r = await db.collection(COL).insertOne(doc);
  return _vista({ ...doc, _id: r.insertedId });
}

async function borrar(id, por, { _db: d = null } = {}) {
  const db = await _db(d);
  if (!ObjectId.isValid(id)) throw new Error('id no válido');
  await db.collection(COL).updateOne({ _id: new ObjectId(id) }, { $set: { activo: false, borradoPor: por, borradoAt: new Date() } });
  return { ok: true };
}

// Carga de una lista ya revisada (la del grupo de CINC). No pisa lo que ya hay: junta por teléfono/email en el
// mismo cliente y añade lo que falte.
async function importar(lista, por, { origen = 'grupo', _db: d = null, _S = null } = {}) {
  const db = await _db(d); const cm = await _clientes(_S);
  let nuevos = 0, juntados = 0, saltados = 0;
  for (const x of lista || []) {
    let c; try { c = _limpio(x); } catch (e) { saltados++; continue; }
    const clienteId = x.clienteId && cm[x.clienteId] ? String(x.clienteId) : null;
    const cliente = clienteId ? cm[clienteId].name : (x.cliente || x.comunidad || '');
    const claves = [...c.telefonos.map(t => ({ telefonos: t })), ...c.emails.map(e => ({ emails: e }))];
    const ya = claves.length ? await db.collection(COL).findOne({ clienteId, activo: { $ne: false }, $or: claves })
      : await db.collection(COL).findOne({ clienteId, clienteNorm: norm(cliente), activo: { $ne: false }, nombre: c.nombre });
    if (ya) {
      const set = { telefonos: [...new Set([...(ya.telefonos || []), ...c.telefonos])], emails: [...new Set([...(ya.emails || []), ...c.emails])], actualizado: new Date() };
      if (!ya.piso && c.piso) set.piso = c.piso;
      if (!ya.nota && c.nota) set.nota = c.nota;
      set.buscar = buscar({ ...ya, ...set });
      await db.collection(COL).updateOne({ _id: ya._id }, { $set: set }); juntados++; continue;
    }
    const doc = { ...c, clienteId, cliente, clienteNorm: norm(cliente), origen, fuente: x.fuente || null, activo: true, stel: x.stel || null, creado: new Date(), actualizado: new Date(), por };
    doc.buscar = buscar(doc);
    await db.collection(COL).insertOne(doc); nuevos++;
  }
  return { nuevos, juntados, saltados };
}

// Lo que todavía no está en StelOrder (y se puede subir: con cliente y con teléfono o email).
async function pendientesStel({ _db: d = null } = {}) {
  const db = await _db(d);
  return db.collection(COL).find({ activo: { $ne: false }, clienteId: { $ne: null }, 'stel.id': { $exists: false }, 'stel.estado': { $ne: 'revisar' },
    $or: [{ 'telefonos.0': { $exists: true } }, { 'emails.0': { $exists: true } }] }).sort({ cliente: 1 }).toArray();
}

// Sube a StelOrder hasta `max` contactos pendientes (o los `ids` dados). Para en el primer fallo para no gastar cupo.
async function subirStel({ ids = null, max = 50 } = {}, por, { _db: d = null, _S = null, _pausa = 1200 } = {}) {
  const db = await _db(d); const S = _S || require('./stelorder');
  let l = await pendientesStel({ _db: db });
  if (Array.isArray(ids) && ids.length) { const set = new Set(ids.map(String)); l = l.filter(c => set.has(String(c._id))); }
  l = l.slice(0, Math.max(1, Math.min(200, max)));
  const hechos = [], fallos = [];
  for (const c of l) {
    if (S.cupoAgotado && S.cupoAgotado()) { fallos.push({ id: String(c._id), nombre: c.nombre, error: 'Cupo diario de StelOrder agotado: sigue mañana' }); break; }
    const cargo = [ROLES[c.rol] || '', c.piso].filter(Boolean).join(' · ');
    try {
      const r = await S.crearContacto({ accId: c.clienteId, nombre: c.nombre, telefono: c.telefonos[0] ? telBonito(c.telefonos[0]) : null, email: c.emails[0] || null, cargo,
        nota: [c.telefonos.slice(1).map(telBonito).join(', '), c.emails.slice(1).join(', '), c.nota].filter(Boolean).join(' · ') || null, requestedBy: por });
      await db.collection(COL).updateOne({ _id: c._id }, { $set: { stel: { id: r.id, at: new Date(), por } } });
      hechos.push({ id: String(c._id), nombre: c.nombre, cliente: c.cliente });
    } catch (e) {
      if (e.sinRespuesta) await db.collection(COL).updateOne({ _id: c._id }, { $set: { stel: { estado: 'revisar', at: new Date(), error: e.message } } });
      fallos.push({ id: String(c._id), nombre: c.nombre, error: e.message });
      break;
    }
    if (_pausa) await new Promise(r => setTimeout(r, _pausa));
  }
  return { subidos: hechos.length, hechos, fallos, quedan: Math.max(0, (await pendientesStel({ _db: db })).length) };
}

async function resumen({ _db: d = null } = {}) {
  const db = await _db(d);
  const [total, enStel, pend] = await Promise.all([
    db.collection(COL).countDocuments({ activo: { $ne: false } }),
    db.collection(COL).countDocuments({ activo: { $ne: false }, 'stel.id': { $exists: true } }),
    pendientesStel({ _db: db }).then(l => l.length)]);
  return { total, enStel, pendientesStel: pend };
}

module.exports = { ROLES, lista, guardar, borrar, importar, subirStel, pendientesStel, resumen, idDeNombre, tel, telBonito, _limpio };
