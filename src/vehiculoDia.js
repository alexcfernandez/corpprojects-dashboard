// src/vehiculoDia.js — QUÉ FURGONETA LLEVA CADA UNO CADA DÍA (4/11/2026, Álex: «David ahora lleva la Partner, que es de
// cinco, porque van muchos a Bar Claudia; la Berlingo es de dos y se ha quedado aquí. Mañana seguramente cambian»).
//  · Al fichar, a quien conduce le sale «🚐 Hoy llevas la Peugeot Partner · Cambiar» (o «hoy no conduzco»).
//  · Conduce quien lo tenga marcado en su ficha (users.conduce true/false) o, si no está marcado, quien tenga el carnet
//    apuntado o sea el conductor de alguna furgoneta. A los demás no les sale nada.
//  · Se guarda un registro por persona y día → ficha del vehículo («quién la ha llevado») y multas (quién conducía ESE día).
//  · Dos que dicen llevar la misma el mismo día → aviso a la oficina.
//  · 3 días seguidos con la misma → pasa a ser su conductor habitual (vehiculos.historialConductor), sin tocarlo a mano.
//
//   vehiculoDia       { _id: 'AAAA-MM-DD:<workerId>', fecha, workerId, workerName, vehiculoId|null, vehiculo, at, origen }
//   vehiculoDiaAvisos { _id: 'AAAA-MM-DD:<vehiculoId>' }  (el aviso de «dos la llevan» sale una vez)
'use strict';
const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const COL = 'vehiculoDia', AVISOS = 'vehiculoDiaAvisos', DIAS_HABITUAL = 3;
const hoyISO = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
const addDias = (f, n) => { const d = new Date(f + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const nombreCorto = s => String(s || '').trim().split(/\s+/)[0];

// ¿Le sale la pregunta? Lo marcado a mano manda; si no, carnet apuntado o conductor de alguna.
function conduce(u, vehiculos = []) {
  if (!u) return false;
  if (u.conduce === true || u.conduce === false) return u.conduce;
  return !!String((u.docs && u.docs.carnet) || '').trim() || vehiculos.some(v => v.conductor && String(v.conductor.userId) === String(u._id));
}

async function _activos(db) {
  return db.collection('vehiculos').find({ estado: 'activo' }).project({ nombre: 1, matricula: 1, conductor: 1, plazas: 1, parada: 1 }).sort({ nombre: 1 }).toArray();
}

// Lo que necesita la tarjeta de /fichar.
async function paraTrabajador(workerId, { hoy = hoyISO(), _db = null } = {}) {
  const db = _db || await getDB();
  const id = String(workerId);
  const [u, vs, deHoy, mio] = await Promise.all([
    ObjectId.isValid(id) ? db.collection('users').findOne({ _id: new ObjectId(id) }, { projection: { conduce: 1, docs: 1 } }) : null,
    _activos(db),
    db.collection(COL).find({ fecha: hoy }).toArray(),
    db.collection(COL).find({ workerId: id, fecha: { $gte: addDias(hoy, -14), $lt: hoy }, vehiculoId: { $ne: null } }).sort({ fecha: -1 }).limit(1).toArray(),
  ]);
  if (!conduce(u ? { ...u, _id: id } : null, vs)) return { conduce: false };
  const elegido = deHoy.find(d => d.workerId === id) || null;
  const habitual = vs.find(v => v.conductor && String(v.conductor.userId) === id);
  const propuesta = elegido ? elegido.vehiculoId : habitual ? String(habitual._id) : (mio[0] && vs.some(v => String(v._id) === mio[0].vehiculoId) ? mio[0].vehiculoId : null);
  return {
    conduce: true,
    elegido: elegido ? { vehiculoId: elegido.vehiculoId } : null,
    propuesta,
    vehiculos: vs.map(v => {
      const otro = deHoy.find(d => d.vehiculoId === String(v._id) && d.workerId !== id);
      return { id: String(v._id), nombre: v.nombre, matricula: v.matricula || '', plazas: v.plazas || null, parada: !!v.parada,
        habitual: v.conductor ? nombreCorto(v.conductor.name) : null, hoyLaLleva: otro ? nombreCorto(otro.workerName) : null };
    }),
  };
}

// Guarda la elección del día. vehiculoId null = «hoy no conduzco».
async function elegir({ workerId, workerName }, vehiculoId, { hoy = hoyISO(), origen = 'fichar', _db = null, _avisar = null, _asignar = null } = {}) {
  const db = _db || await getDB();
  const id = String(workerId);
  let v = null;
  if (vehiculoId) {
    if (!ObjectId.isValid(String(vehiculoId))) throw new Error('Furgoneta no válida');
    v = await db.collection('vehiculos').findOne({ _id: new ObjectId(String(vehiculoId)), estado: 'activo' });
    if (!v) throw new Error('Esa furgoneta no está en la lista');
  }
  const vid = v ? String(v._id) : null;
  await db.collection(COL).updateOne({ _id: `${hoy}:${id}` },
    { $set: { fecha: hoy, workerId: id, workerName: String(workerName || ''), vehiculoId: vid, vehiculo: v ? v.nombre : null, at: new Date(), origen } }, { upsert: true });
  const out = { ok: true, vehiculoId: vid, vehiculo: v ? v.nombre : null, conflicto: null, habitual: false };
  if (!v) return out;

  // ¿Alguien más dice que la lleva hoy? Aviso a la oficina (una vez por furgoneta y día).
  const otros = (await db.collection(COL).find({ fecha: hoy, vehiculoId: vid }).toArray()).filter(d => d.workerId !== id);
  if (otros.length) {
    out.conflicto = otros.map(d => nombreCorto(d.workerName));
    let nuevo = true;
    try { await db.collection(AVISOS).insertOne({ _id: `${hoy}:${vid}`, fecha: hoy, vehiculoId: vid, at: new Date() }); } catch (e) { nuevo = false; }
    if (nuevo) {
      const txt = `🚐 *${v.nombre}*${v.matricula ? ` (${v.matricula})` : ''}: hoy dicen que la llevan *${[nombreCorto(workerName), ...out.conflicto].join('* y *')}*. Mirad quién conduce de verdad (por si llega una multa).`;
      try { await (_avisar || _avisarOficina)(txt); } catch (e) { console.warn('[VehículoDía] aviso:', e.message); }
    }
  }

  // 3 días seguidos con la misma → su conductor habitual.
  const ult = await db.collection(COL).find({ workerId: id, fecha: { $gte: addDias(hoy, -9), $lte: hoy } }).sort({ fecha: -1 }).limit(DIAS_HABITUAL).toArray();
  const yaEsSuya = v.conductor && String(v.conductor.userId) === id;
  if (!yaEsSuya && ult.length === DIAS_HABITUAL && ult.every(d => d.vehiculoId === vid)) {
    const asignar = _asignar || require('./vehiculos').asignarConductor;
    const nota = `${DIAS_HABITUAL} días seguidos llevándola (lo apuntó al fichar)`;
    await asignar(vid, { userId: id, name: workerName, fecha: hoy, nota }, 'automático');
    for (const o of await _activos(db)) {
      if (String(o._id) !== vid && o.conductor && String(o.conductor.userId) === id) await asignar(String(o._id), { userId: null, fecha: hoy, nota: `${nombreCorto(workerName)} lleva ahora ${v.nombre}` }, 'automático');
    }
    out.habitual = true;
  }
  return out;
}

async function _avisarOficina(txt) {
  const to = require('./vehiculos')._oficinaTo();
  for (const t of to) { try { await require('./notifications').sendWhatsAppTo(t, txt); } catch (e) { console.warn('[VehículoDía] WhatsApp:', e.message); } }
}

// Ficha del vehículo: quién la ha llevado (lo apuntado al fichar).
async function historial(vehiculoId, { dias = 90, hoy = hoyISO(), _db = null } = {}) {
  const db = _db || await getDB();
  const l = await db.collection(COL).find({ vehiculoId: String(vehiculoId), fecha: { $gte: addDias(hoy, -dias) } }).sort({ fecha: -1 }).limit(200).toArray();
  return l.map(d => ({ fecha: d.fecha, workerId: d.workerId, workerName: d.workerName }));
}

// Multas: quién dijo que la llevaba ESE día (si alguien lo apuntó al fichar).
async function enFecha(vehiculoId, fecha, { _db = null } = {}) {
  const db = _db || await getDB();
  return db.collection(COL).find({ vehiculoId: String(vehiculoId), fecha }).toArray();
}

module.exports = { conduce, paraTrabajador, elegir, historial, enFecha, hoyISO, COL, DIAS_HABITUAL };
