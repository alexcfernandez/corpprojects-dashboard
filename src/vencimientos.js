// src/vencimientos.js — PREVISIÓN DE PAGOS A PROVEEDORES: qué se va a cargar o hay que pagar y cuándo.
//
// La fecha sale de cómo paga cada proveedor (aprendido de lo ya pagado en el banco):
//   · día fijo de cargo: si sus recibos caen casi siempre el mismo día del mes (Saltoki, Oliveras, Sant Narcís: ~25),
//     la factura se cargará ese día, N meses después de la fecha de factura (lo habitual de ese proveedor);
//   · si no: a los días de siempre desde la factura (mediana);
//   · sin historial: a 30 días.
// Solo cuentan las facturas que el banco no ha pagado todavía (cuentasProveedor). Lo usan el panel de reservas
// y el WhatsApp de cada mañana («en los próximos días se cargan…»).
'use strict';
const DIA = 86400000;
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const iso = d => new Date(d).toISOString().slice(0, 10);
const mediana = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const eur = n => Math.abs(Number(n) || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' }) + ' €';

// Cómo paga un proveedor, a partir de sus facturas pagadas por el banco.
function patron(facturas) {
  const pares = [];
  facturas.filter(f => f.segun === 'banco' && f.pagos.length && f.total > 0).forEach(f => { const p = f.pagos[f.pagos.length - 1]; pares.push({ fac: f.fecha, pago: p.fecha }); });
  if (!pares.length) return { tipo: 'sin_historial', dias: 30, n: 0 };
  const dias = pares.map(x => Math.round((new Date(x.pago) - new Date(x.fac)) / DIA)).filter(d => d >= -5 && d <= 150);
  const dom = pares.map(x => Number(x.pago.slice(8, 10)));
  const moda = mediana(dom);
  const cerca = dom.filter(d => Math.abs(d - moda) <= 3).length;
  if (pares.length >= 3 && cerca / pares.length >= 0.7) {
    const meses = pares.map(x => (Number(x.pago.slice(0, 4)) * 12 + Number(x.pago.slice(5, 7))) - (Number(x.fac.slice(0, 4)) * 12 + Number(x.fac.slice(5, 7))));
    return { tipo: 'dia_fijo', dia: moda, meses: Math.max(0, mediana(meses)), n: pares.length };
  }
  return { tipo: 'dias', dias: dias.length ? Math.max(0, mediana(dias)) : 30, n: pares.length };
}
function fechaPrevista(fechaFactura, pt) {
  if (pt.tipo === 'dia_fijo') {
    const y = Number(fechaFactura.slice(0, 4)), m = Number(fechaFactura.slice(5, 7)) - 1 + pt.meses;
    const ult = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return iso(Date.UTC(y, m, Math.min(pt.dia, ult)));
  }
  return iso(new Date(fechaFactura + 'T12:00:00Z').getTime() + pt.dias * DIA);
}

async function prevision({ dias = 45, hoy = new Date() } = {}) {
  const gs = await require('./cuentasProveedor').grupos({ desde: '2025-01-01' });
  const hoyIso = iso(hoy), hasta = iso(hoy.getTime() + dias * DIA);
  const out = [];
  for (const g of gs) {
    const pend = g.facturas.filter(f => f.estado === 'pendiente' || f.estado === 'parcial');
    if (!pend.length) continue;
    const pt = patron(g.facturas);
    for (const f of pend) {
      const fecha = fechaPrevista(f.fecha, pt);
      if (fecha > hasta) continue;
      out.push({ proveedor: g.proveedor, factura: f.refProveedor || f.numero, numero: f.numero, fechaFactura: f.fecha, importe: f.pendiente, fecha, vencida: fecha < hoyIso,
        como: pt.tipo === 'dia_fijo' ? `suele cargar el día ${pt.dia}${pt.meses ? ` (${pt.meses} mes${pt.meses > 1 ? 'es' : ''} después)` : ''}` : pt.tipo === 'dias' ? `suele pagarse a ${pt.dias} días` : 'sin historial: a 30 días' });
    }
  }
  out.sort((a, b) => a.fecha.localeCompare(b.fecha) || b.importe - a.importe);
  const vencidas = out.filter(x => x.vencida), proximas = out.filter(x => !x.vencida);
  return { hoy: hoyIso, vencidas, proximas, totales: { vencido: r2(vencidas.reduce((a, x) => a + x.importe, 0)), proximos30: r2(proximas.filter(x => x.fecha <= iso(hoy.getTime() + 30 * DIA)).reduce((a, x) => a + x.importe, 0)) } };
}

// WhatsApp de la mañana: lo que se carga en los próximos 3 días (y los lunes, las 2 próximas semanas).
async function avisoManana({ hoy = new Date(), dryRun = false, _enviar = null } = {}) {
  const p = await prevision({ dias: 14, hoy });
  const lunes = hoy.getUTCDay() === 1;
  const lim = iso(hoy.getTime() + (lunes ? 14 : 3) * DIA);
  const ls = p.proximas.filter(x => x.fecha <= lim && x.importe >= 50);
  if (!ls.length) return { enviado: false };
  const porDia = {};
  ls.forEach(x => { (porDia[x.fecha] = porDia[x.fecha] || []).push(x); });
  const txt = `📅 *Pagos a proveedores* ${lunes ? 'de las próximas 2 semanas' : 'de los próximos días'} (${eur(ls.reduce((a, x) => a + x.importe, 0))})\n\n` +
    Object.entries(porDia).map(([f, xs]) => `*${f.split('-').reverse().slice(0, 2).join('/')}*: ${xs.map(x => `${x.proveedor.split(/[ ,]/)[0]} ${eur(x.importe)}`).join(' · ')}`).join('\n') +
    (p.totales.vencido > 0.01 ? `\n\n⚠️ Además hay ${eur(p.totales.vencido)} vencidos sin pagar (Compras → Cuentas).` : '');
  if (dryRun) return { enviado: false, texto: txt };
  const enviar = _enviar || (async (to, t) => require('./notifications').sendWhatsAppTo(to, t));
  const dest = String(process.env.BANCO_AVISOS_TO || process.env.FICHAJE_AVISOS_TO || process.env.WHATSAPP_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  let n = 0; for (const to of dest) { try { if (await enviar(to, txt) !== false) n++; } catch (e) { console.warn('[Vencimientos]', e.message); } }
  return { enviado: n > 0, texto: txt };
}

module.exports = { prevision, avisoManana, patron, fechaPrevista };
