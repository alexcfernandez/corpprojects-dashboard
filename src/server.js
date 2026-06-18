// src/asistente.js — Cerebro del asistente de WhatsApp.
// v3: ENRUTADOR. Entiende qué tipo de pregunta es (facturas / presupuestos /
//     pedidos) y responde por el cajón correcto. + formato + "ver más" + variantes.
// PRINCIPIO: la IA solo INTERPRETA la intención y a qué cliente te refieres;
// los datos (importes, conteos) salen SIEMPRE de StelOrder, nunca se inventan.

const stel = require('./stelorder');

// Memoria de la última lista mostrada por número (para "ver más").
const ultima = new Map(); // from -> { items, titulo, encabezado, fmt, mostradas }
const PAGINA = 10;

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}
function fmtEur(n) {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n || 0);
}

// "ver más" ESTRICTO: solo si el mensaje ES exactamente eso (no cualquier frase con "más")
function esVerMas(t) {
  const n = norm(t);
  return ['ver mas', 'mas', 'el resto', 'los demas', 'las demas', 'siguientes',
          'continuar', 'continua', 'sigue', 'mostrar mas', 'dame mas',
          'mas facturas', 'ver el resto', 'resto'].includes(n);
}

// ── IA #1: clasifica la intención ────────────────────────────────
async function clasificar(texto) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { intent: 'facturas', scope: 'general', rawTarget: null };

  const prompt = `Eres el asistente del dueño de una empresa de mantenimiento de fincas. Clasifica su pregunta.

Pregunta: "${texto}"

Responde SOLO un JSON válido, sin markdown:
{"intent":"facturas|presupuestos|pedidos|otro","scope":"cliente|familia|general","rawTarget":"nombre tal cual lo dice, o null"}

- intent "facturas": deudas, cobros, lo que deben, facturas pendientes, quién más debe.
- intent "presupuestos": presupuestos / ofertas (aceptados, pendientes, etc.).
- intent "pedidos": pedidos de trabajo, partes, trabajos abiertos o en curso.
- intent "otro": saludos o cosas que no encajan.
- scope "general": el total, todos, resumen, ranking. "cliente"/"familia": menciona uno concreto.
- rawTarget: el nombre del cliente/familia tal cual lo escribió, o null.`;

  return iaJson(prompt, 120, { intent: 'otro', scope: 'general', rawTarget: null });
}

// ── IA #2 (fallback): elige el nombre EXACTO de una lista ─────────
async function elegirTarget(texto, candidatos) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !candidatos.length) return null;
  const prompt = `El usuario pregunta: "${texto}"

Elige a cuál de esta lista se refiere (copia EXACTO, o null si ninguno):
${candidatos.slice(0, 150).join('\n')}

Responde SOLO JSON: {"target":"nombre EXACTO de la lista, o null"}`;
  const out = await iaJson(prompt, 60, { target: null });
  return out.target || null;
}

// Llamada genérica a Haiku que espera JSON
async function iaJson(prompt, maxTokens, fallback) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return fallback;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.EMAIL_IA_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`API ${r.status}: ${JSON.stringify(data).slice(0, 150)}`);
    const txt = (data.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim();
    return JSON.parse(txt);
  } catch (e) {
    console.error('[Asistente] IA error:', e.message);
    return fallback;
  }
}

// Resuelve a qué cliente/familia se refiere, mirando las listas reales del dataset.
// Devuelve { scope:'cliente'|'familia'|null, target:string|null }
async function resolver(texto, rawTarget, items) {
  const clientes = [...new Set(items.map(i => i.client).filter(Boolean))];
  const familias = [...new Set(items.map(i => i.family).filter(Boolean))];
  const r = norm(rawTarget || texto);

  // exacto
  let mf = familias.filter(c => norm(c) === r);
  if (mf.length === 1) return { scope: 'familia', target: mf[0] };
  let mc = clientes.filter(c => norm(c) === r);
  if (mc.length === 1) return { scope: 'cliente', target: mc[0] };

  // contiene (en un sentido u otro)
  mf = familias.filter(c => norm(c).includes(r) || r.includes(norm(c)));
  mc = clientes.filter(c => norm(c).includes(r) || r.includes(norm(c)));
  if (mf.length === 1 && mc.length === 0) return { scope: 'familia', target: mf[0] };
  if (mc.length === 1 && mf.length === 0) return { scope: 'cliente', target: mc[0] };

  // ambiguo o nada → IA sobre los candidatos
  const union = [...new Set([...mf, ...mc])];
  const cand = union.length ? union : [...familias, ...clientes];
  const t = await elegirTarget(texto, cand);
  if (!t) return { scope: null, target: null };
  return { scope: familias.includes(t) ? 'familia' : 'cliente', target: t };
}

// ── Paginado genérico ─────────────────────────────────────────────
function pintar(from, estado, desde) {
  const { items, titulo, encabezado, fmt } = estado;
  const trozo = items.slice(desde, desde + PAGINA);
  const restantes = items.length - (desde + trozo.length);
  let msg = desde === 0 ? `${encabezado}\n\n` : `📋 *${titulo}* (continuación)\n\n`;
  msg += trozo.map(fmt).join('\n');
  if (restantes > 0) msg += `\n\n…y ${restantes} más. Responde *"ver más"* para seguir.`;
  ultima.set(from, { ...estado, mostradas: desde + trozo.length });
  return msg;
}

// ── Handler: FACTURAS ─────────────────────────────────────────────
async function handlerFacturas(texto, from, scope, rawTarget) {
  let pend;
  try { pend = await stel.getPendingInvoices(); }
  catch (e) { console.error('[Asistente]', e.message); return '⚠️ No pude consultar StelOrder. Prueba en un momento.'; }
  if (!pend || pend.length === 0) return '✅ No hay facturas pendientes ahora mismo.';

  if (scope === 'general') {
    const total = pend.reduce((s, i) => s + (i.pending || 0), 0);
    const porCli = {};
    pend.forEach(i => { const c = i.client || '(sin nombre)'; porCli[c] = (porCli[c] || 0) + (i.pending || 0); });
    const rank = Object.entries(porCli).sort((a, b) => b[1] - a[1]);
    const top = rank.slice(0, 8).map(([c, v]) => `• ${c} — *${fmtEur(v)}*`);
    let msg = `💰 *Total pendiente: ${fmtEur(total)}*\n${pend.length} facturas · ${rank.length} clientes\n\n*Quién más debe:*\n${top.join('\n')}`;
    if (rank.length > 8) msg += `\n…y ${rank.length - 8} clientes más.`;
    msg += `\n\nPregúntame por uno, p. ej.: *"¿qué debe Illa Verda?"*`;
    ultima.delete(from);
    return msg;
  }

  const { scope: sc, target } = await resolver(texto, rawTarget, pend);
  if (!target) return '🤔 No tengo claro de qué cliente me hablas. Prueba con el nombre, p. ej.: *"¿qué debe Illa Verda?"*';
  const sel = pend.filter(i => norm(i[sc === 'familia' ? 'family' : 'client']) === norm(target))
                  .sort((a, b) => (b.daysOverdue || 0) - (a.daysOverdue || 0));
  if (!sel.length) return `✅ ${target} no tiene facturas pendientes.`;
  const total = sel.reduce((s, i) => s + (i.pending || 0), 0);
  return pintar(from, {
    items: sel,
    titulo: sc === 'familia' ? `Familia: ${target}` : target,
    encabezado: `📋 *${sc === 'familia' ? 'Familia: ' + target : target}*\n💰 Pendiente: *${fmtEur(total)}* · ${sel.length} factura(s)`,
    fmt: i => `• ${i.number} — *${fmtEur(i.pending)}*${i.daysOverdue ? ` · ${i.daysOverdue}d` : ''}`
  }, 0);
}

// ── Handler: PRESUPUESTOS ─────────────────────────────────────────
async function handlerPresupuestos(texto, from, scope, rawTarget) {
  let s;
  try { s = await stel.getEstimatesSummary(); }
  catch (e) { console.error('[Asistente]', e.message); return '⚠️ No pude consultar los presupuestos. Prueba en un momento.'; }

  if (scope === 'general') {
    ultima.delete(from);
    return `📊 *Presupuestos*\n\n` +
      `✅ Aceptados: *${s.accepted.length}* (${fmtEur(s.totalAccepted)})\n` +
      `⏳ Pendientes: *${s.pending.length}* (${fmtEur(s.totalPending)})\n` +
      `📁 Cerrados: ${s.closed.length}\n` +
      `❌ Rechazados: ${s.rejected.length}\n\n` +
      `Pregúntame por un cliente, p. ej.: *"presupuestos de Illa Verda"*`;
  }

  const { scope: sc, target } = await resolver(texto, rawTarget, s.all);
  if (!target) return '🤔 No tengo claro de qué cliente me hablas para los presupuestos.';
  const sel = (s.all || []).filter(i => norm(i[sc === 'familia' ? 'family' : 'client']) === norm(target))
                           .sort((a, b) => (b.daysOld || 0) - (a.daysOld || 0));
  if (!sel.length) return `No encuentro presupuestos de ${target}.`;
  return pintar(from, {
    items: sel,
    titulo: `Presupuestos — ${target}`,
    encabezado: `📊 *Presupuestos — ${target}*\n${sel.length} presupuesto(s)`,
    fmt: i => `• ${i.ref || i.number} — ${i.stateLabel} — *${fmtEur(i.total)}*`
  }, 0);
}

// ── Handler: PEDIDOS (trabajos abiertos) ──────────────────────────
async function handlerPedidos(texto, from, scope, rawTarget) {
  let live;
  try { live = await stel.getWorkOrdersLive(); }
  catch (e) { console.error('[Asistente]', e.message); return '⚠️ No pude consultar los pedidos. Prueba en un momento.'; }
  if (!live || live.length === 0) return '✅ No hay pedidos de trabajo abiertos ahora mismo.';

  if (scope === 'general') {
    const ordenados = [...live].sort((a, b) => (b.days || 0) - (a.days || 0));
    return pintar(from, {
      items: ordenados,
      titulo: 'Pedidos abiertos',
      encabezado: `🔧 *Pedidos de trabajo abiertos: ${live.length}*`,
      fmt: i => `• ${i.number} — ${i.client} · ${i.days || 0}d`
    }, 0);
  }

  const { scope: sc, target } = await resolver(texto, rawTarget, live);
  if (!target) return '🤔 No tengo claro de qué cliente me hablas para los pedidos.';
  const sel = live.filter(i => norm(i[sc === 'familia' ? 'family' : 'client']) === norm(target))
                  .sort((a, b) => (b.days || 0) - (a.days || 0));
  if (!sel.length) return `✅ ${target} no tiene pedidos de trabajo abiertos.`;
  return pintar(from, {
    items: sel,
    titulo: `Pedidos — ${target}`,
    encabezado: `🔧 *Pedidos abiertos — ${target}*\n${sel.length} pedido(s)`,
    fmt: i => `• ${i.number} — ${i.days || 0}d${i.state ? ` (${i.state})` : ''}`
  }, 0);
}

// ── Punto de entrada ──────────────────────────────────────────────
async function responderConsulta(texto, from = 'anon') {
  // 1) "ver más"
  if (esVerMas(texto)) {
    const prev = ultima.get(from);
    if (prev && prev.mostradas < prev.items.length) return pintar(from, prev, prev.mostradas);
    return 'No tengo nada más que mostrar 🙂 Pregúntame por un cliente, p. ej.: *"¿qué debe Illa Verda?"*';
  }

  // 2) Enrutador: ¿qué tipo de pregunta es?
  const { intent, scope, rawTarget } = await clasificar(texto);

  if (intent === 'facturas')     return handlerFacturas(texto, from, scope, rawTarget);
  if (intent === 'presupuestos') return handlerPresupuestos(texto, from, scope, rawTarget);
  if (intent === 'pedidos')      return handlerPedidos(texto, from, scope, rawTarget);

  // 3) No encaja → ayuda
  return `👋 Puedo ayudarte con:\n\n` +
    `💰 *Facturas pendientes* — "¿qué debe Illa Verda?" · "cuánto me deben en total"\n` +
    `📊 *Presupuestos* — "cómo vamos de presupuestos" · "presupuestos de Cinc"\n` +
    `🔧 *Pedidos de trabajo* — "cuántos pedidos tenemos" · "pedidos de Illa Verda"`;
}

module.exports = { responderConsulta };
