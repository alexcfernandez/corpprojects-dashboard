// src/cicloCobro.js — Aviso de cobro del tablero del ciclo (2/11/2026, Álex: «haz el aviso de cobro cuando se ponga
// en ámbar»). Cada mañana (L-V) mira la columna «Por cobrar» y avisa a Álex por WhatsApp, UNA vez por factura:
//   · cuando pasa a ámbar (30 días desde la factura, ciclo.LIMITES.cobrar), para reclamarla antes de que se enquiste;
//   · cuando pasa a rojo (60 días), como segundo y último toque.
// El recordatorio para el cliente se prepara y se envía en /cobrar (recordatoriosCobro.js); aquí solo se avisa.
// Se apaga con AVISO_COBRO_CICLO=off. Lo ya avisado se guarda en cicloCobroAvisos.
'use strict';
const COL = 'cicloCobroAvisos';
const eur = n => (Number(n) || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' }) + ' €';
const corto = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

function texto({ ambar, rojo }) {
  if (!ambar.length && !rojo.length) return null;
  const linea = t => `• *${corto(t.cliente, 34)}* · ${t.facturas.map(f => f.ref).join(', ')} · ${eur(t.importe)} · ${t.dias} días${t.operario ? ` (${t.operario})` : ''}${t.que ? `\n  ${corto(t.que, 70)}` : ''}`;
  const tot = l => eur(l.reduce((s, t) => s + (Number(t.importe) || 0), 0));
  const url = `${process.env.DASHBOARD_URL || 'https://dashboard.corpprojects.es'}/cobrar`;
  return [
    ambar.length ? `🟠 *Cobro: empiezan a tardar* (${ambar.length} · ${tot(ambar)})\nFacturas de trabajos con más de un mes sin cobrar:\n${ambar.map(linea).join('\n')}` : '',
    rojo.length ? `🔴 *Cobro en rojo* (${rojo.length} · ${tot(rojo)})\nMás de dos meses sin cobrar:\n${rojo.map(linea).join('\n')}` : '',
    `El recordatorio para el cliente lo tienes preparado en ${url} (por email o WhatsApp, con un toque). Cada factura te sale aquí una vez al pasar a ámbar y otra al pasar a rojo.`,
  ].filter(Boolean).join('\n\n');
}

async function avisar({ enviar = true, _datos = null, _db = null, _enviar = null } = {}) {
  const d = _datos || await require('./ciclo').datos();
  const db = _db || await require('./db').getDB();
  const cobrar = ((d.columnas || []).find(c => c.k === 'cobrar') || { tarjetas: [] }).tarjetas.filter(t => t.semaforo === 'ambar' || t.semaforo === 'rojo');
  if (!cobrar.length) return { enviado: false, ambar: 0, rojo: 0 };
  const hechos = new Map((await db.collection(COL).find({ _id: { $in: cobrar.map(t => t.id) } }).toArray()).map(x => [x._id, x]));
  const ambar = cobrar.filter(t => t.semaforo === 'ambar' && !(hechos.get(t.id) || {}).ambarAt);
  const rojo = cobrar.filter(t => t.semaforo === 'rojo' && !(hechos.get(t.id) || {}).rojoAt);
  const txt = texto({ ambar, rojo });
  if (!txt || !enviar) return { enviado: false, ambar: ambar.length, rojo: rojo.length, texto: txt };
  const ok = await (_enviar || require('./notifications').sendWhatsApp)(txt);
  if (ok === false) return { enviado: false, ambar: ambar.length, rojo: rojo.length, texto: txt };
  const ahora = new Date();
  for (const t of ambar) await db.collection(COL).updateOne({ _id: t.id }, { $set: { ambarAt: ahora, facturas: t.facturas.map(f => f.ref), cliente: t.cliente } }, { upsert: true });
  for (const t of rojo) await db.collection(COL).updateOne({ _id: t.id }, { $set: { rojoAt: ahora, facturas: t.facturas.map(f => f.ref), cliente: t.cliente } }, { upsert: true });
  return { enviado: true, ambar: ambar.length, rojo: rojo.length, texto: txt };
}

module.exports = { avisar, texto };
