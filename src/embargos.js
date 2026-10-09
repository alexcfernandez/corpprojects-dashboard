// src/embargos.js — EMBARGOS DE SUELDO (10/10/2026): lo que la gestoría descuenta en la nómina por orden de un juzgado,
// Hacienda o la Seguridad Social, y que la EMPRESA tiene que ingresar al organismo el día que paga la nómina.
//
// Cada embargo (appSettings 'embargos') dice de quién es, a quién se paga (IBAN y concepto, o referencia de Hacienda),
// el total a cubrir y cómo reconocer su pago en el banco. Lo retenido sale de las nóminas (la IA lee la línea
// «EMBARG…» de cada una; las repetidas cuentan una vez) más lo apuntado a mano (p. ej. el finiquito). Lo pagado, de
// los movimientos del banco que casan (concepto del juzgado, referencia de Hacienda) más lo apuntado a mano que el
// banco aún no trae. Pendiente = retenido − pagado: va a Reservas y a «A pagar en 30 días» con vencimiento el día 5
// del mes siguiente a la nómina.
'use strict';
async function getDB() { return require('./db').getDB(); }
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const KEY = 'embargos';
const mesMas = (mes, n) => { const [y, m] = mes.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };

// Los que ya conocemos (correos de Som Assessors y carta del juzgado). Se guardan en appSettings la primera vez.
const SEMILLA = [
  { id: 'beliard-arenys', userId: '6a1c99b00faa632f1f00029a', trabajador: 'José Antonio Beliard', organismo: "Juzgado de Arenys de Mar (ejecución 859/2011)", corto: 'juzgado Arenys',
    total: 11859.06, beneficiario: "Servei Comú d'Execució d'Arenys de Mar. Secció Civil", iban: 'ES55 0049 3569 9200 0500 1274', concepto: '4933000005085911',
    desde: '2026-08', buscar: '4933000005085911|arenys|servei com', activo: true,
    nota: '8.993,86 € de principal + 2.865,20 € de intereses y costas. La gestoría calcula cada mes lo que se descuenta (art. 607 LEC); en junio y diciembre también la paga extra.' },
  { id: 'vinas-aeat', userId: null, trabajador: 'Javier Viñas', organismo: 'Hacienda (AEAT Guadalajara), diligencia 192621739003N', corto: 'Hacienda',
    total: 229.52, referencia: '192621739003N', comoPagar: 'Sede de la AEAT → Pagar deudas → Pagar diligencias de embargo (no soy el deudor), con la referencia; o en el banco con la carta de pago (192625739015W / 192625739016A).',
    desde: '2026-08', buscar: '192621739003|192625739015|192625739016', activo: true,
    retenidoManual: [{ mes: '2026-08', importe: 160.02, nota: 'Finiquito del 07/08/2026 («EMBARG HISENDA»)' }],
    nota: 'Ya no trabaja con nosotros (baja 07/08/2026): hay que contestar el anexo de la diligencia diciendo que terminó la relación.' },
  { id: 'valencia-aeat', userId: null, trabajador: 'David Valencia', organismo: 'Hacienda (AEAT Girona) y Seguridad Social', corto: 'Hacienda',
    total: null, inembargable: true, activo: true, nota: 'Cobra menos del salario mínimo: no se le retiene nada. Hay que contestar a la AEAT diciéndolo.' },
];

async function lista() {
  const db = await getDB();
  const d = await db.collection('appSettings').findOne({ key: KEY });
  if (d && Array.isArray(d.lista)) return d.lista;
  await db.collection('appSettings').updateOne({ key: KEY }, { $setOnInsert: { key: KEY, lista: SEMILLA, at: new Date() } }, { upsert: true });
  return SEMILLA;
}

async function _guardar(l) { const db = await getDB(); await db.collection('appSettings').updateOne({ key: KEY }, { $set: { lista: l, at: new Date() } }, { upsert: true }); }

// Apuntar un pago que aún no sale en el banco (o se hizo desde otra cuenta).
async function apuntarPago(id, { importe, fecha, nota = '' } = {}, por = '') {
  const imp = r2(String(importe).replace(',', '.'));
  if (!(imp > 0)) throw new Error('Importe no válido');
  const f = /^\d{4}-\d{2}-\d{2}$/.test(String(fecha || '')) ? fecha : new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
  const l = await lista(); const e = l.find(x => x.id === id); if (!e) throw new Error('Embargo no encontrado');
  (e.pagosManual = e.pagosManual || []).push({ fecha: f, importe: imp, nota: String(nota).slice(0, 200), por, at: new Date() });
  await _guardar(l); return { ok: true };
}

// Estado de cada embargo: retenido por mes, pagado, pendiente, y cuánto queda del total.
async function estado({ hoy = new Date() } = {}) {
  const db = await getDB();
  const l = (await lista()).filter(e => e.activo !== false);
  const NP = require('./nominasPagos');
  const out = [];
  for (const e of l) {
    if (e.inembargable) { out.push({ ...e, retenido: 0, pagado: 0, pendiente: 0, meses: [], pagos: [] }); continue; }
    const desde = e.desde || '2026-01';
    // Retenido en nóminas (la IA lee el embargo de cada una; null = aún sin leer).
    const noms = e.userId ? await db.collection('docsPersonal').find({ tipo: 'nomina', userId: String(e.userId), mes: { $gte: desde } }).project({ data: 0 }).toArray() : [];
    const porMes = {};
    NP.sinRepetidas(noms).forEach(n => { const m = porMes[n.mes] = porMes[n.mes] || { mes: n.mes, importe: 0, sinLeer: 0 }; const v = n.importes && n.importes.embargo; if (v == null) m.sinLeer++; else m.importe = r2(m.importe + v); });
    (e.retenidoManual || []).forEach(x => { const m = porMes[x.mes] = porMes[x.mes] || { mes: x.mes, importe: 0, sinLeer: 0 }; m.importe = r2(m.importe + x.importe); m.nota = x.nota; });
    const meses = Object.values(porMes).sort((a, b) => a.mes.localeCompare(b.mes));
    const retenido = r2(meses.reduce((a, m) => a + m.importe, 0));
    // Pagado: banco (lo que casa) + lo apuntado a mano que el banco no trae (mismo importe ±10 días = el mismo pago).
    let banco = [];
    if (e.buscar) banco = (await db.collection('bancoMovimientos').find({ fechaOperacion: { $gte: desde + '-01' }, importe: { $lt: 0 }, concepto: { $regex: e.buscar, $options: 'i' } }).toArray())
      .map(m => ({ fecha: m.fechaOperacion, importe: r2(-m.importe), banco: true }));
    const cerca = (a, b) => Math.abs(new Date(a) - new Date(b)) <= 10 * 86400000;
    const manual = (e.pagosManual || []).filter(p => !banco.some(b => Math.abs(b.importe - p.importe) < 0.01 && cerca(b.fecha, p.fecha))).map(p => ({ fecha: p.fecha, importe: p.importe, manual: true, nota: p.nota }));
    const pagos = [...banco, ...manual].sort((a, b) => a.fecha.localeCompare(b.fecha));
    const pagado = r2(pagos.reduce((a, p) => a + p.importe, 0));
    const pendiente = r2(Math.max(0, retenido - pagado));
    const ultimo = meses.length ? meses[meses.length - 1].mes : null;
    out.push({ ...e, pagosManual: undefined, retenidoManual: undefined, meses, retenido, pagado, pendiente, pagos,
      vence: ultimo ? `${mesMas(ultimo, 1)}-05` : null, sinLeer: meses.reduce((a, m) => a + m.sinLeer, 0),
      quedaTotal: e.total != null ? r2(Math.max(0, e.total - pagado)) : null });
  }
  return out;
}

// Para Reservas / «A pagar en 30 días»: lo retenido que falta ingresar.
async function paraReservas({ hoy = new Date() } = {}) {
  return (await estado({ hoy })).filter(e => e.pendiente > 0.01).map(e => ({
    clave: 'emb:' + e.id, concepto: `Embargo ${String(e.trabajador).split(' ')[0]} (${e.corto || e.organismo})`, importe: e.pendiente, vence: e.vence || new Date(hoy).toISOString().slice(0, 10),
    detalle: `retenido ${e.retenido.toFixed(2)} − ingresado ${e.pagado.toFixed(2)}${e.iban ? ` · IBAN ${e.iban}, concepto ${e.concepto}` : e.referencia ? ` · referencia ${e.referencia}` : ''}` }));
}

module.exports = { lista, estado, paraReservas, apuntarPago, SEMILLA };
