// src/asistente.js — Cerebro del asistente de WhatsApp.
// v4: ENRUTADOR (facturas / presupuestos / pedidos) + MEMORIA DE ALIAS.
//     Si no conoce un nombre ("bellpuig"), te pregunta, y al decírselo lo
//     guarda en MongoDB para siempre (alias -> cliente/familia canónico).
// PRINCIPIO: la IA interpreta intención y a quién te refieres; los datos
// (importes, conteos) salen SIEMPRE de StelOrder, nunca se inventan.

const stel = require('./stelorder');

const ultima    = new Map(); // from -> estado de paginación ("ver más")
const pendiente = new Map(); // from -> { accion:'aprender', aliasRaw, intent, ts }
const PAGINA = 10;

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}
function fmtEur(n) {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n || 0);
}
function esVerMas(t) {
  const n = norm(t);
  return ['ver mas', 'mas', 'el resto', 'los demas', 'las demas', 'siguientes',
          'continuar', 'continua', 'sigue', 'mostrar mas', 'dame mas',
          'mas facturas', 'ver el resto', 'resto'].includes(n);
}

// ── MongoDB: memoria de alias ─────────────────────────────────────
async function getDB() { return require('./db').getDB(); }

async function buscarAlias(aliasNorm) {
  if (!aliasNorm) return null;
  try {
    const db = await getDB();
    const doc = await db.collection('aliasClientes').findOne({ alias: aliasNorm });
    return doc ? { target: doc.target, scope: doc.scope } : null;
  } catch (e) { console.error('[Asistente] alias read:', e.message); return null; }
}
async function guardarAlias(aliasNorm, target, scope) {
  try {
    const db = await getDB();
    await db.collection('aliasClientes').updateOne(
      { alias: aliasNorm },
      { $set: { alias: aliasNorm, target, scope, updatedAt: new Date() } },
      { upsert: true }
    );
    console.log(`[Asistente] alias aprendido: "${aliasNorm}" -> ${target} (${scope})`);
  } catch (e) { console.error('[Asistente] alias write:', e.message); }
}

// ── Universo de nombres (todos los clientes y familias) ───────────
let _listasCache = null, _listasTs = 0;
async function listas() {
  if (_listasCache && Date.now() - _listasTs < 5 * 60 * 1000) return _listasCache;
  const { clientMap, families } = await stel.getClients();
  const clientes = [...new Set(Object.values(clientMap || {}).map(c => c && c.name).filter(Boolean))];
  const fams     = [...new Set((families || []).map(f => (f && f.name) || f).filter(Boolean))];
  _listasCache = { clientes, familias: fams }; _listasTs = Date.now();
  return _listasCache;
}

// ── IA ────────────────────────────────────────────────────────────
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
  } catch (e) { console.error('[Asistente] IA error:', e.message); return fallback; }
}

async function clasificar(texto) {
  const prompt = `Eres el asistente del dueño de una empresa de mantenimiento de fincas. Clasifica su pregunta.

Pregunta: "${texto}"

Responde SOLO un JSON válido, sin markdown:
{"intent":"facturas|presupuestos|pedidos|otro","scope":"cliente|familia|general","rawTarget":"nombre tal cual lo dice, o null"}

- intent "facturas": deudas, cobros, lo que deben, facturas pendientes, quién más debe.
- intent "presupuestos": presupuestos / ofertas (aceptados, pendientes, etc.).
- intent "pedidos": pedidos de trabajo, partes, trabajos abiertos o en curso.
- intent "otro": saludos o cosas que no encajan.
- scope "general": el total, todos, resumen, ranking. "cliente"/"familia": menciona uno concreto.
- rawTarget: el nombre del cliente/familia/sitio tal cual lo escribió, o null.`;
  return iaJson(prompt, 120, { intent: 'otro', scope: 'general', rawTarget: null });
}

async function elegirTarget(texto, candidatos) {
  if (!candidatos.length) return null;
  const prompt = `El usuario pregunta: "${texto}"

Elige a cuál de esta lista se refiere (copia EXACTO, o null si ninguno):
${candidatos.slice(0, 150).join('\n')}

Responde SOLO JSON: {"target":"nombre EXACTO de la lista, o null"}`;
  const out = await iaJson(prompt, 60, { target: null });
  return out.target || null;
}

// Resuelve a qué cliente/familia se refiere (alias -> código -> IA).
// Devuelve { scope:'cliente'|'familia'|null, target:string|null }
async function resolver(texto, rawTarget) {
  const raw = norm(rawTarget || '');
  if (raw) { const a = await buscarAlias(raw); if (a) return { scope: a.scope, target: a.target }; }

  const { clientes, familias } = await listas();
  const r = raw || norm(texto);

  let mf = familias.filter(c => norm(c) === r); if (mf.length === 1) return { scope: 'familia', target: mf[0] };
  let mc = clientes.filter(c => norm(c) === r); if (mc.length === 1) return { scope: 'cliente', target: mc[0] };

  mf = familias.filter(c => norm(c).includes(r) || r.includes(norm(c)));
  mc = clientes.filter(c => norm(c).includes(r) || r.includes(norm(c)));
  if (mf.length === 1 && mc.length === 0) return { scope: 'familia', target: mf[0] };
  if (mc.length === 1 && mf.length === 0) return { scope: 'cliente', target: mc[0] };

  const union = [...new Set([...mf, ...mc])];
  const cand = union.length ? union : [...familias, ...clientes];
  const t = await elegirTarget(texto, cand);
  if (!t) return { scope: null, target: null };
  return { scope: familias.includes(t) ? 'familia' : 'cliente', target: t };
}

// Mensaje cuando no encuentra el cliente: si dijo un nombre, lo aprendemos
function noEncontrado(from, rawTarget, intent) {
  if (rawTarget) {
    pendiente.set(from, { accion: 'aprender', aliasRaw: rawTarget, intent, ts: Date.now() });
    return `🤔 No conozco *"${rawTarget}"*. ¿A qué cliente corresponde? Dímelo (p. ej. "es Illa Verda") y lo recuerdo.`;
  }
  return '🤔 No tengo claro de qué cliente me hablas. Prueba con el nombre, p. ej.: *"¿qué debe Illa Verda?"*';
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

// ── Handlers ──────────────────────────────────────────────────────
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

  const { scope: sc, target } = await resolver(texto, rawTarget);
  if (!target) return noEncontrado(from, rawTarget, 'facturas');
  const sel = pend.filter(i => norm(i[sc === 'familia' ? 'family' : 'client']) === norm(target))
                  .sort((a, b) => (b.daysOverdue || 0) - (a.daysOverdue || 0));
  if (!sel.length) return `✅ ${target} no tiene facturas pendientes.`;
  const total = sel.reduce((s, i) => s + (i.pending || 0), 0);
  const tit = sc === 'familia' ? `Familia: ${target}` : target;
  return pintar(from, {
    items: sel, titulo: tit,
    encabezado: `📋 *${tit}*\n💰 Pendiente: *${fmtEur(total)}* · ${sel.length} factura(s)`,
    fmt: i => `• ${i.number} — *${fmtEur(i.pending)}*${i.daysOverdue ? ` · ${i.daysOverdue}d` : ''}`
  }, 0);
}

// Detecta si el usuario nombra un estado concreto de presupuesto
function detectarEstado(t) {
  const n = norm(t);
  if (/aceptad/.test(n))  return 'accepted';
  if (/rechazad/.test(n)) return 'rejected';
  if (/cerrad/.test(n))   return 'closed';
  if (/pendient/.test(n)) return 'pending';
  return null;
}
const ESTADO_ES = { accepted: 'aceptados', pending: 'pendientes', closed: 'cerrados', rejected: 'rechazados' };

async function handlerPresupuestos(texto, from, scope, rawTarget) {
  let s;
  try { s = await stel.getEstimatesSummary(); }
  catch (e) { console.error('[Asistente]', e.message); return '⚠️ No pude consultar los presupuestos. Prueba en un momento.'; }

  const estado = detectarEstado(texto);

  // Sin cliente concreto: o listamos un estado, o damos el resumen
  if (scope !== 'cliente' && scope !== 'familia') {
    if (estado) {
      const arr = [...(s[estado] || [])].sort((a, b) => (b.total || 0) - (a.total || 0));
      const etiqueta = ESTADO_ES[estado];
      if (!arr.length) return `No hay presupuestos ${etiqueta}.`;
      const tot = arr.reduce((x, i) => x + (i.total || 0), 0);
      return pintar(from, {
        items: arr, titulo: `Presupuestos ${etiqueta}`,
        encabezado: `📊 *Presupuestos ${etiqueta}: ${arr.length}* (${fmtEur(tot)})`,
        fmt: i => `• ${i.ref || i.number} — ${i.client} — *${fmtEur(i.total)}*`
      }, 0);
    }
    ultima.delete(from);
    return `📊 *Presupuestos*\n\n` +
      `✅ Aceptados: *${s.accepted.length}* (${fmtEur(s.totalAccepted)})\n` +
      `⏳ Pendientes: *${s.pending.length}* (${fmtEur(s.totalPending)})\n` +
      `📁 Cerrados: ${s.closed.length}\n` +
      `❌ Rechazados: ${s.rejected.length}\n\n` +
      `Pregúntame por un estado ("los aceptados") o por un cliente ("presupuestos de Illa Verda").`;
  }

  // Cliente/familia concreto (opcionalmente filtrado por estado)
  const { scope: sc, target } = await resolver(texto, rawTarget);
  if (!target) return noEncontrado(from, rawTarget, 'presupuestos');
  let sel = (s.all || []).filter(i => norm(i[sc === 'familia' ? 'family' : 'client']) === norm(target));
  if (estado) sel = sel.filter(i => i.stateKey === estado);
  sel.sort((a, b) => (b.daysOld || 0) - (a.daysOld || 0));
  const suf = estado ? ` ${ESTADO_ES[estado]}` : '';
  if (!sel.length) return `No encuentro presupuestos${suf} de ${target}.`;
  return pintar(from, {
    items: sel, titulo: `Presupuestos${suf} — ${target}`,
    encabezado: `📊 *Presupuestos${suf} — ${target}*\n${sel.length} presupuesto(s)`,
    fmt: i => `• ${i.ref || i.number} — ${i.stateLabel} — *${fmtEur(i.total)}*`
  }, 0);
}

async function handlerPedidos(texto, from, scope, rawTarget) {
  let live;
  try { live = await stel.getWorkOrdersLive(); }
  catch (e) { console.error('[Asistente]', e.message); return '⚠️ No pude consultar los pedidos. Prueba en un momento.'; }
  if (!live || live.length === 0) return '✅ No hay pedidos de trabajo abiertos ahora mismo.';

  if (scope === 'general') {
    const ordenados = [...live].sort((a, b) => (b.days || 0) - (a.days || 0));
    return pintar(from, {
      items: ordenados, titulo: 'Pedidos abiertos',
      encabezado: `🔧 *Pedidos de trabajo abiertos: ${live.length}*`,
      fmt: i => `• ${i.number} — ${i.client} · ${i.days || 0}d`
    }, 0);
  }

  const { scope: sc, target } = await resolver(texto, rawTarget);
  if (!target) return noEncontrado(from, rawTarget, 'pedidos');
  const sel = live.filter(i => norm(i[sc === 'familia' ? 'family' : 'client']) === norm(target))
                  .sort((a, b) => (b.days || 0) - (a.days || 0));
  if (!sel.length) return `✅ ${target} no tiene pedidos de trabajo abiertos.`;
  return pintar(from, {
    items: sel, titulo: `Pedidos — ${target}`,
    encabezado: `🔧 *Pedidos abiertos — ${target}*\n${sel.length} pedido(s)`,
    fmt: i => `• ${i.number} — ${i.days || 0}d${i.state ? ` (${i.state})` : ''}`
  }, 0);
}

function despachar(intent, from, scope, target) {
  if (intent === 'presupuestos') return handlerPresupuestos(`presupuestos de ${target}`, from, scope, target);
  if (intent === 'pedidos')      return handlerPedidos(`pedidos de ${target}`, from, scope, target);
  return handlerFacturas(`${target}`, from, scope, target);
}

// ── Punto de entrada ──────────────────────────────────────────────
async function responderConsulta(texto, from = 'anon') {
  // A) ¿Estábamos aprendiendo un alias? La respuesta es el nombre real.
  const pend = pendiente.get(from);
  if (pend && pend.accion === 'aprender' && (Date.now() - pend.ts) < 10 * 60 * 1000) {
    const limpio = String(texto).replace(/^\s*(es|son|el|la|los|las|de|del)\s+/i, '').trim();
    const { scope, target } = await resolver(limpio, limpio);
    if (target) {
      await guardarAlias(norm(pend.aliasRaw), target, scope);
      pendiente.delete(from);
      const respuesta = await despachar(pend.intent, from, scope, target);
      return `✅ Apuntado: *${pend.aliasRaw}* = *${target}*\n\n${respuesta}`;
    }
    pendiente.delete(from); // no era un cliente; seguimos como consulta normal
  }

  // B) "ver más"
  if (esVerMas(texto)) {
    const prev = ultima.get(from);
    if (prev && prev.mostradas < prev.items.length) return pintar(from, prev, prev.mostradas);
    return 'No tengo nada más que mostrar 🙂 Pregúntame por un cliente, p. ej.: *"¿qué debe Illa Verda?"*';
  }

  // C) Enrutador
  const { intent, scope, rawTarget } = await clasificar(texto);
  if (intent === 'facturas')     return handlerFacturas(texto, from, scope, rawTarget);
  if (intent === 'presupuestos') return handlerPresupuestos(texto, from, scope, rawTarget);
  if (intent === 'pedidos')      return handlerPedidos(texto, from, scope, rawTarget);

  return `👋 Puedo ayudarte con:\n\n` +
    `💰 *Facturas pendientes* — "¿qué debe Illa Verda?" · "cuánto me deben en total"\n` +
    `📊 *Presupuestos* — "cómo vamos de presupuestos" · "presupuestos de Cinc"\n` +
    `🔧 *Pedidos de trabajo* — "cuántos pedidos tenemos" · "pedidos de Illa Verda"\n\n` +
    `Y si te equivocas con un nombre, te pregunto y lo recuerdo. 🧠`;
}

module.exports = { responderConsulta };
