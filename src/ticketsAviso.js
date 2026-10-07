// src/ticketsAviso.js — Ticket o factura de cada compra con tarjeta, AL MOMENTO (para que no se pierdan).
//
// Cuando el banco trae un pago con tarjeta (Revolut, o la tarjeta de Santander) que no tiene todavía su ticket
// o factura, quien lleva esa tarjeta recibe un WhatsApp con su enlace directo para subir la foto:
//   «🧾 David, hemos visto un pago con tu tarjeta …6439: Obramat · 116,01 € (hoy). Sube aquí el ticket: <enlace>»
// Cada mañana (9:30, L-S) se le recuerda lo que siga faltando de los últimos 30 días, hasta que esté.
// Desde el enlace también puede decir «era personal» o «no tengo ticket» (lo verá oficina).
//
// Quién lleva cada tarjeta: colección `tarjetas` (persona y userId, se elige en Cierre del trimestre).
// Lo que ya tiene documento (Compras, StelOrder o punteado a mano) o no lo necesita no se pide.
//
//   ticketAvisos { _id: movId, userId, persona, tarjeta, fecha, importe, comercio, primeroAt, ultimoAt,
//                  recordatorios, respuesta: null|'personal'|'sin_ticket', compraId, resueltoAt }
'use strict';
const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const BASE_URL = (process.env.PUBLIC_URL || 'https://dashboard.corpprojects.es').replace(/\/+$/, '');
const DIA = 86400000;
const iso = d => new Date(d).toISOString().slice(0, 10);
const nrm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const eur = n => Math.abs(Number(n) || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const _tel = t => { const d = String(t || '').replace(/\D/g, ''); if (!d) return null; return d.length === 9 ? '+34' + d : '+' + d.replace(/^00/, ''); };
const fechaTxt = (f, hoy = new Date()) => f === iso(hoy) ? 'hoy' : f === iso(hoy.getTime() - DIA) ? 'ayer' : f.split('-').reverse().slice(0, 2).join('/');
// No llevan ticket que pedir a nadie (se resuelven en el cierre): parking por app, peajes.
const SIN_TICKET = /estacioname|easypark|telpark|elparking|peaje|autopista|parking app/;
// Facturan una vez al mes todo lo pagado con tarjeta (la gasolina de Esclat, Feixas): no se pide ticket de cada pago.
const FACTURA_MES = /bon ?preu|esclat|feixas aulet/;
const CIF = process.env.EMPRESA_CIF || 'B09899253';

// Pagos con tarjeta de los últimos `dias` (Revolut y tarjetas por su lado; la de Santander va en la cuenta: «Tarj. :*907925»).
async function _pagos(db, dias, hoy) {
  const desde = iso(hoy.getTime() - dias * DIA);
  const [tm, bm] = await Promise.all([
    db.collection('tarjetaMovimientos').find({ fecha: { $gte: desde }, importe: { $lt: 0 }, tipo: 'CARD_PAYMENT', interno: { $ne: true } }).toArray(),
    db.collection('bancoMovimientos').find({ fechaOperacion: { $gte: desde }, importe: { $lt: 0 }, concepto: { $regex: 'tarj', $options: 'i' } }).toArray(),
  ]);
  const comercio = c => require('./trimestre').comercio(c);
  return [
    ...tm.filter(m => !/declined|reverted|failed/i.test(m.estado || '')).map(m => ({ id: String(m._id), fecha: m.fecha, importe: m.importe, concepto: m.concepto, comercio: comercio(m.concepto), tarjeta: m.tarjeta || null })),
    ...bm.map(m => { const t = /\*\s*\d*?(\d{4})\b/.exec(m.concepto || ''); return { id: String(m._id), fecha: m.fechaOperacion, importe: m.importe, concepto: m.concepto, comercio: comercio(m.concepto), tarjeta: t ? t[1] : null }; }),
  ].filter(p => p.tarjeta && !SIN_TICKET.test(nrm(p.concepto)) && !FACTURA_MES.test(nrm(p.concepto)));
}
// La persona de la tarjeta: la elegida en Cierre del trimestre (userId) o, si no, la única con ese nombre y teléfono.
function _quien(tarjetas, users, last4) {
  const t = tarjetas.find(x => String(x._id) === String(last4));
  if (!t) return null;
  let u = t.userId ? users.find(x => String(x._id) === String(t.userId)) : null;
  if (!u && t.persona) { const p = nrm(t.persona); const c = users.filter(x => nrm(x.name) === p); if (c.length === 1) u = c[0]; }
  return { persona: t.persona || null, user: u || null, tel: u ? _tel(u.whatsapp || u.telefono) : null };
}

// Lo que falta: pagos con tarjeta sin documento, con su persona. `porUsuario` para la página del trabajador.
async function pendientes({ dias = 30, hoy = new Date(), userId = null } = {}) {
  const db = await getDB();
  const [pagos, tarjetas, users, avisos, mapa] = await Promise.all([
    _pagos(db, dias, hoy), db.collection('tarjetas').find({}).toArray(), require('./users').getUsers(false),
    db.collection('ticketAvisos').find({}).toArray(), require('./trimestre').mapaPagos(),
  ]);
  const av = new Map(avisos.map(a => [String(a._id), a]));
  const out = [];
  for (const p of pagos) {
    const pm = mapa.porMov.get(p.id);
    if (pm && (pm.estado === 'punteado' || pm.estado === 'no_requiere')) continue;
    const a = av.get(p.id);
    if (a && (a.compraId || a.respuesta)) continue;           // ya lo subió o contestó
    const q = _quien(tarjetas, users, p.tarjeta);
    if (userId && !(q && q.user && String(q.user._id) === String(userId))) continue;
    out.push({ ...p, persona: q && q.persona, userId: q && q.user ? String(q.user._id) : null, nombre: q && q.user ? q.user.name : null, tel: q && q.tel, aviso: a || null });
  }
  return out.sort((a, b) => b.fecha.localeCompare(a.fecha));
}

async function _enlace(userId, movId) {
  const { token } = await require('./users').ensureMagicToken(String(userId));
  return `${BASE_URL}/compra?t=${token}${movId ? '&mov=' + movId : ''}#tickets`;
}
function textoAviso(nombre, ps, url, { recordatorio = false, hoy = new Date() } = {}) {
  const n = String(nombre || '').trim().split(/\s+/)[0] || '';
  if (ps.length === 1 && !recordatorio) {
    const p = ps[0];
    return `🧾 Hola ${n}, hemos visto un pago con tu tarjeta …${p.tarjeta}: *${p.comercio}* · ${eur(p.importe)} (${fechaTxt(p.fecha, hoy)}).\n\nHaz una foto a la factura y súbela aquí:\n${url}\n\n👉 Pide siempre *factura* a nombre de Corp Projects Holding SL (CIF ${CIF}): el ticket solo no sirve para desgravar el IVA.\nSi era personal o no te dieron nada, dilo ahí mismo. El enlace es solo tuyo.`;
  }
  const lista = ps.slice(0, 8).map(p => `• ${fechaTxt(p.fecha, hoy)} · ${p.comercio} · ${eur(p.importe)}`).join('\n') + (ps.length > 8 ? `\n• … y ${ps.length - 8} más` : '');
  return `🧾 ${recordatorio ? 'Buenos días' : 'Hola'} ${n}, ${recordatorio ? (ps.length === 1 ? 'aún nos falta' : 'aún nos faltan') : 'hemos visto'} ${ps.length} pago${ps.length === 1 ? '' : 's'} con tu tarjeta sin factura:\n${lista}\n\nSube las fotos aquí (o di si era personal o no hay ticket):\n${url}\n\n👉 Pide siempre *factura* a nombre de Corp Projects Holding SL (CIF ${CIF}): el ticket solo no desgrava el IVA.`;
}

// modo 'nuevos': tras cada lectura del banco, lo de los últimos 3 días que aún no se ha pedido.
// modo 'recordatorio': cada mañana, todo lo pendiente de 30 días (una vez al día por persona).
async function avisar({ modo = 'nuevos', hoy = new Date(), dryRun = false, _enviar = null } = {}) {
  const db = await getDB();
  const enviar = _enviar || (async (to, txt) => require('./notifications').sendWhatsAppTo(to, txt));
  const ps = await pendientes({ dias: modo === 'nuevos' ? 3 : 30, hoy });
  const porUser = new Map();
  for (const p of ps) {
    if (!p.userId || !p.tel) continue;
    if (modo === 'nuevos' && p.aviso) continue;
    if (modo === 'recordatorio' && p.aviso && p.aviso.ultimoAt && iso(p.aviso.ultimoAt) === iso(hoy)) continue;
    (porUser.get(p.userId) || porUser.set(p.userId, []).get(p.userId)).push(p);
  }
  const hechos = [];
  for (const [userId, lista] of porUser) {
    const url = await _enlace(userId, lista.length === 1 ? lista[0].id : null);
    const txt = textoAviso(lista[0].nombre, lista, url, { recordatorio: modo === 'recordatorio', hoy });
    if (!dryRun) {
      let ok = false; try { ok = await enviar(lista[0].tel, txt); } catch (e) { console.warn('[Tickets] envío:', e.message); }
      if (ok === false) { hechos.push({ nombre: lista[0].nombre, n: lista.length, error: 'no se pudo enviar' }); continue; }
      for (const p of lista) {
        await db.collection('ticketAvisos').updateOne({ _id: p.id }, {
          $setOnInsert: { userId, persona: p.persona, tarjeta: p.tarjeta, fecha: p.fecha, importe: p.importe, comercio: p.comercio, primeroAt: new Date() },
          $set: { ultimoAt: new Date() }, $inc: { recordatorios: modo === 'recordatorio' ? 1 : 0 },
        }, { upsert: true });
      }
    }
    hechos.push({ nombre: lista[0].nombre, n: lista.length, texto: dryRun ? txt : undefined });
  }
  const sinPersona = ps.filter(p => !p.userId || !p.tel);
  if (hechos.length) console.log(`[Tickets] ${modo}: ${hechos.map(h => `${h.nombre} ${h.n}${h.error ? ' (' + h.error + ')' : ''}`).join(', ')}`);
  return { avisados: hechos, sinPersona: sinPersona.length, tarjetasSinPersona: [...new Set(sinPersona.map(p => p.tarjeta))] };
}

// El trabajador sube el ticket desde su enlace: la compra queda unida a ese pago.
async function alSubir(movId, compraId, por) {
  if (!movId) return null;
  const db = await getDB();
  await require('./trimestre').enlazarCompra(String(movId), String(compraId), por);
  await db.collection('ticketAvisos').updateOne({ _id: String(movId) }, { $set: { compraId: String(compraId), resueltoAt: new Date() } }, { upsert: true });
  return { ok: true };
}
// «Era personal» → se marca como gasto personal en el cierre; «no tengo ticket» → deja de recordarse y lo ve oficina.
async function responder(movId, respuesta, quien) {
  if (!['personal', 'sin_ticket'].includes(respuesta)) throw new Error('Respuesta no válida');
  const db = await getDB();
  const mio = (await pendientes({ dias: 90, userId: quien.userId })).find(p => p.id === String(movId));
  if (!mio) throw new Error('Ese pago ya no está pendiente');
  if (respuesta === 'personal') await require('./trimestre').justificar({ movId: String(movId), decision: 'personal', nota: `Lo dice ${quien.name} desde su enlace`, mov: { persona: mio.persona, concepto: mio.concepto, fecha: mio.fecha, importe: mio.importe }, por: { name: quien.name } });
  await db.collection('ticketAvisos').updateOne({ _id: String(movId) }, { $set: { respuesta, respondidoPor: quien.name, resueltoAt: new Date() } }, { upsert: true });
  return { ok: true };
}

// ── LÍMITE AL MES POR TARJETA ──
// En la tabla de tarjetas se pone el límite (p. ej. 580 €); al pasar del aviso (por defecto 520 €, el 90 %) y al llegar
// al límite, WhatsApp a quien la lleva con lo que lleva gastado. Por debajo no se le dice nada.
async function gastoMes(db, last4, mes) {
  const desde = mes + '-01', hasta = mes + '-31';
  const [tm, bm] = await Promise.all([
    db.collection('tarjetaMovimientos').find({ tarjeta: String(last4), fecha: { $gte: desde, $lte: hasta }, interno: { $ne: true } }).toArray(),
    db.collection('bancoMovimientos').find({ fechaOperacion: { $gte: desde, $lte: hasta }, concepto: { $regex: '\\*\\s*\\d*' + String(last4) + '\\b' } }).toArray(),
  ]);
  const t = tm.filter(m => ['CARD_PAYMENT', 'CARD_REFUND', 'REFUND'].includes(m.tipo) && !/declined|reverted|failed/i.test(m.estado || '')).reduce((a, m) => a - m.importe, 0)
    + bm.reduce((a, m) => a - m.importe, 0);
  return Math.round(t * 100) / 100;
}
async function revisarLimites({ hoy = new Date(), dryRun = false, _enviar = null } = {}) {
  const db = await getDB();
  const enviar = _enviar || (async (to, txt) => require('./notifications').sendWhatsAppTo(to, txt));
  const mes = iso(hoy).slice(0, 7);
  const [tarjetas, users] = await Promise.all([db.collection('tarjetas').find({ limiteMes: { $gt: 0 } }).toArray(), require('./users').getUsers(false)]);
  const out = [];
  for (const t of tarjetas) {
    const gasto = await gastoMes(db, t._id, mes);
    const aviso = Number(t.avisoMes) > 0 ? Number(t.avisoMes) : Math.round(t.limiteMes * 0.9);
    const tramo = gasto >= t.limiteMes ? 'limite' : gasto >= aviso ? 'aviso' : null;
    const hechos = ((t.avisosLimite || {})[mes]) || [];
    out.push({ tarjeta: t._id, persona: t.persona, gasto, limite: t.limiteMes, aviso, tramo });
    if (!tramo || hechos.includes(tramo)) continue;
    const q = _quien(tarjetas, users, t._id);
    if (!q || !q.tel) continue;
    const n = String(q.user.name || '').split(/\s+/)[0];
    const txt = tramo === 'limite'
      ? `💳 ${n}, este mes ya llevas *${eur(gasto)}* con la tarjeta …${t._id}: has llegado al límite de ${eur(t.limiteMes)}. A partir de ahora, solo lo imprescindible de la empresa y nada personal.`
      : `💳 ${n}, este mes llevas *${eur(gasto)}* con la tarjeta …${t._id} (el límite es ${eur(t.limiteMes)}). Ojo, que te queda poco.`;
    if (!dryRun) {
      let ok = false; try { ok = await enviar(q.tel, txt); } catch (e) { console.warn('[Tickets] límite:', e.message); }
      if (ok === false) continue;
      await db.collection('tarjetas').updateOne({ _id: t._id }, { $addToSet: { ['avisosLimite.' + mes]: tramo } });
    }
    out[out.length - 1].texto = txt;
  }
  return out;
}

module.exports = { pendientes, avisar, alSubir, responder, textoAviso, _quien, SIN_TICKET, FACTURA_MES, gastoMes, revisarLimites };
