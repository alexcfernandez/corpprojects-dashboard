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

// ── Handler: CONCEPTOS / DETALLE de un presupuesto concreto ───────
async function handlerDetalle(numero, from) {
  let ests;
  try { ests = await stel.getWorkEstimates(); }
  catch (e) { console.error('[Asistente]', e.message); return '⚠️ No pude consultar el presupuesto. Prueba en un momento.'; }

  const qNum = parseInt(String(numero).replace(/\D/g, ''), 10);
  const e = (ests || []).find(x => {
    const ref = String(x['full-reference'] || x.reference || x.number || '');
    return parseInt(ref.replace(/\D/g, ''), 10) === qNum || String(x.id) === String(numero);
  });
  if (!e) return `No encuentro el presupuesto ${numero}. Prueba con la referencia completa, p. ej. *"conceptos del PRT00509"*.`;

  const ref = e['full-reference'] || e.reference || e.number || `#${e.id}`;
  const lines = Array.isArray(e.lines) ? e.lines.filter(l => !l.deleted) : [];
  if (!lines.length) return `📄 *${ref}* no tiene líneas de detalle.`;

  const fmtLinea = l => {
    const nombre = [l['item-name'], l['item-description']].filter(Boolean).join(' — ') || '(sin descripción)';
    const u = Number(l['units'] ?? l['quantity']);
    let imp = Number(l['total-amount']);
    if (!Number.isFinite(imp)) {
      const p = Number(l['unit-price'] ?? l['price']);
      if (Number.isFinite(u) && Number.isFinite(p)) imp = u * p;
    }
    const cant = Number.isFinite(u) && u && u !== 1 ? `${u} × ` : '';
    const dinero = Number.isFinite(imp) && imp ? ` — *${fmtEur(imp)}*` : '';
    return `• ${cant}${nombre}${dinero}`;
  };
  const tot = Number(e['total-amount']) || 0;
  return pintar(from, {
    items: lines, titulo: `Conceptos ${ref}`,
    encabezado: `📄 *${ref} — Conceptos*${tot ? `\nTotal: *${fmtEur(tot)}*` : ''}`,
    fmt: fmtLinea
  }, 0);
}

// ── Resumen GLOBAL del negocio ("resumen") ────────────────────────
function esResumenGlobal(t) {
  const n = norm(t);
  return ['resumen', 'el resumen', 'resumen general', 'resumen del negocio', 'panorama',
          'vista general', 'estado general', 'como vamos', 'como va el negocio',
          'como va todo', 'como esta todo', 'como va esto', 'como vamos de todo'].includes(n);
}
async function handlerResumenGlobal(from) {
  const [pend, est, live] = await Promise.all([
    stel.getPendingInvoices().catch(() => []),
    stel.getEstimatesSummary().catch(() => null),
    stel.getWorkOrdersLive().catch(() => [])
  ]);
  const deuda = (pend || []).reduce((s, i) => s + (i.pending || 0), 0);
  const nCli = new Set((pend || []).map(i => i.client).filter(Boolean)).size;

  let msg = `📌 *Resumen del negocio*\n\n`;
  msg += `💰 Pendiente de cobro: *${fmtEur(deuda)}*\n   ${(pend || []).length} facturas · ${nCli} clientes\n`;
  if (est) msg += `📊 Presupuestos: *${est.accepted.length}* aceptados (${fmtEur(est.totalAccepted)}) · ${est.pending.length} pendientes\n`;
  msg += `🔧 Pedidos abiertos: *${(live || []).length}*`;

  if (pend && pend.length) {
    const porCli = {};
    pend.forEach(i => { const c = i.client || '?'; porCli[c] = (porCli[c] || 0) + (i.pending || 0); });
    const top = Object.entries(porCli).sort((a, b) => b[1] - a[1])[0];
    if (top) msg += `\n\n🔝 Quien más debe: ${top[0]} (${fmtEur(top[1])})`;
  }
  msg += `\n\nPide detalle: *"los aceptados"* · *"resumen de Illa Verda"* · *"cuántos pedidos tenemos"*.`;
  ultima.delete(from);
  return msg;
}

// ── Ficha rápida de un cliente (deuda + presupuestos + pedidos) ────
function detectarFicha(texto) {
  const n = norm(texto);
  const m = n.match(/^(?:resumen de|ficha rapida de|ficha de|ficha|como va|como esta|como estan|todo de|todo lo de)\s+(.+)$/);
  if (!m) return null;
  const objetivo = m[1].trim();
  // No es ficha si lo de detrás es una sección, no un cliente
  if (/factura|presupuesto|pedido|deuda|cobr|aceptad|pendient|rechazad|cerrad/.test(objetivo)) return null;
  if (['todo', 'esto', 'la cosa', 'las cosas', 'el negocio', 'negocio'].includes(objetivo)) return null;
  return objetivo;
}
async function handlerFicha(texto, from, rawTarget) {
  const { scope, target } = await resolver(rawTarget || texto, rawTarget || texto);
  if (!target) {
    if (rawTarget) {
      pendiente.set(from, { accion: 'aprender', aliasRaw: rawTarget, intent: 'ficha', ts: Date.now() });
      return `🤔 No conozco *"${rawTarget}"*. ¿A qué cliente corresponde? Dímelo (p. ej. "es Illa Verda") y lo recuerdo.`;
    }
    return '🤔 ¿De qué cliente quieres la ficha? Prueba: *"resumen de Illa Verda"*.';
  }
  return fichaDe(scope, target, from);
}
async function fichaDe(scope, target, from) {
  const campo = scope === 'familia' ? 'family' : 'client';
  const [pend, est, live] = await Promise.all([
    stel.getPendingInvoices().catch(() => []),
    stel.getEstimatesSummary().catch(() => null),
    stel.getWorkOrdersLive().catch(() => [])
  ]);
  const facs    = (pend || []).filter(i => norm(i[campo]) === norm(target));
  const deuda   = facs.reduce((s, i) => s + (i.pending || 0), 0);
  const estsCli = est ? (est.all || []).filter(i => norm(i[campo]) === norm(target)) : [];
  const acept   = estsCli.filter(i => i.stateKey === 'accepted');
  const pendi   = estsCli.filter(i => i.stateKey === 'pending');
  const pedidos = (live || []).filter(i => norm(i[campo]) === norm(target));

  let msg = `🗂️ *${scope === 'familia' ? 'Familia: ' : ''}${target}*\n\n`;
  msg += `💰 Deuda: *${fmtEur(deuda)}* · ${facs.length} factura(s)\n`;
  msg += `📊 Presupuestos: ${acept.length} aceptados · ${pendi.length} pendientes\n`;
  msg += `🔧 Pedidos abiertos: ${pedidos.length}`;
  if (facs.length) {
    const vieja = [...facs].sort((a, b) => (b.daysOverdue || 0) - (a.daysOverdue || 0))[0];
    msg += `\n\n⏱ Factura más antigua: ${vieja.number} · ${vieja.daysOverdue || 0}d · ${fmtEur(vieja.pending)}`;
  }
  msg += `\n\nDetalle: *"qué debe ${target}"* · *"presupuestos de ${target}"* · *"pedidos de ${target}"*.`;
  ultima.delete(from);
  return msg;
}

// ── Buscador UNIVERSAL de documentos por número ───────────────────
// Tipos con datos: factura (FAC), presupuesto (PRT), pedido (PDT).
// Albaranes y facturas de proveedor aún no están conectados.
function refDigits(s) { return parseInt(String(s || '').replace(/\D/g, ''), 10); }

async function docFactura(q) {
  const invs = await stel.getInvoices().catch(() => []);
  const f = (invs || []).find(x => refDigits(x.number) === q);
  if (!f) return null;
  const pendImp = (f.totalAmount || 0) - (f.paidAmount || 0);
  const estado = pendImp <= 0.01 ? '✅ Pagada' : (f.paidAmount > 0 ? '🟡 Parcial' : '🔴 Pendiente');
  const detalle = `🧾 *${f.number}* (factura)\nCliente: ${f.client}\n` +
    (f.family && f.family !== 'Sin familia' ? `Familia: ${f.family}\n` : '') +
    `Importe: *${fmtEur(f.totalAmount)}*\nEstado: ${estado}` +
    (pendImp > 0.01 ? ` · pendiente *${fmtEur(pendImp)}*` : '') +
    (f.date ? `\nFecha: ${String(f.date).slice(0, 10)}` : '');
  return { detalle, resumen: `🧾 *${f.number}* — ${f.client} — ${fmtEur(f.totalAmount)} (${estado})` };
}

async function docPresupuesto(q) {
  const s = await stel.getEstimatesSummary().catch(() => null);
  if (!s) return null;
  const e = (s.all || []).find(x => refDigits(x.ref || x.number) === q);
  if (!e) return null;
  const detalle = `📊 *${e.ref || e.number}* (presupuesto)\nCliente: ${e.client}\n` +
    (e.family ? `Familia: ${e.family}\n` : '') +
    `Estado: ${e.stateLabel}\nImporte: *${fmtEur(e.total)}*` +
    (e.daysOld != null ? `\nAntigüedad: ${e.daysOld}d` : '') +
    `\n\nVer conceptos: *"conceptos del ${refDigits(e.ref || e.number)}"*`;
  return { detalle, resumen: `📊 *${e.ref || e.number}* — ${e.client} — ${fmtEur(e.total)} (${e.stateLabel})` };
}

async function docPedido(q) {
  const [orders, stateMap, cli] = await Promise.all([
    stel.getAllWorkOrders().catch(() => []),
    stel.getWorkOrderStateMap().catch(() => ({})),
    stel.getClients().catch(() => ({ clientMap: {} }))
  ]);
  const clientMap = cli.clientMap || {};
  const o = (orders || []).filter(x => !x.deleted).find(x => refDigits(x['full-reference']) === q);
  if (!o) return null;
  const ref = o['full-reference'] || `PDT #${o.id}`;
  const c = clientMap[String(o['account-id'] || '')] || {};
  const estado = stateMap[String(o['document-state-id'])] || '';
  const lines = Array.isArray(o.lines) ? o.lines.filter(l => !l.deleted) : [];
  const desc = lines.map(l => l['item-name']).filter(Boolean).slice(0, 4).join(', ');
  const imp = Number(o['total-amount']);
  const detalle = `🔧 *${ref}* (pedido de trabajo)\nCliente: ${c.name || '—'}\n` +
    (c.family && c.family !== 'Sin familia' ? `Familia: ${c.family}\n` : '') +
    (estado ? `Estado: ${estado}\n` : '') +
    (Number.isFinite(imp) && imp ? `Importe: *${fmtEur(imp)}*\n` : '') +
    (desc ? `Trabajo: ${desc}` : '');
  return { detalle, resumen: `🔧 *${ref}* — ${c.name || '—'}${estado ? ` (${estado})` : ''}` };
}

const BUSCADORES = { factura: docFactura, presupuesto: docPresupuesto, pedido: docPedido };

function tipoDocumento(textoNorm) {
  // Códigos pegados a los dígitos: fac309, prt00509, pdt384, alb45, fcp12
  if (/\bfac\d|\bfra\d/.test(textoNorm)) return 'factura';
  if (/\bprt\d/.test(textoNorm))         return 'presupuesto';
  if (/\bpdt\d/.test(textoNorm))         return 'pedido';
  if (/\balb\d/.test(textoNorm))         return 'albaran';
  if (/\bfcp\d/.test(textoNorm))         return 'proveedor';
  // Por palabra
  if (/factura/.test(textoNorm) && !/proveedor/.test(textoNorm)) return 'factura';
  if (/presupuest|presu\b|oferta/.test(textoNorm)) return 'presupuesto';
  if (/pedido|parte|orden de trabajo/.test(textoNorm)) return 'pedido';
  if (/albaran/.test(textoNorm)) return 'albaran';
  if (/proveedor|\bfcp\b/.test(textoNorm)) return 'proveedor';
  return null;
}

async function handlerDocumento(numero, tipo, from) {
  const q = parseInt(String(numero).replace(/\D/g, ''), 10);
  if (tipo === 'albaran')   return '📦 Los *albaranes* todavía no están conectados. Lo dejamos para una próxima mejora.';
  if (tipo === 'proveedor') return '📥 Las *facturas de proveedor* todavía no están conectadas. Lo dejamos para una próxima mejora.';

  const tipos = tipo ? [tipo] : ['factura', 'presupuesto', 'pedido'];
  const hallados = [];
  for (const t of tipos) {
    const r = await BUSCADORES[t](q);
    if (r) hallados.push(r);
  }
  if (!hallados.length) {
    return tipo
      ? `No encuentro ${tipo === 'factura' ? 'la factura' : tipo === 'presupuesto' ? 'el presupuesto' : 'el pedido'} ${numero}.`
      : `No encuentro ningún documento con el número ${numero}.`;
  }
  if (hallados.length === 1) { ultima.delete(from); return hallados[0].detalle; }
  ultima.delete(from);
  return `Hay varios documentos con el ${numero}:\n\n` + hallados.map(h => h.resumen).join('\n') +
         `\n\nDime el tipo, p. ej. *"factura ${numero}"* o *"presupuesto ${numero}"*.`;
}

function despachar(intent, from, scope, target) {
  if (intent === 'ficha')        return fichaDe(scope, target, from);
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

  // C0) Conceptos / detalle (líneas) de un PRESUPUESTO concreto (ej. "conceptos del 509")
  //     Solo si NO menciona factura/pedido (esos van al buscador universal).
  if (/concepto|detalle|detalla|desglos|linea|partida|que (incluye|lleva|contiene|tiene)/.test(norm(texto))
      && !/factura|\bfac\b|pedido|\bpdt\b/.test(norm(texto))) {
    const m = texto.match(/\d{2,6}/);
    if (m) return handlerDetalle(m[0], from);
  }

  // C1) Buscador UNIVERSAL de documento por número (factura/presupuesto/pedido)
  //     Se activa si hay un número y o bien se nombra el tipo, o hay un verbo de búsqueda.
  {
    const n = norm(texto);
    const num = texto.match(/\d{2,6}/);
    const tipo = tipoDocumento(n);
    const verboBusqueda = /\b(dime|dame|cual es|cuales son|que es|ver|muestrame|muestra|ensename|busca|buscar|info|informacion|datos|documento|numero)\b/.test(n);
    if (num && (tipo || verboBusqueda)) return handlerDocumento(num[0], tipo, from);
  }

  // C2) ¿Resumen global del negocio? ("resumen", "cómo vamos")
  if (esResumenGlobal(texto)) return handlerResumenGlobal(from);

  // C3) ¿Ficha rápida de un cliente? ("resumen de Illa Verda", "cómo va bellpuig")
  const objFicha = detectarFicha(texto);
  if (objFicha) return handlerFicha(texto, from, objFicha);

  // D) Enrutador
  const { intent, scope, rawTarget } = await clasificar(texto);
  if (intent === 'facturas')     return handlerFacturas(texto, from, scope, rawTarget);
  if (intent === 'presupuestos') return handlerPresupuestos(texto, from, scope, rawTarget);
  if (intent === 'pedidos')      return handlerPedidos(texto, from, scope, rawTarget);

  return `👋 Puedo ayudarte con:\n\n` +
    `📌 *Resumen* — escribe "resumen" para ver el negocio de un vistazo\n` +
    `🗂️ *Ficha de cliente* — "resumen de Illa Verda" (deuda + presupuestos + pedidos)\n` +
    `🔎 *Buscar un documento* — "dime el 309" · "la factura 309" · "presupuesto 509" · "pedido 384"\n` +
    `💰 *Facturas* — "¿qué debe Illa Verda?" · "cuánto me deben en total"\n` +
    `📊 *Presupuestos* — "los aceptados" · "conceptos del 509" · "presupuestos de Cinc"\n` +
    `🔧 *Pedidos* — "cuántos pedidos tenemos" · "pedidos de Illa Verda"\n\n` +
    `Y si te equivocas con un nombre, te pregunto y lo recuerdo. 🧠`;
}

module.exports = { responderConsulta };
