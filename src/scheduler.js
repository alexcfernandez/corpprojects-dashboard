// src/scheduler.js — con protección contra alertas al arrancar
const cron = require('node-cron');
const { getPendingInvoices, getSummary, getWorkOrdersLive } = require('./stelorder');
const { sendInvoiceAlert, sendDailySummary, sendFamilySummary, buildFamilySummaryEmail, sendWorkOrdersSummary, sendEmail, sendWhatsApp } = require('./notifications');
const { construirAviso } = require('./avisos-proactivo');
const { pollEmails } = require('./email-intelligence');
const avisos = require('./avisos');   // registro persistente de avisos enviados
const calendarSync = require('./calendar'); // sondeo Google Calendar → dashboard
const activity = require('./activity');      // log de actividad de StelOrder

// Flag: no enviar alertas en los primeros 5 minutos tras arrancar
const startTime  = Date.now();
const WARMUP_MS  = 5 * 60 * 1000; // 5 minutos

async function checkPendingInvoices() {
  const isWarmup = (Date.now() - startTime) < WARMUP_MS;
  console.log(`[Scheduler] Revisando facturas — ${new Date().toLocaleString('es-ES')}${isWarmup ? ' (modo warmup, sin alertas)' : ''}`);
  try {
    if (await avisos.isGlobalPaused()) {
      console.log('[Scheduler] ⏸ Avisos en PAUSA global — no se envía nada.');
      return;
    }
    const pending = await getPendingInvoices();
    if (!pending.length) { console.log('[Scheduler] Sin facturas pendientes de alerta.'); return; }
    let alertsTriggered = 0;
    for (const invoice of pending) {
      if (invoice.alertLevel === 'ok') continue;
      if (await avisos.wasAlertSentToday(invoice.id, invoice.alertLevel)) continue;
      // En warmup: marcamos como gestionado (sin enviar) para no disparar el
      // backlog entero al arrancar.
      if (isWarmup) { await avisos.markAlertSent(invoice.id, invoice.alertLevel); continue; }
      console.log(`[Scheduler] Alerta ${invoice.alertLevel} → ${invoice.number} (${invoice.client}) — ${invoice.daysOverdue}d`);
      await sendInvoiceAlert(invoice);
      await avisos.markAlertSent(invoice.id, invoice.alertLevel);
      alertsTriggered++;
      await new Promise(r => setTimeout(r, 1500));
    }
    if (isWarmup) {
      console.log(`[Scheduler] Warmup: ${pending.filter(i=>i.alertLevel!=='ok').length} alertas registradas, no enviadas.`);
    } else {
      console.log(`[Scheduler] ${alertsTriggered} alertas enviadas.`);
    }
  } catch (err) {
    console.error('[Scheduler] Error:', err.message);
  }
}

// Aviso proactivo por WhatsApp al dueño: facturas vencidas + presupuestos aceptados parados.
async function enviarAvisoProactivo() {
  const isWarmup = (Date.now() - startTime) < WARMUP_MS;
  if (isWarmup) { console.log('[Aviso] warmup, no se envía.'); return; }
  try {
    if (await avisos.isGlobalPaused()) { console.log('[Aviso] pausa global, no se envía.'); return; }
    const dateKey = new Date().toISOString().slice(0, 10);
    if (await avisos.wasAlertSentToday('aviso-proactivo', dateKey)) { console.log('[Aviso] ya enviado hoy.'); return; }
    const { texto, hayAlgo } = await construirAviso();
    if (!hayAlgo && process.env.AVISO_SOLO_SI_HAY === '1') { console.log('[Aviso] nada que avisar.'); return; }
    await sendWhatsApp(texto);
    await avisos.markAlertSent('aviso-proactivo', dateKey);
    console.log('[Aviso] proactivo enviado por WhatsApp.');
  } catch (err) {
    console.error('[Aviso] Error:', err.message);
  }
}

async function runDailySummary() {
  console.log('[Scheduler] Enviando resumen diario...');
  try {
    const summary = await getSummary();
    await sendDailySummary(summary);
  } catch (err) {
    console.error('[Scheduler] Error resumen diario:', err.message);
  }
}

// ── "☀️ Buenos días" unificado (Fase 4b): UN solo mensaje WhatsApp al owner por
// SECCIONES (colectores). Funde los avisos WhatsApp-al-owner de las 08:00:
// pendientes + (lunes) proactivo/cobros, más una sección de calendario de hoy.
// NOTA: sendWorkOrdersAlert es un EMAIL (otro canal/destinatario) → NO se funde
// aquí; su cron se mantiene aparte. Cada colector devuelve texto o null.
// Reutiliza avisos (pausa + anti-duplicado) y sendWhatsApp (canal activo).

// Sección Calendario: eventos de HOY (read-only, best-effort).
async function seccionCalendario(hoyISO) {
  try {
    const evs = await calendarSync.eventosDeHoy(hoyISO);
    if (!evs || !evs.length) return null;
    return '📅 *Hoy en el calendario:*\n' + evs.map(e => `• ${e.hora ? e.hora + ' ' : ''}${e.summary}`).join('\n');
  } catch (e) { console.error('[Resumen] calendario:', e.message); return null; }
}

// Sección proactivo/cobros: solo los LUNES (como AVISO_CRON por defecto).
async function seccionProactivo(dow) {
  if (dow !== 1) return null;
  try {
    const { texto, hayAlgo } = await construirAviso();
    return hayAlgo ? texto : null;
  } catch (e) { console.error('[Resumen] proactivo:', e.message); return null; }
}

const RESUMEN_COLECTORES = [
  { nombre: 'pendientes', fn: ({ hoyISO }) => require('./pendientes').seccionResumen(hoyISO) },
  { nombre: 'correo',     fn: () => require('./email-intelligence').seccionCorreo(24) },
  { nombre: 'calendario', fn: ({ hoyISO }) => seccionCalendario(hoyISO) },
  { nombre: 'proactivo',  fn: ({ dow })    => seccionProactivo(dow) },
  // Añadir aquí futuros colectores (presencia, etc.).
];

// Compone el mensaje uniendo SOLO las secciones con contenido. null si no hay nada.
function componerBuenosDias(secciones) {
  const s = (secciones || []).filter(x => x && String(x).trim());
  if (!s.length) return null;
  return '☀️ *Buenos días.* Esto tienes hoy:\n\n' + s.join('\n\n');
}

async function enviarResumenDiario() {
  const isWarmup = (Date.now() - startTime) < WARMUP_MS;
  if (isWarmup) { console.log('[Resumen] warmup, no se envía.'); return; }
  try {
    if (await avisos.isGlobalPaused()) { console.log('[Resumen] pausa global, no se envía.'); return; }
    const dateKey = new Date().toISOString().slice(0, 10);
    if (await avisos.wasAlertSentToday('resumen-diario', dateKey)) { console.log('[Resumen] ya enviado hoy.'); return; }
    const hoyISO = require('./pendientes').hoyMadridISO();
    const ctx = { hoyISO, dow: new Date(hoyISO + 'T00:00:00Z').getUTCDay() };
    const secciones = await Promise.all(RESUMEN_COLECTORES.map(c =>
      Promise.resolve().then(() => c.fn(ctx)).catch(e => { console.error('[Resumen] colector', c.nombre, ':', e.message); return null; })));
    const msg = componerBuenosDias(secciones);
    if (!msg) { console.log('[Resumen] nada que resumir hoy.'); return; }
    await sendWhatsApp(msg);
    await avisos.markAlertSent('resumen-diario', dateKey);
    console.log('[Resumen] enviado.');
  } catch (err) { console.error('[Resumen] Error:', err.message); }
}

// ── Motor de envíos por familia (frecuencia + formato configurables) ──
function groupByFamily(pending) {
  const byFam = {};
  for (const inv of pending) {
    const f = inv.family || 'Sin familia';
    (byFam[f] = byFam[f] || []).push(inv);
  }
  return byFam;
}

// ¿Toca enviar a una familia en esta franja según su frecuencia?
// slot: 'morning' (08:30) | 'evening' (17:00). día: 0=Dom..6=Sáb.
function isFamilyDue(freq, slot, date = new Date()) {
  const day = date.getDay();
  switch (freq) {
    case 'weekly':      return slot === 'morning' && day === 5;                 // viernes
    case 'biweekly':    return slot === 'morning' && (day === 1 || day === 4);  // lunes y jueves
    case 'daily':       return slot === 'morning';
    case 'twice_daily': return slot === 'morning' || slot === 'evening';
    default:            return false;                                           // manual
  }
}

async function sendForFamily(family, invoices, format) {
  if (format === 'individual') {
    for (const inv of invoices) {
      await sendInvoiceAlert(inv);
      await new Promise(r => setTimeout(r, 1200));
    }
  } else {
    await sendFamilySummary(family, invoices);
  }
}

// Envío POR CLIENTE: cada cliente recibe SOLO sus facturas, a su email de ficha.
// Devuelve { sent, sinEmail:[nombres de clientes sin email] }.
async function sendForClients(label, invoices) {
  const byClient = {};
  for (const inv of invoices) {
    const k = inv.accountId ? ('acc:' + inv.accountId) : ('name:' + (inv.client || '?'));
    if (!byClient[k]) byClient[k] = { client: inv.client || 'Cliente', email: (inv.clientEmail || '').trim(), invoices: [] };
    byClient[k].invoices.push(inv);
  }
  let sent = 0; const sinEmail = [];
  for (const c of Object.values(byClient)) {
    if (!c.email) { sinEmail.push(c.client); continue; }
    const { subject, html, waMsg } = await buildFamilySummaryEmail(c.client, c.invoices);
    await sendEmail({ to: c.email, subject, html, text: waMsg });
    sent++;
    await new Promise(r => setTimeout(r, 1500));
  }
  return { sent, sinEmail };
}

// Envío AUTOMÁTICO: recorre familias y envía solo a las que les toca en esta
// franja según su frecuencia. Respeta pausa global, familias pausadas y dedup
// por familia+franja+día.
async function sendReminders(slot) {
  if (await avisos.isGlobalPaused()) {
    console.log(`[Scheduler] ⏸ Pausa global — recordatorios (${slot}) omitidos.`);
    return { paused: true, sent: 0, skipped: 0 };
  }
  let sent = 0, skipped = 0;
  try {
    const pending = await getPendingInvoices();
    if (!pending.length) { console.log('[Scheduler] Recordatorios: sin facturas pendientes.'); return { sent, skipped }; }
    const byFam = groupByFamily(pending);
    for (const [family, invoices] of Object.entries(byFam)) {
      const cfg = await avisos.getFamilyConfig(family);
      if (cfg.paused)                              { skipped++; continue; }
      if (cfg.modo !== 'cliente' && !cfg.email)    { skipped++; continue; }
      if (!isFamilyDue(cfg.freq, slot))            { skipped++; continue; }
      const key = `REM:${family}:${slot}`;
      if (await avisos.wasAlertSentToday(key, 'auto')) { skipped++; continue; }
      if (cfg.modo === 'cliente') {
        const r = await sendForClients(family, invoices);
        console.log(`[Scheduler] Recordatorio POR CLIENTE → ${family}: ${r.sent} enviados${r.sinEmail.length ? `, sin email: ${r.sinEmail.join(', ')}` : ''}`);
      } else {
        console.log(`[Scheduler] Recordatorio (${cfg.freq}/${cfg.format}) → ${family} (${invoices.length} fra.) → ${cfg.email}`);
        await sendForFamily(family, invoices, cfg.format);
      }
      await avisos.markAlertSent(key, 'auto');
      sent++;
      await new Promise(r => setTimeout(r, 1500));
    }
    console.log(`[Scheduler] Recordatorios ${slot}: ${sent} familias avisadas, ${skipped} omitidas.`);
  } catch (err) {
    console.error('[Scheduler] Error recordatorios:', err.message);
  }
  return { sent, skipped };
}

// Envío MANUAL (botones): fuerza el envío a TODAS las familias con responsable
// (ignora frecuencia y dedup). Respeta pausa global y familias pausadas.
// format: 'grouped' | 'individual'.
async function sendManual(format) {
  if (await avisos.isGlobalPaused()) return { paused: true, sent: 0, skipped: 0 };
  let sent = 0, skipped = 0;
  const sinEmail = [];
  try {
    const pending = await getPendingInvoices();
    const byFam = groupByFamily(pending);
    for (const [family, invoices] of Object.entries(byFam)) {
      const cfg = await avisos.getFamilyConfig(family);
      if (cfg.paused) { skipped++; continue; }
      if (cfg.modo === 'cliente') {
        const r = await sendForClients(family, invoices);
        if (r.sinEmail.length) sinEmail.push(...r.sinEmail);
        console.log(`[Scheduler] Manual POR CLIENTE → ${family}: ${r.sent} enviados, ${r.sinEmail.length} sin email.`);
        sent++;
        continue;
      }
      if (!cfg.email) { skipped++; continue; }
      console.log(`[Scheduler] Envío manual (${format}) → ${family} (${invoices.length} fra.) → ${cfg.email}`);
      await sendForFamily(family, invoices, format);
      sent++;
      await new Promise(r => setTimeout(r, 1500));
    }
    console.log(`[Scheduler] Envío manual (${format}): ${sent} familias, ${skipped} omitidas.`);
  } catch (err) {
    console.error('[Scheduler] Error envío manual:', err.message);
  }
  return { sent, skipped, sinEmail };
}

// PREVISUALIZACIÓN: arma el resumen agrupado y lo envía SOLO al email indicado.
// Ignora la pausa global y no manda WhatsApp ni BCC. Sirve para que el admin
// vea cómo queda el correo (con los enlaces "Ver factura") antes de soltarlo.
// Si no se indica familia, coge la que tenga más facturas pendientes.
async function previewToEmail(email, family) {
  if (!email) throw new Error('Falta el email de previsualización');
  const pending = await getPendingInvoices();
  if (!pending.length) throw new Error('No hay facturas pendientes para previsualizar');
  const byFam = groupByFamily(pending);

  let fam = family;
  let invoices = fam ? byFam[fam] : null;
  if (!invoices || !invoices.length) {
    // elegir la familia con más facturas pendientes
    let best = null, bestN = -1;
    for (const [f, list] of Object.entries(byFam)) {
      if (list.length > bestN) { best = f; bestN = list.length; }
    }
    fam = best;
    invoices = byFam[fam] || [];
  }
  if (!invoices.length) throw new Error('No hay facturas para esa familia');

  const { subject, html, waMsg } = await buildFamilySummaryEmail(fam, invoices);
  await sendEmail({ to: email, subject: `[PRUEBA] ${subject}`, html, text: waMsg });
  return { family: fam, count: invoices.length, to: email };
}

// AVISO DIARIO DE PEDIDOS DE TRABAJO: rojos + ámbar a hola@corpprojects.es.
// Respeta su propia pausa (independiente del cobro). force=true ignora la pausa
// (para el botón "enviar/previsualizar ahora").
async function sendWorkOrdersAlert(opts = {}) {
  const { force = false, to = null } = opts;
  if (!force && await avisos.isPedidosPaused()) {
    console.log('[Scheduler] ⏸ Avisos de pedidos en pausa — omitido.');
    return { paused: true, sent: 0 };
  }
  try {
    const all = await getWorkOrdersLive();
    await require('./asignaciones').attachAssignments(all);
    const toAlert = all.filter(o => o.workStatus !== 'done' && o.workStatus !== 'invoiced' && (o.alertLevel === 'red' || o.alertLevel === 'amber'));
    if (!toAlert.length) { console.log('[Scheduler] Pedidos: nada en rojo/ámbar.'); return { sent: 0, count: 0 }; }
    const r = await sendWorkOrdersSummary(toAlert, to);
    console.log(`[Scheduler] Aviso de pedidos enviado a ${r.to} (${toAlert.length} pedidos).`);
    return { sent: 1, count: toAlert.length, to: r.to };
  } catch (err) {
    console.error('[Scheduler] Error aviso pedidos:', err.message);
    return { sent: 0, error: err.message };
  }
}

function startScheduler() {
  console.log('[Scheduler] Iniciando tareas...');

  // Recordatorios a clientes: 08:30 (mañana) y 17:00 (tarde) todos los días.
  // El motor decide qué familias toca según su frecuencia configurada.
  cron.schedule('30 8 * * *', () => sendReminders('morning'), { timezone: 'Europe/Madrid' });
  cron.schedule('0 17 * * *', () => sendReminders('evening'), { timezone: 'Europe/Madrid' });

  // Presencia (Fase 3): sembrar los 5 whatsapp al arrancar (idempotente) y avisar
  // a las 17:30 a quien no conste su presencia hoy (cobertura de equipo incluida).
  const avisoPresencia = require('./avisoPresencia');
  avisoPresencia.seedWhatsappTrabajadores()
    .then(r => console.log('[Presencia] whatsapp seed:', JSON.stringify(r)))
    .catch(e => console.warn('[Presencia] seed:', e.message));
  cron.schedule('30 17 * * 1-5', () => avisoPresencia.enviarAvisoPresencia()
    .then(r => console.log(`[Presencia] aviso 17:30 → ${r.pendientes} pendientes`, JSON.stringify(r.resultado)))
    .catch(e => console.error('[Presencia] aviso:', e.message)), { timezone: 'Europe/Madrid' });

  // Resumen diario INTERNO (al admin) 08:30 lun–vie
  cron.schedule('30 8 * * 1-5', runDailySummary, { timezone: 'Europe/Madrid' });

  // "☀️ Buenos días" unificado al owner por WhatsApp: 08:00 L-V. Incluye pendientes,
  // calendario de hoy y (lunes) el aviso proactivo/cobros — todo en UN solo mensaje.
  cron.schedule('0 8 * * 1-5', enviarResumenDiario, { timezone: 'Europe/Madrid' });

  // Aviso diario de PEDIDOS DE TRABAJO (rojos + ámbar) a las 08:00 → por EMAIL
  // (otro canal/destinatario): NO se funde en el "buenos días" de WhatsApp.
  cron.schedule('0 8 * * *', () => sendWorkOrdersAlert(), { timezone: 'Europe/Madrid' });

  // (El aviso proactivo/cobros de los lunes ya va DENTRO del "buenos días"
  //  unificado — se retira su cron individual para no enviarlo dos veces.)

  // Poll de emails cada 15 minutos
  cron.schedule('*/15 * * * *', async () => {
    try {
      await pollEmails();
    } catch (err) {
      console.error('[Scheduler] Error poll emails:', err.message);
    }
  }, { timezone: 'Europe/Madrid' });

  // Sondeo Google Calendar → dashboard (lo que se edita en el móvil). Antes cada
  // 2 min; subido a 15 min por defecto para bajar coste (configurable por env).
  const GCAL_SYNC_CRON = process.env.GCAL_SYNC_CRON || '*/15 * * * *';
  cron.schedule(GCAL_SYNC_CRON, async () => {
    try {
      const s = await calendarSync.pullChanges();
      if (s && (s.created || s.updated || s.deleted)) {
        console.log(`[GCal] Sync ${s.mode}: +${s.created} ~${s.updated} -${s.deleted}`);
      }
      if (s && s.error) console.error('[GCal] Sync error:', s.error);
    } catch (err) {
      console.error('[GCal] Error sondeo:', err.message);
    }
  }, { timezone: 'Europe/Madrid' });

  // Log de actividad de StelOrder cada 15 minutos (cuidando el tope diario de la API).
  const GCAL_ACT = process.env.ACTIVITY_CRON || '*/15 * * * *';
  cron.schedule(GCAL_ACT, async () => {
    try {
      const s = await activity.scan();
      const t = s.types || {};
      const tot = k => Object.values(t).reduce((n, x) => n + ((x && x[k]) || 0), 0);
      const c = tot('created'), m = tot('modified'), d = tot('deleted');
      if (c || m || d) console.log(`[Actividad] +${c} ~${m} -${d}`);
    } catch (err) {
      console.error('[Actividad] Error scan:', err.message);
    }
  }, { timezone: 'Europe/Madrid' });

  console.log('[Scheduler] ✅ Recordatorios: 08:30 y 17:00 (según frecuencia por familia) | Resumen interno: 08:30 lun–vie | Emails: cada 15min | GCal: cada 15min | Actividad: cada 15min');
  console.log(`[StelOrder] 🛡️ Freno de paginación ACTIVO (tope ${process.env.STEL_MAX_PAGES || 60} páginas) | Rate limit API: ${process.env.API_RATE_MAX || 4000}/15min | 📊 Medidor de tráfico ACTIVO (log cada 30min + /api/diag/traffic) | 📨 Buzón puente con long-poll (anti-flood). Optimización de coste v6.`);

  // Primer poll de emails a los 2 minutos de arrancar
  setTimeout(async () => {
    try {
      await pollEmails();
    } catch (err) {
      console.error('[Scheduler] Error primer poll emails:', err.message);
    }
  }, 2 * 60 * 1000);

  // Primera pasada de Google Calendar a los 90s: fija el punto de partida (baseline).
  setTimeout(async () => {
    try {
      const s = await calendarSync.pullChanges();
      console.log(`[GCal] Sync inicial: ${s.mode} (+${s.created} ~${s.updated} -${s.deleted})${s.error ? ' ERROR: ' + s.error : ''}`);
    } catch (err) {
      console.error('[GCal] Error sync inicial:', err.message);
    }
  }, 90 * 1000);

  // Primera pasada del log de actividad a los 2,5 min: foto inicial (baseline).
  setTimeout(async () => {
    try {
      const s = await activity.scan();
      const tipos = Object.entries(s.types || {}).map(([k, v]) => `${k}:${v.baseline ? 'baseline' : `+${v.created} ~${v.modified} -${v.deleted}`}${v.error ? '(ERR)' : ''}`).join(' | ');
      console.log(`[Actividad] Scan inicial → ${tipos}`);
    } catch (err) {
      console.error('[Actividad] Error scan inicial:', err.message);
    }
  }, 150 * 1000);
}

module.exports = { startScheduler, checkPendingInvoices, runDailySummary, sendReminders, sendManual, previewToEmail, sendWorkOrdersAlert, enviarAvisoProactivo, enviarResumenDiario, componerBuenosDias };
