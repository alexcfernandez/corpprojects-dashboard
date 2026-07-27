// src/agente.js — Núcleo del agente (Fase 1 MVP): tool-calling como FALLBACK.
//
// Se invoca SOLO cuando la cascada de regex no resuelve con confianza:
//   · Puerta A: al final de responderConsultaInterna ("no entendido").
//   · Puerta B: cuando un handler iba a actuar sobre un target de baja confianza
//     (caso estrella: nota de comunidad → puede ser en realidad AGENDA).
//
// Regla inviolable: la IA interpreta; los datos salen de las herramientas reales.
// Si no puede resolver con confianza a qué/quién se refiere → PREGUNTA, no adivina.
// La continuidad de esa pregunta se apoya en estadoConversacion (Fase 0, sobrevive
// a reinicios de Railway).

const estado = require('./estadoConversacion');

const MODELO  = () => process.env.AGENTE_IA_MODEL || 'claude-sonnet-4-6';
const MAX_DIA = () => parseInt(process.env.AGENTE_IA_MAX_DIA || '150', 10);
const TTL_ACLARA = 10 * 60 * 1000;

function hoyMadridISO() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' }); }

// ── Herramientas del MVP (JSON Schema Anthropic) ──
const TOOLS = [
  {
    name: 'crear_evento_agenda',
    description: 'Crea un evento en la AGENDA/calendario personal del jefe (cita, recordatorio con fecha y opcionalmente hora). Úsala cuando pide apuntar algo en su agenda o calendario con una fecha, p. ej. "apunta mañana a las 19 dentista".',
    input_schema: {
      type: 'object',
      properties: {
        fecha: { type: 'string', description: 'Fecha absoluta YYYY-MM-DD (resuelve "mañana"/"el lunes"/"el 19" respecto a HOY).' },
        hora: { type: ['string', 'null'], description: 'Hora HH:MM en 24h, o null si no la dice.' },
        titulo: { type: 'string', description: 'Qué es (breve).' },
      },
      required: ['fecha', 'titulo'],
    },
  },
  {
    name: 'anadir_nota_comunidad',
    description: 'Guarda una nota/ficha técnica sobre una COMUNIDAD de clientes (p. ej. "la caldera de Illa Verda es Roca"). Úsala SOLO si la comunidad está clara; si no, pregunta.',
    input_schema: {
      type: 'object',
      properties: {
        comunidad: { type: 'string', description: 'Nombre de la comunidad/cliente.' },
        nota: { type: 'string', description: 'El hecho a recordar.' },
      },
      required: ['comunidad', 'nota'],
    },
  },
];

function systemPrompt(hoy) {
  return `Eres el asistente del jefe de una empresa de mantenimiento de fincas, por WhatsApp. Hoy es ${hoy} (Europe/Madrid).
REGLAS DURAS:
- Si NO puedes resolver con confianza a qué/quién se refiere (comunidad, cliente, trabajador), haz una PREGUNTA corta de aclaración; NUNCA elijas "el más parecido".
- NUNCA inventes datos (fechas, importes, números de documento). Si falta un dato, pídelo.
- Distingue: "en el calendario / en la agenda" + fecha/hora = evento personal → crear_evento_agenda. "en <comunidad> que <hecho>" = nota de comunidad → anadir_nota_comunidad. Si es ambiguo, pregunta.
- Resuelve fechas relativas ("mañana", "el lunes", "el 19") a YYYY-MM-DD respecto a hoy; hora en HH:MM 24h o null.
- Responde en español y breve.`;
}

// Llama al modelo con tools. Devuelve {tipo:'tool',name,input} | {tipo:'texto',texto} | {tipo:'nada'}.
async function llamarModelo(messages, hoy) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { tipo: 'nada' };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODELO(), max_tokens: 500, system: systemPrompt(hoy), tools: TOOLS, messages }),
  });
  if (!r.ok) { console.error('[Agente] IA HTTP', r.status); return { tipo: 'nada' }; }
  const data = await r.json();
  const blocks = data.content || [];
  const tool = blocks.find(b => b.type === 'tool_use');
  if (tool) return { tipo: 'tool', name: tool.name, input: tool.input || {} };
  const txt = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return txt ? { tipo: 'texto', texto: txt } : { tipo: 'nada' };
}

// `_impl.llamarModelo` es reemplazable en tests (arnés mockeado, sin gastar tokens).
const _impl = { llamarModelo };

// Cupo diario propio del agente (best-effort; ante fallo del contador, no bloquea).
async function dentroDeCupo() {
  try {
    const db = await require('./db').getDB();
    const dia = hoyMadridISO();
    const doc = await db.collection('agenteIAUso').findOne({ dia });
    if (doc && doc.n >= MAX_DIA()) return false;
    await db.collection('agenteIAUso').updateOne({ dia }, { $inc: { n: 1 }, $set: { dia } }, { upsert: true });
    return true;
  } catch (e) { return true; }
}

async function ejecutarTool(name, input) {
  if (name === 'crear_evento_agenda') {
    const { fecha, hora, titulo } = input || {};
    if (!fecha || !titulo) return { handled: true, reply: '¿Qué apunto y para qué día?' };
    try {
      await require('./calendar').crearEventoPersonal({ date: fecha, hora: hora || null, titulo });
      return { handled: true, reply: `🗓️ Apuntado en tu agenda: *${titulo}* — ${hora ? `${fecha} a las ${hora}` : fecha}.` };
    } catch (e) { console.error('[Agente] crearEvento:', e.message); return { handled: true, reply: 'No he podido crear el evento en el calendario, inténtalo de nuevo.' }; }
  }
  if (name === 'anadir_nota_comunidad') {
    const { comunidad, nota } = input || {};
    // Regla dura: resolver la comunidad CON CONFIANZA; si no, preguntar (no guardar en la equivocada).
    const res = await require('./asistente')._ejecutarNotaComunidad(comunidad || '', nota || '');
    if (res && res.ambiguo) return { handled: true, reply: `¿En qué comunidad exactamente? No tengo clara "${comunidad || ''}" (dímela y la aprendo).`, aclara: true };
    if (res && res.ok) return { handled: true, reply: `📝 Anotado en *${res.target}*: ${nota}` };
    return { handled: true, reply: 'No he podido guardar la nota ahora mismo.' };
  }
  return { handled: false };
}

async function intentar({ texto, from, imagenes = [], puerta = null } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) return { handled: false };
  if (!(await dentroDeCupo())) { console.warn('[Agente] cupo diario agotado'); return { handled: false }; }

  const hoy = hoyMadridISO();
  const prev = estado.get(from);
  const enAclaracion = prev && prev.accion === 'agente_aclara' && (Date.now() - (prev.ts || 0)) < TTL_ACLARA;

  const messages = enAclaracion
    ? [
        { role: 'user', content: String(prev.textoOriginal || '') },
        { role: 'assistant', content: String(prev.pregunta || '¿Puedes aclararlo?') },
        { role: 'user', content: String(texto || '') },
      ]
    : [{ role: 'user', content: String(texto || '') }];

  let resp;
  try { resp = await _impl.llamarModelo(messages, hoy); }
  catch (e) { console.error('[Agente] modelo:', e.message); return { handled: false }; }

  if (resp.tipo === 'tool') {
    estado.delete(from); // se resuelve la intención; limpiamos cualquier aclaración
    const out = await ejecutarTool(resp.name, resp.input);
    if (out.aclara) estado.set(from, { accion: 'agente_aclara', textoOriginal: (enAclaracion && prev.textoOriginal) || texto, pregunta: out.reply, ts: Date.now() });
    console.log(`[Agente] tool=${resp.name} puerta=${puerta || '?'}`);
    return { handled: out.handled !== false, reply: out.reply };
  }
  if (resp.tipo === 'texto') {
    estado.set(from, { accion: 'agente_aclara', textoOriginal: (enAclaracion && prev.textoOriginal) || texto, pregunta: resp.texto, ts: Date.now() });
    console.log(`[Agente] aclara puerta=${puerta || '?'}`);
    return { handled: true, reply: resp.texto };
  }
  return { handled: false };
}

module.exports = { intentar, TOOLS, _impl };
