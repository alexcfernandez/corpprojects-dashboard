// src/pendientesFamiliaPdf.js — Lo que nos deben: total + bloques por familia, en PDF A4
// para imprimir (15/10/2026). Lo usan el botón de «Pendientes de cobro» del dashboard
// (respeta sus filtros) y Corpy (enlace firmado /informe/pendientes/<token>).
// Datos: los de stel.getPendingInvoices() (con caché), sin llamadas nuevas a StelOrder.
'use strict';

const SIN = 'Sin familia';

// Agrupa por familia → clientes → facturas. Mayor deuda primero; «Sin familia» al final.
function agrupar(pend) {
  const fams = {};
  for (const i of pend || []) {
    const f = String(i.family || '').trim() || SIN, c = i.client || '(sin nombre)';
    const b = fams[f] || (fams[f] = { nombre: f, total: 0, n: 0, cli: {} });
    const x = b.cli[c] || (b.cli[c] = { nombre: c, total: 0, n: 0, facturas: [] });
    b.total += i.pending || 0; b.n++;
    x.total += i.pending || 0; x.n++; x.facturas.push(i);
  }
  const bloques = Object.values(fams)
    .sort((a, b) => (a.nombre === SIN) - (b.nombre === SIN) || b.total - a.total)
    .map(b => ({ ...b, clientes: Object.values(b.cli).sort((x, y) => y.total - x.total)
      .map(c => ({ ...c, facturas: c.facturas.sort((p, q) => (q.daysOverdue || 0) - (p.daysOverdue || 0)) })) }));
  const total = (pend || []).reduce((s, i) => s + (i.pending || 0), 0);
  return { total, n: (pend || []).length, nFamilias: bloques.filter(b => b.nombre !== SIN).length, conSinFamilia: !!fams[SIN], bloques };
}

// Mismos filtros que la pestaña Pendientes (nivel de días, familia, búsqueda).
const NIVELES = { warning1: ['warning1', 'warning2', 'urgent', 'critical'], warning2: ['warning2', 'urgent', 'critical'], urgent: ['urgent', 'critical'], critical: ['critical'] };
const NIVEL_TXT = { warning1: '15+ días', warning2: '30+ días', urgent: '45+ días', critical: '60+ días' };
function filtrar(pend, { familia = '', nivel = '', q = '' } = {}) {
  let l = pend || [];
  if (NIVELES[nivel]) l = l.filter(i => NIVELES[nivel].includes(i.alertLevel));
  if (familia) l = l.filter(i => (i.family || SIN) === familia);
  const s = String(q || '').toLowerCase().trim();
  if (s) l = l.filter(i => String(i.client || '').toLowerCase().includes(s) || String(i.number || '').toLowerCase().includes(s) || String(i.family || '').toLowerCase().includes(s));
  return l;
}
function describirFiltro({ familia = '', nivel = '', q = '' } = {}) {
  return [familia && `familia ${familia}`, NIVEL_TXT[nivel] && `solo ${NIVEL_TXT[nivel]} sin cobrar`, q && `búsqueda «${q}»`].filter(Boolean).join(' · ');
}

// 1234.5 → "1.234,50 €" (siempre con punto de miles: se lee mejor impreso).
function eur(n) {
  const [e, d] = Math.abs(Number(n) || 0).toFixed(2).split('.');
  return `${n < 0 ? '-' : ''}${e.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${d} €`;
}
function fecha(d) {
  const x = d ? new Date(d) : null;
  return x && !isNaN(x) ? `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}` : '—';
}

// Helvetica estándar solo codifica WinAnsi: lo demás se quita el acento o se cambia por «?».
const WINANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
function limpio(s) {
  return Array.from(String(s == null ? '' : s).normalize('NFC')).map(ch => {
    const c = ch.codePointAt(0);
    if ((c >= 32 && c <= 126) || (c >= 160 && c <= 255) || WINANSI_EXTRA.includes(ch)) return ch;
    if (c < 32) return ' ';
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return base && base.codePointAt(0) <= 255 ? base : '?';
  }).join('');
}

async function generar(pend, { filtro = {}, ahora = new Date() } = {}) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const g = agrupar(pend);
  const doc = await PDFDocument.create();
  doc.setTitle('Pendiente de cobro por familia'); doc.setAuthor('Corp Projects');
  const F = await doc.embedFont(StandardFonts.Helvetica), FB = await doc.embedFont(StandardFonts.HelveticaBold);

  const W = 595.28, H = 841.89, M = 36, ABAJO = 48, ANCHO = W - 2 * M;
  const NEGRO = rgb(0.1, 0.1, 0.12), GRIS = rgb(0.42, 0.42, 0.46), LINEA = rgb(0.82, 0.82, 0.85), BANDA = rgb(0.92, 0.93, 0.95), ROJO = rgb(0.72, 0.12, 0.12);
  // Columnas del detalle (suman ANCHO = 523 pt).
  const COLS = [
    { t: 'Factura', w: 74 }, { t: 'Cliente', w: 233 }, { t: 'Emitida', w: 64 }, { t: 'Días', w: 46, der: true }, { t: 'Pendiente', w: 106, der: true },
  ];
  let page, y;

  const ajustar = (txt, font, size, w) => {
    let s = limpio(txt);
    if (font.widthOfTextAtSize(s, size) <= w) return s;
    while (s.length > 1 && font.widthOfTextAtSize(s + '…', size) > w) s = s.slice(0, -1);
    return s.trimEnd() + '…';
  };
  const texto = (txt, x, yy, { font = F, size = 9, color = NEGRO, w = null, der = false } = {}) => {
    const s = w ? ajustar(txt, font, size, w) : limpio(txt);
    const dx = der ? (w || 0) - font.widthOfTextAtSize(s, size) : 0;
    page.drawText(s, { x: x + dx, y: yy, size, font, color });
  };
  const raya = (yy, color = LINEA, grosor = 0.5) => page.drawLine({ start: { x: M, y: yy }, end: { x: W - M, y: yy }, thickness: grosor, color });
  const cabeceraCols = () => {
    let x = M;
    for (const c of COLS) { texto(c.t, x + 3, y, { font: FB, size: 8, color: GRIS, w: c.w - 6, der: c.der }); x += c.w; }
    y -= 5; raya(y, GRIS, 0.6); y -= 12;
  };
  const nuevaPagina = (conColumnas) => {
    page = doc.addPage([W, H]); y = H - M;
    if (doc.getPageCount() > 1) { texto('Pendiente de cobro por familia (continuación)', M, y, { font: FB, size: 9, color: GRIS }); y -= 20; }
    if (conColumnas) cabeceraCols();
  };
  const sitio = (alto, conColumnas = true) => { if (y - alto < ABAJO) nuevaPagina(conColumnas); };

  // ── Portada: título, total y resumen por familia ──
  nuevaPagina(false);
  texto('CORP PROJECTS', M, y, { font: FB, size: 9, color: GRIS }); y -= 22;
  texto('Pendiente de cobro por familia', M, y, { font: FB, size: 18 }); y -= 16;
  const filtroTxt = describirFiltro(filtro);
  texto(`A ${fecha(ahora)} ${String(ahora.getHours()).padStart(2, '0')}:${String(ahora.getMinutes()).padStart(2, '0')}${filtroTxt ? ` · Filtro: ${filtroTxt}` : ''}`, M, y, { size: 9, color: GRIS, w: ANCHO }); y -= 26;

  page.drawRectangle({ x: M, y: y - 14, width: ANCHO, height: 34, color: BANDA });
  texto('TOTAL PENDIENTE', M + 10, y + 4, { font: FB, size: 8, color: GRIS });
  texto(`${g.n} facturas · ${g.nFamilias} familia${g.nFamilias === 1 ? '' : 's'}${g.conSinFamilia ? ' + sin familia' : ''}`, M + 10, y - 8, { size: 9, color: GRIS });
  texto(eur(g.total), M, y - 6, { font: FB, size: 16, w: ANCHO - 10, der: true });
  y -= 40;

  if (!g.n) {
    texto('No hay facturas pendientes con estos filtros.', M, y, { size: 11 });
  } else {
    texto('Resumen por familia', M, y, { font: FB, size: 11 }); y -= 16;
    const R = [{ t: 'Familia', w: 291 }, { t: 'Facturas', w: 60, der: true }, { t: '% del total', w: 66, der: true }, { t: 'Pendiente', w: 106, der: true }];
    const cabR = () => { let x = M; for (const c of R) { texto(c.t, x + 3, y, { font: FB, size: 8, color: GRIS, w: c.w - 6, der: c.der }); x += c.w; } y -= 5; raya(y, GRIS, 0.6); y -= 12; };
    cabR();
    for (const b of g.bloques) {
      if (y - 14 < ABAJO) { nuevaPagina(false); cabR(); }
      const vals = [b.nombre, String(b.n), g.total ? `${Math.round((b.total / g.total) * 100)} %` : '—', eur(b.total)];
      let x = M; R.forEach((c, k) => { texto(vals[k], x + 3, y, { font: k === 3 ? FB : F, size: 9, w: c.w - 6, der: c.der }); x += c.w; });
      y -= 4; raya(y); y -= 10;
    }
    y -= 4; texto('Total', M + 3, y, { font: FB, size: 9 }); texto(eur(g.total), M + 3, y, { font: FB, size: 9, w: ANCHO - 6, der: true }); y -= 30;

    // ── Detalle: un bloque por familia con sus facturas ──
    sitio(60, false);
    texto('Detalle por familia', M, y, { font: FB, size: 11 }); y -= 16;
    cabeceraCols();
    for (const b of g.bloques) {
      sitio(22 + 2 * 14); // la banda nunca se queda sola al pie de la página
      const banda = (cont) => {
        page.drawRectangle({ x: M, y: y - 5, width: ANCHO, height: 17, color: BANDA });
        texto(b.nombre + (cont ? ' (cont.)' : ''), M + 4, y, { font: FB, size: 10, w: 330 });
        texto(`${b.n} fact. · ${eur(b.total)}`, M, y, { font: FB, size: 10, w: ANCHO - 6, der: true });
        y -= 20;
      };
      banda(false);
      for (const c of b.clientes) for (const i of c.facturas) {
        if (y - 14 < ABAJO) { nuevaPagina(true); banda(true); }
        const dias = i.daysOverdue || 0;
        const vals = [i.number || '—', c.nombre, fecha(i.date), `${dias}`, eur(i.pending)];
        let x = M;
        COLS.forEach((col, k) => {
          const fuerte = (k === 3 && dias >= 60) || k === 4;
          texto(vals[k], x + 3, y, { font: fuerte ? FB : F, size: 9, color: k === 3 && dias >= 60 ? ROJO : NEGRO, w: col.w - 6, der: col.der });
          x += col.w;
        });
        y -= 4; raya(y); y -= 10;
      }
      y -= 8;
    }
    sitio(24);
    raya(y + 6, NEGRO, 0.8);
    texto('TOTAL PENDIENTE', M + 3, y - 8, { font: FB, size: 10 });
    texto(eur(g.total), M + 3, y - 8, { font: FB, size: 10, w: ANCHO - 6, der: true });
  }

  // Pie: fecha y «Página x de n» en todas.
  const pags = doc.getPages();
  pags.forEach((p, k) => {
    page = p;
    texto(`Corp Projects · Pendiente de cobro por familia · ${fecha(ahora)}`, M, 24, { size: 7.5, color: GRIS });
    texto(`Página ${k + 1} de ${pags.length}`, M, 24, { size: 7.5, color: GRIS, w: ANCHO, der: true });
  });
  return Buffer.from(await doc.save());
}

// Enlace firmado (enlaceDoc, uso propio) para mandarlo por WhatsApp: siempre datos frescos.
const ID_INFORME = '0'.repeat(24); // enlaceDoc firma ids de 24 hex; este no es un documento real
function enlace({ dias = 2 } = {}) {
  const E = require('./enlaceDoc');
  return `${String(process.env.DASHBOARD_URL || 'https://dashboard.corpprojects.es').replace(/\/$/, '')}/informe/pendientes/${E.crear(ID_INFORME, { dias, uso: 'pendfam' })}`;
}
const verificarEnlace = token => require('./enlaceDoc').verificar(token, { uso: 'pendfam' }) === ID_INFORME;

module.exports = { agrupar, filtrar, generar, enlace, verificarEnlace, eur, SIN };
