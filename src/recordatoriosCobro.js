// src/recordatoriosCobro.js — Recordatorios de cobro A CLIENTES, siempre con el sí de Álex (8/10/2026).
//
// Cada factura vencida y sin cobrar «toca» recordarla al cumplir 7, 15, 30, 45, 60 y 90 días de vencida (una vez
// por escalón). El sistema prepara el texto (más amable al principio, más firme después) y Álex lo revisa en
// /cobrar: lo envía por email (desde el correo de la empresa) o por WhatsApp desde Corpy con un toque (o lo abre en
// su móvil y lo manda él). Nada sale solo. El texto lleva el enlace al PDF de la factura. El móvil/email del cliente
// sale de StelOrder o de lo apuntado en el dashboard (clientesContacto, manda eso). Si el cliente contesta al WhatsApp
// de Corpy, la respuesta se apunta en la factura y se reenvía a Álex (respuestaCliente). Cada mañana (L-V) le llega un WhatsApp con cuántos hay por revisar.
//
// Lo que NO se propone: facturas que «saltó», clientes en pausa, y las familias que ya reciben recordatorios
// automáticos por email (Ajustes → Alertas, modo cliente) salen marcadas para no repetir.
//
// NOTAS Y PROMESAS DE PAGO: en cada factura se apunta lo que ha dicho el cliente («pagará el 20», «espera la
// derrama»…) con la fecha prometida. Hasta esa fecha no se le propone recordatorio; ese día sale en el WhatsApp de
// la mañana («hoy tiene que pagar…») y, si pasa sin cobrarse, el recordatorio le recuerda lo que dijo.
'use strict';
async function getDB() { return require('./db').getDB(); }
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const COL = 'recordatoriosCobro', PAUSAS = 'recordatoriosCobroPausa';
const PASOS = [7, 15, 30, 45, 60, 90];
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const eur = n => (Number(n) || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' }) + ' €';
const fd = d => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');
const TEL_EMPRESA = '674 013 723';

// Móvil español → +34XXXXXXXXX (solo móviles: a un fijo no se le puede escribir por WhatsApp).
function movil(tel) {
  const d = String(tel || '').replace(/\D/g, '').replace(/^0034/, '').replace(/^34(?=[67]\d{8}$)/, '');
  return /^[67]\d{8}$/.test(d) ? '+34' + d : null;
}
const pasoDe = dias => PASOS.filter(p => dias >= p).pop() || null;

// IBAN de la cuenta principal (Santander, no la de reserva), para poner en el recordatorio dónde pagar.
async function ibanCobro(db) {
  try {
    const conns = await db.collection('bancoConexiones').find({ estado: 'activa' }).toArray();
    const reserva = process.env.RESERVA_IBAN || '6452';
    for (const c of conns) for (const a of c.cuentas || []) {
      const iban = String(a.iban || '').replace(/\s/g, '');
      if (/^ES\d{22}$/.test(iban) && !iban.endsWith(reserva) && /santander/i.test(c.banco || '')) return iban.replace(/(.{4})/g, '$1 ').trim();
    }
  } catch (e) {}
  return process.env.IBAN_COBRO || null;
}

// El texto para el cliente según el escalón (días de vencida).
function texto(f, paso, iban, promesa) {
  const base = `la factura ${f.numero} del ${fd(f.fecha)}, de ${eur(f.pendiente)}${f.pagado > 0.01 ? ` (pendiente de un total de ${eur(f.total)})` : ''}`;
  const pago = (f.pdfPath ? `\n\nPuede ver la factura aquí: ${f.pdfPath}` : '') + (iban ? `\n\nPuede hacer la transferencia a ${iban} indicando el número de factura.` : '');
  const hola = f.persona ? `Buenos días, ${String(f.persona).split(/\s+/)[0]}:` : 'Buenos días:';
  const firma = `\n\nMuchas gracias,\nCorp Projects · ${TEL_EMPRESA}`;
  if (promesa && promesa.fecha) return `${hola}\n\nLe escribimos de Corp Projects por ${base}. Nos indicó que la abonaría el ${fd(promesa.fecha)} y todavía no nos ha llegado. ¿Nos puede confirmar cuándo podrá hacerlo? Si ya la ha pagado, envíenos el justificante y lo comprobamos.${pago}${firma}`;
  if (paso <= 7) return `${hola}\n\nLe escribimos de Corp Projects para recordarle que ${base} venció el ${fd(f.vence)} y nos consta pendiente de pago. Si ya la ha abonado, disculpe y no tenga en cuenta este mensaje.${pago}${firma}`;
  if (paso <= 30) return `${hola}\n\nLe volvemos a escribir de Corp Projects porque ${base} sigue pendiente de pago (venció el ${fd(f.vence)}). ¿Nos podría indicar cuándo tiene previsto abonarla? Si ya la ha pagado, envíenos el justificante y lo comprobamos.${pago}${firma}`;
  return `${hola}\n\n${base.charAt(0).toUpperCase() + base.slice(1)} lleva ${f.dias} días vencida. Le agradeceríamos que la regularizara esta semana o que nos llame al ${TEL_EMPRESA} para hablarlo y buscar una solución.${pago}${firma}`;
}
const asunto = (f, paso) => (paso <= 7 ? `Recordatorio: factura ${f.numero} pendiente` : paso <= 30 ? `Factura ${f.numero} pendiente de pago` : `Factura ${f.numero}: pago vencido hace ${f.dias} días`);

async function propuestas({ hoy = new Date() } = {}) {
  const S = require('./stelorder'), avisos = require('./avisos');
  const db = await getDB();
  const CC = require('./clientesContacto');
  const [pend, cl, hechos, pausas, iban, contactos] = await Promise.all([
    S.getPendingInvoices(), S.getClients().catch(() => ({ clientMap: {} })),
    db.collection(COL).find({}).toArray(), db.collection(PAUSAS).find({}).toArray(), ibanCobro(db), CC.mapa().catch(() => ({})),
  ]);
  const porId = {}; hechos.forEach(h => { porId[String(h._id)] = h; });
  const pausados = new Set(pausas.map(p => p._id));
  const famCfg = {};
  const out = [], promesas = [], hoyPagan = [], incumplidas = [], todas = [];
  for (const inv of pend) {
    const dias = Math.max(0, Math.floor((hoy - new Date(inv.dueDate || inv.date || hoy)) / 86400000));
    if (inv.pending < 1) continue;
    const paso0 = pasoDe(dias);
    const h = porId[String(inv.id)] || {};
    const ov = CC.de(contactos, { accountId: inv.accountId, cliente: inv.client }) || {};
    const c = (cl.clientMap || {})[String(inv.accountId)] || {};
    const email = ov.email || inv.clientEmail || c.email || null, tel = ov.telefono || c.phone || null, wa = movil(tel);
    todas.push({ id: String(inv.id), numero: inv.number, cliente: inv.client, accountId: inv.accountId || null, conWhatsapp: !!wa, conEmail: !!email, fecha: inv.date, vence: inv.dueDate || inv.date, pendiente: r2(inv.pending), dias, notas: (h.notas || []).slice(-3), promesa: h.promesa || null, saltada: !!h.saltar, ultimoEnviado: (h.enviados || []).slice(-1)[0] || null });
    const promesa = h.promesa && h.promesa.fecha ? h.promesa : null;
    const hoyIso = hoy.toISOString().slice(0, 10);
    if (promesa) {
      const fila = { id: String(inv.id), numero: inv.number, cliente: inv.client, pendiente: r2(inv.pending), fechaPromesa: promesa.fecha, nota: promesa.nota || '', dias };
      if (promesa.fecha > hoyIso) { promesas.push(fila); continue; }               // aún no toca: no se le molesta
      if (promesa.fecha === hoyIso) { promesas.push(fila); hoyPagan.push(fila); continue; }
      incumplidas.push(fila);                                                      // pasó la fecha sin cobrarse
    }
    if (h.saltar || pausados.has(norm(inv.client))) continue;
    const ultimo = Math.max(0, ...(h.enviados || []).map(e => e.paso));
    // Promesa incumplida: toca recordar aunque no esté en un escalón nuevo (una vez por promesa).
    const tocaPromesa = promesa && !(h.enviados || []).some(e => e.promesa === promesa.fecha);
    const paso = tocaPromesa ? Math.max(paso0 || 0, ultimo + 1) : paso0;
    if (!paso || (!tocaPromesa && ultimo >= paso)) continue;
    if (!(inv.family in famCfg)) { try { famCfg[inv.family] = await avisos.getFamilyConfig(inv.family); } catch (e) { famCfg[inv.family] = null; } }
    const cfg = famCfg[inv.family];
    const f = { id: String(inv.id), numero: inv.number, cliente: inv.client, accountId: inv.accountId || null, familia: inv.family, fecha: inv.date, vence: inv.dueDate || inv.date, total: r2(inv.total), pagado: r2(inv.paid), pendiente: r2(inv.pending), dias, pdfPath: inv.pdfPath || null, persona: ov.persona || null };
    out.push({ ...f, paso, email, telefono: tel, whatsapp: wa, contactoApuntado: !!(ov.telefono || ov.email), asunto: asunto(f, paso), texto: texto(f, paso, iban, tocaPromesa ? promesa : null),
      promesaIncumplida: tocaPromesa ? promesa : null, notas: (h.notas || []).slice(-5),
      ultimoEnviado: (h.enviados || []).slice(-1)[0] || null,
      yaPorEmail: !!(cfg && !cfg.paused && (cfg.modo === 'cliente' || cfg.email) && cfg.freq !== 'manual') });
  }
  out.sort((a, b) => b.dias - a.dias || b.pendiente - a.pendiente);
  promesas.sort((a, b) => a.fechaPromesa.localeCompare(b.fechaPromesa));
  return { hoy: hoy.toISOString().slice(0, 10), iban, propuestas: out, total: r2(out.reduce((a, x) => a + x.pendiente, 0)), promesas, hoyPagan, incumplidas, todas: todas.sort((a, b) => b.dias - a.dias || b.pendiente - a.pendiente) };
}

async function marcar(invoiceId, { paso, canal, por, nota, promesa, a = null, numero = null, cliente = null } = {}) {
  const db = await getDB();
  await db.collection(COL).updateOne({ _id: String(invoiceId) }, { $push: { enviados: { paso: Number(paso) || 0, canal: canal || 'otro', por: por || '', nota: nota || null, promesa: promesa || null, a, at: new Date() } }, ...(numero ? { $set: { numero, cliente } } : {}) }, { upsert: true });
  return { ok: true };
}
// Apuntar lo que ha dicho el cliente. fechaPago (AAAA-MM-DD) = lo que ha prometido; sin fecha, solo la nota.
async function apuntar(invoiceId, { texto: t, fechaPago, por, numero, cliente } = {}) {
  const db = await getDB();
  const nota = String(t || '').trim().slice(0, 500);
  const f = /^\d{4}-\d{2}-\d{2}$/.test(String(fechaPago || '')) ? fechaPago : null;
  if (!nota && !f) throw new Error('Escribe qué te ha dicho o la fecha en que pagará');
  const set = { numero: numero || null, cliente: cliente || null };
  if (f) set.promesa = { fecha: f, nota, por: por || '', at: new Date() };
  await db.collection(COL).updateOne({ _id: String(invoiceId) }, { $push: { notas: { texto: nota, fechaPago: f, por: por || '', at: new Date() } }, $set: set }, { upsert: true });
  return { ok: true };
}
async function quitarPromesa(invoiceId) {
  const db = await getDB();
  await db.collection(COL).updateOne({ _id: String(invoiceId) }, { $unset: { promesa: '' } });
  return { ok: true };
}
// Notas de varias facturas (para enseñarlas en «Pendientes de cobro»).
async function notasDe(ids) {
  const db = await getDB();
  const ds = await db.collection(COL).find({ _id: { $in: (ids || []).map(String) } }).project({ notas: { $slice: -3 }, promesa: 1 }).toArray();
  return Object.fromEntries(ds.map(d => [String(d._id), { notas: d.notas || [], promesa: d.promesa || null }]));
}
async function saltar(invoiceId, por) {
  const db = await getDB();
  await db.collection(COL).updateOne({ _id: String(invoiceId) }, { $set: { saltar: true, saltadoPor: por || '', saltadoAt: new Date() } }, { upsert: true });
  return { ok: true };
}
async function pausarCliente(cliente, pausa = true, por) {
  const db = await getDB();
  if (pausa) await db.collection(PAUSAS).updateOne({ _id: norm(cliente) }, { $set: { cliente, por: por || '', at: new Date() } }, { upsert: true });
  else await db.collection(PAUSAS).deleteOne({ _id: norm(cliente) });
  return { ok: true };
}
// Envío por email desde el correo de la empresa, con el texto que Álex haya revisado (o el propuesto).
async function enviarEmail(invoiceId, { texto: txt, asunto: asu, por } = {}) {
  const { propuestas: ps } = await propuestas();
  const p = ps.find(x => x.id === String(invoiceId));
  if (!p) throw new Error('Esa factura ya no está pendiente de recordar');
  if (!p.email) throw new Error('El cliente no tiene email: apúntaselo en «Clientes sin contacto»');
  const cuerpo = String(txt || p.texto).slice(0, 4000);
  const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const ok = await require('./notifications').sendEmail({ to: p.email, subject: String(asu || p.asunto).slice(0, 160), text: cuerpo, html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;white-space:pre-line">${esc(cuerpo)}</div>` });
  if (!ok) throw new Error('No se pudo enviar el email');
  await marcar(invoiceId, { paso: p.paso, canal: 'email', por, promesa: p.promesaIncumplida ? p.promesaIncumplida.fecha : null, a: p.email, numero: p.numero, cliente: p.cliente });
  return { ok: true, a: p.email };
}

// Envío por WhatsApp desde Corpy (el número del sistema), con el texto revisado. Si contesta, ver respuestaCliente.
async function enviarWhatsApp(invoiceId, { texto: txt, por, _enviar = null } = {}) {
  const { propuestas: ps } = await propuestas();
  const p = ps.find(x => x.id === String(invoiceId));
  if (!p) throw new Error('Esa factura ya no está pendiente de recordar');
  if (!p.whatsapp) throw new Error('El cliente no tiene móvil: apúntaselo en «Clientes sin contacto»');
  const cuerpo = String(txt || p.texto).slice(0, 4000);
  const ok = await (_enviar || require('./notifications').sendWhatsAppTo)(p.whatsapp, cuerpo);
  if (ok === false) throw new Error('No se pudo enviar el WhatsApp (mira que Corpy esté conectado)');
  await marcar(invoiceId, { paso: p.paso, canal: 'whatsapp_corpy', por, promesa: p.promesaIncumplida ? p.promesaIncumplida.fecha : null, a: p.whatsapp, numero: p.numero, cliente: p.cliente });
  return { ok: true, a: p.whatsapp };
}

// Un número que Corpy no conoce escribe: si es un cliente al que le mandamos un recordatorio los últimos 45 días,
// (10 si ya es un cliente conocido) se apunta lo que dice en su factura y se le pasa a Álex. Devuelve la respuesta para el cliente, o null si no es eso.
async function respuestaCliente(numero, txt, { hoy = new Date(), dias = 45, _enviar = null } = {}) {
  const tel = movil(numero);
  if (!tel) return null;
  const db = await getDB();
  const desde = hoy.getTime() - dias * 86400000;
  const docs = (await db.collection(COL).find({ 'enviados.a': tel }).toArray())
    .map(d => ({ d, e: (d.enviados || []).filter(e => e.a === tel && new Date(e.at).getTime() >= desde).pop() }))
    .filter(x => x.e).sort((a, b) => new Date(b.e.at) - new Date(a.e.at));
  if (!docs.length) return null;
  const { d } = docs[0];
  const dicho = String(txt || '').trim().slice(0, 500) || '(foto o audio)';
  await apuntar(d._id, { texto: `Contestó por WhatsApp: «${dicho}»`, por: 'cliente (WhatsApp)', numero: d.numero, cliente: d.cliente });
  const url = `${process.env.DASHBOARD_URL || 'https://dashboard.corpprojects.es'}/cobrar`;
  try { await (_enviar || require('./notifications').sendWhatsApp)(`💬 *${d.cliente || tel}* ha contestado al recordatorio de ${d.numero || 'su factura'}:\n«${dicho.slice(0, 300)}»\n\nSi dice cuándo paga, apúntalo con la fecha y ese día te lo recuerdo: ${url}`); } catch (e) {}
  return 'Gracias por su respuesta. Se lo pasamos a la oficina de Corp Projects y le contestaremos lo antes posible.';
}

// WhatsApp de la mañana a Álex: cuántos recordatorios hay por revisar (solo si hay alguno, una vez al día).
async function avisoManana({ hoy = new Date(), _enviar = null } = {}) {
  const avisos = require('./avisos');
  const dia = hoy.toISOString().slice(0, 10);
  if (await avisos.wasAlertSentToday('recordatorios-cobro', dia)) return { enviado: false, motivo: 'ya enviado hoy' };
  const { propuestas: ps, hoyPagan, incumplidas } = await propuestas({ hoy });
  const nuevos = ps.filter(p => !p.yaPorEmail);
  const ayer = new Date(hoy.getTime() - 86400000).toISOString().slice(0, 10);
  const recien = incumplidas.filter(p => p.fechaPromesa >= ayer);   // solo el día siguiente; luego siguen en /cobrar
  if (!nuevos.length && !hoyPagan.length && !recien.length) return { enviado: false };
  const url = `${process.env.DASHBOARD_URL || 'https://dashboard.corpprojects.es'}/cobrar`;
  const linea = p => `• ${p.cliente} · ${p.numero} · ${eur(p.pendiente)}${p.nota ? ` — «${p.nota.slice(0, 60)}»` : ''}`;
  const partes = [];
  if (hoyPagan.length) partes.push(`📅 *Hoy dijeron que pagan:*\n${hoyPagan.map(linea).join('\n')}`);
  if (recien.length) partes.push(`⚠️ *Dijeron que pagaban y no ha llegado:*\n${recien.map(p => linea(p) + ` (prometido el ${fd(p.fechaPromesa)})`).join('\n')}`);
  const sinContacto = nuevos.filter(p => !p.whatsapp && !p.email).length;
  if (nuevos.length) partes.push(`💶 *Recordatorios por revisar: ${nuevos.length}* (${eur(nuevos.reduce((a, x) => a + x.pendiente, 0))})\n${nuevos.slice(0, 5).map(p => `• ${p.cliente} · ${p.numero} · ${eur(p.pendiente)} (${p.dias} d)`).join('\n')}${nuevos.length > 5 ? `\n…y ${nuevos.length - 5} más` : ''}${sinContacto ? `\n(${sinContacto} sin móvil ni email: apúntaselos y se les podrá enviar)` : ''}`);
  const txt = `${partes.join('\n\n')}\n\nRevísalo y envía los recordatorios con un toque: ${url}`;
  const ok = await (_enviar || require('./notifications').sendWhatsApp)(txt);
  if (ok !== false) await avisos.markAlertSent('recordatorios-cobro', dia);
  return { enviado: ok !== false, n: nuevos.length, texto: txt };
}

module.exports = { propuestas, marcar, saltar, pausarCliente, enviarEmail, enviarWhatsApp, respuestaCliente, avisoManana, apuntar, quitarPromesa, notasDe, _movil: movil, _pasoDe: pasoDe, _texto: texto, PASOS };
