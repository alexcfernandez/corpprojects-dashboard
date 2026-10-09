// src/trimestre.js — Cierre del trimestre para la gestoría.
//
// Junta en un sitio lo que la gestoría necesita cada trimestre y, sobre todo, LO QUE
// FALTA antes de mandárselo:
//   · Facturas emitidas (StelOrder) y recibidas (StelOrder: facturas de proveedor + gastos).
//   · Pendientes: compras por revisar (fotos, correo, WhatsApp, grupo), revisadas que no
//     han pasado a contabilidad, correos de factura sin PDF o sin revisar, albaranes sin
//     factura, y si el extracto del banco cubre todo el trimestre.
// Se recalcula cada mañana (scheduler) y oficina recibe un resumen los lunes mientras el
// trimestre está abierto o recién cerrado. El Excel para la gestoría sale de aquí.

async function getDB() { return require('./db').getDB(); }
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

// '2026-T3' → { q, y, n, from:'2026-07-01', to:'2026-09-30', label }
function rango(q) {
  const m = /^(\d{4})-T([1-4])$/.exec(String(q || ''));
  if (!m) throw new Error('Trimestre no válido (ej. 2026-T3)');
  const y = Number(m[1]), n = Number(m[2]);
  const mIni = (n - 1) * 3 + 1, mFin = n * 3;
  const fin = new Date(Date.UTC(y, mFin, 0)).getUTCDate();
  return { q, y, n, from: `${y}-${String(mIni).padStart(2, '0')}-01`, to: `${y}-${String(mFin).padStart(2, '0')}-${fin}`, label: `${n}º trimestre ${y}` };
}
// El trimestre que toca cerrar: hasta el día 20 del mes siguiente, el anterior.
function trimestrePorDefecto(hoy = new Date()) {
  const y = hoy.getFullYear(), m = hoy.getMonth() + 1, d = hoy.getDate();
  const n = Math.ceil(m / 3);
  const primerMes = (n - 1) * 3 + 1;
  if (m === primerMes && d <= 20) return n === 1 ? `${y - 1}-T4` : `${y}-T${n - 1}`;
  return `${y}-T${n}`;
}
const enRango = (f, R) => !!f && String(f).slice(0, 10) >= R.from && String(f).slice(0, 10) <= R.to;
const fechaDe = c => c.fecha || (c.createdAt ? new Date(c.createdAt).toISOString().slice(0, 10) : null);

async function emitidas(R) {
  const stel = require('./stelorder');
  const [mapa, facturas] = await Promise.all([stel.getAllOrdinaryInvoices ? stel.getAllOrdinaryInvoices() : {}, stel.getInvoices()]);
  const porId = {}; (facturas || []).forEach(f => { porId[String(f.id)] = f; });
  const out = [];
  for (const [id, o] of Object.entries(mapa || {})) {
    if (!enRango(o.date, R)) continue;
    const f = porId[id] || {};
    const total = o.total != null ? o.total : (f.totalAmount != null ? r2(f.totalAmount) : null);
    out.push({ id, numero: o.number || f.number || id, fecha: String(o.date).slice(0, 10), cliente: f.client || '—', total, base: o.base, iva: o.iva, retencion: o.retencion, cobrado: f.paidAmount != null ? r2(f.paidAmount) : null, pdf: !!o.pdfPath, _pdfPath: o.pdfPath || null });
  }
  return out.sort((a, b) => a.fecha.localeCompare(b.fecha));
}

async function recibidas(R) {
  const stel = require('./stelorder');
  const [fp, gastos] = await Promise.all([stel.getPurchaseInvoices(), stel.getExpenses().catch(() => [])]);
  const facturas = (fp || []).filter(x => enRango(x.date, R)).map(x => ({ id: x.id, tipo: 'factura', numero: x.number, refProveedor: x.extraReference || '', fecha: String(x.date).slice(0, 10), proveedor: x.supplier, total: r2(x.total), base: x.base, iva: x.iva, retencion: x.retencion, pagado: r2(x.paid), pendiente: r2(x.pending) }));
  const gas = (gastos || []).filter(x => enRango(x.date, R)).map(x => ({ id: x.id, tipo: 'gasto', numero: x.number, refProveedor: '', fecha: String(x.date).slice(0, 10), proveedor: x.supplier, total: r2(x.amount), base: null, iva: null, retencion: null, concepto: x.description }));
  return [...facturas, ...gas].sort((a, b) => a.fecha.localeCompare(b.fecha));
}

async function pendientes(R) {
  const db = await getDB();
  const comprasCol = db.collection('compras');
  const todas = await comprasCol.find({ estado: { $ne: 'descartada' } }).project({ lineas: 0 }).toArray();
  const delTrim = todas.filter(c => enRango(fechaDe(c), R));
  const fila = c => ({ id: String(c._id), tipo: c.tipo, proveedor: c.proveedor || null, numero: c.numero || null, fecha: fechaDe(c), total: c.total != null ? r2(c.total) : null, origen: c.origen || 'app', obraRef: c.obraRef || null, quien: (c.subidaPor && c.subidaPor.name) || null, leida: !!(c.ia && c.ia.ok) });
  const porRevisar = delTrim.filter(c => c.estado === 'por_revisar').map(fila);
  // Revisadas (factura/ticket) que no han ido a contabilidad (StelOrder): las de correo/WhatsApp ya van por su camino.
  const sinContabilidad = delTrim.filter(c => c.estado === 'revisada' && ['factura', 'ticket'].includes(c.tipo) && !c.enviadaStel && !['email', 'whatsapp'].includes(c.origen)).map(fila);
  const albaranes = delTrim.filter(c => c.estado === 'revisada' && c.tipo === 'albaran' && !c.facturaId).map(fila);

  // Correos de factura de proveedor del trimestre
  const correos = await db.collection('emails').find({ categoria: 'FACTURA_PROVEEDOR', fecha: { $gte: new Date(R.from), $lte: new Date(R.to + 'T23:59:59Z') } })
    .project({ de: 1, asunto: 1, fecha: 1, tieneAdjuntos: 1, adjuntos: 1, compraId: 1, estado: 1 }).sort({ fecha: 1 }).toArray();
  const idsCompra = correos.map(e => e.compraId).filter(Boolean);
  const estadoCompra = {};
  if (idsCompra.length) {
    const { ObjectId } = require('mongodb');
    const cs = await comprasCol.find({ _id: { $in: idsCompra.filter(x => /^[a-f0-9]{24}$/.test(String(x))).map(x => new ObjectId(String(x))) } }).project({ estado: 1 }).toArray();
    cs.forEach(c => { estadoCompra[String(c._id)] = c.estado; });
  }
  const correoFila = e => ({ id: String(e._id), de: String(e.de || '').replace(/<.*>/, '').trim() || e.de, asunto: e.asunto, fecha: e.fecha ? new Date(e.fecha).toISOString().slice(0, 10) : null, compraId: e.compraId || null, estadoCompra: e.compraId ? (estadoCompra[String(e.compraId)] || 'desconocido') : null });
  const correosSinAdjunto = correos.filter(e => !e.tieneAdjuntos).map(correoFila);
  const correosSinRevisar = correos.filter(e => e.tieneAdjuntos && e.compraId && estadoCompra[String(e.compraId)] === 'por_revisar').map(correoFila);

  // Banco: ¿el último extracto subido cubre hasta el final del trimestre?
  let banco = null;
  try {
    // El extracto que llega más lejos (no el último subido: se pueden subir rangos viejos).
    const u = await db.collection('bancoImports').find({ 'periodo.hasta': { $ne: null } }).sort({ 'periodo.hasta': -1 }).limit(1).next();
    const hasta = u && u.periodo ? u.periodo.hasta : null;
    banco = { ultimoImport: u ? u.fecha : null, archivo: u ? u.archivo : null, hasta, cubre: !!(hasta && hasta >= R.to) };
  } catch (e) { banco = { error: e.message }; }

  return { porRevisar, sinContabilidad, albaranes, correosSinAdjunto, correosSinRevisar, totalCorreosFactura: correos.length, banco };
}

function sumar(lista, k) { return r2(lista.reduce((s, x) => s + (Number(x[k]) || 0), 0)); }
function conocido(lista, k) { return lista.length ? lista.filter(x => x[k] != null).length / lista.length : 0; }

async function estado(q) {
  const R = rango(q || trimestrePorDefecto());
  const [em, rec, pen] = await Promise.all([
    emitidas(R).catch(e => ({ error: e.message })),
    recibidas(R).catch(e => ({ error: e.message })),
    pendientes(R),
  ]);
  const emL = Array.isArray(em) ? em : [], recL = Array.isArray(rec) ? rec : [];
  const resumen = {
    emitidas: { n: emL.length, total: sumar(emL, 'total'), base: sumar(emL, 'base'), iva: sumar(emL, 'iva'), ivaConocido: conocido(emL, 'iva') },
    recibidas: { n: recL.length, total: sumar(recL, 'total'), base: sumar(recL, 'base'), iva: sumar(recL, 'iva'), ivaConocido: conocido(recL.filter(x => x.tipo === 'factura'), 'iva') },
  };
  const nPend = pen.porRevisar.length + pen.sinContabilidad.length + pen.correosSinAdjunto.length + pen.correosSinRevisar.length + (pen.banco && !pen.banco.cubre ? 1 : 0);
  return {
    ...R, generado: new Date(), resumen, nPendientes: nPend,
    emitidas: emL.map(({ _pdfPath, ...x }) => x), recibidas: recL, pendientes: pen,
    errores: { emitidas: Array.isArray(em) ? null : em.error, recibidas: Array.isArray(rec) ? null : rec.error },
  };
}

// Excel para la gestoría: Resumen, Emitidas, Recibidas y Pendientes.
async function excel(q) {
  const XLSX = require('xlsx');
  const e = await estado(q);
  const wb = XLSX.utils.book_new();
  const res = [
    ['Corp Projects Holding SL — ' + e.label, ''], ['Periodo', `${e.from} a ${e.to}`], ['Generado', new Date().toLocaleString('es-ES')], [],
    ['', 'Nº', 'Base', 'IVA', 'Total'],
    ['Facturas emitidas', e.resumen.emitidas.n, e.resumen.emitidas.base, e.resumen.emitidas.iva, e.resumen.emitidas.total],
    ['Facturas y gastos recibidos', e.resumen.recibidas.n, e.resumen.recibidas.base, e.resumen.recibidas.iva, e.resumen.recibidas.total],
    [], ['Pendientes de revisar antes de cerrar', e.nPendientes],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(res), 'Resumen');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(e.emitidas.map(x => ({ Fecha: x.fecha, Número: x.numero, Cliente: x.cliente, Base: x.base, IVA: x.iva, Retención: x.retencion, Total: x.total, Cobrado: x.cobrado }))), 'Emitidas');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(e.recibidas.map(x => ({ Fecha: x.fecha, Tipo: x.tipo, Número: x.numero, 'Nº proveedor': x.refProveedor, Proveedor: x.proveedor, Base: x.base, IVA: x.iva, Retención: x.retencion, Total: x.total, Pendiente: x.pendiente }))), 'Recibidas');
  const p = e.pendientes;
  const filas = [
    ...p.porRevisar.map(x => ({ Qué: 'Compra por revisar', Fecha: x.fecha, Proveedor: x.proveedor, Número: x.numero, Total: x.total, Origen: x.origen })),
    ...p.sinContabilidad.map(x => ({ Qué: 'Revisada sin pasar a StelOrder', Fecha: x.fecha, Proveedor: x.proveedor, Número: x.numero, Total: x.total, Origen: x.origen })),
    ...p.correosSinAdjunto.map(x => ({ Qué: 'Correo de factura SIN PDF', Fecha: x.fecha, Proveedor: x.de, Número: x.asunto, Total: null, Origen: 'correo' })),
    ...p.correosSinRevisar.map(x => ({ Qué: 'Factura de correo por revisar', Fecha: x.fecha, Proveedor: x.de, Número: x.asunto, Total: null, Origen: 'correo' })),
    ...p.albaranes.map(x => ({ Qué: 'Albarán sin factura (informativo)', Fecha: x.fecha, Proveedor: x.proveedor, Número: x.numero, Total: x.total, Origen: x.origen })),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(filas.length ? filas : [{ Qué: 'Nada pendiente' }]), 'Pendientes');
  return { buf: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), nombre: `Corp_${e.q}_gestoria.xlsx` };
}

// ── Paquete para la gestoría con el MISMO formato que el 2º trimestre (Drive) ──
//   1_Facturas_emitidas/07_Julio/2026-FACTURA-FAC00950-Cliente.pdf  (ZIP)
//   3_Resumen_facturas_emitidas_Q3.xlsx
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const carpetaMes = f => { const m = Number(String(f).slice(5, 7)); return `${String(m).padStart(2, '0')}_${MESES[m - 1]}`; };
const limpioArchivo = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9.\- ]+/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').slice(0, 80);

async function resumenEmitidasXlsx(q) {
  const XLSX = require('xlsx');
  const R = rango(q || trimestrePorDefecto());
  const em = (await emitidas(R)).sort((a, b) => a.fecha.localeCompare(b.fecha) || String(a.numero).localeCompare(String(b.numero)));
  const filas = [
    [`Facturas emitidas Q${R.n}`], [`CORP PROJECTS HOLDING SL — Facturas emitidas ${R.n}T ${R.y}`], ['CIF B09899253 · para Som Assessors'],
    ['Referencia', 'Fecha', 'Cliente', 'Base', 'IVA', 'Total', 'Cobrado', 'Pendiente'],
  ];
  const sub = () => ({ base: 0, iva: 0, total: 0, cobrado: 0, pendiente: 0 });
  let mesActual = null, s = sub(); const T = sub();
  const cerrarMes = () => { if (mesActual) filas.push(['', '', `Subtotal ${MESES[Number(mesActual) - 1].toUpperCase()}`, r2(s.base), r2(s.iva), r2(s.total), r2(s.cobrado), r2(s.pendiente)]); };
  for (const f of em) {
    const m = f.fecha.slice(5, 7);
    if (m !== mesActual) { cerrarMes(); mesActual = m; s = sub(); }
    const pend = f.total != null && f.cobrado != null ? r2(f.total - f.cobrado) : null;
    filas.push([f.numero, f.fecha, f.cliente, f.base, f.iva, f.total, f.cobrado, pend]);
    for (const [k, v] of [['base', f.base], ['iva', f.iva], ['total', f.total], ['cobrado', f.cobrado], ['pendiente', pend]]) { s[k] += Number(v) || 0; T[k] += Number(v) || 0; }
  }
  cerrarMes();
  filas.push(['', '', 'TOTAL TRIMESTRE', r2(T.base), r2(T.iva), r2(T.total), r2(T.cobrado), r2(T.pendiente)]);
  const ws = XLSX.utils.aoa_to_sheet(filas);
  for (const addr of Object.keys(ws)) { const c = ws[addr]; if (addr[0] !== '!' && c.t === 'n' && /^[D-H]\d+$/.test(addr)) c.z = '#,##0.00 "€"'; }
  ws['!cols'] = [{ wch: 12 }, { wch: 11 }, { wch: 44 }, { wch: 13 }, { wch: 12 }, { wch: 13 }, { wch: 13 }, { wch: 13 }];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, `Emitidas Q${R.n}`);
  const faltanIva = em.filter(f => f.iva == null).length;
  return { buf: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), nombre: `3_Resumen_facturas_emitidas_Q${R.n}.xlsx`, faltanIva };
}

// ZIP con los PDF oficiales de StelOrder, en carpetas por mes y con el nombre del 2º trimestre.
async function zipEmitidas(q) {
  const R = rango(q || trimestrePorDefecto());
  const { archivos, fallos } = await _pdfsEmitidas(R);
  return { buf: require('./zip').crearZip(archivos), nombre: `1_Facturas_emitidas_Q${R.n}_${R.y}.zip`, n: archivos.length - (fallos.length ? 1 : 0), fallos };
}
async function zipEmitidasArchivos(q) { return (await _pdfsEmitidas(rango(q))).archivos; }
async function _pdfsEmitidas(R) {
  const em = await emitidas(R);
  const archivos = [], fallos = [];
  const cola = em.slice();
  async function trabajador() {
    for (let f = cola.shift(); f; f = cola.shift()) {
      if (!f._pdfPath) { fallos.push(`${f.numero} (sin PDF en StelOrder)`); continue; }
      try {
        const c = new AbortController(); const t = setTimeout(() => c.abort(), 25000);
        const r = await fetch(f._pdfPath, { signal: c.signal }); clearTimeout(t);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const datos = Buffer.from(await r.arrayBuffer());
        if (datos.slice(0, 4).toString() !== '%PDF') throw new Error('no es un PDF');
        archivos.push({ nombre: `1_Facturas_emitidas/${carpetaMes(f.fecha)}/${R.y}-FACTURA-${limpioArchivo(f.numero)}-${limpioArchivo(f.cliente)}.pdf`, datos });
      } catch (e) { fallos.push(`${f.numero} (${e.message})`); }
    }
  }
  await Promise.all([trabajador(), trabajador(), trabajador()]);
  if (fallos.length) archivos.push({ nombre: '1_Facturas_emitidas/_FALTAN.txt', datos: Buffer.from('No se pudieron descargar:\n' + fallos.join('\n') + '\n', 'utf8') });
  archivos.sort((a, b) => a.nombre.localeCompare(b.nombre));
  return { archivos, fallos };
}

// Facturas confirmadas en Compras (fotos y PDF del correo), listas para la gestoría: un PDF por factura en
// carpetas por mes (las fotos se juntan en un PDF), más un Excel índice con cómo se pagó cada una.
// Entran las revisadas y las del archivo del correo; las que siguen por revisar van aparte en un aviso.
async function _archivosRecibidasCompras(R, carpeta = '2_Facturas_recibidas') {
  const XLSX = require('xlsx');
  const compras = require('./compras');
  const fw = require('./facturaWhatsApp');
  const db = await getDB();
  const cs = await db.collection('compras').find({ estado: { $in: ['revisada', 'archivo', 'por_revisar'] }, tipo: { $in: ['factura', 'ticket', 'devolucion'] }, fecha: { $gte: R.from, $lte: R.to }, duplicadoDe: null })
    .project({ lineas: 0, ia: 0 }).sort({ fecha: 1, proveedor: 1 }).toArray();
  const listas = cs.filter(c => c.estado !== 'por_revisar'), pendientes = cs.filter(c => c.estado === 'por_revisar');
  const [pagos, stelRec] = await Promise.all([mapaPagos().catch(() => null), todasRecibidas().catch(() => [])]);
  // La misma factura ya pasada a StelOrder (mismo nº de proveedor y total): así no se cuenta dos veces.
  const dig = x => String(x || '').replace(/\D/g, '');
  const gemela = c => { const d = dig(c.numero); return d.length < 4 ? null : stelRec.find(x => dig(x.refProveedor) === d && Math.abs(Math.abs(x.total) - Math.abs(c.total || 0)) < 0.05) || null; };
  const archivos = [], filas = [], vistos = new Set();
  for (const c of listas) {
    const fotos = await compras.fotosDe(c._id);
    const buf = f => Buffer.from(f.data.buffer || f.data);
    const base0 = `${c.fecha}_${limpioArchivo(c.proveedor || 'Proveedor')}${c.numero ? '_' + limpioArchivo(c.numero) : ''}`;
    let base = base0;
    for (let i = 2; vistos.has(base); i++) base = `${base0}_(${i})`;
    vistos.add(base);
    const dir = `${carpeta}/${carpetaMes(c.fecha)}`, nombres = [];
    const pdfs = fotos.filter(f => /pdf/i.test(f.mimetype || '')), imgs = fotos.filter(f => /^image\//.test(f.mimetype || ''));
    pdfs.forEach((f, i) => { const n = `${base}${pdfs.length > 1 || imgs.length ? '_' + (i + 1) : ''}.pdf`; archivos.push({ nombre: `${dir}/${n}`, datos: buf(f) }); nombres.push(n); });
    if (imgs.length) {
      let pdf = null; try { pdf = await fw.fotosAPdf(imgs.map(f => ({ data: buf(f).toString('base64'), media_type: f.mimetype }))); } catch (e) { pdf = null; }
      if (pdf) { const n = `${base}${pdfs.length ? '_fotos' : ''}.pdf`; archivos.push({ nombre: `${dir}/${n}`, datos: pdf }); nombres.push(n); }
      else imgs.forEach((f, i) => { const n = `${base}_${i + 1}.${(f.mimetype || 'image/jpeg').split('/')[1].replace('jpeg', 'jpg')}`; archivos.push({ nombre: `${dir}/${n}`, datos: buf(f) }); nombres.push(n); });
    }
    const gm = gemela(c);
    const pg = pagos ? (pagos.porDoc.get(String(c._id)) || (gm && pagos.porDoc.get(String(gm.numero))) || []) : [];
    filas.push({ Fecha: c.fecha.split('-').reverse().join('/'), Proveedor: c.proveedor || '', 'Nº factura': c.numero || '', Tipo: c.tipo === 'devolucion' ? 'Abono' : c.tipo === 'ticket' ? 'Ticket' : 'Factura',
      Base: c.base != null ? r2(c.base) : null, IVA: c.iva != null ? r2(c.iva) : null, Total: c.total != null ? r2(c.total) : null,
      Destino: c.destino === 'obra' ? `Obra ${c.obraRef || ''}`.trim() : c.destino === 'varias' ? (c.reparto || []).map(p => p.obraRef).join(' + ') : c.destino === 'lineas' ? ['Por líneas', ...(c.reparto || []).map(p => p.obraRef), ...(c.repartoOtros || []).map(o => ({ herramientas: 'herramientas', ropa: 'EPIs', almacen: 'almacén', general: 'gasto general' })[o.t] || o.t)].join(' · ') : c.destino === 'general' ? `Gasto general${c.categoria ? ' · ' + c.categoria : ''}` : (c.destino || ''),
      Pagada: pg.length ? pg.map(p => `${p.fecha.split('-').reverse().join('/')} ${p.origen}${p.persona ? ' (' + p.persona + ')' : ''}`).join(' + ') : 'Sin pago encontrado',
      'En StelOrder': gm ? `Sí (${gm.numero})` : 'No', Archivo: nombres.join(', ') || 'SIN ARCHIVO', Origen: c.estado === 'archivo' ? 'Correo' : ({ email: 'Correo', whatsapp: 'WhatsApp' })[c.origen] || 'Foto en Compras' });
  }
  const ws = XLSX.utils.json_to_sheet(filas.length ? filas : [{ Proveedor: 'No hay facturas de Compras en este trimestre' }]);
  for (const k of Object.keys(ws)) { const cel = ws[k]; if (k[0] !== '!' && cel.t === 'n' && /^[EFG]\d+$/.test(k)) cel.z = '#,##0.00 "€"'; }
  ws['!cols'] = [{ wch: 11 }, { wch: 32 }, { wch: 18 }, { wch: 8 }, { wch: 11 }, { wch: 10 }, { wch: 11 }, { wch: 28 }, { wch: 40 }, { wch: 18 }, { wch: 50 }, { wch: 14 }];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, `Compras Q${R.n}`);
  archivos.push({ nombre: `${carpeta}/Indice_facturas_de_Compras_Q${R.n}.xlsx`, datos: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) });
  if (pendientes.length) archivos.push({ nombre: `${carpeta}/_POR_REVISAR_EN_COMPRAS.txt`, datos: Buffer.from(`${pendientes.length === 1 ? 'Esta factura del trimestre sigue' : `Estas ${pendientes.length} facturas del trimestre siguen`} sin revisar en Compras y NO va(n) en esta carpeta.\nRevísalas y vuelve a descargar:\n\n` + pendientes.map(c => `${c.fecha}  ${c.proveedor || '?'}  ${c.numero || ''}  ${c.total != null ? c.total + ' €' : ''}`).join('\n') + '\n', 'utf8') });
  archivos.sort((a, b) => a.nombre.localeCompare(b.nombre));
  return { archivos, n: filas.length, pendientes: pendientes.length };
}
async function zipRecibidasCompras(q) {
  const R = rango(q || trimestrePorDefecto());
  const { archivos, n, pendientes } = await _archivosRecibidasCompras(R);
  return { buf: require('./zip').crearZip(archivos), nombre: `2_Facturas_recibidas_Q${R.n}_${R.y}.zip`, n, pendientes };
}

// ── PUNTEO DEL BANCO y documentos para la gestoría ───────────────────────────
// Todas las facturas (no solo las del trimestre): se cobran y pagan con retraso.
async function todasEmitidas() {
  const stel = require('./stelorder');
  const [mapa, facturas] = await Promise.all([stel.getAllOrdinaryInvoices(), stel.getInvoices()]);
  const porId = {}; (facturas || []).forEach(f => { porId[String(f.id)] = f; });
  return Object.entries(mapa || {}).filter(([, o]) => o.date).map(([id, o]) => {
    const f = porId[id] || {};
    const total = o.total != null ? o.total : (f.totalAmount != null ? r2(f.totalAmount) : 0);
    return { id, numero: o.number || f.number || id, fecha: String(o.date).slice(0, 10), cliente: f.client || '—', total, base: o.base, iva: o.iva, pendiente: f.paidAmount != null ? r2(total - f.paidAmount) : null };
  });
}
async function todasRecibidas() {
  const fp = await require('./stelorder').getPurchaseInvoices();
  return (fp || []).filter(x => x.date).map(x => ({ id: x.id, numero: x.number, refProveedor: x.extraReference || '', proveedor: x.supplier, fecha: String(x.date).slice(0, 10), total: r2(x.total), base: x.base, iva: x.iva, pendienteStel: x.pending != null ? r2(x.pending) : null }));
}
// Facturas para el punteo: las de StelOrder + las de Compras (correo, fotos, archivo) que NO estén ya en
// StelOrder. Así lo que llega al correo se cruza con el banco aunque nadie lo haya pasado a StelOrder.
// Misma factura = mismo nº (solo dígitos) o mismo importe ±2 cént. con fechas a ≤7 días y proveedor parecido.
async function recibidasPunteo(stel) {
  const db = await getDB();
  const dig = x => String(x || '').replace(/\D/g, '');
  const n = x => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const palabra = x => (n(x).match(/[a-z0-9]{4,}/g) || []).filter(w => !/^(s\.?l|sociedad|girona|distribucions?|materials?|derivats?)$/.test(w));
  const pareceProv = (a, b) => { const pa = palabra(a), pb = palabra(b); return pa.some(w => pb.includes(w)); };
  const cs = await db.collection('compras').find({ estado: { $ne: 'descartada' }, tipo: { $in: ['factura', 'devolucion', 'ticket'] }, total: { $ne: null }, fecha: { $ne: null }, duplicadoDe: null })
    .project({ proveedor: 1, razonSocial: 1, numero: 1, fecha: 1, total: 1, base: 1, iva: 1, estado: 1 }).toArray();
  const out = [];
  for (const c of cs) {
    const dc = dig(c.numero);
    const yaEsta = stel.some(r => {
      const dr = dig(r.refProveedor);
      if (dc.length >= 4 && dr.length >= 4 && (dc === dr || (Math.min(dc.length, dr.length) >= 5 && (dc.endsWith(dr) || dr.endsWith(dc)))) && (pareceProv(c.proveedor, r.proveedor) || Math.abs(r.total - c.total) < 0.05)) return true;
      return Math.abs(r.total - c.total) < 0.02 && Math.abs(dias2(r.fecha, c.fecha)) <= 7 && pareceProv(c.proveedor, r.proveedor);
    });
    if (yaEsta) continue;
    if (/corp\s*projects/i.test(c.proveedor || '')) continue;   // factura nuestra que llegó al correo: no es de proveedor
    // Mismo nombre que en StelOrder («Oliveras» → «OLIVERAS DERIVATS I MATERIALS, SLU») para que el motor
    // junte sus facturas con las de StelOrder al cuadrar un recibo.
    const alias = c.razonSocial && !/corp\.?\s*projects/i.test(c.razonSocial) && !pareceProv(c.razonSocial, c.proveedor) ? c.razonSocial : null;   // «9electric» = Rachid Ayada
    const nombreStel = (stel.find(r => pareceProv(c.proveedor, r.proveedor)) || (alias && stel.find(r => pareceProv(alias, r.proveedor))) || {}).proveedor;
    out.push({ id: 'c:' + String(c._id), compraId: String(c._id), numero: c.numero || 'Compra', refProveedor: c.numero || '', proveedor: nombreStel || c.proveedor || '', alias, fecha: c.fecha, total: r2(c.total), base: c.base, iva: c.iva, pendienteStel: null, deCompras: true });
  }
  return [...stel, ...out];
}
async function movimientosBanco(R) {
  const db = await getDB();
  const ms = await db.collection('bancoMovimientos').find({ fechaOperacion: { $gte: R.from, $lte: R.to } }).sort({ fechaOperacion: 1 }).toArray();
  return ms.map(m => ({ id: String(m._id), fecha: m.fechaOperacion, concepto: m.concepto, importe: m.importe, saldo: m.saldo, codigo: m.codigo, categoria: m.categoria, contraparte: m.contraparte, origen: 'Cuenta Santander', persona: m.categoria === 'nomina' ? m.contraparte : null }));
}

async function punteo(q) {
  const C = require('./conciliacion');
  const R = rango(q || trimestrePorDefecto());
  const [movsBanco, movsTarjeta, em, recStel] = await Promise.all([movimientosBanco(R), require('./tarjetas').movimientosPunteo(R).catch(() => []), todasEmitidas(), todasRecibidas()]);
  const rec = await recibidasPunteo(recStel).catch(e => { console.warn('[Trimestre] compras en el punteo:', e.message); return recStel; });
  const movs = [...movsBanco, ...movsTarjeta];
  try {
    const db = await getDB();
    const man = await db.collection('punteoManual').find({ _id: { $in: movs.map(m => m.id) } }).toArray();
    const porId = {}; man.forEach(x => { porId[x._id] = x; });
    movs.forEach(m => { if (porId[m.id]) m.manual = porId[m.id]; });
  } catch (e) {}
  const res = C.conciliar({ movimientos: movs, emitidas: em, recibidas: rec });
  const recTrim = rec.filter(r => enRango(r.fecha, R));
  let sinPago = recTrim.filter(r => !res.recibidasUsadas.has(r.id) && r.total > 0);
  // ¿Se pagaron DESPUÉS del trimestre? Se mira en los extractos ya subidos posteriores.
  const hoyISO = new Date().toISOString().slice(0, 10);
  const pagadasDespues = {};
  if (sinPago.length && hoyISO > R.to) {
    const Rpost = { from: new Date(Date.UTC(Number(R.to.slice(0, 4)), Number(R.to.slice(5, 7)) - 1, Number(R.to.slice(8, 10)) + 1)).toISOString().slice(0, 10), to: hoyISO };
    const [b2, t2] = await Promise.all([movimientosBanco(Rpost), require('./tarjetas').movimientosPunteo(Rpost).catch(() => [])]);
    if (b2.length || t2.length) {
      const res2 = C.conciliar({ movimientos: [...b2, ...t2], emitidas: [], recibidas: sinPago });
      for (const f of res2.filas) if (f.estado === 'punteado') for (const d of f.docs) pagadasDespues[d.ref] = f.fecha;
    }
  }
  const fechasExtracto = [...movsBanco, ...movsTarjeta].map(m => m.fecha).filter(Boolean).sort();
  const extractoHasta = fechasExtracto.length ? fechasExtracto[fechasExtracto.length - 1] : null;
  const provs = {};
  for (const r of sinPago) {
    const g = (provs[r.proveedor] = provs[r.proveedor] || { proveedor: r.proveedor, total: 0, n: 0, facturas: [] });
    const despues = pagadasDespues[r.numero] || null;
    g.facturas.push({ numero: r.numero, refProveedor: r.refProveedor, fecha: r.fecha, total: r.total, pagadaDespues: despues, pendienteStel: r.pendienteStel });
    if (!despues) { g.total = r2(g.total + r.total); g.n++; }
  }
  const pendientesPago = Object.values(provs).filter(g => g.n > 0 || g.facturas.length).sort((a, b) => b.total - a.total);
  const avisos = C.avisosRecibidas(recTrim.filter(r => !r.deCompras));   // duplicados / IVA 0 %: solo lo de StelOrder
  const porOrigen = {};
  for (const f of res.filas) { const o = (porOrigen[f.origen] = porOrigen[f.origen] || { origen: f.origen, persona: null, n: 0, punteados: 0, sinDocumento: 0, importeSin: 0 }); o.n++; if (f.estado === 'punteado') o.punteados++; if (f.estado === 'sin_documento' && f.importe < 0) { o.sinDocumento++; o.importeSin = r2(o.importeSin - f.importe); } if (f.persona && f.origen !== 'Cuenta Santander') o.persona = f.persona; }
  // Lo que falta, agrupado por comercio (para buscar la factura y subirla desde aquí).
  const grupos = {};
  for (const f of res.filas.filter(x => x.estado === 'sin_documento' || (x.estado === 'revisar' && x.importe < 0 && x.tipo !== 'efectivo' && x.tipo !== 'prestamo'))) {
    const k = f.importe > 0 ? 'Cobros sin factura identificada' : comercio(f.concepto);
    const gk = k.toLowerCase();
    const g = (grupos[gk] = grupos[gk] || { comercio: k, cobros: f.importe > 0, n: 0, importe: 0, movs: [] });
    g.n++; g.importe = r2(g.importe + Math.abs(f.importe));
    g.movs.push({ id: f.id, fecha: f.fecha, importe: f.importe, persona: f.persona || null, origen: f.origen || null, concepto: f.concepto, nota: f.nota || null, candidatas: f.candidatas || null });
  }
  const faltan = Object.values(grupos).sort((a, b) => (a.cobros - b.cobros) || b.importe - a.importe);
  const fila = f => ({ id: f.id, fecha: f.fecha, importe: f.importe, concepto: f.concepto, origen: f.origen || null, persona: f.persona || null, nota: f.manual && f.manual.nota || null, por: f.manual && f.manual.por || null, obraRef: f.manual && f.manual.obraRef || null });
  const porPersona = {};
  for (const f of res.filas.filter(x => x.manual && x.manual.decision === 'personal')) {
    const k = f.persona || 'Sin asignar';
    const g = (porPersona[k] = porPersona[k] || { persona: k, total: 0, movs: [] }); g.total = r2(g.total - f.importe); g.movs.push(fila(f));
  }
  const personales = Object.values(porPersona).sort((a, b) => b.total - a.total);
  const deObra = res.filas.filter(x => x.manual && x.manual.decision === 'obra').map(fila);
  const sinFacturaOk = res.filas.filter(x => x.manual && x.manual.decision === 'sin_factura').map(fila);
  const porEmpresa = {};
  for (const f of res.filas.filter(x => x.manual && x.manual.decision === 'tercero')) {
    const k = f.manual.empresa || 'Otra empresa';
    const g = (porEmpresa[k] = porEmpresa[k] || { empresa: k, entradas: 0, salidas: 0, saldo: 0, movs: [] });
    if (f.importe > 0) g.entradas = r2(g.entradas + f.importe); else g.salidas = r2(g.salidas - f.importe);
    g.saldo = r2(g.entradas - g.salidas); g.movs.push(fila(f));
  }
  const terceros = Object.values(porEmpresa);
  // Cuenta corriente con cada empresa desde el principio (todos los trimestres): lo que entró y salió
  // por su cuenta, para saber quién debe a quién al final.
  const cuentasEmpresas = [];
  const personalesMeses = [];
  const dietas = [];
  try {
    const db = await getDB();
    const todos = await db.collection('punteoManual').find({ decision: 'tercero' }).sort({ fecha: 1 }).toArray();
    const acc = {};
    for (const x of todos) {
      const k = x.empresa || 'Otra empresa';
      const g = (acc[k] = acc[k] || { empresa: k, entradas: 0, salidas: 0, saldo: 0, movs: [] });
      const imp = Number(x.importe) || 0;
      if (imp > 0) g.entradas = r2(g.entradas + imp); else g.salidas = r2(g.salidas - imp);
      g.saldo = r2(g.entradas - g.salidas);
      g.movs.push({ id: String(x._id), fecha: x.fecha, importe: imp, concepto: x.concepto, origen: x.origen || null, persona: x.persona || null, nota: x.nota || null, por: x.por || null, esteTrimestre: !!(x.fecha && x.fecha >= R.from && x.fecha <= R.to) });
    }
    cuentasEmpresas.push(...Object.values(acc));
    // Gastos personales por persona y mes, desde el principio (no solo este trimestre).
    const pers = await db.collection('punteoManual').find({ decision: 'personal' }).sort({ fecha: 1 }).toArray();
    const pp = {};
    for (const x of pers) {
      const k = x.persona || 'Sin asignar', mes = String(x.fecha || '').slice(0, 7) || '—';
      const g = (pp[k] = pp[k] || { persona: k, total: 0, n: 0, meses: {} });
      const m = (g.meses[mes] = g.meses[mes] || { mes, total: 0, movs: [] });
      const imp = -(Number(x.importe) || 0);
      g.total = r2(g.total + imp); g.n++; m.total = r2(m.total + imp);
      m.movs.push({ id: String(x._id), fecha: x.fecha, importe: x.importe, concepto: x.concepto, origen: x.origen || null, persona: x.persona || null, nota: x.nota || null, por: x.por || null });
    }
    personalesMeses.push(...Object.values(pp).map(g => ({ ...g, meses: Object.values(g.meses).sort((a, b) => b.mes.localeCompare(a.mes)) })).sort((a, b) => b.total - a.total));
    // Comidas de trabajo (dietas) por mes, con lo que sale por persona y día.
    const dts = await db.collection('punteoManual').find({ decision: 'dieta' }).sort({ fecha: 1 }).toArray();
    const dm = {};
    for (const x of dts) {
      const mes = String(x.fecha || '').slice(0, 7) || '—';
      const g = (dm[mes] = dm[mes] || { mes, total: 0, movs: [] });
      g.total = r2(g.total - (Number(x.importe) || 0));
      g.movs.push({ id: String(x._id), fecha: x.fecha, importe: x.importe, concepto: x.concepto, origen: x.origen || null, persona: x.persona || null, personas: x.personas || [], porPersona: x.porPersona || null, obraRef: x.obraRef || null, nota: x.nota || null, por: x.por || null, esteTrimestre: !!(x.fecha && x.fecha >= R.from && x.fecha <= R.to) });
    }
    dietas.push(...Object.values(dm).sort((a, b) => b.mes.localeCompare(a.mes)));
  } catch (e) { console.warn('[Trimestre] cuentas con empresas:', e.message); }
  const porFacturar = res.filas.filter(x => x.manual && x.manual.decision === 'facturar').map(fila);
  const emitidasPendientes = em.filter(e => e.pendiente != null && e.pendiente > 0.01 && dias2(R.to, e.fecha) <= 400).sort((a, b) => b.fecha.localeCompare(a.fecha)).slice(0, 300)
    .map(e => ({ id: e.id, numero: e.numero, cliente: e.cliente, fecha: e.fecha, total: e.total, pendiente: e.pendiente }));
  return { ...R, resumen: res.resumen, filas: res.filas, faltan, pendientesPago, extractoHasta, personales, deObra, sinFacturaOk, terceros, porFacturar, cuentasEmpresas, personalesMeses, dietas, emitidasPendientes, recibidasSinPago: sinPago, avisos, hayBanco: movsBanco.length > 0, hayTarjetas: movsTarjeta.length > 0, porOrigen: Object.values(porOrigen) };
}

// Nombre corto del comercio a partir del concepto (para agrupar «facturas a pedir»).
function comercio(concepto) {
  // Solo el nombre del comercio o persona: sin «Concepto…», «Nº Recibo…» ni «Ref. Mandato…», que cambian
  // en cada pago y separaban en grupos distintos los pagos a la misma persona (Rachid, Oliveras…).
  return String(concepto || '').replace(/^(compra internet en|pago movil en|compra|transaccion contactless|recibo|transferencia( inmediata)? (a favor de|de))\s+/i, '')
    .replace(/[,.:]?\s+(concepto|n[º°o]\.?\s*recibo|ref\.?\s*mandato)\b.*$/i, '')
    .replace(/,?\s*(tarj\.?|tarjeta)\b.*$/i, '').replace(/\s*\(.*\)\s*$/, '').replace(/\s+(girona|gerona|salt|barcelona)\b.*$/i, '').trim().slice(0, 40).replace(/[\s,.;:\-]+$/, '') || '—';
}

const dias2 = (a, b) => Math.round((new Date(a + 'T12:00:00Z') - new Date(b + 'T12:00:00Z')) / 86400000);

// Resolver a mano un movimiento: subir su factura (va a Compras y queda casada) o decir que no lleva.
// Ticket subido por el trabajador desde su enlace (ticketsAviso): esa compra paga ese movimiento.
async function enlazarCompra(movId, compraId, por) {
  olvidarMapaPagos();
  const db = await getDB();
  let total = null, proveedor = null;
  try { const c = await require('./compras').getCompra(compraId); total = c.total != null ? r2(c.total) : null; proveedor = c.proveedor || null; } catch (e) {}
  const { ObjectId } = require('mongodb');
  let mov = null;
  try { mov = await db.collection('tarjetaMovimientos').findOne({ _id: new ObjectId(String(movId)) }) || await db.collection('bancoMovimientos').findOne({ _id: new ObjectId(String(movId)) }); } catch (e) {}
  const cuadra = total == null || !mov ? null : Math.abs(total - Math.abs(Number(mov.importe) || 0)) < 0.02;
  await quitarDeObra(db, movId);
  await db.collection('punteoManual').updateOne({ _id: String(movId) }, { $set: { compraId: String(compraId), proveedor, total, cuadra, decision: null, nota: null, obraId: null, obraRef: null, por: (por && por.name) || por || null, at: new Date() } }, { upsert: true });
  return { ok: true, cuadra };
}
async function justificar({ movId, archivo, decision, nota, obraId, mov = {}, por, extra = {} }) {
  olvidarMapaPagos();
  const db = await getDB();
  if (!movId) throw new Error('Falta el movimiento');
  if (archivo) {
    const fecha = String(mov.fecha || '').split('-').reverse().join('/');
    const notaC = `Factura del pago de ${Math.abs(Number(mov.importe) || 0).toFixed(2)} € del ${fecha} en ${comercio(mov.concepto)}${mov.persona ? ` (${mov.persona})` : ''} — subida desde el cierre del trimestre`;
    const r = await require('./compras').crear({ fotos: [{ data: archivo.buffer, mimetype: archivo.mimetype }], destino: 'obra', origen: 'punteo', nota: notaC.slice(0, 300), subidaPor: por, silencioso: por && por.kind === 'admin' });
    let total = null, proveedor = r.proveedor || null;
    try { const c = await require('./compras').getCompra(r.id); total = c.total != null ? r2(c.total) : null; proveedor = c.proveedor || proveedor; } catch (e) {}
    const cuadra = total == null ? null : Math.abs(total - Math.abs(Number(mov.importe) || 0)) < 0.02;
    await quitarDeObra(db, movId); // la factura ya cuenta por Compras
    await db.collection('punteoManual').updateOne({ _id: String(movId) }, { $set: { compraId: r.id, proveedor, total, cuadra, decision: null, nota: null, obraId: null, obraRef: null, por: por && por.name, at: new Date() } }, { upsert: true });
    return { ok: true, compraId: r.id, proveedor, total, cuadra, leida: r.leida };
  }
  if (!['personal', 'sin_factura', 'obra', 'tercero', 'factura', 'facturas', 'facturar', 'vehiculo', 'dieta'].includes(decision)) throw new Error('Decisión no válida');
  const datosMov = { persona: mov.persona || null, concepto: String(mov.concepto || '').slice(0, 200), fecha: mov.fecha || null, importe: Number(mov.importe) || 0, origen: mov.origen || null };
  const set = { decision, nota: String(nota || '').slice(0, 200) || null, compraId: null, obraId: null, obraRef: null, empresa: null, facturaNumero: null, cliente: null, total: null, por: por && por.name, at: new Date(), ...datosMov };
  if (decision === 'tercero') set.empresa = String(extra.empresa || 'JustFly Executive').trim().slice(0, 80);
  if (decision === 'vehiculo') {
    const { ObjectId } = require('mongodb');
    const v = extra.vehiculoId && /^[a-f0-9]{24}$/.test(String(extra.vehiculoId)) ? await db.collection('vehiculos').findOne({ _id: new ObjectId(String(extra.vehiculoId)) }, { projection: { nombre: 1, matricula: 1 } }) : null;
    if (!v) throw new Error('Elige el vehículo');
    set.vehiculoId = String(v._id); set.vehiculoNombre = v.nombre + (v.matricula ? ` (${v.matricula})` : '');
    set.categoria = extra.categoria || require('./vehiculos').sugerirCategoria(datosMov.concepto);
  }
  // Recibo que paga varias facturas de proveedor, elegidas a mano en el cierre.
  if (decision === 'facturas') {
    let ids = extra.recibidas; try { if (typeof ids === 'string') ids = JSON.parse(ids); } catch (e) { ids = []; }
    ids = (Array.isArray(ids) ? ids : []).map(String).slice(0, 40);
    const rec = (await recibidasPunteo(await todasRecibidas())).filter(r => ids.includes(String(r.id)));
    if (!rec.length) throw new Error('Elige al menos una factura');
    set.recibidas = rec.map(r => ({ id: r.id, ref: r.numero, refProveedor: r.refProveedor, tercero: r.proveedor, total: r.total, fecha: r.fecha }));
    set.total = r2(rec.reduce((a, r) => a + r.total, 0));
    set.parcial = extra.parcial === true || extra.parcial === '1' || extra.parcial === 'true';   // anticipo o resto: otra transferencia paga el resto
  }
  if (decision === 'factura') {
    const em = (await todasEmitidas()).find(e => String(e.id) === String(extra.facturaId) || e.numero === extra.facturaId);
    if (!em) throw new Error('Esa factura no está en StelOrder');
    set.facturaNumero = em.numero; set.cliente = em.cliente; set.total = em.total;
  }
  await quitarDeObra(db, movId); // si antes estaba en otra obra, se quita de allí
  // Comida de trabajo autorizada (dieta): gasto de personal de la empresa. Quién comió y, si se dice, de qué
  // obra (entonces cuenta en su coste). Exenta para el trabajador hasta 26,67 €/persona/día sin pernocta.
  if (decision === 'dieta') {
    let ps = extra.personas; try { if (typeof ps === 'string') ps = JSON.parse(ps); } catch (e) { ps = String(ps || '').split(','); }
    set.personas = (Array.isArray(ps) ? ps : []).map(x => String(x).trim()).filter(Boolean).slice(0, 20);
    if (!set.personas.length) throw new Error('Di quién comió');
    set.porPersona = r2(Math.abs(datosMov.importe) / set.personas.length);
    if (obraId && /^[a-f0-9]{24}$/.test(String(obraId))) {
      const { ObjectId } = require('mongodb');
      const o = await db.collection('obras').findOne({ _id: new ObjectId(String(obraId)) }, { projection: { reference: 1 } });
      if (o) {
        set.obraId = String(o._id); set.obraRef = o.reference;
        await db.collection('obras').updateOne({ _id: o._id }, { $set: { updatedAt: new Date() }, $push: { materiales: { id: 'punteo-' + String(movId), concepto: `Comida de trabajo: ${set.personas.join(', ')} — ${comercio(datosMov.concepto)} (${String(datosMov.fecha || '').split('-').reverse().join('/')})`, importe: r2(Math.abs(datosMov.importe)), fecha: datosMov.fecha, origen: 'punteo', movId: String(movId), sinFactura: true, at: new Date() } } });
      }
    }
  }
  if (decision === 'obra') {
    const { ObjectId } = require('mongodb');
    const o = obraId && /^[a-f0-9]{24}$/.test(String(obraId)) ? await db.collection('obras').findOne({ _id: new ObjectId(String(obraId)) }, { projection: { reference: 1 } }) : null;
    if (!o) throw new Error('Elige la obra');
    set.obraId = String(o._id); set.obraRef = o.reference;
    // Cuenta como material de la obra (rentabilidad); se quita si se deshace.
    await db.collection('obras').updateOne({ _id: o._id }, { $set: { updatedAt: new Date() }, $push: { materiales: { id: 'punteo-' + String(movId), concepto: `${comercio(datosMov.concepto)}${set.nota ? ' — ' + set.nota : ''} (tarjeta${datosMov.persona ? ' de ' + datosMov.persona : ''}, ${String(datosMov.fecha || '').split('-').reverse().join('/')})`, importe: r2(Math.abs(datosMov.importe)), fecha: datosMov.fecha, origen: 'punteo', movId: String(movId), sinFactura: true, at: new Date() } } });
  }
  await db.collection('punteoManual').updateOne({ _id: String(movId) }, { $set: set }, { upsert: true });
  return { ok: true, obraRef: set.obraRef };
}
// La factura subida cuadra con el pago: se elige obra o gasto general y queda confirmada (→ StelOrder).
async function confirmarDesdePunteo(movId, { obraId, categoria, vehiculoId }, por) {
  const db = await getDB();
  const pm = await db.collection('punteoManual').findOne({ _id: String(movId) });
  if (!pm || !pm.compraId) throw new Error('Primero sube la factura');
  const compras = require('./compras');
  if (vehiculoId) await compras.editar(pm.compraId, { destino: 'vehiculo', vehiculoId, categoria: categoria || null, obraId: null }, por);
  else if (obraId) await compras.editar(pm.compraId, { destino: 'obra', obraId }, por);
  else if (categoria) await compras.editar(pm.compraId, { destino: 'general', categoria, obraId: null }, por);
  else throw new Error('Elige la obra o la categoría');
  const c = await compras.revisar(pm.compraId, por);
  await db.collection('punteoManual').updateOne({ _id: String(movId) }, { $set: { confirmada: true, obraRef: c.obraRef || null, categoria: c.categoria || null } });
  return { ok: true, obraRef: c.obraRef || null, vehiculo: c.vehiculoNombre || null, categoria: c.categoria || null, enviadaStel: !!c.enviadaStel };
}
async function quitarDeObra(db, movId) {
  await db.collection('obras').updateMany({ 'materiales.movId': String(movId) }, { $pull: { materiales: { movId: String(movId) } } }).catch(() => {});
}
async function deshacerJustificacion(movId) {
  olvidarMapaPagos();
  const db = await getDB();
  await quitarDeObra(db, movId);
  await db.collection('punteoManual').deleteOne({ _id: String(movId) });
  return { ok: true };
}

// Borrador del 303 (orientativo: lo ajusta la gestoría).
function borrador303(e, p) {
  const rep = e.resumen.emitidas.iva, sop = e.resumen.recibidas.iva;
  const dupIva = r2(p.avisos.duplicadas.reduce((s, d) => s + (Number(d.duplicada.iva) || 0), 0));
  const iva0 = r2(p.avisos.iva0.reduce((s, r) => s + Number(r.total) * 21 / 121, 0));
  return { repercutido: rep, base: e.resumen.emitidas.base, nEmitidas: e.resumen.emitidas.n, soportado: sop, dupIva, soportadoCorregido: r2(sop - dupIva), iva0Recuperable: iva0, resultado: r2(rep - (sop - dupIva)) };
}

function hojaMovimientos(XLSX, p, filasMov, titulo) {
  filasMov = filasMov || p.filas;
  const filas = [
    [`Movimientos ${titulo ? 'tarjetas' : 'banco'} Q${p.n}`], [`CORP PROJECTS HOLDING SL — ${titulo || 'Movimientos bancarios'} ${p.n}T ${p.y}`], [`${titulo ? 'Revolut Business y tarjetas de crédito Santander' : 'Cuenta ES35 0049 1807 36 2210700012'} · ${p.from.split('-').reverse().join('/')}–${p.to.split('-').reverse().join('/')} · para Som Assessors`],
    ['Fecha', 'Concepto', 'Cargo', 'Abono', 'Saldo', 'Qué es', 'Factura / documento', 'Proveedor / cliente', 'Estado', 'Nota', 'Tarjeta / cuenta', 'Quién'],
  ];
  const TIPO = { cobro: 'Cobro', pago_tarjeta: 'Compra con tarjeta', recibo: 'Recibo domiciliado', pago_transferencia: 'Transferencia', nomina: 'Nómina', seguridad_social: 'Seguridad Social', impuestos: 'Impuestos', traspaso_propio: 'Traspaso propio', liquidacion_tarjeta: 'Liquidación tarjeta crédito', comision_banco: 'Comisión banco', efectivo: 'Efectivo', prestamo: 'Préstamo', devolucion: 'Devolución' };
  const EST = { punteado: '✓ Con factura', no_requiere: 'No lleva factura', revisar: 'REVISAR', sin_documento: 'SIN FACTURA' };
  let mes = null, c = 0, a = 0, TC = 0, TA = 0;
  const MES = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];
  const cerrar = () => { if (mes) filas.push(['', `Subtotal ${MES[Number(mes) - 1]}`, r2(c), r2(a)]); };
  for (const f of filasMov) {
    const m = f.fecha.slice(5, 7); if (m !== mes) { cerrar(); mes = m; c = 0; a = 0; }
    if (f.importe < 0) { c += f.importe; TC += f.importe; } else { a += f.importe; TA += f.importe; }
    filas.push([f.fecha.split('-').reverse().join('/'), f.concepto, f.importe < 0 ? f.importe : null, f.importe > 0 ? f.importe : null, f.saldo, TIPO[f.tipo] || f.tipo, f.docs.map(d => d.ref + (d.refProveedor ? ` (${d.refProveedor})` : '')).join(' + '), [...new Set(f.docs.map(d => d.tercero))].join(' + '), EST[f.estado] || f.estado, f.nota || '', f.origen || '', f.persona || '']);
  }
  cerrar(); filas.push(['', 'TOTAL TRIMESTRE', r2(TC), r2(TA)]);
  const ws = XLSX.utils.aoa_to_sheet(filas);
  for (const k of Object.keys(ws)) { const cel = ws[k]; if (k[0] !== '!' && cel.t === 'n' && /^[C-E]\d+$/.test(k)) cel.z = '#,##0.00 "€"'; }
  ws['!cols'] = [{ wch: 11 }, { wch: 70 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 22 }, { wch: 28 }, { wch: 30 }, { wch: 16 }, { wch: 40 }, { wch: 18 }, { wch: 16 }];
  return ws;
}

function hojaIndiceRecibidas(XLSX, R, rec, avisos) {
  const dupIds = new Set(avisos.duplicadas.map(d => d.duplicada.id)), iva0Ids = new Set(avisos.iva0.map(r => r.id));
  const filas = [[`Facturas recibidas Q${R.n}`], [`CORP PROJECTS HOLDING SL — Facturas recibidas ${R.n}T ${R.y} (indice)`], [`${rec.length} facturas de compra - fuente: Libro StelOrder - para Som Assessors`],
    ['Ref StelOrder', 'Proveedor', 'No doc', 'Fecha', 'Base', '% IVA', 'IVA', 'Total', 'Aviso']];
  const MES = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];
  let mes = null, sb = 0, si = 0, st = 0, TB = 0, TI = 0, TT = 0;
  const cerrar = () => { if (mes) filas.push(['', `Subtotal ${MES[Number(mes) - 1]}`, '', '', r2(sb), '', r2(si), r2(st)]); };
  for (const r of rec.slice().sort((a, b) => a.fecha.localeCompare(b.fecha))) {
    const m = r.fecha.slice(5, 7); if (m !== mes) { cerrar(); mes = m; sb = si = st = 0; }
    const pct = r.base && r.iva != null ? Math.round(r.iva / r.base * 100) : null;
    filas.push([r.numero, r.proveedor, r.refProveedor, r.fecha.split('-').reverse().join('/'), r.base, pct != null ? pct + '%' : '', r.iva, r.total, dupIds.has(r.id) ? 'DUPLICADA en StelOrder — no contar' : iva0Ids.has(r.id) ? 'IVA 0% en StelOrder: comprobar el ticket' : '']);
    if (!dupIds.has(r.id)) { sb += Number(r.base) || 0; si += Number(r.iva) || 0; st += Number(r.total) || 0; TB += Number(r.base) || 0; TI += Number(r.iva) || 0; TT += Number(r.total) || 0; }
  }
  cerrar(); filas.push(['', 'TOTAL TRIMESTRE (sin duplicadas)', '', '', r2(TB), '', r2(TI), r2(TT)]);
  const ws = XLSX.utils.aoa_to_sheet(filas);
  for (const k of Object.keys(ws)) { const cel = ws[k]; if (k[0] !== '!' && cel.t === 'n' && /^[EGH]\d+$/.test(k)) cel.z = '#,##0.00 "€"'; }
  ws['!cols'] = [{ wch: 13 }, { wch: 34 }, { wch: 20 }, { wch: 11 }, { wch: 12 }, { wch: 7 }, { wch: 11 }, { wch: 12 }, { wch: 38 }];
  return ws;
}

// Texto para la gestoría (mismo esquema que el correo del 2º trimestre).
function textoGestoria(e, p, b) {
  const eur = v => { const [e, d] = Math.abs(Number(v) || 0).toFixed(2).split('.'); return (Number(v) < 0 ? '-' : '') + e.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + d + ' €'; };
  const rev = p.filas.filter(f => f.estado === 'revisar' || f.estado === 'sin_documento');
  const grupo = t => rev.filter(f => f.tipo === t);
  const efectivo = grupo('efectivo'), sinDoc = p.filas.filter(f => f.estado === 'sin_documento' && f.importe < 0);
  const lineas = [
    `Hola Rubén,`, ``,
    `Ya tienes toda la documentación del ${e.label} en la carpeta de Drive (PARA_GESTORIA_Q${e.n}_${e.y}).`, ``,
    `Dentro está organizada así:`,
    `- 1_Facturas_emitidas: PDFs separados por mes.`,
    `- 2_Facturas_recibidas: PDFs separados por mes (los que se revisan en nuestro programa), el índice del libro de StelOrder (${e.resumen.recibidas.n} facturas de compra) y el índice de Compras (columna «En StelOrder» para no contar dos veces).`,
    `- 3_Resumen_facturas_emitidas_Q${e.n}.xlsx`,
    `- 4_Movimientos_bancarios_Q${e.n}.xlsx — cada movimiento con su factura al lado (${p.resumen.punteados} punteados de ${p.resumen.movimientos}).`,
    `- 5_Extractos_tarjeta_credito y 6_Extracto_banco.`, ``,
    `Sobre el 303, por si te sirve de punto de partida (los números finales ya los ajustas tú):`,
    `- IVA repercutido: ${eur(b.repercutido)} (${b.nEmitidas} facturas emitidas, base ${eur(b.base)}).`,
    `- IVA soportado: ${eur(b.soportadoCorregido)}${b.dupIva ? ` (ya restados ${eur(b.dupIva)} de IVA de facturas duplicadas en StelOrder)` : ''}.`,
    `- Resultado que me sale: ${eur(b.resultado)} ${b.resultado >= 0 ? 'a ingresar' : 'a compensar'}.`, ``,
    `Cosas que prefiero que revises y valides tú:`,
  ];
  let n = 1;
  if (p.avisos.iva0.length) lineas.push(`${n++}. ${p.avisos.iva0.length} facturas de compra están en StelOrder con IVA 0% de proveedores que normalmente cobran IVA (${[...new Set(p.avisos.iva0.map(r => r.proveedor))].slice(0, 4).join(', ')}). Si el ticket lleva IVA, se recuperarían unos ${eur(b.iva0Recuperable)}. Van señaladas en el índice.`);
  if (p.avisos.duplicadas.length) lineas.push(`${n++}. ${p.avisos.duplicadas.length} facturas estaban duplicadas en StelOrder; no las he contado (señaladas en el índice).`);
  if (efectivo.length) lineas.push(`${n++}. Reintegros en efectivo: ${eur(-efectivo.reduce((s, f) => s + f.importe, 0))}.`);
  if (sinDoc.length) {
    const grupos = {};
    for (const f of sinDoc) { const k = f.nota ? f.nota.split(':')[0] : 'Otros cargos sin clasificar'; (grupos[k] = grupos[k] || { n: 0, imp: 0 }); grupos[k].n++; grupos[k].imp += -f.importe; }
    lineas.push(`${n++}. Cargos del banco sin factura localizada: ${sinDoc.length} (${eur(-sinDoc.reduce((s, f) => s + f.importe, 0))}), marcados «SIN FACTURA» en el Excel de movimientos:`);
    Object.entries(grupos).sort((a, b) => b[1].imp - a[1].imp).forEach(([k, g]) => lineas.push(`   - ${k}: ${g.n} (${eur(g.imp)})`));
  }
  for (const g of (p.terceros || [])) lineas.push(`${n++}. Movimientos por cuenta de ${g.empresa} (sociedad vinculada) que han pasado por nuestra cuenta: entradas ${eur(g.entradas)}, pagos ${eur(g.salidas)}, saldo ${eur(g.saldo)}. No los he contado como ingreso ni gasto nuestro; dime cómo prefieres documentarlos (cuenta corriente entre sociedades, refacturación…). Detalle en la hoja «Por cuenta de otras empresas».`);
  if ((p.porFacturar || []).length) lineas.push(`${n++}. Cobros recibidos de los que aún tenemos que emitir factura: ${p.porFacturar.length} (${eur(p.porFacturar.reduce((s, m) => s + m.importe, 0))}). Están en la hoja «Facturas por emitir»; las emito antes de cerrar.`);
  if ((p.personales || []).length) lineas.push(`${n++}. Gastos personales pagados con tarjeta de la empresa (no son gasto de la empresa): ${p.personales.map(g => `${g.persona} ${eur(g.total)}`).join(', ')}. Detalle en la hoja «Gastos personales».`);
  const dietasTrim = (p.dietas || []).flatMap(g => g.movs).filter(m => m.esteTrimestre);
  if (dietasTrim.length) lineas.push(`${n++}. Comidas de trabajo pagadas por la empresa (dietas, trabajadores desplazados a obra): ${dietasTrim.length} (${eur(dietasTrim.reduce((s, m) => s - m.importe, 0))}). Detalle con quién comió en la hoja «Comidas y dietas».`);
  const bonpreu = p.filas.filter(f => f.estado === 'revisar' && /factura por mes/.test(f.nota || ''));
  if (bonpreu.length) lineas.push(`${n++}. Proveedores que facturan una vez al mes y no cuadran con lo pagado con tarjeta (${[...new Set(bonpreu.map(f => f.docs[0] && f.docs[0].tercero))].join(', ')}): la diferencia puede ser gasto personal. Señalado en el Excel.`);
  if (n === 1) lineas.push(`- Nada especial este trimestre.`);
  lineas.push(``, `Las liquidaciones de tarjeta, los traspasos entre cuentas propias, nóminas, Seguridad Social e impuestos no los he contado como gasto con factura.`, ``, `Cualquier cosa que te falte o que prefieras de otra forma, me dices.`, ``, `Gracias,`, `Àlex`);
  return lineas.join('\n');
}

// Paquete completo en un ZIP con la estructura de Drive.
async function paqueteGestoria(q) {
  const XLSX = require('xlsx');
  const R = rango(q || trimestrePorDefecto());
  const [e, p, resEm] = await Promise.all([estado(R.q), punteo(R.q), resumenEmitidasXlsx(R.q)]);
  const b = borrador303(e, p);
  const recTrim = (await todasRecibidas()).filter(r => enRango(r.fecha, R));
  const libro = (ws, nombre) => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, nombre); return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); };
  const wbMov = XLSX.utils.book_new();
  const deBanco = p.filas.filter(f => f.origen === 'Cuenta Santander'), deTarjeta = p.filas.filter(f => f.origen !== 'Cuenta Santander');
  XLSX.utils.book_append_sheet(wbMov, hojaMovimientos(XLSX, p, deBanco), `Banco Q${R.n}`);
  if (deTarjeta.length) XLSX.utils.book_append_sheet(wbMov, hojaMovimientos(XLSX, p, deTarjeta, 'Movimientos de tarjetas'), `Tarjetas Q${R.n}`);
  // Lista de facturas que hay que pedir, por comercio
  const pedir = p.filas.filter(f => f.estado === 'sin_documento' && f.importe < 0).sort((a, b) => String(comercio(a.concepto)).localeCompare(comercio(b.concepto)) || a.fecha.localeCompare(b.fecha))
    .map(f => ({ Comercio: comercio(f.concepto), Fecha: f.fecha, Importe: -f.importe, Quién: f.persona || '', 'Tarjeta / cuenta': f.origen || '', Concepto: f.concepto, Nota: f.nota || '' }));
  XLSX.utils.book_append_sheet(wbMov, XLSX.utils.json_to_sheet(pedir.length ? pedir : [{ Comercio: 'Nada pendiente' }]), 'Facturas a pedir');
  const pers = p.personales.flatMap(g => g.movs.map(m => ({ Persona: g.persona, Fecha: m.fecha, Concepto: m.concepto, Importe: -m.importe, 'Tarjeta / cuenta': m.origen || '', Nota: m.nota || '', 'Marcado por': m.por || '' })));
  if (pers.length) XLSX.utils.book_append_sheet(wbMov, XLSX.utils.json_to_sheet(pers), 'Gastos personales');
  const diet = (p.dietas || []).flatMap(g => g.movs).filter(m => m.esteTrimestre).map(m => ({ Fecha: m.fecha, Concepto: m.concepto, Importe: -m.importe, Personas: (m.personas || []).join(', '), 'Por persona': m.porPersona, Obra: m.obraRef || '', 'Tarjeta / cuenta': m.origen || '', Nota: m.nota || '' }));
  if (diet.length) XLSX.utils.book_append_sheet(wbMov, XLSX.utils.json_to_sheet(diet), 'Comidas y dietas');
  const terc = p.terceros.flatMap(g => g.movs.map(m => ({ Empresa: g.empresa, Fecha: m.fecha, Concepto: m.concepto, Entrada: m.importe > 0 ? m.importe : null, Salida: m.importe < 0 ? -m.importe : null, Nota: m.nota || '' })));
  if (terc.length) XLSX.utils.book_append_sheet(wbMov, XLSX.utils.json_to_sheet(terc), 'Por cuenta de otras empresas');
  if (p.porFacturar.length) XLSX.utils.book_append_sheet(wbMov, XLSX.utils.json_to_sheet(p.porFacturar.map(m => ({ Fecha: m.fecha, Concepto: m.concepto, Importe: m.importe, 'A quién / obra': m.nota || '' }))), 'Facturas por emitir');
  const revisar = p.filas.filter(f => f.estado === 'revisar' || f.estado === 'sin_documento').map(f => ({ Fecha: f.fecha, Concepto: f.concepto, Importe: f.importe, Estado: f.estado === 'revisar' ? 'Revisar' : 'Sin factura', Nota: f.nota || '' }));
  XLSX.utils.book_append_sheet(wbMov, XLSX.utils.json_to_sheet(revisar.length ? revisar : [{ Concepto: 'Nada pendiente' }]), 'Para revisar');
  XLSX.utils.book_append_sheet(wbMov, XLSX.utils.json_to_sheet(p.recibidasSinPago.map(r => ({ Ref: r.numero, Proveedor: r.proveedor, 'Nº proveedor': r.refProveedor, Fecha: r.fecha, Total: r.total }))), 'Facturas sin pago en cuenta');
  const corregir = [...p.avisos.duplicadas.map(d => ({ Qué: 'Duplicada', Ref: d.duplicada.numero, 'Igual que': d.original.numero, Proveedor: d.duplicada.proveedor, 'Nº proveedor': d.duplicada.refProveedor, Total: d.duplicada.total, IVA: d.duplicada.iva })),
    ...p.avisos.iva0.map(r => ({ Qué: 'IVA 0% sospechoso', Ref: r.numero, Proveedor: r.proveedor, 'Nº proveedor': r.refProveedor, Total: r.total, 'IVA si fuera 21%': r2(r.total * 21 / 121) }))];
  XLSX.utils.book_append_sheet(wbMov, XLSX.utils.json_to_sheet(corregir.length ? corregir : [{ Qué: 'Nada que corregir' }]), 'Corregir en StelOrder');
  const archivos = [];
  const emZip = await zipEmitidasArchivos(R.q);
  archivos.push(...emZip.map(a => ({ nombre: `PARA_GESTORIA_Q${R.n}_${R.y}/${a.nombre}`, datos: a.datos })));
  const recCompras = await _archivosRecibidasCompras(R);
  archivos.push(...recCompras.archivos.map(a => ({ nombre: `PARA_GESTORIA_Q${R.n}_${R.y}/${a.nombre}`, datos: a.datos })));
  archivos.push({ nombre: `PARA_GESTORIA_Q${R.n}_${R.y}/2_Facturas_recibidas/Indice_facturas_recibidas_Q${R.n}.xlsx`, datos: libro(hojaIndiceRecibidas(XLSX, R, recTrim, p.avisos), `Recibidas Q${R.n}`) });
  archivos.push({ nombre: `PARA_GESTORIA_Q${R.n}_${R.y}/${resEm.nombre}`, datos: resEm.buf });
  archivos.push({ nombre: `PARA_GESTORIA_Q${R.n}_${R.y}/4_Movimientos_bancarios_Q${R.n}.xlsx`, datos: XLSX.write(wbMov, { type: 'buffer', bookType: 'xlsx' }) });
  const texto = textoGestoria(e, p, b);
  archivos.push({ nombre: `PARA_GESTORIA_Q${R.n}_${R.y}/LEEME_para_Som_Assessors.txt`, datos: Buffer.from(texto, 'utf8') });
  return { buf: require('./zip').crearZip(archivos), nombre: `PARA_GESTORIA_Q${R.n}_${R.y}.zip`, texto, b, resumenPunteo: p.resumen };
}

// Cada mañana: se recalcula y se guarda; los lunes, resumen a oficina si hay pendientes
// (mientras el trimestre está abierto o en los 20 días después de cerrarse).
async function revisionDiaria({ forzarAviso = false } = {}) {
  const q = trimestrePorDefecto();
  const e = await estado(q);
  const db = await getDB();
  await db.collection('trimestreEstado').updateOne({ _id: q }, { $set: { q, nPendientes: e.nPendientes, resumen: e.resumen, generado: new Date() } }, { upsert: true });
  const lunes = new Date().getDay() === 1;
  if ((lunes || forzarAviso) && e.nPendientes > 0) {
    const p = e.pendientes;
    const lineas = [
      p.porRevisar.length ? `• ${p.porRevisar.length} compras por revisar` : '',
      p.sinContabilidad.length ? `• ${p.sinContabilidad.length} revisadas sin pasar a StelOrder` : '',
      p.correosSinAdjunto.length ? `• ${p.correosSinAdjunto.length} correos de factura sin PDF (pedirla)` : '',
      p.correosSinRevisar.length ? `• ${p.correosSinRevisar.length} facturas de correo por revisar` : '',
      p.banco && !p.banco.cubre ? '• falta subir el extracto del banco hasta el final del trimestre' : '',
    ].filter(Boolean);
    const texto = `🗂️ *${e.label}* — para cerrar con la gestoría:\n${lineas.join('\n')}\n\nhttps://dashboard.corpprojects.es/trimestre`;
    try { await require('./push').sendToOficina({ title: `${e.label}: ${e.nPendientes} pendientes`, body: lineas.join(' · ').replace(/• /g, ''), url: '/trimestre', tag: 'trimestre' }); } catch (x) {}
    try {
      const dest = String(process.env.FICHAJE_AVISOS_TO || process.env.WHATSAPP_TO || '').split(',').map(s => s.trim()).filter(Boolean);
      for (const d of dest) await require('./notifications').sendWhatsAppTo(d, texto);
    } catch (x) {}
  }
  return { q, nPendientes: e.nPendientes };
}

// Mapa de pagos de TODO el histórico: qué movimiento (cuenta, tarjeta, Revolut) paga o cobra cada factura.
// Se calcula cruzando todos los extractos a la vez; caché de 5 min (se borra al resolver algo a mano).
let _mapa = null, _mapaAt = 0;
function olvidarMapaPagos() { _mapa = null; }
async function mapaPagos() {
  if (_mapa && Date.now() - _mapaAt < 5 * 60 * 1000) return _mapa;
  const C = require('./conciliacion');
  const R = { from: '2000-01-01', to: '2100-12-31' };
  const [movsBanco, movsTarjeta, em, recStel] = await Promise.all([movimientosBanco(R), require('./tarjetas').movimientosPunteo(R).catch(() => []), todasEmitidas(), todasRecibidas()]);
  const rec = await recibidasPunteo(recStel).catch(() => recStel);
  const movs = [...movsBanco, ...movsTarjeta];
  const db = await getDB();
  const man = await db.collection('punteoManual').find({}).toArray();
  const porId = {}; man.forEach(x => { porId[x._id] = x; });
  movs.forEach(m => { if (porId[m.id]) m.manual = porId[m.id]; });
  const res = C.conciliar({ movimientos: movs, emitidas: em, recibidas: rec });
  const porDoc = new Map(), porMov = new Map();
  for (const f of res.filas) {
    porMov.set(f.id, { estado: f.estado, tipo: f.tipo || null, confianza: f.confianza || null, nota: f.nota || null, persona: f.persona || null, docs: (f.docs || []).map(d => ({ ref: d.ref, refProveedor: d.refProveedor || null, tercero: d.tercero || null, total: d.total, fecha: d.fecha || null, compraId: d.compraId || null })) });
    if (f.estado !== 'punteado') continue;
    const pago = { movId: f.id, fecha: f.fecha, importe: f.importe, origen: f.origen || 'Cuenta Santander', persona: f.persona || null, concepto: f.concepto, nota: f.nota || null, conOtras: (f.docs || []).length > 1 ? f.docs.length - 1 : 0 };
    for (const d of f.docs || []) for (const k of [d.ref, d.compraId]) {
      if (!k || k === 'Compra subida') continue;
      const l = porDoc.get(String(k)) || []; if (!l.some(x => x.movId === f.id)) l.push(pago); porDoc.set(String(k), l);
    }
  }
  _mapa = { porDoc, porMov, desde: movs.map(m => m.fecha).filter(Boolean).sort()[0] || null };
  _mapaAt = Date.now();
  return _mapa;
}

// Buscador del cierre: todo lo que hay de un proveedor, cliente o persona (o de un importe), en cualquier fecha.
// Movimientos de banco y tarjetas + facturas recibidas (StelOrder y Compras) + facturas emitidas.
async function buscar(texto) {
  const t = String(texto || '').trim();
  if (t.length < 2) return { texto: t, movimientos: [], recibidas: [], compras: [], emitidas: [] };
  const n = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const palabras = n(t).split(/\s+/).filter(Boolean);
  // «163,71» / «163.71» → busca también por importe (±1 céntimo)
  const imp = /^-?\d{1,3}(\.\d{3})*(,\d{1,2})?$|^-?\d+([.,]\d{1,2})?$/.test(t) ? Math.abs(Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t)) : null;
  const casa = (txt, importe) => (imp != null && Math.abs(Math.abs(Number(importe) || 0) - imp) < 0.015) || palabras.every(w => n(txt).includes(w));
  // Sin acentos: «ruben» encuentra «Rubén» en el concepto del banco.
  const AC = { a: '[aàáâä]', e: '[eèéêë]', i: '[iìíîï]', o: '[oòóôö]', u: '[uùúûü]', n: '[nñ]', c: '[cç]' };
  const rx = palabras.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[aeiounc]/g, ch => AC[ch] || ch)).join('|');
  const db = await getDB();
  const filtroMov = imp != null ? { $or: [{ importe: imp }, { importe: -imp }] } : { concepto: { $regex: rx, $options: 'i' } };
  const [bm, tm, rec, em, cs] = await Promise.all([
    db.collection('bancoMovimientos').find(filtroMov).sort({ fechaOperacion: -1 }).limit(300).toArray(),
    db.collection('tarjetaMovimientos').find(filtroMov).sort({ fecha: -1 }).limit(300).toArray(),
    todasRecibidas().catch(() => []),
    todasEmitidas().catch(() => []),
    db.collection('compras').find({ estado: { $ne: 'descartada' } }).project({ proveedor: 1, numero: 1, fecha: 1, total: 1, tipo: 1, estado: 1, obraRef: 1, destino: 1, origen: 1, createdAt: 1, duplicadoDe: 1 }).sort({ createdAt: -1 }).limit(2000).toArray(),
  ]);
  const movimientos = [
    ...bm.filter(m => casa(m.concepto, m.importe)).map(m => ({ id: String(m._id), fecha: m.fechaOperacion, importe: m.importe, concepto: m.concepto, origen: 'Cuenta Santander' })),
    ...tm.filter(m => casa(m.concepto, m.importe) && !/declined|reverted|failed/i.test(m.estado || '')).map(m => ({ id: String(m._id), fecha: m.fecha, importe: m.importe, concepto: m.concepto, origen: m.fuente === 'revolut' ? `Revolut${m.tarjeta ? ' …' + m.tarjeta : ''}` : `Crédito …${m.tarjeta}` })),
  ].sort((a, b) => String(b.fecha).localeCompare(String(a.fecha))).slice(0, 80);
  // Nombres relacionados: si un pago cita un nº de factura («IN2608-0063»), esa factura entra y su proveedor
  // también (Rachid factura como «9electric»: buscando «rachid» salen también sus facturas de 9electric).
  const dig = x => String(x || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const refs = new Set();
  movimientos.forEach(m => (String(m.concepto).match(/[a-z]{0,4}\d[\d\/\-]{4,}\d/gi) || []).forEach(x => { if (dig(x).length >= 6) refs.add(dig(x)); }));
  const citada = num => { const d = dig(num); return d.length >= 6 && [...refs].some(r => r === d || (Math.min(r.length, d.length) >= 8 && (r.endsWith(d) || d.endsWith(r)))); };
  const nombres = new Set();
  rec.forEach(r => { if (citada(r.refProveedor) || citada(r.numero)) nombres.add(n(r.proveedor)); });
  cs.forEach(c => { if (citada(c.numero)) nombres.add(n(c.proveedor)); });
  const deNombre = prov => nombres.has(n(prov));
  // La misma factura en StelOrder (por su nº de proveedor): sus pagos valen para la compra.
  const gemelaRec = c => { const d = dig(c.numero); if (d.length < 4) return null; return rec.find(x => dig(x.refProveedor) === d && Math.abs(Math.abs(x.total) - Math.abs(c.total || 0)) < 0.05) || null; };
  const gemelaStel = c => { const r = gemelaRec(c); return r ? r.numero : null; };
  // «prefer» (nombre comercial en Compras) trae también a «PREFORMADOS ESPINOSA RUIZ» (razón social en StelOrder).
  cs.filter(c => casa(`${c.proveedor} ${c.numero}`, c.total)).forEach(c => { const r = gemelaRec(c); if (r) nombres.add(n(r.proveedor)); });
  const casaDoc = (txt, importe, prov, ...nums) => casa(txt, importe) || deNombre(prov) || nums.some(citada);
  // Segunda pasada: movimientos del banco a nombre de los relacionados (razón social de StelOrder).
  const extraNombres = [...nombres].filter(x => !palabras.every(w => x.includes(w)));
  if (extraNombres.length && imp == null) {
    const claves = extraNombres.map(x => (x.match(/[a-z0-9]{4,}/g) || []).filter(w => !/^(sociedad|girona|limitada)$/.test(w)).slice(0, 2).join('.{0,3}')).filter(Boolean);
    if (claves.length) {
      const rx2 = claves.map(k => k.replace(/[aeiounc]/g, ch => AC[ch] || ch)).join('|');
      const ya = new Set(movimientos.map(m => m.id));
      const [b2, t2] = await Promise.all([db.collection('bancoMovimientos').find({ concepto: { $regex: rx2, $options: 'i' } }).sort({ fechaOperacion: -1 }).limit(100).toArray(), db.collection('tarjetaMovimientos').find({ concepto: { $regex: rx2, $options: 'i' } }).sort({ fecha: -1 }).limit(100).toArray()]);
      b2.filter(m => !ya.has(String(m._id))).forEach(m => movimientos.push({ id: String(m._id), fecha: m.fechaOperacion, importe: m.importe, concepto: m.concepto, origen: 'Cuenta Santander' }));
      t2.filter(m => !ya.has(String(m._id)) && !/declined|reverted|failed/i.test(m.estado || '')).forEach(m => movimientos.push({ id: String(m._id), fecha: m.fecha, importe: m.importe, concepto: m.concepto, origen: m.fuente === 'revolut' ? `Revolut${m.tarjeta ? ' …' + m.tarjeta : ''}` : `Crédito …${m.tarjeta}` }));
      movimientos.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
    }
  }
  // Cómo se pagó / cobró cada cosa (cruce de TODO el histórico, no solo del trimestre).
  const M = await mapaPagos().catch(e => { console.warn('[Trimestre] mapa de pagos:', e.message); return null; });
  const pagosDe = (...claves) => { if (!M) return null; for (const k of claves) if (k && M.porDoc.has(String(k))) return M.porDoc.get(String(k)); return []; };
  movimientos.forEach(m => { const f = M && M.porMov.get(m.id); if (f) { m.estado = f.estado; m.docs = f.docs; m.nota = f.nota || null; m.persona = f.persona || null; } });
  return {
    texto: t, importe: imp, movimientos, relacionados: [...nombres].filter(x => !palabras.every(w => x.includes(w))),
    recibidas: rec.filter(r => casaDoc(`${r.proveedor} ${r.numero} ${r.refProveedor}`, r.total, r.proveedor, r.refProveedor, r.numero)).sort((a, b) => b.fecha.localeCompare(a.fecha)).slice(0, 60).map(r => ({ ...r, pagos: pagosDe(r.numero) })),
    compras: cs.filter(c => casaDoc(`${c.proveedor} ${c.numero} ${c.obraRef || ''}`, c.total, c.proveedor, c.numero)).slice(0, 40).map(c => ({ id: String(c._id), proveedor: c.proveedor, numero: c.numero, fecha: c.fecha || (c.createdAt && c.createdAt.toISOString().slice(0, 10)), total: c.total, tipo: c.tipo, estado: c.estado, obraRef: c.obraRef || null, destino: c.destino, duplicada: !!c.duplicadoDe, pagos: pagosDe(String(c._id), c.numero, gemelaStel(c)) })),
    emitidas: em.filter(e => casa(`${e.cliente} ${e.numero}`, e.total)).sort((a, b) => b.fecha.localeCompare(a.fecha)).slice(0, 40).map(e => ({ id: e.id, numero: e.numero, cliente: e.cliente, fecha: e.fecha, total: e.total, pendiente: e.pendiente, pagos: pagosDe(e.numero) })),
  };
}

module.exports = { olvidarMapaPagos, enlazarCompra, todasRecibidas, rango, trimestrePorDefecto, estado, excel, revisionDiaria, resumenEmitidasXlsx, zipEmitidas, zipRecibidasCompras, punteo, paqueteGestoria, borrador303, textoGestoria, justificar, deshacerJustificacion, comercio, confirmarDesdePunteo, buscar, recibidasPunteo, mapaPagos, todasEmitidas };
