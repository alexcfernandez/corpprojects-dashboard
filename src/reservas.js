// src/reservas.js — RESERVAS: lo que hay que ir apartando para no ir justos el día que toca pagar.
//
//   IVA (303)   · repercutido − soportado del trimestre (StelOrder). Vence el 20 del mes siguiente al trimestre
//                 (el del 4º trimestre, el 30 de enero). Mientras el plazo está abierto se ven dos: el que toca
//                 pagar ya y el que se está generando.
//   IRPF (111)  · retenciones de las nóminas (las lee la IA de cada nómina) + las de facturas de profesionales.
//   Seg. Social · el cargo de la TGSS de cada mes, estimado con la media de los 3 últimos; se cobra a fin de mes.
//   Nóminas     · lo que falta pagar de las nóminas del mes (nominasPagos); se pagan hacia el día 5.
//
// Lo guardado = el saldo de la cuenta de reserva (por defecto la de Santander …6452; RESERVA_IBAN para cambiarla),
// que lee el banco automático una vez al día. Lo guardado cubre primero lo que vence antes; de cada cosa sale lo
// que falta y cuánto apartar cada semana hasta su fecha.
'use strict';
async function getDB() { return require('./db').getDB(); }
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const DIA = 86400000;
const iso = d => new Date(d).toISOString().slice(0, 10);

function trimestreDe(fecha) { const d = new Date(fecha); const y = d.getUTCFullYear(), n = Math.floor(d.getUTCMonth() / 3) + 1; return { q: `${y}-T${n}`, y, n }; }
function venceTrimestre(y, n) { return n === 4 ? `${y + 1}-01-30` : `${y}-${String(n * 3 + 1).padStart(2, '0')}-20`; }
function anterior({ y, n }) { return n === 1 ? { q: `${y - 1}-T4`, y: y - 1, n: 4 } : { q: `${y}-T${n - 1}`, y, n: n - 1 }; }
const finDeMes = (y, m) => iso(Date.UTC(y, m, 0));            // m 1-12

async function _ivaIrpf(t, db) {
  const T = require('./trimestre');
  const R = T.rango(t.q);
  const e = await T.estado(t.q);
  const rep = Number(e.resumen && e.resumen.emitidas && e.resumen.emitidas.iva) || 0, sop = Number(e.resumen && e.resumen.recibidas && e.resumen.recibidas.iva) || 0;
  const meses = [0, 1, 2].map(i => `${t.y}-${String((t.n - 1) * 3 + 1 + i).padStart(2, '0')}`);
  const noms = await db.collection('docsPersonal').find({ tipo: 'nomina', mes: { $in: meses } }).project({ importes: 1, mes: 1 }).toArray();
  const irpfNom = noms.reduce((a, n) => a + (Number(n.importes && n.importes.irpf) || 0), 0);
  const sinIrpf = noms.filter(n => !(n.importes && n.importes.irpf != null)).length;
  let irpfProf = 0;
  try { const fp = await require('./stelorder').getPurchaseInvoices(); irpfProf = fp.filter(x => x.date && String(x.date).slice(0, 10) >= R.from && String(x.date).slice(0, 10) <= R.to).reduce((a, x) => a + (Number(x.retencion) || 0), 0); } catch (e) {}
  return { repercutido: r2(rep), soportado: r2(sop), iva: r2(Math.max(0, rep - sop)), ivaAFavor: r2(Math.max(0, sop - rep)), irpfNominas: r2(irpfNom), irpfProfesionales: r2(irpfProf), nominasSinIrpf: sinIrpf, nNominas: noms.length };
}

async function _saldoReserva(db) {
  const fin = String(process.env.RESERVA_IBAN || '6452').replace(/\s/g, '');
  const conns = await db.collection('bancoConexiones').find({ estado: 'activa' }).toArray();
  for (const c of conns) for (const a of c.cuentas || []) if (a.iban && a.iban.replace(/\s/g, '').endsWith(fin)) return { saldo: a.saldo != null ? r2(a.saldo) : null, saldoAt: a.saldoAt || null, cuenta: `${c.banco} …${a.iban.slice(-4)}` };
  return { saldo: null, saldoAt: null, cuenta: null };
}

let _cache = null, _cacheAt = 0;
async function panel({ hoy = new Date(), fresco = false } = {}) {
  if (!fresco && _cache && Date.now() - _cacheAt < 15 * 60 * 1000) return _cache;
  const db = await getDB();
  const hoyIso = iso(hoy);
  const actual = trimestreDe(hoy), prev = anterior(actual);
  const plazoPrev = hoyIso <= venceTrimestre(prev.y, prev.n);
  const items = [];
  const qs = plazoPrev ? [prev, actual] : [actual];
  for (const t of qs) {
    const x = await _ivaIrpf(t, db).catch(e => ({ error: e.message }));
    if (x.error) { items.push({ clave: 'iva:' + t.q, concepto: `IVA ${t.n}º trimestre (303)`, error: x.error, vence: venceTrimestre(t.y, t.n) }); continue; }
    const enCurso = t.q === actual.q;
    items.push({ clave: 'iva:' + t.q, concepto: `IVA ${t.n}º trimestre (303)`, importe: x.iva, vence: venceTrimestre(t.y, t.n), enCurso,
      detalle: `repercutido ${x.repercutido.toFixed(2)} − soportado ${x.soportado.toFixed(2)}${x.ivaAFavor ? ` (a favor: ${x.ivaAFavor.toFixed(2)})` : ''}${enCurso ? ' · sigue subiendo hasta fin de trimestre' : ''}` });
    const irpf = r2(x.irpfNominas + x.irpfProfesionales);
    items.push({ clave: 'irpf:' + t.q, concepto: `IRPF ${t.n}º trimestre (111)`, importe: irpf, vence: venceTrimestre(t.y, t.n), enCurso,
      detalle: `nóminas ${x.irpfNominas.toFixed(2)} (${x.nNominas}${x.nominasSinIrpf ? `, ${x.nominasSinIrpf} sin leer` : ''}) + profesionales ${x.irpfProfesionales.toFixed(2)}` });
  }
  // Seguridad Social: media de los 3 últimos cargos de la TGSS; vence a fin de mes.
  try {
    const desde = iso(hoy.getTime() - 100 * DIA);
    const ss = await db.collection('bancoMovimientos').find({ fechaOperacion: { $gte: desde }, importe: { $lt: 0 }, $or: [{ categoria: 'seguridad_social' }, { concepto: { $regex: 'tgss|seguridad social', $options: 'i' } }] }).toArray();
    const porMes = {}; ss.forEach(m => { const k = m.fechaOperacion.slice(0, 7); porMes[k] = (porMes[k] || 0) - m.importe; });
    const vals = Object.values(porMes).slice(-3);
    const media = vals.length ? r2(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
    const ya = porMes[hoyIso.slice(0, 7)] || 0;
    const y = hoy.getUTCFullYear(), m = hoy.getUTCMonth() + 1;
    if (media) items.push({ clave: 'ss:' + hoyIso.slice(0, 7), concepto: 'Seguridad Social del mes', importe: ya >= media * 0.8 ? 0 : media, vence: finDeMes(y, m), detalle: ya >= media * 0.8 ? `ya cargada este mes (${ya.toFixed(2)})` : `estimado con la media de los últimos ${vals.length} meses` });
  } catch (e) {}
  // Nóminas: lo que falta pagar de las del mes pasado (y del actual si ya están subidas).
  try {
    const NP = require('./nominasPagos');
    const mesAnt = iso(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - 1, 1)).slice(0, 7);
    const e = await NP.estado(mesAnt, { hoy });
    if (e.totales.nominas) items.push({ clave: 'nom:' + mesAnt, concepto: `Nóminas de ${mesAnt}`, importe: e.totales.falta, vence: `${hoyIso.slice(0, 7)}-05`, detalle: `${e.totales.pagadas} de ${e.totales.nominas} pagadas${e.totales.sinImporte ? `, ${e.totales.sinImporte} sin importe leído` : ''}` });
  } catch (e) {}

  const res = await _saldoReserva(db);
  // Lo guardado cubre primero lo que vence antes.
  let queda = res.saldo || 0;
  const lista = items.filter(i => !i.error).sort((a, b) => a.vence.localeCompare(b.vence)).map(i => {
    const cubre = r2(Math.min(queda, i.importe || 0)); queda = r2(queda - cubre);
    const falta = r2((i.importe || 0) - cubre);
    const dias = Math.ceil((new Date(i.vence + 'T12:00:00Z') - new Date(hoyIso + 'T12:00:00Z')) / DIA);
    const semanas = Math.max(1, Math.ceil(Math.max(dias, 1) / 7));
    return { ...i, cubierto: cubre, falta, dias, porSemana: falta > 0 ? r2(falta / semanas) : 0 };
  });
  const total = r2(lista.reduce((a, i) => a + (i.importe || 0), 0));
  _cache = {
    hoy: hoyIso, reserva: res, items: [...lista, ...items.filter(i => i.error)],
    totales: { necesario: total, guardado: res.saldo, falta: r2(Math.max(0, total - (res.saldo || 0))), sobra: r2(Math.max(0, (res.saldo || 0) - total)),
      porSemana: r2(lista.reduce((a, i) => a + i.porSemana, 0)) },
  };
  _cacheAt = Date.now();
  return _cache;
}

module.exports = { panel, venceTrimestre, trimestreDe };
