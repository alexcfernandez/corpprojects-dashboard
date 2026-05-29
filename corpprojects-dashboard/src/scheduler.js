// src/scheduler.js
// Tareas automáticas programadas
const cron = require('node-cron');
const { getPendingInvoices, getSummary } = require('./stelorder');
const { sendInvoiceAlert, sendDailySummary } = require('./notifications');

// Registro de alertas ya enviadas (en memoria, se resetea al reiniciar)
// En el futuro esto irá a base de datos
const alertsSent = new Map();

function getAlertKey(invoiceId, level) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `${invoiceId}-${level}-${today}`;
}

// ─── Revisar facturas pendientes ─────────────────────────────────
async function checkPendingInvoices() {
  console.log(`[Scheduler] Revisando facturas pendientes — ${new Date().toLocaleString('es-ES')}`);

  try {
    const pending = await getPendingInvoices();

    if (!pending.length) {
      console.log('[Scheduler] No hay facturas pendientes de alerta.');
      return;
    }

    let alertsTriggered = 0;

    for (const invoice of pending) {
      // Solo alertar niveles de alerta real (no 'ok')
      if (invoice.alertLevel === 'ok') continue;

      const key = getAlertKey(invoice.id, invoice.alertLevel);

      // No enviar la misma alerta dos veces en el mismo día
      if (alertsSent.has(key)) continue;

      console.log(`[Scheduler] Alerta ${invoice.alertLevel} para factura ${invoice.number} — ${invoice.daysOverdue} días`);

      await sendInvoiceAlert(invoice);
      alertsSent.set(key, new Date());
      alertsTriggered++;

      // Pequeña pausa para no saturar las APIs
      await new Promise(r => setTimeout(r, 1500));
    }

    console.log(`[Scheduler] Revisión completada — ${alertsTriggered} alertas enviadas`);

  } catch (err) {
    console.error('[Scheduler] Error en checkPendingInvoices:', err.message);
  }
}

// ─── Resumen diario ───────────────────────────────────────────────
async function runDailySummary() {
  console.log('[Scheduler] Enviando resumen diario...');
  try {
    const summary = await getSummary();
    await sendDailySummary(summary);
  } catch (err) {
    console.error('[Scheduler] Error en resumen diario:', err.message);
  }
}

// ─── Iniciar tareas ───────────────────────────────────────────────
function startScheduler() {
  console.log('[Scheduler] Iniciando tareas programadas...');

  // Revisar facturas pendientes cada 2 horas
  // Formato cron: minuto hora día-mes mes día-semana
  cron.schedule('0 */2 * * *', checkPendingInvoices, {
    timezone: 'Europe/Madrid'
  });

  // Resumen diario a las 8:30 de lunes a viernes
  cron.schedule('30 8 * * 1-5', runDailySummary, {
    timezone: 'Europe/Madrid'
  });

  // Limpieza semanal del registro de alertas (cada lunes a las 00:01)
  cron.schedule('1 0 * * 1', () => {
    console.log('[Scheduler] Limpiando registro de alertas...');
    alertsSent.clear();
  }, { timezone: 'Europe/Madrid' });

  console.log('[Scheduler] ✅ Tareas activas:');
  console.log('  → Revisión de facturas: cada 2 horas');
  console.log('  → Resumen diario: 08:30 lun-vie');

  // Primera ejecución inmediata al arrancar (con 10s de delay)
  setTimeout(() => {
    console.log('[Scheduler] Primera revisión inicial...');
    checkPendingInvoices();
  }, 10000);
}

module.exports = { startScheduler, checkPendingInvoices, runDailySummary };
