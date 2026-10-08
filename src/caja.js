// src/caja.js — «¿Cómo vamos de dinero?» para la portada (8/10/2026): la foto real de la caja, para no pensar que
// vamos mal cuando lo que pasa es que nos deben dinero.
//   Nos deben     = facturas emitidas sin cobrar (StelOrder): total, lo ya vencido, lo más antiguo.
//   En el banco   = saldo de hoy de las cuentas conectadas (sin la de reserva, que es para impuestos).
//   A pagar 30 d  = proveedores (previsión por cómo suele cargar cada uno, incluidas las vencidas) + impuestos,
//                   Seguridad Social y nóminas que vencen en 30 días (Reservas), menos lo que ya cubre la reserva.
//   Si se cobrara lo vencido: banco + vencido − a pagar.
'use strict';
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
let _cache = null, _at = 0;

async function resumen({ fresco = false } = {}) {
  if (!fresco && _cache && Date.now() - _at < 10 * 60 * 1000) return _cache;
  const avisos = [];
  const intenta = async (nombre, fn, def) => { try { return await fn(); } catch (e) { avisos.push(`${nombre}: ${e.message}`); return def; } };
  const db = await require('./db').getDB();
  const [pend, conns, prev, res] = await Promise.all([
    intenta('Pendientes de cobro', () => require('./stelorder').getPendingInvoices(), []),
    intenta('Bancos', () => db.collection('bancoConexiones').find({ estado: 'activa' }).toArray(), []),
    intenta('Pagos a proveedores', () => require('./vencimientos').prevision({ dias: 30 }), null),
    intenta('Reservas', () => require('./reservas').panel(), null),
  ]);
  const reserva = process.env.RESERVA_IBAN || '6452';
  const cuentas = conns.flatMap(c => (c.cuentas || []).filter(a => a.saldo != null).map(a => ({ banco: c.banco, fin: a.iban ? String(a.iban).slice(-4) : null, saldo: Number(a.saldo) || 0, reserva: !!(a.iban && String(a.iban).replace(/\s/g, '').endsWith(reserva)) })));
  const banco = r2(cuentas.filter(c => !c.reserva).reduce((a, c) => a + c.saldo, 0));
  const vencidas = pend.filter(p => p.daysOverdue > 0);
  const masAntigua = vencidas.slice().sort((a, b) => b.daysOverdue - a.daysOverdue)[0] || null;
  const proveedores = prev ? r2((prev.totales.vencido || 0) + (prev.totales.proximos30 || 0)) : null;
  // De Reservas: lo que vence en 30 días y aún no cubre la cuenta de reserva.
  const items = res ? (res.items || []).filter(i => !i.error && i.dias != null && i.dias <= 30) : [];
  const impuestos = r2(items.reduce((a, i) => a + (i.falta != null ? i.falta : i.importe || 0), 0));
  const aPagar = r2((proveedores || 0) + impuestos);
  const nosDeben = r2(pend.reduce((a, p) => a + (p.pending || 0), 0)), vencido = r2(vencidas.reduce((a, p) => a + (p.pending || 0), 0));
  _cache = {
    nosDeben, nFacturas: pend.length, vencido, nVencidas: vencidas.length,
    masAntigua: masAntigua ? { cliente: masAntigua.client, numero: masAntigua.number, dias: masAntigua.daysOverdue, importe: r2(masAntigua.pending) } : null,
    banco, cuentas, aPagar, desglosePagar: { proveedores, impuestos: items.map(i => ({ concepto: i.concepto || i.nombre || i.tipo, importe: r2(i.falta != null ? i.falta : i.importe), vence: i.vence })) },
    siCobraraVencido: r2(banco + vencido - aPagar), hoy: banco - aPagar,
    avisos,
  };
  _at = Date.now();
  return _cache;
}

module.exports = { resumen };
