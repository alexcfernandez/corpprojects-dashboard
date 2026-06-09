// src/scheduler.js — con protección contra alertas al arrancar
const cron = require('node-cron');
const { getPendingInvoices, getSummary, getWorkOrdersLive } = require('./stelorder');
const { sendInvoiceAlert, sendDailySummary, sendFamilySummary, buildFamilySummaryEmail, sendWorkOrdersSummary, sendEmail } = require('./notifications');
const { pollEmails } = require('./email-intelligence');
const avisos = require('./avisos');   // registro persistente de avisos enviados

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

async function runDailySummary() {
  console.log('[Scheduler] Enviando resumen diario...');
  try {
    const summary = await getSummary();
    await sendDailySummary(summary);
  } catch (err) {
    console.error('[Scheduler] Error resumen diario:', err.message);
  }
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
      if (!cfg.email || cfg.paused)             { skipped++; continue; }
      if (!isFamilyDue(cfg.freq, slot))         { skipped++; continue; }
      const key = `REM:${family}:${slot}`;
      if (await avisos.wasAlertSentToday(key, 'auto')) { skipped++; continue; }
      console.log(`[Scheduler] Recordatorio (${cfg.freq}/${cfg.format}) → ${family} (${invoices.length} fra.) → ${cfg.email}`);
      await sendForFamily(family, invoices, cfg.format);
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
  try {
    const pending = await getPendingInvoices();
    const byFam = groupByFamily(pending);
    for (const [family, invoices] of Object.entries(byFam)) {
      const cfg = await avisos.getFamilyConfig(family);
      if (!cfg.email || cfg.paused) { skipped++; continue; }
      console.log(`[Scheduler] Envío manual (${format}) → ${family} (${invoices.length} fra.) → ${cfg.email}`);
      await sendForFamily(family, invoices, format);
      sent++;
      await new Promise(r => setTimeout(r, 1500));
    }
    console.log(`[Scheduler] Envío manual (${format}): ${sent} familias, ${skipped} omitidas.`);
  } catch (err) {
    console.error('[Scheduler] Error envío manual:', err.message);
  }
  return { sent, skipped };
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
    const toAlert = all.filter(o => o.alertLevel === 'red' || o.alertLevel === 'amber');
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

  // Resumen diario INTERNO (al admin) 08:30 lun–vie
  cron.schedule('30 8 * * 1-5', runDailySummary, { timezone: 'Europe/Madrid' });

  // Aviso diario de PEDIDOS DE TRABAJO (rojos + ámbar) a las 08:00. Respeta su pausa.
  cron.schedule('0 8 * * *', () => sendWorkOrdersAlert(), { timezone: 'Europe/Madrid' });

  // Poll de emails cada 15 minutos
  cron.schedule('*/15 * * * *', async () => {
    try {
      await pollEmails();
    } catch (err) {
      console.error('[Scheduler] Error poll emails:', err.message);
    }
  }, { timezone: 'Europe/Madrid' });

  console.log('[Scheduler] ✅ Recordatorios: 08:30 y 17:00 (según frecuencia por familia) | Resumen interno: 08:30 lun–vie | Emails: cada 15min');

  // Primer poll de emails a los 2 minutos de arrancar
  setTimeout(async () => {
    try {
      await pollEmails();
    } catch (err) {
      console.error('[Scheduler] Error primer poll emails:', err.message);
    }
  }, 2 * 60 * 1000);
}

module.exports = { startScheduler, checkPendingInvoices, runDailySummary, sendReminders, sendManual, previewToEmail, sendWorkOrdersAlert };
