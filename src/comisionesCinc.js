// src/comisionesCinc.js — Comprueba una factura de comisiones de CINC (administrador de fincas).
//
// CINC cobra a Corp el 10 % de la BASE de cada factura nuestra a sus comunidades, y la lista línea a
// línea («Treballs realitzats Fact. n.º 872 … 185,46»). Por cada línea se mira:
//   · que la factura nuestra exista y esté COBRADA (banco o StelOrder),
//   · que el importe sea el 10 % de su base (no del total con IVA, ni el 100 %),
//   · que no la hayan cobrado ya en otra factura de CINC (o dos veces en la misma).
// Se usa desde Compras (ficha de una factura de CINC).

async function getDB() { return require('./db').getDB(); }
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const PCT = () => Number(process.env.CINC_COMISION || 10) / 100;

// Nº de factura nuestra que cita la línea: «Fact. n.º 872», «n.º00910», «Factura FAC00870».
function numDeLinea(txt) {
  const m = String(txt || '').match(/(?:fact(?:ura)?\.?\s*(?:n\.?\s*[ºo°]\.?)?\s*|FAC)\s*(?:FAC)?\s*0*(\d{2,5})\b/i);
  return m ? 'FAC' + m[1].padStart(5, '0') : null;
}

async function revisar(compraId) {
  const db = await getDB();
  const compras = require('./compras');
  const c = await compras.getCompra(compraId);
  if (!c) throw new Error('Compra no encontrada');
  const T = require('./trimestre');
  const [em, mapa, otras] = await Promise.all([
    T.todasEmitidas(),
    T.mapaPagos().catch(() => null),
    db.collection('compras').find({ proveedor: /cinc/i, estado: { $ne: 'descartada' }, duplicadoDe: null }).project({ numero: 1, fecha: 1, lineas: 1 }).toArray(),
  ]);
  const porNum = {}; em.forEach(e => { porNum[e.numero] = e; });
  // Lo ya cobrado por CINC en sus OTRAS facturas (las que están en Compras).
  const antes = {};
  for (const o of otras) {
    if (String(o._id) === String(compraId) || (o.numero && o.numero === c.numero)) continue;
    (o.lineas || []).forEach(l => { const n = numDeLinea(l.descripcion); if (n) (antes[n] = antes[n] || []).push(o.numero || String(o._id)); });
  }
  const enEsta = {};
  const filas = (c.lineas || []).map(l => {
    const num = numDeLinea(l.descripcion);
    const cobra = r2(Math.abs(l.importe || 0));
    const e = num ? porNum[num] : null;
    const base = e && e.base != null ? Number(e.base) : null;
    const debe = base != null ? r2(base * PCT()) : null;
    const pagos = num && mapa ? (mapa.porDoc.get(num) || []) : [];
    let estado = 'ok', deMas = 0;
    if (!num) estado = 'sin_num';
    else if (!e) estado = 'no_existe';
    else if (enEsta[num]) { estado = 'duplicada'; deMas = cobra; }
    else if (antes[num]) { estado = 'ya_cobrada'; deMas = cobra; }
    else if (Math.abs(cobra - debe) > 0.10) { estado = Math.abs(cobra - r2(Number(e.total) * PCT())) <= 0.05 ? 'sobre_total' : (cobra > debe ? 'de_mas' : 'de_menos'); deMas = r2(cobra - debe); }
    if (num) enEsta[num] = true;
    return {
      descripcion: l.descripcion, num, cobra, base, debe, deMas: r2(deMas), estado, cliente: e ? e.cliente : null,
      cobrada: pagos.length ? { fecha: pagos[0].fecha, importe: Math.abs(pagos[0].importe) } : null,
      pendienteCobro: e && !pagos.length && e.pendiente != null && e.pendiente > 0.01 ? e.pendiente : null,
      yaEn: antes[num] || null,
    };
  });
  const deMas = r2(filas.filter(f => f.deMas > 0).reduce((a, f) => a + f.deMas, 0));
  return {
    compra: { id: String(c._id), numero: c.numero, fecha: c.fecha, base: c.base, total: c.total },
    pct: PCT() * 100, filas, deMas, deMasConIva: r2(deMas * 1.21),
    sumaLineas: r2(filas.reduce((a, f) => a + f.cobra, 0)),
    sinCobrar: filas.filter(f => f.pendienteCobro).length,
  };
}

module.exports = { revisar, numDeLinea };
