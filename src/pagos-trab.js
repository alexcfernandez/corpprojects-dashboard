// src/pagos-trab.js
// Helpers PUROS para la captura de pagos a TRABAJADORES por WhatsApp.
// - semanaLaboral(): deduce la semana de trabajo (Lun–Vie) a partir de una fecha,
//   sin que el usuario tenga que decirla. Usa UTC para no depender del locale
//   (Railway no tiene datos ICU, toLocaleDateString('es-ES') peta).
// - etiquetas de mes con arrays fijos.
// - formatInforme(): resumen mensual para enseñar a un trabajador.

const MESES_ABBR = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MESES_FULL = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// Mapa: tipo "hablado" -> tipo del libro de colaboradores.
const TIPO_MAP = {
  adelanto:  'adelanto',
  pago:      'pago_semana',
  trabajo:   'semana_trabajada',
  prestamo:  'adelanto',     // un préstamo es dinero entregado (se cuenta como tal)
  descuento: 'descuento',
  devolucion:'devolucion',
};

const ETIQUETA = {
  adelanto: 'adelanto', pago: 'pago', trabajo: 'trabajo (devengado)',
  prestamo: 'préstamo', descuento: 'descuento', devolucion: 'devolución',
};

function _toDate(iso) {
  // 'YYYY-MM-DD' -> Date al mediodía UTC (evita líos de huso/DST en los bordes)
  if (iso instanceof Date) return new Date(Date.UTC(iso.getUTCFullYear(), iso.getUTCMonth(), iso.getUTCDate(), 12));
  return new Date(iso + 'T12:00:00Z');
}
function _iso(d) { return d.toISOString().slice(0, 10); }

// Semana laboral Lun–Vie que contiene `baseISO`, desplazada `offset` semanas.
function semanaLaboral(baseISO, offset = 0) {
  const d = baseISO ? _toDate(baseISO) : _toDate(new Date().toISOString().slice(0, 10));
  const dow = d.getUTCDay();                 // 0=Dom .. 6=Sáb
  const diffToMon = (dow === 0 ? -6 : 1 - dow);
  const mon = _toDate(_iso(d)); mon.setUTCDate(d.getUTCDate() + diffToMon + offset * 7);
  const fri = _toDate(_iso(mon)); fri.setUTCDate(mon.getUTCDate() + 4);
  return { desde: _iso(mon), hasta: _iso(fri), label: labelSemana(_iso(mon), _iso(fri)) };
}

// "8–12 jun" / "29 jun–3 jul"
function labelSemana(desdeISO, hastaISO) {
  const a = _toDate(desdeISO), b = _toDate(hastaISO);
  const dA = a.getUTCDate(), dB = b.getUTCDate();
  const mA = MESES_ABBR[a.getUTCMonth()], mB = MESES_ABBR[b.getUTCMonth()];
  return mA === mB ? `${dA}–${dB} ${mA}` : `${dA} ${mA}–${dB} ${mB}`;
}

function mesNombre(m, full = false) { return (full ? MESES_FULL : MESES_ABBR)[m] || ''; }

// Convierte la pista "actual|pasada|siguiente" en un offset de semanas.
function offsetSemana(hint) {
  const h = (hint || '').toLowerCase();
  if (/pasad|anterior/.test(h)) return -1;
  if (/siguient|proxim|que viene/.test(h)) return 1;
  return 0;
}

const eur = n => (Number(n) || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

// Suma de un array de movimientos en {dev, ent, dsc}.
function _sumar(movs) {
  let dev = 0, ent = 0, dsc = 0;
  for (const m of movs) {
    const im = Number(m.importe) || 0;
    if (m.tipo === 'semana_trabajada') dev += im;
    else if (m.tipo === 'pago_semana' || m.tipo === 'pago_dias' || m.tipo === 'adelanto') ent += im;
    else if (m.tipo === 'descuento') { dsc += im; ent += im; }
    else if (m.tipo === 'devolucion') ent -= im;
  }
  return { dev, ent, dsc };
}

// Informe agrupado por mes. `movs` = movimientos ya filtrados por periodo.
function formatInforme(movs, { nombre = '', tituloPeriodo = '' } = {}) {
  if (!movs || !movs.length) return `📄 *Informe de ${nombre}* — ${tituloPeriodo}\nNo hay movimientos en este periodo.`;
  const porMes = {};
  for (const m of movs) {
    const k = (m.fecha || '').slice(0, 7); // YYYY-MM
    (porMes[k] = porMes[k] || []).push(m);
  }
  const claves = Object.keys(porMes).sort();
  let out = `📄 *Informe de ${nombre}* — ${tituloPeriodo}\n`;
  let tDev = 0, tEnt = 0;
  for (const k of claves) {
    const [yy, mm] = k.split('-');
    const { dev, ent } = _sumar(porMes[k]);
    tDev += dev; tEnt += ent;
    out += `\n*${mesNombre(+mm - 1, true)} ${yy}* — trabajado ${eur(dev)} · entregado ${eur(ent)}`;
  }
  const saldo = tDev - tEnt;
  out += `\n\n*Totales del periodo:*\nDevengado: ${eur(tDev)}\nEntregado: ${eur(tEnt)}`;
  out += saldo >= 0
    ? `\nSaldo: le debemos *${eur(saldo)}*`
    : `\nSaldo: nos debe *${eur(-saldo)}* (ha cobrado de más)`;
  return out;
}

module.exports = {
  MESES_ABBR, MESES_FULL, TIPO_MAP, ETIQUETA,
  semanaLaboral, labelSemana, mesNombre, offsetSemana, formatInforme, eur,
};
