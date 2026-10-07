// src/avisoPagos.js — Resumen por WhatsApp de lo que acaba de entrar del banco (a Álex y oficina).
//
// Tras cada lectura del banco (bancoSync) con movimientos nuevos, UN mensaje corto:
//   · cobros uno a uno: de quién, qué factura(s) paga y, si es parcial, cuánto falta;
//   · pagos de 300 € o más (o parciales) uno a uno; el resto, sumados en una línea;
//   · compras con tarjeta en una sola línea (los tickets ya los pide ticketsAviso a cada uno).
// Sin movimientos nuevos no se manda nada. Destinatarios: BANCO_AVISOS_TO (o FICHAJE_AVISOS_TO / WHATSAPP_TO).
'use strict';
const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const eur = n => Math.abs(Number(n) || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' }) + ' €';
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const GRANDE = Number(process.env.AVISO_PAGOS_MIN) || 300;
function destinos() { return String(process.env.BANCO_AVISOS_TO || process.env.FICHAJE_AVISOS_TO || process.env.WHATSAPP_TO || '').split(',').map(s => s.trim().replace(/^whatsapp:/i, '')).filter(Boolean); }

// Una línea por movimiento con lo que dice el cuadre.
function linea(m, pm) {
  const quien = require('./trimestre').comercio(m.concepto);
  const docs = (pm && pm.docs) || [];
  if (pm && pm.estado === 'punteado' && docs.length) {
    const suma = r2(docs.reduce((a, d) => a + Math.abs(Number(d.total) || 0), 0));
    const falta = r2(suma - Math.abs(m.importe));
    const refs = docs.map(d => d.ref || d.refProveedor).filter(Boolean).join(' + ');
    if (falta > 0.02) return { ok: 'parcial', txt: `🟡 ${eur(m.importe)} · ${quien} → ${refs} · *falta ${eur(falta)}*` };
    if (falta < -0.02) return { ok: 'si', txt: `✅ ${eur(m.importe)} · ${quien} → ${refs} (${eur(-falta)} de más)` };
    return { ok: 'si', txt: `✅ ${eur(m.importe)} · ${quien} → ${refs}` };
  }
  if (pm && pm.estado === 'no_requiere') return { ok: 'no', txt: `▫️ ${eur(m.importe)} · ${quien}${pm.nota ? ' (' + pm.nota.slice(0, 50) + ')' : ''}` };
  return { ok: 'falta', txt: `❓ ${eur(m.importe)} · ${quien} → sin factura` };
}

async function resumen(nuevos, { hoy = new Date() } = {}) {
  if (!nuevos || !nuevos.length) return null;
  const db = await getDB();
  const T = require('./trimestre');
  T.olvidarMapaPagos();
  const mapa = await T.mapaPagos();
  const ids = col => nuevos.filter(n => n.col === col).map(n => { try { return new ObjectId(String(n.id)); } catch (e) { return null; } }).filter(Boolean);
  const [bm, tm] = await Promise.all([
    db.collection('bancoMovimientos').find({ _id: { $in: ids('bancoMovimientos') } }).toArray(),
    db.collection('tarjetaMovimientos').find({ _id: { $in: ids('tarjetaMovimientos') } }).toArray(),
  ]);
  const movs = [
    ...bm.map(m => ({ id: String(m._id), fecha: m.fechaOperacion, importe: m.importe, concepto: m.concepto, tarjeta: /tarj/i.test(m.concepto || '') })),
    ...tm.filter(m => !m.interno).map(m => ({ id: String(m._id), fecha: m.fecha, importe: m.importe, concepto: m.concepto, tarjeta: ['CARD_PAYMENT', 'CARD_REFUND'].includes(m.tipo) })),
  ].sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
  if (!movs.length) return null;
  const cobros = movs.filter(m => m.importe > 0 && !m.tarjeta);
  const pagos = movs.filter(m => m.importe < 0 && !m.tarjeta);
  const tarjeta = movs.filter(m => m.tarjeta && m.importe < 0);
  const out = [];
  if (cobros.length) { out.push(`*Cobros* (${cobros.length} · ${eur(cobros.reduce((a, m) => a + m.importe, 0))})`); cobros.forEach(m => out.push(linea(m, mapa.porMov.get(m.id)).txt)); }
  if (pagos.length) {
    const ls = pagos.map(m => ({ m, l: linea(m, mapa.porMov.get(m.id)) }));
    // A cada pago a un proveedor se le añade lo que aún le debemos (cuentasProveedor).
    try { require('./cuentasProveedor').olvidar(); } catch (e) {}
    for (const x of ls) {
      const pm = mapa.porMov.get(x.m.id); const ter = pm && pm.docs && pm.docs[0] && pm.docs[0].tercero;
      if (!ter || !(Math.abs(x.m.importe) >= GRANDE || x.l.ok === 'parcial')) continue;
      const d = await require('./cuentasProveedor').deuda(ter).catch(() => null);
      if (d) x.l.txt += d.pendiente > 0.01 ? ` · aún le debemos ${eur(d.pendiente)} (${d.nPendientes} fra.)` : ' · al día';
    }
    // Transferencias a trabajadores: cómo queda su nómina (nominasPagos), aunque sean pequeñas.
    for (const x of ls) {
      const pm = mapa.porMov.get(x.m.id);
      if (pm && pm.estado === 'punteado') continue;
      const nl = await require('./nominasPagos').lineaPago(x.m.concepto, x.m.fecha).catch(() => null);
      if (nl) { x.l.txt += ` · ${nl}`; x.nomina = true; }
    }
    const uno = ls.filter(x => Math.abs(x.m.importe) >= GRANDE || x.l.ok === 'parcial' || x.nomina);
    const resto = ls.filter(x => !uno.includes(x));
    out.push(`${out.length ? '\n' : ''}*Pagos* (${pagos.length} · ${eur(pagos.reduce((a, m) => a + m.importe, 0))})`);
    uno.forEach(x => out.push(x.l.txt));
    if (resto.length) out.push(`${uno.length ? '… y ' : ''}${resto.length} pago${resto.length === 1 ? '' : 's'} ${uno.length ? 'más ' : ''}de menos de ${GRANDE} € (${eur(resto.reduce((a, x) => a + x.m.importe, 0))}): ${resto.filter(x => x.l.ok === 'si').length} con factura${resto.some(x => x.l.ok === 'falta') ? `, ${resto.filter(x => x.l.ok === 'falta').length} sin` : ''}`);
  }
  if (tarjeta.length) {
    const con = tarjeta.filter(m => { const pm = mapa.porMov.get(m.id); return pm && (pm.estado === 'punteado' || pm.estado === 'no_requiere'); }).length;
    out.push(`${out.length ? '\n' : ''}💳 Compras con tarjeta: ${tarjeta.length} (${eur(tarjeta.reduce((a, m) => a + m.importe, 0))}), ${con} ya con factura; el resto se le pide a cada uno.`);
  }
  const hora = hoy.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });
  return `🏦 *Banco* · lectura de las ${hora}\n\n${out.join('\n')}`;
}

async function avisar(nuevos, { dryRun = false, _enviar = null, hoy = new Date() } = {}) {
  const txt = await resumen(nuevos, { hoy });
  if (!txt) return { enviado: false };
  if (dryRun) return { enviado: false, texto: txt };
  const enviar = _enviar || (async (to, t) => require('./notifications').sendWhatsAppTo(to, t));
  let n = 0;
  for (const to of destinos()) { try { if (await enviar(to, txt) !== false) n++; } catch (e) { console.warn('[AvisoPagos]', e.message); } }
  return { enviado: n > 0, a: n, texto: txt };
}

// Factura de proveedor que llega por correo (email-intelligence): «llega la 0017 de Rubén por 320 €; con esta le
// debemos X». Si ya está pagada (con tarjeta, o casada con el banco), no se avisa.
async function facturaLlegada(compraIds, { dryRun = false, _enviar = null } = {}) {
  const C = require('./compras');
  const T = require('./trimestre'); T.olvidarMapaPagos();
  const CP = require('./cuentasProveedor'); CP.olvidar();
  const lineas = [];
  for (const id of compraIds || []) {
    let c = null; try { c = await C.getCompra(id); } catch (e) { continue; }
    if (!c || c.tipo !== 'factura' || !(c.ia && c.ia.ok) || c.duplicadoDe || !c.proveedor || c.total == null) continue;
    const d = await CP.deuda(c.razonSocial || c.proveedor) || await CP.deuda(c.proveedor);
    if (d) {
      const cuenta = await CP.cuenta(d.proveedor).catch(() => null);
      const esta = cuenta && cuenta.facturas.find(f => (f.refProveedor || f.numero) && String(f.refProveedor || f.numero).replace(/\D/g, '').endsWith(String(c.numero || '').replace(/\D/g, '').slice(-5)));
      if (esta && esta.estado === 'pagada') continue;            // ya pagada (tarjeta, recibo…): nada que avisar
    }
    lineas.push(`📥 *${c.proveedor}* · factura ${c.numero || 's/n'} de *${eur(c.total)}*${c.fecha ? ' (' + c.fecha.split('-').reverse().join('/') + ')' : ''}` +
      (d ? (d.pendiente > 0.01 ? `\n   Con esta le debemos *${eur(d.pendiente)}* (${d.nPendientes} factura${d.nPendientes === 1 ? '' : 's'} sin pagar)` : '\n   Con esta, al día') : ''));
  }
  if (!lineas.length) return { enviado: false };
  const txt = lineas.join('\n');
  if (dryRun) return { enviado: false, texto: txt };
  const enviar = _enviar || (async (to, t) => require('./notifications').sendWhatsAppTo(to, t));
  let n = 0; for (const to of destinos()) { try { if (await enviar(to, txt) !== false) n++; } catch (e) { console.warn('[AvisoPagos] factura:', e.message); } }
  return { enviado: n > 0, texto: txt };
}

module.exports = { resumen, avisar, linea, facturaLlegada };
