// compras.js — COMPRAS POR FOTO (Paso 4 de "la obra es una carpeta").
//
// El trabajador fotografía lo que compra (albarán, factura, ticket, devolución), elige
// la obra y lo envía. La IA lee el documento al momento; oficina lo revisa en una cola y
// lo confirma. Un documento = un registro en `compras`; sus fotos en `comprasFotos`.
//
//   compra = {
//     empresaId, estado: por_revisar | revisada | descartada,
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
const DESTINOS = ['obra', 'varias', 'herramientas', 'ropa', 'almacen', 'general'];
const DESTINO_TXT = { obra: 'Obra', varias: 'Varias obras', herramientas: 'Herramientas', ropa: 'Ropa de trabajo', almacen: 'Stock de almacén', general: 'Gasto general' };
function limpiarWorker(w) { if (!w || !w.id) return null; return { id: String(w.id), name: String(w.name || '').trim().slice(0, 80) }; }

async function getDB() { return require('./db').getDB(); }
const oid = id => { try { return new ObjectId(String(id)); } catch (e) { throw new Error('Compra no encontrada'); } };
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\b(s\.?l\.?u?|s\.?a\.?u?|s\.?c\.?p\.?|sl|sa)\b\.?/g, '').replace(/[^a-z0-9ñç]+/g, ' ').trim();
const n2 = v => { const n = Number(String(v ?? '').replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
const num = v => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };

// ── LECTURA CON IA ───────────────────────────────────────────────
const PROMPT = `Eres el administrativo de una empresa de reformas en Girona. Te paso la(s) foto(s) de UN documento de compra de material (albarán de entrega, factura, ticket de caja o abono/devolución). Devuelve SOLO un JSON con esta forma exacta, sin texto alrededor:
{
 "calidad": "legible" | "borroso" | "cortado" | "no_es_documento",
 "tipo": "albaran" | "factura" | "ticket" | "devolucion" | "otro",
 "proveedor": "nombre comercial del proveedor (Saltoki, Leroy Merlin, Obramat…)", "razonSocial": "razón social completa tal cual aparece (p. ej. Obramat S.L.U.) o null", "nif": "CIF/NIF del proveedor o null",
 "numero": "número del documento tal cual aparece, o null", "fecha": "YYYY-MM-DD o null",
 "base": número o null, "iva": número o null, "total": número o null,
 "lineas": [{"descripcion": "texto de la línea", "cantidad": número o null, "unidad": "ud|m|m2|kg|saco|caja|…", "precio": número o null, "importe": número o null, "talla": "talla si es ropa (M, L, 42…) o null"}],
 "albaranesRef": ["números de albarán que cite una FACTURA (si es una factura que agrupa albaranes), si no []"],
 "obraPista": "texto del documento que parezca referirse a una obra o dirección de entrega, o null",
 "confianza": 0-1,
 "aviso": "una frase corta en español si hay algo que oficina deba mirar (importe ilegible, falta una página, es un presupuesto y no una compra…), o null"
}
Reglas: "albaran" = entrega de material SIN importes totales o con la palabra albarán/entrega; "factura" = lleva la palabra factura y desglose de IVA; "ticket" = ticket de caja/TPV; "devolucion" = abono, devolución o importes negativos (pon los importes en NEGATIVO). Números con formato español (1.234,56) → 1234.56. Si no es un documento de compra, calidad="no_es_documento". No inventes: lo que no se lea, null.`;

function parseJsonLoose(raw) {
  const s = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i < 0 || j < 0) throw new Error('La IA no devolvió JSON');
  return JSON.parse(s.slice(i, j + 1));
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
  content.push({ type: 'text', text: PROMPT });
  const modelo = CONFIG.ia.vision;
  let raw = '';
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 60000);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: c.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: modelo, max_tokens: 2500, messages: [{ role: 'user', content }] }),
    }).finally(() => clearTimeout(t));
    const data = await r.json();
    if (!r.ok) throw new Error(`API ${r.status}: ${JSON.stringify(data).slice(0, 160)}`);
    raw = (data.content || []).map(b => b.text || '').join('');
    const j = parseJsonLoose(raw);
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
  if (doc.gmailId) { const e = await db.collection(COL).findOne({ empresaId: EMPRESA, gmailId: doc.gmailId, _id: { $ne: doc._id } }, { projection: { _id: 1 } }); if (e) return String(e._id); }
  if (doc._id) q._id = { $ne: doc._id };
  const d = await db.collection(COL).findOne(q, { projection: { _id: 1 } });
  return d ? String(d._id) : null;
}

// ── ALTA (trabajador u oficina) ──────────────────────────────────
// fotos: [{data: Buffer, mimetype}]. Devuelve lo que se le confirma al que la sube.
async function crear({ fotos, obraId, varias, destino, paraWorker, nota, subidaPor, origen, gmailId, email }) {
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
    empresaId: EMPRESA, estado: 'por_revisar', tipo: 'otro', destino: dest, paraWorker: pw,
    proveedor: null, proveedorNorm: null, nif: null, numero: null, fecha: null, base: null, iva: null, total: null, lineas: [], albaranesRef: [], obraPista: null,
    obraId: obraId ? String(obraId) : null, obraRef: obraId ? obraRef : null, varias: !!varias, reparto: [], categoria: dest === 'herramientas' ? 'herramientas' : dest === 'ropa' ? 'ropa' : null,
    nota: String(nota || '').trim().slice(0, 300) || null, subidaPor: subidaPor || null, nFotos: fotos.length,
    origen: origen || 'app', gmailId: gmailId || null, email: email || null,   // 'email' = llegó al correo (n8n ya la manda a StelOrder)
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
  doc.duplicadoDe = await buscarDuplicado(db, doc);
  doc.updatedAt = new Date();
  const { _id, ...set } = doc;
  await db.collection(COL).updateOne({ _id }, { $set: set });

  // Aviso a oficina (push al momento; el WhatsApp va en el resumen de las 18:00)
  try {
    const quien = origen === 'email' ? 'el correo' : ((subidaPor && subidaPor.name) || 'Alguien');
    const que = doc.ia.ok ? `${TIPO_TXT[doc.tipo]}${doc.proveedor ? ' de ' + doc.proveedor : ''}${doc.numero ? ' nº ' + doc.numero : ''}` : 'un documento (la IA no pudo leerlo)';
    await require('./push').sendToOficina({ title: origen === 'email' ? '📧 Factura llegada por correo' : `📸 Compra de ${quien}`, body: `${que}${doc.obraRef ? ' · ' + doc.obraRef : dest === 'varias' ? ' · para varias obras' : dest === 'herramientas' || dest === 'ropa' ? ' · ' + DESTINO_TXT[dest].toLowerCase() + (pw ? ' para ' + pw.name : ' (queda en oficina)') : dest === 'general' ? ' · gasto general' : ''}. Por revisar.`, url: '/compras', tag: 'compra-nueva' });
  } catch (e) {}
  return { ok: true, id: String(doc._id), ...resumenParaTrabajador(doc) };
}
// Lo que ve quien la sube: tipo, proveedor, número, nº de líneas y calidad. SIN importes.
function resumenParaTrabajador(c) {
  const r = { id: String(c._id), estado: c.estado, tipo: c.tipo, tipoTxt: TIPO_TXT[c.tipo] || 'Documento', proveedor: c.proveedor, numero: c.numero, fecha: c.fecha, nLineas: (c.lineas || []).length, obraRef: c.obraRef, varias: !!c.varias, destino: c.destino || (c.varias ? 'varias' : 'obra'), destinoTxt: DESTINO_TXT[c.destino] || (c.varias ? 'Varias obras' : 'Obra'), paraWorker: c.paraWorker || null, nFotos: c.nFotos, createdAt: c.createdAt, leida: !!(c.ia && c.ia.ok), calidad: c.ia && c.ia.calidad || null, duplicado: !!c.duplicadoDe };
  // Mensaje para la pantalla del móvil
  if (!r.leida) r.mensaje = 'Guardada. La IA no ha podido leerla ahora; oficina la revisará a mano.';
  else if (r.calidad === 'no_es_documento') r.mensaje = 'No parece un albarán ni una factura. Si lo es, repite la foto más de cerca.';
  else if (r.calidad === 'borroso' || r.calidad === 'cortado') r.mensaje = `Guardada, pero la foto sale ${r.calidad === 'borroso' ? 'borrosa' : 'cortada'}. Si puedes, repítela con más luz y el papel entero.`;
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
  if ('lineas' in data && Array.isArray(data.lineas)) set.lineas = data.lineas.slice(0, 120).map(l => ({ descripcion: String(l.descripcion || '').trim().slice(0, 200), cantidad: n2(l.cantidad), unidad: String(l.unidad || '').trim().slice(0, 12) || null, precio: n2(l.precio), importe: n2(l.importe), talla: String(l.talla || '').trim().slice(0, 12) || null })).filter(l => l.descripcion);
  if ('albaranesRef' in data) set.albaranesRef = (Array.isArray(data.albaranesRef) ? data.albaranesRef : String(data.albaranesRef || '').split(/[,\s;]+/)).map(x => String(x).trim()).filter(Boolean).slice(0, 60);
  if ('nota' in data) set.nota = String(data.nota || '').trim().slice(0, 300) || null;
  if ('categoria' in data) set.categoria = data.categoria ? String(data.categoria).trim().toLowerCase() : null;
  if ('destino' in data) { if (!DESTINOS.includes(data.destino)) throw new Error('Destino no válido'); set.destino = data.destino; }
  if ('paraWorker' in data) set.paraWorker = limpiarWorker(data.paraWorker);
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
        if (o) set.reparto.push({ obraId: String(o._id), obraRef: o.reference || '', importe: n2(p.importe) });
      }
    } else {
      const unico = rep.length === 1 ? rep[0].obraId : data.obraId;
      set.reparto = []; set.varias = false; set.obraId = null; set.obraRef = null;
      if (unico) { const o = await db.collection('obras').findOne({ _id: new ObjectId(String(unico)) }, { projection: { reference: 1 } }); if (o) { set.obraId = String(o._id); set.obraRef = o.reference || ''; } }
    }
  }
  if (por) set.editadaPor = por;
  await db.collection(COL).updateOne({ _id: c._id }, { $set: set });
  const dup = await buscarDuplicado(db, { ...c, ...set, _id: c._id });
  await db.collection(COL).updateOne({ _id: c._id }, { $set: { duplicadoDe: dup } });
  return getCompra(id);
}
async function releer(id) {
  const db = await getDB();
  const c = await db.collection(COL).findOne({ _id: oid(id), empresaId: EMPRESA });
  if (!c) throw new Error('Compra no encontrada');
  const fotos = await fotosDe(id);
  const lec = await leerConIA(fotos.map(f => ({ data: f.data.buffer ? Buffer.from(f.data.buffer) : f.data, mimetype: f.mimetype })));
  if (!lec.ok) throw new Error('La IA no ha podido leerla: ' + lec.error);
  const doc = aplicarLectura({}, lec.datos);
  doc.ia = { ok: true, calidad: lec.datos.calidad || 'legible', confianza: num(lec.datos.confianza), aviso: String(lec.datos.aviso || '').trim().slice(0, 200) || null, modelo: lec.modelo, releidaAt: new Date() };
  doc.updatedAt = new Date();
  await db.collection(COL).updateOne({ _id: c._id }, { $set: doc });
  const dup = await buscarDuplicado(db, { ...c, ...doc, _id: c._id });
  await db.collection(COL).updateOne({ _id: c._id }, { $set: { duplicadoDe: dup } });
  return getCompra(id);
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
  if (dest === 'general' && !c.categoria) throw new Error('Pon la categoría del gasto general');
  if (dest === 'almacen' && !(Array.isArray(almacen) && almacen.length) && !(c.almacenCreado || []).length) throw new Error('Marca qué líneas entran en el almacén');
  const set = { estado: 'revisada', revisadaPor: por || '', revisadaAt: new Date(), updatedAt: new Date() };
  // ALMACÉN: cada línea marcada entra como existencias (se agrupa por nombre; precio medio).
  if (dest === 'almacen' && Array.isArray(almacen) && almacen.length && !(c.almacenCreado || []).length) {
    const alm = require('./almacen'); const creado = [];
    for (const l of almacen.slice(0, 60)) {
      try {
        const q = Math.max(0, Number(l.cantidad) || 0); if (!q) continue;
        const total = Math.abs(Number(l.valor) || 0);
        const r = await alm.entrada({ nombre: l.nombre, unidad: l.unidad || 'ud', cantidad: q, precioUd: Number(l.valorEsTotal) ? total / q : total, recogida: !!l.recogida, compraId: String(c._id), proveedor: c.proveedor, fecha: c.fecha, by: por });
        creado.push({ id: r.id, nombre: r.nombre, cantidad: q });
      } catch (e) { console.warn('[Compras] almacén:', e.message); }
    }
    set.almacenCreado = creado;
  }
  // HERRAMIENTAS y ROPA: cada línea marcada se da de alta en Llaves y herramientas. Si hay un
  // trabajador, se le ENTREGA (queda en su historial); si no, se queda en OFICINA para
  // repartirla más adelante desde Llaves y herramientas.
  // Si ya se dieron de alta (se reabrió y se vuelve a confirmar), no se duplican.
  if ((dest === 'herramientas' || dest === 'ropa') && Array.isArray(herramientas) && herramientas.length && !(c.activosCreados || []).length) {
    const act = require('./activos'); const creadas = [];
    // Una unidad por cada cantidad de la línea ("4 × pantalón" → 4 prendas), tope 30 por línea.
    let total = 0;
    for (const h of herramientas.slice(0, 40)) {
      const nombre = String(h.nombre || '').trim(); if (!nombre) continue;
      const n = Math.min(30, Math.max(1, Math.round(Number(h.cantidad) || 1)));
      const valorUd = Math.abs(Number(h.valor) || 0) / (Number(h.valorEsTotal) ? n : 1);
      for (let i = 0; i < n && total < 60; i++, total++) {
        try {
          const r = await act.crearActivo({ tipo: dest === 'ropa' ? 'ropa' : 'herramienta', nombre, talla: h.talla || '', marca: h.marca || '', modelo: h.modelo || '', valor: Math.round(valorUd * 100) / 100, fechaCompra: c.fecha || new Date().toISOString().slice(0, 10), notas: `Compra ${c.proveedor || ''}${c.numero ? ' nº ' + c.numero : ''}${n > 1 ? ` (${i + 1} de ${n})` : ''} (foto en Compras)` }, por);
          if (c.paraWorker && c.paraWorker.id) await act.darActivo(r.id, { holderType: 'operario', holderId: c.paraWorker.id, holderName: c.paraWorker.name, nota: 'Entregada al comprarla' }, por);
          creadas.push({ id: r.id, codigo: r.codigo, nombre: nombre + (h.talla ? ' ' + h.talla : '') });
        } catch (e) { console.warn('[Compras] alta:', e.message); }
      }
    }
    set.activosCreados = creadas;
  }
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
      const obraRef = dest === 'obra' ? c.obraRef : dest === 'varias' ? (c.reparto || []).map(p => p.obraRef).join(' + ') : null;
      const catGasto = c.categoria || ({ herramientas: 'herramientas', ropa: 'ropa', almacen: 'material' })[dest] || null;
      const r = await fw.reenviarFacturaMail({ attachments, obraRef, obraId: c.obraId || null, origen: 'compras', from: por || 'oficina', nota: [c.proveedor, c.numero ? 'nº ' + c.numero : null, c.total != null ? c.total + ' €' : null, (dest === 'herramientas' || dest === 'ropa') ? DESTINO_TXT[dest] + (c.paraWorker ? ' para ' + c.paraWorker.name : ' (stock en oficina)') : null].filter(Boolean).join(' · '), categoria: !obraRef ? catGasto : null });
      set.enviadaStel = { ok: !!r.ok, at: new Date(), detalle: r.reply || null };
    } catch (e) { set.enviadaStel = { ok: false, at: new Date(), detalle: e.message }; }
  }
  await db.collection(COL).updateOne({ _id: c._id }, { $set: set });
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

module.exports = { TIPOS, TIPO_TXT, DESTINOS, DESTINO_TXT, buscarPrecios, crear, getFoto, fotosDe, lista, getCompra, mias, contarPendientes, editar, releer, revisar, descartar, reabrir, resumenPendientes, resumenParaTrabajador, _leerConIA: leerConIA, _aplicarLectura: aplicarLectura, _norm: norm };
