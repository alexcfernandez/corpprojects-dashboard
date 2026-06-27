// src/asistente.js — Cerebro del asistente de WhatsApp.
// v4: ENRUTADOR (facturas / presupuestos / pedidos) + MEMORIA DE ALIAS.
//     Si no conoce un nombre ("bellpuig"), te pregunta, y al decírselo lo
//     guarda en MongoDB para siempre (alias -> cliente/familia canónico).
// PRINCIPIO: la IA interpreta intención y a quién te refieres; los datos
// (importes, conteos) salen SIEMPRE de StelOrder, nunca se inventan.

const stel = require('./stelorder');
const com  = require('./comunidades');

const ultima    = new Map(); // from -> estado de paginación ("ver más")
const pendiente = new Map(); // from -> { accion:'aprender', aliasRaw, intent, ts }
const contexto  = new Map(); // from -> { tipo:'gasto', prov, ts } para encadenar preguntas
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

// Alias de PROVEEDOR (colección aparte)
async function buscarAliasProv(aliasNorm) {
  if (!aliasNorm) return null;
  try {
    const db = await getDB();
    const doc = await db.collection('aliasProveedores').findOne({ alias: aliasNorm });
    return doc ? doc.target : null;
  } catch (e) { return null; }
}
async function guardarAliasProv(aliasNorm, target) {
  try {
    const db = await getDB();
    await db.collection('aliasProveedores').updateOne(
      { alias: aliasNorm },
      { $set: { alias: aliasNorm, target, updatedAt: new Date() } },
      { upsert: true }
    );
    console.log(`[Asistente] alias proveedor: "${aliasNorm}" -> ${target}`);
  } catch (e) { console.error('[Asistente] aliasProv write:', e.message); }
}
// Palabras genéricas en nombres de proveedor que no distinguen
const STOPPROV = new Set(['sl', 'slu', 'sa', 'sau', 'sccl', 'sociedad', 'limitada', 'unipersonal',
  'espana', 'iberica', 'iberia', 'comercial', 'comercializadora', 'distribuciones', 'distribucion',
  'suministros', 'suministro', 'materiales', 'material', 'grupo', 'hermanos', 'hijos', 'industrial',
  'servicios', 'soluciones', 'group', 'and', 'the']);

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

// Vocabulario para mejorar la transcripción de voz (Whisper): nombres propios
// reales de StelOrder (comunidades/familias + proveedores). Whisper solo usa
// los últimos ~224 tokens del prompt, así que los más distintivos van al final.
let _vozCache = null, _vozTs = 0;
async function vocabularioVoz() {
  if (_vozCache && Date.now() - _vozTs < 10 * 60 * 1000) return _vozCache;
  let familias = [], provNames = [], clientes = [];
  try {
    const l = await listas();
    familias = l.familias || []; clientes = l.clientes || [];
  } catch (e) {}
  try {
    const { suppliers } = await stel.getSuppliers();
    provNames = (suppliers || []).map(s => s.name);
  } catch (e) {}
  // Limpia sufijos societarios y duplicados; los proveedores (marcas) al final.
  const limpiar = arr => [...new Set((arr || [])
    .map(n => String(n).replace(/[\s,]+(s\.?l\.?u?\.?|s\.?a\.?u?\.?|s\.?c\.?c\.?l\.?)\.?\s*$/i, '').replace(/[",]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(n => n.length >= 3))];
  const nombres = [...limpiar(clientes), ...limpiar(familias), ...limpiar(provNames)];
  let prompt = `Empresa de mantenimiento y reformas de comunidades de vecinos. Nombres propios habituales: ${nombres.join(', ')}.`;
  // Whisper recorta al final del prompt: conservamos la cola (proveedores/familias).
  if (prompt.length > 1100) prompt = '…' + prompt.slice(prompt.length - 1100);
  _vozCache = prompt; _vozTs = Date.now();
  return prompt;
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

// Parser de JSON tolerante: arregla los fallos típicos de los modelos antes de
// rendirse — coma decimal española ("180,00" -> "180.00"), comas finales y, como
// último recurso, cierra cadenas/llaves de un JSON truncado para salvar el borrador.
function parseJsonLoose(raw) {
  let s = String(raw || '').replace(/```json|```/g, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a !== -1 && b > a) s = s.slice(a, b + 1);
  // Coma decimal -> punto SOLO en posición de valor numérico (dígito,dígitos seguido de , } o ])
  s = s.replace(/(\d),(\d{1,2})(?=\s*[,}\]])/g, '$1.$2');
  // Comas finales antes de cierre
  s = s.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(s); }
  catch (e1) {
    try { return JSON.parse(repararJsonTruncado(s)); }
    catch (e2) { throw e1; } // lanza el error original, más informativo
  }
}

// Cierra un JSON cortado a media frase: cierra la cadena colgante y los
// brackets abiertos en el ORDEN correcto (pila), respetando el anidamiento.
function repararJsonTruncado(s) {
  const pila = [];
  let enCadena = false, escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { enCadena = !enCadena; continue; }
    if (enCadena) continue;
    if (c === '{' || c === '[') pila.push(c);
    else if (c === '}' || c === ']') pila.pop();
  }
  let t = s;
  if (enCadena) t += '"';        // cierra cadena colgante
  t = t.replace(/,\s*$/, '');     // quita coma colgante al final
  for (let i = pila.length - 1; i >= 0; i--) t += (pila[i] === '{' ? '}' : ']');
  return t.replace(/,\s*([}\]])/g, '$1');
}

// Llamada a IA que admite IMÁGENES (para el presupuesto técnico con fotos).
// Usa un modelo más capaz (Sonnet) porque redacta partidas técnicas y lee fotos.
async function iaJsonVision(prompt, imagenes, maxTokens, fallback) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return fallback;
  let raw = '', stop = '';
  try {
    const content = [];
    for (const img of (imagenes || []).slice(0, 6)) {
      if (img && img.data) content.push({ type: 'image', source: { type: 'base64', media_type: img.media_type || 'image/jpeg', data: img.data } });
    }
    content.push({ type: 'text', text: prompt });
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.PRESU_IA_MODEL || 'claude-sonnet-4-6',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content }]
      })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`API ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
    raw = data.content?.[0]?.text || '';
    stop = data.stop_reason || '';
    return parseJsonLoose(raw);
  } catch (e) {
    console.error('[Asistente] IA vision error:', e.message, '| stop_reason:', stop, '| raw(0-400):', String(raw).slice(0, 400));
    return fallback;
  }
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
// ── CONCEPTOS / desglose de líneas — GLOBAL (presupuesto/factura/pedido) ──
// Memoria del último documento mostrado, para "conceptos" sin número.
const ultimoDoc = new Map(); // from -> { tipo, numero }

// Caché en memoria del documento crudo de factura (getInvoiceRaw es llamada real)
const _rawFacturaCache = new Map(); // id -> { doc, ts }
async function rawFactura(id) {
  const hit = _rawFacturaCache.get(id);
  if (hit && Date.now() - hit.ts < 30 * 60 * 1000) return hit.doc;
  const raw = await stel.getInvoiceRaw(id);
  const doc = Array.isArray(raw) ? raw[0] : raw;
  _rawFacturaCache.set(id, { doc, ts: Date.now() });
  return doc;
}

function fmtLineaConcepto(l) {
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
}
function pintaConceptos(from, ref, etiqueta, lines, total) {
  if (!lines.length) return `📄 *${ref}* no tiene líneas de detalle.`;
  return pintar(from, {
    items: lines, titulo: `Conceptos ${ref}`,
    encabezado: `📄 *${ref} — Conceptos* (${etiqueta})${total ? `\nTotal: *${fmtEur(total)}*` : ''}`,
    fmt: fmtLineaConcepto
  }, 0);
}

async function conceptosPresupuesto(q, from) {
  const ests = await stel.getWorkEstimates().catch(() => []);
  const e = (ests || []).find(x => refDigits(x['full-reference'] || x.reference || x.number) === q);
  if (!e) return `No encuentro el presupuesto ${q}.`;
  const ref = e['full-reference'] || e.reference || e.number || `#${e.id}`;
  const lines = Array.isArray(e.lines) ? e.lines.filter(l => !l.deleted) : [];
  ultimoDoc.set(from, { tipo: 'presupuesto', numero: q });
  return pintaConceptos(from, ref, 'presupuesto', lines, Number(e['total-amount']) || 0);
}
async function conceptosPedido(q, from) {
  const orders = await stel.getAllWorkOrders().catch(() => []);
  const o = (orders || []).filter(x => !x.deleted).find(x => refDigits(x['full-reference']) === q);
  if (!o) return `No encuentro el pedido ${q}.`;
  const ref = o['full-reference'] || `PDT #${o.id}`;
  const lines = Array.isArray(o.lines) ? o.lines.filter(l => !l.deleted) : [];
  ultimoDoc.set(from, { tipo: 'pedido', numero: q });
  return pintaConceptos(from, ref, 'pedido', lines, Number(o['total-amount']) || 0);
}
async function conceptosFactura(q, from) {
  const invs = await stel.getInvoices().catch(() => []);
  const f = (invs || []).find(x => refDigits(x.number) === q);
  if (!f) return `No encuentro la factura ${q}.`;
  if (!f.id) return `No puedo abrir el detalle de la factura ${f.number}.`;
  let doc;
  try { doc = await rawFactura(f.id); }
  catch (e) { console.error('[Asistente]', e.message); return '⚠️ No pude abrir el detalle de la factura. Prueba en un momento.'; }
  const lines = Array.isArray(doc?.lines) ? doc.lines.filter(l => !l.deleted) : [];
  ultimoDoc.set(from, { tipo: 'factura', numero: q });
  return pintaConceptos(from, f.number, 'factura', lines, Number(doc?.['total-amount']) || f.totalAmount || 0);
}

async function conceptosProveedor(q, from) {
  const invs = await stel.getPurchaseInvoices().catch(() => []);
  const f = (invs || []).find(x => refDigits(x.number) === q);
  if (!f) return `No encuentro la factura de proveedor ${q}.`;
  const lines = Array.isArray(f.lines) ? f.lines.filter(l => !l.deleted) : [];
  ultimoDoc.set(from, { tipo: 'proveedor', numero: q });
  return pintaConceptos(from, `${f.number} (${f.supplier})`, 'compra', lines, f.total || 0);
}

function conceptosDe(tipo, q, from) {
  if (tipo === 'presupuesto') return conceptosPresupuesto(q, from);
  if (tipo === 'pedido')      return conceptosPedido(q, from);
  if (tipo === 'factura')     return conceptosFactura(q, from);
  if (tipo === 'proveedor')   return conceptosProveedor(q, from);
  if (tipo === 'gasto')       return Promise.resolve('Los gastos no tienen desglose de líneas; usa *"gasto N"* para ver su ficha.');
  return Promise.resolve('Todavía no puedo sacar el desglose de ese tipo de documento.');
}

async function verConceptos(tipo, numero, from) {
  if (tipo === 'albaran') return '📦 Los *albaranes* todavía no están conectados.';

  // Sin número: usamos el último documento mostrado
  if (numero == null) {
    const ud = ultimoDoc.get(from);
    if (!ud) return '¿De qué documento quieres el desglose? Dime el número, p. ej. *"conceptos del presupuesto 509"*.';
    return conceptosDe(ud.tipo, ud.numero, from);
  }
  const q = parseInt(String(numero).replace(/\D/g, ''), 10);
  if (tipo) return conceptosDe(tipo, q, from);

  // Sin tipo: ¿en qué tipos (con desglose) existe ese número?
  const existentes = [];
  for (const t of ['factura', 'presupuesto', 'pedido', 'proveedor']) {
    const r = await BUSCADORES[t](q);
    if (r) existentes.push(t);
  }
  if (!existentes.length) return `No encuentro ningún documento con el número ${numero}.`;
  if (existentes.length === 1) return conceptosDe(existentes[0], q, from);
  return `Hay varios documentos con el ${numero}. ¿De cuál quieres el desglose?\n` +
    existentes.map(t => `• *"conceptos del ${t} ${numero}"*`).join('\n');
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
// Tipos con datos: factura (FAC), presupuesto (PRT), pedido (PDT), proveedor (FPR), gasto (GAS).
// Albaranes (ALB) aún no están conectados.
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

async function docProveedor(q) {
  const invs = await stel.getPurchaseInvoices().catch(() => []);
  const f = (invs || []).find(x => refDigits(x.number) === q);
  if (!f) return null;
  const estado = f.pending <= 0.01 ? '✅ Pagada' : (f.paid > 0 ? '🟡 Parcial' : '🔴 Pendiente');
  const detalle = `📥 *${f.number}* (factura de proveedor)\nProveedor: ${f.supplier}\n` +
    (f.title ? `Concepto: ${f.title}\n` : '') +
    `Importe: *${fmtEur(f.total)}*\nEstado: ${estado}` +
    (f.pending > 0.01 ? ` · pendiente *${fmtEur(f.pending)}*` : '') +
    (f.date ? `\nFecha: ${String(f.date).slice(0, 10)}` : '') +
    `\n\nVer conceptos: *"conceptos del ${refDigits(f.number)}"*`;
  return { detalle, resumen: `📥 *${f.number}* — ${f.supplier} — ${fmtEur(f.total)} (${estado})` };
}

async function docGasto(q) {
  const gastos = await stel.getExpenses().catch(() => []);
  const g = (gastos || []).find(x => refDigits(x.number) === q);
  if (!g) return null;
  const detalle = `💸 *${g.number}* (gasto)\nProveedor: ${g.supplier}\n` +
    (g.description ? `Descripción: ${g.description}\n` : '') +
    `Importe: *${fmtEur(g.amount)}*` +
    (g.date ? `\nFecha: ${String(g.date).slice(0, 10)}` : '');
  return { detalle, resumen: `💸 *${g.number}* — ${g.supplier} — ${fmtEur(g.amount)}` };
}

const BUSCADORES = { factura: docFactura, presupuesto: docPresupuesto, pedido: docPedido, proveedor: docProveedor, gasto: docGasto };
const TIPOS_DOC = ['factura', 'presupuesto', 'pedido', 'proveedor', 'gasto'];

function tipoDocumento(textoNorm) {
  // Códigos pegados a los dígitos
  if (/\bfac\d|\bfra\d/.test(textoNorm)) return 'factura';
  if (/\bprt\d/.test(textoNorm))         return 'presupuesto';
  if (/\bpdt\d/.test(textoNorm))         return 'pedido';
  if (/\bfpr\d/.test(textoNorm))         return 'proveedor';
  if (/\bgas\d/.test(textoNorm))         return 'gasto';
  if (/\balb\d/.test(textoNorm))         return 'albaran';
  // Por palabra (proveedor/compra ANTES que factura)
  if (/proveedor|factura de compra|factura de proveedor/.test(textoNorm)) return 'proveedor';
  if (/\bgasto\b|\bgastos\b/.test(textoNorm)) return 'gasto';
  if (/factura/.test(textoNorm)) return 'factura';
  if (/presupuest|presu\b|oferta/.test(textoNorm)) return 'presupuesto';
  if (/pedido|parte|orden de trabajo/.test(textoNorm)) return 'pedido';
  if (/albaran/.test(textoNorm)) return 'albaran';
  return null;
}

async function handlerDocumento(numero, tipo, from) {
  const q = parseInt(String(numero).replace(/\D/g, ''), 10);
  if (tipo === 'albaran') return '📦 Los *albaranes* todavía no están conectados. Lo dejamos para una próxima mejora.';

  const tipos = tipo ? [tipo] : TIPOS_DOC;
  const hallados = [];
  for (const t of tipos) {
    const r = await BUSCADORES[t](q);
    if (r) hallados.push({ ...r, tipo: t });
  }
  if (!hallados.length) {
    const etiqueta = { factura: 'la factura', presupuesto: 'el presupuesto', pedido: 'el pedido', proveedor: 'la factura de proveedor', gasto: 'el gasto' }[tipo];
    return tipo ? `No encuentro ${etiqueta} ${numero}.` : `No encuentro ningún documento con el número ${numero}.`;
  }
  if (hallados.length === 1) {
    ultima.delete(from);
    ultimoDoc.set(from, { tipo: hallados[0].tipo, numero: q });
    return hallados[0].detalle;
  }
  ultima.delete(from);
  return `Hay varios documentos con el ${numero}:\n\n` + hallados.map(h => h.resumen).join('\n') +
         `\n\nDime el tipo, p. ej. *"factura ${numero}"* o *"presupuesto ${numero}"*.`;
}

// Detecta un cliente/familia mencionado en el texto, SIN gastar IA:
// mira alias guardados y nombres de cliente/familia que aparezcan literalmente.
async function clienteEnTexto(texto) {
  const r = norm(texto);
  // 1) alias guardados (vocabulario del usuario: "bellpuig", etc.)
  try {
    const db = await getDB();
    const aliases = await db.collection('aliasClientes').find({}).toArray();
    for (const a of aliases) {
      if (a.alias && a.alias.length >= 4 && r.includes(a.alias)) return { scope: a.scope, target: a.target };
    }
  } catch (e) {}
  // 2) nombres de cliente/familia presentes literalmente
  const { clientes, familias } = await listas();
  const mc = clientes.filter(c => { const n = norm(c); return n.length >= 4 && r.includes(n); });
  const mf = familias.filter(c => { const n = norm(c); return n.length >= 4 && r.includes(n); });
  if (mc.length === 1 && mf.length === 0) return { scope: 'cliente', target: mc[0] };
  if (mf.length === 1 && mc.length === 0) return { scope: 'familia', target: mf[0] };
  return null;
}

// La ÚLTIMA factura / presupuesto / pedido (número de serie más alto),
// global o de un cliente concreto si se menciona. Mismo comportamiento para los 3 tipos.
async function handlerUltimo(tipo, texto, from) {
  const cli = await clienteEnTexto(texto);
  const campo = cli ? (cli.scope === 'familia' ? 'family' : 'client') : null;
  let bestQ = 0;

  if (tipo === 'factura') {
    let invs = await stel.getInvoices().catch(() => []);
    if (cli) invs = (invs || []).filter(x => norm(x[campo]) === norm(cli.target));
    for (const x of invs || []) { const d = refDigits(x.number); if (Number.isFinite(d) && d > bestQ) bestQ = d; }
  } else if (tipo === 'presupuesto') {
    const s = await stel.getEstimatesSummary().catch(() => null);
    let arr = (s && s.all) || [];
    if (cli) arr = arr.filter(x => norm(x[campo]) === norm(cli.target));
    for (const x of arr) { const d = refDigits(x.ref || x.number); if (Number.isFinite(d) && d > bestQ) bestQ = d; }
  } else if (tipo === 'pedido') {
    const orders = await stel.getAllWorkOrders().catch(() => []);
    let clientMap = {};
    if (cli) { try { ({ clientMap } = await stel.getClients()); } catch (e) {} }
    let arr = (orders || []).filter(o => !o.deleted);
    if (cli) arr = arr.filter(o => {
      const c = clientMap[String(o['account-id'] || '')] || {};
      return norm(c[cli.scope === 'familia' ? 'family' : 'name'] || '') === norm(cli.target);
    });
    for (const x of arr) { const d = refDigits(x['full-reference']); if (Number.isFinite(d) && d > bestQ) bestQ = d; }
  } else if (tipo === 'proveedor') {
    const invs = await stel.getPurchaseInvoices().catch(() => []);
    for (const x of invs || []) { const d = refDigits(x.number); if (Number.isFinite(d) && d > bestQ) bestQ = d; }
  } else if (tipo === 'gasto') {
    const gastos = await stel.getExpenses().catch(() => []);
    for (const x of gastos || []) { const d = refDigits(x.number); if (Number.isFinite(d) && d > bestQ) bestQ = d; }
  }
  const r = await BUSCADORES[tipo](bestQ);
  if (!r) return `No pude abrir la última ${tipo} (${bestQ}).`;
  ultimoDoc.set(from, { tipo, numero: bestQ });
  return `🆕 *Última ${tipo}${cli ? ` de ${cli.target}` : ''}:*\n\n${r.detalle}`;
}

// Detecta un proveedor mencionado por nombre (sin IA): coincidencia literal.
async function proveedorEnTexto(texto) {
  const r = norm(texto);
  // 1) alias de proveedor aprendido
  try {
    const db = await getDB();
    const aliases = await db.collection('aliasProveedores').find({}).toArray();
    for (const a of aliases) if (a.alias && a.alias.length >= 3 && r.includes(a.alias)) return a.target;
  } catch (e) {}

  const { suppliers } = await stel.getSuppliers().catch(() => ({ suppliers: [] }));
  if (!suppliers || !suppliers.length) return null;

  // 2) nombre completo contenido en el texto
  const full = suppliers.filter(s => { const n = norm(s.name); return n.length >= 4 && r.includes(n); });
  if (full.length === 1) return full[0].name;

  // 3) por trozo: palabras distintivas del nombre que aparezcan en el texto
  const palabras = new Set(r.replace(/[^a-z0-9ñ ]/g, ' ').split(/\s+/).filter(w => w.length >= 4 && !STOPPROV.has(w)));
  if (!palabras.size) return null;
  const scored = [];
  for (const s of suppliers) {
    const toks = norm(s.name).replace(/[^a-z0-9ñ ]/g, ' ').split(/\s+/).filter(w => w.length >= 4 && !STOPPROV.has(w));
    const seen = new Set();
    let hits = 0;
    for (const t of toks) { if (seen.has(t)) continue; seen.add(t); if (palabras.has(t)) hits++; }
    if (hits > 0) scored.push({ name: s.name, hits });
  }
  scored.sort((a, b) => b.hits - a.hits);
  if (scored.length && (scored.length === 1 || scored[0].hits > scored[1].hits)) return scored[0].name;
  return null;
}

// Análisis de gasto: global ("qué proveedor gastamos más") o de un proveedor concreto.
// Detecta un periodo temporal en el texto: "este mes/año", "mes/año pasado",
// un año concreto (2024) o un mes por nombre. Devuelve {desde, hasta, etiqueta} o null.
function detectarPeriodo(textoNorm) {
  const ahora = new Date();
  const y = ahora.getFullYear();
  const m = ahora.getMonth(); // 0-11
  const rango = (desde, hasta, etiqueta) => ({ desde, hasta, etiqueta });
  const yearMatch = textoNorm.match(/\b(20\d{2})\b/);
  const MESES_N = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const etiqMes = (d) => `${MESES_N[d.getMonth()]} ${d.getFullYear()}`;
  const NUMPAL = { un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12 };
  const numDe = w => (NUMPAL[w] != null ? NUMPAL[w] : (/^\d+$/.test(w) ? +w : null));
  const NUM = '(\\d+|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)';

  // Relativos: "hace 2 meses", "hace un año", "últimos 3 meses"
  let mm;
  if ((mm = textoNorm.match(new RegExp(`hace\\s+${NUM}\\s+mes`)))) {
    const k = numDe(mm[1]); if (k != null) { const d = new Date(y, m - k, 1); return rango(d, new Date(y, m - k + 1, 1), etiqMes(d)); }
  }
  if ((mm = textoNorm.match(new RegExp(`hace\\s+${NUM}\\s+an[oñ]`)))) {
    const k = numDe(mm[1]); if (k != null) return rango(new Date(y - k, 0, 1), new Date(y - k + 1, 0, 1), `${y - k}`);
  }
  if ((mm = textoNorm.match(new RegExp(`ultimos?\\s+${NUM}\\s+mes`)))) {
    const k = numDe(mm[1]); if (k != null) return rango(new Date(y, m - k + 1, 1), new Date(y, m + 1, 1), `últimos ${k} meses`);
  }

  if (/\beste mes\b|mes actual|del mes/.test(textoNorm))            return rango(new Date(y, m, 1),     new Date(y, m + 1, 1), 'este mes');
  if (/mes pasado|ultimo mes|mes anterior/.test(textoNorm))        return rango(new Date(y, m - 1, 1), new Date(y, m, 1),     'el mes pasado');
  if (/este ano|ano actual|del ano|lo que va de ano/.test(textoNorm)) return rango(new Date(y, 0, 1),  new Date(y + 1, 0, 1), `${y}`);
  if (/ano pasado|ultimo ano|ano anterior/.test(textoNorm))        return rango(new Date(y - 1, 0, 1), new Date(y, 0, 1),     `${y - 1}`);

  const MES = { enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5, julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9, noviembre: 10, diciembre: 11 };
  for (const [nombre, idx] of Object.entries(MES)) {
    if (new RegExp(`\\b${nombre}\\b`).test(textoNorm)) {
      const yy = yearMatch ? +yearMatch[1] : y;
      return rango(new Date(yy, idx, 1), new Date(yy, idx + 1, 1), `${MESES_N[idx]} ${yy}`);
    }
  }
  if (yearMatch) { const yy = +yearMatch[1]; return rango(new Date(yy, 0, 1), new Date(yy + 1, 0, 1), `${yy}`); }
  return null;
}

async function handlerGasto(texto, from) {
  const [comprasAll, gastosAll] = await Promise.all([
    stel.getPurchaseInvoices().catch(() => []),
    stel.getExpenses().catch(() => [])
  ]);
  // Filtro temporal opcional ("este año", "mes pasado", "2024", "en marzo"…)
  const periodo = detectarPeriodo(norm(texto));
  const enPeriodo = (d) => {
    if (!periodo) return true;
    if (!d) return false;
    const t = new Date(d);
    return t >= periodo.desde && t < periodo.hasta;
  };
  const compras = comprasAll.filter(x => enPeriodo(x.date));
  const gastos  = gastosAll.filter(x => enPeriodo(x.date));
  const suf = periodo ? ` · *${periodo.etiqueta}*` : '';

  const prov = await proveedorEnTexto(texto);

  if (prov) {
    contexto.set(from, { tipo: 'gasto', prov, ts: Date.now() });
    const fc = compras.filter(x => norm(x.supplier) === norm(prov));
    const gc = gastos.filter(x => norm(x.supplier) === norm(prov));
    const totC = fc.reduce((s, x) => s + (x.total || 0), 0);
    const totG = gc.reduce((s, x) => s + (x.amount || 0), 0);
    if (!fc.length && !gc.length) return `No encuentro compras a ${prov}${periodo ? ` en ${periodo.etiqueta}` : ''}.`;
    let msg = `🏷️ *${prov}*${suf}\n\n`;
    msg += `📥 Facturas de proveedor: *${fmtEur(totC)}* (${fc.length})\n`;
    msg += `💸 Gastos: *${fmtEur(totG)}* (${gc.length})\n`;
    msg += `Σ Total: *${fmtEur(totC + totG)}*`;
    if (fc.length) {
      const ult = [...fc].sort((a, b) => refDigits(b.number) - refDigits(a.number))[0];
      msg += `\n\nÚltima factura: ${ult.number} · ${fmtEur(ult.total)}${ult.date ? ` · ${String(ult.date).slice(0, 10)}` : ''}`;
    }
    ultima.delete(from);
    return msg;
  }

  // ¿Había un proveedor objetivo explícito que no reconocí? → aprenderlo
  const mt = norm(texto).match(/(?:gastamos en|gastado en|gasto en|compramos en|compramos a|gastamos a|compras? a|compras? en)\s+(.+)$/);
  let rawProv = mt ? mt[1].trim().replace(/[?.!]+$/, '') : null;
  if (rawProv) rawProv = rawProv.replace(/\b(este|el|la|los|las|en|durante)?\s*(a[nñ]o|mes|semana)\b.*$/i, '').trim();
  if (rawProv) rawProv = rawProv.replace(/\b(20\d{2})\b.*$/, '').trim();
  if (rawProv && rawProv.length >= 3) {
    pendiente.set(from, { accion: 'aprender', clase: 'proveedor', aliasRaw: rawProv, intent: 'gasto', ts: Date.now() });
    return `🤔 No conozco el proveedor *"${rawProv}"*. ¿A cuál corresponde? Dímelo (p. ej. "es Saint-Gobain Weber") y lo recuerdo.`;
  }

  // Global: ranking de proveedores
  contexto.set(from, { tipo: 'gasto', prov: null, ts: Date.now() });
  const totalCompras = compras.reduce((s, x) => s + (x.total || 0), 0);
  const totalGastos  = gastos.reduce((s, x) => s + (x.amount || 0), 0);
  const porProv = {};
  for (const x of compras) { const k = x.supplier || '—'; porProv[k] = (porProv[k] || 0) + (x.total || 0); }
  for (const x of gastos)  { const k = x.supplier || '—'; porProv[k] = (porProv[k] || 0) + (x.amount || 0); }
  const rank = Object.entries(porProv).sort((a, b) => b[1] - a[1]);
  if (!rank.length) return `No encuentro compras${periodo ? ` en ${periodo.etiqueta}` : ''}.`;
  const top = rank.slice(0, 8).map(([n, v]) => `• ${n} — *${fmtEur(v)}*`);
  let msg = `🛒 *Gasto en proveedores*${suf}\n\n`;
  msg += `📥 Facturas de proveedor: *${fmtEur(totalCompras)}* (${compras.length})\n`;
  msg += `💸 Gastos sueltos: *${fmtEur(totalGastos)}* (${gastos.length})\n`;
  msg += `Σ Total: *${fmtEur(totalCompras + totalGastos)}*\n\n`;
  msg += `*En quién más gastamos:*\n${top.join('\n')}`;
  if (rank.length > 8) msg += `\n…y ${rank.length - 8} proveedores más.`;
  msg += `\n\nPregunta por uno: *"cuánto gastamos en Saltoki"*${periodo ? '' : ' · o un periodo: *"qué proveedor gastamos más este año"*'}.`;
  ultima.delete(from);
  return msg;
}

function despachar(intent, from, scope, target) {
  if (intent === 'ficha')        return fichaDe(scope, target, from);
  if (intent === 'presupuestos') return handlerPresupuestos(`presupuestos de ${target}`, from, scope, target);
  if (intent === 'pedidos')      return handlerPedidos(`pedidos de ${target}`, from, scope, target);
  return handlerFacturas(`${target}`, from, scope, target);
}

// ── Punto de entrada ──────────────────────────────────────────────
// ── CREAR INCIDENCIA por voz/texto (la IA propone, tú confirmas, el sistema escribe) ──
const TIPO_INC = { actuacion: 3146, presupuesto: 3145 };

async function handlerNuevaIncidencia(texto, from) {
  // 1) La IA extrae cliente, descripción y tipo de la frase
  const ex = await iaJson(
    `Eres el asistente de una empresa de mantenimiento de fincas. El usuario quiere CREAR una incidencia.\n` +
    `Frase: "${texto}"\n\n` +
    `Extrae y responde SOLO JSON:\n` +
    `{"cliente":"nombre del cliente/comunidad tal cual lo dice, o null","descripcion":"el problema descrito, redactado claro y breve","tipo":"actuacion|presupuesto|null"}\n\n` +
    `Sobre "tipo":\n` +
    `- "presupuesto": si piden valorar, presupuestar, "hacer un presupuesto", o es un trabajo grande que requiere oferta previa.\n` +
    `- "actuacion": si es una reparación/arreglo directo (cambiar, reparar, no funciona, avería, urgencia).\n` +
    `- null: SOLO si de verdad no hay pista suficiente para decidir.`,
    250, { cliente: null, descripcion: null, tipo: null }
  );
  if (!ex.descripcion) return '¿Qué incidencia creo y para qué comunidad? Ej: *"incidencia para Illa Verda: no funciona la luz del portal, es actuación"*.';

  // 2) Resolver el cliente
  const { scope, target } = await resolver(texto, ex.cliente || '');
  if (!target) {
    pendiente.set(from, { accion: 'incCliente', descripcion: ex.descripcion, tipo: ex.tipo, ts: Date.now() });
    return `📋 Incidencia: "${ex.descripcion}"\n\n🤔 ¿De qué cliente es? Dime el nombre **tal como aparece en StelOrder**.\n\n_Si es un cliente nuevo, créalo primero en StelOrder (Clientes) con su NIF y dirección, y luego vuelve a decírmelo._`;
  }
  const accId = await stel.accountIdByName(target);
  if (!accId) return `Reconozco *${target}* pero no encuentro su ficha en StelOrder. Prueba con el nombre exacto.`;

  // 3) ¿Falta el tipo? Preguntarlo
  if (!ex.tipo || !TIPO_INC[ex.tipo]) {
    pendiente.set(from, { accion: 'incTipo', accId, target, descripcion: ex.descripcion, ts: Date.now() });
    return `📋 Incidencia para *${target}*:\n"${ex.descripcion}"\n\n¿Es de *Actuación* (reparar) o *Presupuesto*? Responde "actuación" o "presupuesto".`;
  }

  // 4) Mostrar borrador y pedir confirmación
  return prepararConfirmIncidencia(from, accId, target, ex.descripcion, ex.tipo);
}

function prepararConfirmIncidencia(from, accId, target, descripcion, tipo) {
  pendiente.set(from, { accion: 'incConfirmar', accId, target, descripcion, tipo, ts: Date.now() });
  const tipoLabel = tipo === 'presupuesto' ? 'Presupuesto' : 'Actuación';
  return `📋 *Voy a crear esta incidencia:*\n\n` +
    `🏘️ Cliente: *${target}*\n` +
    `📝 Descripción: ${descripcion}\n` +
    `🏷️ Tipo: ${tipoLabel}\n\n` +
    `¿La creo? Responde *"sí"* o *"no"*.`;
}

async function ejecutarCrearIncidencia(from, pend) {
  try {
    const r = await stel.crearIncidencia({
      accId: pend.accId, descripcion: pend.descripcion,
      tipoId: TIPO_INC[pend.tipo] || null, requestedBy: from
    });
    // Guardamos la incidencia recién creada para poder generar su pedido con "sí"
    pendiente.set(from, { accion: 'genPedido', incidentId: r.id, accId: pend.accId, target: pend.target, descripcion: pend.descripcion, tipo: pend.tipo || 'actuacion', ref: r.ref, ts: Date.now() });
    return `✅ Incidencia creada: *${r.ref || r.id}*\n🏘️ ${pend.target}\n\n¿Genero el pedido de trabajo? Responde *"sí"* o *"no"*.`;
  } catch (e) {
    pendiente.delete(from);
    return `⚠️ No pude crear la incidencia: ${e.message}`;
  }
}

// Comando suelto: generar pedido desde una incidencia concreta o la última
async function handlerGenerarPedido(texto, from) {
  const nn = norm(texto);
  let inc;
  if (/\b(ultima|última)\b/.test(nn)) {
    inc = await stel.ultimaIncidencia();
    if (!inc) return 'No encuentro ninguna incidencia reciente.';
  } else {
    const m = texto.match(/\d{2,6}/);
    if (!m) return 'Dime de qué incidencia: *"haz el pedido de INC00575"* o *"pedido de la última incidencia"*.';
    inc = await stel.incidenciaPorRef(m[0]);
    if (!inc) return `No encuentro la incidencia ${m[0]}.`;
  }
  if (!inc.accId) return `La incidencia ${inc.ref} no tiene cliente asignado; no puedo generar el pedido.`;
  // Resolver nombre del cliente para mostrarlo
  let nombre = '';
  try { const { clientMap } = await stel.getClients(); nombre = (clientMap[String(inc.accId)] || {}).name || ''; } catch (e) {}
  pendiente.set(from, { accion: 'genPedido', incidentId: inc.id, accId: inc.accId, target: nombre, descripcion: inc.descripcion, tipo: inc.tipo || 'actuacion', ref: inc.ref, ts: Date.now() });
  return `📋 *Voy a generar un pedido de trabajo:*\n\n🔗 Desde: *${inc.ref}*\n🏘️ Cliente: *${nombre || '—'}*\n📝 ${inc.descripcion || '(sin descripción)'}\n\n¿Lo genero? Responde *"sí"* o *"no"*.`;
}

async function ejecutarGenerarPedido(from, datos) {
  try {
    const r = await stel.generarPedidoDesdeIncidencia({
      incidentId: datos.incidentId, accId: datos.accId, descripcion: datos.descripcion, tipo: datos.tipo || 'actuacion', requestedBy: from
    });
    pendiente.delete(from);
    return `✅ Pedido de trabajo generado: *${r.ref || r.id}*\n🏘️ ${datos.target || ''}\n🔗 Enlazado a ${datos.ref || 'la incidencia'}`;
  } catch (e) {
    pendiente.delete(from);
    return `⚠️ No pude generar el pedido: ${e.message}`;
  }
}

// Crea el presupuesto (workEstimate) en StelOrder a partir del borrador guardado.
async function ejecutarCrearPresupuesto(from, pend) {
  try {
    const b = pend.borrador || {};
    const r = await stel.crearPresupuestoStel({
      accId: pend.accId,
      titulo: b.titulo || null,
      observaciones: b.observaciones || null,
      partidas: b.partidas || [],
      iva: pend.iva != null ? pend.iva : 21,
      requestedBy: from
    });
    pendiente.delete(from);
    return `✅ Presupuesto creado en StelOrder: *${r.ref || r.id}*\n🏘️ ${pend.target || ''}\n\n_Está en estado Pendiente. Revísalo y ajusta el IVA si hace falta._`;
  } catch (e) {
    pendiente.delete(from);
    return `⚠️ No pude crear el presupuesto: ${e.message}`;
  }
}

// ── PIEZA B: PRESUPUESTO TÉCNICO por voz/texto + fotos (de momento SOLO genera y enseña) ──
function fmtEurB(n) {
  const v = (Number(n) || 0).toFixed(2);
  return v.replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' €';
}

async function handlerPresupuesto(texto, from, imagenes = []) {
  const prompt =
    `Eres un técnico de una empresa española de mantenimiento de fincas y reformas (fachadas, impermeabilizaciones, electricidad, fontanería, pintura). ` +
    `Vas a redactar un PRESUPUESTO profesional a partir de lo que te dice el usuario` + (imagenes && imagenes.length ? ` y de las FOTOS adjuntas (úsalas para entender el trabajo)` : '') + `.\n\n` +
    `Petición del usuario: "${texto}"\n\n` +
    `Devuelve SOLO un JSON válido (sin markdown) con esta forma:\n` +
    `{"titulo":"título del presupuesto","cliente":"nombre del cliente si lo dice, o null","iva":21,"observaciones":"texto técnico de observaciones (opcional, puede ser null)","partidas":[{"nombre":"nombre corto de la partida","descripcion":"detalle técnico paso a paso, estilo profesional","precio":0.00,"uds":1}]}\n\n` +
    `Reglas:\n` +
    `- Estructura típica: mano de obra (con su paso a paso detallado), materiales, medios auxiliares (andamio si aplica), desplazamiento/gestión de residuos.\n` +
    `- "iva": 21 por defecto; si el usuario dice "al 10" pon 10; si dice "al 0" o "sin iva" pon 0.\n` +
    `- PRECIOS: si el usuario da un total, REPARTE ese total entre las partidas de forma realista (la suma debe cuadrar). Si da precios por partida, respétalos. Si no da ningún precio, propón importes de referencia razonables para España.\n` +
    `- Redacta en español, profesional, como un presupuesto real de construcción. El paso a paso de la mano de obra debe ser detallado.\n` +
    `- En pintura: superficies completas (paños enteros, techos completos), nunca parches.\n` +
    `- JSON VÁLIDO OBLIGATORIO: "precio" y "uds" deben ser NÚMEROS con PUNTO decimal y sin separador de miles (ej: 180.00, 1250.5), NUNCA con coma (no "180,00"). No pongas el símbolo € dentro del JSON. Escapa correctamente comillas y saltos de línea dentro de los textos.`;

  const r = await iaJsonVision(prompt, imagenes, 4000, null);
  if (!r || !Array.isArray(r.partidas) || !r.partidas.length) {
    return '🤔 No he conseguido generar el presupuesto. Dame un poco más de detalle (qué trabajo y, si quieres, el importe). Ej: *"hazme un presupuesto para Illa Verda: impermeabilizar la tribuna, 2530€"*.';
  }

  const iva = [0, 10, 21].includes(Number(r.iva)) ? Number(r.iva) : 21;
  const base = r.partidas.reduce((s, p) => s + (Number(p.precio) || 0) * (Number(p.uds) || 1), 0);
  const total = base * (1 + iva / 100);

  // Cuerpo COMPACTO para WhatsApp (resumen). El paso a paso completo NO se manda
  // por WhatsApp (gastaría muchos mensajes); se guarda en el borrador y va entero
  // a la línea de StelOrder al crear el presupuesto.
  let msg = `📊 *BORRADOR DE PRESUPUESTO*\n`;
  if (r.titulo) msg += `_${r.titulo}_\n`;
  if (r.cliente) msg += `🏘️ ${r.cliente}\n`;
  msg += `\n`;
  if (r.observaciones) {
    const obs = String(r.observaciones).trim();
    msg += `📝 *Observaciones:*\n${obs.length > 400 ? obs.slice(0, 400) + '…' : obs}\n\n`;
  }
  r.partidas.forEach((p, i) => {
    const sub = (Number(p.precio) || 0) * (Number(p.uds) || 1);
    msg += `*${i + 1}. ${p.nombre}* — ${fmtEurB(sub)}\n`;
  });
  msg += `━━━━━━━━━━\n`;
  msg += `Base: ${fmtEurB(base)}\n`;
  msg += `IVA (${iva}%): ${fmtEurB(total - base)}\n`;
  msg += `*TOTAL: ${fmtEurB(total)}*\n\n`;
  msg += `_El detalle técnico (paso a paso) de cada partida se guardará en StelOrder._\n`;
  // Resolver el cliente para poder crearlo en StelOrder
  const { target } = await resolver(texto, r.cliente || '');
  const accId = target ? await stel.accountIdByName(target) : null;

  if (accId) {
    pendiente.set(from, { accion: 'presuConfirmar', borrador: r, iva, accId, target, ts: Date.now() });
    msg += `_⚠️ Borrador generado por IA — revisa los precios._\n\n¿Lo creo en StelOrder para *${target}* (IVA ${iva}%, estado Pendiente)? Responde *"sí"* o *"no"*.`;
  } else {
    pendiente.set(from, { accion: 'presuCliente', borrador: r, iva, ts: Date.now() });
    msg += `_⚠️ Borrador generado por IA — revisa los precios._\n\n🤔 ¿Para qué cliente lo creo? Dime el nombre **tal como aparece en StelOrder** y lo creo.\n_Si el cliente no existe aún, créalo primero en StelOrder._`;
  }
  return msg;
}

async function responderConsulta(texto, from = 'anon', imagenes = []) {
  // A) ¿Estábamos aprendiendo un alias? La respuesta es el nombre real.
  const pend = pendiente.get(from);

  // A.inc) Flujo de creación de incidencia (cliente / tipo / confirmación)
  if (pend && (Date.now() - pend.ts) < 10 * 60 * 1000) {
    const nn = norm(texto);
    if (pend.accion === 'genPedido') {
      if (/^(s[ií]|si|vale|ok|dale|confirmo|adelante|correcto|genera(lo)?|hazlo)\b/.test(nn)) return ejecutarGenerarPedido(from, pend);
      if (/^(no|cancela|para|anula|dejalo|mejor no|ahora no)\b/.test(nn)) { pendiente.delete(from); return '👍 Vale, no genero el pedido. La incidencia queda creada.'; }
      // si no responde sí/no, dejamos pasar al resto (puede querer otra cosa)
    }
    if (pend.accion === 'presuConfirmar') {
      if (/^(s[ií]|si|vale|ok|dale|confirmo|adelante|correcto|crea(lo)?|hazlo)\b/.test(nn)) return ejecutarCrearPresupuesto(from, pend);
      if (/^(no|cancela|para|anula|dejalo|mejor no|ahora no)\b/.test(nn)) { pendiente.delete(from); return '👍 Vale, no creo el presupuesto. El borrador queda descartado.'; }
      return 'Responde *"sí"* para crear el presupuesto en StelOrder o *"no"* para descartarlo.';
    }
    if (pend.accion === 'presuCliente') {
      const { target } = await resolver(texto, texto);
      const accId = target ? await stel.accountIdByName(target) : null;
      if (accId) {
        const b = pend.borrador || {};
        pendiente.set(from, { accion: 'presuConfirmar', borrador: b, iva: pend.iva, accId, target, ts: Date.now() });
        return `📊 Presupuesto _${b.titulo || ''}_ para *${target}*.\n¿Lo creo en StelOrder (IVA ${pend.iva != null ? pend.iva : 21}%, estado Pendiente)? Responde *"sí"* o *"no"*.`;
      }
      return '⚠️ No encuentro ese cliente en StelOrder. Dime el nombre exacto tal como aparece en *Clientes*, o créalo primero allí.';
    }
    if (pend.accion === 'incConfirmar') {
      if (/^(s[ií]|si|vale|ok|dale|confirmo|adelante|correcto|crea(la)?)\b/.test(nn)) return ejecutarCrearIncidencia(from, pend);
      if (/^(no|cancela|para|anula|dejalo|mejor no)\b/.test(nn)) { pendiente.delete(from); return '👍 Cancelado, no he creado nada.'; }
      // si no es sí/no claro, seguimos esperando
      return 'Responde *"sí"* para crear la incidencia o *"no"* para cancelar.';
    }
    if (pend.accion === 'incTipo') {
      const tipo = /presupuest/.test(nn) ? 'presupuesto' : (/actuaci|repar|arregl|cambi/.test(nn) ? 'actuacion' : null);
      if (tipo) return prepararConfirmIncidencia(from, pend.accId, pend.target, pend.descripcion, tipo);
      return 'Dime *"actuación"* (reparar) o *"presupuesto"*.';
    }
    if (pend.accion === 'incCliente') {
      const { scope, target } = await resolver(texto, texto);
      if (target) {
        const accId = await stel.accountIdByName(target);
        if (accId) {
          if (!pend.tipo || !TIPO_INC[pend.tipo]) { pendiente.set(from, { accion: 'incTipo', accId, target, descripcion: pend.descripcion, ts: Date.now() }); return `📋 Incidencia para *${target}*:\n"${pend.descripcion}"\n\n¿Es de *Actuación* o *Presupuesto*?`; }
          return prepararConfirmIncidencia(from, accId, target, pend.descripcion, pend.tipo);
        }
      }
      return '⚠️ No existe ningún cliente así en StelOrder. Créalo primero en *Clientes* (con su NIF y dirección) y luego vuelve a decirme la incidencia.\n\n_O dime el nombre exacto si ya existe._';
    }
  }

  if (pend && pend.accion === 'aprender' && (Date.now() - pend.ts) < 10 * 60 * 1000) {
    const limpio = String(texto).replace(/^\s*(es|son|el|la|los|las|de|del)\s+/i, '').trim();
    if (pend.clase === 'proveedor') {
      const prov = await proveedorEnTexto(limpio);
      if (prov) {
        await guardarAliasProv(norm(pend.aliasRaw), prov);
        pendiente.delete(from);
        const respuesta = await handlerGasto(`gastamos en ${prov}`, from);
        return `✅ Apuntado: *${pend.aliasRaw}* = *${prov}*\n\n${respuesta}`;
      }
      pendiente.delete(from); // no reconocido, seguimos normal
    } else {
      const { scope, target } = await resolver(limpio, limpio);
      if (target) {
        await guardarAlias(norm(pend.aliasRaw), target, scope);
        pendiente.delete(from);
        const respuesta = await despachar(pend.intent, from, scope, target);
        return `✅ Apuntado: *${pend.aliasRaw}* = *${target}*\n\n${respuesta}`;
      }
      pendiente.delete(from); // no era un cliente; seguimos como consulta normal
    }
  }

  // B) "ver más"
  if (esVerMas(texto)) {
    const prev = ultima.get(from);
    if (prev && prev.mostradas < prev.items.length) return pintar(from, prev, prev.mostradas);
    return 'No tengo nada más que mostrar 🙂 Pregúntame por un cliente, p. ej.: *"¿qué debe Illa Verda?"*';
  }

  // C0.presu) PIEZA B — generar presupuesto técnico: "hazme/prepara/redacta un presupuesto de ..."
  // (distinto de "hay que hacer presupuesto para X" que registra una incidencia)
  const _np = norm(texto);
  const pidePresu =
    /\b(haz(me|le|lo|les|nos)?|prepara(me|le|lo|les|nos)?|redacta(me|le|lo|les|nos)?|genera(me|le|lo|les|nos)?|monta(me|le|lo|les|nos)?)\b[\s\S]*\bpresupuest/.test(_np) ||
    /\bpresupuesto (detallado|tecnico|t\u00e9cnico|profesional)\b/.test(_np) ||
    /\bpresupuesto (a|para|de)\b[\s\S]{0,80}:\s*\S/.test(_np);
  if (pidePresu || (imagenes && imagenes.length && /presupuest/.test(_np))) {
    return handlerPresupuesto(texto, from, imagenes);
  }

  // C0.ped) Generar pedido desde incidencia: "haz el pedido de INC00575" / "pedido de la última incidencia"
  if (/\b(haz|genera(r)?|crea(r)?|saca)\b[\s\S]*\bpedido\b[\s\S]*\b(incidencia|inc\s*\d|ultima|última)/.test(norm(texto)) ||
      /\bpedido (de|para) (la )?(ultima|última) incidencia\b/.test(norm(texto))) {
    return handlerGenerarPedido(texto, from);
  }

  // C0.inc) Crear incidencia: "incidencia para X ...", "crea un aviso de ...", "hay que hacer presupuesto para X ..."
  const _ni = norm(texto);
  const intencionCrear =
    /\b(crea(r)?|nueva|nuevo|abre|apunta)\b[\s\S]*\b(incidencia|aviso|parte)\b|^incidencia\b|\bincidencia (para|de|en|por)\b|\baviso (para|de)\b/.test(_ni) ||
    /\b(hay que|tenemos que|tengo que|necesito|toca)\b[\s\S]*\b(hacer|preparar|sacar)\b[\s\S]*\bpresupuest/.test(_ni) ||
    /\bpresupuest[oa]r\b[\s\S]*\b(para|de|en)\b/.test(_ni);
  if (intencionCrear) {
    return handlerNuevaIncidencia(texto, from);
  }

  // C0) Conceptos / desglose de líneas de un documento (presupuesto, factura o pedido)
  if (/concepto|desglos|\blineas?\b|partida|que (incluye|lleva|contiene)/.test(norm(texto))) {
    const m = texto.match(/\d{2,6}/);
    const tipo = tipoDocumento(norm(texto));
    if (m || ultimoDoc.has(from)) return verConceptos(tipo, m ? m[0] : null, from);
  }

  // C0.5) ¿La ÚLTIMA factura/presupuesto/pedido/proveedor/gasto?
  if (/\bultim[oa]s?\b|mas reciente|mas nueva/.test(norm(texto)) && !/incidencia/.test(norm(texto))) {
    const tipo = tipoDocumento(norm(texto));
    if (tipo === 'albaran') return '📦 Los *albaranes* todavía no están conectados.';
    if (tipo) return handlerUltimo(tipo, texto, from);
  }

  // Comando: gestión de morosos (oculta del aviso de WhatsApp; NO toca los correos)
  {
    const n = norm(texto);
    const tocaGestion = /gestion|paypymes/.test(n) || /\bderiv(a|ar)\b/.test(n);
    if (tocaGestion) {
      const motivo = /paypymes/.test(n) ? 'Paypymes' : (/judicial|demanda|abogad/.test(n) ? 'Judicial' : null);
      // Listar
      if (/^\s*(en gestion|morosos? en gestion|que (morosos? )?tengo en gestion|lista de gestion)\s*[?]?\s*$/.test(n)) {
        return handlerGestionList();
      }
      // Quitar de gestión
      const mq = texto.match(/(?:quita|saca|elimina|borra|reactiva)\s+(?:de\s+)?gesti[oó]n\s+(.+)$/i);
      if (mq) return handlerGestionMarcar(mq[1].trim(), false, from, null);
      // Derivar X a Paypymes / judicial
      const md = texto.match(/(?:deriva|derivar|manda|mandar|pasa|pasar)\s+(.+?)\s+a\s+(?:paypymes|gesti[oó]n|la gesti[oó]n|judicial|el abogado|los? abogados?)/i);
      if (md) return handlerGestionMarcar(md[1].trim(), true, from, motivo || 'Paypymes');
      // Marcar en gestión X
      const mm = texto.match(/(?:en|a|pon(?:er)?\s+en|marca(?:r)?\s+en)\s+gesti[oó]n\s+(.+)$/i)
              || texto.match(/gesti[oó]n\s+(?:de\s+|judicial\s+|paypymes\s+)?(.+)$/i);
      if (mm) return handlerGestionMarcar(mm[1].trim(), true, from, motivo);
    }
  }

  // Comando: "cobros" / "a quién reclamar" → panel de priorización de cobros
  if (/^\s*cobros?\b/.test(norm(texto)) ||
      /a qui[eé]n (reclamo|aprieto|reclamar|derivar|reclamamos)|prioridad de cobro|a quien reclamar primero|prioriza(r)? (los )?cobros|panel de cobros/.test(norm(texto))) {
    try { const { construirCobros } = require('./avisos-proactivo'); return (await construirCobros()).texto; }
    catch (e) { return 'No he podido montar el panel de cobros ahora mismo.'; }
  }

  // Comando: "avisos" / "qué debería revisar" → resumen proactivo bajo demanda
  if (/^\s*(avisos?|alertas?|que revisar)\b/.test(norm(texto)) ||
      /que (deberia|tengo que|debo) revisar|que tengo pendiente de cobr|que me avisarias/.test(norm(texto))) {
    try { const { construirAviso } = require('./avisos-proactivo'); return (await construirAviso()).texto; }
    catch (e) { return 'No he podido montar el resumen de avisos ahora mismo.'; }
  }

  // Comando de revisión: "fallos" → consultas que no entendí (para que las veas tú)
  if (/^\s*(fallos|errores)\b/.test(norm(texto)) || /que (no )?(has )?entend|consultas que no entend|donde fallas/.test(norm(texto))) {
    return handlerFallos(from);
  }

  // C-ctx) Continuación temporal de una consulta de gasto ("¿y el mes pasado?", "¿y hace dos meses?")
  {
    const n = norm(texto);
    const ctx = contexto.get(from);
    const periodoSolo = detectarPeriodo(n);
    const palabras = n.replace(/[¿?¡!.,]/g, '').trim().split(/\s+/).filter(Boolean);
    const empiezaY = /^\s*(y|¿\s*y|e)\b/.test(texto.trim().toLowerCase());
    const cortito = palabras.length <= 5;
    const sinOtraIntencion = !/proveedor|factura|presupuesto|pedido|debe|deben|conceptos|resumen/.test(n);
    if (ctx && ctx.tipo === 'gasto' && (Date.now() - ctx.ts) < 15 * 60 * 1000 &&
        periodoSolo && sinOtraIntencion && (empiezaY || cortito)) {
      const base = ctx.prov ? `gastamos en ${ctx.prov}` : 'que proveedor gastamos mas';
      return handlerGasto(`${base} ${texto}`, from);
    }
  }

  // C0.7) ¿Análisis de GASTO / compras? ("qué proveedor gastamos más este año", "cuánto pagamos en X")
  {
    const n = norm(texto);
    const numTok = texto.match(/\d{2,6}/);
    const esAnio = numTok && /^20\d{2}$/.test(numTok[0]);
    const verbosGasto = /(gastamos|gastado|gasto total|compramos|comprado|compras totales|total de (gasto|compra)|en quien (mas )?gastamos|cuanto (gastamos|compramos)|en que gastamos|que proveedor)/.test(n);
    // "pagado/pagamos/abonado ... en/a X" = pago a proveedor (excluye cobros de clientes)
    const pagoProv = /(pagado|pagamos|pagar|abonado|abonamos)/.test(n) && /\b(en|a|al|a la)\b/.test(n) &&
                     !/nos (han )?pag|me (han )?pag|nos pagan|me pagan|nos deben|me deben|cliente/.test(n);
    const mencionProv = /proveedor(es)?\b/.test(n);
    if ((verbosGasto || pagoProv) && (!numTok || esAnio)) return handlerGasto(texto, from);
    if (mencionProv && !numTok)                           return handlerGasto(texto, from);
  }

  // C1) Buscador UNIVERSAL de documento por número (factura/presupuesto/pedido/proveedor/gasto)
  {
    const n = norm(texto);
    const num = texto.match(/\d{2,6}/);
    const tipo = tipoDocumento(n);
    const verboBusqueda = /\b(dime|dame|cual es|cuales son|que es|ver|muestrame|muestra|ensename|busca|buscar|info|informacion|datos|detalle|documento|numero)\b/.test(n);
    if (num && (tipo || verboBusqueda)) return handlerDocumento(num[0], tipo, from);
  }

  // C2) ¿Resumen global del negocio? ("resumen", "cómo vamos")
  if (esResumenGlobal(texto)) return handlerResumenGlobal(from);

  // C3) ¿Ficha rápida de un cliente? ("resumen de Illa Verda", "cómo va bellpuig")
  const objFicha = detectarFicha(texto);
  if (objFicha) return handlerFicha(texto, from, objFicha);

  // C4) Base de conocimiento de comunidades (ficha automática + notas manuales)
  {
    const n = norm(texto);
    // Borrar nota: "borra de <comunidad> la nota 3"
    if (/\b(borra|elimina|quita)\b[\s\S]*\bnota/.test(norm(texto))) return handlerNotaBorrar(texto, from);
    // Añadir nota: "apunta/anota/recuerda en <comunidad> [que/:] <texto>"
    const mAdd = texto.match(/(?:ap[uú]nta(?:me)?|an[oó]ta(?:me)?|recuerda|guarda)\b[\s\S]*?\ben\s+([\s\S]+)$/i);
    if (mAdd) return handlerNotaAdd(mAdd[1].trim(), from);

    // Consultar ficha de comunidad (no confundir con gasto de proveedores)
    if (!/proveedor|gastamos|pagado|compramos|compra a/.test(n) &&
        /(solemos|soliamos|materiales|trabajos que|ficha tecnica|ficha de comunidad|conocimiento de|que sabemos de|que solemos hacer|que hay en)/.test(n)) {
      return handlerComunidad(texto, from);
    }
  }

  // D) Enrutador
  const { intent, scope, rawTarget } = await clasificar(texto);
  if (intent === 'facturas')     return handlerFacturas(texto, from, scope, rawTarget);
  if (intent === 'presupuestos') return handlerPresupuestos(texto, from, scope, rawTarget);
  if (intent === 'pedidos')      return handlerPedidos(texto, from, scope, rawTarget);

  // Ninguna regla ni el clasificador lo entendieron → lo registramos para ir mejorando.
  await registrarFallo(from, texto);
  return `👋 Puedo ayudarte con:\n\n` +
    `📌 *Resumen* — escribe "resumen" para ver el negocio de un vistazo\n` +
    `🗂️ *Ficha de cliente* — "resumen de Illa Verda" (deuda + presupuestos + pedidos)\n` +
    `🔎 *Buscar un documento* — "dime el 309" · "la factura 309" · "la última factura"\n` +
    `📄 *Conceptos / desglose* — "conceptos del 509" · "qué lleva la factura 309" (o "conceptos" tras ver uno)\n` +
    `💰 *Facturas* — "¿qué debe Illa Verda?" · "cuánto me deben en total"\n` +
    `📊 *Presupuestos* — "los aceptados" · "conceptos del 509" · "presupuestos de Cinc"\n` +
    `🔧 *Pedidos* — "cuántos pedidos tenemos" · "pedidos de Illa Verda"\n` +
    `🛒 *Proveedores y gasto* — "qué proveedor gastamos más" · "cuánto gastamos en Saltoki" · "la factura de proveedor 9"\n` +
    `🏘️ *Comunidades* — "materiales de Illa Verda" · "apunta en Illa Verda que la caldera es Roca"\n` +
    `💸 *Cobros* — "cobros" · "a quién reclamar" · "en gestión Clepsa" (ocultar del aviso)\n\n` +
    `Y si te equivocas con un nombre, te pregunto y lo recuerdo. 🧠`;
}

// ── Registro de fallos (retroalimentación): consultas que no se entendieron ──
async function registrarFallo(from, texto) {
  try {
    const db = await getDB();
    await db.collection('fallosAsistente').insertOne({
      texto: String(texto || '').slice(0, 500),
      from: String(from || ''),
      ts: new Date(),
      revisado: false
    });
  } catch (e) { console.error('[Asistente] registrarFallo:', e.message); }
}

async function handlerFallos(from) {
  let docs = [];
  try {
    const db = await getDB();
    docs = await db.collection('fallosAsistente').find({}).sort({ ts: -1 }).limit(300).toArray();
  } catch (e) { return 'No he podido leer el registro de fallos.'; }
  if (!docs.length) return '🎉 No tengo consultas sin entender registradas. De momento, todo lo que me preguntáis lo voy pillando.';
  const conteo = {};
  for (const d of docs) {
    const k = norm(d.texto).slice(0, 60);
    if (!k) continue;
    if (!conteo[k]) conteo[k] = { n: 0, ej: d.texto };
    conteo[k].n++;
  }
  const rank = Object.values(conteo).sort((a, b) => b.n - a.n).slice(0, 15);
  let msg = `🛠️ *Consultas que no entendí* (de las últimas ${docs.length})\n\n`;
  msg += rank.map(r => `• "${r.ej}"${r.n > 1 ? ` _×${r.n}_` : ''}`).join('\n');
  msg += `\n\n_Esto me sirve para ir aprendiendo qué os hace falta._`;
  return msg;
}

// ── Base de conocimiento de comunidades ──────────────────────────────────
// Ficha determinista: agrega las líneas (conceptos) de presupuestos + pedidos
// de esa comunidad + notas manuales. No inventa: lee datos reales de StelOrder.
// Categorías de la ficha técnica de comunidad (en módulo compartido com.CAT_COM)

async function fichaComunidad(target, scope, from) {
  const notas = await com.getNotas(target, scope || 'cliente');
  if (!notas.length) {
    return `🏘️ *${target}* — ficha técnica\n\nAún no tengo datos. Apúntame cosas de mantenimiento, p. ej.:\n• *"apunta en ${target} las luces son downlight 26W 4000K"*\n• *"apunta en ${target} portero Fermax, código portal 1234"*`;
  }
  const porCat = {};
  notas.forEach((nt, i) => {
    const cat = com.CAT_COM[nt.cat] ? nt.cat : 'otros';
    (porCat[cat] = porCat[cat] || []).push({ n: i + 1, texto: nt.texto });
  });
  let msg = `🏘️ *${target}* — ficha técnica\n`;
  for (const key of com.CAT_ORDER) {
    if (!porCat[key]) continue;
    msg += `\n*${com.CAT_COM[key]}*\n` + porCat[key].map(x => `${x.n}. ${x.texto}`).join('\n') + '\n';
  }
  msg += `\n_Borra con "borra de ${target} la nota 3" · añade con "apunta en ${target} ..."_`;
  return msg;
}

async function handlerComunidad(texto, from) {
  const { scope, target } = await resolver(texto, texto);
  if (!target) return '¿De qué comunidad quieres la ficha? Dime el nombre como aparece en StelOrder (p. ej. *"materiales de Illa Verda"*).';
  return fichaComunidad(target, scope || 'cliente', from);
}

async function handlerNotaAdd(resto, from) {
  resto = String(resto || '').trim();
  if (!resto) return '¿Qué apunto y en qué comunidad? Ej: *"apunta en Illa Verda que la caldera es Roca"*.';

  const { scope, target } = await resolver(resto, resto);
  if (!target) return `No reconozco la comunidad. Empieza por el nombre, ej: *"apunta en Illa Verda que ..."*.`;

  // Separar la nota: quitamos el nombre de la comunidad del principio (sin cortar el resto)
  const STOP = new Set(['cp', 'c', 'p', 'comunidad', 'comunitat', 'propietarios', 'propietaris', 'de', 'del', 'la', 'el', 'los', 'las']);
  const sig = norm(target).replace(/[.\-_/]/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !STOP.has(w));
  const words = resto.split(/\s+/);
  let cut = 0;
  for (let i = 0; i < Math.min(words.length, 8); i++) {
    const w = norm(words[i]).replace(/[^a-z0-9ñ]/g, '');
    if (sig.includes(w)) cut = i + 1;
  }
  let nota = words.slice(cut).join(' ').trim();
  nota = nota.replace(/^(que|:|,|;|->)\s*/i, '').trim().replace(/[.\s]+$/, '');
  if (!nota) return `Entiendo que es sobre *${target}*, pero no veo la nota. Ej: *"apunta en ${target} que la caldera es Roca"*.`;

  const iaCls = async (t, cats) => {
    const r = await iaJson(`Clasifica esta nota de mantenimiento de un edificio en UNA categoría.\nCategorías: ${cats.join(', ')}.\nNota: "${t}"\nResponde SOLO JSON: {"cat":"..."}`, 30, { cat: 'otros' });
    return (r && cats.includes(r.cat)) ? r.cat : 'otros';
  };
  const res = await com.addNota(target, scope || 'cliente', nota, iaCls);
  if (!res.ok) return 'No he podido guardar la nota ahora mismo.';
  return `📝 Apuntado en *${target}* ${com.CAT_COM[res.cat] || com.CAT_COM.otros}: "${nota}"`;
}

async function handlerNotaBorrar(texto, from) {
  const m = norm(texto).match(/\bnota\s+(\d{1,3})\b|\b(\d{1,3})\b/);
  const idx = m ? parseInt(m[1] || m[2], 10) : null;
  const { scope, target } = await resolver(texto, texto);
  if (!target) return 'No reconozco la comunidad. Ej: *"borra de Illa Verda la nota 3"*.';
  if (!idx) return `¿Qué nota borro? Mira los números con *"materiales de ${target}"* y di *"borra de ${target} la nota 2"*.`;
  const res = await com.borrarNota(target, scope || 'cliente', idx);
  if (!res.ok) return res.total != null
    ? `¿Qué nota borro? *${target}* tiene ${res.total}. Míralas con *"materiales de ${target}"*.`
    : 'No he podido borrar la nota.';
  return `🗑️ Borrada de *${target}*: "${res.borrada.texto}"`;
}

// ── Gestión de morosos: ocultar del aviso de WhatsApp (los correos siguen) ──
async function handlerGestionMarcar(valorRaw, activar, from, motivo) {
  const gp = require('./avisos-proactivo');
  const v = String(valorRaw || '').trim().replace(/[?.!]+$/, '');
  if (!v) return '¿A quién o qué factura? Prueba: *"en gestión Clepsa"* o *"en gestión FAC00179"*.';

  const num = (v.match(/\d{2,6}/) || [])[0];
  const pareceFactura = num && (/\b(fac|fra|factura)\b/i.test(v) || /^(la |el )?(fac|fra|factura)?\s*0*\d{2,6}$/i.test(v));
  const suf = motivo ? ` _(${motivo})_` : '';

  if (pareceFactura) {
    const clave = String(parseInt(num, 10));
    const etiqueta = `FAC${clave.padStart(5, '0')}`;
    if (activar) { await gp.marcarGestion('factura', etiqueta, clave, motivo); return `🔕 *${etiqueta}* en gestión${suf}: no saldrá en tu aviso ni en cobros. _(El cliente sigue recibiendo los correos.)_`; }
    const ok = await gp.desmarcarGestion('factura', clave);
    return ok ? `🔔 *${etiqueta}* vuelve a tu aviso.` : `*${etiqueta}* no estaba en gestión.`;
  }

  // Por cliente: resolvemos el nombre real
  const { target } = await resolver(v, v);
  if (!target) return `No reconozco *"${v}"*. Dímelo como aparece en StelOrder, o usa el número de factura.`;
  if (activar) { await gp.marcarGestion('cliente', target, null, motivo); return `🔕 *${target}* queda en gestión${suf}: no saldrá en tu aviso ni en cobros. _(Le siguen llegando los correos de impago.)_`; }
  const ok = await gp.desmarcarGestion('cliente', gp.normTxt(target));
  return ok ? `🔔 *${target}* vuelve a tu aviso.` : `*${target}* no estaba en gestión.`;
}

async function handlerGestionList() {
  const gp = require('./avisos-proactivo');
  const gest = await gp.getGestion();
  if (!gest.length) return '🔕 No tienes nada en gestión.\nMarca con *"en gestión Clepsa"* o *"deriva Clepsa a Paypymes"*.';
  const cli = gest.filter(g => g.tipo === 'cliente');
  const fac = gest.filter(g => g.tipo === 'factura');
  const item = g => `• ${g.valor}${g.motivo ? ` _(${g.motivo})_` : ''}`;
  let msg = `🔕 *En gestión* (ocultos de tu aviso y de cobros; siguen recibiendo correos)\n`;
  if (cli.length) msg += `\n*Clientes:*\n` + cli.map(item).join('\n');
  if (fac.length) msg += `\n\n*Facturas:*\n` + fac.map(item).join('\n');
  msg += `\n\nPara reactivar: *"quita de gestión Clepsa"*.`;
  return msg;
}

module.exports = { responderConsulta, vocabularioVoz };
