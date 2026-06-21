// src/avisos-proactivo.js — Construye el resumen de "cosas a revisar":
// facturas vencidas sin cobrar + presupuestos aceptados sin cerrar.
// Solo LEE datos de StelOrder. La marca "en gestión" oculta morosos de ESTE
// aviso de WhatsApp (no afecta a los correos de impago al cliente).
const { getPendingInvoices, getEstimatesSummary } = require('./stelorder');
const { getDB } = require('./db');

function normTxt(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim(); }
function digitos(s) { const m = String(s || '').match(/\d+/g); return m ? String(parseInt(m.join(''), 10)) : ''; }

// Formato de euros manual (Railway no tiene ICU completo → evitamos Intl).
function fmtEur(n) {
  const x = (Number(n) || 0).toFixed(2);
  const [ent, dec] = x.split('.');
  return ent.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + dec + ' €';
}

// ── "En gestión" (judicial/Paypymes): solo oculta del aviso de WhatsApp ──
async function getGestion() {
  try { const db = await getDB(); return await db.collection('morososGestion').find({}).toArray(); }
  catch (e) { return []; }
}
async function marcarGestion(tipo, valor, clave, motivo) {
  const k = clave || normTxt(valor);
  if (!k) return false;
  try {
    const db = await getDB();
    const set = { tipo, clave: k, valor, updatedAt: new Date() };
    if (motivo) set.motivo = motivo;
    await db.collection('morososGestion').updateOne(
      { tipo, clave: k },
      { $set: set },
      { upsert: true }
    );
    return true;
  } catch (e) { return false; }
}
async function desmarcarGestion(tipo, clave) {
  try { const db = await getDB(); const r = await db.collection('morososGestion').deleteOne({ tipo, clave }); return r.deletedCount > 0; }
  catch (e) { return false; }
}

async function construirAviso(opts = {}) {
  const diasUmbral = parseInt(opts.dias      || process.env.AVISO_DIAS_VENCIDA || 60, 10);
  const diasPresu  = parseInt(opts.diasPresu || process.env.AVISO_DIAS_PRESU   || 15, 10);

  const [pending, est, gest] = await Promise.all([
    getPendingInvoices().catch(() => []),
    getEstimatesSummary().catch(() => ({ accepted: [] })),
    getGestion()
  ]);

  const cliGest = new Set(gest.filter(g => g.tipo === 'cliente').map(g => g.clave));
  const facGest = new Set(gest.filter(g => g.tipo === 'factura').map(g => g.clave));
  const enGestion = i => cliGest.has(normTxt(i.client)) || facGest.has(digitos(i.number));

  const todasVencidas = (pending || [])
    .filter(i => (i.daysOverdue || 0) >= diasUmbral)
    .sort((a, b) => (b.daysOverdue || 0) - (a.daysOverdue || 0));
  const vencidas = todasVencidas.filter(i => !enGestion(i));
  const nOcultas = todasVencidas.length - vencidas.length;
  const totalVencido = vencidas.reduce((s, i) => s + (i.pending || 0), 0);

  const aceptados = (est.accepted || [])
    .filter(e => (e.daysOld || 0) >= diasPresu)
    .sort((a, b) => (b.daysOld || 0) - (a.daysOld || 0));

  const hayAlgo = vencidas.length > 0 || aceptados.length > 0;

  let texto = `🔔 *Cosas a revisar*\n`;
  if (!hayAlgo) {
    texto += `\n✅ Nada nuevo que perseguir: sin facturas vencidas (+${diasUmbral}d) ni presupuestos aceptados parados.`;
    if (nOcultas) texto += `\n🔕 (${nOcultas} en gestión, ocultas — siguen recibiendo correos.)`;
    return { texto, hayAlgo, nVencidas: 0, totalVencido: 0, nOcultas };
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
  if (nOcultas) texto += `\n\n🔕 ${nOcultas} en gestión (ocultas — siguen recibiendo correos).`;
  return { texto, hayAlgo, nVencidas: vencidas.length, totalVencido, nOcultas };
}

// ── Panel de cobros: prioriza a quién reclamar (tiempo × importe) ──
// Agrupa por cliente. No filtra por importe ("hay que reclamar todos");
// el importe solo ordena dentro de cada nivel. Excluye lo marcado "en gestión".
async function construirCobros(opts = {}) {
  const diasRojo    = parseInt(opts.diasRojo    || process.env.COBROS_DIAS_ROJO    || 365, 10);
  const diasNaranja = parseInt(opts.diasNaranja || process.env.COBROS_DIAS_NARANJA || 200, 10);

  const [pending, gest] = await Promise.all([getPendingInvoices().catch(() => []), getGestion()]);
  const cliGest = new Set(gest.filter(g => g.tipo === 'cliente').map(g => g.clave));
  const facGest = new Set(gest.filter(g => g.tipo === 'factura').map(g => g.clave));

  const porCli = {};
  let nGestion = 0;
  for (const i of (pending || [])) {
    if (facGest.has(digitos(i.number)) || cliGest.has(normTxt(i.client))) { nGestion++; continue; }
    const k = i.client || '—';
    if (!porCli[k]) porCli[k] = { cliente: k, total: 0, n: 0, maxDias: 0 };
    porCli[k].total += (i.pending || 0);
    porCli[k].n++;
    porCli[k].maxDias = Math.max(porCli[k].maxDias, i.daysOverdue || 0);
  }
  const clientes = Object.values(porCli);
  const rojo     = clientes.filter(c => c.maxDias >= diasRojo).sort((a, b) => b.total - a.total);
  const naranja  = clientes.filter(c => c.maxDias >= diasNaranja && c.maxDias < diasRojo).sort((a, b) => b.total - a.total);
  const amarillo = clientes.filter(c => c.maxDias < diasNaranja).sort((a, b) => b.total - a.total);
  const totalTodo = clientes.reduce((s, c) => s + c.total, 0);

  const linea = c => `• ${c.cliente} — *${fmtEur(c.total)}*${c.n > 1 ? ` _(${c.n} fras)_` : ''} · ${c.maxDias}d`;
  const bloque = (emoji, titulo, arr, tope) => {
    if (!arr.length) return '';
    const sub = arr.reduce((s, c) => s + c.total, 0);
    let s = `\n\n${emoji} *${titulo} — ${arr.length}* _(${fmtEur(sub)})_:\n` + arr.slice(0, tope).map(linea).join('\n');
    if (arr.length > tope) s += `\n…y ${arr.length - tope} más.`;
    return s;
  };

  let msg = `💸 *Cobros — a quién reclamar*\n_Pendiente total: ${fmtEur(totalTodo)} · ${clientes.length} clientes_`;
  if (!clientes.length) {
    msg += `\n\n✅ Nada que reclamar fuera de lo que ya tienes en gestión.`;
  } else {
    msg += bloque('🔴', `Derivar ya (+${diasRojo}d)`, rojo, 12);
    msg += bloque('🟠', `Apretar (${diasNaranja}-${diasRojo}d)`, naranja, 8);
    msg += bloque('🟡', `Vigilar (<${diasNaranja}d)`, amarillo, 5);
  }
  if (nGestion) msg += `\n\n🔕 ${nGestion} factura(s) en gestión, ocultas.`;
  return { texto: msg, rojo, naranja, amarillo, totalTodo };
}

module.exports = { construirAviso, construirCobros, getGestion, marcarGestion, desmarcarGestion, normTxt, digitos };
