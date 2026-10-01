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

// ── PUNTEO DEL BANCO y documentos para la gestoría ───────────────────────────
// Todas las facturas (no solo las del trimestre): se cobran y pagan con retraso.
async function todasEmitidas() {
  const stel = require('./stelorder');
  const [mapa, facturas] = await Promise.all([stel.getAllOrdinaryInvoices(), stel.getInvoices()]);
  const porId = {}; (facturas || []).forEach(f => { porId[String(f.id)] = f; });
  return Object.entries(mapa || {}).filter(([, o]) => o.date).map(([id, o]) => {
    const f = porId[id] || {};
    return { id, numero: o.number || f.number || id, fecha: String(o.date).slice(0, 10), cliente: f.client || '—', total: o.total != null ? o.total : (f.totalAmount != null ? r2(f.totalAmount) : 0), base: o.base, iva: o.iva };
  });
}
async function todasRecibidas() {
  const fp = await require('./stelorder').getPurchaseInvoices();
  return (fp || []).filter(x => x.date).map(x => ({ id: x.id, numero: x.number, refProveedor: x.extraReference || '', proveedor: x.supplier, fecha: String(x.date).slice(0, 10), total: r2(x.total), base: x.base, iva: x.iva }));
}
async function movimientosBanco(R) {
  const db = await getDB();
  const ms = await db.collection('bancoMovimientos').find({ fechaOperacion: { $gte: R.from, $lte: R.to } }).sort({ fechaOperacion: 1 }).toArray();
  return ms.map(m => ({ id: String(m._id), fecha: m.fechaOperacion, concepto: m.concepto, importe: m.importe, saldo: m.saldo, codigo: m.codigo, categoria: m.categoria, contraparte: m.contraparte }));
}

async function punteo(q) {
  const C = require('./conciliacion');
  const R = rango(q || trimestrePorDefecto());
  const [movs, em, rec] = await Promise.all([movimientosBanco(R), todasEmitidas(), todasRecibidas()]);
  const res = C.conciliar({ movimientos: movs, emitidas: em, recibidas: rec });
  const recTrim = rec.filter(r => enRango(r.fecha, R));
  const sinPago = recTrim.filter(r => !res.recibidasUsadas.has(r.id) && r.total > 0);
  const avisos = C.avisosRecibidas(recTrim);
  return { ...R, resumen: res.resumen, filas: res.filas, recibidasSinPago: sinPago, avisos, hayBanco: movs.length > 0 };
}

// Borrador del 303 (orientativo: lo ajusta la gestoría).
function borrador303(e, p) {
  const rep = e.resumen.emitidas.iva, sop = e.resumen.recibidas.iva;
  const dupIva = r2(p.avisos.duplicadas.reduce((s, d) => s + (Number(d.duplicada.iva) || 0), 0));
  const iva0 = r2(p.avisos.iva0.reduce((s, r) => s + Number(r.total) * 21 / 121, 0));
  return { repercutido: rep, base: e.resumen.emitidas.base, nEmitidas: e.resumen.emitidas.n, soportado: sop, dupIva, soportadoCorregido: r2(sop - dupIva), iva0Recuperable: iva0, resultado: r2(rep - (sop - dupIva)) };
}

function hojaMovimientos(XLSX, p) {
  const filas = [
    [`Movimientos banco Q${p.n}`], [`CORP PROJECTS HOLDING SL — Movimientos bancarios ${p.n}T ${p.y}`], [`Cuenta ES35 0049 1807 36 2210700012 · ${p.from.split('-').reverse().join('/')}–${p.to.split('-').reverse().join('/')} · para Som Assessors`],
    ['Fecha', 'Concepto', 'Cargo', 'Abono', 'Saldo', 'Qué es', 'Factura / documento', 'Proveedor / cliente', 'Estado', 'Nota'],
  ];
  const TIPO = { cobro: 'Cobro', pago_tarjeta: 'Compra con tarjeta', recibo: 'Recibo domiciliado', pago_transferencia: 'Transferencia', nomina: 'Nómina', seguridad_social: 'Seguridad Social', impuestos: 'Impuestos', traspaso_propio: 'Traspaso propio', liquidacion_tarjeta: 'Liquidación tarjeta crédito', comision_banco: 'Comisión banco', efectivo: 'Efectivo', prestamo: 'Préstamo', devolucion: 'Devolución' };
  const EST = { punteado: '✓ Con factura', no_requiere: 'No lleva factura', revisar: 'REVISAR', sin_documento: 'SIN FACTURA' };
  let mes = null, c = 0, a = 0, TC = 0, TA = 0;
  const MES = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];
  const cerrar = () => { if (mes) filas.push(['', `Subtotal ${MES[Number(mes) - 1]}`, r2(c), r2(a)]); };
  for (const f of p.filas) {
    const m = f.fecha.slice(5, 7); if (m !== mes) { cerrar(); mes = m; c = 0; a = 0; }
    if (f.importe < 0) { c += f.importe; TC += f.importe; } else { a += f.importe; TA += f.importe; }
    filas.push([f.fecha.split('-').reverse().join('/'), f.concepto, f.importe < 0 ? f.importe : null, f.importe > 0 ? f.importe : null, f.saldo, TIPO[f.tipo] || f.tipo, f.docs.map(d => d.ref + (d.refProveedor ? ` (${d.refProveedor})` : '')).join(' + '), [...new Set(f.docs.map(d => d.tercero))].join(' + '), EST[f.estado] || f.estado, f.nota || '']);
  }
  cerrar(); filas.push(['', 'TOTAL TRIMESTRE', r2(TC), r2(TA)]);
  const ws = XLSX.utils.aoa_to_sheet(filas);
  for (const k of Object.keys(ws)) { const cel = ws[k]; if (k[0] !== '!' && cel.t === 'n' && /^[C-E]\d+$/.test(k)) cel.z = '#,##0.00 "€"'; }
  ws['!cols'] = [{ wch: 11 }, { wch: 70 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 22 }, { wch: 28 }, { wch: 30 }, { wch: 16 }, { wch: 40 }];
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
    `- 2_Facturas_recibidas: PDFs separados por mes, más un Excel índice (${e.resumen.recibidas.n} facturas de compra).`,
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
  XLSX.utils.book_append_sheet(wbMov, hojaMovimientos(XLSX, p), `Banco Q${R.n}`);
  const revisar = p.filas.filter(f => f.estado === 'revisar' || f.estado === 'sin_documento').map(f => ({ Fecha: f.fecha, Concepto: f.concepto, Importe: f.importe, Estado: f.estado === 'revisar' ? 'Revisar' : 'Sin factura', Nota: f.nota || '' }));
  XLSX.utils.book_append_sheet(wbMov, XLSX.utils.json_to_sheet(revisar.length ? revisar : [{ Concepto: 'Nada pendiente' }]), 'Para revisar');
  XLSX.utils.book_append_sheet(wbMov, XLSX.utils.json_to_sheet(p.recibidasSinPago.map(r => ({ Ref: r.numero, Proveedor: r.proveedor, 'Nº proveedor': r.refProveedor, Fecha: r.fecha, Total: r.total }))), 'Facturas sin pago en cuenta');
  const corregir = [...p.avisos.duplicadas.map(d => ({ Qué: 'Duplicada', Ref: d.duplicada.numero, 'Igual que': d.original.numero, Proveedor: d.duplicada.proveedor, 'Nº proveedor': d.duplicada.refProveedor, Total: d.duplicada.total, IVA: d.duplicada.iva })),
    ...p.avisos.iva0.map(r => ({ Qué: 'IVA 0% sospechoso', Ref: r.numero, Proveedor: r.proveedor, 'Nº proveedor': r.refProveedor, Total: r.total, 'IVA si fuera 21%': r2(r.total * 21 / 121) }))];
  XLSX.utils.book_append_sheet(wbMov, XLSX.utils.json_to_sheet(corregir.length ? corregir : [{ Qué: 'Nada que corregir' }]), 'Corregir en StelOrder');
  const archivos = [];
  const emZip = await zipEmitidasArchivos(R.q);
  archivos.push(...emZip.map(a => ({ nombre: `PARA_GESTORIA_Q${R.n}_${R.y}/${a.nombre}`, datos: a.datos })));
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

module.exports = { rango, trimestrePorDefecto, estado, excel, revisionDiaria, resumenEmitidasXlsx, zipEmitidas, punteo, paqueteGestoria, borrador303, textoGestoria };
