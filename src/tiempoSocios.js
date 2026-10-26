// src/tiempoSocios.js — EL TIEMPO DE ÁLEX Y ALFONSO (27/10/2026). Ellos no fichan y su día va a trozos: una hora de
// presupuestos para un cliente, una visita a Llagostera, ir a Obramat a por material para otra obra… Álex: «no siempre
// para facturar, sino para saber el coste de nuestras horas y adónde se van: queremos ganar 2.000 € cerrados cada uno».
// Se apunta hablando con Corpy («Alfonso y yo hemos salido a las 10:30 a ver la obra de Laura y hemos vuelto a las 11»)
// y cada rato queda en `tiempoSocios` con quién, obra o cliente, qué (visita, presupuesto, compra, gestión, intervención),
// minutos y km. Son horas de GESTIÓN/administrativas: la obra las enseña aparte (no en el coste de obra) con su
// «beneficio tras gestión» (horas × TARIFA_SOCIO + km × €/km), y a final de mes sale el resumen.
'use strict';
async function getDB() { return require('./db').getDB(); }
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const hoyISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
// 2.000 €/mes ÷ ~160 h → 12,50 €/h de coste (lo que tiene que cubrir cada hora suya). Gasolina y desgaste por km.
const TARIFA = () => Number(process.env.TARIFA_SOCIO_HORA) || 12.5;
const EUR_KM = () => Number(process.env.EUR_KM) || 0.3;
const TIPOS = ['visita', 'presupuesto', 'compra', 'gestion', 'intervencion', 'otro'];
// Km de ida desde Girona a los sitios de siempre (para no tener que decirlos cada vez); ida y vuelta = ×2.
const KM_DESDE_GIRONA = { girona: 0, salt: 4, sarria: 3, 'sant gregori': 8, quart: 6, 'bescano': 10, vilobi: 16, 'riudellots': 12, cassa: 15, llagostera: 22, 'caldes de malavella': 20, 'santa coloma de farners': 27, tordera: 40, lloret: 40, 'sant pere pescador': 42, figueres: 40, olot: 55, 'arenys de mar': 70, banyoles: 20, palafrugell: 40, 'sant feliu de guixols': 35, 'la bisbal': 30, celra: 10, 'sant cugat': 95 };
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
function kmDe(texto) {
  const t = norm(texto); let mejor = null;
  for (const [k, km] of Object.entries(KM_DESDE_GIRONA)) if (t.includes(k) && (mejor == null || k.length > mejor.k.length)) mejor = { k, km };
  return mejor ? mejor.km * 2 : null;
}
const aMin = h => { const m = String(h || '').match(/^(\d{1,2})[:.h]?(\d{2})?$/); return m ? Number(m[1]) * 60 + Number(m[2] || 0) : null; };

async function apuntar({ quienes = [], obra = '', cliente = '', que = '', tipo = 'otro', fecha = null, desde = null, hasta = null, minutos = null, km = null, facturable = false, nota = '' } = {}, por = '', { _db = null, _obraDeTexto = null } = {}) {
  const db = _db || await getDB();
  const ps = [...new Set((Array.isArray(quienes) ? quienes : [quienes]).map(q => /alfons/i.test(q) ? 'Alfonso' : /alex|álex|yo/i.test(q) ? 'Álex' : null).filter(Boolean))];
  if (!ps.length) ps.push('Álex');
  let min = Number(minutos) || null;
  const d0 = aMin(desde), d1 = aMin(hasta);
  if (!min && d0 != null && d1 != null) min = d1 > d0 ? d1 - d0 : null;
  if (!(min > 0)) throw new Error('¿Cuánto rato fue? Dime de qué hora a qué hora o los minutos.');
  const texto = [obra, cliente].filter(Boolean).join(' ');
  let o = null; try { o = texto ? await (_obraDeTexto || require('./comprasVigilancia').obraDeTexto)(texto) : null; } catch (e) {}
  const kms = km != null && km !== '' ? Number(km) : (['visita', 'compra', 'intervencion'].includes(tipo) ? kmDe([texto, o && o.address, o && o.reference, nota].join(' ')) : null);
  const doc = { fecha: /^\d{4}-\d{2}-\d{2}$/.test(String(fecha || '')) ? fecha : hoyISO(), quienes: ps, minutos: Math.round(min), desde: desde || null, hasta: hasta || null,
    tipo: TIPOS.includes(tipo) ? tipo : 'otro', que: String(que || '').trim().slice(0, 200), obraId: o ? String(o._id) : null, obraRef: o ? o.reference : null, cliente: String(cliente || '').trim().slice(0, 120) || null,
    km: kms != null && kms >= 0 ? kms : null, facturable: !!facturable, nota: String(nota || '').trim().slice(0, 200) || null, por: String(por || ''), creado: new Date() };
  doc.coste = r2(doc.minutos / 60 * TARIFA() * ps.length + (doc.km || 0) * EUR_KM());
  const r = await db.collection('tiempoSocios').insertOne(doc); doc._id = r.insertedId;
  return doc;
}

async function deObra(obraId, { _db = null } = {}) {
  const db = _db || await getDB();
  const l = await db.collection('tiempoSocios').find({ obraId: String(obraId) }).sort({ fecha: 1 }).toArray();
  return { total: r2(l.reduce((a, x) => a + (x.coste || 0), 0)), minutos: l.reduce((a, x) => a + x.minutos * x.quienes.length, 0), km: l.reduce((a, x) => a + (x.km || 0), 0), ratos: l.map(x => ({ id: String(x._id), fecha: x.fecha, quienes: x.quienes, minutos: x.minutos, tipo: x.tipo, que: x.que, km: x.km, coste: x.coste, facturable: x.facturable })) };
}

// Resumen del mes: horas de cada uno, por obra/cliente, y lo que cubre de los 2.000 €.
async function resumenMes(mes = hoyISO().slice(0, 7), { _db = null } = {}) {
  const db = _db || await getDB();
  const l = await db.collection('tiempoSocios').find({ fecha: { $regex: '^' + mes } }).toArray();
  const por = {};
  for (const x of l) for (const q of x.quienes) {
    const p = (por[q] = por[q] || { quien: q, minutos: 0, facturableMin: 0, km: 0, sitios: {} });
    p.minutos += x.minutos; if (x.facturable) p.facturableMin += x.minutos; p.km += (x.km || 0) / x.quienes.length;
    const k = x.obraRef || x.cliente || 'Sin obra (gestión)'; p.sitios[k] = (p.sitios[k] || 0) + x.minutos;
  }
  return Object.values(por).map(p => ({ ...p, horas: r2(p.minutos / 60), coste: r2(p.minutos / 60 * TARIFA()), km: Math.round(p.km),
    sitios: Object.entries(p.sitios).sort((a, b) => b[1] - a[1]).map(([s, m]) => ({ sitio: s, horas: r2(m / 60) })) }));
}

module.exports = { apuntar, deObra, resumenMes, kmDe, TARIFA, EUR_KM };
