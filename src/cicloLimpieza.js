// src/cicloLimpieza.js — Limpieza del tablero del ciclo (6/11/2026, Álex: «me salen cosas ya muy antiguas… si hay cosas
// que se hicieron y ya están facturadas, se tendría que hacer una limpieza de todo esto»).
// El tablero lee de StelOrder todo lo abierto, y mucho se hizo y se facturó por otro lado (dentro de un presupuesto, en
// una factura agrupada) o era un aviso que nadie cerró. Aquí se clasifica para revisarlo de golpe en /limpieza:
//   · facturado: el cliente tiene una factura de después (hasta 120 días) → «ya facturado aparte» (marcado por defecto);
//   · sinFactura: pedido cerrado en StelOrder y el cliente no tiene ninguna factura de después → ¿se nos pasó facturar?
//     (no se marca nada por defecto; «Hay que facturarlo» lo apunta en Pendientes para la oficina);
//   · viejo: por asignar desde hace más de 30 días y sin factura → cerrar o dejar.
// Acciones: ignorar (sale del tablero; el pedido no se toca), cerrar (incidencia a Cerrada en StelOrder), hecho
// (petición sin incidencia), facturar (pendiente para la oficina). Solo lee cachés de StelOrder; escribe al cerrar.
'use strict';
const VENTANA = 120, VIEJO = 30;
const ymd = x => String(x || '').slice(0, 10);
const masDias = (f, n) => { const d = new Date(f + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function lista() {
  const S = require('./stelorder');
  const [d, wos, facMap, incs] = await Promise.all([require('./ciclo').datos(), S.getAllWorkOrders(), S.getAllOrdinaryInvoices().catch(() => ({})), S.getAllIncidents()]);
  const facs = Object.values(facMap || {});
  const woById = new Map((wos || []).map(w => [String(w.id), w]));
  const incByRef = new Map((incs || []).map(i => [i['full-reference'], i]));
  const col = k => (d.columnas.find(c => c.k === k) || { tarjetas: [] }).tarjetas;
  const grupos = { facturado: [], sinFactura: [], viejo: [] };
  for (const t of [...col('facturar'), ...col('asignar')]) {
    if (t.col === 'asignar' && t.dias <= VIEJO) continue;
    if (t.col === 'asignar' && /va con/.test(t.etiqueta || '')) continue;
    let acc = null, fecha = null;
    if (t.woId) { const w = woById.get(String(t.woId)); if (w) { acc = String(w['account-id']); fecha = ymd(w.date); } }
    else if (t.incRef) { const i = incByRef.get(t.incRef); if (i) { acc = String(i['account-id']); fecha = ymd(i.date); } }
    const despues = acc && fecha ? facs.filter(f => f.accountId === acc && ymd(f.date) >= fecha && ymd(f.date) <= masDias(fecha, VENTANA)).sort((a, b) => ymd(a.date) < ymd(b.date) ? -1 : 1) : [];
    const tipo = t.id.split(':')[0];   // wo | inc | pet
    const fila = {
      id: t.id, tipo, col: t.col, ref: t.ref, incRef: t.incRef || null, cliente: t.cliente, que: t.que, dias: t.dias, fecha, etiqueta: t.etiqueta, peticionId: t.peticionId || null,
      facturas: despues.slice(0, 3).map(f => ({ ref: f.number, fecha: ymd(f.date), total: Math.round((f.total || 0) * 100) / 100 })),
      acciones: tipo === 'inc' ? ['cerrar', 'ignorar'] : tipo === 'pet' ? ['hecho'] : ['ignorar'],
    };
    if (despues.length) grupos.facturado.push({ ...fila, sugerida: fila.acciones[0] });
    else if (t.col === 'facturar') grupos.sinFactura.push({ ...fila, acciones: ['ignorar', 'facturar'], sugerida: null });
    else grupos.viejo.push({ ...fila, sugerida: null });
  }
  for (const g of Object.values(grupos)) g.sort((a, b) => b.dias - a.dias);
  return grupos;
}

async function aplicar(acciones = [], por = '') {
  const C = require('./ciclo');
  const res = [];
  for (const a of (acciones || []).slice(0, 150)) {
    try {
      if (a.accion === 'ignorar') { const id = a.tipo === 'inc' ? 'inc:' + a.incRef : a.id; await C.ignorar(id, a.motivo || 'limpieza: ya facturado aparte o no se factura', por); }
      else if (a.accion === 'cerrar') { if (!a.incRef) throw new Error('Sin incidencia'); await C.cerrarIncidencia(a.incRef, 'cerrada', por); }
      else if (a.accion === 'hecho') { if (!a.peticionId) throw new Error('Sin petición'); await require('./peticionesGrupo').marcar(a.peticionId, { estado: 'hecho', nota: 'Limpieza del tablero' }, por); }
      else if (a.accion === 'facturar') {
        await require('./pendientes').addPendiente(`Facturar ${a.ref}${a.cliente ? ' · ' + a.cliente : ''} (cerrado en StelOrder sin factura)`, `panel:${por || 'Oficina'}`, { quien: 'oficina', obra: a.cliente || null, detalle: `${a.que || ''}\nSalió en la limpieza del tablero del ${new Date().toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' })}: el cliente no tiene ninguna factura de después.` });
        await C.ignorar(a.id, 'limpieza: apuntado en Pendientes para facturar', por);
      } else continue;
      res.push({ id: a.id, ok: true });
    } catch (e) { res.push({ id: a.id, ok: false, error: e.message }); }
  }
  return { hechas: res.filter(r => r.ok).length, errores: res.filter(r => !r.ok) };
}

module.exports = { lista, aplicar };
