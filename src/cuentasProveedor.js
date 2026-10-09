// src/cuentasProveedor.js — CUENTA DE CADA PROVEEDOR al céntimo: sus facturas, qué se ha pagado (y con qué
// movimiento del banco o tarjeta), qué queda pendiente y los pagos que no tienen factura.
//
//   Facturas: las de StelOrder + las de Compras que aún no están allí (trimestre.recibidasPunteo).
//   Pagado:   lo que el cuadre del banco une a cada factura (trimestre.mapaPagos). Si el banco no dice nada pero
//             StelOrder la tiene cobrada (pago en efectivo, compensación…), cuenta como pagada «según StelOrder».
//   Pendiente = total − pagado (las parciales salen con lo que falta).
//   Pagos sin factura: movimientos que nombran al proveedor y no casan con nada (anticipos, facturas que faltan).
//
// Lo usan la pestaña «Cuentas» de Compras, el WhatsApp del banco (avisoPagos: «aún le debemos X») y el aviso
// cuando llega una factura nueva por correo.
'use strict';
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\b(s\.?\s?l\.?\s?u?|s\.?\s?a\.?\s?u?|slu|sau|sl|sa|scp|s\.c\.p)\b\.?/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9ñç]+/g, ' ').trim();
const clave = s => norm(s).split(' ').filter(w => w.length >= 3 && !['del', 'les', 'els', 'los', 'las', 'girona'].includes(w)).slice(0, 3).join(' ') || norm(s);

let _cache = null, _cacheAt = 0;
async function _datos() {
  if (_cache && Date.now() - _cacheAt < 5 * 60 * 1000) return _cache;
  const T = require('./trimestre');
  const recStel = await T.todasRecibidas();
  const [rec, mapa] = await Promise.all([T.recibidasPunteo(recStel).catch(() => recStel), T.mapaPagos()]);
  _cache = { rec, mapa }; _cacheAt = Date.now();
  return _cache;
}
function olvidar() { _cache = null; }

function _factura(r, mapa) {
  const total = r2(r.total);
  const pagos = (mapa.porDoc.get(String(r.numero)) || mapa.porDoc.get(String(r.compraId || '')) || mapa.porDoc.get(String(r.id)) || [])
    .map(p => ({ fecha: p.fecha, importe: r2(p.conOtras > 0 ? Math.abs(total) : Math.abs(p.importe)), origen: p.origen, persona: p.persona || null, concepto: p.concepto, varias: p.conOtras > 0 }));
  let pagado = r2(Math.min(Math.abs(total), pagos.reduce((a, p) => a + p.importe, 0)));
  let segun = pagos.length ? 'banco' : null;
  if (!pagos.length && r.pendienteStel != null && Math.abs(r.pendienteStel) < 0.01 && Math.abs(total) > 0) { pagado = Math.abs(total); segun = 'stelorder'; }
  if (Math.abs(Math.abs(total) - pagado) <= 0.02) pagado = Math.abs(total);
  const pendiente = total < 0 ? 0 : r2(total - pagado);
  return { id: r.id, compraId: r.compraId || null, pdfPath: r.pdfPath || null, numero: r.numero, refProveedor: r.refProveedor || null, fecha: r.fecha, total, pagado, pendiente, estado: total < 0 ? 'abono' : pendiente <= 0.01 ? 'pagada' : pagado > 0 ? 'parcial' : 'pendiente', segun, pagos, deCompras: !!r.compraId && !r.pendienteStel && String(r.id).startsWith('c:') };
}

// Todas las cuentas (una por proveedor) con lo pendiente.
async function cuentas({ desde = '2025-01-01' } = {}) {
  const { rec, mapa } = await _datos();
  const g = new Map();
  for (const r of rec) {
    if (!r.fecha || r.fecha < desde || !r.proveedor) continue;
    const k = clave(r.proveedor);
    const c = g.get(k) || { clave: k, proveedor: r.proveedor, facturas: [] };
    c.facturas.push(_factura(r, mapa));
    g.set(k, c);
  }
  return [...g.values()].map(c => {
    const abonos = c.facturas.filter(f => f.estado === 'abono').reduce((a, f) => a + f.total, 0);
    const pend = c.facturas.reduce((a, f) => a + f.pendiente, 0);
    return { clave: c.clave, proveedor: c.proveedor, nFacturas: c.facturas.length, total: r2(c.facturas.reduce((a, f) => a + f.total, 0)),
      pagado: r2(c.facturas.reduce((a, f) => a + f.pagado, 0)), pendiente: r2(Math.max(0, pend + abonos)), abonos: r2(abonos),
      nPendientes: c.facturas.filter(f => f.estado === 'pendiente' || f.estado === 'parcial').length, ultima: c.facturas.map(f => f.fecha).sort().pop() };
  }).sort((a, b) => b.pendiente - a.pendiente || String(b.ultima).localeCompare(String(a.ultima)));
}

// El detalle de un proveedor: facturas con sus pagos y los pagos que no casan con ninguna factura.
async function cuenta(nombre, { desde = '2025-01-01' } = {}) {
  let k = clave(nombre);
  if (!k) throw new Error('Falta el proveedor');
  const { rec, mapa } = await _datos();
  // «Rubén Esteban» encuentra «Rubén Esteban Díaz Aceña»: todas las palabras buscadas están en el nombre.
  if (!rec.some(r => r.proveedor && clave(r.proveedor) === k)) {
    const ws = norm(nombre).split(' ').filter(w => w.length >= 3);
    const cand = {}; rec.forEach(r => { if (r.proveedor && ws.length && ws.every(w => norm(r.proveedor).includes(w))) { const kk = clave(r.proveedor); cand[kk] = (cand[kk] || 0) + 1; } });
    const mejor = Object.entries(cand).sort((a, b) => b[1] - a[1])[0];
    if (mejor) k = mejor[0];
  }
  const facturas = rec.filter(r => r.fecha && r.fecha >= desde && r.proveedor && clave(r.proveedor) === k).map(r => _factura(r, mapa)).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  if (!facturas.length) throw new Error('No encuentro facturas de ese proveedor');
  const nombreProv = (rec.find(r => r.proveedor && clave(r.proveedor) === k) || {}).proveedor || nombre;
  // Para ver la factura de un clic: la de StelOrder que vino de Compras tiene allí su documento ORIGINAL (PDF o foto
  // del proveedor). Se busca su gemela por el nº del proveedor (solo dígitos).
  try {
    const sinCompra = facturas.filter(f => !f.compraId && f.refProveedor);
    if (sinCompra.length) {
      const db = await require('./db').getDB();
      const dig = x => String(x || '').replace(/\D/g, '');
      const cs = await db.collection('compras').find({ estado: { $ne: 'descartada' }, numero: { $ne: null }, proveedorNorm: new RegExp((norm(nombreProv).match(/[a-z0-9]{4,}/) || [norm(nombreProv).slice(0, 4)])[0]) }).project({ numero: 1, total: 1 }).toArray();
      for (const f of sinCompra) {
        const d = dig(f.refProveedor); if (d.length < 4) continue;
        const c = cs.find(x => { const dc = dig(x.numero); return dc && (dc === d || (Math.min(dc.length, d.length) >= 5 && (dc.endsWith(d) || d.endsWith(dc)))); });
        if (c) f.compraId = String(c._id);
      }
    }
  } catch (e) {}
  // Pagos del banco que nombran al proveedor y no tienen factura (anticipos, facturas que faltan).
  const { clavesTercero } = require('./conciliacion');
  const ks = clavesTercero(nombreProv);
  const sinFactura = [];
  try {
    const T = require('./trimestre');
    const movs = await T.buscar(nombreProv.split(/[\s,]+/).filter(w => w.length >= 4)[0] || nombreProv);
    for (const m of (movs.movimientos || [])) {
      if (m.importe >= 0 || m.estado === 'punteado' || m.estado === 'no_requiere' || m.fecha < desde) continue;
      if (!ks.some(x => norm(m.concepto).includes(norm(x)))) continue;
      sinFactura.push({ fecha: m.fecha, importe: Math.abs(m.importe), concepto: m.concepto, origen: m.origen });
    }
  } catch (e) { /* el buscador es un extra */ }
  const abonos = facturas.filter(f => f.estado === 'abono').reduce((a, f) => a + f.total, 0);
  const pend = facturas.reduce((a, f) => a + f.pendiente, 0);
  return {
    proveedor: nombreProv, facturas, sinFactura,
    totales: { facturado: r2(facturas.filter(f => f.total > 0).reduce((a, f) => a + f.total, 0)), abonos: r2(abonos), pagado: r2(facturas.reduce((a, f) => a + f.pagado, 0)),
      pendiente: r2(Math.max(0, pend + abonos)), pagosSinFactura: r2(sinFactura.reduce((a, m) => a + m.importe, 0)) },
  };
}

// «Cuánto le debemos» a un proveedor (para los WhatsApp).
async function deuda(nombre) {
  try { const c = await cuenta(nombre); return { proveedor: c.proveedor, pendiente: c.totales.pendiente, nPendientes: c.facturas.filter(f => f.estado === 'pendiente' || f.estado === 'parcial').length, pagosSinFactura: c.totales.pagosSinFactura }; }
  catch (e) { return null; }
}

// Todas las facturas agrupadas por proveedor (con sus pagos), para la previsión de pagos (vencimientos.js).
async function grupos({ desde = '2025-01-01' } = {}) {
  const { rec, mapa } = await _datos();
  const g = new Map();
  for (const r of rec) {
    if (!r.fecha || r.fecha < desde || !r.proveedor) continue;
    const k = clave(r.proveedor);
    const c = g.get(k) || { clave: k, proveedor: r.proveedor, facturas: [] };
    c.facturas.push({ ...(_factura(r, mapa)), stelId: String(r.id || '') });
    g.set(k, c);
  }
  return [...g.values()];
}

module.exports = { cuentas, cuenta, deuda, grupos, olvidar, clave, _factura };
