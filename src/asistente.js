// src/asistente.js — Cerebro del asistente de WhatsApp.
// v2: consultas de DEUDAS / FACTURAS PENDIENTES por cliente, familia o total.
//     + formato bonito (negritas) + "ver más" (paginado) + variantes.
// PRINCIPIO: la IA solo INTERPRETA a qué te refieres; los importes salen
// SIEMPRE de StelOrder (getPendingInvoices), nunca se inventan.

const stel = require('./stelorder');

// Memoria de la última consulta por número (para "ver más").
// En memoria del proceso: se reinicia al desplegar, suficiente para paginar.
const ultima = new Map(); // from -> { items:[...], titulo, mostradas, tipo }

const PAGINA = 10;

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}
function fmtEur(n) {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n || 0);
}
function esVerMas(t) {
  return /\b(ver mas|mas facturas|el resto|los demas|las demas|siguientes|continua|continuar|mostrar mas|dame mas|mas\b)\b/.test(norm(t))
      || norm(t) === 'mas' || norm(t) === 'mas+';
}
function esTotal(t) {
  const n = norm(t);
  return /(en total|el total|cuanto me deben$|cuanto deben en total|deuda total|todas las deudas|todo lo pendiente|cuanto me deben en total)/.test(n)
      || n === 'total' || n === 'cuanto me deben' || n === 'deudas';
}

// Pinta una línea de factura
function lineaFactura(i) {
  const dias = i.daysOverdue ? ` · ${i.daysOverdue}d` : '';
  return `• ${i.number} — *${fmtEur(i.pending)}*${dias}`;
}

// Construye el bloque de facturas (con paginado) y guarda el estado
function bloqueFacturas(from, items, titulo, desde = 0) {
  const total = items.reduce((s, i) => s + (i.pending || 0), 0);
  const trozo = items.slice(desde, desde + PAGINA);
  const restantes = items.length - (desde + trozo.length);

  let msg = '';
  if (desde === 0) {
    msg += `📋 *${titulo}*\n💰 Pendiente: *${fmtEur(total)}* · ${items.length} factura(s)\n\n`;
  } else {
    msg += `📋 *${titulo}* (continuación)\n\n`;
  }
  msg += trozo.map(lineaFactura).join('\n');
  if (restantes > 0) {
    msg += `\n\n…y ${restantes} más. Responde *"ver más"* para seguir.`;
  }

  ultima.set(from, { items, titulo, mostradas: desde + trozo.length, tipo: 'facturas' });
  return msg;
}

// Pregunta a Haiku a qué cliente/familia se refiere
async function interpretar(texto, clientes, familias) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { scope: 'ninguno', target: null };

  const prompt = `Eres el asistente del dueño de una empresa de mantenimiento de fincas.
Te pregunta por DEUDAS / FACTURAS PENDIENTES.

Pregunta del usuario: "${texto}"

CLIENTES con deuda (copia uno EXACTO si se refiere a un cliente concreto):
${clientes.slice(0, 120).join('\n') || '(ninguno)'}

FAMILIAS / grupos (copia uno EXACTO si se refiere a un grupo entero):
${familias.slice(0, 60).join('\n') || '(ninguna)'}

Responde SOLO un JSON válido, sin markdown ni texto extra:
{"scope":"cliente|familia|general|ninguno","target":"nombre EXACTO de las listas, o null"}

Reglas:
- "general": pregunta por el total, todo, todos, o el resumen global.
- "familia": se refiere a un grupo entero (ej. "todo lo de Cinc", "la familia X").
- "cliente": un cliente concreto.
- "ninguno": no se entiende a quién se refiere.
- "target" debe estar COPIADO TAL CUAL de las listas. NUNCA inventes nombres.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.EMAIL_IA_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 120,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`API ${r.status}: ${JSON.stringify(data).slice(0, 150)}`);
    const txt = (data.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim();
    const out = JSON.parse(txt);
    return { scope: out.scope || 'ninguno', target: out.target || null };
  } catch (e) {
    console.error('[Asistente] IA error:', e.message);
    return { scope: 'ninguno', target: null };
  }
}

// Resumen general: total + ranking de quién más debe
function resumenGeneral(from, pend) {
  const total = pend.reduce((s, i) => s + (i.pending || 0), 0);
  const porCliente = {};
  for (const i of pend) {
    const c = i.client || '(sin nombre)';
    porCliente[c] = (porCliente[c] || 0) + (i.pending || 0);
  }
  const ranking = Object.entries(porCliente).sort((a, b) => b[1] - a[1]);
  const top = ranking.slice(0, 8).map(([c, v]) => `• ${c} — *${fmtEur(v)}*`);

  let msg = `💰 *Total pendiente: ${fmtEur(total)}*\n${pend.length} facturas · ${ranking.length} clientes\n\n*Quién más debe:*\n${top.join('\n')}`;
  if (ranking.length > 8) msg += `\n…y ${ranking.length - 8} clientes más.`;
  msg += `\n\nPregúntame por uno, p. ej.: *"¿qué debe Illa Verda?"*`;
  ultima.delete(from); // el resumen no se pagina por facturas
  return msg;
}

// Punto de entrada
async function responderConsulta(texto, from = 'anon') {
  // 1) "ver más" — usa la memoria de la última consulta
  if (esVerMas(texto)) {
    const prev = ultima.get(from);
    if (prev && prev.tipo === 'facturas' && prev.mostradas < prev.items.length) {
      return bloqueFacturas(from, prev.items, prev.titulo, prev.mostradas);
    }
    return 'No tengo nada más que mostrar 🙂 Pregúntame por un cliente, p. ej.: *"¿qué debe Illa Verda?"*';
  }

  // 2) Datos reales de StelOrder
  let pend;
  try {
    pend = await stel.getPendingInvoices();
  } catch (e) {
    console.error('[Asistente] StelOrder error:', e.message);
    return '⚠️ No he podido consultar StelOrder ahora mismo. Prueba de nuevo en un momento.';
  }
  if (!Array.isArray(pend) || pend.length === 0) {
    return '✅ No hay facturas pendientes ahora mismo.';
  }

  // 3) Variante "total" — directa, sin gastar IA
  if (esTotal(texto)) {
    return resumenGeneral(from, pend);
  }

  // 4) Interpretar a qué cliente/familia se refiere (IA)
  const clientesUnicos = [...new Set(pend.map(i => i.client).filter(Boolean))].sort();
  const familiasUnicas = [...new Set(pend.map(i => i.family).filter(Boolean))].sort();
  const { scope, target } = await interpretar(texto, clientesUnicos, familiasUnicas);

  if (scope === 'general') {
    return resumenGeneral(from, pend);
  }

  let sel, titulo;
  if (scope === 'cliente' && target) {
    sel = pend.filter(i => norm(i.client) === norm(target));
    titulo = target;
  } else if (scope === 'familia' && target) {
    sel = pend.filter(i => norm(i.family) === norm(target));
    titulo = `Familia: ${target}`;
  } else {
    return '🤔 No tengo claro de qué cliente me hablas. Prueba con el nombre, por ejemplo: *"¿qué debe Illa Verda?"*';
  }

  if (!sel || sel.length === 0) {
    return `✅ ${target || 'Eso'} no tiene facturas pendientes.`;
  }

  sel.sort((a, b) => (b.daysOverdue || 0) - (a.daysOverdue || 0));
  return bloqueFacturas(from, sel, titulo, 0);
}

module.exports = { responderConsulta };
