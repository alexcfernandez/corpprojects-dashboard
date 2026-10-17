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
const LECTURA = new Set(['consultar_presencia', 'horas_obra', 'datos_empresa']);
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
    name: 'encargar_a_trabajador',
    description: 'ENCARGO a un trabajador: Corpy (la oficina, con su propia autoridad) le pide algo por WhatsApp y se lo recuerda hasta que conteste (p. ej. «pídele a Javi la talla de botas», «dile a Manolo que traiga mañana el carnet de conducir», «pregúntale a Diego si tiene el curso de PRL»). NO para los papeles del alta (DNI, Seguridad Social): eso va aparte.',
    input_schema: {
      type: 'object',
      properties: {
        trabajador: { type: 'string' },
        que: { type: 'string', description: 'Resumen muy corto de lo que se pide (3-6 palabras), p. ej. «talla de botas».' },
        cuando: { type: ['string', 'null'], description: 'YYYY-MM-DD si hay que decírselo más adelante («recuérdale el lunes…», «acuérdate de preguntarle el día 20…»); null = ahora.' },
        mensaje: { type: 'string', description: 'Lo que Corpy (la oficina) le dice al trabajador, en tú, breve, claro y firme, SIN decir «de parte de Álex» ni «el jefe dice». P. ej. «Necesito que me digas qué talla de botas usas, para pedirte unas de seguridad.»' },
      },
      required: ['trabajador', 'que', 'mensaje'],
    },
  },
  {
    name: 'cerrar_encargo',
    description: 'Da por hecho (o anula) un encargo a un trabajador: «Javi ya me ha dicho la talla», «Manolo ya trajo el carnet», «olvida lo de las botas de Javi».',
    input_schema: { type: 'object', properties: { trabajador: { type: 'string' }, que: { type: ['string', 'null'], description: 'De qué encargo, si tiene varios.' }, anular: { type: 'boolean', description: 'true si ya no hace falta (anulado), false si está hecho.' } }, required: ['trabajador'] },
  },
  {
    name: 'pedir_tallas',
    description: 'Pide a un trabajador (o a TODOS) sus tallas de ropa (camiseta, pantalón), calzado y fecha de nacimiento, y las guarda en su ficha. «pide las tallas a todos», «pídele la talla a Javi».',
    input_schema: { type: 'object', properties: { trabajador: { type: ['string', 'null'], description: 'null o «todos» = a todos.' } } },
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
    name: 'nueva_incorporacion',
    description: 'ALTA DE UNA PERSONA NUEVA que empieza a trabajar: «empieza Norman el lunes 19», «el día 2 entra Pedro García, su móvil es 6…, DNI …, oficial de primera». Prepara solo su ficha, le pide los papeles, rellena el formulario de condiciones de la gestoría y lo manda a firmar.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre y apellidos tal cual los diga.' },
        fechaInicio: { type: 'string', description: 'YYYY-MM-DD del primer día de trabajo.' },
        telefono: { type: ['string', 'null'], description: 'Su móvil si lo dice; null si no.' },
        dni: { type: ['string', 'null'] },
        categoria: { type: ['string', 'null'], enum: ['peo', 'oficial_3', 'oficial_1', null], description: 'peón / oficial de tercera (ayudante) / oficial de primera, si lo dice.' },
      },
      required: ['nombre', 'fechaInicio'],
    },
  },
  {
    name: 'datos_empresa',
    description: 'DATOS DE NUESTRA EMPRESA (solo lee): razón social, CIF, domicilio y qué documentos de la empresa tenemos guardados en Personal (escrituras/CIF, certificados de Hacienda y Seguridad Social, seguros, REA, TC…) con su fecha y caducidad. P. ej. «¿cuál es nuestro CIF?», «¿tenemos el certificado de Hacienda al día?».',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'pasar_documento',
    description: 'PASA AL JEFE UN DOCUMENTO guardado en Personal, de la EMPRESA (CIF/escrituras, certificado de Hacienda o de la Seguridad Social, seguro, REA, TC, ITA…) o de un TRABAJADOR (DNI/NIE, Seguridad Social, contrato, nómina, reconocimiento médico, cursos de PRL, carnés…). P. ej. «pásame el CIF de la empresa», «mándame el DNI de Javi», «necesito el certificado de Hacienda», «envíame la última nómina de Manolo».',
    input_schema: {
      type: 'object',
      properties: {
        de: { type: 'string', description: '«empresa» si es de la empresa; si no, el nombre del trabajador.' },
        que: { type: 'string', description: 'Qué documento, en pocas palabras (p. ej. «CIF», «certificado Hacienda», «DNI», «nómina septiembre», «curso PRL»).' },
      },
      required: ['de', 'que'],
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

const EXTRA = require('./agenteExtra');
TOOLS.push(...EXTRA.TOOLS);
for (const t of EXTRA.LECTURA) LECTURA.add(t);

function systemPrompt(hoy, contexto = '') {
  return `Eres el asistente del jefe de una empresa de mantenimiento de fincas, por WhatsApp. Hoy es ${hoy} (Europe/Madrid).
REGLAS DURAS:
- Si NO puedes resolver con confianza a qué/quién se refiere (comunidad, cliente, trabajador), haz una PREGUNTA corta de aclaración; NUNCA elijas "el más parecido".
- NUNCA inventes datos (fechas, importes, números de documento). Si falta un dato, pídelo.
- Distingue: "en el calendario / en la agenda" + fecha/hora = evento personal → crear_evento_agenda. "en <comunidad> que <hecho>" = nota de comunidad → anadir_nota_comunidad. Si es ambiguo, pregunta.
- Resuelve fechas relativas ("mañana", "el lunes", "el 19") a YYYY-MM-DD respecto a hoy.
- HORA: si es INEQUÍVOCA ("19:30", "a las 19", "a las 8 de la mañana", "mediodía") → HH:MM en 24h. Si es AMBIGUA mañana/tarde ("las 7.30", "a las 8", "a las 5" sin "de la mañana/tarde" ni formato 24h) → NO la asumas: PREGUNTA "¿mañana o tarde? (p. ej. 07:30 o 19:30)" antes de crear el evento. Si no dice hora → null.
- Tallas de ropa/calzado y cumpleaños → pedir_tallas. «Pídele / dile / pregúntale / recuérdale a X que…» (también «acuérdate de preguntarle a X el lunes…») → encargar_a_trabajador (redacta el mensaje para el trabajador en tú, breve). «X ya lo ha hecho / ya me lo dio / olvida lo de…» → cerrar_encargo.
- Presencia, horas, quién trabajó/vino/faltó, vacaciones, bajas → consultar_presencia. Para «cuántos días faltó/trabajó/lleva X» usa resumenPorPersona: «faltó» = faltaInjustificada + faltaJustificada + sinApuntar (días laborables sin nada apuntado); dilo desglosado y con las fechas si son pocas. Si preguntan «cuántos días lleva» sin decir de qué, da días trabajados (y vacaciones/baja si hay). Horas o coste de una obra → horas_obra. Contesta SOLO con lo que devuelvan (si no hay datos, dilo). «Esta semana» = desde el lunes.
- «Empieza / entra a trabajar X el día…», «da de alta a…» → nueva_incorporacion.
- Datos o documentos de NUESTRA empresa (CIF, razón social, domicilio, certificados) → datos_empresa. «Pásame / mándame / necesito / envíame <documento>» de la empresa o de un trabajador → pasar_documento (NO digas que no tienes acceso: búscalo).
- Lo que nos DEBE un cliente o comunidad → facturas_cliente. Si vuelve más de un cliente igual de parecido, di cuáles y PREGUNTA; si uno encaja claramente, contesta con ese. «No tiene pendientes» solo si su lista está vacía.
- Qué material se compró, dónde o para qué obra → buscar_compras. Cuánto gastamos en un proveedor → gasto_proveedor (Obramat = Bricoman = Bricomart; Bauhaus = Werkhaus).
- Papeles de un vehículo (ficha técnica, permiso, seguro, ITV) → pasar_documento_vehiculo (o documentos_vehiculo para solo mirar). Los vehículos NO son clientes ni comunidades.
- Si Corpy preguntó «¿de qué vehículo es?» un repostaje y Álex contesta con un vehículo o con quién lo lleva o lo puso → asignar_repostaje (aunque hayan pasado días). Si no existe y Álex dice «créala / dala de alta como…» → crear_vehiculo.
- «Hecho el pendiente 1, 2 y 3» → cerrar_pendientes con todos los números.
- Documentos por número, presupuestos, pedidos, resumen, cobros, PDF de pendientes, notas de comunidad → consulta_clasica con la consulta reescrita clara (con el nombre exacto que hayas sacado de la conversación). Pasa su respuesta casi tal cual.
- Respuestas cortas («era Rutlla 202», «el de Alfonso», «no, la otra»): entiéndelas con la CONVERSACIÓN RECIENTE de abajo y sigue con lo que se estaba hablando.
- Si Álex pide CREAR o CAMBIAR algo que no está en tus herramientas (hacer o modificar un presupuesto, una factura, un pedido o una incidencia, cambiar importes…) contesta solo: NO_ES_MIO. Apuntar pendientes o recordatorios para Álex SÍ es tuyo (apuntar_pendiente); los de la agenda con hora, crear_evento_agenda.
- Al contestar con datos: breve, para WhatsApp (*negritas* para nombres y totales, una línea por persona u obra).
- Formato de WhatsApp: negrita con UN asterisco a cada lado (*así*), NUNCA con dos (**así**), sin títulos con # ni líneas ---.
- Responde en español y breve.${contexto ? `

CONVERSACIÓN RECIENTE (lo último que se han dicho; el mensaje a contestar es el siguiente):
${contexto}` : ''}`;
}

// Llama al modelo con tools. Devuelve {tipo:'tool',name,input} | {tipo:'texto',texto} | {tipo:'nada'}.
async function llamarModelo(messages, hoy, { maxTokens = 500, contexto = '' } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { tipo: 'nada' };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODELO(), max_tokens: maxTokens, system: systemPrompt(hoy, contexto), tools: TOOLS, messages }),
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
// Nuestra empresa: datos fiscales y qué papeles suyos hay en Personal.
const EMPRESA = () => ({ razonSocial: 'CORP. PROJECTS HOLDING, S.L.', cif: process.env.EMPRESA_CIF || 'B09899253', domicilio: process.env.EMPRESA_DOMICILIO || 'C/ Nou 12, 2º 2B, 17001 Girona' });
async function datosEmpresa() {
  const P = require('./personalDocs');
  let docs = [];
  try { docs = (await P.carpeta({ ambito: 'empresa' })).map(d => ({ tipo: (P.TIPOS_EMPRESA[d.tipo] || {}).nombre || d.tipo, fecha: d.fecha || null, caduca: d.caduca || null, mes: d.mes || null, nombre: d.nombre || null })); } catch (e) {}
  return { ...EMPRESA(), documentos: docs.slice(0, 40), nota: 'Para mandar un documento usa pasar_documento.' };
}
const LECTORES = { consultar_presencia: consultarPresencia, horas_obra: horasObra, datos_empresa: datosEmpresa, ...EXTRA.LECTORES };

// Busca en Personal el documento que pide el jefe y le manda un enlace que caduca (solo al dueño).
const _palabras = s => _n(s).split(' ').filter(w => w.length >= 3 && !['del', 'las', 'los', 'una', 'uno', 'de', 'la', 'el', 'que', 'por', 'para', 'ultimo', 'ultima', 'empresa'].includes(w));
const SINONIMOS = [[/\b(cif|nif|escritura|constitucion)/, 'escrituras'], [/hacienda|aeat|tributari/, 'cert_hacienda'], [/seguridad social|tgss|corriente.*ss|\bss\b/, 'cert_ss'], [/\brea\b|empresas acreditadas/, 'rea'],
  [/\btc\b|rnt|rlc/, 'rnt_rlc'], [/\bita\b|trabajadores en alta/, 'ita'], [/responsabilidad civil|\brc\b/, 'seguro_rc'], [/accidente/, 'seguro_acc'], [/\bdni\b|\bnie\b|pasaporte|residencia/, 'dni'],
  [/nomina|nómina/, 'nomina'], [/contrato/, 'contrato'], [/medic|reconocimiento|aptitud/, 'reconocimiento'], [/prl|curso|formacion|formación/, 'formacion_prl'], [/carne|carné|conducir|plataforma/, 'carnet'], [/numero.*seguridad|tarjeta.*ss|nuss|afiliacion/, 'tarjeta_ss'], [/\bta ?7\b/, 'ta7'], [/\biae\b/, 'iae'], [/epi/, 'epis']];
async function pasarDocumento({ de, que } = {}, from) {
  if (!require('./acceso').esOwner(from)) return { handled: true, reply: 'Los documentos de la empresa y del personal solo se los paso a Álex.' };
  const P = require('./personalDocs');
  const esEmpresa = /^(la )?empresa|corp|nosotros|nuestr/i.test(String(de || '').trim());
  let docs, quien;
  if (esEmpresa) { docs = await P.carpeta({ ambito: 'empresa' }); quien = 'la empresa'; }
  else {
    const u = await _trabajador(de || '');
    if (!u || u.varios) return { handled: true, reply: u && u.varios && u.varios.length ? `¿De quién? Hay varios: ${u.varios.join(', ')}.` : `No encuentro a «${de}».`, aclara: true };
    docs = await P.carpeta({ userId: String(u._id) }); quien = u.name;
  }
  const nq = _n(que);
  const tipo = (SINONIMOS.find(([re]) => re.test(nq)) || [])[1];
  const ws = _palabras(que);
  const nombreTipo = d => ((esEmpresa ? P.TIPOS_EMPRESA : P.TIPOS)[d.tipo] || {}).nombre || d.tipo;
  // Las palabras cuentan en el nombre del archivo y sus notas, no en el nombre del tipo (con «CIF» empataban todas las
  // escrituras y se mandaban 3, 15/10/2026). Si no casa por tipo, el nombre del tipo sí ayuda a encontrarlo.
  const puntos = d => (tipo && d.tipo === tipo ? 10 : 0) + ws.filter(w => _n([d.nombre, d.notas, d.mes, tipo ? '' : nombreTipo(d)].join(' ')).includes(w)).length;
  const cand = docs.map(d => ({ d, p: puntos(d) })).filter(x => x.p > 0).sort((a, b) => b.p - a.p || String(b.d.fecha || b.d.subido || '').localeCompare(String(a.d.fecha || a.d.subido || '')));
  const extra = esEmpresa && tipo === 'escrituras' ? `\nCIF: *${EMPRESA().cif}* · ${EMPRESA().razonSocial}` : '';
  if (!cand.length) return { handled: true, reply: `No tengo «${que}» de ${quien} en Personal.${extra}\nSi lo tienes, súbelo en https://dashboard.corpprojects.es/personal y te lo paso cuando quieras.` };
  // Uno solo (el que mejor encaja y, si empatan, el más reciente), salvo que pida varios («todos», «todas las nóminas»).
  const varios = /\btod[oa]s\b/.test(nq);
  const top = (varios ? cand.filter(x => x.p === cand[0].p).slice(0, 5) : cand.slice(0, 1)).map(x => x.d);
  const E = { HORAS: 24, crear: async (id) => require('./enlaceDoc').url(String(id), { dias: 1 }) }; const f = x => x ? String(x).slice(0, 10).split('-').reverse().join('/') : null;
  // Por el puente, el archivo va dentro del chat (con el enlace de pie por si no se abre); con Twilio, solo el enlace.
  const W = require('./canalWhatsapp'); let mandados = 0;
  if (W.canalActivo() === 'bridge') {
    for (const d of top) {
      try { const raw = await P.archivo(d.id || d._id);
        const pie = `📎 ${nombreTipo(d)}${d.nombre ? ` (${d.nombre})` : ''}\nSi no se abre: ${await E.crear(d.id || d._id, { nombre: d.nombre || nombreTipo(d), para: from })}`;
        if (raw && raw.data && await W.enviarArchivo(from, pie, { data: raw.data.buffer ? Buffer.from(raw.data.buffer) : raw.data, mime: raw.mime || d.mime, nombre: d.nombre || nombreTipo(d) })) mandados++;
      } catch (e) { console.warn('[Agente] archivo:', e.message); }
    }
    if (mandados === top.length) return { handled: true, reply: `Te lo mando aquí mismo${mandados > 1 ? ` (${mandados} documentos)` : ''}.${extra}` };
  }
  const lineas = [];
  for (const d of top) lineas.push(`📎 *${nombreTipo(d)}*${d.nombre ? ` (${d.nombre})` : ''}${d.fecha ? ` · ${f(d.fecha)}` : ''}${d.caduca ? ` · caduca ${f(d.caduca)}` : ''}\n${await E.crear(d.id || d._id, { nombre: d.nombre || nombreTipo(d), para: from })}`);
  return { handled: true, reply: `${lineas.join('\n\n')}${extra}\n\n_El enlace es solo para ti y caduca en ${E.HORAS} h._` };
}

async function _trabajador(nombre) {
  const us = (await require('./users').getUsers(false)).filter(u => u.active !== false);
  const c = us.filter(u => _casa(u.name, nombre)); if (c.length === 1) return c[0];
  const p = us.filter(u => _n(u.name).split(' ')[0] === _n(nombre).split(' ')[0]); if (p.length === 1) return p[0];
  return { varios: (c.length ? c : p).map(u => u.name) };
}
async function ejecutarTool(name, input, from) {
  if (name === 'nueva_incorporacion') {
    if (!require('./acceso').esOwner(from)) return { handled: true, reply: 'Las altas de gente nueva las pone Álex o la oficina desde el dashboard: https://dashboard.corpprojects.es/incorporaciones' };
    try {
      const I = require('./incorporaciones');
      const v = await I.crear({ nombre: input.nombre, fechaInicio: input.fechaInicio, telefono: input.telefono || '', dni: input.dni || '', condiciones: input.categoria ? { categoria: input.categoria } : {} }, 'Álex (Corpy)');
      const f = d => String(d).split('-').reverse().join('/');
      const hecho = v.pasos.filter(p => p.ok).map(p => '✅ ' + p.t), falta = v.pasos.filter(p => !p.ok && p.antes).map(p => '⏳ ' + p.t + (p.nota ? ` (${p.nota})` : ''));
      const pide = [!input.telefono && 'su *móvil*', !input.dni && 'su *DNI/NIE*'].filter(Boolean);
      return { handled: true, reply: `🧑‍🔧 Alta de *${v.nombre}* en marcha, empieza el *${f(v.fechaInicio)}* \n\nCondiciones propuestas: ${I.CATEGORIAS[v.condiciones.categoria]}, indefinido, convenio, jornada completa, 15 días de prueba. *Confírmalas en la pantalla* antes de generar el papel para firmar.\n\n${[...hecho, ...falta].join('\n')}${pide.length ? `\n\nPara seguir necesito ${pide.join(' y ')}: ponlos aquí: https://dashboard.corpprojects.es/incorporaciones` : '\n\nTodo en https://dashboard.corpprojects.es/incorporaciones'}` };
    } catch (e) { return { handled: true, reply: e.message }; }
  }
  if (name === 'pasar_documento') { try { return await pasarDocumento(input || {}, from); } catch (e) { console.error('[Agente] documento:', e.message); return { handled: true, reply: 'No he podido sacar el documento ahora mismo, inténtalo en un momento.' }; } }
  if (name === 'encargar_a_trabajador') {
    const u = await _trabajador(input.trabajador || '');
    if (!u || u.varios) return { handled: true, reply: u && u.varios && u.varios.length ? `¿A quién? Hay varios: ${u.varios.join(', ')}.` : `No encuentro a «${input.trabajador}».`, aclara: true };
    try { const r = await require('./encargos').crear({ userId: String(u._id), que: input.que, mensaje: input.mensaje, cuando: input.cuando || null, por: 'Álex (Corpy)' });
      if (r.programado) return { handled: true, reply: `🗓️ Apuntado: el *${r.programado.split('-').reverse().join('/')}* le diré a *${u.name}*:\n_${input.mensaje}_\n\nY le seguiré insistiendo hasta que conteste.` };
      return { handled: true, reply: `📨 Se lo he pedido a *${u.name}*:\n_${input.mensaje}_\n\nCuando conteste te lo paso. Si no contesta, se lo recuerdo mañana y pasado, y si sigue sin contestar te aviso.` }; }
    catch (e) { return { handled: true, reply: e.message }; }
  }
  if (name === 'pedir_tallas') {
    const F = require('./fichaDatos');
    if (!input.trabajador || /^tod/i.test(input.trabajador)) {
      const r = await F.pedirATodos({ por: 'Álex (Corpy)' });
      const ped = r.filter(x => x.estado === 'pedidas').map(x => x.nombre), ya = r.filter(x => x.estado === 'ya las tiene').map(x => x.nombre), err = r.filter(x => x.error);
      return { handled: true, reply: `👕 Tallas y cumpleaños pedidos a ${ped.length}: ${ped.join(', ') || '—'}.${ya.length ? `\nYa las tienen: ${ya.join(', ')}.` : ''}${err.length ? `\n⚠️ ${err.map(x => x.nombre + ': ' + x.error).join('; ')}` : ''}\n\nSe las recuerdo hasta que contesten y las guardo en su ficha.` };
    }
    const u = await _trabajador(input.trabajador); if (!u || u.varios) return { handled: true, reply: `¿A quién? No tengo claro «${input.trabajador}».` };
    try { const r = await F.pedir(String(u._id), { por: 'Álex (Corpy)' }); return { handled: true, reply: r.yaEsta ? `${u.name} ya tiene todas sus tallas apuntadas.` : r.yaPedido ? `A ${u.name} ya se las pedí; se las sigo recordando.` : `👕 Pedidas las tallas a *${u.name}*.` }; }
    catch (e) { return { handled: true, reply: e.message }; }
  }
  if (name === 'cerrar_encargo') {
    const u = await _trabajador(input.trabajador || '');
    if (!u || u.varios) return { handled: true, reply: `¿De quién? No tengo claro «${input.trabajador}».` };
    const E = require('./encargos'); let l = await E.abiertosDe(String(u._id));
    if (input.que) { const f = l.filter(e => _casa(e.que + ' ' + e.mensaje, input.que)); if (f.length) l = f; }
    if (!l.length) return { handled: true, reply: `${u.name} no tiene encargos pendientes.` };
    if (l.length > 1 && !input.que) return { handled: true, reply: `${u.name} tiene ${l.length} encargos: ${l.map(e => '«' + e.que + '»').join(', ')}. ¿Cuál cierro?`, aclara: true };
    await E.cerrar(String(l[0]._id), { como: input.anular ? 'cancelado' : 'hecho', por: 'Álex (Corpy)' });
    return { handled: true, reply: `✔ ${input.anular ? 'Anulado' : 'Cerrado'} el encargo «${l[0].que}» de *${u.name}*.` };
  }
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
  return EXTRA.ejecutar(name, input || {}, from);
}

const _wa = t => String(t || '').replace(/\*\*([^*\n]+)\*\*/g, '*$1*').replace(/^#{1,6}\s*/gm, '').replace(/^\s*-{3,}\s*$/gm, '');
async function intentar(args = {}) {
  const r = await _intentar(args);
  if (r && r.handled && typeof r.reply === 'string') r.reply = _wa(r.reply);
  return r;
}
async function _intentar({ texto, from, imagenes = [], puerta = null, contexto = '' } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) return { handled: false };
  if ((EXTRA.DENTRO.getStore() || {}).desdeAgente) return { handled: false };   // ya estamos dentro del agente
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
  try { resp = await _impl.llamarModelo(messages, hoy, { contexto }); }
  catch (e) { console.error('[Agente] modelo:', e.message); return { handled: false }; }

  // Consultas: se leen los datos y el modelo redacta la respuesta con ellos (hasta 3 consultas encadenadas).
  for (let vuelta = 0; resp.tipo === 'tool' && LECTURA.has(resp.name) && vuelta < 3; vuelta++) {
    let datos;
    try { datos = await LECTORES[resp.name](resp.input || {}, from); } catch (e) { console.error('[Agente] lectura', resp.name, e.message); datos = { error: 'No he podido leer los datos ahora mismo.' }; }
    messages.push({ role: 'assistant', content: resp.blocks }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: resp.id, content: JSON.stringify(datos).slice(0, 20000) }] });
    console.log(`[Agente] lectura=${resp.name} puerta=${puerta || '?'}`);
    try { resp = await _impl.llamarModelo(messages, hoy, { maxTokens: 900, contexto }); } catch (e) { console.error('[Agente] modelo:', e.message); return { handled: false }; }
    if (resp.tipo === 'texto') { estado.delete(from); if (/^\s*NO_ES_MIO\b/.test(resp.texto)) return { handled: false }; return { handled: true, reply: resp.texto }; }
  }

  if (resp.tipo === 'tool') {
    estado.delete(from); // se resuelve la intención; limpiamos cualquier aclaración
    const out = await ejecutarTool(resp.name, resp.input, from);
    if (out.aclara) estado.set(from, { accion: 'agente_aclara', textoOriginal: (enAclaracion && prev.textoOriginal) || texto, pregunta: out.reply, ts: Date.now() });
    console.log(`[Agente] tool=${resp.name} puerta=${puerta || '?'}`);
    return { handled: out.handled !== false, reply: out.reply };
  }
  if (resp.tipo === 'texto' && /^\s*NO_ES_MIO\b/.test(resp.texto)) return { handled: false };
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

module.exports = { intentar, TOOLS, _impl, _consultarPresencia: consultarPresencia, _horasObra: horasObra, _pasarDocumento: pasarDocumento, _datosEmpresa: datosEmpresa };
