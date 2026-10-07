// src/stelCobros.js — Lo que el banco ya ha casado, cobrado/pagado también en StelOrder (sin conciliar a mano).
//
// El cuadre (trimestre.mapaPagos) sabe qué movimiento del banco o tarjeta paga cada factura. Aquí se pasa a
// StelOrder: los recibos (vencimientos) de esa factura se marcan pagados con la fecha del banco. Si el pago es
// parcial (Claudia: 12.000 € y 8.000 € de una de 29.683,45 €), el recibo se parte: lo cobrado queda pagado y el
// resto, pendiente. Facturas emitidas (ordinaryInvoiceReceipts) y recibidas de proveedor (purchaseInvoiceReceipts).
//
// Va solo tras cada lectura del banco (bancoSync) y desde Cierre del trimestre; siempre se puede ver antes en
// modo prueba. Cada cambio queda en `stelWriteLog`. Solo se toca lo que haga falta (la API tiene límite).
'use strict';
async function getDB() { return require('./db').getDB(); }
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const S = () => require('./stelorder');
const espera = ms => new Promise(r => setTimeout(r, ms));
const isoT = f => `${String(f).slice(0, 10)}T00:00:00+0000`;

// Lo cobrado de cada factura según el banco: [{fecha, importe, origen, movId}] (un pago de varias facturas
// cuenta entero para cada una de ellas: el cuadre ya comprobó que la suma da).
function pagosDe(mapa, doc) {
  const l = mapa.porDoc.get(String(doc.numero)) || mapa.porDoc.get(String(doc.id)) || [];
  return l.map(p => ({ fecha: p.fecha, importe: p.conOtras > 0 ? Math.abs(doc.total) : Math.abs(p.importe), origen: p.origen, movId: p.movId, varias: p.conOtras > 0, concepto: p.concepto || '', persona: p.persona || null }))
    .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
}

// Qué habría que marcar en StelOrder (sin tocar nada).
async function plan({ desde = '2026-01-01' } = {}) {
  const T = require('./trimestre');
  const [mapa, em, rec] = await Promise.all([T.mapaPagos(), T.todasEmitidas(), T.todasRecibidas()]);
  const out = [];
  const mira = (doc, tipo, pendiente) => {
    if (!(pendiente > 0.01) || String(doc.fecha) < desde) return;
    const pagos = pagosDe(mapa, doc);
    if (!pagos.length) return;
    const total = Math.abs(doc.total);
    const cobradoBanco = r2(Math.min(total, pagos.reduce((a, p) => a + p.importe, 0)));
    const yaEnStel = r2(total - pendiente);
    const completo = Math.abs(cobradoBanco - total) <= 0.02 || cobradoBanco >= total;   // ±2 cént. del banco: pagada entera
    const falta = completo ? r2(pendiente) : r2(cobradoBanco - yaEnStel);
    if (falta <= 0.01) return;
    out.push({ tipo, id: String(doc.id), numero: doc.numero, tercero: tipo === 'emitida' ? doc.cliente : doc.proveedor, fecha: doc.fecha, total, pendienteStel: r2(pendiente), cobradoBanco, marcar: falta, completo, pagos });
  };
  em.forEach(d => mira(d, 'emitida', d.pendiente));
  rec.forEach(d => mira(d, 'recibida', d.pendienteStel));
  return out.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
}

// Con qué se pagó, en las formas de pago y cuentas de StelOrder (lo que se veía «domiciliación» en Obramat era la
// forma por defecto del proveedor; manda lo que dice el banco). Tarjeta sin forma propia (Manolo …1643): solo concepto.
const FORMA_TARJETA = { '7925': 125113, '9259': 125013, '6302': 125098, '3139': 125025, '8305': 125112, '3836': 125114, '6983': 127022, '6439': 183315, '4522': 183349 };
const CUENTA_REVOLUT = { '6439': 8142591, '4522': 8142584 };
const CUENTA_SANTANDER = 5621452, TRANSFERENCIA = 106782, DOMICILIACION = 106783;
function formaPago(pg) {
  const o = String(pg.origen || ''), c = String(pg.concepto || '');
  const t = (/…\s*(\d{4})/.exec(o) || /tarj[^*]*\*\s*\d*?(\d{4})\b/i.exec(c) || [])[1] || null;
  const out = { concept: [c.replace(/\s+/g, ' ').trim(), pg.persona ? `(${pg.persona})` : null].filter(Boolean).join(' ').slice(0, 250) || null };
  if (/revolut/i.test(o)) { if (t && FORMA_TARJETA[t]) out['payment-option-id'] = FORMA_TARJETA[t]; out['bank-account-id'] = (t && CUENTA_REVOLUT[t]) || 8142584; }
  else if (/cr[eé]dito/i.test(o)) { if (t && FORMA_TARJETA[t]) out['payment-option-id'] = FORMA_TARJETA[t]; out['bank-account-id'] = CUENTA_SANTANDER; }
  else if (t) { if (FORMA_TARJETA[t]) out['payment-option-id'] = FORMA_TARJETA[t]; out['bank-account-id'] = CUENTA_SANTANDER; }
  else { out['payment-option-id'] = /^recibo\b|adeudo|domicili/i.test(c) ? DOMICILIACION : TRANSFERENCIA; out['bank-account-id'] = CUENTA_SANTANDER; }
  return out;
}

// Recibos sin pagar de una factura, en StelOrder.
async function _recibos(tipo, docId) {
  const ep = tipo === 'emitida' ? '/ordinaryInvoiceReceipts' : '/purchaseInvoiceReceipts';
  const r = await S()._client.get(`${ep}?original-element-id=${encodeURIComponent(docId)}`, { timeout: 25000 });
  const l = (Array.isArray(r.data) ? r.data : []).filter(x => !x.deleted && String(x['original-element-id']) === String(docId));
  return { ep, todos: l, sinPagar: l.filter(x => !x.paid).sort((a, b) => String(a['payment-term-date']).localeCompare(String(b['payment-term-date']))) };
}

// Marca en StelOrder lo cobrado de una factura: cada pago del banco, en orden, paga recibos enteros o parte uno.
async function aplicarUno(p, { por = 'auto' } = {}) {
  const db = await getDB();
  const { ep, sinPagar } = await _recibos(p.tipo, p.id);
  const hechos = [];
  // Pagada entera (también la factura mensual de Bon Preu con 15 pagos de tarjeta): todos sus recibos pendientes,
  // pagados con la fecha del último pago; si fueron varios pagos, el concepto lo dice.
  if (p.completo) {
    const ult = p.pagos[p.pagos.length - 1];
    const fp = formaPago(ult);
    if (p.pagos.length > 1) fp.concept = `${p.pagos.length} pagos del ${p.pagos[0].fecha.split('-').reverse().join('/')} al ${ult.fecha.split('-').reverse().join('/')} · ${fp.concept || ''}`.slice(0, 250);
    for (const rc of sinPagar) {
      await S()._client.put(`${ep}/${rc.id}`, { paid: true, 'payment-date': isoT(ult.fecha), ...fp }, { timeout: 25000 });
      hechos.push({ recibo: rc.id, accion: 'pagado', importe: Math.abs(Number(rc.amount) || 0), fecha: ult.fecha, forma: fp['payment-option-id'] || null });
      await espera(1100);
    }
    await db.collection('stelWriteLog').insertOne({ tipo: 'cobro', doc: p.numero, docId: p.id, tercero: p.tercero, hechos, por, at: new Date() }).catch(() => {});
    return hechos;
  }
  let porMarcar = p.marcar;
  // Lo ya cobrado en StelOrder se descuenta de los pagos más antiguos.
  let yaCubierto = r2(p.total - p.pendienteStel);
  const pagos = p.pagos.map(x => ({ ...x })).filter(x => { if (yaCubierto <= 0.01) return true; const usa = Math.min(yaCubierto, x.importe); yaCubierto = r2(yaCubierto - usa); x.importe = r2(x.importe - usa); return x.importe > 0.01; });
  for (const pg of pagos) {
    let resto = r2(Math.min(pg.importe, porMarcar));
    while (resto > 0.01 && sinPagar.length) {
      const rc = sinPagar[0];
      const amt = Math.abs(Number(rc.amount) || 0), signo = Number(rc.amount) < 0 ? -1 : 1;
      if (resto >= amt - 0.01) {
        const fp = formaPago(pg);
        await S()._client.put(`${ep}/${rc.id}`, { paid: true, 'payment-date': isoT(pg.fecha), ...fp }, { timeout: 25000 });
        hechos.push({ recibo: rc.id, accion: 'pagado', importe: amt, fecha: pg.fecha, forma: fp['payment-option-id'] || null });
        sinPagar.shift(); resto = r2(resto - amt); porMarcar = r2(porMarcar - amt);
      } else {
        // Pago parcial: el recibo queda por lo cobrado (pagado) y se crea otro pendiente por la diferencia.
        await S()._client.put(`${ep}/${rc.id}`, { amount: r2(signo * resto), paid: true, 'payment-date': isoT(pg.fecha), ...formaPago(pg) }, { timeout: 25000 });
        const nuevo = { 'original-element-id': Number(p.id), amount: r2(signo * (amt - resto)), paid: false, 'payment-term-date': rc['payment-term-date'] };
        for (const k of ['payment-option-id', 'bank-account-id']) if (rc[k] != null) nuevo[k] = rc[k];
        const rn = await S()._client.post(ep, nuevo, { timeout: 25000 });
        const dn = Array.isArray(rn.data) ? rn.data[0] : rn.data;
        hechos.push({ recibo: rc.id, accion: 'parcial', importe: resto, fecha: pg.fecha, nuevoPendiente: dn && dn.id, restoPendiente: r2(amt - resto) });
        sinPagar[0] = dn || { ...rc, id: null, amount: signo * (amt - resto) };
        porMarcar = r2(porMarcar - resto); resto = 0;
      }
      await espera(1100);
    }
  }
  await db.collection('stelWriteLog').insertOne({ tipo: 'cobro', doc: p.numero, docId: p.id, tercero: p.tercero, hechos, por, at: new Date() }).catch(() => {});
  return hechos;
}

let _enCurso = false;
async function sincronizar({ dryRun = true, desde = '2026-01-01', soloNumero = null, por = 'auto' } = {}) {
  if (_enCurso) return { enCurso: true };
  _enCurso = true;
  try {
    let l = await plan({ desde });
    if (soloNumero) l = l.filter(p => p.numero === soloNumero);
    if (dryRun) return { dryRun: true, n: l.length, plan: l };
    const res = [];
    for (const p of l) {
      try { res.push({ numero: p.numero, tercero: p.tercero, marcado: p.marcar, completo: p.completo, hechos: await aplicarUno(p, { por }) }); }
      catch (e) { res.push({ numero: p.numero, tercero: p.tercero, error: (e.response && JSON.stringify(e.response.data).slice(0, 200)) || e.message }); }
    }
    if (res.some(r => r.hechos && r.hechos.length)) { try { S().invalidate('receipts'); S().invalidate('ordinaryInvoices'); S().invalidate('purchaseInvoices'); } catch (e) {} try { require('./trimestre').olvidarMapaPagos(); } catch (e) {} }
    const ok = res.filter(r => r.hechos && r.hechos.length).length;
    if (ok || res.some(r => r.error)) console.log(`[StelCobros] ${ok} factura(s) marcadas en StelOrder${res.some(r => r.error) ? ', ' + res.filter(r => r.error).length + ' con error' : ''}`);
    return { dryRun: false, n: res.length, marcadas: ok, res };
  } finally { _enCurso = false; }
}

module.exports = { plan, sincronizar, aplicarUno, pagosDe, formaPago };
