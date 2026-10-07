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
//   Banco       = comisiones bancarias.
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
    db.collection('bancoMovimientos').find({ importe: { $lt: 0 }, categoria: { $in: ['nomina', 'seguridad_social', 'comision'] } }).project({ fechaOperacion: 1, importe: 1, categoria: 1 }).toArray(),
    db.collection('docsPersonal').find({ tipo: 'nomina' }).project({ mes: 1, importes: 1, userId: 1, 'ia.trabajadorLeido': 1 }).toArray(),
  ]);
  const deCompras = recStel ? await tryOr('Compras', async () => (await T.recibidasPunteo(recStel)).filter(r => String(r.id).startsWith('c:')), []) : [];
  const anos = {};
  const A = y => (anos[y] = anos[y] || { year: Number(y), ventas: 0, compras: 0, comprasStel: 0, gastosStel: 0, comprasApp: 0, nominas: 0, ss: 0, irpf: 0, comisiones: 0, nFacturas: 0 });
  const serie = MESES.map(label => ({ label }));
  const nowY = new Date().getFullYear();
  if (em) for (const f of em) { const y = String(f.fecha || '').slice(0, 4); if (!y) continue; const b = base(f); A(y).ventas += b; A(y).nFacturas++; const m = Number(String(f.fecha).slice(5, 7)) - 1; if ((+y === nowY || +y === nowY - 1) && m >= 0) serie[m][y] = (serie[m][y] || 0) + b; }
  if (recStel) for (const f of recStel) { const y = String(f.fecha || '').slice(0, 4); if (y) A(y).comprasStel += base(f); }
  for (const g of gastosStel || []) { const y = String(g.date || '').slice(0, 4); if (y) A(y).gastosStel += (Number(g.amount) || 0); }
  for (const c of deCompras) { const y = String(c.fecha || '').slice(0, 4); if (y) A(y).comprasApp += base(c); }
  for (const m of movs) { const y = String(m.fechaOperacion || '').slice(0, 4); if (!y) continue; const k = m.categoria === 'nomina' ? 'nominas' : m.categoria === 'seguridad_social' ? 'ss' : 'comisiones'; A(y)[k] += -m.importe; }
  const vistas = new Set();
  for (const n of noms) { const y = String(n.mes || '').slice(0, 4); const irpf = n.importes && n.importes.irpf; if (!y || irpf == null) continue; const k = [n.mes, n.userId || (n.ia && n.ia.trabajadorLeido) || '', n.importes.liquido].join('|'); if (vistas.has(k)) continue; vistas.add(k); A(y).irpf += Number(irpf) || 0; }
  const lista = Object.values(anos).map(a => {
    const compras = a.comprasStel + a.gastosStel + a.comprasApp, personal = a.nominas + a.ss + a.irpf;
    const gastos = compras + personal + a.comisiones;
    return { year: a.year, ventas: r2(a.ventas), gastos: r2(gastos), resultado: r2(a.ventas - gastos), margen: a.ventas ? Math.round((a.ventas - gastos) / a.ventas * 1000) / 10 : null, nFacturas: a.nFacturas,
      desglose: { compras: r2(compras), comprasStel: r2(a.comprasStel), gastosStel: r2(a.gastosStel), comprasApp: r2(a.comprasApp), personal: r2(personal), nominas: r2(a.nominas), ss: r2(a.ss), irpf: r2(a.irpf), comisiones: r2(a.comisiones) } };
  }).filter(a => a.ventas || a.gastos).sort((a, b) => a.year - b.year);
  serie.forEach(r => { r[nowY] = r2(r[nowY]); r[nowY - 1] = r2(r[nowY - 1]); });
  // Avisos de calidad: años sin nóminas leídas (el IRPF falta) o sin banco.
  const act = lista.find(a => a.year === nowY);
  if (act && !act.desglose.irpf) avisos.push('Este año aún no hay IRPF de nóminas leído: falta subir o leer las nóminas (Personal).');
  _cache = { anos: lista, serie, anoActual: nowY, anoAnterior: nowY - 1, sinIva: true, avisos }; _cacheAt = Date.now();
  return _cache;
}

module.exports = { cuentaResultados };
