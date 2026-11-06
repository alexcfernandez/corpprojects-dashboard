// src/lluviaObservacion.js — Cuando llueve en Girona, a Álex y a la oficina los trabajos «en observación» por agua
// (6/11/2026, Álex con Illa Verda: «si sabemos que está lloviendo aquí en Girona, que me mande un mensaje: esto que
// estaba en observación por lluvia, ya puedes llamar a preguntar; así no se queda ningún día de lluvia sin llamar»).
//
// Cada hora de 8 a 20 mira la lluvia de las últimas horas en Open-Meteo (gratis, sin clave). Si pasa de LLUVIA_MM
// (1 mm por defecto) y hay trabajos en observación por agua, manda UN aviso al día con a quién llamar. El día de lluvia
// queda apuntado en el trabajo (observacion.lluvias) y sale en el tablero.
'use strict';
const TZ = 'Europe/Madrid';
const GIRONA = { lat: 41.98, lon: 2.82 };
const hoyISO = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: TZ });
const horaMadrid = (d = new Date()) => Number(d.toLocaleString('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }));
const MM = () => Number(process.env.LLUVIA_MM || 1);
const POR_AGUA = /lluv|plou|agua|aigua|filtra|gotera|goteres|humedad|humitat|moja|entra/i;
const corto = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const fechaCorta = f => `${String(f).slice(8, 10)}/${String(f).slice(5, 7)}`;
const mmTxt = n => String(Math.round(n * 10) / 10).replace('.', ',');
async function getDB() { return require('./db').getDB(); }

// mm de lluvia en Girona en las últimas `horas` horas (hasta la hora en curso incluida).
async function lluvia({ horas = 6, ahora = new Date(), _fetch = null } = {}) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${GIRONA.lat}&longitude=${GIRONA.lon}&hourly=precipitation&past_days=1&forecast_days=1&timezone=Europe%2FMadrid`;
  const r = await (_fetch || fetch)(url);
  if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
  const d = await r.json();
  const t = (d.hourly && d.hourly.time) || [], p = (d.hourly && d.hourly.precipitation) || [];
  const fin = `${hoyISO(ahora)}T${String(horaMadrid(ahora)).padStart(2, '0')}:00`;
  const i = t.indexOf(fin);
  if (i < 0) throw new Error('Open-Meteo sin la hora actual');
  const mm = p.slice(Math.max(0, i - horas + 1), i + 1).reduce((s, x) => s + (Number(x) || 0), 0);
  return { mm: Math.round(mm * 10) / 10, horas };
}

// Trabajos en observación que dependen de la lluvia (por lo que dice el motivo o el trabajo).
async function enObservacion(db) {
  const l = await db.collection('workOrderAssignments').find({ observacion: { $exists: true }, status: { $nin: ['done', 'invoiced'] }, cerrado: { $ne: true } }).toArray();
  return l.filter(a => a.observacion.lluvia === true || (a.observacion.lluvia !== false && POR_AGUA.test(`${a.observacion.motivo || ''} ${a.resumen || ''}`)));
}

function mensaje(lista, { mm, horas }) {
  const linea = a => {
    const o = a.observacion, contacto = o.contacto || a.contacto;
    return `• *${corto(a.cliente, 40)}*${a.direccion ? ' · ' + corto(a.direccion, 35) : ''} (${a.pedidoRef || ''})\n` +
      `   ${o.motivo ? corto(o.motivo, 90) : 'en observación'}${o.desde ? ` · desde el ${fechaCorta(hoyISO(new Date(o.desde)))}` : ''}\n` +
      `   📞 ${contacto ? corto(contacto, 60) : 'sin contacto apuntado (míralo en la ficha)'}`;
  };
  return `🌧️ *Está lloviendo en Girona* (${mmTxt(mm)} mm en las últimas ${horas} h).\n\n` +
    `Buen momento para llamar a ${lista.length === 1 ? 'este trabajo' : 'estos trabajos'} en observación y preguntar si entra agua y por dónde:\n\n` +
    `${lista.map(linea).join('\n\n')}\n\n` +
    `Si entra agua y hay que ir: tablero 🚦 → la tarjeta → escribe qué hay que hacer → «Devolver». Le sale en su parte y le llega por WhatsApp.`;
}

// Cron: cada hora de 8 a 20. Un aviso al día como mucho. A las 8 mira también la noche (12 h).
async function revisar({ ahora = new Date(), dryRun = false, _lluvia = null, _enviar = null, _db = null } = {}) {
  const db = _db || await getDB();
  const hoy = hoyISO(ahora);
  const cfg = await db.collection('appSettings').findOne({ key: 'lluviaObservacion' });
  if (!dryRun && cfg && cfg.value && cfg.value.ultimo === hoy) return { ya: true };
  const lista = await enObservacion(db);
  if (!lista.length) return { trabajos: 0 };
  const horas = horaMadrid(ahora) <= 8 ? 12 : 6;
  const ll = await (_lluvia || lluvia)({ horas, ahora });
  if (ll.mm < MM()) return { trabajos: lista.length, mm: ll.mm, llueve: false };
  const txt = mensaje(lista, ll);
  if (dryRun) return { trabajos: lista.length, mm: ll.mm, llueve: true, txt };
  const N = require('./notifications');
  const enviar = _enviar || N.sendWhatsAppTo;
  let ok = 0;
  for (const to of [...new Set([N.destinoDueno(), process.env.OFICINA_TELEFONO || '+34674013723'].filter(Boolean))]) {
    try { if (await enviar(to, txt, { sinTraducir: true }) !== false) ok++; } catch (e) { console.warn('[Lluvia] envío:', e.message); }
  }
  await db.collection('appSettings').updateOne({ key: 'lluviaObservacion' }, { $set: { value: { ultimo: hoy, mm: ll.mm, enviados: ok } } }, { upsert: true });
  await db.collection('workOrderAssignments').updateMany({ _id: { $in: lista.map(a => a._id) } }, { $push: { 'observacion.lluvias': { fecha: hoy, mm: ll.mm, avisado: new Date() } } });
  return { trabajos: lista.length, mm: ll.mm, llueve: true, enviados: ok };
}

module.exports = { lluvia, enObservacion, mensaje, revisar, POR_AGUA };
