// src/personalDocs.js — Documentación del personal y de la empresa (la que piden las obras: CAE / PRL).
//
// · Carpeta por trabajador: reconocimiento médico (aptitud), formación PRL, entrega de EPIs, alta en la SS,
//   DNI, carnés y permisos, contrato, nóminas… con fecha y caducidad.
// · Carpeta de empresa: RNT/RLC (TC) del mes, certificados de Hacienda y SS, seguro RC, REA, PRL…
// · Subida masiva: la IA clasifica cada archivo (tipo, de quién, fecha, caducidad, mes) y, si un PDF trae
//   varias personas (las nóminas del gestor), lo parte por páginas. Oficina confirma.
// · Paquete para una obra: eliges trabajadores → ZIP con lo vigente de cada uno + lo de empresa.
// · El trabajador ve su carpeta (y sus nóminas) en la app SOLO si se activa en Ajustes.
// Colección 'docsPersonal' (con el archivo dentro, ≤ 12 MB) y config en appSettings { key: 'personalDocs' }.

const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const fechaOk = s => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : null);
const mesOk = s => (/^\d{4}-\d{2}$/.test(String(s || '')) ? String(s) : null);
const txt = (s, n = 120) => String(s == null ? '' : s).trim().slice(0, n);
const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
function _oid(id) { try { return new ObjectId(String(id)); } catch (e) { throw new Error('Documento no válido'); } }
const addMeses = (f, m) => { const d = new Date(f + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString().slice(0, 10); };
const diasHasta = f => (f ? Math.round((new Date(f + 'T00:00:00Z') - new Date(hoy() + 'T00:00:00Z')) / 86400000) : null);

// obra: se incluye en el paquete para obras · caducaMeses: si no la pone el documento · mensual: va por mes
const TIPOS = {
  reconocimiento: { nombre: 'Reconocimiento médico (aptitud)', obra: true, caducaMeses: 12 },
  formacion_prl: { nombre: 'Formación PRL', obra: true },
  epis: { nombre: 'Entrega de EPIs', obra: true },
  alta_ss: { nombre: 'Alta en la Seguridad Social', obra: true },
  dni: { nombre: 'DNI / NIE', obra: true },
  carnet: { nombre: 'Carnés y permisos (conducir, plataforma, carretilla…)', obra: true },
  contrato: { nombre: 'Contrato de trabajo', obra: false },
  nomina: { nombre: 'Nómina', obra: false, mensual: true, privado: true },
  formacion_oficio: { nombre: 'Formación por oficio 20 h (convenio de la construcción)', obra: true },
  maquinaria_aut: { nombre: 'Autorización de uso de maquinaria', obra: false },
  maquinaria_form: { nombre: 'Formación en maquinaria (RD 1215/1997)', obra: false },
  tarjeta_ss: { nombre: 'Nº de la Seguridad Social (tarjeta o documento)', obra: false },
  extranjeria: { nombre: 'Papeles de extranjería (residencia, admisión a trámite…)', obra: false },
  otro: { nombre: 'Otro', obra: false },
};
const TIPOS_EMPRESA = {
  rnt_rlc: { nombre: 'RNT / RLC (TC) del mes', obra: true, mensual: true },
  cert_ss: { nombre: 'Certificado de estar al corriente con la Seguridad Social', obra: true, caducaMeses: 1 },
  cert_hacienda: { nombre: 'Certificado de estar al corriente con Hacienda', obra: true, caducaMeses: 12 },
  seguro_rc: { nombre: 'Seguro de responsabilidad civil (póliza y recibo)', obra: true, caducaMeses: 12 },
  rea: { nombre: 'Registro de Empresas Acreditadas (REA)', obra: true, caducaMeses: 36 },
  prl_empresa: { nombre: 'Evaluación de riesgos / Plan de PRL / modalidad preventiva', obra: true },
  ita: { nombre: 'ITA (Informe de Trabajadores en Alta) actualizado', obra: true, caducaMeses: 1 },
  cert_spa: { nombre: 'Certificado del Servicio de Prevención (al corriente de pago)', obra: true, caducaMeses: 12 },
  mutua: { nombre: 'Asociación con la Mutua y centro asistencial más cercano', obra: true, caducaMeses: 12 },
  seguro_acc: { nombre: 'Seguro de accidentes de convenio (póliza y recibo)', obra: true, caducaMeses: 12 },
  ta7: { nombre: 'Alta de la empresa en la Seguridad Social (TA.7)', obra: false },
  iae: { nombre: 'Alta en el IAE', obra: false },
  escrituras: { nombre: 'Escrituras / CIF', obra: false },
  otro_empresa: { nombre: 'Otro', obra: false },
};
// Papeles de UNA obra (los formularios del contratista, firmados): van con su obraId.
const TIPOS_OBRA = {
  contrato_obra: { nombre: 'Contrato con el contratista (firmado)' },
  adhesion_pss: { nombre: 'Adhesión al Plan de Seguridad y Salud (sellado y firmado)' },
  trab_designado: { nombre: 'Nombramiento de Trabajador Designado (sellado y firmado)' },
  aut_libro: { nombre: 'Autorización de firma del Libro de Subcontratación' },
  recibi_doc: { nombre: 'Recibí de la relación de documentación (firmado)' },
  cert_hacienda_contratista: { nombre: 'Certificado de Hacienda específico para el contratista (art. 43.1.f)', caducaMeses: 12 },
  otro_obra: { nombre: 'Otro de la obra' },
};
const tipoDe = (ambito, t) => (ambito === 'empresa' ? TIPOS_EMPRESA : ambito === 'obra' ? TIPOS_OBRA : TIPOS)[t];

// ── AJUSTES (qué ve el trabajador) ──
const CFG_DEF = { visibleTrabajadores: false, nominasVisibles: false };
async function getConfig() { const db = await getDB(); const d = await db.collection('appSettings').findOne({ key: 'personalDocs' }); return { ...CFG_DEF, ...((d && d.valor) || {}) }; }
async function setConfig(c = {}, por) {
  const db = await getDB(); const v = { visibleTrabajadores: !!c.visibleTrabajadores, nominasVisibles: !!c.nominasVisibles };
  await db.collection('appSettings').updateOne({ key: 'personalDocs' }, { $set: { valor: v, actualizado: new Date(), por: por || '' } }, { upsert: true });
  return v;
}

async function _plantilla() {
  const { getUsers, normalizeRole } = require('./users');
  return ((await getUsers(false)) || []).filter(u => u.role !== 'client' && ['tecnico', 'encargado', 'oficina'].includes(normalizeRole(u.role)) && u.active !== false)
    .map(u => ({ id: String(u._id), name: u.name, dni: (u.docs && u.docs.dni) || '', alias: require('./nominasPagos').nombresDe(u).map(ws => ws.join(' ')) }));
}
function _caduca(ambito, tipo, fecha, caduca) {
  if (fechaOk(caduca)) return caduca;
  const t = tipoDe(ambito, tipo);
  return t && t.caducaMeses && fechaOk(fecha) ? addMeses(fecha, t.caducaMeses) : null;
}
const _publico = d => ({ id: String(d._id), ambito: d.ambito, userId: d.userId || null, tipo: d.tipo, tipoNombre: (tipoDe(d.ambito, d.tipo) || {}).nombre || d.tipo, nombre: d.nombre, fecha: d.fecha, caduca: d.caduca, dias: diasHasta(d.caduca), mes: d.mes, mime: d.mime, size: d.size, estado: d.estado, notas: d.notas || '', ia: d.ia || null, subido: d.subido, por: d.por, visibleTrabajador: d.visibleTrabajador !== false, importes: d.importes || null });

async function subir({ ambito = 'trabajador', userId, obraId, tipo, archivo, fecha, caduca, mes, notas, visibleTrabajador = true }, por) {
  if (!archivo || !archivo.buffer) throw new Error('Falta el archivo');
  if (!/^(image\/|application\/pdf)/.test(archivo.mimetype || '')) throw new Error('Sube un PDF o una foto');
  ambito = ['empresa', 'obra'].includes(ambito) ? ambito : 'trabajador';
  if (ambito === 'obra' && !/^[a-f0-9]{24}$/.test(String(obraId || ''))) throw new Error('¿De qué obra es?');
  if (!tipoDe(ambito, tipo)) throw new Error('Tipo de documento no válido');
  if (ambito === 'trabajador' && !userId) throw new Error('¿De qué trabajador es?');
  const db = await getDB();
  // multer da el nombre del archivo en latin1: «AdhesiÃ³n» → «Adhesión».
  if (archivo.originalname && /[ÃÂ]/.test(archivo.originalname)) { try { const u = Buffer.from(archivo.originalname, 'latin1').toString('utf8'); if (!u.includes('\ufffd')) archivo.originalname = u; } catch (e) {} }
  const doc = { ambito, userId: ambito === 'trabajador' ? String(userId) : null, obraId: ambito === 'obra' ? String(obraId) : null, tipo, nombre: txt(archivo.originalname || (tipoDe(ambito, tipo) || {}).nombre, 120), fecha: fechaOk(fecha), mes: mesOk(mes), notas: txt(notas, 300),
    mime: archivo.mimetype, size: archivo.size || archivo.buffer.length, data: archivo.buffer, estado: 'ok', visibleTrabajador: visibleTrabajador !== false && visibleTrabajador !== 'false', subido: new Date(), por: por || '' };
  doc.caduca = _caduca(ambito, tipo, doc.fecha, caduca);
  const r = await db.collection('docsPersonal').insertOne(doc);
  return _publico({ ...doc, _id: r.insertedId });
}

// ── SUBIDA MASIVA CON IA ──
const HERRAMIENTA = {
  name: 'clasificar_documentos',
  description: 'Clasifica el archivo. Si un PDF contiene documentos de VARIAS personas o de varios tipos (p. ej. todas las nóminas del mes), devuelve un elemento por cada uno con sus páginas.',
  input_schema: { type: 'object', properties: { documentos: { type: 'array', items: { type: 'object', properties: {
    paginas: { type: 'array', items: { type: 'integer' }, description: 'Páginas (1 = primera) de este documento dentro del archivo. Vacío = todo el archivo.' },
    ambito: { type: 'string', enum: ['trabajador', 'empresa'] },
    tipo: { type: 'string', enum: [...Object.keys(TIPOS), ...Object.keys(TIPOS_EMPRESA)] },
    trabajador: { type: 'string', description: 'Nombre del trabajador tal como aparece (si es de un trabajador)' },
    dni: { type: 'string' },
    fecha: { type: 'string', description: 'Fecha del documento (AAAA-MM-DD): del reconocimiento, del curso, de la entrega…' },
    caduca: { type: 'string', description: 'Fecha de caducidad o validez hasta (AAAA-MM-DD) si aparece' },
    mes: { type: 'string', description: 'Para nóminas y RNT/RLC: el mes al que corresponde (AAAA-MM)' },
    liquido: { type: 'number', description: 'Solo nóminas: LÍQUIDO A PERCIBIR (neto que cobra el trabajador), en euros' },
    bruto: { type: 'number', description: 'Solo nóminas: total devengado (bruto), en euros' },
    irpf: { type: 'number', description: 'Solo nóminas: retención de IRPF del trabajador, en euros' },
    ssTrabajador: { type: 'number', description: 'Solo nóminas: aportación del trabajador a la Seguridad Social, en euros' },
    resumen: { type: 'string', description: 'Una frase: qué es (p. ej. «Apto sin restricciones, Quirón Prevención»). Sin datos médicos.' },
  }, required: ['ambito', 'tipo'] } } }, required: ['documentos'] },
};
function _matchTrabajador(plantilla, nombre, dni) {
  const n = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const d = String(dni || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (d.length >= 8) { const w = plantilla.find(p => String(p.dni).toUpperCase().replace(/[^0-9A-Z]/g, '') === d); if (w) return w; }
  const nn = n(nombre); if (!nn) return null;
  const pal = nn.split(' ').filter(x => x.length >= 3);
  let mejor = null, punt = 0;
  // Por su nombre o por un alias («David Taladros» en el programa es «David Valencia» en la nómina y el banco).
  for (const p of plantilla) for (const nom of [p.name, ...(p.alias || [])]) { const pp = n(nom).split(' ').filter(x => x.length >= 3); const c = pp.filter(x => pal.includes(x)).length; if (c > punt && (c >= 2 || (pp.length === 1 && c === 1))) { mejor = p; punt = c; } }
  return mejor;
}
async function _clasificarIA(archivo, plantilla) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) return { ok: false, error: 'ANTHROPIC_API_KEY no configurada' };
  const b64 = archivo.buffer.toString('base64');
  const contenido = /pdf/i.test(archivo.mimetype) ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } } : { type: 'image', source: { type: 'base64', media_type: archivo.mimetype, data: b64 } };
  const tipos = [...Object.entries(TIPOS).map(([k, t]) => `${k} (trabajador): ${t.nombre}`), ...Object.entries(TIPOS_EMPRESA).map(([k, t]) => `${k} (empresa): ${t.nombre}`)].join('\n');
  const prompt = `Eres el administrativo de una empresa de reformas (Corp Projects Holding SL). Clasifica este documento de personal o de empresa.\nTipos posibles:\n${tipos}\n\nTrabajadores de la empresa: ${plantilla.map(p => p.name + (p.dni ? ' (' + p.dni + ')' : '')).join(', ')}.\nSi el PDF trae documentos de varias personas (p. ej. las nóminas de todos), devuelve uno por persona con sus páginas. Del reconocimiento médico solo interesa la aptitud y la fecha, nunca datos de salud. Llama a la herramienta «clasificar_documentos».`;
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 90000);
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: c.signal, headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: require('./config').ia.vision, max_tokens: 4000, tools: [HERRAMIENTA], tool_choice: { type: 'tool', name: HERRAMIENTA.name }, messages: [{ role: 'user', content: [contenido, { type: 'text', text: prompt }] }] }) }).finally(() => clearTimeout(t));
    const d = await r.json(); if (!r.ok) throw new Error(`API ${r.status}`);
    const tu = (d.content || []).find(b => b.type === 'tool_use');
    return { ok: true, documentos: (tu && tu.input && tu.input.documentos) || [] };
  } catch (e) { return { ok: false, error: e.message }; }
}
async function _extraerPaginas(buf, paginas) {
  const { PDFDocument } = require('pdf-lib');
  const src = await PDFDocument.load(buf, { ignoreEncryption: true });
  const n = src.getPageCount();
  const idx = [...new Set(paginas.map(p => Number(p) - 1).filter(i => i >= 0 && i < n))].sort((a, b) => a - b);
  if (!idx.length || idx.length === n) return buf;
  const out = await PDFDocument.create();
  (await out.copyPages(src, idx)).forEach(p => out.addPage(p));
  return Buffer.from(await out.save());
}
// Cada archivo → uno o varios documentos «propuesta» que oficina confirma (o corrige) en la pantalla.
async function analizar(archivos, por) {
  const plantilla = await _plantilla();
  const db = await getDB();
  const out = [];
  for (const a of archivos.slice(0, 20)) {
    const ia = await _clasificarIA(a, plantilla);
    const lista = ia.ok && ia.documentos.length ? ia.documentos : [{ ambito: 'trabajador', tipo: 'otro' }];
    for (const d of lista.slice(0, 40)) {
      const ambito = d.ambito === 'empresa' ? 'empresa' : 'trabajador';
      const tipo = tipoDe(ambito, d.tipo) ? d.tipo : (ambito === 'empresa' ? 'otro_empresa' : 'otro');
      let buf = a.buffer;
      if (/pdf/i.test(a.mimetype) && Array.isArray(d.paginas) && d.paginas.length && lista.length > 1) { try { buf = await _extraerPaginas(a.buffer, d.paginas); } catch (e) { /* se guarda entero */ } }
      const w = ambito === 'trabajador' ? _matchTrabajador(plantilla, d.trabajador, d.dni) : null;
      const doc = { ambito, userId: w ? w.id : null, tipo, nombre: txt(a.originalname, 100) + (lista.length > 1 && d.paginas && d.paginas.length ? ` (pág. ${d.paginas.join(',')})` : ''),
        fecha: fechaOk(d.fecha), mes: mesOk(d.mes) || ((tipoDe(ambito, tipo) || {}).mensual && fechaOk(d.fecha) ? String(d.fecha).slice(0, 7) : null),
        notas: txt(d.resumen, 300), mime: a.mimetype, size: buf.length, data: buf, estado: 'propuesta', visibleTrabajador: true,
        importes: tipo === 'nomina' && Number(d.liquido) > 0 ? _importes(d) : null,
        ia: { ok: ia.ok, error: ia.error || null, trabajadorLeido: txt(d.trabajador, 80) || null, dni: txt(d.dni, 20) || null }, subido: new Date(), por: por || '' };
      doc.caduca = _caduca(ambito, tipo, doc.fecha, d.caduca);
      const r = await db.collection('docsPersonal').insertOne(doc);
      out.push(_publico({ ...doc, _id: r.insertedId }));
    }
  }
  return out;
}
const _n2 = v => Number(v) > 0 ? Math.round(Number(v) * 100) / 100 : null;
const _importes = x => ({ liquido: _n2(x.liquido), bruto: _n2(x.bruto), irpf: Number(x.irpf) >= 0 && x.irpf != null ? Math.round(Number(x.irpf) * 100) / 100 : null, ssTrabajador: _n2(x.ssTrabajador) });
// Nóminas ya subidas sin importe: la IA lee el líquido a percibir (para cruzarlo con lo pagado en el banco).
const HERR_NOMINA = { name: 'importes_nomina', description: 'Importes de la nómina', input_schema: { type: 'object', properties: {
  liquido: { type: 'number', description: 'LÍQUIDO A PERCIBIR (neto), en euros' }, bruto: { type: 'number', description: 'Total devengado (bruto), en euros' },
  irpf: { type: 'number', description: 'Retención de IRPF, en euros' }, ssTrabajador: { type: 'number', description: 'Aportación del trabajador a la Seguridad Social, en euros' },
  mes: { type: 'string', description: 'Mes de la nómina (AAAA-MM)' } }, required: ['liquido'] } };
async function leerImportesNomina(id) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) throw new Error('ANTHROPIC_API_KEY no configurada');
  const db = await getDB();
  const d = await db.collection('docsPersonal').findOne({ _id: _oid(id) });
  if (!d || d.tipo !== 'nomina') throw new Error('No es una nómina');
  const buf = Buffer.from(d.data.buffer || d.data), b64 = buf.toString('base64');
  const contenido = /pdf/i.test(d.mime) ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } } : { type: 'image', source: { type: 'base64', media_type: d.mime, data: b64 } };
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: require('./config').ia.vision, max_tokens: 500, tools: [HERR_NOMINA], tool_choice: { type: 'tool', name: HERR_NOMINA.name }, messages: [{ role: 'user', content: [contenido, { type: 'text', text: 'Saca el líquido a percibir, el total devengado, la retención de IRPF, la aportación del trabajador a la Seguridad Social y el mes de esta nómina.' }] }] }) });
  const j = await r.json(); if (!r.ok) throw new Error(`API ${r.status}`);
  const tu = (j.content || []).find(b => b.type === 'tool_use'); const x = (tu && tu.input) || {};
  if (!(Number(x.liquido) > 0)) throw new Error('No se ve el líquido a percibir');
  const importes = _importes(x);
  const set = { importes }; if (!d.mes && mesOk(x.mes)) set.mes = mesOk(x.mes);
  await db.collection('docsPersonal').updateOne({ _id: d._id }, { $set: set });
  return { id: String(d._id), ...importes, mes: set.mes || d.mes };
}
// Todas las nóminas sin importe (de una en una; la IA tarda unos segundos por nómina).
async function leerImportesPendientes({ max = 40 } = {}) {
  const db = await getDB();
  const l = await db.collection('docsPersonal').find({ tipo: 'nomina', 'importes.liquido': { $exists: false } }).project({ _id: 1 }).limit(max).toArray();
  const out = [];
  for (const x of l) { try { out.push(await leerImportesNomina(String(x._id))); } catch (e) { out.push({ id: String(x._id), error: e.message }); } }
  return out;
}
async function editar(id, cambios = {}, por) {
  const db = await getDB();
  const d = await db.collection('docsPersonal').findOne({ _id: _oid(id) }, { projection: { data: 0 } });
  if (!d) throw new Error('Documento no encontrado');
  const ambito = cambios.ambito ? (['empresa', 'obra'].includes(cambios.ambito) ? cambios.ambito : 'trabajador') : d.ambito;
  const tipo = cambios.tipo || d.tipo;
  if (!tipoDe(ambito, tipo)) throw new Error('Tipo no válido');
  const set = { ambito, tipo, actualizado: new Date(), actualizadoPor: por || '' };
  if ('userId' in cambios) set.userId = ambito === 'trabajador' && cambios.userId ? String(cambios.userId) : null;
  if ('fecha' in cambios) set.fecha = fechaOk(cambios.fecha);
  if ('mes' in cambios) set.mes = mesOk(cambios.mes);
  if ('notas' in cambios) set.notas = txt(cambios.notas, 300);
  if (cambios.nombre && String(cambios.nombre).trim()) set.nombre = txt(cambios.nombre, 120);
  if ('visibleTrabajador' in cambios) set.visibleTrabajador = !!cambios.visibleTrabajador;
  set.caduca = _caduca(ambito, tipo, 'fecha' in set ? set.fecha : d.fecha, 'caduca' in cambios ? cambios.caduca : (tipo === d.tipo ? d.caduca : null));
  if (cambios.confirmar) {
    if (ambito === 'trabajador' && !('userId' in set ? set.userId : d.userId)) throw new Error('Elige el trabajador');
    set.estado = 'ok';
  }
  await db.collection('docsPersonal').updateOne({ _id: d._id }, { $set: set });
  return _publico({ ...d, ...set });
}
async function borrar(id) { const db = await getDB(); await db.collection('docsPersonal').deleteOne({ _id: _oid(id) }); return { ok: true }; }
async function archivo(id) { const db = await getDB(); return db.collection('docsPersonal').findOne({ _id: _oid(id) }); }

// ── VISTAS ──
// Para cada trabajador, el documento vigente de cada tipo que piden las obras y su semáforo.
async function resumen() {
  const db = await getDB();
  const [plantilla, docs, cfg] = await Promise.all([_plantilla(), db.collection('docsPersonal').find({}, { projection: { data: 0 } }).sort({ fecha: -1, subido: -1 }).toArray(), getConfig()]);
  const ultimo = (lista, tipo) => lista.filter(d => d.tipo === tipo && d.estado === 'ok').sort((a, b) => String(b.caduca || b.fecha || '').localeCompare(String(a.caduca || a.fecha || '')))[0] || null;
  const estado = d => !d ? 'falta' : (d.caduca ? (diasHasta(d.caduca) < 0 ? 'caducado' : diasHasta(d.caduca) <= 30 ? 'pronto' : 'ok') : 'ok');
  const trabajadores = plantilla.map(p => {
    const mios = docs.filter(d => d.ambito === 'trabajador' && d.userId === p.id);
    const req = {}; Object.entries(TIPOS).filter(([, t]) => t.obra).forEach(([k]) => { const d = ultimo(mios, k); req[k] = { estado: estado(d), caduca: d ? d.caduca : null, id: d ? String(d._id) : null }; });
    return { ...p, requisitos: req, total: mios.filter(d => d.estado === 'ok').length, nominas: mios.filter(d => d.tipo === 'nomina' && d.estado === 'ok').length };
  });
  const empresa = {}; Object.entries(TIPOS_EMPRESA).filter(([, t]) => t.obra).forEach(([k]) => { const d = ultimo(docs.filter(x => x.ambito === 'empresa'), k); empresa[k] = { estado: estado(d), caduca: d ? d.caduca : null, mes: d ? d.mes : null, id: d ? String(d._id) : null }; });
  return { tipos: TIPOS, tiposEmpresa: TIPOS_EMPRESA, config: cfg, trabajadores, empresa, propuestas: docs.filter(d => d.estado === 'propuesta').map(_publico) };
}
async function carpeta({ userId, ambito }) {
  const db = await getDB();
  const q = ambito === 'empresa' ? { ambito: 'empresa', estado: 'ok' } : { ambito: 'trabajador', userId: String(userId), estado: 'ok' };
  return (await db.collection('docsPersonal').find(q, { projection: { data: 0 } }).sort({ fecha: -1, subido: -1 }).toArray()).map(_publico);
}

// ── PAQUETE PARA UNA OBRA ──
async function paqueteObra({ userIds = [], obraId = null, conEmpresa = true } = {}, por) {
  const db = await getDB();
  const { crearZip } = require('./zip');
  const plantilla = await _plantilla();
  const limpio = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 ._-]/g, '').trim().replace(/\s+/g, '_');
  const ext = m => (/pdf/i.test(m) ? 'pdf' : /png/i.test(m) ? 'png' : 'jpg');
  const archivos = [], indice = ['Documentación para obra — Corp Projects Holding SL', `Fecha: ${hoy().split('-').reverse().join('/')}`, ''];
  const vigente = (lista, tipo) => lista.filter(d => d.tipo === tipo).sort((a, b) => String(b.mes || b.caduca || b.fecha || '').localeCompare(String(a.mes || a.caduca || a.fecha || '')))[0];
  if (conEmpresa) {
    const docs = await db.collection('docsPersonal').find({ ambito: 'empresa', estado: 'ok' }).toArray();
    indice.push('EMPRESA');
    for (const [k, t] of Object.entries(TIPOS_EMPRESA).filter(([, t]) => t.obra)) {
      const d = vigente(docs, k);
      if (!d) { indice.push(`  ✗ FALTA: ${t.nombre}`); continue; }
      const cad = d.caduca && diasHasta(d.caduca) < 0;
      archivos.push({ nombre: `Empresa/${limpio(t.nombre)}${d.mes ? '_' + d.mes : ''}.${ext(d.mime)}`, datos: Buffer.from(d.data.buffer || d.data) });
      indice.push(`  ${cad ? '⚠ CADUCADO' : '✓'} ${t.nombre}${d.mes ? ' (' + d.mes + ')' : ''}${d.caduca ? ' · válido hasta ' + d.caduca.split('-').reverse().join('/') : ''}`);
    }
    indice.push('');
  }
  for (const id of userIds.map(String)) {
    const w = plantilla.find(p => p.id === id); if (!w) continue;
    const docs = await db.collection('docsPersonal').find({ ambito: 'trabajador', userId: id, estado: 'ok' }).toArray();
    indice.push(w.name.toUpperCase());
    for (const [k, t] of Object.entries(TIPOS).filter(([, t]) => t.obra)) {
      const d = vigente(docs, k);
      if (!d) { indice.push(`  ✗ FALTA: ${t.nombre}`); continue; }
      const cad = d.caduca && diasHasta(d.caduca) < 0;
      archivos.push({ nombre: `${limpio(w.name)}/${limpio(t.nombre)}.${ext(d.mime)}`, datos: Buffer.from(d.data.buffer || d.data) });
      indice.push(`  ${cad ? '⚠ CADUCADO' : '✓'} ${t.nombre}${d.caduca ? ' · válido hasta ' + d.caduca.split('-').reverse().join('/') : ''}`);
    }
    indice.push('');
  }
  archivos.unshift({ nombre: 'INDICE.txt', datos: Buffer.from(indice.join('\r\n'), 'utf8') });
  let obraRef = null;
  if (obraId && /^[a-f0-9]{24}$/.test(String(obraId))) {
    const o = await db.collection('obras').findOne({ _id: new ObjectId(String(obraId)) }, { projection: { reference: 1 } });
    if (o) { obraRef = o.reference; await db.collection('obras').updateOne({ _id: o._id }, { $set: { personalAcreditado: { userIds: userIds.map(String), fecha: new Date(), por: por || '' } } }); }
  }
  return { zip: crearZip(archivos), nombre: `Documentacion_${limpio(obraRef || 'obra')}_${hoy()}.zip`, faltan: indice.filter(l => /FALTA|CADUCADO/.test(l)).length };
}

// ── AVISOS DE CADUCIDAD (oficina) ──
async function revisarCaducidades({ dryRun = false } = {}) {
  const db = await getDB();
  const [plantilla, docs] = await Promise.all([_plantilla(), db.collection('docsPersonal').find({ estado: 'ok', caduca: { $ne: null } }, { projection: { data: 0 } }).toArray()]);
  // Solo el último de cada (persona, tipo): si ya hay uno nuevo, el viejo no avisa.
  const ult = {}; docs.forEach(d => { const k = `${d.ambito}|${d.userId || ''}|${d.tipo}`; if (!ult[k] || String(d.caduca) > String(ult[k].caduca)) ult[k] = d; });
  const avisos = [];
  for (const d of Object.values(ult)) {
    const dd = diasHasta(d.caduca); if (dd == null || dd > 30) continue;
    const umbral = dd < 0 ? 'vencido-' + Math.floor(-dd / 7) : 'd' + [30, 7, 0].filter(u => u >= dd).pop();
    const clave = `${d.caduca}:${umbral}`;
    if ((d.avisos || {})[clave]) continue;
    const quien = d.ambito === 'empresa' ? 'Empresa' : ((plantilla.find(p => p.id === d.userId) || {}).name || '¿?');
    avisos.push({ id: d._id, clave, texto: `• ${quien}: ${(tipoDe(d.ambito, d.tipo) || {}).nombre || d.tipo} — ${dd < 0 ? `caducó hace ${-dd} días` : dd === 0 ? 'caduca HOY' : `caduca en ${dd} días`} (${d.caduca.split('-').reverse().join('/')})` });
  }
  if (!avisos.length || dryRun) return { avisos: avisos.map(a => a.texto), dryRun };
  const to = String(process.env.FICHAJE_AVISOS_TO || process.env.WHATSAPP_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  const texto = `📁 *Documentación del personal que caduca*\n\n${avisos.map(a => a.texto).join('\n')}\n\nRenovar en: https://dashboard.corpprojects.es/personal`;
  for (const t of to) { try { await require('./notifications').sendWhatsAppTo(t, texto); } catch (e) { console.warn('[Personal] aviso:', e.message); } }
  for (const a of avisos) await db.collection('docsPersonal').updateOne({ _id: a.id }, { $set: { ['avisos.' + a.clave]: new Date() } });
  return { avisos: avisos.map(a => a.texto) };
}

// ── EL TRABAJADOR (app) ──
async function misDocs(userId) {
  const cfg = await getConfig();
  if (!cfg.visibleTrabajadores) return { activo: false };
  const lista = (await carpeta({ userId })).filter(d => d.visibleTrabajador && (cfg.nominasVisibles || d.tipo !== 'nomina'));
  return { activo: true, nominas: cfg.nominasVisibles, docs: lista };
}
async function miArchivo(userId, id) {
  const cfg = await getConfig(); if (!cfg.visibleTrabajadores) return null;
  const d = await archivo(id);
  if (!d || d.ambito !== 'trabajador' || d.userId !== String(userId) || d.estado !== 'ok' || d.visibleTrabajador === false) return null;
  if (d.tipo === 'nomina' && !cfg.nominasVisibles) return null;
  return d;
}

module.exports = { leerImportesNomina, leerImportesPendientes, TIPOS, TIPOS_EMPRESA, TIPOS_OBRA, diasHasta, getConfig, setConfig, subir, analizar, editar, borrar, archivo, resumen, carpeta, paqueteObra, revisarCaducidades, misDocs, miArchivo, _matchTrabajador };
