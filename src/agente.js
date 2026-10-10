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

const MODELO  = () => require('./config').ia.agente;
const MAX_DIA = () => parseInt(process.env.AGENTE_IA_MAX_DIA || '150', 10);
const TTL_ACLARA = 10 * 60 * 1000;

function hoyMadridISO() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' }); }

// ── Herramientas del MVP (JSON Schema Anthropic) ──
// Las de CONSULTA (solo leen) devuelven datos y el modelo redacta la respuesta con ellos (segunda llamada).
const LECTURA = new Set(['consultar_presencia', 'horas_obra']);
const TOOLS = [
  {
    name: 'consultar_presencia',
    description: 'PRESENCIA Y HORAS de los trabajadores (solo lee): quién trabajó, dónde, cuántas horas, quién estuvo de vacaciones, de baja, libre o sin apuntar, en un día o un periodo. P. ej. «¿cuántas horas lleva David esta semana?», «¿quién estuvo en Simón Bombi el jueves?», «¿quién no ha venido hoy?», «¿cuántos días de vacaciones lleva Javi este año?».',
    input_schema: {
      type: 'object',
      properties: {
        desde: { type: 'string', description: 'YYYY-MM-DD (resuelve «hoy», «ayer», «esta semana» = desde el lunes, «este mes», «el jueves»… respecto a HOY).' },
        hasta: { type: 'string', description: 'YYYY-MM-DD (igual que desde si es un solo día).' },
        trabajador: { type: ['string', 'null'], description: 'Nombre o parte del nombre si pregunta por alguien concreto; null si es de todos.' },
        obra: { type: ['string', 'null'], description: 'Obra o cliente si pregunta por una obra; null si no.' },
        estado: { type: ['string', 'null'], enum: ['obra', 'oficina', 'vacaciones', 'baja', 'falta_j', 'falta_i', 'libre', 'festivo', null], description: 'Solo si pregunta por un estado concreto (vacaciones, baja…).' },
      },
      required: ['desde', 'hasta'],
    },
  },
  {
    name: 'apuntar_ausencia',
    description: 'Apunta una AUSENCIA LARGA de un trabajador con su fecha de fin (maternidad/paternidad, baja médica, accidente, lactancia, excedencia): así esos días no salen como «sin apuntar» y la gestoría recibe el tipo bien. P. ej. «Paula está de maternidad hasta el 12 de febrero», «Judit de baja hasta el lunes».',
    input_schema: {
      type: 'object',
      properties: {
        trabajador: { type: 'string' },
        tipo: { type: 'string', enum: ['maternidad', 'baja', 'accidente', 'lactancia', 'excedencia', 'otra'] },
        desde: { type: 'string', description: 'YYYY-MM-DD (si no lo dice: hoy).' },
        hasta: { type: ['string', 'null'], description: 'YYYY-MM-DD del último día, o null si no se sabe.' },
        nota: { type: ['string', 'null'] },
      },
      required: ['trabajador', 'tipo', 'desde'],
    },
  },
  {
    name: 'horas_obra',
    description: 'HORAS Y COSTE DE PERSONAL DE UNA OBRA (solo lee): total de horas, quién ha trabajado y cuánto, días, compras. P. ej. «¿cuántas horas llevamos en la Claudia?», «¿quién ha ido a la Simón Bombi fase 2?».',
    input_schema: {
      type: 'object',
      properties: {
        obra: { type: 'string', description: 'Nombre de la obra o del cliente.' },
        desde: { type: ['string', 'null'], description: 'YYYY-MM-DD si pregunta por un periodo; null = toda la obra.' },
        hasta: { type: ['string', 'null'], description: 'YYYY-MM-DD; null = hasta hoy.' },
      },
      required: ['obra'],
    },
  },
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
- Resuelve fechas relativas ("mañana", "el lunes", "el 19") a YYYY-MM-DD respecto a hoy.
- HORA: si es INEQUÍVOCA ("19:30", "a las 19", "a las 8 de la mañana", "mediodía") → HH:MM en 24h. Si es AMBIGUA mañana/tarde ("las 7.30", "a las 8", "a las 5" sin "de la mañana/tarde" ni formato 24h) → NO la asumas: PREGUNTA "¿mañana o tarde? (p. ej. 07:30 o 19:30)" antes de crear el evento. Si no dice hora → null.
- Presencia, horas, quién trabajó/vino/faltó, vacaciones, bajas → consultar_presencia. Para «cuántos días faltó/trabajó/lleva X» usa resumenPorPersona: «faltó» = faltaInjustificada + faltaJustificada + sinApuntar (días laborables sin nada apuntado); dilo desglosado y con las fechas si son pocas. Si preguntan «cuántos días lleva» sin decir de qué, da días trabajados (y vacaciones/baja si hay). Horas o coste de una obra → horas_obra. Contesta SOLO con lo que devuelvan (si no hay datos, dilo). «Esta semana» = desde el lunes.
- Al contestar con datos: breve, para WhatsApp (*negritas* para nombres y totales, una línea por persona u obra).
- Responde en español y breve.`;
}

// Llama al modelo con tools. Devuelve {tipo:'tool',name,input} | {tipo:'texto',texto} | {tipo:'nada'}.
async function llamarModelo(messages, hoy, { maxTokens = 500 } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { tipo: 'nada' };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODELO(), max_tokens: maxTokens, system: systemPrompt(hoy), tools: TOOLS, messages }),
  });
  if (!r.ok) { console.error('[Agente] IA HTTP', r.status); return { tipo: 'nada' }; }
  const data = await r.json();
  const blocks = data.content || [];
  const tool = blocks.find(b => b.type === 'tool_use');
  if (tool) return { tipo: 'tool', name: tool.name, input: tool.input || {}, id: tool.id, blocks };
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

// ── Consultas de presencia y obras (solo leen) ──
const _n = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9ñ ]+/g, ' ').trim();
const _casa = (texto, q) => { const t = _n(texto), ws = _n(q).split(' ').filter(w => w.length >= 2); return !!ws.length && ws.every(w => t.includes(w)); };
const _fechaOk = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
async function consultarPresencia({ desde, hasta, trabajador = null, obra = null, estado = null } = {}) {
  if (!_fechaOk(desde)) desde = hoyMadridISO(); if (!_fechaOk(hasta)) hasta = desde;
  if (hasta < desde) [desde, hasta] = [hasta, desde];
  let l = await require('./attendance').getAttendance({ from: desde, to: hasta });
  if (trabajador) l = l.filter(e => _casa(e.workerName, trabajador));
  if (obra) l = l.filter(e => _casa([e.clientName, ...(e.obras || []).map(o => o.clientName)].join(' '), obra));
  if (estado) l = l.filter(e => (e.estado || 'obra') === estado);
  const porPersona = {}, porObra = {};
  for (const e of l) {
    const p = porPersona[e.workerName] = porPersona[e.workerName] || { dias: 0, horas: 0, estados: {} };
    const est = e.estado || 'obra'; p.dias++; p.estados[est] = (p.estados[est] || 0) + 1;
    const obras = (e.obras && e.obras.length) ? e.obras : (e.clientName ? [{ clientName: e.clientName, horas: e.horas }] : []);
    if (est === 'obra' || est === 'oficina') p.horas += Number(e.horas) || obras.reduce((a, o) => a + (Number(o.horas) || 0), 0);
    for (const o of obras) { if (obra && !_casa(o.clientName, obra)) continue; const k = o.clientName || '—'; porObra[k] = porObra[k] || { horas: 0, personas: new Set() }; porObra[k].horas += Number(o.horas) || 0; porObra[k].personas.add(e.workerName); }
  }
  const out = { desde, hasta, filtro: { trabajador, obra, estado }, registros: l.length,
    porPersona: Object.entries(porPersona).map(([nombre, x]) => ({ nombre, ...x })).sort((a, b) => b.horas - a.horas),
    porObra: Object.entries(porObra).map(([nombre, x]) => ({ nombre, horas: x.horas, personas: [...x.personas] })).sort((a, b) => b.horas - a.horas),
    detalle: l.slice(0, 80).map(e => ({ fecha: e.date, trabajador: e.workerName, estado: e.estado || 'obra', horas: e.horas, obras: (e.obras || []).map(o => `${o.clientName} ${o.horas || ''}h`).join(', ') || e.clientName || '' })) };
  // Resumen POR PERSONA del periodo: días trabajados, vacaciones, baja, faltas y laborables SIN NADA APUNTADO (cuentan
  // como faltas si no hay otra explicación), con sus fechas. Laborables = lunes a viernes menos festivos, desde el
  // primer día que esa persona tiene algo apuntado (para no contar lo de antes de entrar) y hasta hoy.
  if (!obra) {
    try {
      const U = require('./users');
      const us = (await U.getUsers(false)).filter(u => ['tecnico', 'encargado', 'oficina'].includes(U.normalizeRole(u.role)) && (trabajador ? _casa(u.name, trabajador) : u.active !== false));
      const ext = await require('./attendance').extremosPorTrabajador();
      const fest = {}; for (const y of new Set([desde.slice(0, 4), hasta.slice(0, 4)])) Object.assign(fest, await require('./festivos').lista(y).catch(() => ({})));
      const hoy = hoyMadridISO();
      const AUS = require('./ausencias'); const aus = await AUS.lista();   // maternidad, bajas largas… con su fecha de fin
      const NOM = { obra: 'trabajados', oficina: 'oficina', vacaciones: 'vacaciones', baja: 'baja', falta_j: 'faltaJustificada', falta_i: 'faltaInjustificada', libre: 'libre', festivo: 'festivo' };
      out.resumenPorPersona = us.map(u => {
        const e = ext.get(String(u._id)) || {};
        const ini = [desde, e.primero || desde].sort().pop(), fin = [hasta, hoy, ...(u.active === false && e.ultimo ? [e.ultimo] : [])].sort()[0];
        const suyos = l.filter(x => String(x.workerId) === String(u._id));
        const r = { nombre: u.name, autonomo: !!u.autonomo, activo: u.active !== false, desde: ini, hasta: fin, laborables: 0, trabajados: 0, oficina: 0, vacaciones: 0, baja: 0, faltaJustificada: 0, faltaInjustificada: 0, libre: 0, festivo: 0, horas: 0, sinApuntar: 0, fechasSinApuntar: [], fechasFaltas: [], fechasVacaciones: [], fechasBaja: [] };
        r.porAusencia = {};   // { maternidad: { fechas, hasta, nota } } — lo de dentro de una ausencia larga apuntada
        const enAus = (f) => AUS.deDia(aus, u._id, f);
        const meter = (a, f) => { const k = a.tipo; (r.porAusencia[k] = r.porAusencia[k] || { fechas: [], hasta: a.hasta, desde: a.desde, nota: a.nota }).fechas.push(f); };
        for (const x of suyos) { const a0 = /baja|falta_j/.test(x.estado || '') ? enAus(x.date) : null; if (a0) { meter(a0, x.date); continue; }
          const k = NOM[x.estado || 'obra'] || 'trabajados'; r[k]++; if (['obra', 'oficina'].includes(x.estado || 'obra')) r.horas += Number(x.horas) || 0;
          if (/falta/.test(x.estado || '')) r.fechasFaltas.push(x.date); if (x.estado === 'vacaciones') r.fechasVacaciones.push(x.date); if (x.estado === 'baja') r.fechasBaja.push(x.date); }
        if (!estado) for (let d = new Date(ini + 'T12:00:00Z'); ini <= fin && d <= new Date(fin + 'T12:00:00Z'); d = new Date(d.getTime() + 86400000)) {
          const f = d.toISOString().slice(0, 10), w = d.getUTCDay(); if (w === 0 || w === 6 || fest[f]) continue;
          r.laborables++; if (!suyos.some(x => x.date === f)) { const a = enAus(f); if (a) meter(a, f); else { r.sinApuntar++; r.fechasSinApuntar.push(f); } }
        }
        for (const k of ['fechasSinApuntar', 'fechasFaltas', 'fechasVacaciones', 'fechasBaja']) r[k] = r[k].sort().slice(0, 31);
        if (!e.primero || e.primero > hasta) r.nota = 'Sin nada apuntado en este periodo (o aún no había empezado).';
        return r;
      }).filter(r => trabajador || r.laborables || r.trabajados);
    } catch (e) { console.warn('[Agente] resumen por persona:', e.message); }
  }
  return out;
}
async function horasObra({ obra, desde = null, hasta = null } = {}) {
  const O = require('./obras');
  const todas = await O.getObras({ verEstudio: false });
  const cands = todas.filter(o => _casa([o.reference, o.clientName, ...(o.aliases || [])].join(' '), obra));
  if (!cands.length) return { error: `No encuentro ninguna obra que sea «${obra}».` };
  const abiertas = cands.filter(o => o.status === 'activa');
  if (cands.length > 1 && abiertas.length !== 1) return { varias: cands.slice(0, 8).map(o => ({ nombre: o.reference, cliente: o.clientName, estado: o.status })) };
  const o = abiertas.length === 1 ? abiertas[0] : cands[0];
  const r = await O.getRentabilidad(String(o._id));
  const fechas = Object.keys(r.byDate || {}).filter(f => (!_fechaOk(desde) || f >= desde) && (!_fechaOk(hasta) || f <= hasta)).sort();
  const porPersona = {}; let horas = 0;
  for (const f of fechas) for (const x of r.byDate[f]) { porPersona[x.worker] = porPersona[x.worker] || { horas: 0, dias: 0 }; porPersona[x.worker].horas += x.horas; porPersona[x.worker].dias++; horas += x.horas; }
  return { obra: o.reference, cliente: o.clientName, estado: o.status, desde: desde || (fechas[0] || null), hasta: hasta || (fechas[fechas.length - 1] || null), horas, dias: fechas.length,
    porPersona: Object.entries(porPersona).map(([nombre, x]) => ({ nombre, ...x })).sort((a, b) => b.horas - a.horas),
    ...(!desde && !hasta ? { costePersonal: Math.round(r.totalCostePersonal || 0), compras: Math.round((r.totalCompras || 0) * 100) / 100 } : {}),
    porDia: fechas.slice(-20).map(f => ({ fecha: f, quienes: r.byDate[f].map(x => `${x.worker} ${x.horas}h`).join(', ') })) };
}
const LECTORES = { consultar_presencia: consultarPresencia, horas_obra: horasObra };

async function ejecutarTool(name, input) {
  if (name === 'apuntar_ausencia') {
    try {
      const x = await require('./ausencias').poner({ nombre: input.trabajador, tipo: input.tipo, desde: input.desde || hoyMadridISO(), hasta: input.hasta || null, nota: input.nota || '' }, 'Corpy');
      const f = d => d.split('-').reverse().join('/');
      return { handled: true, reply: `📅 Apuntado: *${x.nombre}* — ${require('./ausencias').TIPOS[x.tipo].toLowerCase()} desde el ${f(x.desde)}${x.hasta ? ` hasta el ${f(x.hasta)}` : ' (sin fecha de fin)'}. Esos días ya no saldrán como «sin apuntar» y la gestoría lo recibirá así.` };
    } catch (e) { return { handled: true, reply: e.message }; }
  }
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

  // Consultas: se leen los datos y el modelo redacta la respuesta con ellos (hasta 3 consultas encadenadas).
  for (let vuelta = 0; resp.tipo === 'tool' && LECTURA.has(resp.name) && vuelta < 3; vuelta++) {
    let datos;
    try { datos = await LECTORES[resp.name](resp.input || {}); } catch (e) { console.error('[Agente] lectura', resp.name, e.message); datos = { error: 'No he podido leer los datos ahora mismo.' }; }
    messages.push({ role: 'assistant', content: resp.blocks }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: resp.id, content: JSON.stringify(datos).slice(0, 20000) }] });
    console.log(`[Agente] lectura=${resp.name} puerta=${puerta || '?'}`);
    try { resp = await _impl.llamarModelo(messages, hoy, { maxTokens: 900 }); } catch (e) { console.error('[Agente] modelo:', e.message); return { handled: false }; }
    if (resp.tipo === 'texto') { estado.delete(from); return { handled: true, reply: resp.texto }; }
  }

  if (resp.tipo === 'tool') {
    estado.delete(from); // se resuelve la intención; limpiamos cualquier aclaración
    const out = await ejecutarTool(resp.name, resp.input);
    if (out.aclara) estado.set(from, { accion: 'agente_aclara', textoOriginal: (enAclaracion && prev.textoOriginal) || texto, pregunta: out.reply, ts: Date.now() });
    console.log(`[Agente] tool=${resp.name} puerta=${puerta || '?'}`);
    return { handled: out.handled !== false, reply: out.reply };
  }
  if (resp.tipo === 'texto') {
    // Solo UNA ronda de aclaración: si tras aclarar sigue sin entenderlo, se suelta el
    // hilo (antes encadenaba respuestas inventando contexto: "me he inventado contexto").
    if (enAclaracion) { estado.delete(from); console.log(`[Agente] 2ª aclaración → suelto el hilo puerta=${puerta || '?'}`); return { handled: true, reply: resp.texto }; }
    estado.set(from, { accion: 'agente_aclara', textoOriginal: (enAclaracion && prev.textoOriginal) || texto, pregunta: resp.texto, ts: Date.now() });
    console.log(`[Agente] aclara puerta=${puerta || '?'}`);
    return { handled: true, reply: resp.texto };
  }
  return { handled: false };
}

module.exports = { intentar, TOOLS, _impl, _consultarPresencia: consultarPresencia, _horasObra: horasObra };
