// src/asistente.js — Cerebro del asistente de WhatsApp.
// v1: responde consultas de DEUDAS / FACTURAS PENDIENTES por cliente o familia.
// La IA (Haiku) SOLO interpreta a qué cliente/familia te refieres; los importes
// salen SIEMPRE de StelOrder (getPendingInvoices), nunca se inventan.

const stel = require('./stelorder');

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function fmtEur(n) {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n || 0);
}

// Pregunta a Haiku a qué cliente/familia se refiere el texto.
// Devuelve { scope: 'cliente'|'familia'|'general'|'ninguno', target: 'nombre EXACTO'|null }
async function interpretar(texto, clientes, familias) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { scope: 'ninguno', target: null };

  const prompt = `Eres el asistente del dueño de una empresa de mantenimiento de fincas.
Te pregunta por DEUDAS / FACTURAS PENDIENTES.

Pregunta del usuario: "${texto}"

CLIENTES con deuda (copia uno EXACTO si se refiere a un cliente concreto):
${clientes.slice(0, 120).join('\n') || '(ninguno)'}

FAMILIAS / grupos disponibles:
${familias.slice(0, 60).join('\n') || '(ninguna)'}

Responde SOLO un JSON válido, sin markdown ni texto extra:
{"scope":"cliente|familia|general|ninguno","target":"nombre EXACTO de las listas, o null"}

Reglas:
- "general" si pregunta por el total, todo, o todos los clientes.
- "ninguno" si no se entiende a quién se refiere.
- "target" debe estar COPIADO TAL CUAL de las listas de arriba. No inventes nombres.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
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

// Punto de entrada: recibe el texto del WhatsApp y devuelve la respuesta (string).
async function responderConsulta(texto) {
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

  const clientesUnicos = [...new Set(pend.map(i => i.client).filter(Boolean))].sort();
  const familiasUnicas = [...new Set(pend.map(i => i.family).filter(Boolean))].sort();

  const { scope, target } = await interpretar(texto, clientesUnicos, familiasUnicas);

  let sel, titulo;
  if (scope === 'general') {
    sel = pend;
    titulo = 'Total pendiente (todos)';
  } else if (scope === 'cliente' && target) {
    sel = pend.filter(i => norm(i.client) === norm(target));
    titulo = target;
  } else if (scope === 'familia' && target) {
    sel = pend.filter(i => norm(i.family) === norm(target));
    titulo = `Familia: ${target}`;
  } else {
    return '🤔 No tengo claro de qué cliente me hablas. Prueba con el nombre, por ejemplo: "¿qué debe Illa Verda?"';
  }

  if (!sel || sel.length === 0) {
    return `✅ ${target || 'Eso'} no tiene facturas pendientes.`;
  }

  const total = sel.reduce((s, i) => s + (i.pending || 0), 0);
  sel.sort((a, b) => (b.daysOverdue || 0) - (a.daysOverdue || 0));

  const lineas = sel.slice(0, 15).map(i =>
    `• ${i.number} — ${fmtEur(i.pending)}${i.daysOverdue ? ` (${i.daysOverdue}d)` : ''}`
  );

  let msg = `📋 *${titulo}*\nPendiente: *${fmtEur(total)}* en ${sel.length} factura(s)\n\n${lineas.join('\n')}`;
  if (sel.length > 15) msg += `\n…y ${sel.length - 15} más.`;
  return msg;
}

module.exports = { responderConsulta };
