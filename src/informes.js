// src/informes.js — CUENTA DE RESULTADOS por año, SIN IVA y con TODOS los gastos.
//
// Antes (server.js /api/informes) el resultado era ventas con IVA − facturas de proveedor de StelOrder con IVA:
// faltaban nóminas, Seguridad Social, IRPF y lo de Compras, y el IVA (que es de Hacienda) salía como beneficio;
// si StelOrder fallaba, los gastos salían a 0 sin avisar. Ahora:
//
//   Ventas      = base imponible de las facturas emitidas, por fecha de EMISIÓN (StelOrder).
//   Compras     = base de las facturas de proveedor (StelOrder) + gastos de StelOrder + facturas y tickets de
//                 Compras que no están en StelOrder (trimestre.recibidasPunteo, ya sin duplicados).
//   Personal    = nóminas pagadas (banco, categoría nómina) + Seguridad Social (banco, TGSS) + IRPF retenido de
//                 las nóminas (lo lee la IA de cada nómina; se paga a Hacienda con el 111).
//   Sin factura = pagos del banco o con tarjeta sin ninguna factura asociada (conciliación).
//   Banco       = comisiones bancarias de verdad (no el pago de la tarjeta de crédito ni el «Com. 10%»).
//   Resultado   = ventas − todo lo anterior. Los pagos a Hacienda de IVA e IRPF NO son gasto (el IVA es de paso;
//                 el IRPF ya está en Personal).
// Si una fuente falla, se dice (avisos) en vez de contar 0.
'use strict';
async function getDB() { return require('./db').getDB(); }
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const base = x => (x.base != null && Number.isFinite(Number(x.base)) ? Number(x.base) : (Number(x.total) || 0) / 1.21);

let _cache = null, _cacheAt = 0;
async function cuentaResultados({ fresco = false } = {}) {
  if (!fresco && _cache && Date.now() - _cacheAt < 10 * 60 * 1000) return _cache;
  const T = require('./trimestre');
  const avisos = [];
  const tryOr = async (nombre, fn, def) => { try { return await fn(); } catch (e) { avisos.push(`${nombre}: no se ha podido leer (${e.message}). Las cifras están incompletas.`); return def; } };
  const db = await getDB();
  const [em, recStel, gastosStel, movs, noms] = await Promise.all([
    tryOr('Facturas emitidas', () => T.todasEmitidas(), null),
    tryOr('Facturas de proveedor', () => T.todasRecibidas(), null),
    tryOr('Gastos de StelOrder', () => require('./stelorder').getExpenses(), []),
    db.collection('bancoMovimientos').find({ importe: { $lt: 0 }, categoria: { $in: ['nomina', 'seguridad_social', 'comision'] } }).project({ fechaOperacion: 1, importe: 1, categoria: 1, concepto: 1, codigo: 1 }).toArray(),
    db.collection('docsPersonal').find({ tipo: 'nomina' }).project({ mes: 1, importes: 1, userId: 1, subido: 1, 'ia.trabajadorLeido': 1 }).toArray(),
  ]);
  const deCompras = recStel ? await tryOr('Compras', async () => (await T.recibidasPunteo(recStel)).filter(r => String(r.id).startsWith('c:')), []) : [];
  // Pagos que salieron del banco o de una tarjeta y NO tienen ninguna factura asociada en la conciliación (compras con
  // tarjeta sin ticket subido, transferencias a proveedores cuya factura no está…): son gasto aunque falte el papel.
  // No entran los que no la necesitan (nóminas, Seguridad Social, impuestos, traspasos entre cuentas, pago de la
  // tarjeta de crédito), los marcados como personales ni los que ya tienen factura (esos cuentan por la factura).
  const mapa = await tryOr('Conciliación con el banco', () => T.mapaPagos(), null);
  const sinFactura = {};
  if (mapa) {
    const C = require('./conciliacion');
    const [bm, tm] = await Promise.all([
      db.collection('bancoMovimientos').find({ importe: { $lt: 0 } }).project({ fechaOperacion: 1, importe: 1, categoria: 1, concepto: 1, codigo: 1 }).toArray(),
      db.collection('tarjetaMovimientos').find({ importe: { $lt: 0 }, interno: { $ne: true } }).project({ fecha: 1, importe: 1, tipo: 1, estado: 1 }).toArray(),
    ]);
    const NO = new Set(['nomina', 'seguridad_social', 'impuesto', 'ahorro', 'comision']);
    const cuenta = (id, fecha, imp) => { const f = mapa.porMov.get(String(id)); if (!f || ['punteado', 'no_requiere'].includes(f.estado) || /personal/i.test([f.estado, f.nota].join(' '))) return; const y = String(fecha || '').slice(0, 4); if (y) sinFactura[y] = (sinFactura[y] || 0) + Math.abs(imp); };
    for (const m of bm) { if (NO.has(m.categoria)) continue; const tp = C.tipoMovimiento(m).tipo; if (tp === 'liquidacion_tarjeta' || tp === 'traspaso_propio') continue; cuenta(m._id, m.fechaOperacion, m.importe); }
    for (const t of tm) { if (/declined|reverted|failed/i.test(t.estado || '') || !['CARD_PAYMENT', 'FEE'].includes(t.tipo)) continue; cuenta(t._id, t.fecha, t.importe); }
  }
  const anos = {};
  const A = y => (anos[y] = anos[y] || { year: Number(y), ventas: 0, compras: 0, comprasStel: 0, gastosStel: 0, comprasApp: 0, sinFactura: 0, nominas: 0, ss: 0, irpf: 0, comisiones: 0, nFacturas: 0 });
  const serie = MESES.map(label => ({ label }));
  const nowY = new Date().getFullYear();
  if (em) for (const f of em) { const y = String(f.fecha || '').slice(0, 4); if (!y) continue; const b = base(f); A(y).ventas += b; A(y).nFacturas++; const m = Number(String(f.fecha).slice(5, 7)) - 1; if ((+y === nowY || +y === nowY - 1) && m >= 0) serie[m][y] = (serie[m][y] || 0) + b; }
  if (recStel) for (const f of recStel) { const y = String(f.fecha || '').slice(0, 4); if (y) A(y).comprasStel += base(f); }
  for (const g of gastosStel || []) { const y = String(g.date || '').slice(0, 4); if (y) A(y).gastosStel += (Number(g.amount) || 0); }
  for (const c of deCompras) { const y = String(c.fecha || '').slice(0, 4); if (y) A(y).comprasApp += base(c); }
  const Cn = require('./conciliacion');
  for (const m of movs) {
    const y = String(m.fechaOperacion || '').slice(0, 4); if (!y) continue;
    // «comision» en el banco también agrupaba el pago mensual de las tarjetas de crédito y los traspasos «Com. 10%»
    // (37.106 € en 2026): no son comisiones. Las compras con tarjeta cuentan por su factura o en «sin factura».
    if (m.categoria === 'comision') { const tp = Cn.tipoMovimiento(m).tipo; if (tp === 'liquidacion_tarjeta' || tp === 'traspaso_propio' || /c[o0]m\.?\s*10/i.test(m.concepto || '')) continue; }
    const k = { nomina: 'nominas', seguridad_social: 'ss', comision: 'comisiones' }[m.categoria]; if (k) A(y)[k] += -m.importe;
  }
  for (const [y, v] of Object.entries(sinFactura)) A(y).sinFactura += v;
  // La misma nómina recibida dos veces (en el PDF del mes y suelta, o corregida) cuenta una vez.
  for (const n of require('./nominasPagos').sinRepetidas(noms)) { const y = String(n.mes || '').slice(0, 4); const irpf = n.importes && n.importes.irpf; if (!y || irpf == null) continue; A(y).irpf += Number(irpf) || 0; }
  const lista = Object.values(anos).map(a => {
    const compras = a.comprasStel + a.gastosStel + a.comprasApp + a.sinFactura, personal = a.nominas + a.ss + a.irpf;
    const gastos = compras + personal + a.comisiones;
    return { year: a.year, ventas: r2(a.ventas), gastos: r2(gastos), resultado: r2(a.ventas - gastos), margen: a.ventas ? Math.round((a.ventas - gastos) / a.ventas * 1000) / 10 : null, nFacturas: a.nFacturas,
      desglose: { compras: r2(compras), comprasStel: r2(a.comprasStel), gastosStel: r2(a.gastosStel), comprasApp: r2(a.comprasApp), sinFactura: r2(a.sinFactura), personal: r2(personal), nominas: r2(a.nominas), ss: r2(a.ss), irpf: r2(a.irpf), comisiones: r2(a.comisiones) } };
  }).filter(a => a.ventas || a.gastos).sort((a, b) => a.year - b.year);
  serie.forEach(r => { r[nowY] = r2(r[nowY]); r[nowY - 1] = r2(r[nowY - 1]); });
  // Avisos de calidad: años sin nóminas leídas (el IRPF falta) o sin banco.
  const act = lista.find(a => a.year === nowY);
  if (act && !act.desglose.irpf) avisos.push('Este año aún no hay IRPF de nóminas leído: falta subir o leer las nóminas (Personal).');
  _cache = { anos: lista, serie, anoActual: nowY, anoAnterior: nowY - 1, sinIva: true, avisos }; _cacheAt = Date.now();
  return _cache;
}

module.exports = { cuentaResultados };
