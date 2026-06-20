// src/avisos-proactivo.js — Construye el resumen de "cosas a revisar":
// facturas vencidas sin cobrar + presupuestos aceptados sin cerrar.
// Solo LEE datos de StelOrder (no envía nada, no escribe nada).
const { getPendingInvoices, getEstimatesSummary } = require('./stelorder');

// Formato de euros manual (Railway no tiene ICU completo → evitamos Intl).
function fmtEur(n) {
  const x = (Number(n) || 0).toFixed(2);
  const [ent, dec] = x.split('.');
  return ent.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + dec + ' €';
}

async function construirAviso(opts = {}) {
  const diasUmbral = parseInt(opts.dias      || process.env.AVISO_DIAS_VENCIDA || 60, 10);
  const diasPresu  = parseInt(opts.diasPresu || process.env.AVISO_DIAS_PRESU   || 15, 10);

  const [pending, est] = await Promise.all([
    getPendingInvoices().catch(() => []),
    getEstimatesSummary().catch(() => ({ accepted: [] }))
  ]);

  const vencidas = (pending || [])
    .filter(i => (i.daysOverdue || 0) >= diasUmbral)
    .sort((a, b) => (b.daysOverdue || 0) - (a.daysOverdue || 0));
  const totalVencido = vencidas.reduce((s, i) => s + (i.pending || 0), 0);

  const aceptados = (est.accepted || [])
    .filter(e => (e.daysOld || 0) >= diasPresu)
    .sort((a, b) => (b.daysOld || 0) - (a.daysOld || 0));

  const hayAlgo = vencidas.length > 0 || aceptados.length > 0;

  let texto = `🔔 *Cosas a revisar*\n`;
  if (!hayAlgo) {
    texto += `\n✅ Nada urgente: sin facturas vencidas (+${diasUmbral}d) ni presupuestos aceptados parados.`;
    return { texto, hayAlgo, nVencidas: 0, totalVencido: 0 };
  }
  if (vencidas.length) {
    texto += `\n💰 *Sin cobrar (+${diasUmbral} días): ${vencidas.length}* — total *${fmtEur(totalVencido)}*\n`;
    texto += vencidas.slice(0, 6)
      .map(i => `• ${i.number} · ${i.client} — ${fmtEur(i.pending || 0)} _(${i.daysOverdue}d)_`)
      .join('\n');
    if (vencidas.length > 6) texto += `\n…y ${vencidas.length - 6} más.`;
  }
  if (aceptados.length) {
    texto += `\n\n📐 *Presupuestos aceptados sin cerrar (+${diasPresu}d): ${aceptados.length}*\n`;
    texto += aceptados.slice(0, 5)
      .map(e => `• ${e.ref} · ${e.client} — ${fmtEur(e.total || 0)} _(${e.daysOld}d)_`)
      .join('\n');
    if (aceptados.length > 5) texto += `\n…y ${aceptados.length - 5} más.`;
    texto += `\n_Revisa si ya están convertidos en pedido._`;
  }
  return { texto, hayAlgo, nVencidas: vencidas.length, totalVencido };
}

module.exports = { construirAviso };
