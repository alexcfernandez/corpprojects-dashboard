// src/scheduler.js — con protección contra alertas al arrancar
const cron = require('node-cron');
const { getPendingInvoices, getSummary } = require('./stelorder');
const { sendInvoiceAlert, sendDailySummary, sendFamilySummary } = require('./notifications');
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

// Envía UN resumen agrupado por familia (todas sus facturas pendientes en un
// solo correo). Solo a familias con responsable asignado y no pausadas. Respeta
// la pausa global y el dedup diario (una vez al día por familia).
async function sendFamilySummaries() {
  if (await avisos.isGlobalPaused()) {
    console.log('[Scheduler] ⏸ Avisos en PAUSA global — no se envían resúmenes.');
    return { paused: true, sent: 0, skipped: 0 };
  }
  let sent = 0, skipped = 0;
  try {
    const pending = await getPendingInvoices();
    const byFam = {};
    for (const inv of pending) { (byFam[inv.family || 'Sin familia'] = byFam[inv.family || 'Sin familia'] || []).push(inv); }
    for (const [family, invoices] of Object.entries(byFam)) {
      const email = await avisos.getFamilyEmail(family);   // null si no hay o está pausada
      if (!email) { skipped++; continue; }
      if (await avisos.wasAlertSentToday('FAMSUM:' + family, 'summary')) { skipped++; continue; }
      console.log(`[Scheduler] Resumen → ${family} (${invoices.length} facturas) → ${email}`);
      await sendFamilySummary(family, invoices);
      await avisos.markAlertSent('FAMSUM:' + family, 'summary');
      sent++;
      await new Promise(r => setTimeout(r, 1500));
    }
    console.log(`[Scheduler] Resúmenes por familia: ${sent} enviados, ${skipped} omitidos.`);
  } catch (err) {
    console.error('[Scheduler] Error resúmenes por familia:', err.message);
  }
  return { sent, skipped };
}

function startScheduler() {
  console.log('[Scheduler] Iniciando tareas...');

  // Revisar facturas cada 2 horas
  cron.schedule('0 */2 * * *', checkPendingInvoices, { timezone: 'Europe/Madrid' });

  // Resumen diario 08:30 lun–vie
  cron.schedule('30 8 * * 1-5', runDailySummary, { timezone: 'Europe/Madrid' });

  // Poll de emails cada 15 minutos
  cron.schedule('*/15 * * * *', async () => {
    try {
      await pollEmails();
    } catch (err) {
      console.error('[Scheduler] Error poll emails:', err.message);
    }
  }, { timezone: 'Europe/Madrid' });

  console.log('[Scheduler] ✅ Revisión facturas: cada 2h | Resumen: 08:30 lun–vie | Emails: cada 15min');
  console.log(`[Scheduler] ⏳ Warmup activo ${WARMUP_MS/60000} min — no se enviarán alertas hasta ${new Date(startTime + WARMUP_MS).toLocaleTimeString('es-ES')}`);

  // Primera revisión facturas tras el warmup (5 min)
  setTimeout(checkPendingInvoices, WARMUP_MS);

  // Primer poll de emails a los 2 minutos de arrancar
  setTimeout(async () => {
    try {
      await pollEmails();
    } catch (err) {
      console.error('[Scheduler] Error primer poll emails:', err.message);
    }
  }, 2 * 60 * 1000);
}

module.exports = { startScheduler, checkPendingInvoices, runDailySummary, sendFamilySummaries };
