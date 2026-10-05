// src/reclamaciones.js — Lo que un proveedor nos ha cobrado mal y aún tiene que arreglar (de momento, CINC).
//
// Cada factura de comisiones de CINC se comprueba (comisionesCinc.revisar) al pulsar «Comprobar» y al
// confirmarla en Compras. Las líneas mal cobradas quedan apuntadas aquí, una ficha por factura de CINC:
//   pendiente  → aún no se lo hemos dicho
//   reclamada  → se lo hemos dicho (fecha), esperamos el abono
//   resuelta   → nos han hecho el abono (nº) o lo han corregido
//   descartada → no se reclama (nota)
// Errores que se reclaman: repetida en la misma factura, ya cobrada en otra, 10 % del total con IVA en vez
// de la base, o más del 10 %. Lo que cobran de menos o las líneas sin factura nuestra van aparte («a mirar»).
'use strict';
const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const COL = 'reclamaciones';
const ESTADOS = ['pendiente', 'reclamada', 'resuelta', 'descartada'];
const RECLAMABLE = { duplicada: 'Repetida en esta factura', ya_cobrada: 'Ya la cobraron en otra factura', sobre_total: '10 % del total con IVA, no de la base', de_mas: 'Cobran más del 10 %' };
const A_MIRAR = { de_menos: 'Cobran menos del 10 % (a su favor nuestro)', no_existe: 'No encuentro esa factura nuestra', sin_num: 'Línea sin nº de factura' };
const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
function _oid(id) { try { return new ObjectId(String(id)); } catch (e) { throw new Error('Reclamación no válida'); } }

// Comprueba una factura de CINC y deja apuntados sus errores (sin tocar el estado si ya estaba reclamada).
async function desdeCinc(compraId, por) {
  const res = await require('./comisionesCinc').revisar(compraId);
  const db = await getDB();
  const lineas = res.filas.filter(f => RECLAMABLE[f.estado] && f.deMas > 0.009)
    .map(f => ({ num: f.num, cliente: f.cliente || null, descripcion: f.descripcion, cobra: f.cobra, debe: f.debe, deMas: f.deMas, estado: f.estado, motivo: RECLAMABLE[f.estado], yaEn: f.yaEn || null }));
  const mirar = res.filas.filter(f => A_MIRAR[f.estado]).map(f => ({ num: f.num, descripcion: f.descripcion, cobra: f.cobra, debe: f.debe, estado: f.estado, motivo: A_MIRAR[f.estado] }));
  const importe = r2(lineas.reduce((a, l) => a + l.deMas, 0));
  const clave = { proveedor: 'CINC', compraId: String(res.compra.id) };
  const ya = await db.collection(COL).findOne(clave);
  if (!lineas.length && !mirar.length) {
    if (ya && ya.estado === 'pendiente') await db.collection(COL).deleteOne({ _id: ya._id });
    return { ...res, reclamacion: ya && ya.estado !== 'pendiente' ? _pub(ya) : null };
  }
  const set = { ...clave, factura: res.compra.numero || null, fechaFactura: res.compra.fecha || null, lineas, mirar, importe, conIva: r2(importe * 1.21), comprobada: new Date(), comprobadaPor: por || '' };
  if (!importe && ya && ya.estado === 'pendiente' && !mirar.length) { await db.collection(COL).deleteOne({ _id: ya._id }); return { ...res, reclamacion: null }; }
  await db.collection(COL).updateOne(clave, { $set: set, $setOnInsert: { estado: 'pendiente', creada: new Date(), historial: [] } }, { upsert: true });
  return { ...res, reclamacion: _pub(await db.collection(COL).findOne(clave)) };
}

// Todas las facturas de CINC que hay en Compras (para ponerse al día de una vez).
async function revisarTodasCinc(por) {
  const db = await getDB();
  const cs = await db.collection('compras').find({ proveedor: /cinc/i, estado: { $ne: 'descartada' }, duplicadoDe: null, tipo: { $ne: 'devolucion' } }).project({ _id: 1, numero: 1 }).sort({ fecha: 1 }).toArray();
  let conErrores = 0; const fallos = [];
  for (const c of cs) {
    try { const r = await desdeCinc(String(c._id), por); if (r.reclamacion && r.reclamacion.importe > 0) conErrores++; }
    catch (e) { fallos.push(`${c.numero || c._id}: ${e.message}`); }
  }
  return { revisadas: cs.length, conErrores, fallos };
}

// Facturas de CINC que llegaron al correo y no están en Compras (el correo de CINC se clasificaba como
// administrador de fincas, no como factura): se traen al archivo, se leen y se comprueban todas.
// Tarda (la IA lee cada PDF): va en segundo plano y la página pregunta cómo va.
let _trabajo = null;
function estadoTrabajo() { return _trabajo; }
async function traerCincDelCorreo({ desde = '2025-01-01' } = {}, por) {
  if (_trabajo && !_trabajo.fin) return _trabajo;
  _trabajo = { inicio: new Date(), fin: null, correos: 0, nuevas: 0, yaEstaban: 0, fallos: [], fase: 'buscando en el correo' };
  (async () => {
    const T = _trabajo;
    try {
      const ei = require('./email-intelligence');
      const gmail = ei.getGmailClient();
      const db = await getDB();
      const q = `from:cinc.es has:attachment after:${desde.replace(/-/g, '/')}`;
      const ids = []; let pageToken;
      do { const r = await gmail.users.messages.list({ userId: 'me', q, maxResults: 100, pageToken }); (r.data.messages || []).forEach(m => ids.push(m.id)); pageToken = r.data.nextPageToken; } while (pageToken && ids.length < 300);
      T.correos = ids.length; T.fase = 'leyendo las facturas';
      for (const id of ids) {
        try {
          if (await db.collection('compras').findOne({ gmailId: id })) { T.yaEstaban++; continue; }
          const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
          const h = msg.data.payload.headers || [];
          const asunto = (h.find(x => x.name === 'Subject') || {}).value || '';
          const de = (h.find(x => x.name === 'From') || {}).value || '';
          if (!/factura|fra\.?|F2\d\/\d/i.test(asunto)) continue;   // avisos y presupuestos de CINC con adjunto: no
          const nuevas = await ei.comprasDesdeCorreo(id, ei.extractAttachments(msg.data.payload), { de, asunto, fecha: new Date(Number(msg.data.internalDate)) }, { estadoInicial: 'archivo', silencioso: true });
          T.nuevas += nuevas.length;
        } catch (e) { T.fallos.push(e.message); }
      }
      T.fase = 'comprobando las comisiones';
      T.revision = await revisarTodasCinc(por);
    } catch (e) { T.fallos.push(e.message); }
    T.fin = new Date(); T.fase = 'hecho';
  })();
  return _trabajo;
}

function _pub(r) { return r ? { ...r, id: String(r._id), _id: undefined } : null; }

async function lista() {
  const db = await getDB();
  const rs = (await db.collection(COL).find({}).sort({ fechaFactura: 1 }).toArray()).map(_pub);
  const suma = e => r2(rs.filter(r => r.estado === e).reduce((a, r) => a + (r.importe || 0), 0));
  // Abonos de CINC que han llegado (Compras) para enlazarlos al dar una por resuelta.
  const abonos = await db.collection('compras').find({ proveedor: /cinc/i, tipo: 'devolucion', estado: { $ne: 'descartada' } })
    .project({ numero: 1, fecha: 1, total: 1, base: 1 }).sort({ fecha: -1 }).limit(20).toArray();
  return {
    reclamaciones: rs,
    totales: { pendiente: suma('pendiente'), reclamada: suma('reclamada'), resuelta: suma('resuelta') },
    porCobrar: r2(suma('pendiente') + suma('reclamada')), porCobrarConIva: r2((suma('pendiente') + suma('reclamada')) * 1.21),
    abonos: abonos.map(a => ({ id: String(a._id), numero: a.numero, fecha: a.fecha, base: a.base, total: a.total })),
  };
}
// Resumen corto para el aviso del panel de CINC en Compras y para el dashboard.
async function pendienteProveedor(proveedor = 'CINC') {
  const db = await getDB();
  const rs = await db.collection(COL).find({ proveedor, estado: { $in: ['pendiente', 'reclamada'] } }).project({ importe: 1, estado: 1 }).toArray();
  const s = e => r2(rs.filter(r => r.estado === e).reduce((a, r) => a + (r.importe || 0), 0));
  return { facturas: rs.length, pendiente: s('pendiente'), reclamada: s('reclamada'), total: r2(s('pendiente') + s('reclamada')) };
}

async function cambiarEstado(id, { estado, fecha, abono, nota } = {}, por) {
  if (!ESTADOS.includes(estado)) throw new Error('Estado no válido');
  const db = await getDB();
  const r = await db.collection(COL).findOne({ _id: _oid(id) });
  if (!r) throw new Error('Reclamación no encontrada');
  const f = /^\d{4}-\d{2}-\d{2}$/.test(String(fecha || '')) ? fecha : hoy();
  const set = { estado };
  if (estado === 'reclamada') set.reclamadaEl = f;
  if (estado === 'resuelta') { set.resueltaEl = f; set.abono = String(abono || '').trim().slice(0, 60) || null; }
  if (nota != null) set.nota = String(nota).trim().slice(0, 300) || null;
  await db.collection(COL).updateOne({ _id: r._id }, { $set: set, $push: { historial: { estado, fecha: f, por: por || '', abono: set.abono || null, nota: set.nota || null, at: new Date() } } });
  return _pub(await db.collection(COL).findOne({ _id: r._id }));
}
// «Ya se lo he enviado»: todas las pendientes pasan a reclamadas con esa fecha.
async function marcarReclamadas(ids, fecha, por) {
  const out = [];
  for (const id of ids || []) out.push(await cambiarEstado(id, { estado: 'reclamada', fecha }, por));
  return { ok: true, n: out.length };
}

// Texto para mandar a CINC (correo o WhatsApp) con lo pendiente y lo ya reclamado sin resolver.
function textoReclamacion(rs, { formato = 'correo' } = {}) {
  const eur = v => Number(v || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  const abiertas = rs.filter(r => ['pendiente', 'reclamada'].includes(r.estado) && r.importe > 0);
  const total = r2(abiertas.reduce((a, r) => a + r.importe, 0));
  const wa = formato === 'whatsapp';
  const b = s => (wa ? `*${s}*` : s);
  const L = [];
  L.push(wa ? 'Hola, os pasamos las comisiones que hay que corregir:' : 'Hola,\n\nRevisando vuestras facturas de comisiones (10 % de la base imponible de nuestras facturas) hemos encontrado estas diferencias:');
  for (const r of abiertas) {
    L.push('');
    L.push(b(`Factura ${r.factura || '?'}${r.fechaFactura ? ' (' + r.fechaFactura.split('-').reverse().join('/') + ')' : ''}${r.estado === 'reclamada' && r.reclamadaEl ? ' — ya reclamada el ' + r.reclamadaEl.split('-').reverse().join('/') : ''}`));
    for (const l of r.lineas) {
      const ref = l.num ? l.num.replace(/^FAC0*/, 'FAC') : '?';
      L.push(`${wa ? '• ' : '  - '}${ref}${l.cliente ? ' ' + l.cliente : ''}: cobráis ${eur(l.cobra)}${l.debe != null && l.estado !== 'duplicada' && l.estado !== 'ya_cobrada' ? `, el 10 % de la base es ${eur(l.debe)}` : ''} → ${l.motivo.toLowerCase()}${l.yaEn ? ' (' + l.yaEn.join(', ') + ')' : ''}. De más: ${eur(l.deMas)}`);
    }
  }
  L.push('');
  L.push(b(`Total cobrado de más: ${eur(total)} + IVA = ${eur(total * 1.21)}`));
  L.push(wa ? '¿Nos podéis hacer el abono? Gracias.' : '\n¿Nos podéis emitir una factura de abono por ese importe? Cualquier duda nos decís.\n\nGracias,\nCorp Projects Holding');
  return { texto: L.join('\n'), total, conIva: r2(total * 1.21), facturas: abiertas.length };
}

module.exports = { traerCincDelCorreo, estadoTrabajo, desdeCinc, revisarTodasCinc, lista, pendienteProveedor, cambiarEstado, marcarReclamadas, textoReclamacion, RECLAMABLE, A_MIRAR };
