// src/movimientosCuadre.js — «Movimientos y cuadre» (9/10/2026): cada cobro y cada pago del banco y de las tarjetas
// con la factura o facturas con las que casa, para que la oficina vea de un vistazo:
//   «Entró 3.400 € → FAC00975 (Comunidad Plaça Ciutat de Figueres 1) · cuadrado»
//   «Pago 5.190 € → Prefer: 3 facturas + 1 abono · cuadrado»
//   «Entró 2.000 € → FAC00990 (2.500 €) · parcial: faltan 500 €»
// Sale de la conciliación (trimestre.mapaPagos): lo que el sistema casa solo y lo que se ha casado a mano.
'use strict';
async function getDB() { return require('./db').getDB(); }
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const iso = d => new Date(d).toISOString().slice(0, 10);

// Estado del cuadre de un movimiento con sus documentos.
function cuadre(m, pm) {
  if (!pm) return { estado: 'sin_datos', texto: 'Sin cruzar todavía' };
  const docs = pm.docs || [];
  if (pm.estado === 'no_requiere') return { estado: 'no_requiere', texto: pm.nota || 'No necesita factura', docs };
  if (pm.estado === 'punteado' && docs.length) {
    const conTotal = docs.filter(d => d.total != null && !isNaN(Number(d.total)));
    const suma = r2(conTotal.reduce((a, d) => a + Number(d.total), 0));
    const imp = Math.abs(m.importe);
    // Facturas de proveedor llegan en positivo y los abonos en negativo: la suma ya los descuenta.
    const dif = conTotal.length === docs.length ? r2(imp - Math.abs(suma)) : null;
    const abonos = docs.filter(d => Number(d.total) < 0).length;
    const facturas = docs.length - abonos;
    const resumenDocs = docs.length === 1 ? docs[0].ref : `${facturas} factura${facturas === 1 ? '' : 's'}${abonos ? ` + ${abonos} abono${abonos === 1 ? '' : 's'}` : ''}`;
    if (dif == null || Math.abs(dif) < 1) return { estado: 'cuadrado', texto: resumenDocs, docs, suma, nota: pm.nota || null, confianza: pm.confianza };
    // Cobro de menos que las facturas: falta; de más: sobra (anticipo, otra factura…).
    return { estado: 'parcial', texto: resumenDocs, docs, suma, dif, nota: dif < 0 ? `Faltan ${(-dif).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' })} € de ${docs.length === 1 ? 'la factura' : 'esas facturas'}` : `Sobran ${dif.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' })} €`, confianza: pm.confianza };
  }
  return { estado: 'sin_cuadrar', texto: pm.nota || (m.importe > 0 ? 'No sé de qué factura es' : 'Sin factura'), docs };
}

async function lista({ dias = 31, desde, hasta } = {}) {
  const db = await getDB();
  const T = require('./trimestre');
  const hoy = new Date();
  const d1 = /^\d{4}-\d{2}-\d{2}$/.test(String(desde || '')) ? desde : iso(hoy.getTime() - Math.max(1, Math.min(400, Number(dias) || 31)) * 86400000);
  const d2 = /^\d{4}-\d{2}-\d{2}$/.test(String(hasta || '')) ? hasta : iso(hoy);
  const [bm, tm, ts, mapa] = await Promise.all([
    db.collection('bancoMovimientos').find({ fechaOperacion: { $gte: d1, $lte: d2 } }).project({ fechaOperacion: 1, importe: 1, concepto: 1, iban: 1, saldo: 1 }).toArray(),
    db.collection('tarjetaMovimientos').find({ fecha: { $gte: d1, $lte: d2 }, interno: { $ne: true } }).project({ fecha: 1, importe: 1, concepto: 1, tarjeta: 1, fuente: 1, estado: 1, tipo: 1 }).toArray(),
    db.collection('tarjetas').find({}).project({ persona: 1 }).toArray(),
    T.mapaPagos().catch(() => null),
  ]);
  const persona = Object.fromEntries(ts.map(t => [String(t._id), t.persona]));
  const reserva = process.env.RESERVA_IBAN || '6452';
  const quien = c => { try { return T.comercio(c); } catch (e) { return String(c || '').slice(0, 60); } };
  const movs = [
    ...bm.map(m => ({ id: String(m._id), fecha: m.fechaOperacion, importe: r2(m.importe), concepto: m.concepto || '', quien: quien(m.concepto),
      origen: `Santander …${String(m.iban || '').slice(-4) || '?'}${String(m.iban || '').endsWith(reserva) ? ' (reserva)' : ''}`, saldo: m.saldo != null ? r2(m.saldo) : null })),
    ...tm.filter(m => !/declined|reverted|failed/i.test(m.estado || '')).map(m => ({ id: String(m._id), fecha: m.fecha, importe: r2(m.importe), concepto: m.concepto || '', quien: quien(m.concepto),
      origen: `${m.fuente === 'revolut' ? 'Revolut' : 'Crédito'} …${m.tarjeta || ''}${persona[m.tarjeta] ? ' · ' + persona[m.tarjeta] : ''}`, tarjeta: true })),
  ].sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)) || Math.abs(b.importe) - Math.abs(a.importe));
  const out = movs.map(m => ({ ...m, ...cuadre(m, mapa ? mapa.porMov.get(m.id) : null) }));
  const suma = arr => r2(arr.reduce((a, m) => a + m.importe, 0));
  const ent = out.filter(m => m.importe > 0), sal = out.filter(m => m.importe < 0);
  const pend = out.filter(m => m.estado === 'sin_cuadrar' || m.estado === 'parcial');
  return {
    desde: d1, hasta: d2, sinCuadre: !mapa, movimientos: out,
    totales: { entradas: { n: ent.length, importe: suma(ent) }, salidas: { n: sal.length, importe: suma(sal) },
      cuadrados: out.filter(m => m.estado === 'cuadrado' || m.estado === 'no_requiere').length, pendientes: { n: pend.length, importe: suma(pend) } },
  };
}

module.exports = { lista, _cuadre: cuadre };
