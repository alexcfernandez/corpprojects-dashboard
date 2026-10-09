// compras.js — COMPRAS POR FOTO (Paso 4 de "la obra es una carpeta").
//
// El trabajador fotografía lo que compra (albarán, factura, ticket, devolución), elige
// la obra y lo envía. La IA lee el documento al momento; oficina lo revisa en una cola y
// lo confirma. Un documento = un registro en `compras`; sus fotos en `comprasFotos`.
//
//   compra = {
//     empresaId, estado: por_revisar | revisada | descartada | archivo (recuperada del correo, solo para cuadrar),
//     tipo: albaran | factura | ticket | devolucion | otro,
//     proveedor, proveedorNorm, nif, numero, fecha (YYYY-MM-DD), base, iva, total,
//     lineas: [{descripcion, cantidad, unidad, precio, importe}], albaranesRef: ['4471', …],
//     obraId, obraRef, varias (bool), reparto: [{obraId, obraRef, importe}], categoria (gasto general),
//     nota, subidaPor: {kind: worker|admin, userId, name}, nFotos,
//     ia: {ok, calidad: legible|borroso|cortado|no_es_documento, confianza, aviso, modelo, error},
//     duplicadoDe (id), revisadaPor, revisadaAt, enviadaStel: {ok, at}, createdAt, updatedAt }
//
// Reglas decididas con Álex: los albaranes NO van a StelOrder; las facturas/tickets se
// mandan a StelOrder (vía n8n) solo cuando oficina CONFIRMA; las fotos viven en Mongo
// (comprimidas en el móvil); el trabajador nunca ve importes.

const { ObjectId } = require('mongodb');
const CONFIG = require('./config');
const EMPRESA = process.env.EMPRESA_ID || 'corp';
const COL = 'compras', FOTOS = 'comprasFotos';
const TIPOS = ['albaran', 'factura', 'ticket', 'devolucion', 'otro'];
const TIPO_TXT = { albaran: 'Albarán', factura: 'Factura', ticket: 'Ticket', devolucion: 'Devolución', otro: 'Documento' };
// Para qué es la compra: una obra · varias obras (oficina reparte) · herramientas para un
// trabajador (al confirmar se dan de alta en Llaves y herramientas y se le entregan) ·
// ropa de trabajo para un trabajador · otro gasto general (con categoría).
// · «lineas»: factura mezclada (Palahí: material de obras, herramientas, EPIs…): cada línea dice a dónde va
//   (l.para = {t: obra|herramientas|ropa|almacen|general, obraId, workerId, workerName}); lo de obras se
//   guarda como `reparto` (así cuenta en cada obra igual que «varias») y lo demás en `repartoOtros`.
const DESTINOS = ['obra', 'varias', 'lineas', 'herramientas', 'ropa', 'almacen', 'general', 'vehiculo', 'cliente'];
const DESTINO_TXT = { obra: 'Obra', varias: 'Varias obras', lineas: 'Por líneas (mezcla)', herramientas: 'Herramientas', ropa: 'Ropa de trabajo', almacen: 'Stock de almacén', general: 'Gasto general', vehiculo: 'Vehículo', cliente: 'Cliente (sin obra)' };
const PARA_T = ['obra', 'herramientas', 'ropa', 'almacen', 'general'];
function limpiarPara(p) {
  if (!p || !PARA_T.includes(p.t)) return null;
  const o = { t: p.t };
  if (p.t === 'obra') { if (!/^[a-f0-9]{24}$/.test(String(p.obraId || ''))) return null; o.obraId = String(p.obraId); }
  if ((p.t === 'herramientas' || p.t === 'ropa') && p.workerId) { o.workerId = String(p.workerId).slice(0, 40); o.workerName = String(p.workerName || '').trim().slice(0, 80); }
  return o;
}
function limpiarWorker(w) { if (!w || !w.id) return null; return { id: String(w.id), name: String(w.name || '').trim().slice(0, 80) }; }

async function getDB() { return require('./db').getDB(); }
const oid = id => { try { return new ObjectId(String(id)); } catch (e) { throw new Error('Compra no encontrada'); } };
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\b(s\.?l\.?u?|s\.?a\.?u?|s\.?c\.?p\.?|sl|sa)\b\.?/g, '').replace(/[^a-z0-9ñç]+/g, ' ').trim();
// Importe escrito a mano o devuelto por el formulario: «1.234,56», «1234,56», «399.78» (número JS), «1.234».
// Antes se quitaban TODOS los puntos y «399.78» se guardaba como 39978.
// Cantidades (1.250 m³, 0,5 h): el punto y la coma son siempre decimales.
const nCant = v => { const n = Number(String(v ?? '').trim().replace(',', '.')); return String(v ?? '').trim() && Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null; };
function n2(v) {
  let t = String(v ?? '').trim().replace(/\s|€/g, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');          // coma decimal: los puntos son miles
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');      // «1.234» / «12.500»: miles
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
const num = v => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };

// ── LECTURA CON IA ───────────────────────────────────────────────
const PROMPT = `Eres el administrativo de una empresa de reformas en Girona. Te paso la(s) foto(s) de UN documento de compra de material (albarán de entrega, factura, ticket de caja o abono/devolución). Devuelve SOLO un JSON con esta forma exacta, sin texto alrededor:
{
 "calidad": "legible" | "borroso" | "cortado" | "no_es_documento",
 "tipo": "albaran" | "factura" | "ticket" | "devolucion" | "otro",
 "proveedor": "nombre comercial del proveedor (Saltoki, Leroy Merlin, Obramat…)", "razonSocial": "razón social completa tal cual aparece (p. ej. Obramat S.L.U.) o null", "nif": "CIF/NIF del proveedor o null",
 "numero": "número del documento tal cual aparece, o null", "fecha": "YYYY-MM-DD o null",
 "base": número o null, "iva": número o null, "total": número o null,
 "lineas": [{"descripcion": "texto de la línea", "cantidad": número o null, "unidad": "ud|m|m2|kg|saco|caja|…", "precio": número o null, "importe": número o null, "talla": "talla si es ropa (M, L, 42…) o null", "albaran": "en facturas que agrupan albaranes: nº del albarán al que pertenece la línea, o null", "obraTexto": "en facturas que agrupan albaranes: obra o dirección que pone en ese albarán (p. ej. «OBRA CARLES RAHOLA 13 ATIC»), o null"}],
 "albaranesRef": ["números de albarán que cite una FACTURA (si es una factura que agrupa albaranes), si no []"],
 "obraPista": "texto del documento que parezca referirse a una obra o dirección de entrega, o null",
 "confianza": 0-1,
 "aviso": "una frase corta en español si hay algo que oficina deba mirar (importe ilegible, falta una página, es un presupuesto y no una compra…), o null"
}
Si el documento tiene más de 60 líneas, incluye las 60 primeras y resume el resto en una línea "… y N líneas más". En facturas que agrupan varios albaranes (cada albarán empieza con su cabecera, p. ej. «SC/286689 17/09/2026 PEDIDO:», y la obra o dirección va en una línea sin importe al principio o AL FINAL del bloque, p. ej. «OBRA CARLES RAHOLA, 13 ATIC (ALEX RINCON)»), pon en CADA línea su "albaran" y el "obraTexto" de su bloque (la cabecera y la línea de la obra no son líneas). En facturas de gasolinera que listan repostajes, una línea por tiquet con la descripción "PRODUCTO - Tiquet NÚMERO (DD-MM-AAAA)" (el nº de tiquet tal cual), litros como cantidad con unidad "L" e importe de la línea. Reglas: "albaran" = entrega de material SIN importes totales o con la palabra albarán/entrega; "factura" = lleva la palabra factura y desglose de IVA; "ticket" = ticket de caja/TPV; "devolucion" = abono, devolución o importes negativos (pon los importes en NEGATIVO). Números con formato español (1.234,56) → 1234.56. Si no es un documento de compra, calidad="no_es_documento". No inventes: lo que no se lea, null.`;

// Esquema de la salida estructurada (mismo contenido que pide PROMPT).
const _n = { type: ['number', 'null'] }, _s = { type: ['string', 'null'] };
const HERRAMIENTA = {
  name: 'registrar_documento',
  description: 'Registra los datos leídos del documento de compra.',
  input_schema: {
    type: 'object',
    properties: {
      calidad: { type: 'string', enum: ['legible', 'borroso', 'cortado', 'no_es_documento'] },
      tipo: { type: 'string', enum: ['albaran', 'factura', 'ticket', 'devolucion', 'otro'] },
      proveedor: _s, razonSocial: _s, nif: _s, numero: _s,
      fecha: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
      base: _n, iva: _n, total: _n,
      lineas: { type: 'array', items: { type: 'object', properties: { descripcion: { type: 'string' }, cantidad: _n, unidad: _s, precio: _n, importe: _n, talla: _s, albaran: _s, obraTexto: _s }, required: ['descripcion'] } },
      albaranesRef: { type: 'array', items: { type: 'string' } },
      obraPista: _s,
      confianza: _n,
      aviso: _s,
    },
    required: ['calidad', 'tipo', 'lineas'],
  },
};

// Si la respuesta se cortó (documento con muchas líneas), se recorta hasta el último objeto
// completo y se cierran los corchetes/llaves que falten: se conserva todo lo leído hasta ahí.
function repararJson(s) {
  let t = s.slice(0, s.lastIndexOf('}') + 1);
  for (let intento = 0; intento < 3 && t; intento++) {
    let pila = [], enStr = false, esc = false;
    for (const ch of t) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { if (enStr) esc = true; continue; }
      if (ch === '"') { enStr = !enStr; continue; }
      if (enStr) continue;
      if (ch === '{' || ch === '[') pila.push(ch === '{' ? '}' : ']');
      else if (ch === '}' || ch === ']') pila.pop();
    }
    const cerrado = t.replace(/,\s*$/, '') + pila.reverse().join('');
    try { return JSON.parse(cerrado); } catch (e) { t = t.slice(0, t.lastIndexOf('}', t.length - 2) + 1); }
  }
  return null;
}
function parseJsonLoose(raw) {
  const s = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const i = s.indexOf('{');
  if (i < 0) throw new Error('La IA no devolvió JSON');
  const cuerpo = s.slice(i, s.lastIndexOf('}') + 1 || undefined);
  try { return JSON.parse(cuerpo); }
  catch (e) { const r = repararJson(s.slice(i)); if (r) { r._truncado = true; return r; } throw new Error('La IA devolvió un JSON incompleto (documento muy largo)'); }
}
async function leerConIA(fotos) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: 'ANTHROPIC_API_KEY no configurada' };
  const content = [];
  for (const f of fotos.slice(0, 8)) {
    const b64 = Buffer.isBuffer(f.data) ? f.data.toString('base64') : String(f.data);
    if (/pdf/i.test(f.mimetype || '')) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } });
    else content.push({ type: 'image', source: { type: 'base64', media_type: f.mimetype || 'image/jpeg', data: b64 } });
  }
  content.push({ type: 'text', text: PROMPT + '\n\nRegistra el resultado llamando a la herramienta «registrar_documento» (no escribas el JSON como texto).' });
  const modelo = CONFIG.ia.vision;
  let raw = '';
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 90000);
    // Salida ESTRUCTURADA (tool_use forzado): el API devuelve un objeto ya validado, así que las
    // comillas de las medidas en pulgadas (3/4", 1/2") o cualquier carácter raro de una factura
    // larga ya no rompen el JSON. Si no llega el bloque de herramienta, se lee el texto como antes.
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: c.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: modelo, max_tokens: 12000, tools: [HERRAMIENTA], tool_choice: { type: 'tool', name: HERRAMIENTA.name }, messages: [{ role: 'user', content }] }),
    }).finally(() => clearTimeout(t));
    const data = await r.json();
    if (!r.ok) throw new Error(`API ${r.status}: ${JSON.stringify(data).slice(0, 160)}`);
    const tu = (data.content || []).find(b => b.type === 'tool_use' && b.input && typeof b.input === 'object');
    raw = (data.content || []).map(b => b.text || '').join('');
    const j = (tu && (tu.input.tipo || tu.input.proveedor || (tu.input.lineas || []).length)) ? { ...tu.input } : parseJsonLoose(raw);
    if (j._truncado || data.stop_reason === 'max_tokens') { delete j._truncado; j.aviso = [j.aviso, 'Documento muy largo: la IA no llegó a leer todas las líneas; comprueba las últimas.'].filter(Boolean).join(' · '); }
    return { ok: true, modelo, datos: j };
  } catch (e) {
    console.error('[Compras] IA:', e.message, '| raw:', String(raw).slice(0, 200));
    return { ok: false, modelo, error: e.message };
  }
}
// Pasa lo leído a los campos de la compra (sin pisar lo que oficina ya haya corregido si `soloVacios`).
function aplicarLectura(doc, d) {
  const tipo = TIPOS.includes(d.tipo) ? d.tipo : 'otro';
  const neg = tipo === 'devolucion' ? (v => v == null ? null : -Math.abs(v)) : (v => v);
  const lineas = (Array.isArray(d.lineas) ? d.lineas : []).slice(0, 80).map(l => ({
    descripcion: String(l.descripcion || '').trim().slice(0, 200), cantidad: num(l.cantidad), unidad: String(l.unidad || '').trim().slice(0, 12) || null,
    precio: num(l.precio), importe: neg(num(l.importe)), talla: String(l.talla || '').trim().slice(0, 12) || null,
    albaran: String(l.albaran || '').trim().slice(0, 30) || null, obraTexto: String(l.obraTexto || '').trim().slice(0, 120) || null,
  })).filter(l => l.descripcion);
  Object.assign(doc, {
    tipo, proveedor: String(d.proveedor || '').trim().slice(0, 120) || null, proveedorNorm: norm(d.proveedor) || null,
    razonSocial: String(d.razonSocial || '').trim().slice(0, 160) || null, nif: String(d.nif || '').trim().slice(0, 20) || null, numero: String(d.numero || '').trim().slice(0, 60) || null,
    fecha: /^\d{4}-\d{2}-\d{2}$/.test(String(d.fecha || '')) ? d.fecha : null,
    base: neg(num(d.base)), iva: neg(num(d.iva)), total: neg(num(d.total)), lineas,
    albaranesRef: (Array.isArray(d.albaranesRef) ? d.albaranesRef : []).map(x => String(x).trim()).filter(Boolean).slice(0, 60),
    obraPista: String(d.obraPista || '').trim().slice(0, 160) || null,
  });
  return doc;
}

// ── DUPLICADOS: mismo proveedor + mismo número (y no descartada) ─
async function buscarDuplicado(db, doc) {
  if (!doc.proveedorNorm || !doc.numero) return null;
  const q = { empresaId: EMPRESA, estado: { $ne: 'descartada' }, proveedorNorm: doc.proveedorNorm, numero: doc.numero };
  // Mismo correo ya procesado (y no descartado) con el mismo nº: repetida. Un correo con dos facturas distintas no.
  if (doc.gmailId) { const e = await db.collection(COL).findOne({ empresaId: EMPRESA, gmailId: doc.gmailId, estado: { $ne: 'descartada' }, numero: doc.numero, _id: { $ne: doc._id } }, { projection: { _id: 1 } }); if (e) return String(e._id); }
  if (doc._id) q._id = { $ne: doc._id };
  const d = await db.collection(COL).findOne(q, { projection: { _id: 1 } });
  return d ? String(d._id) : null;
}

// ── ALTA (trabajador u oficina) ──────────────────────────────────
// fotos: [{data: Buffer, mimetype}]. Devuelve lo que se le confirma al que la sube.
// estadoInicial 'archivo': factura recuperada del correo solo para cuadrar el banco (no entra en la cola
// «por revisar», ni en costes de obra ni precios; se puede confirmar después desde Compras).
async function crear({ fotos, obraId, varias, destino, paraWorker, nota, subidaPor, origen, gmailId, email, soloSiDocumento = false, grupo = null, silencioso = false, estadoInicial = null, archivoHash = null }) {
  if (!fotos || !fotos.length) throw new Error('Haz al menos una foto del documento');
  const db = await getDB();
  let obraRef = null;
  if (obraId) {
    try { const o = await db.collection('obras').findOne({ _id: new ObjectId(String(obraId)) }, { projection: { reference: 1 } }); obraRef = o ? o.reference : null; if (!o) obraId = null; }
    catch (e) { obraId = null; }
  }
  let dest = DESTINOS.includes(destino) ? destino : (varias ? 'varias' : 'obra');
  const pw = (dest === 'herramientas' || dest === 'ropa') ? limpiarWorker(paraWorker) : null;
  if (dest !== 'obra') obraId = null;
  if (dest === 'varias') varias = true; else varias = false;
  const now = new Date();
  const doc = {
    empresaId: EMPRESA, estado: estadoInicial === 'archivo' ? 'archivo' : 'por_revisar', tipo: 'otro', destino: dest, paraWorker: pw,
    proveedor: null, proveedorNorm: null, nif: null, numero: null, fecha: null, base: null, iva: null, total: null, lineas: [], albaranesRef: [], obraPista: null,
    obraId: obraId ? String(obraId) : null, obraRef: obraId ? obraRef : null, varias: !!varias, reparto: [], categoria: dest === 'herramientas' ? 'herramientas' : dest === 'ropa' ? 'ropa' : null,
    nota: String(nota || '').trim().slice(0, 300) || null, subidaPor: subidaPor || null, nFotos: fotos.length,
    origen: origen || 'app', gmailId: gmailId || null, email: email || null,   // 'email' = llegó al correo (n8n ya la manda a StelOrder)
    grupo: grupo || null,   // { jid, nombre } si llegó por un grupo de WhatsApp
    archivoHash: archivoHash || null,   // subida masiva: el mismo archivo dos veces no entra
    ia: { ok: false }, duplicadoDe: null, revisadaPor: null, revisadaAt: null, enviadaStel: null, createdAt: now, updatedAt: now,
  };
  const r = await db.collection(COL).insertOne(doc);
  doc._id = r.insertedId;
  await db.collection(FOTOS).insertMany(fotos.map((f, i) => ({ compraId: String(doc._id), idx: i, mimetype: f.mimetype || 'image/jpeg', bytes: f.data.length, data: f.data, createdAt: now })));

  const lec = await leerConIA(fotos);
  if (lec.ok) {
    aplicarLectura(doc, lec.datos);
    doc.ia = { ok: true, calidad: lec.datos.calidad || 'legible', confianza: num(lec.datos.confianza), aviso: String(lec.datos.aviso || '').trim().slice(0, 200) || null, modelo: lec.modelo };
  } else {
    doc.ia = { ok: false, error: lec.error, modelo: lec.modelo || null };
  }
  // Del grupo llegan también fotos de la obra: si la IA ve que NO es un documento de compra, no se guarda.
  if (soloSiDocumento && lec.ok && doc.tipo === 'otro' && !doc.proveedor && doc.total == null && !(doc.lineas || []).length) {
    await db.collection(COL).deleteOne({ _id: doc._id });
    await db.collection(FOTOS).deleteMany({ compraId: String(doc._id) });
    return { ok: true, noEsDocumento: true };
  }
  doc.duplicadoDe = await buscarDuplicado(db, doc);
  doc.updatedAt = new Date();
  const { _id, ...set } = doc;
  await db.collection(COL).updateOne({ _id }, { $set: set });

  // Aviso a oficina (push al momento; el WhatsApp va en el resumen de las 18:00). No se avisa de lo que sube la propia oficina.
  if (!silencioso) try {
    const quien = origen === 'email' ? 'el correo' : ((subidaPor && subidaPor.name) || 'Alguien') + (grupo && grupo.nombre ? ` (grupo ${grupo.nombre})` : '');
    const que = doc.ia.ok ? `${TIPO_TXT[doc.tipo]}${doc.proveedor ? ' de ' + doc.proveedor : ''}${doc.numero ? ' nº ' + doc.numero : ''}` : 'un documento (la IA no pudo leerlo)';
    await require('./push').sendToOficina({ title: origen === 'email' ? '📧 Factura llegada por correo' : `📸 Compra de ${quien}`, body: `${que}${doc.obraRef ? ' · ' + doc.obraRef : dest === 'varias' ? ' · para varias obras' : dest === 'herramientas' || dest === 'ropa' ? ' · ' + DESTINO_TXT[dest].toLowerCase() + (pw ? ' para ' + pw.name : ' (queda en oficina)') : dest === 'general' ? ' · gasto general' : ''}. Por revisar.`, url: '/compras', tag: 'compra-nueva' });
  } catch (e) {}
  return { ok: true, id: String(doc._id), ...resumenParaTrabajador(doc) };
}
// ── SUBIDA MASIVA (oficina): las facturas que se bajan de golpe de la web de Obramat, Leroy… ──
// Cada archivo es una factura (o cada página, si el PDF las junta). La IA las lee una a una en segundo plano y
// descarta solas las repetidas: el mismo archivo, el mismo nº del mismo proveedor, o la factura de un pago que ya
// estaba como ticket (entonces la factura sustituye al ticket y se queda con su obra).
const _trabajos = new Map();
const _hash = b => require('crypto').createHash('sha256').update(b).digest('hex');
async function _partirPdf(buf) {
  const { PDFDocument } = require('pdf-lib');
  const src = await PDFDocument.load(buf, { ignoreEncryption: true });
  const out = [];
  for (let i = 0; i < src.getPageCount(); i++) { const d = await PDFDocument.create(); const [pg] = await d.copyPages(src, [i]); d.addPage(pg); out.push(Buffer.from(await d.save())); }
  return out;
}
// ¿Es la misma compra que otra ya subida? Mismo proveedor (nombre o NIF), total y fecha (±1 día).
async function _gemelaTicket(db, c) {
  if (c.total == null || !c.fecha || !(c.proveedorNorm || c.nif)) return null;
  const d = new Date(c.fecha + 'T12:00:00Z'), f = x => new Date(d.getTime() + x * 86400000).toISOString().slice(0, 10);
  const prov = [c.proveedorNorm ? { proveedorNorm: c.proveedorNorm } : null, c.nif ? { nif: c.nif } : null].filter(Boolean);
  return db.collection(COL).findOne({ empresaId: EMPRESA, _id: { $ne: c._id }, estado: { $ne: 'descartada' }, $or: prov, fecha: { $in: [f(-1), f(0), f(1)] }, total: { $gte: c.total - 0.01, $lte: c.total + 0.01 } });
}
async function _unaMasiva(db, it, por) {
  if (await db.collection(COL).findOne({ empresaId: EMPRESA, archivoHash: it.hash, estado: { $ne: 'descartada' } }, { projection: { _id: 1 } })) return { estado: 'repetida', motivo: 'Ese mismo archivo ya estaba subido' };
  const r = await crear({ fotos: [{ data: it.data, mimetype: it.mimetype }], destino: 'obra', origen: 'masiva', nota: `Subida masiva: ${it.nombre}`.slice(0, 300), subidaPor: por, silencioso: true, archivoHash: it.hash });
  const c = await db.collection(COL).findOne({ _id: new ObjectId(r.id) });
  const base = { id: r.id, proveedor: c.proveedor, numero: c.numero, fecha: c.fecha, total: c.total };
  if (!c.ia || !c.ia.ok) return { ...base, estado: 'sin_leer', motivo: 'La IA no la ha podido leer: revísala a mano' };
  const descartar = async motivo => { await db.collection(COL).updateOne({ _id: c._id }, { $set: { estado: 'descartada', descarteMotivo: motivo, descartadaPor: (por && por.name) || 'subida masiva', updatedAt: new Date() } }); return { ...base, estado: 'repetida', motivo }; };
  if (c.duplicadoDe) return descartar('Repetida: ya estaba en Compras con el mismo nº');
  const gem = await _gemelaTicket(db, c);
  if (gem) {
    // Factura del mismo pago que un ticket (lo subió el trabajador): si el ticket aún no está revisado, la factura lo
    // sustituye y hereda su obra; si ya se revisó, la repetida es esta.
    if (gem.estado === 'revisada' || c.tipo !== 'factura' || gem.tipo === 'factura') return descartar(`Repetida: es la misma compra que ${TIPO_TXT[gem.tipo] || 'el documento'} ${gem.numero || ''} del ${String(gem.fecha || '').split('-').reverse().join('/')}`.replace(/\s+/g, ' '));
    const heredar = {}; for (const k of ['destino', 'obraId', 'obraRef', 'varias', 'reparto', 'categoria', 'paraWorker', 'vehiculoId', 'vehiculoNombre', 'clienteNombre']) if (gem[k] != null && !(Array.isArray(gem[k]) && !gem[k].length)) heredar[k] = gem[k];
    await db.collection(COL).updateOne({ _id: c._id }, { $set: { ...heredar, sustituyeA: String(gem._id), updatedAt: new Date() } });
    await db.collection(COL).updateOne({ _id: gem._id }, { $set: { estado: 'descartada', descarteMotivo: `Sustituido por la factura ${c.numero || ''} (subida masiva)`.trim(), descartadaPor: 'subida masiva', updatedAt: new Date() } });
    try { await db.collection('punteoManual').updateMany({ compraId: String(gem._id) }, { $set: { compraId: r.id } }); } catch (e) {}
    return { ...base, estado: 'nueva', motivo: `Sustituye al ticket que ya estaba${gem.obraRef ? ' (obra ' + gem.obraRef + ')' : ''}` };
  }
  return { ...base, estado: 'nueva', tipo: c.tipo };
}
async function subidaMasiva(archivos, { porPagina = false, por = null } = {}) {
  const items = [];
  for (const a of archivos) {
    const esPdf = /pdf/i.test(a.mimetype || '') || /\.pdf$/i.test(a.originalname || '');
    if (!esPdf && !/^image\//.test(a.mimetype || '')) { items.push({ nombre: a.originalname, error: 'No es PDF ni foto' }); continue; }
    let trozos = [a.buffer];
    if (esPdf && porPagina) { try { trozos = await _partirPdf(a.buffer); } catch (e) { trozos = [a.buffer]; } }
    trozos.forEach((b, i) => items.push({ nombre: a.originalname + (trozos.length > 1 ? ` (pág. ${i + 1})` : ''), data: b, mimetype: esPdf ? 'application/pdf' : a.mimetype, hash: _hash(b) }));
  }
  // Repetidos dentro de la misma subida
  const vistos = new Set();
  for (const it of items) { if (it.hash && vistos.has(it.hash)) { it.error = null; it.repetidoEnLote = true; } else if (it.hash) vistos.add(it.hash); }
  const id = require('crypto').randomBytes(8).toString('hex');
  const job = { id, total: items.length, hechos: 0, nuevas: 0, repetidas: 0, errores: 0, terminado: false, items: items.map(it => ({ nombre: it.nombre, estado: it.error ? 'error' : it.repetidoEnLote ? 'repetida' : 'pendiente', motivo: it.error || (it.repetidoEnLote ? 'Repetida dentro de esta misma subida' : null) })), empezado: new Date() };
  _trabajos.set(id, job);
  (async () => {
    const db = await getDB();
    let sig = 0;
    const worker = async () => {
      while (sig < items.length) {
        const i = sig++; const it = items[i];
        if (it.error || it.repetidoEnLote) { job.hechos++; if (it.error) job.errores++; else job.repetidas++; continue; }
        try { const r = await _unaMasiva(db, it, por); Object.assign(job.items[i], r); if (r.estado === 'repetida') job.repetidas++; else if (r.estado === 'nueva') job.nuevas++; else job.errores++; }
        catch (e) { Object.assign(job.items[i], { estado: 'error', motivo: e.message }); job.errores++; }
        job.hechos++;
      }
    };
    await Promise.all([worker(), worker()]);           // dos a la vez: la IA tarda 10-30 s por factura
    job.terminado = true; job.terminadoAt = new Date();
    try { require('./trimestre').olvidarMapaPagos(); } catch (e) {}
    console.log(`[Compras] subida masiva ${id}: ${job.nuevas} nuevas, ${job.repetidas} repetidas, ${job.errores} con problema`);
    setTimeout(() => _trabajos.delete(id), 6 * 3600000);
  })().catch(e => { job.terminado = true; job.error = e.message; });
  return { id, total: items.length };
}
function estadoMasiva(id) { const j = _trabajos.get(String(id)); if (!j) throw new Error('No encuentro esa subida (¿se reinició el servidor?)'); return j; }
// Lo que ve quien la sube: tipo, proveedor, número, nº de líneas y calidad. SIN importes.
function resumenParaTrabajador(c) {
  const r = { id: String(c._id), estado: c.estado, tipo: c.tipo, tipoTxt: TIPO_TXT[c.tipo] || 'Documento', proveedor: c.proveedor, numero: c.numero, fecha: c.fecha, nLineas: (c.lineas || []).length, obraRef: c.obraRef, varias: !!c.varias, destino: c.destino || (c.varias ? 'varias' : 'obra'), destinoTxt: DESTINO_TXT[c.destino] || (c.varias ? 'Varias obras' : 'Obra'), paraWorker: c.paraWorker || null, nFotos: c.nFotos, createdAt: c.createdAt, leida: !!(c.ia && c.ia.ok), calidad: c.ia && c.ia.calidad || null, duplicado: !!c.duplicadoDe, motivoDescarte: c.estado === 'descartada' ? (c.descarteMotivo || 'sin motivo') : null };
  // Repetir la foto solo si de verdad falta algo: borrosa, ilegible, o cortada justo donde iba un dato clave.
  const faltaDato = c.total == null || !c.numero || !c.proveedor;
  r.repetir = c.estado !== 'revisada' && (!r.leida || ['borroso', 'no_es_documento'].includes(r.calidad) || (r.calidad === 'cortado' && faltaDato) || (c.estado === 'descartada' && /foto|ilegible|borros|cortad|no se ve|repet/i.test(c.descarteMotivo || '')));
  // Mensaje para la pantalla del móvil
  if (!r.leida) r.mensaje = 'Guardada. La IA no ha podido leerla ahora; oficina la revisará a mano.';
  else if (r.calidad === 'no_es_documento') r.mensaje = 'No parece un albarán ni una factura. Si lo es, repite la foto más de cerca.';
  else if (r.calidad === 'borroso' || (r.calidad === 'cortado' && r.repetir)) r.mensaje = `Hay que repetir esta foto: sale ${r.calidad === 'borroso' ? 'borrosa' : 'cortada y falta información'}.`;
  else if (r.calidad === 'cortado') r.mensaje = 'Guardada y leída. La foto sale algo cortada: la próxima, que salga el papel entero.';
  else if (r.duplicado) r.mensaje = 'Guardada. Parece que este documento ya se había subido; oficina lo comprobará.';
  else r.mensaje = 'Guardada y leída. Oficina la revisará.';
  return r;
}

// ── FOTOS ────────────────────────────────────────────────────────
async function getFoto(id, idx) {
  const db = await getDB();
  return db.collection(FOTOS).findOne({ compraId: String(id), idx: Number(idx) || 0 });
}
async function fotosDe(id) {
  const db = await getDB();
  return db.collection(FOTOS).find({ compraId: String(id) }).sort({ idx: 1 }).toArray();
}

// ── CONSULTAS ────────────────────────────────────────────────────
async function lista({ estado, desde, hasta, limit = 200 } = {}) {
  const db = await getDB();
  const q = { empresaId: EMPRESA };
  if (estado) q.estado = estado;
  if (desde || hasta) { q.createdAt = {}; if (desde) q.createdAt.$gte = new Date(desde); if (hasta) q.createdAt.$lte = new Date(hasta + 'T23:59:59'); }
  const arr = await db.collection(COL).find(q).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 200, 500)).toArray();
  return arr.map(c => ({ ...c, _id: String(c._id), lineas: undefined, nLineas: (c.lineas || []).length }));
}
async function getCompra(id) {
  const db = await getDB();
  const c = await db.collection(COL).findOne({ _id: oid(id), empresaId: EMPRESA });
  if (!c) throw new Error('Compra no encontrada');
  c._id = String(c._id);
  if (c.duplicadoDe) { const d = await db.collection(COL).findOne({ _id: oid(c.duplicadoDe) }, { projection: { estado: 1, createdAt: 1, obraRef: 1, subidaPor: 1, total: 1 } }); c.duplicadoInfo = d ? { id: c.duplicadoDe, estado: d.estado, createdAt: d.createdAt, obraRef: d.obraRef, por: d.subidaPor && d.subidaPor.name, total: d.total } : null; }
  return c;
}
async function mias(subidaPor, limit = 20) {
  const db = await getDB();
  const arr = await db.collection(COL).find({ empresaId: EMPRESA, 'subidaPor.kind': subidaPor.kind, 'subidaPor.userId': String(subidaPor.userId) }).sort({ createdAt: -1 }).limit(limit).toArray();
  return arr.map(resumenParaTrabajador);
}
async function contarPendientes() {
  const db = await getDB();
  return db.collection(COL).countDocuments({ empresaId: EMPRESA, estado: 'por_revisar' });
}

// ── REVISIÓN (oficina) ───────────────────────────────────────────
async function editar(id, data, por) {
  const db = await getDB();
  const c = await db.collection(COL).findOne({ _id: oid(id), empresaId: EMPRESA });
  if (!c) throw new Error('Compra no encontrada');
  const set = { updatedAt: new Date() };
  if ('tipo' in data) { if (!TIPOS.includes(data.tipo)) throw new Error('Tipo no válido'); set.tipo = data.tipo; }
  if ('proveedor' in data) { set.proveedor = String(data.proveedor || '').trim().slice(0, 120) || null; set.proveedorNorm = norm(data.proveedor) || null; }
  if ('nif' in data) set.nif = String(data.nif || '').trim().slice(0, 20) || null;
  if ('razonSocial' in data) set.razonSocial = String(data.razonSocial || '').trim().slice(0, 160) || null;
  if ('numero' in data) set.numero = String(data.numero || '').trim().slice(0, 60) || null;
  if ('fecha' in data) set.fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(data.fecha || '')) ? data.fecha : null;
  for (const k of ['base', 'iva', 'total']) if (k in data) set[k] = n2(data[k]);
  if ('lineas' in data && Array.isArray(data.lineas)) set.lineas = data.lineas.slice(0, 120).map(l => ({ descripcion: String(l.descripcion || '').trim().slice(0, 200), cantidad: nCant(l.cantidad), unidad: String(l.unidad || '').trim().slice(0, 12) || null, precio: n2(l.precio), importe: n2(l.importe), talla: String(l.talla || '').trim().slice(0, 12) || null, vehiculoId: /^[a-f0-9]{24}$/.test(String(l.vehiculoId || '')) ? String(l.vehiculoId) : null, albaran: String(l.albaran || '').trim().slice(0, 30) || null, obraTexto: String(l.obraTexto || '').trim().slice(0, 120) || null, para: limpiarPara(l.para), recogida: !!l.recogida })).filter(l => l.descripcion);
  if ('albaranesRef' in data) set.albaranesRef = (Array.isArray(data.albaranesRef) ? data.albaranesRef : String(data.albaranesRef || '').split(/[,\s;]+/)).map(x => String(x).trim()).filter(Boolean).slice(0, 60);
  if ('nota' in data) set.nota = String(data.nota || '').trim().slice(0, 300) || null;
  if ('categoria' in data) set.categoria = data.categoria ? String(data.categoria).trim().toLowerCase() : null;
  // Reparación suelta sin obra: va al cliente (comunidad, particular…) para ver su historial y lo que nos deja.
  if ('clienteNombre' in data) set.clienteNombre = String(data.clienteNombre || '').trim().slice(0, 160) || null;
  if ('destino' in data) { if (!DESTINOS.includes(data.destino)) throw new Error('Destino no válido'); set.destino = data.destino; }
  if ('paraWorker' in data) set.paraWorker = limpiarWorker(data.paraWorker);
  // Vehículo de la flota (/vehiculos): sus gastos se ven en su ficha.
  if ('vehiculoId' in data) {
    set.vehiculoId = null; set.vehiculoNombre = null;
    if (data.vehiculoId && /^[a-f0-9]{24}$/.test(String(data.vehiculoId))) {
      const v = await db.collection('vehiculos').findOne({ _id: new ObjectId(String(data.vehiculoId)) }, { projection: { nombre: 1, matricula: 1 } });
      if (v) { set.vehiculoId = String(v._id); set.vehiculoNombre = v.nombre + (v.matricula ? ` (${v.matricula})` : ''); }
    }
  }
  let destFinal = set.destino || c.destino || (c.varias ? 'varias' : 'obra');
  // Sin destino explícito: categoría y sin obra ⇒ gasto general; reparto de varias ⇒ varias
  if (!('destino' in data)) {
    if (Array.isArray(data.reparto) && data.reparto.length > 1) destFinal = 'varias';
    else if (destFinal === 'obra' && data.categoria && !data.obraId) destFinal = 'general';
    if (destFinal !== (c.destino || 'obra')) set.destino = destFinal;
  }
  if (destFinal === 'herramientas' && !('categoria' in data)) set.categoria = 'herramientas';
  if (destFinal === 'ropa' && !('categoria' in data)) set.categoria = 'ropa';
  if (destFinal !== 'herramientas' && destFinal !== 'ropa') set.paraWorker = null;
  // Obra única, o reparto entre varias (importes por obra; la suma no tiene por qué cuadrar al céntimo)
  if ('obraId' in data || 'reparto' in data) {
    const rep = Array.isArray(data.reparto) ? data.reparto : [];
    if (rep.length > 1) {
      set.reparto = []; set.varias = true; set.obraId = null; set.obraRef = null;
      for (const p of rep) {
        if (!p.obraId) continue;
        const o = await db.collection('obras').findOne({ _id: new ObjectId(String(p.obraId)) }, { projection: { reference: 1 } });
        if (o) set.reparto.push({ obraId: String(o._id), obraRef: o.reference || '', importe: n2(p.importe), ...(p.texto ? { texto: String(p.texto).trim().slice(0, 120) } : {}) });
      }
    } else {
      const unico = rep.length === 1 ? rep[0].obraId : data.obraId;
      set.reparto = []; set.varias = false; set.obraId = null; set.obraRef = null;
      if (unico) { const o = await db.collection('obras').findOne({ _id: new ObjectId(String(unico)) }, { projection: { reference: 1 } }); if (o) { set.obraId = String(o._id); set.obraRef = o.reference || ''; } }
    }
  }
  if (destFinal === 'lineas') Object.assign(set, await _repartoDeLineas(db, set.lineas || c.lineas || []));
  else if (c.repartoOtros) set.repartoOtros = null;
  if (por) set.editadaPor = por;
  await db.collection(COL).updateOne({ _id: c._id }, { $set: set });
  const dup = await buscarDuplicado(db, { ...c, ...set, _id: c._id });
  await db.collection(COL).updateOne({ _id: c._id }, { $set: { duplicadoDe: dup } });
  return getCompra(id);
}
// Factura por líneas: lo de cada obra se suma en `reparto` (cuenta en su rentabilidad como «varias obras») y lo
// demás (herramientas, EPIs, almacén, gasto general) en `repartoOtros`.
const _OTROS_TXT = { herramientas: 'herramientas', ropa: 'EPIs / ropa', almacen: 'almacén', general: 'gasto general' };
function _textoOtros(otros) { return (otros || []).filter(o => o.importe).map(o => `${_OTROS_TXT[o.t] || o.t}${o.quien ? ' (' + o.quien + ')' : ''} ${o.importe.toFixed(2)} €`).join(', ') || null; }
async function _repartoDeLineas(db, lineas) {
  const porObra = new Map(), otros = {};
  let sinDestino = 0;
  for (const l of lineas) {
    const imp = Number(l.importe) || 0, p = l.para;
    if (!p) { sinDestino++; continue; }
    if (p.t === 'obra') porObra.set(p.obraId, (porObra.get(p.obraId) || 0) + imp);
    else { const k = p.t + (p.workerName ? '|' + p.workerName : ''); otros[k] = (otros[k] || 0) + imp; }
  }
  const reparto = [];
  for (const [obraId, imp] of porObra) {
    const o = await db.collection('obras').findOne({ _id: new ObjectId(obraId) }, { projection: { reference: 1 } });
    if (o) reparto.push({ obraId, obraRef: o.reference || '', importe: n2(imp) });
  }
  const repartoOtros = Object.entries(otros).map(([k, imp]) => { const [t, quien] = k.split('|'); return { t, quien: quien || null, importe: n2(imp) }; });
  return { reparto, repartoOtros, varias: reparto.length > 0, obraId: null, obraRef: null, sinDestino, categoria: null };
}
const _EPI = /\b(guant|guante|ulleres?|gafas?|sabat|bota|botas|calcat|calzado|casc|casco|mascaret|mascarill|tap(s|ons)? (d.)?oid|protector(s)? (auditiu|auditivo)|orejera|armilla|chaleco|arnes|faixa|genoller|rodiller|pantalo|pantalon|samarret|camiseta|jaqueta|chaqueta|polo|sudadera|forro polar|impermeable|epi)/;
const _HERR = /\b(pala|paleti|paleta|llana|regle|regla|nivell|nivel|martell|martillo|maceta|maza|tornavis|destornillador|alicat|tenalla|tenaza|serra|sierra|serrucho|metre|flexometre|flexometro|carretilla|escala|escalera|cisell|cincel|espatula|cutter|ganivet|trepant|taladr|radial|amoladora|pistola|caixa d.eines|caja de herramientas|clau angl|llave inglesa|serjant|sargento|tracer|pinzell|brotxa|brocha|rodet|rodillo)/;
// Propuesta para cada línea de una factura mezclada: lo que ya se decidió antes para ese mismo artículo,
// la obra de su albarán (si el albarán está en Compras con obra, o la factura dice la obra) y, si no,
// por el nombre: EPI / ropa, herramienta… Lo que no se sabe se deja vacío.
async function propuestaLineas(id) {
  const db = await getDB();
  const c = await db.collection(COL).findOne({ _id: oid(id), empresaId: EMPRESA });
  if (!c) throw new Error('Compra no encontrada');
  const ls = c.lineas || [];
  const clave = d => norm(d).replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim();
  const previas = await db.collection(COL).find({ empresaId: EMPRESA, destino: 'lineas', estado: 'revisada', _id: { $ne: c._id } })
    .sort({ revisadaAt: -1 }).limit(150).project({ lineas: 1 }).toArray();
  const aprendido = new Map();
  previas.forEach(p => (p.lineas || []).forEach(l => { const k = clave(l.descripcion); if (l.para && l.para.t !== 'obra' && k && !aprendido.has(k)) aprendido.set(k, l.para); }));
  let obraAlb = new Map();
  try {
    const r = await repartoPorAlbaran(id);
    (r.grupos || []).forEach(g => { if (g.obraId) { g.albaranes.forEach(a => obraAlb.set(nd(a), g)); if (g.obraTexto) obraAlb.set('txt:' + norm(g.obraTexto), g); } });
  } catch (e) { obraAlb = new Map(); }
  return ls.map((l, idx) => {
    if (l.para) return { idx, para: l.para, motivo: 'elegido' };
    const t = norm(l.descripcion);
    const ap = aprendido.get(clave(l.descripcion));
    if (ap) return { idx, para: { t: ap.t }, motivo: 'como la última vez' };
    if (_EPI.test(t)) return { idx, para: { t: 'ropa' }, motivo: 'parece un EPI' };
    const g = (l.albaran && obraAlb.get(nd(l.albaran))) || (l.obraTexto && obraAlb.get('txt:' + norm(l.obraTexto)));
    if (g && !_HERR.test(t)) return { idx, para: { t: 'obra', obraId: g.obraId }, motivo: `albarán ${l.albaran || ''} → ${g.obraRef}`.replace('  ', ' ') };
    if (_HERR.test(t)) return { idx, para: { t: 'herramientas' }, motivo: 'parece una herramienta' };
    if (g) return { idx, para: { t: 'obra', obraId: g.obraId }, motivo: `albarán → ${g.obraRef}` };
    return { idx, para: null, motivo: null };
  });
}
// Han subido dos documentos juntos (p. ej. una devolución y la factura nueva): esa foto pasa a una compra
// nueva (la IA la lee) y la original se vuelve a leer sin ella.
async function separarFoto(id, idx, por) {
  const db = await getDB();
  const c = await db.collection(COL).findOne({ _id: oid(id), empresaId: EMPRESA });
  if (!c) throw new Error('Compra no encontrada');
  if (c.estado === 'revisada') throw new Error('Está revisada: reábrela antes de separar');
  const fotos = await fotosDe(id);
  if (fotos.length < 2) throw new Error('Solo tiene una foto');
  const f = fotos.find(x => Number(x.idx) === Number(idx));
  if (!f) throw new Error('Foto no encontrada');
  const nueva = await crear({ fotos: [{ data: f.data.buffer ? Buffer.from(f.data.buffer) : f.data, mimetype: f.mimetype }], destino: c.destino || null, obraId: c.obraId || null,
    paraWorker: c.paraWorker || null, origen: c.origen, gmailId: null, email: c.email || null, nota: `Separada de ${c.proveedor || 'otra compra'}${c.numero ? ' nº ' + c.numero : ''}`, subidaPor: c.subidaPor, silencioso: true });
  // Fuera de la original y fotos renumeradas (0, 1, 2…)
  await db.collection(FOTOS).deleteOne({ _id: f._id });
  const resto = fotos.filter(x => String(x._id) !== String(f._id)).sort((a, b) => a.idx - b.idx);
  for (let i = 0; i < resto.length; i++) if (resto[i].idx !== i) await db.collection(FOTOS).updateOne({ _id: resto[i]._id }, { $set: { idx: i } });
  await db.collection(COL).updateOne({ _id: c._id }, { $set: { nFotos: resto.length, updatedAt: new Date() }, $push: { historial: { accion: 'separada', foto: Number(idx), nueva: nueva && nueva.id, por: por || '', at: new Date() } } });
  let releida = null; try { releida = await releer(id); } catch (e) { releida = null; }
  return { ok: true, nuevaId: nueva && nueva.id, original: releida || await getCompra(id) };
}
async function releer(id) {
  const db = await getDB();
  const c = await db.collection(COL).findOne({ _id: oid(id), empresaId: EMPRESA });
  if (!c) throw new Error('Compra no encontrada');
  const fotos = await fotosDe(id);
  const lec = await leerConIA(fotos.map(f => ({ data: f.data.buffer ? Buffer.from(f.data.buffer) : f.data, mimetype: f.mimetype })));
  if (!lec.ok) {
    // Se guarda el intento fallido (con la hora): si no, la pantalla seguía enseñando el error antiguo.
    await db.collection(COL).updateOne({ _id: c._id }, { $set: { 'ia.error': lec.error, 'ia.intentoAt': new Date(), updatedAt: new Date() } });
    throw new Error('La IA no ha podido leerla: ' + lec.error);
  }
  const doc = aplicarLectura({}, lec.datos);
  doc.ia = { ok: true, calidad: lec.datos.calidad || 'legible', confianza: num(lec.datos.confianza), aviso: String(lec.datos.aviso || '').trim().slice(0, 200) || null, modelo: lec.modelo, releidaAt: new Date() };
  doc.updatedAt = new Date();
  await db.collection(COL).updateOne({ _id: c._id }, { $set: doc });
  const dup = await buscarDuplicado(db, { ...c, ...doc, _id: c._id });
  await db.collection(COL).updateOne({ _id: c._id }, { $set: { duplicadoDe: dup } });
  return getCompra(id);
}
async function _entradaAlmacen(c, almacen, por) {
  const alm = require('./almacen'); const creado = [];
  for (const l of almacen.slice(0, 60)) {
    try {
      const q = Math.max(0, Number(l.cantidad) || 0); if (!q) continue;
      const total = Math.abs(Number(l.valor) || 0);
      const r = await alm.entrada({ nombre: l.nombre, unidad: l.unidad || 'ud', cantidad: q, precioUd: Number(l.valorEsTotal) ? total / q : total, recogida: !!l.recogida, compraId: String(c._id), proveedor: c.proveedor, fecha: c.fecha, by: por });
      creado.push({ id: r.id, nombre: r.nombre, cantidad: q });
    } catch (e) { console.warn('[Compras] almacén:', e.message); }
  }
  return creado;
}
// Una unidad por cada cantidad de la línea ("4 × pantalón" → 4 prendas), tope 30 por línea; entregada a `worker` o en oficina.
async function _altaActivos(c, items, por) {
  const act = require('./activos'); const creadas = [];
  let total = 0;
  for (const h of items.slice(0, 40)) {
    const nombre = String(h.nombre || '').trim(); if (!nombre) continue;
    const n = Math.min(30, Math.max(1, Math.round(Number(h.cantidad) || 1)));
    const valorUd = Math.abs(Number(h.valor) || 0) / (Number(h.valorEsTotal) ? n : 1);
    for (let i = 0; i < n && total < 60; i++, total++) {
      try {
        const r = await act.crearActivo({ tipo: h.tipo, nombre, talla: h.talla || '', marca: h.marca || '', modelo: h.modelo || '', valor: Math.round(valorUd * 100) / 100, fechaCompra: c.fecha || new Date().toISOString().slice(0, 10), notas: `Compra ${c.proveedor || ''}${c.numero ? ' nº ' + c.numero : ''}${n > 1 ? ` (${i + 1} de ${n})` : ''} (foto en Compras)` }, por);
        if (h.worker && h.worker.id) await act.darActivo(r.id, { holderType: 'operario', holderId: h.worker.id, holderName: h.worker.name, nota: 'Entregada al comprarla' }, por);
        creadas.push({ id: r.id, codigo: r.codigo, nombre: nombre + (h.talla ? ' ' + h.talla : ''), para: h.worker && h.worker.name || null });
      } catch (e) { console.warn('[Compras] alta:', e.message); }
    }
  }
  return creadas;
}
// CONFIRMAR: pasa a revisada. Las FACTURAS y TICKETS se mandan a StelOrder (n8n) en este
// momento, con la obra ya correcta. Los albaranes y devoluciones se quedan en el dashboard.
async function revisar(id, por, { enviarStel = true, herramientas = null, almacen = null } = {}) {
  const db = await getDB();
  const c = await db.collection(COL).findOne({ _id: oid(id), empresaId: EMPRESA });
  if (!c) throw new Error('Compra no encontrada');
  if (c.estado === 'revisada') return getCompra(id);
  if (!c.proveedor) throw new Error('Pon el proveedor antes de confirmar');
  const dest = c.destino || ((c.reparto || []).length > 1 || c.varias ? 'varias' : (c.categoria && !c.obraId) ? 'general' : 'obra');
  if (dest === 'obra' && !c.obraId) throw new Error('Elige la obra (o cambia el destino: varias obras, herramientas, ropa o gasto general)');
  if (dest === 'varias' && !(c.reparto || []).length) throw new Error('Reparte el importe entre las obras');
  if (dest === 'lineas' && !(c.lineas || []).length) throw new Error('No tiene líneas: pon las líneas o elige otro destino');
  if (dest === 'general' && !c.categoria) throw new Error('Pon la categoría del gasto general');
  if (dest === 'cliente' && !c.clienteNombre) throw new Error('Elige el cliente');
  if (dest === 'vehiculo' && !c.vehiculoId && !(c.lineas || []).some(l => l.vehiculoId)) throw new Error('Elige el vehículo (o el de cada línea)');
  if (dest === 'almacen' && !(Array.isArray(almacen) && almacen.length) && !(c.almacenCreado || []).length) throw new Error('Marca qué líneas entran en el almacén');
  const set = { estado: 'revisada', revisadaPor: por || '', revisadaAt: new Date(), updatedAt: new Date() };
  // Factura por líneas: lo de herramientas/EPIs se da de alta (a quien diga cada línea) y lo de almacén entra al almacén.
  if (dest === 'lineas') {
    const ls = c.lineas || [];
    const sin = ls.filter(l => !l.para).length;
    if (sin) throw new Error(`Hay ${sin} línea(s) sin decir a dónde van`);
    if (!(c.activosCreados || []).length) set.activosCreados = await _altaActivos(c, ls.filter(l => l.para.t === 'herramientas' || l.para.t === 'ropa').map(l => ({ nombre: l.descripcion, cantidad: l.cantidad, talla: l.talla, valor: l.importe, valorEsTotal: 1, tipo: l.para.t === 'ropa' ? 'ropa' : 'herramienta', worker: l.para.workerId ? { id: l.para.workerId, name: l.para.workerName } : null })), por);
    if (!(c.almacenCreado || []).length) set.almacenCreado = await _entradaAlmacen(c, ls.filter(l => l.para.t === 'almacen').map(l => ({ nombre: l.descripcion, unidad: l.unidad || 'ud', cantidad: Number(l.cantidad) || 1, recogida: !!l.recogida, valor: l.importe, valorEsTotal: 1 })), por);
  }
  // ALMACÉN: cada línea marcada entra como existencias (se agrupa por nombre; precio medio).
  if (dest === 'almacen' && Array.isArray(almacen) && almacen.length && !(c.almacenCreado || []).length) set.almacenCreado = await _entradaAlmacen(c, almacen, por);
  // HERRAMIENTAS y ROPA: cada línea marcada se da de alta en Llaves y herramientas. Si hay un
  // trabajador, se le ENTREGA (queda en su historial); si no, se queda en OFICINA para
  // repartirla más adelante desde Llaves y herramientas.
  // Si ya se dieron de alta (se reabrió y se vuelve a confirmar), no se duplican.
  if ((dest === 'herramientas' || dest === 'ropa') && Array.isArray(herramientas) && herramientas.length && !(c.activosCreados || []).length)
    set.activosCreados = await _altaActivos(c, herramientas.map(h => ({ ...h, tipo: dest === 'ropa' ? 'ropa' : 'herramienta', worker: c.paraWorker })), por);
  if (enviarStel && (c.tipo === 'factura' || c.tipo === 'ticket') && !(c.enviadaStel && c.enviadaStel.ok)) {
    try {
      const fw = require('./facturaWhatsApp');
      const fotos = await fotosDe(id);
      const imgs = fotos.filter(f => /^image\//.test(f.mimetype || ''));
      const pdfs = fotos.filter(f => /pdf/i.test(f.mimetype || ''));
      const attachments = pdfs.map(f => ({ filename: `compra-${c.numero || id}.pdf`, content: Buffer.from(f.data.buffer || f.data), contentType: 'application/pdf' }));
      if (imgs.length) {
        const pdf = await fw.fotosAPdf(imgs.map(f => ({ data: Buffer.from(f.data.buffer || f.data).toString('base64'), media_type: f.mimetype })));
        if (pdf) attachments.push({ filename: `${c.tipo}-${(c.proveedor || 'proveedor').replace(/[^\w-]+/g, '_')}-${(c.numero || id).replace(/[^\w-]+/g, '_')}.pdf`, content: pdf, contentType: 'application/pdf' });
      }
      const obraRef = dest === 'obra' ? c.obraRef : (dest === 'varias' || dest === 'lineas') ? (c.reparto || []).map(p => p.obraRef).join(' + ') || null : dest === 'cliente' ? c.clienteNombre : null;
      const catGasto = c.categoria || ({ herramientas: 'herramientas', ropa: 'ropa', almacen: 'material', lineas: 'material' })[dest] || null;
      const r = await fw.reenviarFacturaMail({ attachments, obraRef, obraId: c.obraId || null, origen: 'compras', from: por || 'oficina', nota: [c.proveedor, c.numero ? 'nº ' + c.numero : null, c.total != null ? c.total + ' €' : null, (dest === 'herramientas' || dest === 'ropa') ? DESTINO_TXT[dest] + (c.paraWorker ? ' para ' + c.paraWorker.name : ' (stock en oficina)') : null, dest === 'lineas' ? _textoOtros(c.repartoOtros) : null].filter(Boolean).join(' · '), categoria: !obraRef ? catGasto : null });
      set.enviadaStel = { ok: !!r.ok, at: new Date(), detalle: r.reply || null };
    } catch (e) { set.enviadaStel = { ok: false, at: new Date(), detalle: e.message }; }
  }
  // Factura de ITV de un vehículo: su ficha queda con la última ITV (fecha de la factura) y la próxima calculada.
  if ((set.destino || c.destino) === 'vehiculo' && (set.categoria || c.categoria) === 'itv' && (set.vehiculoId || c.vehiculoId) && c.fecha) {
    try { const r = await require('./vehiculos').registrarItv(set.vehiculoId || c.vehiculoId, c.fecha, { origen: [c.proveedor, c.numero].filter(Boolean).join(' '), por }); if (r) set.itvActualizada = r; }
    catch (e) { console.warn('[Compras] ITV del vehículo:', e.message); }
  }
  await db.collection(COL).updateOne({ _id: c._id }, { $set: set });
  // Reparto por albaranes: si la factura decía «CARRER OVIEDO 39» y se eligió la obra Oviedo 16, se apunta
  // como alias de esa obra para que la próxima vez salga sola.
  if ((c.reparto || []).some(p => p.texto)) { try { await aprenderAliasObras(c.reparto); } catch (e) { console.warn('[Compras] alias obra:', e.message); } }
  // CINC: sus comisiones mal cobradas quedan apuntadas en Reclamaciones (en segundo plano: tarda unos segundos).
  if (/\bcinc\b/i.test(c.proveedor || '') && c.tipo !== 'devolucion') require('./reclamaciones').desdeCinc(String(c._id), por).catch(e => console.warn('[Compras] reclamación CINC:', e.message));
  // Gasolinera: cada tiquet queda unido a su línea y vehículo (y se aprende el nombre que tenía en la app Esclat).
  if (dest === 'vehiculo' && (c.lineas || []).some(l => l.vehiculoId)) { try { await require('./repostajes').alConfirmar(c); } catch (e) { console.warn('[Compras] repostajes:', e.message); } }
  // Cierra el aviso al trabajador con lo que ha pasado (push, sin importes)
  try {
    if (c.subidaPor && c.subidaPor.kind === 'worker') await require('./push').sendToWorker(c.subidaPor.userId, { title: '✅ Compra revisada', body: `${TIPO_TXT[c.tipo]}${c.proveedor ? ' de ' + c.proveedor : ''} — ${c.obraRef || DESTINO_TXT[dest]}${(set.activosCreados || []).length ? ' · ' + set.activosCreados.length + (dest === 'ropa' ? ' prenda(s)' : ' herramienta(s)') + ' a tu nombre' : ''}.`, url: '/compra', tag: 'compra-revisada' });
  } catch (e) {}
  return getCompra(id);
}
async function descartar(id, por, motivo) {
  const db = await getDB();
  const c = await db.collection(COL).findOne({ _id: oid(id), empresaId: EMPRESA });
  if (!c) throw new Error('Compra no encontrada');
  await db.collection(COL).updateOne({ _id: c._id }, { $set: { estado: 'descartada', descartadaPor: por || '', descartadaAt: new Date(), descarteMotivo: String(motivo || '').trim().slice(0, 200) || null, updatedAt: new Date() } });
  // WhatsApp al trabajador: qué se descartó, por qué y, si es la foto, que la repita (con el enlace).
  try {
    if (c.subidaPor && c.subidaPor.kind === 'worker' && c.subidaPor.userId) {
      const u = await db.collection('users').findOne({ _id: oid(c.subidaPor.userId) }, { projection: { name: 1, whatsapp: 1, telefono: 1 } }).catch(() => null);
      const d = String((u && (u.whatsapp || u.telefono)) || '').replace(/\D/g, '');
      const tel = d ? (d.length === 9 ? '+34' + d : '+' + d.replace(/^00/, '')) : null;
      if (tel) {
        const nom = String((u && u.name) || c.subidaPor.name || '').split(/\s+/)[0];
        const doc = `${(TIPO_TXT[c.tipo] || 'documento').toLowerCase()}${c.proveedor ? ' de ' + c.proveedor : ''} del ${new Date(c.createdAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'numeric' })}`;
        const foto = /foto|ilegible|borros|cortad|no se ve|repet/i.test(String(motivo || ''));
        const base = String(process.env.DASHBOARD_URL || 'https://dashboard.corpprojects.es').replace(/\/$/, '');
        await require('./notifications').sendWhatsAppTo(tel, foto
          ? `Hola ${nom} 📸 La foto del ${doc} no se puede leer (${String(motivo).trim()}). ¿Puedes repetirla?\n\n✅ El papel entero dentro de la foto, plano sobre una superficie, con buena luz y sin sombras ni bolsas encima.\n\n${base}/compra`
          : `Hola ${nom}, se ha descartado el ${doc}${motivo ? ': ' + String(motivo).trim() : ''}.`);
      }
    }
  } catch (e) { console.warn('[Compras] aviso de descarte:', e.message); }
  try {
    if (c.subidaPor && c.subidaPor.kind === 'worker') await require('./push').sendToWorker(c.subidaPor.userId, { title: 'Compra descartada', body: `${TIPO_TXT[c.tipo]}${c.proveedor ? ' de ' + c.proveedor : ''}${motivo ? ': ' + String(motivo).slice(0, 80) : ''}. Si hace falta, vuelve a hacer la foto.`, url: '/compra', tag: 'compra-descartada' });
  } catch (e) {}
  return getCompra(id);
}
async function reabrir(id) {
  const db = await getDB();
  await db.collection(COL).updateOne({ _id: oid(id), empresaId: EMPRESA }, { $set: { estado: 'por_revisar', updatedAt: new Date() } });
  return getCompra(id);
}

// ── COMPRAS DE UNA OBRA (para su ficha y su rentabilidad) ────────
// Revisadas, con obra única o reparto. `importe` = lo que carga a ESTA obra (base sin IVA;
// si no hay base, el total; en reparto, la parte asignada). Albaranes sin importe → 0.
async function deObra(obraId) {
  const id = String(obraId);
  const db = await getDB();
  const arr = await db.collection(COL).find({ empresaId: EMPRESA, estado: 'revisada', $or: [{ obraId: id }, { 'reparto.obraId': id }] })
    .project({ lineas: 0 }).sort({ fecha: -1, createdAt: -1 }).toArray();
  return arr.map(c => {
    const parte = (c.reparto || []).find(p => p.obraId === id);
    const importe = parte ? (Number(parte.importe) || 0) : (c.base != null ? c.base : (c.total != null ? c.total : 0));
    return { id: String(c._id), tipo: c.tipo, proveedor: c.proveedor, proveedorNorm: c.proveedorNorm, numero: c.numero, fecha: c.fecha || (c.createdAt && c.createdAt.toISOString().slice(0, 10)), importe: Math.round(importe * 100) / 100,
      sinImporte: !parte && c.base == null && c.total == null, reparto: !!parte, albaranesRef: c.albaranesRef || [], facturaId: c.facturaId || null, facturaNumero: c.facturaNumero || null, casado: c.casado ? { n: c.casado.n, suma: c.casado.suma, diferencia: c.casado.diferencia } : null, enviadaStel: !!(c.enviadaStel && c.enviadaStel.ok), origen: c.origen || 'app', por: c.subidaPor && c.subidaPor.name, nLineas: c.nLineas };
  });
}

// ── CASAR FACTURA MENSUAL CON SUS ALBARANES (4.3) ─────────────────
// Saltoki y otros facturan a mes vencido: la factura agrupa albaranes ya subidos. Al casarlos,
// en la rentabilidad cuentan los ALBARANES (cada uno en su obra) y la factura no vuelve a sumar.
const nd = v => { const d = (String(v || '').match(/\d+/g) || []).join(''); return d ? d.replace(/^0+/, '') : String(v || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
const prov1 = c => String(c.proveedorNorm || norm(c.proveedor) || '').split(' ')[0];
async function propuestaCasar(facturaId) {
  const db = await getDB();
  const f = await db.collection(COL).findOne({ _id: oid(facturaId), empresaId: EMPRESA });
  if (!f) throw new Error('Compra no encontrada');
  if (f.tipo !== 'factura') throw new Error('Solo se casan facturas');
  const p1 = prov1(f); if (!p1) throw new Error('La factura no tiene proveedor');
  const ref = new Set((f.albaranesRef || []).map(nd).filter(Boolean));
  const ffecha = f.fecha || (f.createdAt && f.createdAt.toISOString().slice(0, 10)) || new Date().toISOString().slice(0, 10);
  const desde = new Date(new Date(ffecha).getTime() - 75 * 86400000).toISOString().slice(0, 10), hasta = new Date(new Date(ffecha).getTime() + 5 * 86400000).toISOString().slice(0, 10);
  const cand = await db.collection(COL).find({ empresaId: EMPRESA, tipo: 'albaran', estado: { $ne: 'descartada' }, _id: { $ne: f._id } }).project({ lineas: 0 }).sort({ fecha: 1 }).toArray();
  const albaranes = cand.filter(a => prov1(a) === p1 && (!a.facturaId || String(a.facturaId) === String(f._id))).map(a => {
    const fe = a.fecha || (a.createdAt && a.createdAt.toISOString().slice(0, 10)) || '';
    const refEnFactura = !!(a.numero && ref.has(nd(a.numero)));
    const enVentana = fe >= desde && fe <= hasta;
    const importe = a.base != null ? a.base : (a.total != null ? a.total : null);
    return { id: String(a._id), numero: a.numero, fecha: fe, importe, sinImporte: importe == null, obraRef: a.obraRef || ((a.reparto || []).length ? a.reparto.map(p => p.obraRef).join(' + ') : null), estado: a.estado, yaCasado: !!a.facturaId, refEnFactura, enVentana, sugerido: !!a.facturaId || refEnFactura || (ref.size === 0 && enVentana) };
  });
  const sug = albaranes.filter(a => a.sugerido);
  const suma = Math.round(sug.reduce((x, a) => x + (a.importe || 0), 0) * 100) / 100;
  const base = f.base != null ? f.base : f.total;
  return { factura: { id: String(f._id), numero: f.numero, proveedor: f.proveedor, fecha: ffecha, base: f.base, total: f.total, albaranesRef: f.albaranesRef || [], casado: f.casado || null },
    ventana: { desde, hasta }, albaranes, sumaSugeridos: suma, diferencia: base != null ? Math.round((base - suma) * 100) / 100 : null, sinImporteSugeridos: sug.filter(a => a.sinImporte).length,
    noEncontrados: [...ref].filter(r => !albaranes.some(a => a.numero && nd(a.numero) === r)) };
}
// Albaranes que la factura cita y no están en Compras: se buscan en el correo (primero del mismo remitente
// que la factura; si no, de cualquiera) y se traen a la cola. La IA los lee (nº, obra) y quedan para casar.
async function albaranesDelCorreo(facturaId) {
  const p = await propuestaCasar(facturaId);
  const faltan = p.noEncontrados.filter(r => /^\d{4,}$/.test(r)).slice(0, 15);
  if (!faltan.length) return { ...p, correo: { buscados: 0, correos: 0, traidos: 0 } };
  const db = await getDB();
  const f = await db.collection(COL).findOne({ _id: oid(facturaId), empresaId: EMPRESA });
  const ei = require('./email-intelligence');
  const gmail = ei.getGmailClient();
  const dom = ((f.email && f.email.de) || '').match(/@([\w.-]+)/);
  const buscar = async q => ((await gmail.users.messages.list({ userId: 'me', q, maxResults: 25 })).data.messages || []);
  const nums = `(${faltan.join(' OR ')}) has:attachment newer_than:1y`;
  let msgs = dom ? await buscar(`from:${dom[1]} ${nums}`) : [];
  if (!msgs.length) msgs = await buscar(nums);
  let traidos = 0;
  for (const m of msgs) {
    if (m.id === f.gmailId || await db.collection(COL).findOne({ gmailId: m.id })) continue;
    const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
    const h = msg.data.payload.headers || [];
    const asunto = (h.find(x => x.name === 'Subject') || {}).value || '', de = (h.find(x => x.name === 'From') || {}).value || '';
    if (/factura|invoice/i.test(asunto) && !/albar/i.test(asunto)) continue;   // otra factura que cita el mismo nº
    const ids = await ei.comprasDesdeCorreo(m.id, ei.extractAttachments(msg.data.payload), { de, asunto, fecha: new Date(Number(msg.data.internalDate)) }, { silencioso: true });
    traidos += ids.length;
  }
  return { ...(await propuestaCasar(facturaId)), correo: { buscados: faltan.length, correos: msgs.length, traidos } };
}
// Factura que agrupa albaranes de varias obras (Sant Narcís): cada albarán dice su obra. Se propone el
// reparto por obra sumando sus líneas; la obra sale del albarán si está en Compras con obra, o del texto
// de la factura comparado con las obras (referencia, cliente, dirección y alias).
const _STOP = new Set(['obra', 'obras', 'obres', 'carrer', 'calle', 'avinguda', 'avenida', 'pedido', 'girona', 'para', 'desde', 'atic', 'baixos', 'pis', 'piso']);
function _tokens(t) { return norm(t).split(/[^a-z0-9]+/).filter(w => (w.length >= 4 || /^\d{1,4}$/.test(w)) && !_STOP.has(w)); }
function obraDeTexto(obras, texto, ignorar = new Set()) {
  const tk = _tokens(texto).filter(w => !ignorar.has(w)); if (!tk.length) return null;
  const pal = tk.filter(w => !/^\d+$/.test(w)), nums = tk.filter(w => /^\d+$/.test(w));
  const sc = obras.map(o => {
    const t = new Set(_tokens([o.reference, o.clientName, o.address, ...(o.aliases || [])].join(' ')));
    const p = pal.filter(w => t.has(w)).length, n = nums.filter(w => t.has(w)).length;
    return { o, s: p * 2 + n, p };
  }).filter(x => x.p > 0).sort((a, b) => b.s - a.s);
  if (!sc.length || (sc[1] && sc[1].s === sc[0].s)) return null;
  return sc[0].s >= 3 || (sc[0].p >= 1 && !sc[1]) ? sc[0].o : null;
}
async function aprenderAliasObras(reparto) {
  const db = await getDB();
  const obras = await require('./obras').getSelector({ todas: true, conEstudio: true });
  // Palabra que sale en albaranes de obras DISTINTAS (quién lo pidió: «ALEX RINCON») no identifica la obra.
  const obrasDe = {};
  reparto.filter(p => p.texto && p.obraId).forEach(p => new Set(_tokens(p.texto)).forEach(w => { (obrasDe[w] = obrasDe[w] || new Set()).add(String(p.obraId)); }));
  const ignorar = new Set(Object.keys(obrasDe).filter(w => !/^\d+$/.test(w) && obrasDe[w].size >= 2));
  for (const p of reparto) {
    if (!p.texto || !p.obraId) continue;
    const ya = obraDeTexto(obras, p.texto, ignorar);
    if (ya && ya.id === String(p.obraId)) continue;            // ya la reconoce
    const alias = _tokens(p.texto).filter(w => !ignorar.has(w)).join(' ').trim();
    if (alias.length < 4) continue;
    await db.collection('obras').updateOne({ _id: new ObjectId(String(p.obraId)) }, { $addToSet: { aliases: alias } });
  }
}
async function repartoPorAlbaran(facturaId) {
  const db = await getDB();
  const f = await db.collection(COL).findOne({ _id: oid(facturaId), empresaId: EMPRESA });
  if (!f) throw new Error('Compra no encontrada');
  const ls = f.lineas || [];
  if (!ls.some(l => l.albaran || l.obraTexto)) return { grupos: [], sinDatos: true };
  const obras = await require('./obras').getSelector({ todas: true, conEstudio: true });
  const albs = await db.collection(COL).find({ empresaId: EMPRESA, tipo: 'albaran', estado: { $ne: 'descartada' }, obraId: { $ne: null } }).project({ numero: 1, obraId: 1, obraRef: 1, proveedorNorm: 1, proveedor: 1 }).toArray();
  const p1 = prov1(f);
  const grupos = new Map();
  for (const l of ls) {
    const clave = l.obraTexto ? norm(l.obraTexto) : (l.albaran ? 'alb:' + nd(l.albaran) : '_');
    const g = grupos.get(clave) || { albaranes: new Set(), obraTexto: l.obraTexto || null, importe: 0, lineas: 0 };
    if (l.albaran) g.albaranes.add(l.albaran);
    g.importe += Number(l.importe) || 0; g.lineas++;
    grupos.set(clave, g);
  }
  // Lo que sale en casi todos los albaranes (quién lo pidió: «ALEX RINCON») no sirve para saber la obra.
  const textos = [...grupos.values()].filter(g => g.obraTexto).map(g => new Set(_tokens(g.obraTexto)));
  const ignorar = new Set();
  if (textos.length >= 2) { const cuenta = {}; textos.forEach(t => t.forEach(w => { cuenta[w] = (cuenta[w] || 0) + 1; })); Object.entries(cuenta).forEach(([w, n]) => { if (!/^\d+$/.test(w) && n > textos.length / 2) ignorar.add(w); }); }
  const out = [...grupos.values()].map(g => {
    let obra = null, motivo = null;
    const alb = albs.find(a => prov1(a) === p1 && [...g.albaranes].some(n => nd(n) === nd(a.numero)));
    if (alb) { obra = obras.find(o => o.id === String(alb.obraId)) || { id: String(alb.obraId), reference: alb.obraRef }; motivo = `albarán ${alb.numero} en Compras`; }
    if (!obra && g.obraTexto) { obra = obraDeTexto(obras, g.obraTexto, ignorar); if (obra) motivo = 'por el nombre en la factura'; }
    return { albaranes: [...g.albaranes], obraTexto: g.obraTexto, importe: Math.round(g.importe * 100) / 100, lineas: g.lineas, obraId: obra ? obra.id : null, obraRef: obra ? obra.reference : null, motivo };
  });
  // Mismas obras juntas (dos albaranes de la misma obra).
  const junt = [];
  for (const g of out) { const ya = g.obraId && junt.find(x => x.obraId === g.obraId); if (ya) { ya.importe = Math.round((ya.importe + g.importe) * 100) / 100; ya.albaranes.push(...g.albaranes); ya.lineas += g.lineas; ya.obraTexto = [ya.obraTexto, g.obraTexto].filter(Boolean).join(' / '); } else junt.push(g); }
  const suma = Math.round(junt.reduce((a, g) => a + g.importe, 0) * 100) / 100;
  const base = f.base != null ? f.base : f.total;
  return { grupos: junt, suma, base, diferencia: base != null ? Math.round((base - suma) * 100) / 100 : null };
}
// Para «Clasificar facturas» (facturas de StelOrder): la clasificación que ya tiene su gemela en Compras.
// Misma factura = mismo nº del proveedor (≥4 cifras) y total parecido, o mismo total ±2 cént. a ≤7 días.
async function clasificacionesParaStel() {
  const db = await getDB();
  const cs = await db.collection(COL).find({ empresaId: EMPRESA, estado: 'revisada', tipo: { $in: ['factura', 'ticket', 'devolucion'] }, duplicadoDe: null })
    .project({ numero: 1, total: 1, fecha: 1, destino: 1, obraId: 1, obraRef: 1, reparto: 1, categoria: 1, varias: 1, proveedor: 1, razonSocial: 1 }).toArray();
  const dig = x => String(x || '').replace(/\D/g, '').replace(/^0+/, '');
  const porNum = new Map(); cs.forEach(c => { const d = dig(c.numero); if (d.length >= 4) (porNum.get(d) || porNum.set(d, []).get(d)).push(c); });
  const dias = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000);
  return f => {
    const d = dig(f.extraReference);
    const tot = Number(f.total) || 0;
    let c = d.length >= 4 ? (porNum.get(d) || []).find(x => x.total == null || Math.abs(Math.abs(x.total) - Math.abs(tot)) < 1) : null;
    // Sin nº: mismo importe, fechas cercanas Y algún nombre en común (si no, dos compras de 100 € se cruzarían).
    const comun = x => { const w = new Set(_pal(f.supplier)); return [..._pal(x.proveedor), ..._pal(x.razonSocial)].some(p => w.has(p)); };
    if (!c && f.date) c = cs.find(x => x.total != null && Math.abs(x.total - tot) < 0.02 && x.fecha && dias(x.fecha, String(f.date).slice(0, 10)) <= 7 && comun(x));
    if (!c) return null;
    const dest = c.destino || (c.varias ? 'varias' : 'obra');
    if (dest === 'obra' && c.obraId) return { tipo: 'obra', fuente: 'compras', obraId: c.obraId, obraRef: c.obraRef || '', categoria: null, compraId: String(c._id) };
    if (dest === 'varias' || (dest === 'lineas' && (c.reparto || []).length)) return { tipo: 'obra', fuente: 'compras', reparto: true, obraRef: (c.reparto || []).map(p => p.obraRef).filter(Boolean).join(' + ') || 'Varias obras', compraId: String(c._id) };
    return { tipo: 'general', fuente: 'compras', categoria: c.categoria || dest, compraId: String(c._id) };
  };
}
// Regla por proveedor (las que se ponían en «Clasificar facturas»: «este proveedor siempre es gasto general
// · gestoría» u «obra X»). Se casa por el nombre (razón social o comercial) con el de la regla de StelOrder.
const _GEN = new Set(['sociedad', 'limitada', 'girona', 'barcelona', 'espana', 'grupo', 'comercial', 'serveis', 'servicios', 'materials', 'materiales', 'distribucions', 'distribuciones']);
const _pal = t => norm(t).replace(/\b(s\.?\s?l\.?u?|s\.?\s?a\.?u?|slu|sau)\b/g, ' ').split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !_GEN.has(w) && !['del', 'les', 'els', 'los', 'las'].includes(w));
async function reglaProveedorDe(compraId) {
  const db = await getDB();
  const c = await db.collection(COL).findOne({ _id: oid(compraId), empresaId: EMPRESA }, { projection: { proveedor: 1, razonSocial: 1 } });
  if (!c || !(c.proveedor || c.razonSocial)) return null;
  const reglas = await db.collection('reglaProveedor').find({}).toArray();
  // Todas las palabras del nombre (comercial o razón social) tienen que estar en el de la regla:
  // «Obramat» ⊂ «BRICOMAN (OBRAMAT GIRONA)», pero «Pintures Vic» no es «Pintures Sant Narcís».
  const nombres = [_pal(c.proveedor), _pal(c.razonSocial)].filter(w => w.length);
  const sc = reglas.map(r => { const w = new Set(_pal(r.supplier)); const n = Math.max(0, ...nombres.map(ns => ns.every(x => w.has(x)) ? ns.length : 0)); return { r, n }; })
    .filter(x => x.n >= 1).sort((a, b) => b.n - a.n);
  if (!sc.length || (sc[1] && sc[1].n === sc[0].n)) return null;
  const r = sc[0].r;
  if (!r.obraId && !r.obraRef && !r.categoria) return null;
  return { proveedor: r.supplier || '', obraId: r.obraId || null, obraRef: r.obraRef || '', categoria: r.categoria || null };
}
async function casar(facturaId, albaranIds, por) {
  const db = await getDB();
  const f = await db.collection(COL).findOne({ _id: oid(facturaId), empresaId: EMPRESA });
  if (!f || f.tipo !== 'factura') throw new Error('Solo se casan facturas');
  const ids = (Array.isArray(albaranIds) ? albaranIds : []).map(String).filter(Boolean);
  // Se sueltan los que ya estaban y no vienen; se enganchan los nuevos.
  await db.collection(COL).updateMany({ empresaId: EMPRESA, facturaId: String(f._id), _id: { $nin: ids.map(oid) } }, { $set: { facturaId: null, facturaNumero: null, casadaAt: null, updatedAt: new Date() } });
  const albs = ids.length ? await db.collection(COL).find({ empresaId: EMPRESA, _id: { $in: ids.map(oid) }, tipo: 'albaran', estado: { $ne: 'descartada' } }).project({ lineas: 0 }).toArray() : [];
  const otroProv = albs.filter(a => prov1(a) !== prov1(f));
  if (otroProv.length) throw new Error(`Hay albaranes de otro proveedor (${otroProv.map(a => a.numero || a.proveedor).join(', ')})`);
  const ocupados = albs.filter(a => a.facturaId && String(a.facturaId) !== String(f._id));
  if (ocupados.length) throw new Error(`Ya casados con otra factura: ${ocupados.map(a => a.numero).join(', ')}`);
  const now = new Date();
  if (albs.length) await db.collection(COL).updateMany({ _id: { $in: albs.map(a => a._id) } }, { $set: { facturaId: String(f._id), facturaNumero: f.numero || null, casadaAt: now, casadaPor: por || '', updatedAt: now } });
  const suma = Math.round(albs.reduce((x, a) => x + (a.base != null ? a.base : (a.total || 0)), 0) * 100) / 100;
  const base = f.base != null ? f.base : f.total;
  const casado = albs.length ? { n: albs.length, suma, diferencia: base != null ? Math.round((base - suma) * 100) / 100 : null, at: now, por: por || '', albaranes: albs.map(a => ({ id: String(a._id), numero: a.numero, importe: a.base != null ? a.base : a.total, obraRef: a.obraRef || null })) } : null;
  await db.collection(COL).updateOne({ _id: f._id }, { $set: { casado, updatedAt: now } });
  return getCompra(facturaId);
}
async function descasar(facturaId) { return casar(facturaId, [], ''); }
// Albaranes confirmados que ninguna factura ha recogido todavía, por proveedor y antigüedad.
async function albaranesSinFactura({ diasMin = 0 } = {}) {
  const db = await getDB();
  const arr = await db.collection(COL).find({ empresaId: EMPRESA, tipo: 'albaran', estado: 'revisada', facturaId: { $in: [null] } }).project({ lineas: 0 }).sort({ fecha: 1 }).toArray();
  const hoy = Date.now(); const out = {};
  for (const a of arr) {
    const fe = a.fecha || (a.createdAt && a.createdAt.toISOString().slice(0, 10)); const dias = fe ? Math.floor((hoy - new Date(fe).getTime()) / 86400000) : 0;
    if (dias < diasMin) continue;
    const k = a.proveedorNorm || 'sin proveedor';
    (out[k] = out[k] || { proveedor: a.proveedor || 'Sin proveedor', n: 0, importe: 0, sinImporte: 0, masAntiguo: null, albaranes: [] });
    const imp = a.base != null ? a.base : a.total;
    out[k].n++; if (imp != null) out[k].importe += imp; else out[k].sinImporte++;
    out[k].masAntiguo = out[k].masAntiguo == null ? dias : Math.max(out[k].masAntiguo, dias);
    out[k].albaranes.push({ id: String(a._id), numero: a.numero, fecha: fe, dias, importe: imp, obraRef: a.obraRef || ((a.reparto || []).length ? a.reparto.map(p => p.obraRef).join(' + ') : null) });
  }
  return Object.values(out).map(p => ({ ...p, importe: Math.round(p.importe * 100) / 100 })).sort((a, b) => b.masAntiguo - a.masAntiguo);
}
// Día 1 de cada mes: albaranes de más de 35 días sin factura → oficina (push + WhatsApp).
async function avisoAlbaranesSinFactura({ dryRun = false, diasMin = 35 } = {}) {
  const lista = await albaranesSinFactura({ diasMin });
  if (!lista.length) return { pendientes: 0, enviado: false };
  const n = lista.reduce((a, p) => a + p.n, 0);
  const texto = `📄 *Albaranes sin factura (${n})* — más de ${diasMin} días:\n` + lista.slice(0, 10).map(p => `• ${p.proveedor}: ${p.n} ${p.n === 1 ? 'albarán' : 'albaranes'}${p.importe ? ' · ' + p.importe.toFixed(2) + ' €' : ''} · el más antiguo hace ${p.masAntiguo} días`).join('\n') + `\n\nReclama la factura o cásalos en https://dashboard.corpprojects.es/compras`;
  if (dryRun) return { pendientes: n, texto, lista };
  const to = String(process.env.FICHAJE_AVISOS_TO || process.env.WHATSAPP_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  let ok = 0; for (const t of to) { try { await require('./notifications').sendWhatsAppTo(t, texto); ok++; } catch (e) {} }
  try { await require('./push').sendToOficina({ title: `📄 ${n} albaranes sin factura`, body: lista.slice(0, 3).map(p => `${p.proveedor} (${p.n})`).join(' · '), url: '/compras', tag: 'albaranes-sin-factura' }); } catch (e) {}
  return { pendientes: n, enviado: ok > 0 };
}

// ── RESUMEN POR PROVEEDOR (4.4) ─────────────────────────────────
async function resumenProveedores({ desde, hasta } = {}) {
  const db = await getDB();
  const q = { empresaId: EMPRESA, estado: 'revisada' };
  if (desde || hasta) { q.fecha = {}; if (desde) q.fecha.$gte = desde; if (hasta) q.fecha.$lte = hasta; }
  const arr = await db.collection(COL).find(q).project({ lineas: 0 }).toArray();
  const out = {};
  for (const c of arr) {
    const k = c.proveedorNorm || 'sinproveedor';
    const p = (out[k] = out[k] || { proveedor: c.proveedor || 'Sin proveedor', razonSocial: null, nif: null, n: 0, facturas: 0, albaranes: 0, tickets: 0, devoluciones: 0, total: 0, albaranesSinFactura: 0, ultimo: null });
    if (c.razonSocial) p.razonSocial = c.razonSocial; if (c.nif) p.nif = c.nif;
    p.n++; p[{ factura: 'facturas', albaran: 'albaranes', ticket: 'tickets', devolucion: 'devoluciones' }[c.tipo] || 'n'] += (c.tipo in { factura: 1, albaran: 1, ticket: 1, devolucion: 1 }) ? 1 : 0;
    // Total sin contar dos veces: factura casada no suma (suman sus albaranes); albarán no casado suma si tiene importe
    const imp = c.base != null ? c.base : (c.total != null ? c.total : 0);
    if (!(c.tipo === 'factura' && c.casado && c.casado.n > 0)) p.total += imp;
    if (c.tipo === 'albaran' && !c.facturaId) p.albaranesSinFactura++;
    const fe = c.fecha || (c.createdAt && c.createdAt.toISOString().slice(0, 10)); if (fe && (!p.ultimo || fe > p.ultimo)) p.ultimo = fe;
  }
  return Object.values(out).map(p => ({ ...p, total: Math.round(p.total * 100) / 100 })).sort((a, b) => b.total - a.total);
}

// ── PRECIOS POR TIENDA ───────────────────────────────────────────
// Qué nos ha costado un material en cada proveedor, según las compras CONFIRMADAS
// (albaranes incluidos si traen precio). Lo usa el bot ("cuánto nos costó…") y /compras.
async function buscarPrecios(material, proveedor, { limit = 30 } = {}) {
  const mat = norm(material); if (mat.length < 2) return [];
  const palabras = mat.split(' ').filter(w => w.length >= 3);
  const db = await getDB();
  const q = { empresaId: EMPRESA, estado: 'revisada', 'lineas.0': { $exists: true } };
  if (proveedor) q.proveedorNorm = { $regex: norm(proveedor).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };
  const cs = await db.collection(COL).find(q).project({ lineas: 1, proveedor: 1, numero: 1, fecha: 1, tipo: 1, createdAt: 1 }).sort({ fecha: -1 }).limit(600).toArray();
  const hits = [];
  for (const c of cs) for (const l of (c.lineas || [])) {
    const n = norm(l.descripcion); if (!n) continue;
    if (!(n.includes(mat) || (palabras.length && palabras.every(w => n.includes(w))))) continue;
    let unit = l.precio, total = l.importe; const units = l.cantidad || null;
    if (unit == null && total != null && units) unit = Math.round(total / units * 10000) / 10000;
    if (total == null && unit != null && units) total = Math.round(unit * units * 100) / 100;
    if (unit == null && total == null) continue;
    hits.push({ fuente: 'compras', compraId: String(c._id), tipo: c.tipo, fpr: c.numero || '', supplier: c.proveedor || '', date: c.fecha || (c.createdAt && c.createdAt.toISOString().slice(0, 10)), itemName: l.descripcion, units, unit, total });
  }
  return hits.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, limit);
}

// ── RESUMEN DE LAS 18:00 (WhatsApp a oficina solo si queda algo por revisar) ──
async function resumenPendientes({ dryRun = false } = {}) {
  const db = await getDB();
  const pend = await db.collection(COL).find({ empresaId: EMPRESA, estado: 'por_revisar' }).sort({ createdAt: 1 }).toArray();
  if (!pend.length) return { pendientes: 0, enviado: false };
  const lineas = pend.slice(0, 12).map(c => `• ${TIPO_TXT[c.tipo]}${c.proveedor ? ' ' + c.proveedor : ''}${c.numero ? ' nº ' + c.numero : ''} — ${c.obraRef || (c.destino && c.destino !== 'obra' ? DESTINO_TXT[c.destino] : null) || (c.varias ? 'varias obras' : 'sin obra')}${c.paraWorker ? ' para ' + c.paraWorker.name : ''} (${(c.subidaPor && c.subidaPor.name) || '?'})`);
  const texto = `🧾 *Compras por revisar: ${pend.length}*\n${lineas.join('\n')}${pend.length > 12 ? `\n… y ${pend.length - 12} más` : ''}\n\nRevísalas en https://dashboard.corpprojects.es/compras`;
  if (dryRun) return { pendientes: pend.length, texto };
  const to = String(process.env.FICHAJE_AVISOS_TO || process.env.WHATSAPP_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  let ok = 0;
  for (const t of to) { try { await require('./notifications').sendWhatsAppTo(t, texto); ok++; } catch (e) {} }
  try { await require('./push').sendToOficina({ title: `🧾 ${pend.length} compra(s) por revisar`, body: 'Quedan compras del día sin revisar.', url: '/compras', tag: 'compras-pendientes' }); } catch (e) {}
  return { pendientes: pend.length, enviado: ok > 0 };
}

module.exports = { subidaMasiva, estadoMasiva, _unaMasiva, _gemelaTicket, _partirPdf, propuestaLineas, _repartoDeLineas, separarFoto, n2, nCant, TIPOS, TIPO_TXT, DESTINOS, DESTINO_TXT, buscarPrecios, deObra, resumenProveedores, propuestaCasar, albaranesDelCorreo, repartoPorAlbaran, obraDeTexto, _aprenderAliasObras: aprenderAliasObras, clasificacionesParaStel, reglaProveedorDe, casar, descasar, albaranesSinFactura, avisoAlbaranesSinFactura, crear, getFoto, fotosDe, lista, getCompra, mias, contarPendientes, editar, releer, revisar, descartar, reabrir, resumenPendientes, resumenParaTrabajador, _leerConIA: leerConIA, _aplicarLectura: aplicarLectura, _norm: norm };
