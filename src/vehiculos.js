// src/vehiculos.js — Flota: furgonetas y coches de la empresa.
//
// Cada vehículo tiene su ficha (colección 'vehiculos'):
//   · datos (matrícula, marca, modelo, bastidor, combustible, matriculación),
//   · quién lo lleva (conductor + historial de cambios),
//   · ITV, seguro (compañía, póliza, precio, vencimiento), impuesto, próxima revisión, km,
//   · alta (compra / renting / leasing, precio) y baja (vendido, achatarrado…),
//   · documentos (ficha técnica, permiso de circulación, póliza…) en 'vehiculoDocs',
//   · su id en Quartix para verlo en el mapa (src/quartix.js).
// Los gastos salen de:
//   · Compras con destino 'vehiculo' (facturas de taller, seguro, ITV…), por su base sin IVA si la hay.
//   · Pagos del punteo marcados «del vehículo» sin factura (tickets de gasolina, parking…).
// Avisos (cada mañana): ITV y revisión → conductor + oficina; seguro → oficina. A 30, 15, 7, 1 y 0 días,
// y una vez por semana si ya está vencida.

const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const matNorm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const fechaOk = s => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : null);
const txt = (s, n = 120) => String(s == null ? '' : s).trim().slice(0, n);
const num = v => (v === '' || v == null || isNaN(Number(v)) ? null : r2(v));
function _oid(id) { try { return new ObjectId(String(id)); } catch (e) { throw new Error('Vehículo no válido'); } }

const CATEGORIAS = { taller: 'Taller y reparaciones', combustible: 'Combustible', neumaticos: 'Neumáticos', seguro: 'Seguro', itv: 'ITV', impuestos: 'Impuestos (IVTM)', peajes: 'Peajes y parking', lavado: 'Lavado', renting: 'Renting / leasing', gps: 'Localizador GPS', otros: 'Otros' };
const TIPOS = { furgoneta: 'Furgoneta', coche: 'Coche', camion: 'Camión', moto: 'Moto', remolque: 'Remolque', otro: 'Otro' };
const COMBUSTIBLES = ['diésel', 'gasolina', 'híbrido', 'eléctrico', 'GLP'];
const FORMAS = { compra: 'Comprado', renting: 'Renting', leasing: 'Leasing', prestamo: 'Comprado con préstamo' };
const MOTIVOS_BAJA = { vendido: 'Vendido', achatarrado: 'Achatarrado', fin_renting: 'Fin del renting', siniestro: 'Siniestro total', robo: 'Robo', otro: 'Otro' };
const DOCS = { ficha_tecnica: 'Ficha técnica', permiso: 'Permiso de circulación', seguro: 'Póliza / recibo del seguro', itv: 'Informe ITV', contrato: 'Contrato compra / renting', otro: 'Otro' };

// Categoría probable a partir del proveedor o el concepto.
function sugerirCategoria(texto) {
  const n = norm(texto);
  if (/neumat|pneumat|euromaster|confort auto/.test(n)) return 'neumaticos';
  if (/\bitv\b|inspeccion tecnica|applus|sgs/.test(n)) return 'itv';
  if (/seguro|assegur|mapfre|allianz|axa|generali|mutua|admiral|linea directa|occident/.test(n)) return 'seguro';
  if (/gasolin|petroprix|petrem|repsol|cepsa|galp|esclatoil|bp |shell|carburant|e\.?s\.? |estacio de servei|ballenoil|plenoil/.test(n)) return 'combustible';
  if (/peaje|autopista|autopistes|parking|aparcament|estacioname|via-?t/.test(n)) return 'peajes';
  if (/renting|leasing|arval|ald |leaseplan|northgate/.test(n)) return 'renting';
  if (/quartix|localiza|gps|tracker/.test(n)) return 'gps';
  if (/lavado|rentat|wash/.test(n)) return 'lavado';
  if (/taller|mecan|auto|norauto|midas|recambi|recanvi|carrosser|chapa|feu vert|classicauto|kin\b/.test(n)) return 'taller';
  if (/ivtm|impuesto vehic|xaloc|circulacion/.test(n)) return 'impuestos';
  return 'otros';
}

// Normaliza lo que llega del formulario (solo los campos que vienen).
function limpiar(d = {}) {
  const o = {};
  const S = (k, n) => { if (k in d) o[k] = txt(d[k], n); };
  S('nombre', 60); S('marca', 40); S('modelo', 60); S('bastidor', 30); S('color', 30); S('notas', 2000); S('proveedorCompra', 80); S('quartixId', 40);
  if ('matricula' in d) o.matricula = matNorm(d.matricula).slice(0, 12);
  if ('tipo' in d) o.tipo = TIPOS[d.tipo] ? d.tipo : 'furgoneta';
  if ('combustible' in d) o.combustible = COMBUSTIBLES.includes(d.combustible) ? d.combustible : '';
  if ('fechaMatriculacion' in d) o.fechaMatriculacion = fechaOk(d.fechaMatriculacion);
  if ('fechaAlta' in d) o.fechaAlta = fechaOk(d.fechaAlta);
  if ('formaCompra' in d) o.formaCompra = FORMAS[d.formaCompra] ? d.formaCompra : 'compra';
  if ('precioCompra' in d) o.precioCompra = num(d.precioCompra);
  if ('cuotaMensual' in d) o.cuotaMensual = num(d.cuotaMensual);
  if ('finContrato' in d) o.finContrato = fechaOk(d.finContrato);
  if ('km' in d) o.km = num(d.km) != null ? Math.round(num(d.km)) : null;
  if (d.itv && typeof d.itv === 'object') o.itv = { proxima: fechaOk(d.itv.proxima), ultima: fechaOk(d.itv.ultima), notas: txt(d.itv.notas, 300) };
  if (d.seguro && typeof d.seguro === 'object') {
    const s = d.seguro;
    o.seguro = { compania: txt(s.compania, 60), poliza: txt(s.poliza, 40), modalidad: txt(s.modalidad, 40), precioAnual: num(s.precioAnual), vencimiento: fechaOk(s.vencimiento), telefonoAsistencia: txt(s.telefonoAsistencia, 20) };
  }
  if (d.revision && typeof d.revision === 'object') o.revision = { proximaFecha: fechaOk(d.revision.proximaFecha), proximaKm: num(d.revision.proximaKm), notas: txt(d.revision.notas, 300) };
  if ('ivtm' in d) o.ivtm = num(d.ivtm);
  return o;
}

async function siguienteCodigo(db) {
  const ult = await db.collection('vehiculos').find({}, { projection: { codigo: 1 } }).sort({ codigo: -1 }).limit(1).toArray();
  const n = ult.length ? parseInt(String(ult[0].codigo).replace(/\D/g, ''), 10) || 0 : 0;
  return 'V-' + String(n + 1).padStart(3, '0');
}

async function crear(data, por) {
  const db = await getDB();
  const v = limpiar(data);
  if (!v.nombre && !v.matricula) throw new Error('Pon al menos un nombre (p. ej. «Furgoneta Jose») o la matrícula');
  if (v.matricula && await db.collection('vehiculos').findOne({ matricula: v.matricula, estado: 'activo' })) throw new Error('Ya hay un vehículo con esa matrícula');
  const doc = {
    codigo: await siguienteCodigo(db), tipo: 'furgoneta', formaCompra: 'compra', ...v,
    nombre: v.nombre || [v.marca, v.modelo].filter(Boolean).join(' ') || v.matricula,
    estado: 'activo', conductor: null, historialConductor: [], avisos: {},
    creado: new Date(), creadoPor: por || '', actualizado: new Date(),
  };
  if (data.conductor && data.conductor.userId) {
    doc.conductor = { userId: String(data.conductor.userId), name: txt(data.conductor.name, 60) };
    doc.historialConductor = [{ ...doc.conductor, desde: new Date().toISOString().slice(0, 10), hasta: null, por: por || '' }];
  }
  const r = await db.collection('vehiculos').insertOne(doc);
  return { ...doc, _id: r.insertedId };
}

async function editar(id, data, por) {
  const db = await getDB();
  const v = limpiar(data);
  if ('nombre' in v && !v.nombre) delete v.nombre;   // el nombre no se puede dejar vacío
  if (v.matricula && await db.collection('vehiculos').findOne({ matricula: v.matricula, estado: 'activo', _id: { $ne: _oid(id) } })) throw new Error('Ya hay otro vehículo con esa matrícula');
  // Si cambia una fecha de vencimiento, los avisos de esa fecha vuelven a empezar.
  const r = await db.collection('vehiculos').findOneAndUpdate({ _id: _oid(id) }, { $set: { ...v, actualizado: new Date(), actualizadoPor: por || '' } }, { returnDocument: 'after' });
  const doc = r && (r.value !== undefined ? r.value : r);
  if (!doc) throw new Error('Vehículo no encontrado');
  return doc;
}

// Cambia quién lo lleva (o lo deja en la nave con userId vacío) y guarda el historial.
async function asignarConductor(id, { userId, name, fecha, nota } = {}, por) {
  const db = await getDB();
  const v = await db.collection('vehiculos').findOne({ _id: _oid(id) });
  if (!v) throw new Error('Vehículo no encontrado');
  const f = fechaOk(fecha) || new Date().toISOString().slice(0, 10);
  const hist = (v.historialConductor || []).map(h => (h.hasta ? h : { ...h, hasta: f }));
  const nuevo = userId ? { userId: String(userId), name: txt(name, 60) } : null;
  if (nuevo) hist.push({ ...nuevo, desde: f, hasta: null, por: por || '', nota: txt(nota, 200) });
  await db.collection('vehiculos').updateOne({ _id: v._id }, { $set: { conductor: nuevo, historialConductor: hist.slice(-50), actualizado: new Date() } });
  return { ok: true, conductor: nuevo };
}

async function darDeBaja(id, { fecha, motivo, precioVenta, nota } = {}, por) {
  const db = await getDB();
  const baja = { fecha: fechaOk(fecha) || new Date().toISOString().slice(0, 10), motivo: MOTIVOS_BAJA[motivo] ? motivo : 'otro', precioVenta: num(precioVenta), nota: txt(nota, 300), por: por || '' };
  const v = await db.collection('vehiculos').findOne({ _id: _oid(id) });
  if (!v) throw new Error('Vehículo no encontrado');
  if (v.conductor) await asignarConductor(id, { userId: null, fecha: baja.fecha }, por);
  await db.collection('vehiculos').updateOne({ _id: v._id }, { $set: { estado: 'baja', baja, actualizado: new Date() } });
  return { ok: true };
}
async function reactivar(id, por) {
  const db = await getDB();
  await db.collection('vehiculos').updateOne({ _id: _oid(id) }, { $set: { estado: 'activo', actualizado: new Date(), actualizadoPor: por || '' }, $unset: { baja: '' } });
  return { ok: true };
}

// ── DOCUMENTOS ──
async function subirDocumento(id, { tipo, archivo, nombre }, por) {
  if (!archivo || !archivo.buffer) throw new Error('Falta el archivo');
  if (!/^(image\/|application\/pdf)/.test(archivo.mimetype || '')) throw new Error('Sube una foto o un PDF');
  const db = await getDB();
  const v = await db.collection('vehiculos').findOne({ _id: _oid(id) }, { projection: { _id: 1 } });
  if (!v) throw new Error('Vehículo no encontrado');
  const doc = { vehiculoId: String(v._id), tipo: DOCS[tipo] ? tipo : 'otro', nombre: txt(nombre || archivo.originalname || DOCS[tipo] || 'Documento', 100), mime: archivo.mimetype, size: archivo.size || archivo.buffer.length, data: archivo.buffer, subido: new Date(), por: por || '' };
  const r = await db.collection('vehiculoDocs').insertOne(doc);
  return { id: String(r.insertedId), tipo: doc.tipo, nombre: doc.nombre, mime: doc.mime, size: doc.size, subido: doc.subido };
}
async function documentos(id) {
  const db = await getDB();
  return (await db.collection('vehiculoDocs').find({ vehiculoId: String(id) }, { projection: { data: 0 } }).sort({ subido: -1 }).toArray())
    .map(d => ({ id: String(d._id), tipo: d.tipo, nombre: d.nombre, mime: d.mime, size: d.size, subido: d.subido, por: d.por }));
}
async function documento(docId) {
  const db = await getDB();
  return db.collection('vehiculoDocs').findOne({ _id: _oid(docId) });
}
async function borrarDocumento(docId) {
  const db = await getDB();
  await db.collection('vehiculoDocs').deleteOne({ _id: _oid(docId) });
  return { ok: true };
}

// ── LISTAS ──
// Para elegir vehículo en Compras y el cierre: solo los activos, datos mínimos.
async function lista() {
  const db = await getDB();
  return (await db.collection('vehiculos').find({ estado: 'activo' }).sort({ nombre: 1 }).toArray())
    .map(v => ({ id: String(v._id), codigo: v.codigo, nombre: v.nombre, matricula: v.matricula || '', marca: v.marca || '', modelo: v.modelo || '', quien: v.conductor ? v.conductor.name : null }));
}
function diasHasta(f, hoy = new Date()) {
  if (!f) return null;
  const h = new Date(hoy.toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' }) + 'T00:00:00Z');
  return Math.round((new Date(f + 'T00:00:00Z') - h) / 86400000);
}
function _publico(v) {
  const { avisos, ...rest } = v;
  return { ...rest, id: String(v._id), dias: { itv: diasHasta(v.itv && v.itv.proxima), seguro: diasHasta(v.seguro && v.seguro.vencimiento), revision: diasHasta(v.revision && v.revision.proximaFecha), finContrato: diasHasta(v.finContrato) } };
}
// Flota completa con el gasto del año y los documentos que tiene cada uno.
async function flota({ anio } = {}) {
  const db = await getDB();
  const y = Number(anio) || new Date().getFullYear();
  const [vs, gs, ds] = await Promise.all([
    db.collection('vehiculos').find({}).sort({ estado: 1, nombre: 1 }).toArray(),
    gastos({ desde: `${y}-01-01`, hasta: `${y}-12-31` }),
    db.collection('vehiculoDocs').aggregate([{ $group: { _id: { v: '$vehiculoId', t: '$tipo' }, n: { $sum: 1 } } }]).toArray(),
  ]);
  const docsDe = {}; ds.forEach(d => { (docsDe[d._id.v] = docsDe[d._id.v] || {})[d._id.t] = d.n; });
  return {
    anio: y, tipos: TIPOS, formas: FORMAS, motivosBaja: MOTIVOS_BAJA, docs: DOCS, combustibles: COMBUSTIBLES, categorias: CATEGORIAS,
    vehiculos: vs.map(v => { const id = String(v._id); const mios = gs.filter(g => g.vehiculoId === id); return { ..._publico(v), gastoAnio: r2(mios.reduce((a, g) => a + g.importe, 0)), docsTipos: docsDe[id] || {} }; }),
  };
}
async function ficha(id, { anio } = {}) {
  const db = await getDB();
  const v = await db.collection('vehiculos').findOne({ _id: _oid(id) });
  if (!v) throw new Error('Vehículo no encontrado');
  const [docs, res] = await Promise.all([documentos(id), resumen({ anio, soloId: String(v._id), incluirBajas: true })]);
  return { vehiculo: _publico(v), documentos: docs, gastos: res.vehiculos[0] || null, tipos: TIPOS, formas: FORMAS, motivosBaja: MOTIVOS_BAJA, docsTipos: DOCS, combustibles: COMBUSTIBLES, categorias: CATEGORIAS };
}

// ── GASTOS ──
async function gastos({ desde, hasta } = {}) {
  const db = await getDB();
  const qFecha = (campo) => (desde || hasta) ? { [campo]: { ...(desde ? { $gte: desde } : {}), ...(hasta ? { $lte: hasta } : {}) } } : {};
  const [cs, pm] = await Promise.all([
    db.collection('compras').find({ destino: 'vehiculo', vehiculoId: { $ne: null }, estado: { $ne: 'descartada' }, ...qFecha('fecha') })
      .project({ vehiculoId: 1, proveedor: 1, numero: 1, fecha: 1, base: 1, total: 1, categoria: 1, estado: 1, createdAt: 1 }).toArray(),
    db.collection('punteoManual').find({ decision: 'vehiculo', vehiculoId: { $ne: null }, ...qFecha('fecha') }).toArray(),
  ]);
  return [
    ...cs.map(c => ({ vehiculoId: c.vehiculoId, fecha: c.fecha || (c.createdAt && c.createdAt.toISOString().slice(0, 10)), concepto: [c.proveedor, c.numero].filter(Boolean).join(' nº '), categoria: c.categoria && CATEGORIAS[c.categoria] ? c.categoria : sugerirCategoria(c.proveedor), importe: r2(c.base != null ? c.base : c.total), conFactura: true, compraId: String(c._id), porRevisar: c.estado !== 'revisada' })),
    ...pm.map(p => ({ vehiculoId: p.vehiculoId, fecha: p.fecha, concepto: p.concepto + (p.nota ? ` — ${p.nota}` : ''), categoria: p.categoria || sugerirCategoria(p.concepto), importe: r2(Math.abs(p.importe || 0)), conFactura: false })),
  ].sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
}

// Resumen por vehículo para un año: total, por categoría, por mes y los últimos gastos.
async function resumen({ anio, soloId, incluirBajas } = {}) {
  const y = Number(anio) || new Date().getFullYear();
  const db = await getDB();
  const q = soloId ? { _id: _oid(soloId) } : (incluirBajas ? {} : { estado: 'activo' });
  const [vs, gs] = await Promise.all([db.collection('vehiculos').find(q).sort({ nombre: 1 }).toArray(), gastos({ desde: `${y}-01-01`, hasta: `${y}-12-31` })]);
  const out = vs.map(v => {
    const id = String(v._id);
    const mios = gs.filter(g => g.vehiculoId === id);
    const porCat = {}, porMes = {};
    for (const g of mios) { porCat[g.categoria] = r2((porCat[g.categoria] || 0) + g.importe); const m = String(g.fecha || '').slice(0, 7); porMes[m] = r2((porMes[m] || 0) + g.importe); }
    const meses = Object.keys(porMes).filter(Boolean).length;
    const total = r2(mios.reduce((a, g) => a + g.importe, 0));
    return { id, nombre: v.nombre, matricula: v.matricula || '', marca: v.marca || '', modelo: v.modelo || '', quien: v.conductor ? v.conductor.name : null, estado: v.estado, total, porCategoria: porCat, porMes, mediaMes: meses ? r2(total / meses) : 0, sinFactura: mios.filter(g => !g.conFactura).length, gastos: mios.slice(0, 60) };
  }).sort((a, b) => b.total - a.total);
  return { anio: y, categorias: CATEGORIAS, vehiculos: out, total: r2(out.reduce((a, v) => a + v.total, 0)) };
}

// ── AVISOS DE VENCIMIENTOS ──
const UMBRALES = [30, 15, 7, 1, 0];
// Clave del aviso que toca hoy (o null): el menor umbral ≥ días que falten; vencida → una por semana.
function claveAviso(dias) {
  if (dias == null || dias > UMBRALES[0]) return null;
  if (dias < 0) return 'vencida-' + Math.floor(-dias / 7);
  return 'd' + UMBRALES.filter(u => u >= dias).pop();
}
function _fmt(f) { return f ? f.split('-').reverse().join('/') : ''; }
function _cuando(d) { return d < 0 ? `venció hace ${-d} día${d === -1 ? '' : 's'}` : d === 0 ? 'vence HOY' : d === 1 ? 'vence mañana' : `vence en ${d} días`; }
function _tel(t) { const d = String(t || '').replace(/\D/g, ''); if (!d) return null; return d.length === 9 ? '+34' + d : '+' + d.replace(/^00/, ''); }
function _oficina() { return String(process.env.VEHICULOS_AVISOS_TO || process.env.FICHAJE_AVISOS_TO || process.env.WHATSAPP_TO || '').split(',').map(s => s.trim().replace(/^whatsapp:/i, '')).filter(Boolean); }

// Qué avisos tocan hoy (sin enviar): útil para la página y para las pruebas.
function avisosPendientes(v, hoy = new Date()) {
  const out = [];
  const nombreV = `${v.nombre}${v.matricula ? ' (' + v.matricula + ')' : ''}`;
  const add = (tipo, fecha, conductor, titulo, extra) => {
    const dias = diasHasta(fecha, hoy); const k = claveAviso(dias);
    if (!k) return;
    const clave = `${tipo}:${fecha}:${k}`;
    if ((v.avisos || {})[clave]) return;
    out.push({ tipo, fecha, dias, clave, conductor, oficina: `🚐 ${titulo} de ${nombreV}: ${_cuando(dias)} (${_fmt(fecha)}).${v.conductor ? ' Lo lleva ' + v.conductor.name + '.' : ''}${extra ? ' ' + extra : ''}`, titulo });
  };
  if (v.estado !== 'activo') return out;
  if (v.itv && v.itv.proxima) add('itv', v.itv.proxima, true, 'ITV');
  if (v.seguro && v.seguro.vencimiento) add('seguro', v.seguro.vencimiento, false, 'Seguro', [v.seguro.compania, v.seguro.precioAnual ? `${v.seguro.precioAnual} €/año` : ''].filter(Boolean).join(' · ') + (v.seguro.compania || v.seguro.precioAnual ? '. ¿Renovar o pedir otras ofertas?' : ''));
  if (v.revision && v.revision.proximaFecha) add('revision', v.revision.proximaFecha, true, 'Revisión');
  if (v.finContrato && v.formaCompra !== 'compra') add('contrato', v.finContrato, false, `Fin del ${FORMAS[v.formaCompra] || 'contrato'}`);
  return out;
}

async function revisarVencimientos({ dryRun = false, hoy = new Date() } = {}) {
  const db = await getDB();
  const vs = await db.collection('vehiculos').find({ estado: 'activo' }).toArray();
  const { getUsers } = require('./users');
  const usuarios = await getUsers(false).catch(() => []);
  const telDe = {}; (usuarios || []).forEach(u => { telDe[String(u._id)] = _tel(u.whatsapp || u.telefono); });
  const enviar = async (to, texto) => { try { return await require('./notifications').sendWhatsAppTo(to, texto); } catch (e) { console.error('[Vehículos] envío:', e.message); return false; } };
  const hechos = [];
  for (const v of vs) {
    for (const a of avisosPendientes(v, hoy)) {
      const dest = [];
      if (a.conductor && v.conductor && telDe[v.conductor.userId]) {
        const nom = String(v.conductor.name || '').split(/\s+/)[0];
        const queV = [[v.marca, v.modelo].filter(Boolean).join(' '), v.matricula].filter(Boolean).join(' ') || v.nombre;
        const textoC = `Hola ${nom}, la ${a.titulo} de la ${(TIPOS[v.tipo] || 'vehículo').toLowerCase()} que llevas (${queV}) ${_cuando(a.dias)} (${_fmt(a.fecha)}).` + (a.tipo === 'itv' ? ' Habla con la oficina para pedir cita.' : ' Habla con la oficina para llevarla al taller.');
        dest.push({ to: telDe[v.conductor.userId], texto: textoC, quien: v.conductor.name });
      }
      _oficina().forEach(to => dest.push({ to, texto: a.oficina, quien: 'oficina' }));
      if (!dryRun) {
        for (const d of dest) await enviar(d.to, d.texto);
        try { await require('./push').sendToOficina({ title: `🚐 ${a.titulo}: ${v.nombre}`, body: _cuando(a.dias), url: '/vehiculos#' + String(v._id) }); } catch (e) { /* push opcional */ }
        await db.collection('vehiculos').updateOne({ _id: v._id }, { $set: { ['avisos.' + a.clave]: new Date() } });
      }
      hechos.push({ vehiculo: v.nombre, tipo: a.tipo, dias: a.dias, a: dest.map(d => d.quien) });
    }
  }
  return { avisos: hechos, dryRun };
}

module.exports = { CATEGORIAS, TIPOS, FORMAS, MOTIVOS_BAJA, DOCS, sugerirCategoria, limpiar, crear, editar, asignarConductor, darDeBaja, reactivar, subirDocumento, documentos, documento, borrarDocumento, lista, flota, ficha, gastos, resumen, diasHasta, claveAviso, avisosPendientes, revisarVencimientos, matNorm };
