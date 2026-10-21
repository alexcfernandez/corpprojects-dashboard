// src/costeReal.js — COSTE REAL POR HORA de cada asalariado, con lo que de verdad cuesta (21/10/2026, Álex: «teniendo
// los datos bancarios y todo, no entiendo por qué no los sacamos y lo ponemos como es»). Es la «Fase 2» de
// trabajadores.js (allí el coste se estimaba con el neto y un % de SS):
//   · bruto de sus nóminas (docsPersonal leídas por la IA): sin repetidas (nominasPagos.unicasDelMes) ni los «resumen de
//     nómina»; dos nóminas parciales del mismo mes («del 1 al 7», «4 días») se suman;
//   · pagas extra repartidas: cada mes, bruto × 2 × (paga extra / bruto del mes) / 12 — la proporción de SU última paga
//     extra completa o, si no tiene (recién entrado), la mediana de los demás;
//   · Seguridad Social de la EMPRESA: recibo TGSS «Régimen General» de ese periodo (banco) − lo que paga el trabajador
//     (en sus nóminas), repartido por bruto. Sale ~40 % del bruto porque se cotiza también por las pagas extra. El último
//     mes aún no tiene recibo (se paga a mes vencido): usa el % medio de los 3 últimos meses que sí lo tienen;
//   · entre las horas de presencia de esos mismos meses (vacaciones, lluvia y días de médico pagados entran en el coste).
// Ventana: los últimos 3 meses cerrados con nómina. Con menos de 60 h no se da número (se queda la ficha); un mes con
// menos de 6 € brutos por hora tampoco cuenta (las horas apuntadas no son las de la nómina).
// obras.tarifaHora lo usa antes que la ficha. Caché de 1 h.
'use strict';
async function getDB() { return require('./db').getDB(); }
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const mesMas = (mes, n) => { const [y, m] = mes.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };
const texto = n => `${n.nombre || ''} ${n.notas || ''}`;
const esResumen = n => /resumen de n[oó]mina/i.test(texto(n));
const esExtra = n => /verano|estiu|nadal|navidad|paga extra|pagues/i.test(texto(n));
const esParcial = n => /\b\d{1,2}\s*[-–]\s*\d{1,2}\b|\(\d+\s*d[ií]as|del \d+ al \d+/i.test(n.notas || '');
const MESES = 3, MIN_HORAS = 60, SS_DEF = 0.33, MIN_BRUTO_HORA = 6;

// Nóminas normales de un trabajador en un mes → las que cuentan.
function delMes(l) {
  const u = require('./nominasPagos').unicasDelMes(l);
  if (u.length <= 1 || u.every(esParcial)) return u;
  return [u.filter(n => !esParcial(n))[0]];   // unicasDelMes ya las deja de la más reciente a la más antigua
}

async function calcular({ hoy = new Date(), _db = null } = {}) {
  const db = _db || await getDB();
  const hasta = mesMas(hoy.toISOString().slice(0, 7), -1);
  const desde12 = mesMas(hasta, -11);
  const [noms, tgss] = await Promise.all([
    db.collection('docsPersonal').find({ tipo: 'nomina', mes: { $gte: desde12, $lte: hasta } }).project({ data: 0 }).toArray(),
    db.collection('bancoMovimientos').find({ categoria: 'seguridad_social', concepto: /r[eé]gimen general/i }).project({ concepto: 1, importe: 1 }).toArray(),
  ]);
  const validas = noms.filter(n => n.importes && Number(n.importes.bruto) > 0 && !esResumen(n));
  const clave = n => String(n.userId || (n.ia && n.ia.trabajadorLeido) || n._id);

  // Nóminas normales por trabajador y mes; pagas extra aparte.
  const normales = {}, extras = {};
  for (const n of validas) {
    const k = clave(n);
    if (esExtra(n)) { (extras[k] = extras[k] || []).push(n); continue; }
    ((normales[k] = normales[k] || {})[n.mes] = normales[k][n.mes] || []).push(n);
  }
  const porMes = {};   // mes → [{k, bruto, ssT}]
  for (const [k, ms] of Object.entries(normales)) for (const [m, l] of Object.entries(ms)) {
    const ok = delMes(l);
    (porMes[m] = porMes[m] || []).push({ k, userId: ok[0].userId ? String(ok[0].userId) : null, name: (ok[0].ia && ok[0].ia.trabajadorLeido) || '', bruto: ok.reduce((s, n) => s + Number(n.importes.bruto), 0), ssT: ok.reduce((s, n) => s + (Number(n.importes.ssTrabajador) || 0), 0) });
  }

  // % de SS de la empresa sobre el bruto, por mes (recibo TGSS del periodo − lo que pagan los trabajadores).
  const tgMes = {};
  for (const t of tgss) { const p = String(t.concepto).match(/Periodo:\s*(\d{2})\/(\d{4})/i); if (p) tgMes[`${p[2]}-${p[1]}`] = (tgMes[`${p[2]}-${p[1]}`] || 0) - Number(t.importe || 0); }
  const pct = {};
  for (const [m, l] of Object.entries(porMes)) {
    const b = l.reduce((s, x) => s + x.bruto, 0), sT = l.reduce((s, x) => s + x.ssT, 0);
    if (tgMes[m] && b) { const p = (tgMes[m] - sT) / b; if (p > 0.15 && p < 0.6) pct[m] = p; }
  }
  const pcts = Object.keys(pct).sort().slice(-3).map(m => pct[m]);   // los 3 últimos con recibo
  const pctMedio = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : SS_DEF;

  // Proporción paga extra / bruto del mes: la del propio trabajador (si su paga es «completa») o la mediana.
  const ratio = {};
  for (const [k, l] of Object.entries(extras)) {
    const e = l.sort((a, b) => String(b.mes).localeCompare(String(a.mes)))[0];
    const mesBase = normales[k] && normales[k][e.mes] ? delMes(normales[k][e.mes]) : null;
    const base = mesBase ? mesBase.reduce((s, n) => s + Number(n.importes.bruto), 0) : 0;
    const r = base ? Number(e.importes.bruto) / base : 0;
    if (r >= 0.5 && r <= 1.5) ratio[k] = r;
  }
  const rs = Object.values(ratio).sort((a, b) => a - b);
  const ratioMed = rs.length ? rs[Math.floor(rs.length / 2)] : 0.9;

  // Horas de presencia por trabajador y mes.
  const meses = Object.keys(porMes).filter(m => m <= hasta).sort().slice(-MESES);
  if (!meses.length) return [];
  const at = await db.collection('attendance').aggregate([
    { $match: { date: { $gte: meses[0] + '-01', $lte: meses[meses.length - 1] + '-31' } } },
    { $group: { _id: { w: '$workerId', m: { $substr: ['$date', 0, 7] } }, h: { $sum: '$horas' } } },
  ]).toArray();
  const horas = {}; at.forEach(a => { (horas[String(a._id.w)] = horas[String(a._id.w)] || {})[a._id.m] = Number(a.h) || 0; });

  const out = {};
  for (const m of meses) for (const x of porMes[m] || []) {
    if (!x.userId) continue;   // sin usuario (ya no está) no hay horas con las que dividir
    const h = (horas[x.userId] || {})[m] || 0;
    // Menos de 6 € brutos por hora = las horas no cuadran con la nómina (de baja con la presencia puesta, nómina de 7 días
    // con el mes entero apuntado…): ese mes no cuenta.
    if (!h || x.bruto / h < MIN_BRUTO_HORA) continue;
    const p = pct[m] != null ? pct[m] : pctMedio;
    const extra = x.bruto * 2 * (ratio[x.k] != null ? ratio[x.k] : ratioMed) / 12;
    const o = (out[x.userId] = out[x.userId] || { userId: x.userId, name: x.name, meses: [], bruto: 0, extras: 0, ssEmpresa: 0, horas: 0 });
    o.meses.push(m); o.bruto += x.bruto; o.extras += extra; o.ssEmpresa += x.bruto * p; o.horas += h;
  }
  return Object.values(out).map(o => {
    const coste = o.bruto + o.extras + o.ssEmpresa;
    return { ...o, bruto: r2(o.bruto), extras: r2(o.extras), ssEmpresa: r2(o.ssEmpresa), coste: r2(coste), horas: r2(o.horas), costeHora: o.horas >= MIN_HORAS ? r2(coste / o.horas) : null, pctSS: o.bruto ? r2(o.ssEmpresa / o.bruto * 100) : null };
  }).sort((a, b) => (b.costeHora || 0) - (a.costeHora || 0));
}

let _cache = null, _cacheAt = 0;
async function porUsuario() {
  if (_cache && Date.now() - _cacheAt < 3600 * 1000) return _cache;
  const l = await calcular().catch(e => { console.warn('[CosteReal]', e.message); return []; });
  _cache = Object.fromEntries(l.filter(x => x.costeHora).map(x => [x.userId, x]));
  _cacheAt = Date.now();
  return _cache;
}

module.exports = { calcular, porUsuario, _delMes: delMes, _esExtra: esExtra, _esParcial: esParcial };
