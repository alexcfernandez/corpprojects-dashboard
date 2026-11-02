// src/planificacionPdf.js — PDF diario de trabajos y presupuestos (2/11/2026, Álex: «cada día unos PDFs de los
// presupuestos pendientes y de las cosas pendientes de trabajo y quién las está ejecutando; algo así como un Gantt»).
//
// A4 apaisado:
//   1. Gantt de los trabajos asignados (workOrderAssignments que vienen de una petición), por operario: desde que se
//      encargó hasta la cita; cita en azul, hecho en verde, atrasado sin parte en rojo, sin día en ámbar.
//   2. Trabajos sin asignar (incidencias de actuación abiertas sin pedido de un operario).
//   3. Presupuestos por hacer (incidencias de presupuesto abiertas) con barra de antigüedad.
//   4. Presupuestos enviados que esperan respuesta (PRT pendientes de los últimos 120 días).
// Datos de StelOrder con su caché (sin llamadas nuevas si ya están). Se manda cada mañana por WhatsApp (avisar()).
'use strict';
const WINANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const TZ = 'Europe/Madrid';
const hoyISO = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: TZ });
const masDias = (f, n) => { const d = new Date(f + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const entre = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);
const ymd = d => d ? new Date(d).toLocaleDateString('en-CA', { timeZone: TZ }) : null;
const DIAS = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
const eur = n => { const [e, d] = Math.abs(Number(n) || 0).toFixed(2).split('.'); return `${e.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${d} €`; };
function limpio(s) {
  return Array.from(String(s == null ? '' : s).normalize('NFC')).map(ch => {
    const c = ch.codePointAt(0);
    if ((c >= 32 && c <= 126) || (c >= 160 && c <= 255) || WINANSI_EXTRA.includes(ch)) return ch;
    if (c < 32) return ' ';
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return base && base.codePointAt(0) <= 255 ? base : '';
  }).join('').replace(/\s+/g, ' ').trim();
}

// ── Datos ──
async function datos({ hoy = hoyISO(), _S = null, _db = null } = {}) {
  const S = _S || require('./stelorder');
  const db = _db || await require('./db').getDB();
  const desde = masDias(hoy, -14);
  // Trabajos asignados: abiertos + cerrados en las 2 últimas semanas.
  const asig = await db.collection('workOrderAssignments').find({ peticionId: { $exists: true }, $or: [{ status: { $ne: 'done' } }, { doneAt: { $gte: new Date(desde + 'T00:00:00Z') } }], cerrado: { $ne: true } }).toArray();
  const trabajos = asig.map(a => ({
    operario: a.userName || '¿?', equipo: a.equipo || [], cliente: a.cliente || '', que: a.resumen || '', pedido: a.pedidoRef || '', incidencia: a.incidenciaRef || '',
    encargado: ymd(a.assignedAt) || hoy, cita: a.fecha || null, hora: a.hora || null, hecho: a.status === 'done' ? (ymd(a.doneAt) || a.fecha || hoy) : null,
    pendiente: a.motivoPendiente || null, tipo: a.tipo || 'trabajo',
  })).sort((x, y) => x.operario.localeCompare(y.operario) || String(x.cita || '9').localeCompare(String(y.cita || '9')));
  const conPedido = new Set(asig.map(a => a.incidenciaRef).filter(Boolean));
  const inc = await require('./incidenciasDia').datos({ _S: S, _db: db });
  const sinAsignar = inc.trabajos.filter(i => !conPedido.has(i.ref));
  const presupuestos = inc.presupuestos.filter(i => !conPedido.has(i.ref));
  // Presupuestos enviados esperando respuesta.
  let enviados = [];
  try {
    const [est, { clientMap }] = await Promise.all([S.getWorkEstimates(), S.getClients()]);
    const lim = masDias(hoy, -120);
    enviados = (est || []).filter(e => !e.deleted && Number(e['document-state-id']) === 1120641 && String(e.date).slice(0, 10) >= lim)
      .map(e => { const c = clientMap[String(e['account-id'])] || {}; return { ref: e['full-reference'], fecha: String(e.date).slice(0, 10), dias: entre(String(e.date).slice(0, 10), hoy), cliente: c['legal-name'] || c.name || '', titulo: e.title || '', total: Number(e['total-amount']) || 0 }; })
      .sort((a, b) => b.dias - a.dias);
  } catch (e) { console.warn('[PlanificacionPdf] presupuestos:', e.message); }
  return { hoy, trabajos, sinAsignar, presupuestos, enviados };
}

// ── PDF ──
async function generar(d) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const F = await doc.embedFont(StandardFonts.Helvetica), FB = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 842, H = 595, M = 28;
  const C = { tinta: rgb(0.13, 0.15, 0.18), gris: rgb(0.45, 0.47, 0.5), linea: rgb(0.86, 0.87, 0.89), fondo: rgb(0.965, 0.97, 0.975), hoy: rgb(0.99, 0.95, 0.8),
    azul: rgb(0.22, 0.47, 0.85), verde: rgb(0.18, 0.62, 0.38), rojo: rgb(0.85, 0.26, 0.24), ambar: rgb(0.93, 0.62, 0.12), espera: rgb(0.72, 0.75, 0.8) };
  let pg, y;
  const corta = (t, f, s, w) => { t = limpio(t); if (f.widthOfTextAtSize(t, s) <= w) return t; while (t && f.widthOfTextAtSize(t + '…', s) > w) t = t.slice(0, -1); return t + '…'; };
  const txt = (t, x, yy, { s = 8, f = F, c = C.tinta, w = null } = {}) => pg.drawText(w ? corta(t, f, s, w) : limpio(t), { x, y: yy, size: s, font: f, color: c });
  const fechaLarga = new Date(d.hoy + 'T12:00:00Z').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  let nPag = 0;
  const nueva = titulo => {
    pg = doc.addPage([W, H]); nPag++; y = H - M;
    txt('Corp Projects · Trabajos y presupuestos', M, y - 4, { s: 9, c: C.gris });
    txt(fechaLarga, W - M - 160, y - 4, { s: 9, c: C.gris, w: 160 });
    y -= 26; txt(titulo, M, y, { s: 15, f: FB }); y -= 18;
  };
  const sitio = h => { if (y - h < M + 14) return false; return true; };

  // 1. Gantt
  const D0 = masDias(d.hoy, -7), ND = 22, LX = M + 250, DW = (W - M - LX) / ND, RH = 15;
  const xDia = f => LX + Math.max(0, Math.min(ND, entre(D0, f))) * DW;
  // Fondo de fin de semana y de hoy solo en la franja de cada fila (no por debajo de las tablas).
  const franja = (yb, h) => {
    for (let i = 0; i < ND; i++) {
      const f = masDias(D0, i), dw = new Date(f + 'T12:00:00Z').getUTCDay();
      if (f === d.hoy) pg.drawRectangle({ x: LX + i * DW, y: yb, width: DW, height: h, color: C.hoy });
      else if (dw === 0 || dw === 6) pg.drawRectangle({ x: LX + i * DW, y: yb, width: DW, height: h, color: C.fondo });
    }
  };
  const cabGantt = () => {
    franja(y - 12, 22);
    for (let i = 0; i < ND; i++) {
      const f = masDias(D0, i), dw = new Date(f + 'T12:00:00Z').getUTCDay();
      txt(DIAS[dw], LX + i * DW + DW / 2 - 2.5, y, { s: 7, c: C.gris });
      txt(f.slice(8, 10), LX + i * DW + DW / 2 - 4, y - 9, { s: 7, f: f === d.hoy ? FB : F, c: f === d.hoy ? C.tinta : C.gris });
    }
    txt('Trabajo', M, y - 9, { s: 7, f: FB, c: C.gris }); y -= 16;
    pg.drawLine({ start: { x: M, y: y + 3 }, end: { x: W - M, y: y + 3 }, thickness: 0.6, color: C.linea });
  };
  nueva(`Trabajos en curso (${d.trabajos.filter(t => !t.hecho).length} abiertos, ${d.trabajos.filter(t => t.hecho).length} hechos en 2 semanas)`);
  // Leyenda
  const ley = [['Encargado, esperando', C.espera], ['Cita', C.azul], ['Hecho', C.verde], ['Atrasado sin parte', C.rojo], ['Sin día (queda con el cliente)', C.ambar]];
  let lx = M; for (const [t, c] of ley) { pg.drawRectangle({ x: lx, y: y - 1, width: 9, height: 7, color: c }); txt(t, lx + 12, y, { s: 7, c: C.gris }); lx += 14 + F.widthOfTextAtSize(t, 7) + 14; }
  y -= 18;
  if (!d.trabajos.length) { txt('No hay trabajos asignados todavía. Se asignan contestando a «¿Quién va?» por WhatsApp.', M, y, { c: C.gris }); y -= 20; }
  else {
    cabGantt();
    let op = null;
    for (const t of d.trabajos) {
      if (!sitio(RH + (t.operario !== op ? 14 : 0))) { nueva('Trabajos en curso (sigue)'); cabGantt(); op = null; }
      if (t.operario !== op) { op = t.operario; franja(y - 13, 13); txt(op, M, y - 9, { s: 8.5, f: FB }); y -= 13; }
      const yb = y - 10;
      franja(y - RH, RH);
      txt(`${t.cliente}${t.que ? ' · ' + t.que : ''}`, M + 8, yb + 1, { s: 7.5, w: LX - M - 14 });
      const fin = t.hecho || t.cita || d.hoy;
      if (entre(t.encargado, fin) > 0) pg.drawRectangle({ x: xDia(t.encargado), y: yb + 2, width: Math.max(1, xDia(fin) - xDia(t.encargado)), height: 3, color: C.espera });
      if (!t.cita && !t.hecho) pg.drawRectangle({ x: xDia(t.encargado), y: yb, width: Math.max(DW, xDia(d.hoy) + DW - xDia(t.encargado)), height: 7, color: C.ambar, opacity: 0.85 });
      else {
        const f = t.hecho || t.cita, color = t.hecho ? C.verde : f < d.hoy ? C.rojo : C.azul;
        if (entre(D0, f) >= 0 && entre(D0, f) < ND) {
          pg.drawRectangle({ x: xDia(f) + 1, y: yb - 1, width: DW - 2, height: 9, color });
          if (t.hora && !t.hecho) txt(t.hora, xDia(f) + DW + 2, yb, { s: 6, c: C.gris });
        } else txt(f < D0 ? `‹ ${f.slice(8, 10)}/${f.slice(5, 7)}` : `${f.slice(8, 10)}/${f.slice(5, 7)} ›`, f < D0 ? LX + 2 : W - M - 30, yb, { s: 6.5, c: color });
      }
      y -= RH;
      pg.drawLine({ start: { x: M + 8, y: y + 3 }, end: { x: W - M, y: y + 3 }, thickness: 0.3, color: C.linea });
    }
    y -= 8;
  }

  // Tablas con barra de antigüedad
  const tabla = (titulo, filas, cols, { barra = null, total = null, vacio = '' } = {}) => {
    if (!sitio(60)) nueva(titulo); else { y -= 10; txt(titulo, M, y, { s: 12, f: FB }); y -= 16; }
    if (!filas.length) { txt(vacio, M, y, { c: C.gris }); y -= 16; return; }
    const cab = () => { let x = M; for (const c of cols) { txt(c.t, x, y, { s: 7, f: FB, c: C.gris, w: c.w - 4 }); x += c.w; } if (barra) txt(barra.t, x, y, { s: 7, f: FB, c: C.gris }); y -= 5; pg.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: C.linea }); y -= 10; };
    cab();
    for (const r of filas) {
      if (!sitio(13)) { nueva(`${titulo} (sigue)`); cab(); }
      let x = M; for (const c of cols) { txt(c.v(r), x, y, { s: 7.5, w: c.w - 6, f: c.bold ? FB : F, c: c.color ? c.color(r) : C.tinta }); x += c.w; }
      if (barra) { const v = barra.v(r), max = barra.max, ancho = (W - M - x - 30) * Math.min(1, v / max); pg.drawRectangle({ x, y: y - 1, width: Math.max(1.5, ancho), height: 7, color: v >= 60 ? C.rojo : v >= 30 ? C.ambar : C.verde }); txt(`${v} d`, x + Math.max(1.5, ancho) + 3, y, { s: 6.5, c: C.gris }); }
      y -= 12;
    }
    if (total) { y -= 2; txt(total, M, y, { s: 8, f: FB }); y -= 14; }
  };
  const dias = r => r.dias;
  tabla(`Trabajos sin asignar (${d.sinAsignar.length})`, d.sinAsignar, [
    { t: 'Incidencia', w: 62, v: r => r.ref, bold: true }, { t: 'Cliente', w: 170, v: r => r.cliente }, { t: 'Qué es', w: 300, v: r => r.que }, { t: 'Estado', w: 72, v: r => r.estado }],
    { barra: { t: 'Días abierta', v: dias, max: 120 }, vacio: 'Ninguno.' });
  tabla(`Presupuestos por hacer (${d.presupuestos.length})`, d.presupuestos, [
    { t: 'Incidencia', w: 62, v: r => r.ref, bold: true }, { t: 'Cliente', w: 170, v: r => r.cliente }, { t: 'Qué piden', w: 300, v: r => r.que }, { t: 'Estado', w: 72, v: r => r.estado }],
    { barra: { t: 'Días esperando', v: dias, max: 120 }, vacio: 'Ninguno.' });
  tabla(`Presupuestos enviados esperando respuesta (${d.enviados.length}, últimos 120 días)`, d.enviados, [
    { t: 'Presupuesto', w: 62, v: r => r.ref, bold: true }, { t: 'Cliente', w: 170, v: r => r.cliente }, { t: 'Título', w: 260, v: r => r.titulo }, { t: 'Total', w: 112, v: r => eur(r.total) }],
    { barra: { t: 'Días sin respuesta', v: dias, max: 120 }, total: `Total esperando respuesta: ${eur(d.enviados.reduce((s, r) => s + r.total, 0))}`, vacio: 'Ninguno.' });

  doc.getPages().forEach((p, i) => p.drawText(`${i + 1} / ${nPag}`, { x: W - M - 24, y: M - 8, size: 7, font: F, color: C.gris }));
  return Buffer.from(await doc.save());
}

function resumen(d) {
  const ab = d.trabajos.filter(t => !t.hecho), sinDia = ab.filter(t => !t.cita), atras = ab.filter(t => t.cita && t.cita < d.hoy), hoyL = ab.filter(t => t.cita === d.hoy);
  return `📊 *Trabajos y presupuestos* (PDF)\n` +
    `🔨 Trabajos asignados abiertos: ${ab.length}${hoyL.length ? ` · hoy ${hoyL.length}` : ''}${sinDia.length ? ` · sin día ${sinDia.length}` : ''}${atras.length ? ` · atrasados ${atras.length}` : ''}\n` +
    `📋 Sin asignar: ${d.sinAsignar.length} · 📝 Presupuestos por hacer: ${d.presupuestos.length}\n` +
    `⏳ Presupuestos enviados sin respuesta: ${d.enviados.length} (${eur(d.enviados.reduce((s, r) => s + r.total, 0))})`;
}

// Cada mañana a Álex y a la oficina: el PDF por WhatsApp con el resumen de pie.
async function avisar({ _datos = null } = {}) {
  const d = _datos || await datos();
  const pdf = await generar(d);
  const N = require('./notifications'), W = require('./canalWhatsapp');
  let ok = 0;
  for (const to of [...new Set([N.destinoDueno(), process.env.OFICINA_TELEFONO || '+34674013723'].filter(Boolean))]) {
    try { if (await W.enviarArchivo(to, resumen(d), { data: pdf, mime: 'application/pdf', nombre: `Trabajos-y-presupuestos-${d.hoy}.pdf` })) ok++; } catch (e) { console.warn('[PlanificacionPdf] envío:', e.message); }
  }
  return { enviado: ok > 0, destinos: ok, bytes: pdf.length };
}

module.exports = { datos, generar, resumen, avisar, limpio };
