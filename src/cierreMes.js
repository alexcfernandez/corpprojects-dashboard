// src/cierreMes.js — CIERRE DEL MES para la gestoría (3/11/2026, Álex: «en vez de un cierre global trimestral, que
// lo hagan cada mes: que se vaya poniendo todo en facturas y organizando, para que en el trimestre no les pille de
// golpe»). Lo lleva la administrativa; el trimestre pasa a ser la suma de sus 3 meses ya cerrados.
//   · Colección `cierresMes` {_id:'2026-10', pasos:{clave:{hecho, por, at}}, cerrado, cerradoPor, cerradoAt}.
//   · Cada paso se marca a mano; al lado se enseña lo que dice el sistema (compras sin revisar, extractos…) para que
//     no se marque en verde algo que aún tiene pendientes. El paso «paquete» se marca solo al bajar el paquete del mes.
//   · Día 5 de cada mes (L-V; si cae en sábado o domingo, el lunes): WhatsApp a Álex y a oficina con lo que falta del
//     mes anterior. Se apaga con CIERRE_MES=off.
'use strict';
const COL = 'cierresMes';
const T = () => require('./trimestre');

const PASOS = [
  { k: 'emitidas', t: 'Facturas emitidas revisadas y cobros al día', ayuda: 'Todas las facturas del mes hechas en StelOrder, con NIF bueno (comunidades con H) y los cobros marcados. Lo que esté cobrado en el banco, márcalo como cobrado.' },
  { k: 'recibidas', t: 'Facturas recibidas completas', ayuda: 'Ninguna factura de proveedor en «faltan factura» del punteo, ni correos de factura sin PDF. Las que falten se piden al proveedor.' },
  { k: 'compras', t: 'Compras revisadas y con obra', ayuda: 'En Compras no queda nada del mes por revisar ni sin obra.' },
  { k: 'extractos', t: 'Extractos hasta fin de mes (Santander, Revolut y tarjetas)', ayuda: 'Con los bancos conectados llegan solos; lo que no esté conectado se sube a mano en «Bancos».' },
  { k: 'punteo', t: 'Punteo del banco revisado', ayuda: 'Cada movimiento con su factura o con su motivo (personal, no lleva factura, otra empresa, dieta…).' },
  { k: 'absentismes', t: 'Absentismos enviados a la gestoría', ayuda: 'La respuesta a Eduard con las faltas, bajas y vacaciones del mes (Corpy la deja en borrador cuando llega su correo).' },
  { k: 'paquete', t: 'Paquete del mes bajado y subido a Drive', ayuda: 'Botón «Paquete completo» con el mes elegido; se marca solo al bajarlo. Luego se arrastra a la carpeta del trimestre en Drive.' },
];

async function _db(_d) { return _d || require('./db').getDB(); }
const okMes = mes => { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(mes || ''))) throw new Error('Mes no válido (ej. 2026-10)'); return String(mes); };
const mesAnterior = (hoy = new Date()) => { const d = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

// Lo que dice el sistema de cada paso: { n: cosas pendientes, txt } (n = null si no se puede saber solo).
async function auto(mes, { _db: dbx = null, _estado = null } = {}) {
  const R = T().rango(mes);
  const db = await _db(dbx);
  const out = {};
  let e = null;
  try { e = await (_estado || (q => T().estado(q)))(mes); } catch (x) { e = null; }
  const p = e && e.pendientes;
  if (p) {
    out.emitidas = { n: (p.gestoria || []).length, txt: (p.gestoria || []).length ? `${p.gestoria.length} factura(s) con algo que corregir (NIF, IVA…)` : 'Sin avisos de la gestoría' };
    const rec = p.correosSinAdjunto.length + p.correosSinRevisar.length;
    out.recibidas = { n: rec, txt: rec ? `${p.correosSinAdjunto.length} correo(s) sin PDF · ${p.correosSinRevisar.length} por revisar` : 'Nada pendiente en el correo' };
    out.extractos = { n: p.banco && p.banco.cubre ? 0 : 1, txt: p.banco && p.banco.hasta ? `Santander hasta el ${p.banco.hasta.split('-').reverse().join('/')}` : 'Falta el extracto de Santander' };
  }
  try {
    const cs = await db.collection('compras').find({ estado: 'por_revisar', fecha: { $gte: R.from, $lte: R.to } }).project({ obraId: 1, destino: 1, varias: 1 }).toArray();
    const sinObra = cs.filter(c => !c.obraId && !c.varias && (!c.destino || c.destino === 'obra')).length;
    out.compras = { n: cs.length, txt: cs.length ? `${cs.length} por revisar${sinObra ? ` (${sinObra} sin obra)` : ''}` : 'Todo revisado' };
  } catch (x) {}
  try {
    const u = await db.collection('tarjetaMovimientos').find({}).sort({ fecha: -1 }).limit(1).toArray();
    const hasta = u[0] && u[0].fecha;
    if (out.extractos) {
      const faltaT = !hasta || hasta < R.to;
      out.extractos = { n: out.extractos.n + (faltaT ? 1 : 0), txt: `${out.extractos.txt} · tarjetas/Revolut ${hasta ? 'hasta el ' + hasta.split('-').reverse().join('/') : 'sin subir'}` };
    }
  } catch (x) {}
  return out;
}

async function get(mes, { conAuto = true, _db: dbx = null, _estado = null } = {}) {
  okMes(mes);
  const db = await _db(dbx);
  const doc = (await db.collection(COL).findOne({ _id: mes })) || { _id: mes, pasos: {} };
  const au = conAuto ? await auto(mes, { _db: db, _estado }).catch(() => ({})) : {};
  const pasos = PASOS.map(p => ({ ...p, hecho: !!(doc.pasos && doc.pasos[p.k] && doc.pasos[p.k].hecho), por: doc.pasos && doc.pasos[p.k] ? doc.pasos[p.k].por || null : null, at: doc.pasos && doc.pasos[p.k] ? doc.pasos[p.k].at || null : null, auto: au[p.k] || null }));
  return { mes, label: T().rango(mes).label, pasos, hechos: pasos.filter(p => p.hecho).length, total: pasos.length, cerrado: !!doc.cerrado, cerradoPor: doc.cerradoPor || null, cerradoAt: doc.cerradoAt || null };
}

async function marcar(mes, k, hecho, por, { _db: dbx = null } = {}) {
  okMes(mes);
  if (!PASOS.some(p => p.k === k)) throw new Error('Paso no válido');
  const db = await _db(dbx);
  const doc = await db.collection(COL).findOne({ _id: mes });
  if (doc && doc.cerrado && !hecho) throw new Error('El mes está cerrado: reábrelo antes de desmarcar un paso');
  await db.collection(COL).updateOne({ _id: mes }, { $set: { [`pasos.${k}`]: { hecho: !!hecho, por: por || 'Oficina', at: new Date() }, actualizado: new Date() } }, { upsert: true });
  return get(mes, { conAuto: false, _db: db });
}

// Cerrar = todos los pasos hechos. Queda quién y cuándo.
async function cerrar(mes, por, { _db: dbx = null } = {}) {
  const db = await _db(dbx);
  const c = await get(mes, { conAuto: false, _db: db });
  const faltan = c.pasos.filter(p => !p.hecho);
  if (faltan.length) throw new Error(`Faltan ${faltan.length} paso(s): ${faltan.map(p => p.t).join(' · ')}`);
  await db.collection(COL).updateOne({ _id: mes }, { $set: { cerrado: true, cerradoPor: por || 'Oficina', cerradoAt: new Date() } }, { upsert: true });
  return get(mes, { conAuto: false, _db: db });
}
async function reabrir(mes, por, { _db: dbx = null } = {}) {
  okMes(mes);
  const db = await _db(dbx);
  await db.collection(COL).updateOne({ _id: mes }, { $set: { cerrado: false, reabiertoPor: por || 'Oficina', reabiertoAt: new Date() } }, { upsert: true });
  return get(mes, { conAuto: false, _db: db });
}

// El trimestre visto como sus 3 meses.
async function delTrimestre(q, { _db: dbx = null } = {}) {
  const db = await _db(dbx);
  const meses = [];
  for (const m of T().mesesDe(q)) meses.push(await get(m, { conAuto: false, _db: db }));
  return { q, meses, cerrados: meses.filter(m => m.cerrado).length };
}

// ¿Hoy toca el aviso? El día 5 si es laborable; si el 5 cae en finde, el lunes siguiente (6 o 7).
function tocaAviso(hoy = new Date()) {
  const d = hoy.getDate(), w = hoy.getDay();
  return (d === 5 && w >= 1 && w <= 5) || (w === 1 && (d === 6 || d === 7));
}
function textoAviso(c) {
  const falta = c.pasos.filter(p => !p.hecho);
  return `🗂️ *Cierre de ${c.label}* para la gestoría — falta${falta.length > 1 ? 'n' : ''} ${falta.length} de ${c.total} pasos:\n` +
    falta.map(p => `• ${p.t}${p.auto && p.auto.n ? ` (${p.auto.txt})` : ''}`).join('\n') +
    `\n\nhttps://dashboard.corpprojects.es/trimestre?q=${c.mes}`;
}
async function avisoDia5({ hoy = new Date(), forzar = false, _db: dbx = null, _estado = null, _enviar = null } = {}) {
  if (process.env.CIERRE_MES === 'off') return { enviado: false, motivo: 'apagado' };
  if (!forzar && !tocaAviso(hoy)) return { enviado: false, motivo: 'no toca' };
  const mes = mesAnterior(hoy);
  const c = await get(mes, { _db: dbx, _estado });
  if (c.cerrado || c.hechos === c.total) return { enviado: false, motivo: 'cerrado', mes };
  const texto = textoAviso(c);
  const dest = String(process.env.FICHAJE_AVISOS_TO || process.env.WHATSAPP_TO || '').split(',').map(s => s.trim().replace(/^whatsapp:/i, '')).filter(Boolean);
  const enviar = _enviar || ((to, t) => require('./notifications').sendWhatsAppTo(to, t));
  let n = 0;
  for (const d of dest) { try { await enviar(d, texto); n++; } catch (e) { console.warn('[CierreMes] aviso:', e.message); } }
  if (!_enviar) { try { await require('./push').sendToOficina({ title: `Cierre de ${c.label}: faltan ${c.total - c.hechos} pasos`, body: c.pasos.filter(p => !p.hecho).map(p => p.t).join(' · ').slice(0, 140), url: `/trimestre?q=${mes}`, tag: 'cierre-mes' }); } catch (e) {} }
  return { enviado: n > 0, mes, n, texto };
}

module.exports = { PASOS, get, auto, marcar, cerrar, reabrir, delTrimestre, tocaAviso, textoAviso, avisoDia5, mesAnterior };
