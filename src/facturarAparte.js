// src/facturarAparte.js — Días de obra que se facturan APARTE por horas (24/10/2026, Álex: «el sábado han trabajado en
// Seranco y eso se factura extra por horas: que se quede marcado y me salga en Inicio»). Se marca en Presencia con la
// casilla del día (attendance.facturarAparte); en Inicio sale por obra y día —quién fue y cuántas horas, contando a
// todos los que estuvieron en esa obra ese día— hasta que se pulsa «Ya facturado» (attendance.facturadoAparte).
'use strict';
async function getDB() { return require('./db').getDB(); }
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const obrasDe = e => (Array.isArray(e.obras) && e.obras.length) ? e.obras : (e.clientName ? [{ clientName: e.clientName, obraId: e.obraId || null, horas: e.horas }] : []);
const claveObra = o => (o.obraId ? 'id:' + o.obraId : 'n:' + norm(o.clientName));

async function pendientes({ _db = null } = {}) {
  const db = _db || await getDB();
  const marcados = await db.collection('attendance').find({ facturarAparte: true, facturadoAparte: { $exists: false } }).toArray();
  const grupos = {};
  for (const e of marcados) for (const o of obrasDe(e)) {
    const k = e.date + '|' + claveObra(o);
    (grupos[k] = grupos[k] || { fecha: e.date, obra: o.clientName || '', obraId: o.obraId || null, marcados: [] }).marcados.push(String(e._id));
  }
  const fechas = [...new Set(Object.values(grupos).map(g => g.fecha))];
  const delDia = fechas.length ? await db.collection('attendance').find({ date: { $in: fechas } }).toArray() : [];
  return Object.values(grupos).map(g => {
    const k = claveObra(g);
    const personas = [];
    for (const e of delDia.filter(x => x.date === g.fecha)) {
      const o = obrasDe(e).find(x => claveObra(x) === k || (g.obra && norm(x.clientName) === norm(g.obra)));
      if (o) personas.push({ nombre: e.workerName || '', horas: r2(o.horas != null ? o.horas : e.horas) });
    }
    return { ...g, personas, horas: r2(personas.reduce((s, p) => s + p.horas, 0)) };
  }).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
}

// «Ya facturado»: se cierran los días marcados de esa obra y esa fecha.
async function marcarFacturado({ fecha, obraId = null, obra = '' } = {}, por = '', { _db = null } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha || ''))) throw new Error('Falta el día');
  const db = _db || await getDB();
  const k = claveObra({ obraId, clientName: obra });
  const marcados = await db.collection('attendance').find({ date: fecha, facturarAparte: true, facturadoAparte: { $exists: false } }).toArray();
  const ids = marcados.filter(e => obrasDe(e).some(o => claveObra(o) === k)).map(e => e._id);
  if (!ids.length) throw new Error('No hay nada pendiente de esa obra ese día');
  await db.collection('attendance').updateMany({ _id: { $in: ids } }, { $set: { facturadoAparte: { at: new Date(), por: String(por || '') } } });
  return { ok: true, cerrados: ids.length };
}

module.exports = { pendientes, marcarFacturado };
