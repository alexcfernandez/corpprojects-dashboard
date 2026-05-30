// src/scheduler.js — con protección contra alertas al arrancar
const cron = require('node-cron');
const { getPendingInvoices, getSummary } = require('./stelorder');
const { sendInvoiceAlert, sendDailySummary } = require('./notifications');

// Registro de alertas enviadas hoy (en memoria)
const alertsSent = new Map();
// Flag: no enviar alertas en los primeros 5 minutos tras arrancar
const startTime  = Date.now();
const WARMUP_MS  = 5 * 60 * 1000; // 5 minutos

function getAlertKey(invoiceId, level) {
  const today = new Date().toISOString().slice(0, 10);
  return `${invoiceId}-${level}-${today}`;
}

async function checkPendingInvoices() {
  // Protección warmup: no enviar alertas justo al arrancar
  const isWarmup = (Date.now() - startTime) < WARMUP_MS;
  console.log(`[Scheduler] Revisando facturas — ${new Date().toLocaleString('es-ES')}${isWarmup ? ' (modo warmup, sin alertas)' : ''}`);

  try {
    const pending = await getPendingInvoices();
    if (!pending.length) { console.log('[Scheduler] Sin facturas pendientes de alerta.'); return; }

    let alertsTriggered = 0;

    for (const invoice of pending) {
      if (invoice.alertLevel === 'ok') continue;

      const key = getAlertKey(invoice.id, invoice.alertLevel);
      if (alertsSent.has(key)) continue; // ya enviada hoy

      // En warmup: registrar pero NO enviar
      alertsSent.set(key, new Date());
      if (isWarmup) continue;

      console.log(`[Scheduler] Alerta ${invoice.alertLevel} → ${invoice.number} (${invoice.client}) — ${invoice.daysOverdue}d`);
      await sendInvoiceAlert(invoice);
      alertsTriggered++;
      await new Promise(r => setTimeout(r, 1500)); // pausa entre envíos
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

function startScheduler() {
  console.log('[Scheduler] Iniciando tareas...');

  // Revisar facturas cada 2 horas
  cron.schedule('0 */2 * * *', checkPendingInvoices, { timezone: 'Europe/Madrid' });

  // Resumen diario 08:30 lun–vie
  cron.schedule('30 8 * * 1-5', runDailySummary, { timezone: 'Europe/Madrid' });

  // Limpiar registro cada lunes 00:01
  cron.schedule('1 0 * * 1', () => {
    console.log('[Scheduler] Limpiando registro de alertas...');
    alertsSent.clear();
  }, { timezone: 'Europe/Madrid' });

  console.log('[Scheduler] ✅ Revisión: cada 2h | Resumen: 08:30 lun–vie');
  console.log(`[Scheduler] ⏳ Warmup activo ${WARMUP_MS/60000} min — no se enviarán alertas hasta ${new Date(startTime + WARMUP_MS).toLocaleTimeString('es-ES')}`);

  // Primera revisión tras el warmup (5 min)
  setTimeout(checkPendingInvoices, WARMUP_MS);
}

module.exports = { startScheduler, checkPendingInvoices, runDailySummary };
