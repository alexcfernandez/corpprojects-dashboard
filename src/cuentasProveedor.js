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

// El MISMO proveedor con varios nombres (StelOrder «SPASS, SLU» y «SPASS-SERVICIO DE PREVENCIÓN…», Compras «Amazon» y
// «Amazon EU S.à r.l.», el coworking que factura como «Cossi Coworking» y cobra como «Gerard Codina Mas»): una sola
// cuenta. Se junta por la razón social (alias) y cuando un nombre es el principio del otro (palabra propia ≥5 letras).
const GEN1 = /^(pintur\w*|ferreter\w*|construcc\w*|material\w*|taller\w*|recambio\w*|recanvi\w*|servei\w*|servicio\w*|transport\w*|cafeteria|restaurant\w*|hermanos|germans|grupo?|comercial|distribuc\w*|suministro\w*|instal\w*|reformas?|obras?|gestio\w*|asesor\w*|assessor\w*|autos?|electric\w*|fontaner\w*|fusteria|maderas?|hotel|estacion|gasolinera)$/;
function agrupador(rec) {
  const base = r => clave(r.alias || r.proveedor);
  const cnt = new Map(); rec.forEach(r => { if (r.proveedor) { const k = base(r); cnt.set(k, (cnt.get(k) || 0) + 1); } });
  const keys = [...cnt.keys()], canon = new Map();
  for (const k of keys) {
    const ws = k.split(' ');
    if (ws[0].length < 5 || GEN1.test(ws[0])) { canon.set(k, k); continue; }
    const fam = keys.filter(x => { const xs = x.split(' '); const [a, b] = xs.length <= ws.length ? [xs, ws] : [ws, xs]; return a.every((w, i) => b[i] === w); });
    canon.set(k, fam.sort((a, b) => cnt.get(b) - cnt.get(a) || a.localeCompare(b))[0]);
  }
  return r => canon.get(base(r)) || base(r);
}

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
// Cobra por RECIBO domiciliado (Quartix, la oficina virtual, Marcel Navarro…): lo pendiente se cargará solo, no hay
// que pagarlo a mano. Se ve en cómo se pagaron sus facturas (o en sus recibos sin factura).
const ES_RECIBO = /^\s*(recibo|adeudo|domiciliaci)/i;
function domiciliado(facturas, sueltos = []) {
  return facturas.some(f => (f.pagos || []).some(p => ES_RECIBO.test(p.concepto || ''))) || sueltos.some(m => ES_RECIBO.test(m.concepto || ''));
}

function _factura(r, mapa) {
  const total = r2(r.total);
  const pagos = (mapa.porDoc.get(String(r.numero)) || mapa.porDoc.get(String(r.compraId || '')) || mapa.porDoc.get(String(r.id)) || [])
    .map(p => ({ fecha: p.fecha, importe: r2(p.conOtras > 0 ? Math.abs(total) : Math.abs(p.importe)), origen: p.origen, persona: p.persona || null, concepto: p.concepto, varias: p.conOtras > 0 }));
  let pagado = r2(Math.min(Math.abs(total), pagos.reduce((a, p) => a + p.importe, 0)));
  let segun = pagos.length ? 'banco' : null;
  if (!pagos.length && r.pendienteStel != null && Math.abs(r.pendienteStel) < 0.01 && Math.abs(total) > 0) { pagado = Math.abs(total); segun = 'stelorder'; }
  if (Math.abs(Math.abs(total) - pagado) <= 0.05) pagado = Math.abs(total);   // céntimos de redondeo
  if (total < 0) { pagado = 0; segun = null; }   // un abono no es un pago: resta de lo facturado
  const pendiente = total < 0 ? 0 : r2(total - pagado);
  return { id: r.id, compraId: r.compraId || null, pdfPath: r.pdfPath || null, numero: r.numero, refProveedor: r.refProveedor || null, fecha: r.fecha, total, pagado, pendiente, estado: total < 0 ? 'abono' : pendiente <= 0.01 ? 'pagada' : pagado > 0 ? 'parcial' : 'pendiente', segun, pagos, deCompras: !!r.compraId && !r.pendienteStel && String(r.id).startsWith('c:') };
}

// RECTIFICATIVAS: un abono que anula entera una factura anterior (mismo importe en negativo) deja esa factura
// «anulada»; lo que se le pagó pasa a las siguientes facturas pendientes del proveedor (la que la sustituye).
// Caso Obras Plener: 18.582,84 € pagados 14.000 → abono −18.582,84 y factura nueva de 14.000,35 → todo pagado.
function aplicarRectificativas(facturas) {
  const porFecha = facturas.slice().sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
  for (const ab of porFecha.filter(f => f.estado === 'abono')) {
    const f = porFecha.find(x => x.total > 0 && x.estado !== 'anulada' && Math.abs(x.total + ab.total) < 0.05 && String(x.fecha) <= String(ab.fecha));
    if (!f) continue;
    f.estado = 'anulada'; f.anuladaPor = ab.refProveedor || ab.numero; ab.anulaA = f.refProveedor || f.numero;
    let sobra = r2(f.pagado); const pagosF = f.pagos || []; f.pagado = 0; f.pendiente = 0;
    for (const g of porFecha.filter(x => x.total > 0 && x !== f && x.estado !== 'anulada' && String(x.fecha) >= String(f.fecha))) {
      if (sobra <= 0.01) break;
      const falta = r2(g.total - (g.segun === 'stelorder' ? 0 : g.pagado));
      if (falta <= 0.01) continue;
      const usa = r2(Math.min(sobra, falta)); sobra = r2(sobra - usa);
      if (g.segun === 'stelorder') { g.pagado = 0; g.segun = 'banco'; }
      g.pagos = [...(g.pagos || []), ...pagosF.map(p => ({ ...p, importe: usa, nota: `pagado en su día a la ${f.refProveedor || f.numero}, que se anuló` }))];
      g.pagado = r2(g.pagado + usa);
      g.pendiente = r2(g.total - g.pagado);
      if (g.pendiente <= 1) { g.pendiente = 0; g.estado = 'pagada'; } else g.estado = 'parcial';   // céntimos de redondeo
    }
  }
}

// Proveedores de TIENDA (Obramat, Leroy, Bauhaus…): se pagan en el mostrador con tarjeta. Si la mayoría de sus pagos
// encontrados son con tarjeta, una factura sin pago localizado NO es deuda: está pagada en la tienda y falta casar
// el movimiento (tarjeta sin extracto, ticket sin casar, efectivo). Mismo criterio que la previsión de pagos.
function aplicarTienda(facturas) {
  const pagos = facturas.flatMap(f => f.pagos || []);
  const conTarjeta = pagos.filter(p => /revolut|cr[eé]dito|tarj/i.test(`${p.origen || ''} ${p.concepto || ''}`)).length;
  const deTienda = pagos.length >= 3 && conTarjeta / pagos.length >= 0.6;
  if (!deTienda) return false;
  for (const f of facturas) if (f.estado === 'pendiente' || f.estado === 'parcial') { f.sinLocalizar = f.pendiente; f.pendiente = 0; f.estado = 'sin_localizar'; }
  return true;
}

// Todas las cuentas (una por proveedor) con lo pendiente.
async function cuentas({ desde = '2025-01-01' } = {}) {
  const { rec, mapa } = await _datos();
  const grupoDe = agrupador(rec);
  const g = new Map();
  for (const r of rec) {
    if (!r.fecha || r.fecha < desde || !r.proveedor) continue;
    const k = grupoDe(r);
    const c = g.get(k) || { clave: k, proveedor: r.proveedor, facturas: [] };
    c.facturas.push(_factura(r, mapa));
    g.set(k, c);
  }
  return [...g.values()].map(c => {
    aplicarRectificativas(c.facturas);
    const tienda = aplicarTienda(c.facturas);
    const abonos = c.facturas.filter(f => f.estado === 'abono').reduce((a, f) => a + f.total, 0);
    const pend = c.facturas.reduce((a, f) => a + f.pendiente, 0);
    const dom = domiciliado(c.facturas);
    const sinPagar = c.facturas.filter(f => f.estado === 'pendiente' || f.estado === 'parcial');
    return { clave: c.clave, proveedor: c.proveedor, nFacturas: c.facturas.length, total: r2(c.facturas.reduce((a, f) => a + f.total, 0)),
      pagado: r2(c.facturas.reduce((a, f) => a + f.pagado, 0)), pendiente: r2(Math.max(0, pend + abonos)), abonos: r2(abonos), domiciliado: dom,
      nPendientes: dom ? 0 : sinPagar.length, nDomiciliadas: dom ? sinPagar.length : 0, ultima: c.facturas.map(f => f.fecha).sort().pop(),
      tienda, sinLocalizar: r2(c.facturas.reduce((a, f) => a + (f.sinLocalizar || 0), 0)) };
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
  const grupoDe = agrupador(rec);
  const uno = rec.find(r => r.proveedor && (clave(r.proveedor) === k || grupoDe(r) === k));
  const K = uno ? grupoDe(uno) : k;
  const facturas = rec.filter(r => r.fecha && r.fecha >= desde && r.proveedor && grupoDe(r) === K).map(r => _factura(r, mapa)).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  if (!facturas.length) throw new Error('No encuentro facturas de ese proveedor');
  const nombreProv = (uno || {}).proveedor || nombre;
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
    // Solo palabras PROPIAS del nombre: «obras», «construcciones»… salen en cualquier concepto (los pagos de
    // Wallapop salían como «pagos sin factura» de Obras Plener).
    const GEN = /^(obras?|construcci\w*|reformas?|servicios?|material(es)?|instalacion\w*|proyectos?|grupo|comercial|industrial\w*|empresa|hermanos|germans|distribuc\w*|suministros?|girona|catalunya|holding|soluciones|tecnic\w*)$/;
    const propias = ks.filter(x => !GEN.test(norm(x)));
    if (!propias.length) throw new Error('sin palabras propias');
    const movs = await T.buscar(propias[0]);
    for (const m of (movs.movimientos || [])) {
      if (m.importe >= 0 || m.estado === 'punteado' || m.estado === 'no_requiere' || m.fecha < desde) continue;
      if (!propias.some(x => norm(m.concepto).includes(norm(x)))) continue;
      sinFactura.push({ fecha: m.fecha, importe: Math.abs(m.importe), concepto: m.concepto, origen: m.origen });
    }
  } catch (e) { /* el buscador es un extra */ }
  aplicarRectificativas(facturas);
  const tienda = aplicarTienda(facturas);
  const dom = domiciliado(facturas, sinFactura);
  if (dom) facturas.forEach(f => { if (f.estado === 'pendiente' || f.estado === 'parcial') f.domiciliada = true; });
  const abonos = facturas.filter(f => f.estado === 'abono').reduce((a, f) => a + f.total, 0);
  const pend = facturas.reduce((a, f) => a + f.pendiente, 0);
  return {
    proveedor: nombreProv, facturas, sinFactura, tienda, domiciliado: dom,
    totales: { facturado: r2(facturas.filter(f => f.total > 0).reduce((a, f) => a + f.total, 0)), abonos: r2(abonos), pagado: r2(facturas.reduce((a, f) => a + f.pagado, 0)),
      pendiente: r2(Math.max(0, pend + abonos)), pagosSinFactura: r2(sinFactura.reduce((a, m) => a + m.importe, 0)), sinLocalizar: r2(facturas.reduce((a, f) => a + (f.sinLocalizar || 0), 0)) },
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
  const grupoDe = agrupador(rec);
  const g = new Map();
  for (const r of rec) {
    if (!r.fecha || r.fecha < desde || !r.proveedor) continue;
    const k = grupoDe(r);
    const c = g.get(k) || { clave: k, proveedor: r.proveedor, facturas: [] };
    c.facturas.push({ ...(_factura(r, mapa)), stelId: String(r.id || '') });
    g.set(k, c);
  }
  return [...g.values()];
}

module.exports = { _agrupador: agrupador, _domiciliado: domiciliado, _aplicarTienda: aplicarTienda, _aplicarRectificativas: aplicarRectificativas, cuentas, cuenta, deuda, grupos, olvidar, clave, _factura };
