// src/obras.js — Módulo de obras y rentabilidad
const { MongoClient, ObjectId } = require('mongodb');

let db = null;

async function getDB() {
  return require('./db').getDB();
}

const ESTADOS_OBRA = {
  activa:     { label: 'En curso',    color: '#22c487', emoji: '🏗️' },
  pausada:    { label: 'Pausada',     color: '#f59e0b', emoji: '⏸️' },
  terminada:  { label: 'Terminada',   color: '#4d9cf8', emoji: '✅' },
  facturada:  { label: 'Facturada',   color: '#a78bfa', emoji: '💰' },
};

// ── CLASIFICACIÓN DE FACTURAS DE PROVEEDOR ───────────────────────
// Cada factura se clasifica con DOS ejes independientes:
//   · obra     → si está ligada a una obra concreta, cuenta en SU rentabilidad.
//   · categoria→ etiqueta del gasto (material, combustible, herramientas…).
// Combinaciones:
//   · obra (+ categoría opcional)  → cuenta en la obra (p.ej. combustible de la obra X).
//   · solo categoría (sin obra)    → gasto general (no cuenta en obras).
//   · nada                         → sin clasificar (pendiente).
// Prioridad al resolver: (1) clasificación explícita por factura > (2) regla por
// proveedor > (3) marcador "[obra: {ref}]" de n8n > (4) sin clasificar. Las reglas
// se aplican en LECTURA: clasifican al vuelo todas las facturas de ese proveedor,
// sin escribir cientos de registros, y cambiarlas actualiza pasado y futuro.
const CATEGORIAS_GASTO = ['material', 'combustible', 'herramientas', 'subcontrata', 'gestoria', 'seguros', 'suministros', 'alquiler', 'otros'];

function extraerObraMarcador(text) {
  const m = String(text || '').match(/obra:\s*([^\]\n|·]+)/i);
  return m ? m[1].trim() : '';
}
async function getAsignacionesFacturaMap(dbArg) {
  const database = dbArg || await getDB();
  const arr = await database.collection('facturaObraAsignada').find({}).toArray();
  const map = new Map();
  arr.forEach(a => map.set(String(a.stelInvoiceId), a));
  return map;
}
async function getReglasMap(dbArg) {
  const database = dbArg || await getDB();
  const arr = await database.collection('reglaProveedor').find({}).toArray();
  const map = new Map();
  arr.forEach(r => map.set(String(r.supplierId), r));
  return map;
}
// Normaliza un registro de clasificación (o null si no clasifica nada).
// tipo se DERIVA: 'obra' si hay obra, 'general' si solo hay categoría.
function _normClasif(rec, fuente) {
  if (!rec) return null;
  const obraId = rec.obraId || null;
  const obraRef = rec.obraRef || '';
  const categoria = rec.categoria || null;
  if (!obraId && !obraRef && !categoria) return null;
  return { tipo: (obraId || obraRef) ? 'obra' : 'general', fuente, obraId, obraRef, categoria };
}
// Resuelve la clasificación efectiva de una factura (o null si sin clasificar).
function resolverFacturaObra(f, asignMap, reglaMap) {
  const rec = asignMap && asignMap.get(String(f.id));
  if (rec && Array.isArray(rec.repartos) && rec.repartos.length) {
    const n = rec.repartos.length;
    return { tipo: 'obra', fuente: 'reparto', obraId: null, obraRef: `repartida (${n} obra${n > 1 ? 's' : ''})`, categoria: null, reparto: true };
  }
  const a = _normClasif(rec, 'manual');
  if (a) return a;
  const r = _normClasif(reglaMap && reglaMap.get(String(f.supplierId || '')), 'regla');
  if (r) return r;
  const marca = extraerObraMarcador(`${f.title || ''} ${f.extraReference || ''}`);
  if (marca) return { tipo: 'obra', fuente: 'n8n', obraId: null, obraRef: marca, categoria: null };
  return null;
}
function _validarClasif({ obraId, obraRef, categoria }) {
  if (!obraId && !obraRef && !categoria) throw new Error('Indica una obra o una categoría');
}
async function clasificarFactura(stelInvoiceId, { obraId, obraRef, categoria, by } = {}) {
  if (!stelInvoiceId) throw new Error('Falta la factura');
  _validarClasif({ obraId, obraRef, categoria });
  const database = await getDB();
  await database.collection('facturaObraAsignada').updateOne(
    { stelInvoiceId: String(stelInvoiceId) },
    { $set: {
        stelInvoiceId: String(stelInvoiceId),
        obraId:    obraId ? String(obraId) : null,
        obraRef:   obraRef || '',
        categoria: categoria || null,
        repartos:  [],   // una asignación simple anula el reparto
        by:        by || '',
        ts:        new Date(),
    } },
    { upsert: true }
  );
  return { ok: true };
}

// Reparto: asigna a la obra SOLO una parte del importe de la factura (para
// facturas de varias obras, o para excluir ítems regalados). Una misma factura
// puede repartirse entre varias obras. El reparto anula la asignación simple.
async function repartirFactura(stelInvoiceId, { obraId, obraRef, importe, by } = {}) {
  if (!stelInvoiceId) throw new Error('Falta la factura');
  if (!obraId) throw new Error('Falta la obra');
  const imp = Number(importe);
  if (!Number.isFinite(imp) || imp <= 0) throw new Error('Importe no válido');
  const database = await getDB();
  const rec = await database.collection('facturaObraAsignada').findOne({ stelInvoiceId: String(stelInvoiceId) });
  const repartos = ((rec && Array.isArray(rec.repartos)) ? rec.repartos : []).filter(p => String(p.obraId) !== String(obraId));
  repartos.push({ obraId: String(obraId), obraRef: obraRef || '', importe: Math.round(imp * 100) / 100 });
  await database.collection('facturaObraAsignada').updateOne(
    { stelInvoiceId: String(stelInvoiceId) },
    { $set: { stelInvoiceId: String(stelInvoiceId), repartos, obraId: null, obraRef: '', categoria: null, by: by || '', ts: new Date() } },
    { upsert: true }
  );
  return { ok: true };
}
async function quitarReparto(stelInvoiceId, obraId) {
  const database = await getDB();
  const rec = await database.collection('facturaObraAsignada').findOne({ stelInvoiceId: String(stelInvoiceId) });
  if (!rec) return { ok: true };
  const repartos = (rec.repartos || []).filter(p => String(p.obraId) !== String(obraId));
  if (repartos.length) await database.collection('facturaObraAsignada').updateOne({ stelInvoiceId: String(stelInvoiceId) }, { $set: { repartos, ts: new Date() } });
  else await database.collection('facturaObraAsignada').deleteOne({ stelInvoiceId: String(stelInvoiceId) });
  return { ok: true };
}
async function desclasificarFactura(stelInvoiceId) {
  const database = await getDB();
  await database.collection('facturaObraAsignada').deleteOne({ stelInvoiceId: String(stelInvoiceId) });
  return { ok: true };
}
async function setReglaProveedor(supplierId, { supplier, obraId, obraRef, categoria, by } = {}) {
  if (!supplierId) throw new Error('Falta el proveedor');
  _validarClasif({ obraId, obraRef, categoria });
  const database = await getDB();
  await database.collection('reglaProveedor').updateOne(
    { supplierId: String(supplierId) },
    { $set: {
        supplierId: String(supplierId),
        supplier:   supplier || '',
        obraId:    obraId ? String(obraId) : null,
        obraRef:   obraRef || '',
        categoria: categoria || null,
        by:        by || '',
        ts:        new Date(),
    } },
    { upsert: true }
  );
  return { ok: true };
}
async function deleteReglaProveedor(supplierId) {
  const database = await getDB();
  await database.collection('reglaProveedor').deleteOne({ supplierId: String(supplierId) });
  return { ok: true };
}
async function getReglas() {
  const database = await getDB();
  return database.collection('reglaProveedor').find({}).sort({ supplier: 1 }).toArray();
}

// ── CRUD OBRAS ───────────────────────────────────────────────────
async function createObra(data) {
  const db = await getDB();
  const obra = {
    // Identificación
    clientName:   data.clientName?.trim() || '',
    reference:    data.reference?.trim() || '',   // "Calle Mayor 12 - Fachada"
    description:  data.description?.trim() || '',
    address:      data.address?.trim() || '',

    // Estado y fechas
    status:       data.status || 'activa',
    startDate:    data.startDate || new Date().toISOString().slice(0, 10),
    endDate:      data.endDate || null,

    // Presupuesto
    budgetAmount: parseFloat(data.budgetAmount || 0),  // Precio presupuestado (venta)
    costePresupuestado: parseFloat(data.costePresupuestado || 0), // Coste que esperábamos gastar
    presupuestoId: data.presupuestoId ? String(data.presupuestoId) : null, // origen (si nace de un presupuesto)
    presupuestoNumero: data.presupuestoNumero || null,  // nº del presupuesto de origen (para el recibo/trazabilidad)
    tiempoEstimado: data.tiempoEstimado || null,        // estimado del presupuesto (comparar vs real)
    equipoPresup:   Array.isArray(data.equipoPresup) ? data.equipoPresup : [],
    invoicedAmount: 0,  // Se calcula cruzando con StelOrder

    // Control
    materiales:   Array.isArray(data.materiales) ? data.materiales.map(m => ({ id: String(Date.now()) + Math.random().toString(36).slice(2, 6), concepto: String(m.concepto || '').trim(), importe: parseFloat(m.importe || 0) })) : [],
    notes:        data.notes || '',
    tags:         data.tags || [],  // Weber, Nutersa, etc.
    aliases:      Array.isArray(data.aliases) ? data.aliases.map(s => String(s || '').trim()).filter(Boolean) : [],  // otros nombres que cuentan (partes/presencia)
    createdAt:    new Date(),
    updatedAt:    new Date(),
  };

  if (!obra.clientName) throw new Error('El cliente es obligatorio');
  if (!obra.reference)  throw new Error('La referencia de obra es obligatoria');

  const result = await db.collection('obras').insertOne(obra);
  console.log(`[Obras] Nueva obra: ${obra.reference} — ${obra.clientName}`);
  return { id: result.insertedId, ...obra };
}

async function getObras({ clientName, status, search } = {}) {
  const db = await getDB();
  const query = {};
  if (status)     query.status = status;
  if (clientName) query.clientName = { $regex: clientName, $options: 'i' };
  if (search)     query.$or = [
    { reference:   { $regex: search, $options: 'i' } },
    { clientName:  { $regex: search, $options: 'i' } },
    { address:     { $regex: search, $options: 'i' } },
  ];
  return db.collection('obras').find(query).sort({ createdAt: -1 }).toArray();
}

async function getObra(id) {
  const db = await getDB();
  return db.collection('obras').findOne({ _id: new ObjectId(id) });
}

async function updateObra(id, data) {
  const db = await getDB();
  const allowed = ['clientName','reference','description','address','status','startDate','endDate','budgetAmount','notes','tags','materiales','aliases'];
  const set = { updatedAt: new Date() };
  allowed.forEach(k => { if (data[k] !== undefined) set[k] = data[k]; });
  if (Array.isArray(set.aliases)) set.aliases = set.aliases.map(s => String(s || '').trim()).filter(Boolean);
  return db.collection('obras').updateOne({ _id: new ObjectId(id) }, { $set: set });
}

// Borrar una obra (p. ej. una duplicada). No toca partes/presencia/facturas;
// solo elimina el registro de obra y su cálculo de rentabilidad.
async function deleteObra(id) {
  const db = await getDB();
  await db.collection('obras').deleteOne({ _id: new ObjectId(id) });
  return { ok: true };
}

// Material de obra (a mano): {concepto, importe}. Suma al coste en la rentabilidad.
async function addMaterial(obraId, { concepto, importe }) {
  const db = await getDB();
  const mat = { id: String(Date.now()) + Math.random().toString(36).slice(2, 6), concepto: String(concepto || '').trim(), importe: parseFloat(importe || 0) };
  if (!mat.importe || mat.importe <= 0) throw new Error('El importe del material debe ser mayor que 0');
  await db.collection('obras').updateOne({ _id: new ObjectId(obraId) }, { $push: { materiales: mat }, $set: { updatedAt: new Date() } });
  return mat;
}
async function deleteMaterial(obraId, matId) {
  const db = await getDB();
  return db.collection('obras').updateOne({ _id: new ObjectId(obraId) }, { $pull: { materiales: { id: matId } }, $set: { updatedAt: new Date() } });
}

// ── CERTIFICACIONES (cobros por partes de la obra) ───────────────
// Cada certificación es una parte a cobrar: {id, concepto, pct, importe, fecha,
// estado:'pendiente'|'cobrado', cobradoAt, cobradoNota}. El % se calcula sobre
// el presupuesto (budgetAmount) o se pone el importe a mano.
async function addCertificacion(obraId, { concepto, pct, importe } = {}) {
  const db = await getDB();
  const obra = await db.collection('obras').findOne({ _id: new ObjectId(obraId) });
  if (!obra) throw new Error('Obra no encontrada');
  const base = Number(obra.budgetAmount) || 0;
  const p = parseFloat(pct || 0);
  let imp = parseFloat(importe || 0);
  if (!(imp > 0) && p > 0 && base > 0) imp = Math.round(base * p / 100 * 100) / 100;
  if (!(imp > 0)) throw new Error('Indica un % (sobre el presupuesto) o un importe');
  const cert = {
    id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
    concepto: String(concepto || '').trim() || 'Certificación',
    pct: p > 0 ? p : null,
    importe: imp,
    fecha: new Date(),
    estado: 'pendiente', cobradoAt: null, cobradoNota: '',
  };
  await db.collection('obras').updateOne({ _id: obra._id }, { $push: { certificaciones: cert }, $set: { updatedAt: new Date() } });
  return cert;
}
async function setCertificacion(obraId, certId, { estado, cobradoNota, cobradoRef } = {}) {
  const db = await getDB();
  const set = { updatedAt: new Date() };
  if (estado === 'cobrado') {
    set['certificaciones.$.estado'] = 'cobrado';
    set['certificaciones.$.cobradoAt'] = new Date();
    if (cobradoNota != null) set['certificaciones.$.cobradoNota'] = String(cobradoNota);
    // Conciliación: movimiento del banco que casa este cobro.
    set['certificaciones.$.cobradoRef'] = cobradoRef ? {
      huella: String(cobradoRef.huella || ''), fecha: cobradoRef.fecha || null,
      concepto: String(cobradoRef.concepto || ''), importe: Number(cobradoRef.importe) || 0,
    } : null;
  } else {
    set['certificaciones.$.estado'] = 'pendiente';
    set['certificaciones.$.cobradoAt'] = null;
    set['certificaciones.$.cobradoRef'] = null;
  }
  await db.collection('obras').updateOne({ _id: new ObjectId(obraId), 'certificaciones.id': certId }, { $set: set });
  return { ok: true };
}
async function deleteCertificacion(obraId, certId) {
  const db = await getDB();
  return db.collection('obras').updateOne({ _id: new ObjectId(obraId) }, { $pull: { certificaciones: { id: certId } }, $set: { updatedAt: new Date() } });
}
function resumenCertificaciones(obra) {
  const certs = (obra && obra.certificaciones) || [];
  const base = Number(obra && obra.budgetAmount) || 0;
  const certificado = certs.reduce((s, c) => s + (Number(c.importe) || 0), 0);
  const cobrado = certs.filter(c => c.estado === 'cobrado').reduce((s, c) => s + (Number(c.importe) || 0), 0);
  const r = x => Math.round(x * 100) / 100;
  return { certs, certificado: r(certificado), cobrado: r(cobrado), pendiente: r(certificado - cobrado), sinCertificar: r(base - certificado), pctCertificado: base > 0 ? Math.round(certificado / base * 100) : 0 };
}

// ── RENTABILIDAD ─────────────────────────────────────────────────
// Cruza partes de trabajo con facturas de StelOrder para calcular
// coste real vs facturado por obra

async function getRentabilidad(obraId) {
  const db = await getDB();
  const obra = await db.collection('obras').findOne({ _id: new ObjectId(obraId) });
  if (!obra) throw new Error('Obra no encontrada');

  // Textos por los que se reconoce esta obra: referencia, cliente y ALIAS
  // ("otros nombres que cuentan" — el usuario los añade en la ficha para que
  // cuadren partes y presencia registrados con un nombre distinto). Escapados.
  const esc = s => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matchTexts = [obra.reference, obra.clientName, ...(obra.aliases || [])]
    .map(s => String(s || '').trim()).filter(Boolean);
  const orClientName  = matchTexts.map(t => ({ clientName: { $regex: esc(t), $options: 'i' } }));
  const orObrasClient = matchTexts.map(t => ({ 'obras.clientName': { $regex: esc(t), $options: 'i' } }));
  const NADA = { _id: null }; // sin textos → no casa nada

  // 1. Partes asociados a esta obra: por obraId EXPLÍCITO (el operario la eligió
  //    en el parte) o por cualquiera de sus nombres/alias.
  const orPartes = [{ obraId: String(obra._id) }, ...orClientName];
  const partes = await db.collection('partes').find({ $or: orPartes }).sort({ date: 1 }).toArray();

  // 2. Coste de personal — desde PARTES y, si no hay parte ese día, desde PRESENCIA.
  //    Tarifa real = coste/hora de la plantilla (con fallback razonable).
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const RATES = { jose: 26.72, diego: 19.05, abdellah: 13.28, mamadou: 13.28, paula: 8.66 };
  let trabs = [];
  try { trabs = await require('./trabajadores').getTrabajadores(false); } catch (e) {}
  const rateFor = (name, id) => {
    const n = norm(name);
    for (const w of trabs) {
      if (!w.costeHora) continue;
      const toks = norm(w.nombre).split(/\s+/).filter(t => t.length > 2);
      if (n && (n === norm(w.nombre) || toks.some(t => n.includes(t)) || (w.alias || []).some(a => a && n.includes(a)))) return w.costeHora;
    }
    return RATES[id] || 15;
  };

  // Presencia asociada a la obra: por cualquiera de sus nombres/alias.
  const nRef = norm(obra.reference || ''), nCli = norm(obra.clientName || '');
  const nList = matchTexts.map(norm).filter(Boolean);
  const matchObra = name => { const a = norm(name); if (!a) return false; return nList.some(t => a.includes(t) || t.includes(a)); };
  let presencias = [];
  try {
    presencias = await db.collection('attendance').find(
      (orClientName.length || orObrasClient.length) ? { $or: [...orClientName, ...orObrasClient] } : NADA
    ).toArray();
  } catch (e) {}

  let totalHoras = 0;
  let totalCostePersonal = 0;
  let totalMateriales = 0;
  const byWorker = {};
  const byDate = {};
  const cubierto = new Set(); // workerId|date ya contado por un parte

  // 2a. Partes (prioridad: traen materiales y horas explícitas)
  partes.forEach(p => {
    const horas = p.horas || 8, rate = rateFor(p.workerName, p.workerId), coste = horas * rate;
    totalHoras += horas; totalCostePersonal += coste;
    const wk = p.workerId || p.workerName;
    cubierto.add(wk + '|' + p.date);
    if (!byWorker[wk]) byWorker[wk] = { name: p.workerName, dias: 0, horas: 0, coste: 0 };
    byWorker[wk].dias++; byWorker[wk].horas += horas; byWorker[wk].coste += coste;
    (byDate[p.date] = byDate[p.date] || []).push({ worker: p.workerName, horas, coste, src: 'parte' });
    (p.materiales || []).forEach(m => { totalMateriales += (m.cantidad || 0) * (m.precio || 0); });
  });

  // 2b. Presencia (rellena los días sin parte de esa obra)
  presencias.forEach(e => {
    let horas = 0;
    if (Array.isArray(e.obras) && e.obras.length) {
      e.obras.forEach(o => { if (matchObra(o.clientName)) horas += (o.horas || 0); });
      if (!horas && matchObra(e.clientName)) horas = e.horas || 8;
    } else if (matchObra(e.clientName)) horas = e.horas || 8;
    if (!horas) return;
    const wk = e.workerId || e.workerName;
    if (cubierto.has(wk + '|' + e.date)) return; // ya contado por un parte ese día
    const rate = rateFor(e.workerName, e.workerId), coste = horas * rate;
    totalHoras += horas; totalCostePersonal += coste;
    if (!byWorker[wk]) byWorker[wk] = { name: e.workerName, dias: 0, horas: 0, coste: 0 };
    byWorker[wk].dias++; byWorker[wk].horas += horas; byWorker[wk].coste += coste;
    (byDate[e.date] = byDate[e.date] || []).push({ worker: e.workerName, horas, coste, src: 'presencia' });
  });

  // 2c. Material de la obra (metido a mano en la ficha) — cuenta como coste.
  (obra.materiales || []).forEach(m => { totalMateriales += parseFloat(m.importe || 0); });

  // 2d. Facturas de PROVEEDOR de esta obra (Fase 2). Se resuelve cada factura por
  //     prioridad clasificación-manual > regla-proveedor > marcador-n8n. Solo las
  //     de tipo 'obra' ligadas a ESTA obra suman; los gastos generales y las sin
  //     clasificar no cuentan. Cada factura, una sola vez. Sin datos → suma 0.
  let totalProveedores = 0;
  const proveedores = [];
  try {
    const [facturasProv, asignMap, reglaMap] = await Promise.all([
      require('./stelorder').getPurchaseInvoices(),
      getAsignacionesFacturaMap(db),
      getReglasMap(db),
    ]);
    const miId = String(obra._id);
    for (const f of (facturasProv || [])) {
      // Reparto: la factura va troceada por importe entre varias obras.
      const rec = asignMap.get(String(f.id));
      if (rec && Array.isArray(rec.repartos) && rec.repartos.length) {
        const parte = rec.repartos.find(p => String(p.obraId) === miId);
        if (parte) {
          const imp = Number(parte.importe) || 0;
          totalProveedores += imp;
          proveedores.push({ id: f.id, number: f.number, supplier: f.supplier, total: imp, date: f.date, fuente: 'reparto', categoria: null });
        }
        continue; // el reparto manda; no se cuenta el total entero
      }
      const cls = resolverFacturaObra(f, asignMap, reglaMap);
      if (!cls || cls.tipo !== 'obra') continue;
      let pertenece;
      if (cls.obraId) {
        pertenece = String(cls.obraId) === miId;      // obra concreta (manual/regla)
      } else {
        const tag = norm(cls.obraRef || '');           // marcador n8n: match por reference
        pertenece = !!(tag && nRef && (tag.includes(nRef) || nRef.includes(tag)));
      }
      if (pertenece) {
        const imp = Number(f.total) || 0;
        totalProveedores += imp;
        proveedores.push({ id: f.id, number: f.number, supplier: f.supplier, total: imp, date: f.date, fuente: cls.fuente, categoria: cls.categoria || null });
      }
    }
  } catch (e) { /* si StelOrder falla, la rentabilidad sigue con personal + material */ }

  const totalCoste = totalCostePersonal + totalMateriales + totalProveedores;
  const facturado  = obra.invoicedAmount || obra.budgetAmount || 0;
  const beneficio  = facturado - totalCoste;
  const margen     = facturado > 0 ? (beneficio / facturado * 100) : 0;

  // 3. Diagnóstico automático
  let diagnostico = null;
  if (facturado > 0) {
    if (margen < 0) {
      diagnostico = {
        tipo: 'perdida',
        emoji: '🚨',
        color: '#f05252',
        mensaje: `Pérdida de ${Math.abs(beneficio).toFixed(0)}€. El coste supera lo facturado en un ${Math.abs(margen).toFixed(1)}%.`,
        recomendacion: `Para cubrir costes necesitas facturar al menos ${(totalCoste * 1.2).toFixed(0)}€ (margen 20%).`
      };
    } else if (margen < 15) {
      diagnostico = {
        tipo: 'ajustado',
        emoji: '⚠️',
        color: '#f59e0b',
        mensaje: `Margen muy ajustado del ${margen.toFixed(1)}%. Beneficio de ${beneficio.toFixed(0)}€.`,
        recomendacion: 'Revisar si hay materiales no registrados o horas adicionales no facturadas.'
      };
    } else if (margen < 30) {
      diagnostico = {
        tipo: 'correcto',
        emoji: '✅',
        color: '#22c487',
        mensaje: `Obra rentable con ${margen.toFixed(1)}% de margen. Beneficio de ${beneficio.toFixed(0)}€.`,
        recomendacion: null
      };
    } else {
      diagnostico = {
        tipo: 'excelente',
        emoji: '🌟',
        color: '#4d9cf8',
        mensaje: `Excelente margen del ${margen.toFixed(1)}%. Beneficio de ${beneficio.toFixed(0)}€.`,
        recomendacion: null
      };
    }
  }

  const costePresupuestado = Number(obra.costePresupuestado) || 0;
  return {
    obra,
    partes: partes.length,
    totalHoras,
    totalCostePersonal,
    totalMateriales,
    totalProveedores,
    proveedores,
    totalCoste,
    costePresupuestado,                       // lo que esperábamos gastar (del presupuesto)
    desvioCoste: Math.round((totalCoste - costePresupuestado) * 100) / 100, // real − presupuestado (+ = de más)
    facturado,
    beneficio,
    margen,
    byWorker: Object.values(byWorker),
    byDate,
    diagnostico,
    certificaciones: resumenCertificaciones(obra),
  };
}

// ── RESUMEN GENERAL ───────────────────────────────────────────────
async function getResumenGeneral() {
  const db = await getDB();
  const obras = await db.collection('obras').find({}).sort({ createdAt: -1 }).toArray();

  const resumen = await Promise.all(obras.map(async obra => {
    try {
      const r = await getRentabilidad(String(obra._id));
      return { ...r, obraId: String(obra._id) };
    } catch(e) {
      return { obra, partes: 0, totalCoste: 0, facturado: 0, beneficio: 0, margen: 0, diagnostico: null };
    }
  }));

  return resumen;
}

module.exports = {
  ESTADOS_OBRA, CATEGORIAS_GASTO,
  createObra, getObras, getObra, updateObra, deleteObra, addMaterial, deleteMaterial,
  addCertificacion, setCertificacion, deleteCertificacion, resumenCertificaciones,
  getRentabilidad, getResumenGeneral,
  extraerObraMarcador, getAsignacionesFacturaMap, getReglasMap, resolverFacturaObra,
  clasificarFactura, desclasificarFactura, repartirFactura, quitarReparto,
  setReglaProveedor, deleteReglaProveedor, getReglas,
};
