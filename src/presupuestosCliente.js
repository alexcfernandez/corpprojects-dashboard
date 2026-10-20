// src/presupuestosCliente.js — Los presupuestos pendientes de StelOrder, que el administrador acepte o rechace él mismo
// (20/10/2026, Álex: «lo mismo que tenemos para los recordatorios de las facturas por familias, para los presupuestos:
// que se envíe todos los lunes lo pendiente, que vean la vista previa y le den a aceptar o rechazar»).
//
//   · Cada lunes (9:15) a cada familia con «Presupuestos los lunes» activado (Ajustes → Familias) le llega un correo
//     con sus presupuestos en estado Pendiente de los últimos 6 meses. Cada uno lleva su enlace /pr/<token>.
//   · /pr/<token>: el presupuesto (PDF de StelOrder + resumen) y los botones Aceptar / Rechazar (con nombre y, si
//     rechaza, el motivo). Nada se hace con solo abrir el enlace (los antivirus del correo abren los enlaces).
//   · Al responder: cambia el estado en StelOrder (si la escritura está activada), la obra «En estudio» que tenga ese
//     presupuesto pasa a activa, y a Álex y a la oficina les llega un WhatsApp.
//   · No se mandan: los de menos de 3 días (para revisarlos), ni los marcados «No enviar» (colección
//     presupuestosClienteCfg) — los de medidas estimadas por revisar, los anulados por el cliente…
//
//   presupuestosClienteCfg   { _id: estId, ref, noEnviar, motivo, por, at }
//   presupuestosClienteLog   { estId, ref, tipo: 'envio'|'vista'|'respuesta', family, a, accion, nombre, motivo, ip, at }
'use strict';
const crypto = require('crypto');
async function getDB() { return require('./db').getDB(); }
const CFG = 'presupuestosClienteCfg', LOG = 'presupuestosClienteLog';
const PENDIENTE = 1120641, ACEPTADO = 1120656, RECHAZADO = 1120642;
const ESTADO_TXT = { 1120641: 'Pendiente', 1120642: 'Rechazado', 1120656: 'Aceptado', 1120650: 'Cerrado' };
const DIAS_MAX = 180, DIAS_MARGEN = 3;
const eur = n => (Number(n) || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' }) + ' €';
const fd = d => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const base = () => process.env.PUBLIC_URL || process.env.DASHBOARD_URL || 'https://dashboard.corpprojects.es';

// ── Enlace firmado por presupuesto (sin caducidad: vale lo que vale el presupuesto) ──
function _firma(id) { return crypto.createHmac('sha256', process.env.JWT_SECRET || 'corp').update('prt:' + id).digest('base64url').slice(0, 18); }
function token(estId) { const id = String(estId).replace(/\D/g, ''); return Buffer.from(id).toString('base64url') + '.' + _firma(id); }
function verificar(tok) {
  const [b, f] = String(tok || '').split('.');
  if (!b || !f) return null;
  let id; try { id = Buffer.from(b, 'base64url').toString(); } catch (e) { return null; }
  if (!/^\d{4,12}$/.test(id)) return null;
  const g = _firma(id);
  return f.length === g.length && crypto.timingSafeEqual(Buffer.from(f), Buffer.from(g)) ? id : null;
}
const url = estId => `${base()}/pr/${token(estId)}`;

// ── Pendientes por familia ──
async function pendientes({ hoy = new Date(), family = null, todos = false, _stel = null, _db = null } = {}) {
  const S = _stel || require('./stelorder');
  const db = _db || await getDB();
  const [est, { clientMap }] = await Promise.all([S.getWorkEstimates(), S.getClients()]);
  const cfg = new Map((await db.collection(CFG).find({}).toArray()).map(c => [String(c._id), c]));
  const out = [];
  for (const e of est || []) {
    if (e.deleted || Number(e['document-state-id']) !== PENDIENTE) continue;
    const dias = Math.floor((hoy - new Date(e.date)) / 86400000);
    const c = clientMap[String(e['account-id'])] || {};
    const fam = String(c.family || '').trim() || 'Sin familia';
    if (family && fam !== family) continue;
    const x = cfg.get(String(e.id));
    const motivoFuera = dias > DIAS_MAX ? `más de ${DIAS_MAX} días` : dias < DIAS_MARGEN ? 'recién hecho (margen para revisarlo)' : x && x.noEnviar ? (x.motivo || 'marcado «No enviar»') : null;
    if (motivoFuera && !todos) continue;
    out.push({ id: String(e.id), ref: e['full-reference'], fecha: String(e.date).slice(0, 10), dias, titulo: (e.title && e.title !== 'null') ? e.title : '', total: Number(e['total-amount']) || 0,
      cliente: c['legal-name'] || c.name || '—', accountId: String(e['account-id']), clientEmail: (c.email || '').trim(), family: fam, noEnviar: !!(x && x.noEnviar), fuera: motivoFuera, emailLeido: Number(e['email-read-count']) || 0 });
  }
  return out.sort((a, b) => a.cliente.localeCompare(b.cliente) || a.fecha.localeCompare(b.fecha));
}

// ── Correo a la familia ──
function construirEmail(family, lista) {
  const total = lista.reduce((a, p) => a + p.total, 0);
  const subject = `Corp Projects — ${lista.length} presupuesto${lista.length > 1 ? 's' : ''} pendiente${lista.length > 1 ? 's' : ''} de respuesta`;
  const filas = lista.map(p => `<tr>
  <td style="padding:10px 8px;border-top:1px solid #e6e8ea"><strong>${esc(p.cliente)}</strong><br><span style="color:#5b6670">${esc(p.ref)}${p.titulo ? ' · ' + esc(p.titulo) : ''}</span></td>
  <td style="padding:10px 8px;border-top:1px solid #e6e8ea;white-space:nowrap;color:#5b6670">${fd(p.fecha)}</td>
  <td style="padding:10px 8px;border-top:1px solid #e6e8ea;text-align:right;white-space:nowrap"><strong>${eur(p.total)}</strong></td>
  <td style="padding:10px 8px;border-top:1px solid #e6e8ea;text-align:right"><a href="${url(p.id)}" style="display:inline-block;background:#1f4e79;color:#fff;text-decoration:none;padding:8px 12px;border-radius:6px;font-weight:600;white-space:nowrap">Ver y responder</a></td></tr>`).join('');
  const html = `<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1d2422;max-width:720px">
<p>Buenos días,</p>
<p>Os pasamos los presupuestos que tenemos pendientes de respuesta. En cada uno podéis ver el presupuesto completo y <strong>aceptarlo o rechazarlo</strong> con un clic; si alguno ya no interesa, rechazadlo y lo quitamos de la lista.</p>
<table style="border-collapse:collapse;width:100%;font-size:14px"><thead><tr style="text-align:left;color:#5b6670;font-size:12px"><th style="padding:6px 8px">Comunidad / presupuesto</th><th style="padding:6px 8px">Fecha</th><th style="padding:6px 8px;text-align:right">Importe</th><th></th></tr></thead><tbody>${filas}</tbody>
<tfoot><tr><td style="padding:10px 8px;border-top:2px solid #1d2422" colspan="2"><strong>${lista.length} presupuesto${lista.length > 1 ? 's' : ''}</strong></td><td style="padding:10px 8px;border-top:2px solid #1d2422;text-align:right"><strong>${eur(total)}</strong></td><td style="border-top:2px solid #1d2422"></td></tr></tfoot></table>
<p style="margin-top:18px">Para cualquier cambio en un presupuesto podéis contestar a este correo o llamarnos al 674 013 723.</p>
<p>Gracias,<br>Corp Projects Holding, S.L.</p></div>`;
  const text = `${subject}\n\n` + lista.map(p => `- ${p.cliente} · ${p.ref}${p.titulo ? ' · ' + p.titulo : ''} · ${fd(p.fecha)} · ${eur(p.total)}\n  ${url(p.id)}`).join('\n') + `\n\nTotal: ${eur(total)}\nCorp Projects Holding, S.L. · 674 013 723`;
  return { subject, html, text };
}

// Semana ISO para no mandar dos veces la misma semana.
function semana(d = new Date()) { const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const dia = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - dia); const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y) / 86400000 + 1) / 7)).padStart(2, '0')}`; }

// Envío de los lunes (o a mano). dryRun: devuelve lo que se mandaría sin enviar. soloA: manda la prueba a ese email.
async function envio({ hoy = new Date(), family = null, dryRun = false, soloA = null, forzar = false, _enviar = null } = {}) {
  const avisos = require('./avisos');
  if (!soloA && !dryRun && await avisos.isGlobalPaused()) return { pausado: true, enviados: [] };
  const db = await getDB();
  const lista = await pendientes({ hoy, family });
  const porFam = {};
  for (const p of lista) (porFam[p.family] = porFam[p.family] || []).push(p);
  const res = [];
  for (const [fam, ps] of Object.entries(porFam)) {
    if (fam === 'Sin familia' && !soloA) continue;
    const cfg = await avisos.getFamilyConfig(fam);
    const destino = soloA || cfg.email;
    if (!soloA && (!cfg.presuLunes || cfg.paused || !destino)) { res.push({ family: fam, n: ps.length, omitido: !cfg.presuLunes ? 'no activado' : cfg.paused ? 'familia en pausa' : 'sin email' }); continue; }
    const clave = `PRES:${fam}:${semana(hoy)}`;
    if (!soloA && !dryRun && !forzar && await avisos.wasAlertSentToday(clave, 'semana', 'fija')) { res.push({ family: fam, n: ps.length, omitido: 'ya enviado esta semana' }); continue; }
    const m = construirEmail(fam, ps);
    if (dryRun) { res.push({ family: fam, a: destino, n: ps.length, total: ps.reduce((a, p) => a + p.total, 0), ...m }); continue; }
    const bcc = soloA ? undefined : (process.env.EMAIL_AVISOS || process.env.EMAIL_OFICINA || 'hola@corpprojects.es');
    const ok = await (_enviar || require('./notifications').sendEmail)({ to: destino, bcc: bcc !== destino ? bcc : undefined, subject: soloA ? `[PRUEBA] ${m.subject}` : m.subject, html: m.html, text: m.text });
    if (ok && !soloA) {
      await avisos.markAlertSent(clave, 'semana', 'fija');
      await db.collection(LOG).insertMany(ps.map(p => ({ estId: p.id, ref: p.ref, tipo: 'envio', family: fam, a: destino, at: new Date() })));
    }
    res.push({ family: fam, a: destino, n: ps.length, enviado: !!ok, prueba: !!soloA });
  }
  return { enviados: res };
}

// ── Página del cliente ──
async function publico(tok, { ip = '' } = {}) {
  const id = verificar(tok);
  if (!id) throw new Error('Enlace no válido');
  const S = require('./stelorder');
  const e = await S.leerPresupuesto(id);
  if (!e || e.deleted) throw new Error('Este presupuesto ya no está disponible');
  const { clientMap } = await S.getClients();
  const c = clientMap[String(e['account-id'])] || {};
  const lineas = [];
  for (const l of e.lines || []) {
    if (l.deleted) continue;
    if (l['line-type'] === 'SECTION') { lineas.push({ seccion: String(l['item-name'] || '').trim(), texto: String(l['item-description'] || '').trim() }); continue; }
    lineas.push({ nombre: l['item-name'] || '', descripcion: l['item-description'] && l['item-description'] !== l['item-name'] ? l['item-description'] : '', unidades: Number(l.units) || 0, precio: Number(l['item-base-price']) || 0, dto: Number(l['discount-percentage']) || 0, iva: Number(l['primary-tax-percentage']) || 0,
      importe: Math.round((Number(l.units) || 0) * (Number(l['item-base-price']) || 0) * (1 - (Number(l['discount-percentage']) || 0) / 100) * 100) / 100 });
  }
  const baseImp = lineas.reduce((a, l) => a + (l.importe || 0), 0);
  const db = await getDB();
  const resp = await db.collection(LOG).find({ estId: id, tipo: 'respuesta' }).sort({ at: -1 }).limit(1).toArray();
  db.collection(LOG).insertOne({ estId: id, ref: e['full-reference'], tipo: 'vista', ip: String(ip).slice(0, 60), at: new Date() }).catch(() => {});
  return { ref: e['full-reference'], fecha: String(e.date).slice(0, 10), titulo: (e.title && e.title !== 'null') ? e.title : '', cliente: c['legal-name'] || c.name || '', estado: ESTADO_TXT[e['document-state-id']] || 'Pendiente',
    pendiente: Number(e['document-state-id']) === PENDIENTE, base: Math.round(baseImp * 100) / 100, total: Number(e['total-amount']) || 0, lineas, tienePdf: !!e['pdf-path'],
    respuesta: resp[0] ? { accion: resp[0].accion, nombre: resp[0].nombre, at: resp[0].at } : null };
}

async function pdf(tok) {
  const id = verificar(tok);
  if (!id) throw new Error('Enlace no válido');
  const S = require('./stelorder');
  const e = await S.leerPresupuesto(id);
  if (!e || !e['pdf-path']) throw new Error('Sin PDF');
  const r = await fetch(e['pdf-path']);
  if (!r.ok) throw new Error(`PDF ${r.status}`);
  return { buffer: Buffer.from(await r.arrayBuffer()), nombre: `Presupuesto-${e['full-reference']}.pdf` };
}

async function responder(tok, { accion, nombre = '', motivo = '', ip = '', _stel = null, _enviar = null } = {}) {
  const id = verificar(tok);
  if (!id) throw new Error('Enlace no válido');
  if (!['aceptar', 'rechazar'].includes(accion)) throw new Error('Respuesta no válida');
  const S = _stel || require('./stelorder');
  const db = await getDB();
  const e = await S.leerPresupuesto(id);
  if (!e) throw new Error('Este presupuesto ya no está disponible');
  if (Number(e['document-state-id']) !== PENDIENTE) return { yaRespondido: true, estado: ESTADO_TXT[e['document-state-id']] || '' };
  const ya = await db.collection(LOG).findOne({ estId: id, tipo: 'respuesta' });
  if (ya) return { yaRespondido: true, estado: ya.accion === 'aceptar' ? 'Aceptado' : 'Rechazado' };
  const { clientMap } = await S.getClients();
  const c = clientMap[String(e['account-id'])] || {};
  const doc = { estId: id, ref: e['full-reference'], tipo: 'respuesta', accion, nombre: String(nombre || '').trim().slice(0, 80), motivo: String(motivo || '').trim().slice(0, 500), ip: String(ip).slice(0, 60), family: String(c.family || '').trim() || null, cliente: c['legal-name'] || c.name || '', total: Number(e['total-amount']) || 0, at: new Date() };
  await db.collection(LOG).insertOne(doc);
  // StelOrder (si la escritura está activada en Ajustes); si no, lo cambia la oficina a mano.
  let stel = 'manual';
  try {
    if (await require('./avisos').isStelWriteEnabled()) { await S.setWorkEstimateState(id, accion === 'aceptar' ? ACEPTADO : RECHAZADO, { requestedBy: `Cliente (${doc.nombre || doc.cliente}) desde el enlace` }); stel = 'ok'; }
  } catch (err) { stel = 'error: ' + err.message; }
  // La obra «En estudio» con ese presupuesto pasa a activa.
  let obra = null;
  if (accion === 'aceptar') {
    try {
      const o = await db.collection('obras').findOne({ 'presupuestosStel.id': id });
      if (o) { obra = o.reference; if (o.status === 'estudio') await require('./obras').updateObra(String(o._id), { status: 'activa' }); }
    } catch (err) { console.warn('[PresuCliente] obra:', err.message); }
  }
  await db.collection(LOG).updateOne({ estId: id, tipo: 'respuesta' }, { $set: { stel, obra } });
  const N = require('./notifications');
  const txt = `${accion === 'aceptar' ? '✅ *Presupuesto ACEPTADO*' : '❌ *Presupuesto rechazado*'}\n${doc.ref} · ${doc.cliente}${e.title && e.title !== 'null' ? ' · ' + e.title : ''}\n${eur(doc.total)}${doc.nombre ? `\nResponde: ${doc.nombre}` : ''}${doc.motivo ? `\nMotivo: ${doc.motivo}` : ''}\n` +
    (stel === 'ok' ? 'Ya está cambiado en StelOrder.' : stel === 'manual' ? 'Cámbialo en StelOrder (la escritura automática está apagada).' : `No se pudo cambiar en StelOrder (${stel.replace(/^error: /, '')}): hazlo a mano.`) +
    (obra ? `\nObra: ${obra}${accion === 'aceptar' ? ' (pasa a activa)' : ''}` : '');
  for (const to of [...new Set([N.destinoDueno(), process.env.OFICINA_TELEFONO || '+34674013723'].filter(Boolean))]) {
    try { await (_enviar || N.sendWhatsAppTo)(to, txt); } catch (err) { console.warn('[PresuCliente] aviso:', err.message); }
  }
  return { ok: true, accion, estado: accion === 'aceptar' ? 'Aceptado' : 'Rechazado' };
}

// ── Dashboard: marcar «No enviar» y ver vistas/respuestas ──
async function marcarNoEnviar(estId, noEnviar, { motivo = '', por = '', ref = null } = {}) {
  const id = String(estId).replace(/\D/g, '');
  const db = await getDB();
  await db.collection(CFG).updateOne({ _id: id }, { $set: { noEnviar: !!noEnviar, motivo: String(motivo || '').slice(0, 200), por, at: new Date(), ...(ref ? { ref } : {}) } }, { upsert: true });
  return { ok: true };
}
async function resumen({ hoy = new Date() } = {}) {
  const db = await getDB();
  const lista = await pendientes({ hoy, todos: true });
  const ids = lista.map(p => p.id);
  const logs = await db.collection(LOG).find({ estId: { $in: ids } }).sort({ at: -1 }).toArray();
  for (const p of lista) {
    const l = logs.filter(x => x.estId === p.id);
    p.vistas = l.filter(x => x.tipo === 'vista').length; p.ultimaVista = (l.find(x => x.tipo === 'vista') || {}).at || null;
    p.envios = l.filter(x => x.tipo === 'envio').length; p.ultimoEnvio = (l.find(x => x.tipo === 'envio') || {}).at || null;
    p.url = url(p.id);
  }
  const respuestas = await db.collection(LOG).find({ tipo: 'respuesta' }).sort({ at: -1 }).limit(30).toArray();
  return { lista, respuestas };
}

module.exports = { token, verificar, url, pendientes, construirEmail, envio, publico, pdf, responder, marcarNoEnviar, resumen, semana, PENDIENTE, ACEPTADO, RECHAZADO };
