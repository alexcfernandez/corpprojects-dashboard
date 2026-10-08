// src/rrhh.js — Candidatos (8/10/2026): de «me ha llamado uno que es pintor» a trabajador dado de alta.
//
//   · Ficha del candidato: datos, oficio, carné y coche, disponibilidad, lo que pide cobrar, de dónde viene.
//   · Documentos: CV, DNI, carné… (foto con el móvil o PDF). Al subir un CV, la IA rellena lo que falte.
//   · Entrevista guiada: preguntas generales + las de su oficio, con lo que hay que buscar en la respuesta;
//     cada una se puntúa de 1 a 5 y sale una nota sobre 100.
//   · Estados: nuevo → entrevista → prueba → contratado | descartado.
//   · «Pasar a trabajador»: crea el usuario (rol técnico, PIN) y pasa su DNI y carné a su carpeta de Personal.
'use strict';
const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const COL = 'candidatos', DOCS = 'candidatosDocs';
const ESTADOS = ['nuevo', 'entrevista', 'prueba', 'contratado', 'descartado'];
const TIPOS_DOC = { cv: 'Currículum', dni: 'DNI / NIE', carnet: 'Carné de conducir', prl: 'Formación PRL', otro: 'Otro' };
const txt = (v, n = 200) => String(v == null ? '' : v).trim().slice(0, n);
const oid = id => { try { return new ObjectId(String(id)); } catch (e) { throw new Error('Candidato no válido'); } };

// ── Preguntas de la entrevista ── «busca»: qué tiene que salir en una buena respuesta.
const GENERALES = [
  { id: 'g1', q: '¿Dónde has trabajado los últimos años y en qué tipo de obras?', busca: 'Experiencia real y reciente, cuánto duró en cada sitio, si son obras parecidas a las nuestras.' },
  { id: 'g2', q: '¿Qué es lo que mejor haces? ¿Y lo que no te gusta hacer?', busca: 'Que sepa decir en concreto qué domina; sinceridad con lo que no.' },
  { id: 'g3', q: '¿Tienes carné y coche? ¿Puedes ir a obras en Girona y en el Maresme?', busca: 'Autonomía para llegar a las obras; disponibilidad para moverse.' },
  { id: 'g4', q: '¿Tienes la formación de PRL y el reconocimiento médico al día?', busca: 'PRL de 20 h / 60 h según el oficio; si no, si está dispuesto a hacerla.' },
  { id: 'g5', q: 'Cuéntame un problema que tuviste en una obra y cómo lo resolviste.', busca: 'Iniciativa, que avisa a tiempo, que no culpa a otros.' },
  { id: 'g6', q: '¿Cuándo podrías empezar y cuánto esperas cobrar?', busca: 'Fecha clara y cifra razonable para el puesto.' },
];
const OFICIOS = {
  albanil: { nombre: 'Albañil', p: [
    { id: 'a1', q: '¿Cómo replanteas y levantas un tabique para que quede a plomo y en su sitio?', busca: 'Replanteo con medidas, nivel/láser, plomada, juntas, cuándo usar cada material.' },
    { id: 'a2', q: '¿Cómo impermeabilizas un baño antes de alicatar el plato de ducha?', busca: 'Lámina o mortero impermeable, entregas en paredes, pendiente al desagüe, prueba de agua.' },
    { id: 'a3', q: 'Alicatado de piezas grandes: ¿qué cemento cola y cómo evitas cejas?', busca: 'Cola C2, doble encolado, niveladores/crucetas, planeidad del soporte.' },
    { id: 'a4', q: '¿Sabes leer un plano y sacar cantidades de material?', busca: 'Escala, cotas; calcular m² y sacos aproximados.' } ] },
  pintor: { nombre: 'Pintor', p: [
    { id: 'p1', q: '¿Cómo preparas una pared antes de pintar?', busca: 'Rascar, emplastecer, lijar, imprimación; tapar y proteger.' },
    { id: 'p2', q: '¿Qué pintura usas en un baño, en una fachada y en una carpintería?', busca: 'Antimoho/plástica, pintura de fachada o pliolite, esmalte; diferencias.' },
    { id: 'p3', q: '¿Cuántos m² pintas en un día en un piso vacío, a dos manos?', busca: 'Una cifra razonable y que explique de qué depende.' },
    { id: 'p4', q: '¿Has pintado en altura (andamio o plataforma)?', busca: 'Experiencia y formación en altura; uso de arnés.' } ] },
  electricista: { nombre: 'Electricista', p: [
    { id: 'e1', q: '¿Tienes el carné de instalador / puedes firmar boletines?', busca: 'Si firma él o necesita a alguien que firme.' },
    { id: 'e2', q: '¿Qué protecciones pones en el cuadro de un piso reformado?', busca: 'IGA, diferenciales (30 mA), magnetotérmicos por circuito, sobretensiones.' },
    { id: 'e3', q: 'En una cocina nueva, ¿qué circuitos y secciones pones?', busca: 'Circuitos separados horno/placa (6 mm²), lavadora/lavavajillas, tomas; REBT.' },
    { id: 'e4', q: '¿Cómo localizas una avería que hace saltar el diferencial?', busca: 'Método: desconectar circuitos, medir aislamiento, ir acotando.' } ] },
  fontanero: { nombre: 'Fontanero', p: [
    { id: 'f1', q: '¿Con qué tubo trabajas en una reforma y por qué?', busca: 'Multicapa/PEX vs cobre; uniones; ventajas.' },
    { id: 'f2', q: '¿Cómo haces la prueba de presión antes de cerrar?', busca: 'Presión y tiempo de prueba, revisar uniones, antes de tapar.' },
    { id: 'f3', q: '¿Qué pendiente le das a un desagüe y cómo evitas malos olores?', busca: '1-2 %, sifones, ventilación, registros.' },
    { id: 'f4', q: '¿Has instalado calderas, termos o aerotermia?', busca: 'Experiencia concreta y si tiene el carné para gas.' } ] },
  pladurista: { nombre: 'Pladurista', p: [
    { id: 'l1', q: '¿Cómo montas un tabique de pladur con aislamiento?', busca: 'Canales y montantes a 40/60, lana mineral, doble placa si toca, tornillería.' },
    { id: 'l2', q: '¿Y un techo con registros y focos?', busca: 'Perfilería, cuelgues, refuerzos para focos, registros para instalaciones.' },
    { id: 'l3', q: '¿Cómo tratas las juntas para que no se marquen?', busca: 'Cinta, pasta, varias manos, lijado.' } ] },
  fachadas: { nombre: 'Fachadas / SATE', p: [
    { id: 's1', q: '¿Has trabajado con SATE? Explícame los pasos.', busca: 'Preparación del soporte, perfil de arranque, placas con adhesivo y espigas, malla, mortero, acabado.' },
    { id: 's2', q: '¿Tienes formación para trabajar en altura y montar andamio?', busca: 'Curso de andamios / trabajos en altura, uso de EPIs.' },
    { id: 's3', q: '¿Cómo reparas un frente de forjado con el hierro oxidado?', busca: 'Picar, limpiar armadura, pasivar, mortero de reparación.' } ] },
  peon: { nombre: 'Peón', p: [
    { id: 'o1', q: '¿Qué trabajos has hecho de peón?', busca: 'Demoliciones, carga y descarga, preparar mortero, limpieza.' },
    { id: 'o2', q: '¿Qué te gustaría aprender?', busca: 'Ganas de crecer en un oficio.' },
    { id: 'o3', q: '¿Cómo dejas la obra al acabar el día?', busca: 'Orden, limpieza, recoger herramienta, seguridad.' } ] },
  encargado: { nombre: 'Encargado de obra', p: [
    { id: 'n1', q: '¿Cómo organizas la semana de una obra con varios oficios?', busca: 'Planificación por fases, coordinación de gremios, pedir material con tiempo.' },
    { id: 'n2', q: '¿Cómo tratas con un cliente que se queja?', busca: 'Escucha, explica, propone solución, informa a la oficina.' },
    { id: 'n3', q: '¿Cómo controlas que una obra no se pase de horas ni de material?', busca: 'Partes diarios, mediciones, revisar pedidos, avisar de desvíos.' } ] },
  oficina: { nombre: 'Oficina / administración', p: [
    { id: 'c1', q: '¿Con qué programas has trabajado (facturación, Excel, correo)?', busca: 'Soltura con herramientas; StelOrder o parecido es un plus.' },
    { id: 'c2', q: '¿Cómo llevarías el seguimiento de facturas pendientes de cobro?', busca: 'Orden, recordatorios, trato amable pero firme.' } ] },
  otro: { nombre: 'Otro oficio', p: [] },
};
function preguntas(oficio) {
  const o = OFICIOS[oficio] || OFICIOS.otro;
  return { oficio: OFICIOS[oficio] ? oficio : 'otro', nombre: o.nombre, preguntas: [...GENERALES, ...o.p] };
}

function limpiar(d = {}) {
  const out = {};
  for (const k of ['nombre', 'telefono', 'email', 'poblacion', 'carnet', 'procedencia', 'recomendadoPor', 'salarioPedido', 'resumen', 'notas', 'motivoDescarte']) if (k in d) out[k] = txt(d[k], k === 'notas' || k === 'resumen' ? 3000 : 200);
  if ('oficio' in d) out.oficio = OFICIOS[d.oficio] ? d.oficio : 'otro';
  if ('estado' in d) { if (!ESTADOS.includes(d.estado)) throw new Error('Estado no válido'); out.estado = d.estado; }
  if ('coche' in d) out.coche = d.coche === true || d.coche === 'true' || d.coche === 'si';
  if ('anosExperiencia' in d) out.anosExperiencia = d.anosExperiencia === '' || d.anosExperiencia == null ? null : Math.max(0, Math.min(60, Number(d.anosExperiencia) || 0));
  if ('disponible' in d) out.disponible = /^\d{4}-\d{2}-\d{2}$/.test(String(d.disponible || '')) ? d.disponible : null;
  return out;
}
const publico = c => (c ? { ...c, id: String(c._id), _id: undefined } : null);

async function lista({ estado } = {}) {
  const db = await getDB();
  const q = estado && ESTADOS.includes(estado) ? { estado } : {};
  const cs = await db.collection(COL).find(q).sort({ actualizado: -1 }).limit(500).toArray();
  const docs = await db.collection(DOCS).aggregate([{ $group: { _id: '$candidatoId', tipos: { $addToSet: '$tipo' } } }]).toArray();
  const porC = Object.fromEntries(docs.map(d => [d._id, d.tipos]));
  return cs.map(c => ({ ...publico(c), docs: porC[String(c._id)] || [], entrevista: c.entrevista ? { puntuacion: c.entrevista.puntuacion, fecha: c.entrevista.fecha } : null }));
}
async function ver(id) {
  const db = await getDB();
  const c = await db.collection(COL).findOne({ _id: oid(id) });
  if (!c) throw new Error('Candidato no encontrado');
  const docs = await db.collection(DOCS).find({ candidatoId: String(c._id) }).project({ data: 0 }).sort({ subido: -1 }).toArray();
  return { ...publico(c), documentos: docs.map(d => ({ id: String(d._id), tipo: d.tipo, tipoTxt: TIPOS_DOC[d.tipo] || d.tipo, nombre: d.nombre, mime: d.mime, size: d.size, subido: d.subido })) };
}
async function crear(d, por) {
  const db = await getDB();
  const c = { estado: 'nuevo', oficio: 'otro', ...limpiar(d), creado: new Date(), actualizado: new Date(), por: por || '', historial: [{ at: new Date(), por: por || '', que: 'alta' }] };
  if (!c.nombre) c.nombre = 'Sin nombre';
  const r = await db.collection(COL).insertOne(c);
  return ver(r.insertedId);
}
async function editar(id, d, por) {
  const db = await getDB();
  const set = { ...limpiar(d), actualizado: new Date() };
  const push = set.estado ? { historial: { at: new Date(), por: por || '', que: `estado → ${set.estado}` } } : null;
  await db.collection(COL).updateOne({ _id: oid(id) }, { $set: set, ...(push ? { $push: push } : {}) });
  return ver(id);
}
async function borrar(id) {
  const db = await getDB();
  await db.collection(DOCS).deleteMany({ candidatoId: String(id) });
  await db.collection(COL).deleteOne({ _id: oid(id) });
  return { ok: true };
}

// ── Documentos ──
async function subirDoc(id, { tipo, archivo, leerIA = true }, por) {
  if (!archivo || !archivo.buffer) throw new Error('Falta el archivo');
  if (!/^(image\/|application\/pdf)/.test(archivo.mimetype || '')) throw new Error('Sube un PDF o una foto');
  const db = await getDB();
  const c = await db.collection(COL).findOne({ _id: oid(id) });
  if (!c) throw new Error('Candidato no encontrado');
  const t = TIPOS_DOC[tipo] ? tipo : 'otro';
  await db.collection(DOCS).insertOne({ candidatoId: String(c._id), tipo: t, nombre: txt(archivo.originalname || TIPOS_DOC[t], 120), mime: archivo.mimetype, size: archivo.size || archivo.buffer.length, data: archivo.buffer, subido: new Date(), por: por || '' });
  let leido = null;
  if (t === 'cv' && leerIA) {
    leido = await leerCV(archivo).catch(e => ({ error: e.message }));
    if (leido && !leido.error) {
      // Solo se rellena lo que esté vacío: lo que haya escrito oficina manda.
      const set = {};
      for (const [k, v] of Object.entries(limpiar(leido))) if (v != null && v !== '' && (c[k] == null || c[k] === '' || (k === 'nombre' && c.nombre === 'Sin nombre') || (k === 'oficio' && c.oficio === 'otro'))) set[k] = v;
      if (Array.isArray(leido.empresas)) set.empresasAnteriores = leido.empresas.slice(0, 10).map(e => txt(e, 120));
      if (Object.keys(set).length) await db.collection(COL).updateOne({ _id: c._id }, { $set: { ...set, actualizado: new Date() } });
    }
  }
  return { ...(await ver(id)), leido };
}
async function archivoDoc(id, docId) {
  const db = await getDB();
  return db.collection(DOCS).findOne({ _id: oid(docId), candidatoId: String(id) });
}
async function borrarDoc(id, docId) {
  const db = await getDB();
  await db.collection(DOCS).deleteOne({ _id: oid(docId), candidatoId: String(id) });
  return ver(id);
}

// La IA lee el CV (PDF o foto) y devuelve los datos de la ficha.
async function leerCV(archivo) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY no configurada');
  const b64 = archivo.buffer.toString('base64');
  const doc = /pdf/i.test(archivo.mimetype) ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } } : { type: 'image', source: { type: 'base64', media_type: archivo.mimetype, data: b64 } };
  const tool = { name: 'ficha_candidato', description: 'Datos del candidato leídos de su currículum', input_schema: { type: 'object', properties: {
    nombre: { type: 'string' }, telefono: { type: 'string' }, email: { type: 'string' }, poblacion: { type: 'string' },
    oficio: { type: 'string', enum: Object.keys(OFICIOS), description: 'El oficio principal para una empresa de reformas y construcción' },
    anosExperiencia: { type: 'number', description: 'Años de experiencia en ese oficio (aprox.)' },
    carnet: { type: 'string', description: 'Carnés de conducir u otros (plataforma, carretilla…), si los pone' },
    empresas: { type: 'array', items: { type: 'string' }, description: 'Empresas anteriores con años, la más reciente primero' },
    resumen: { type: 'string', description: 'Dos o tres frases: qué ha hecho y en qué destaca, en castellano' },
  }, required: ['nombre', 'oficio', 'resumen'] } };
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 60000);
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: c.signal,
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: require('./config').ia.vision, max_tokens: 1500, tools: [tool], tool_choice: { type: 'tool', name: tool.name },
      messages: [{ role: 'user', content: [doc, { type: 'text', text: 'Es el currículum de alguien que quiere trabajar en una empresa de reformas, fachadas y obra nueva en Girona. Rellena la ficha con lo que ponga; no inventes lo que no ponga.' }] }] }),
  }).finally(() => clearTimeout(t));
  const data = await r.json();
  if (!r.ok) throw new Error(`IA ${r.status}`);
  const tu = (data.content || []).find(b => b.type === 'tool_use');
  return tu ? tu.input : null;
}

// ── Entrevista: respuestas [{id, nota 1-5, respuesta}] → puntuación sobre 100 ──
async function guardarEntrevista(id, { oficio, respuestas = [], conclusion }, por) {
  const P = preguntas(oficio);
  const valid = new Map(P.preguntas.map(p => [p.id, p]));
  const rs = (respuestas || []).filter(r => valid.has(r.id)).map(r => ({ id: r.id, pregunta: valid.get(r.id).q, nota: r.nota == null || r.nota === '' ? null : Math.max(1, Math.min(5, Number(r.nota) || 0)), respuesta: txt(r.respuesta, 1500) }));
  const puntuadas = rs.filter(r => r.nota);
  const puntuacion = puntuadas.length ? Math.round(puntuadas.reduce((a, r) => a + r.nota, 0) / puntuadas.length * 20) : null;
  const db = await getDB();
  const ent = { oficio: P.oficio, respuestas: rs, puntuacion, conclusion: txt(conclusion, 2000), fecha: new Date(), por: por || '' };
  const c = await db.collection(COL).findOne({ _id: oid(id) });
  if (!c) throw new Error('Candidato no encontrado');
  const set = { entrevista: ent, actualizado: new Date(), oficio: c.oficio === 'otro' ? P.oficio : c.oficio };
  if (c.estado === 'nuevo') set.estado = 'entrevista';
  await db.collection(COL).updateOne({ _id: c._id }, { $set: set, $push: { historial: { at: new Date(), por: por || '', que: `entrevista · ${puntuacion != null ? puntuacion + '/100' : 'sin nota'}` } } });
  return ver(id);
}

// ── Pasar a trabajador: usuario técnico con PIN + su DNI, carné y PRL a la carpeta de Personal ──
async function contratar(id, { pin, costeHora } = {}, por) {
  if (!(Number(costeHora) > 0)) throw new Error('Pon su coste por hora (lo que cuesta a la empresa): sirve para la rentabilidad de las obras');
  const db = await getDB();
  const c = await db.collection(COL).findOne({ _id: oid(id) });
  if (!c) throw new Error('Candidato no encontrado');
  if (c.userId) throw new Error('Ya es trabajador');
  const users = require('./users');
  let p = String(pin || '').replace(/\D/g, '');
  if (!p) for (let i = 0; i < 30 && !p; i++) { const x = String(1000 + Math.floor(Math.random() * 9000)); if (!(await db.collection('users').findOne({ pin: x, active: true }))) p = x; }
  const u = await users.createUser({ name: c.nombre, role: 'tecnico', pin: p, telefono: c.telefono || '', email: c.email || '', costeHora: costeHora || 0, nota: [OFICIOS[c.oficio] && OFICIOS[c.oficio].nombre, c.carnet ? 'carné ' + c.carnet : ''].filter(Boolean).join(' · ') });
  const userId = String(u.id || u._id || '');
  const MAPA = { dni: 'dni', carnet: 'carnet', prl: 'formacion_prl' };
  const docs = await db.collection(DOCS).find({ candidatoId: String(c._id), tipo: { $in: Object.keys(MAPA) } }).toArray();
  let pasados = 0;
  for (const d of docs) {
    try { const buf = d.data && d.data.buffer ? Buffer.from(d.data.buffer) : d.data; await require('./personalDocs').subir({ ambito: 'trabajador', userId, tipo: MAPA[d.tipo], archivo: { buffer: buf, mimetype: d.mime, originalname: d.nombre, size: d.size } }, por); pasados++; } catch (e) { console.warn('[RRHH] doc a Personal:', e.message); }
  }
  await db.collection(COL).updateOne({ _id: c._id }, { $set: { estado: 'contratado', userId, contratado: new Date(), actualizado: new Date() }, $push: { historial: { at: new Date(), por: por || '', que: 'pasado a trabajador' } } });
  return { ok: true, userId, pin: p, docsPasados: pasados };
}

module.exports = { lista, ver, crear, editar, borrar, subirDoc, archivoDoc, borrarDoc, preguntas, guardarEntrevista, contratar, leerCV, ESTADOS, OFICIOS, TIPOS_DOC, _limpiar: limpiar };
