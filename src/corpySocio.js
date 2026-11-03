// src/corpySocio.js — CORPY COMO ASISTENTE DE ALFONSO (socio), 4/11/2026. Álex: «prepara que Alfonso pueda contarle visitas
// a Corpy y que Corpy le explique cómo funciona: que es su asistente, que si le dice que recuerde algo lo recordará, que le
// puede guardar citas en el calendario y todo eso».
// Alfonso tiene rol de técnico (sin dinero) y antes todo lo que escribía solo se le reenviaba a Álex. Ahora, desde su
// modo de trabajador (server.js → procesarTrabajador), la IA entiende lo que pide con un juego CERRADO de herramientas:
//   · registrar_visita / apuntar_tiempo_socio → visitas.js y tiempoSocios.js a nombre de Alfonso («yo» = Alfonso);
//     a Álex le llega el resumen de la visita («que lo sepamos todos»).
//   · recordatorio → un WhatsApp de Corpy a Alfonso a esa hora (programados.js).
//   · crear_cita → evento en el calendario de Corp («Alfonso: …») + WhatsApp de aviso antes.
//   · recordar_dato → la memoria común de Corpy (memoria.js), con aviso a Álex.
// Nada de dinero, presupuestos ni StelOrder: eso contesta NO_ES_MIO y sigue el camino de siempre (se le pasa a Álex).
// Se apaga con CORPY_SOCIO=off.
'use strict';

const hoyISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
const fFecha = f => String(f || '').split('-').reverse().join('/');
const fechaOk = f => /^\d{4}-\d{2}-\d{2}$/.test(String(f || ''));
const horaOk = h => /^\d{1,2}:\d{2}$/.test(String(h || ''));
const pad = h => String(h).padStart(5, '0');

// Hora de Madrid → Date (con el desfase de ese día, invierno +1 / verano +2).
function aDate(fecha, hora) {
  const base = new Date(`${fecha}T${pad(hora)}:00Z`);
  const enMadrid = new Date(base.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
  const enUTC = new Date(base.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(base.getTime() - (enMadrid - enUTC));
}

// «yo», «me», «nosotros» los dice Alfonso: en visitas y tiempo cuenta él (los módulos entienden «yo» como Álex).
function quienesDeAlfonso(q) {
  const l = (Array.isArray(q) ? q : [q]).map(x => String(x || '').trim()).filter(Boolean)
    .map(x => /^(yo|me|m[ií]|nosotros)$/i.test(x) ? 'Alfonso' : x);
  if (!l.some(x => /alfons/i.test(x))) l.unshift('Alfonso');
  return [...new Set(l)];
}

function esquema(nombre) {
  const t = require('./agenteExtra').TOOLS.find(x => x.name === nombre) || require('./agente').TOOLS.find(x => x.name === nombre);
  return t ? t.input_schema : { type: 'object', properties: {} };
}

function tools() {
  return [
    { name: 'registrar_visita', description: 'Alfonso CUENTA una visita (audio o texto): dónde ha ido, qué ha visto, con quién habló, cuánto rato, qué se acordó y qué falta hacer (presupuesto, trabajo…). Pon todo lo que cuente en que_se_vio y los siguientes pasos aparte. En quienes, «yo» es Alfonso (si fue con Álex, los dos).', input_schema: esquema('registrar_visita') },
    { name: 'apuntar_tiempo_socio', description: 'Alfonso apunta SU TIEMPO sin contar una visita: gestiones, compras, presupuestos en la oficina («he estado dos horas con el presupuesto de…»). «Yo» es Alfonso.', input_schema: esquema('apuntar_tiempo_socio') },
    { name: 'recordatorio', description: 'Alfonso pide que le RECUERDES algo a una hora («recuérdame mañana a las 9 llamar a Madrenas», «avísame el viernes de…»). Corpy le manda un WhatsApp a esa hora.', input_schema: { type: 'object', properties: {
      fecha: { type: 'string', description: 'YYYY-MM-DD (resuelve «mañana», «el lunes»… respecto a HOY).' },
      hora: { type: ['string', 'null'], description: 'HH:MM 24h. Si no la dice: null (se manda a las 9:00). Si es ambigua mañana/tarde, PREGUNTA.' },
      texto: { type: 'string', description: 'Qué hay que recordarle, claro y corto.' } }, required: ['fecha', 'texto'] } },
    { name: 'crear_cita', description: 'Alfonso pide apuntar una CITA o reunión en el calendario («apunta el jueves a las 10 visita con Madrenas en Vilobí»). Va al calendario de Corp y Corpy le avisa antes por WhatsApp.', input_schema: esquema('crear_evento_agenda') },
    { name: 'recordar_dato', description: 'Alfonso pide que RECUERDES un dato o corrige algo: «recuerda que el presidente de Bellpuig 41 es Jordi», «el contacto de… es…», «en Carme 60 los buzones son antracita». Queda en la memoria de Corpy para todos.', input_schema: esquema('corregir_dato') },
    { name: 'estado_presupuesto', description: 'Alfonso dice que un presupuesto está ACEPTADO o RECHAZADO («el PRT00880 lo han aceptado», «el 874 no lo quieren»). Se cambia en StelOrder y se avisa a Álex.', input_schema: { type: 'object', properties: {
      ref: { type: 'string', description: 'Número del presupuesto (PRT00880, 880…)' },
      estado: { type: 'string', enum: ['aceptado', 'rechazado'] } }, required: ['ref', 'estado'] } },
    { name: 'mis_recordatorios', description: 'Alfonso pregunta qué tiene pendiente que le recuerdes («¿qué me tienes que recordar?», «¿qué tengo apuntado?»).', input_schema: { type: 'object', properties: {} } },
  ];
}

function prompt(hoy, contexto, memoria) {
  return `Eres Corpy, el asistente por WhatsApp de ALFONSO, socio de Corp Projects (empresa de reformas y mantenimiento de fincas de Girona; el otro socio es Álex). Hoy es ${hoy} (Europe/Madrid).
Le ayudas con: marcar PRESUPUESTOS aceptados o rechazados (estado_presupuesto), apuntar sus VISITAS (registrar_visita) y su tiempo (apuntar_tiempo_socio), RECORDARLE cosas a una hora (recordatorio), apuntar CITAS en el calendario (crear_cita), guardar DATOS que te pide recordar (recordar_dato) y decirle qué le tienes que recordar (mis_recordatorios).
REGLAS:
- «Yo» y «me» son Alfonso. Si dice «con Álex» o «hemos ido Álex y yo», van los dos.
- Si cuenta una visita y no dice cuánto rato fue, PREGUNTA cuánto (de qué hora a qué hora). Si no queda claro el sitio, pregunta.
- Resuelve fechas relativas a YYYY-MM-DD. Hora ambigua («a las 5» sin mañana/tarde) en citas o recordatorios: pregunta «¿mañana o tarde?». Pero si cuenta una visita que YA ha hecho «a las 5», es por la tarde (17:00).
- NUNCA inventes datos. Si falta algo, pregunta corto.
- recordar_dato es SOLO cuando pide expresamente que recuerdes o apuntes un dato («recuerda que…», «apunta que…», «el contacto de… es…») o corrige algo que sabes. Que un presupuesto (PRT…) esté aceptado o rechazado → estado_presupuesto (si no dice el número, pregúntalo). Que una incidencia esté hecha, que un cliente haya pagado o que haya que facturar NO es recordar_dato: es para Álex → NO_ES_MIO.
- Si pide algo que no está en tus herramientas (presupuestos, facturas, cobros, dinero, nóminas, StelOrder, mandar mensajes a clientes o trabajadores…) o solo comenta algo para Álex, contesta solo: NO_ES_MIO (se lo pasamos a Álex).
- Si pregunta qué sabes hacer, explícaselo en pocas líneas con ejemplos.
- Formato WhatsApp: *negrita* con UN asterisco, sin títulos #. Responde en español, breve y cercano.${memoria ? `

LO QUE RECUERDAS (memoria de Corpy):
${memoria}` : ''}${contexto ? `

CONVERSACIÓN RECIENTE (el mensaje a contestar es el siguiente):
${contexto}` : ''}`;
}

async function llamar(messages, hoy, contexto, memoria) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { tipo: 'nada' };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: require('./config').ia.agente, max_tokens: 700, system: prompt(hoy, contexto, memoria), tools: tools(), messages }),
  });
  if (!r.ok) { console.error('[CorpySocio] IA HTTP', r.status); return { tipo: 'nada' }; }
  const data = await r.json();
  const blocks = data.content || [];
  const tool = blocks.find(b => b.type === 'tool_use');
  if (tool) return { tipo: 'tool', name: tool.name, input: tool.input || {} };
  const txt = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return txt ? { tipo: 'texto', texto: txt } : { tipo: 'nada' };
}

async function aAlex(msg) { try { await require('./notifications').sendWhatsApp(msg); } catch (e) { console.warn('[CorpySocio] aviso a Álex:', e.message); } }

async function ejecutar(name, input, { from, trab, _prog = null, _cal = null, _stel = null }) {
  const P = _prog || require('./programados');
  const userId = trab.userId;
  if (name === 'registrar_visita') {
    const r = await require('./visitas').registrar({ ...input, quienes: quienesDeAlfonso(input.quienes) }, 'Alfonso (Corpy)', { from });
    if (r && r.ok) await aAlex(`🤝 *Alfonso* ha contado una visita a Corpy:\n\n${r.reply.replace(/\n📸 Si tienes fotos.*$/, '')}`);
    return { reply: r.reply.replace('en tu agenda', 'en el calendario'), aclara: !!r.aclara };
  }
  if (name === 'apuntar_tiempo_socio') {
    let d; try { d = await require('./tiempoSocios').apuntar({ ...input, quienes: quienesDeAlfonso(input.quienes) }, 'Alfonso (Corpy)'); } catch (e) { return { reply: e.message, aclara: true }; }
    const h = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
    return { reply: `⏱️ Apuntado: *${d.quienes.join(' y ')}* · ${h(d.minutos)} h · ${d.tipo}${d.que ? ' — ' + d.que : ''}${d.obraRef ? ` · obra *${d.obraRef}*` : d.cliente ? ` · ${d.cliente}` : ''}.` };
  }
  if (name === 'recordatorio') {
    if (!fechaOk(input.fecha) || !String(input.texto || '').trim()) return { reply: '¿Qué te recuerdo y qué día?', aclara: true };
    const hora = horaOk(input.hora) ? pad(input.hora) : '09:00';
    const at = aDate(input.fecha, hora);
    if (at.getTime() < Date.now() - 60000) return { reply: `Esa hora (${fFecha(input.fecha)} ${hora}) ya ha pasado. ¿Para cuándo te lo recuerdo?`, aclara: true };
    if (!userId) return { reply: 'No te encuentro en la lista de usuarios; se lo paso a Álex.' };
    await P.crear({ at, tipo: 'whatsapp', userId, nombre: trab.name || 'Alfonso', texto: `⏰ *Recordatorio*: ${String(input.texto).trim()}`, nota: 'Recordatorio que pidió Alfonso', importante: true }, 'Alfonso (Corpy)');
    return { reply: `⏰ Hecho: te lo recuerdo el *${fFecha(input.fecha)} a las ${hora}*: ${String(input.texto).trim()}` };
  }
  if (name === 'crear_cita') {
    const { fecha, hora, titulo, lugar, nota, avisar_dias_antes: antes } = input || {};
    if (!fechaOk(fecha) || !titulo) return { reply: '¿Qué cita apunto y para qué día?', aclara: true };
    const h = horaOk(hora) ? pad(hora) : null;
    try { await (_cal || require('./calendar')).crearEventoPersonal({ date: fecha, hora: h, titulo: `Alfonso: ${titulo}`, lugar: lugar || null, nota: [nota, 'Apuntada por Alfonso'].filter(Boolean).join(' · ') }); }
    catch (e) { console.error('[CorpySocio] cita:', e.message); return { reply: 'No he podido apuntarla en el calendario. Prueba otra vez en un rato.' }; }
    // Aviso por WhatsApp: 1 h antes si tiene hora; si no, a las 8:00 de ese día. Y X días antes si es importante.
    const avisos = [];
    const t = h ? new Date(aDate(fecha, h).getTime() - 3600000) : aDate(fecha, '08:00');
    const txt = `🗓️ *Cita${h ? ' a las ' + h : ' hoy'}*: ${titulo}${lugar ? ' · ' + lugar : ''}${nota ? '\n' + nota : ''}`;
    if (userId && t.getTime() > Date.now()) { await P.crear({ at: t, tipo: 'whatsapp', userId, nombre: trab.name || 'Alfonso', texto: txt, nota: 'Aviso de cita de Alfonso', importante: true }, 'Alfonso (Corpy)'); avisos.push(h ? 'una hora antes' : 'ese día a las 8:00'); }
    if (userId && antes > 0) {
      const d = new Date(aDate(fecha, '09:00').getTime() - antes * 86400000);
      if (d.getTime() > Date.now()) { await P.crear({ at: d, tipo: 'whatsapp', userId, nombre: trab.name || 'Alfonso', texto: `🗓️ En ${antes} días (${fFecha(fecha)}${h ? ' a las ' + h : ''}): ${titulo}${lugar ? ' · ' + lugar : ''}`, nota: 'Aviso previo de cita de Alfonso', importante: true }, 'Alfonso (Corpy)'); avisos.push(`${antes} días antes`); }
    }
    return { reply: `🗓️ Apuntada en el calendario: *${titulo}* — ${fFecha(fecha)}${h ? ' a las ' + h : ''}${lugar ? ' · ' + lugar : ''}.${avisos.length ? `\n⏰ Te aviso por aquí ${avisos.join(' y ')}.` : ''}` };
  }
  if (name === 'recordar_dato') {
    try {
      const r = await require('./memoria').corregir({ sobre: input.sobre, texto: input.texto, tipo: input.tipo || 'correccion', sitio: input.sitio || null, por: 'Alfonso' });
      await aAlex(`🧠 *Alfonso* le ha dicho a Corpy que recuerde, de *${r.sujeto}*: ${input.texto}`);
      return { reply: `🧠 Apuntado de *${r.sujeto}*${input.sitio ? ` (${input.sitio})` : ''}: ${input.texto}\nNo se me olvida.` };
    } catch (e) { return { reply: e.message, aclara: true }; }
  }
  if (name === 'estado_presupuesto') {
    const ref = 'PRT' + String((String(input.ref || '').match(/\d{3,5}/) || [''])[0]).padStart(5, '0');
    const E = { aceptado: 1120656, rechazado: 1120642 };
    if (!/PRT\d{5}/.test(ref) || !E[input.estado]) return { reply: '¿Qué presupuesto y cómo lo dejo? Ej.: «PRT00880 aceptado».', aclara: true };
    const S = _stel || require('./stelorder');
    const p = (await S.getWorkEstimates()).find(e => e['full-reference'] === ref);
    if (!p) return { reply: `No encuentro el ${ref} en StelOrder. ¿Es otro número?`, aclara: true };
    try { await S.setWorkEstimateState(p.id, E[input.estado], { requestedBy: 'Alfonso (Corpy)' }); } catch (e) { return { reply: `No he podido cambiar el ${ref}: ${e.message}. Se lo paso a Álex.` }; }
    try { await require('./memoria').apuntar({ sujeto: { tipo: 'cliente', id: String(p['account-id']), nombre: p.title || ref }, tipo: 'presupuesto', unico: ref, texto: `${ref} ${input.estado} (Alfonso)`, ambito: 'cliente', fuente: { tipo: 'correccion', ref } }); } catch (e) {}
    const imp = Number(p['total-amount']) ? ` · ${Number(p['total-amount']).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €` : '';
    await aAlex(`🤝 *Alfonso*: ${ref}${p.title ? ` (${p.title})` : ''}${imp} → *${input.estado}*. Ya está cambiado en StelOrder.`);
    return { reply: `✅ ${ref}${p.title ? ` (${p.title})` : ''} marcado como *${input.estado}* en StelOrder. Se lo he dicho a Álex.` };
  }
  if (name === 'mis_recordatorios') {
    const l = (await P.lista()).filter(x => x.estado === 'pendiente' && String(x.userId || '') === String(userId) && /Alfonso/.test(x.por || ''));
    if (!l.length) return { reply: 'Ahora mismo no tengo nada pendiente de recordarte.' };
    return { reply: `⏰ *Lo que te tengo que recordar*:\n${l.slice(0, 15).map(x => `• ${new Date(x.at).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} — ${String(x.texto).replace(/^[^:]*:\s*/, '').split('\n')[0].slice(0, 120)}`).join('\n')}` };
  }
  return { reply: null };
}

// Aclaración en curso (una ronda): lo que dijo y lo que Corpy le preguntó.
const aclaraciones = new Map();

// Devuelve el texto de la respuesta, o null si no es suyo (sigue el camino de siempre: se le pasa a Álex).
async function intentar({ texto, from, trab, _llamar = null, _prog = null, _cal = null, _contexto = null, _memoria = null }) {
  if (String(process.env.CORPY_SOCIO || '').toLowerCase() === 'off') return null;
  if (!String(texto || '').trim()) return null;
  const hoy = hoyISO();
  const prev = aclaraciones.get(from);
  const enAclaracion = prev && Date.now() - prev.ts < 10 * 60 * 1000;
  const messages = enAclaracion
    ? [{ role: 'user', content: prev.texto }, { role: 'assistant', content: prev.pregunta }, { role: 'user', content: String(texto) }]
    : [{ role: 'user', content: String(texto) }];
  let contexto = '', memoria = '';
  try { contexto = _contexto != null ? _contexto : String(await require('./agenteExtra').contextoReciente(from)).replace(/\] Álex:/g, '] Alfonso:'); } catch (e) {}
  try { memoria = _memoria != null ? _memoria : await require('./memoria').paraPrompt(texto, { interno: true, limite: 20 }); } catch (e) {}
  let resp;
  try { resp = await (_llamar || llamar)(messages, hoy, contexto, memoria); } catch (e) { console.error('[CorpySocio] modelo:', e.message); return null; }
  if (resp.tipo === 'tool') {
    aclaraciones.delete(from);
    let out;
    try { out = await ejecutar(resp.name, resp.input || {}, { from, trab, _prog, _cal }); }
    catch (e) { console.error('[CorpySocio]', resp.name, e.message); return null; }
    if (!out.reply) return null;
    if (out.aclara) aclaraciones.set(from, { texto: enAclaracion ? prev.texto : String(texto), pregunta: out.reply, ts: Date.now() });
    console.log(`[CorpySocio] tool=${resp.name}`);
    return out.reply.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
  }
  if (resp.tipo === 'texto') {
    if (/\bNO_ES_MIO\b/.test(resp.texto)) { aclaraciones.delete(from); return null; }
    if (enAclaracion) aclaraciones.delete(from);
    else aclaraciones.set(from, { texto: String(texto), pregunta: resp.texto, ts: Date.now() });
    return resp.texto.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
  }
  return null;
}

// El mensaje de bienvenida que explica a Alfonso qué puede hacer con Corpy.
const BIENVENIDA = `Hola Alfonso 👋 Soy *Corpy*. Desde hoy también soy *tu asistente*: me hablas por aquí, con un audio o escribiendo, como a una persona.

📍 *Visitas*: cuando vengas de ver algo, cuéntamelo: dónde, con quién, cuánto rato, qué habéis acordado y si hay que hacer presupuesto o trabajo. Lo apunto en la obra o en la comunidad, cuento tu tiempo y Álex se entera del resumen. Luego mándame las fotos y van a esa visita.
_Ej.: «Vengo de Can Bells 30 con los Madrenas, de 5 a 6. Quieren cambiar la acometida y piden presupuesto para el baño.»_

⏰ *Recordatorios*: «recuérdame mañana a las 9 llamar a Madrenas» y a esa hora te escribo.

🗓️ *Citas*: «apunta el jueves a las 10 visita en Bellpuig 41». Va al calendario de Corp y te aviso una hora antes.

🧠 *Que recuerde algo*: «recuerda que el presidente de Bellpuig 41 es Jordi». Queda guardado para todos y no se me olvida.

Pregúntame «¿qué me tienes que recordar?» cuando quieras. Lo que no sea mío (presupuestos, facturas, dinero) se lo paso a Álex.`;

module.exports = { intentar, ejecutar, BIENVENIDA, _quienes: quienesDeAlfonso, _aDate: aDate, _llamar: llamar };
