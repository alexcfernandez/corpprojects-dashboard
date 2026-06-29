// src/banco.js — Importador de movimientos bancarios (Santander XLS/XLSX)
// ---------------------------------------------------------------------------
// La API de StelOrder NO expone movimientos del banco ni la conciliación; solo
// facturas de compra. Por eso la cara "salidas completas" (nóminas, impuestos,
// recibos, proveedores) entra por aquí: subes el Excel que descargas del banco
// y este módulo lo parsea, lo categoriza de forma determinista por el campo
// "Código" + palabras clave del concepto, y lo guarda en `bancoMovimientos`
// con una clave anti-duplicado (huella) para que puedas resubir rangos que se
// solapen sin generar duplicados.
//
// Diseño en dos capas, para poder probar el parseo sin tocar Mongo:
//   parseExcelBuffer(buf)  -> { cuenta, periodo, movimientos[] }   (puro)
//   ingestExcelBuffer(buf) -> upsert idempotente en `bancoMovimientos`
// ---------------------------------------------------------------------------
const XLSX = require('xlsx');
const { getDB } = require('./db');

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

// "29/06/2026" -> "2026-06-29" (ISO, ordenable). Devuelve '' si no encaja.
function fechaISO(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return '';
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// SheetJS suele devolver el importe ya como número. Si llega como texto
// ("-22,99" o "-22,99 EUR"), lo normalizamos a Number.
function toNum(v) {
  if (typeof v === 'number') return v;
  if (v == null) return 0;
  let s = String(v).replace(/eur/gi, '').replace(/\s/g, '').trim();
  if (!s) return 0;
  // formato español: miles con '.', decimal con ','  -> 1.234,56
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

// ── Trabajadores fijos (nóminas por transferencia) ──────────────────────────
// El concepto del banco trae "...A Favor De <Nombre>...". Detectamos por tokens
// (robusto a "Jose Antonio Beliard" / "Jose Beliard", "Javier Viñas" / "Javier").
const TRABAJADORES = [
  { nombre: 'Diego Campillo',  tokens: ['diego campillo', 'diego'] },
  { nombre: 'Jose Beliard',    tokens: ['jose antonio beliard', 'jose beliard', 'beliard'] },
  { nombre: 'Paula Morales',   tokens: ['paula morales', 'paula'] },
  { nombre: 'Abdellah Souiri', tokens: ['abdellah souiri', 'abdellah'] },
  { nombre: 'Mamadou Barry',   tokens: ['mamadou nourou barry', 'mamadou', 'nourou barry'] },
  { nombre: 'David Valencia',  tokens: ['david valencia', 'david'] },
  { nombre: 'Noel Aranda',     tokens: ['noel aranda', 'noel'] },
  { nombre: 'Javier Viñas',    tokens: ['javier vinas', 'javier viñas', 'viñas beriguete', 'vinas beriguete'] },
  { nombre: 'Alfonso Galvez',  tokens: ['alfonso galvez', 'alfonso'] },
];

function detectarTrabajador(nConcepto) {
  // exige "a favor de" para no confundir un cobro entrante con una nómina
  for (const t of TRABAJADORES) {
    for (const tok of t.tokens) {
      if (nConcepto.includes(tok)) return t.nombre;
    }
  }
  return null;
}

// ── Proveedores / suministros conocidos (refinan la categoría) ──────────────
const REGLAS_PROVEEDOR = [
  { cat: 'seguro',            re: /occident|vidacaixa|seguros|reaseguros|mapfre|allianz/ },
  { cat: 'telefonia',         re: /masmovil|xfera|yoigo|vodafone|movistar|orange/ },
  { cat: 'software_suscrip',  re: /apple\.com|canva|railway|framer|metapay|facebk|facebook|adobe|google\*|google ads|notion|openai|anthropic/ },
  { cat: 'publicidad_rrhh',   re: /adevinta|jobtoday|infojobs|indeed|linkedin/ },
  { cat: 'combustible',       re: /e\.\s?s\.\s|estacion servicio|estaci[oó] de servei|repsol|cepsa|galp|petronor|tabuenca|gasolin|carburant/ },
  { cat: 'gestoria',          re: /burocracia|gestoria|asesoria/ },
  { cat: 'material',          re: /werkhaus|saltoki|pintures|oliveras|x-palahi|palahi|nuevas tecnicas del revestimiento|saint-?gobain|weber|leroy merlin|gotarra|caber ferreteri|ferreteri|barcelona led|recupluja|recuperacions|marcel navarro|bonpreu|esclat|graner|mercat|classicauto|taller/ },
  { cat: 'parking',           re: /estacioname|parking|aparcamiento/ },
];

// ── Códigos de operación Santander -> tipo base ─────────────────────────────
// 136 tarjeta · 174 recibo domiciliado · 071 transf. recibida · 072 transf. emitida
// 002/100 liquidación tarjetas · 074 impuesto · 070 notif./comisión · 001/135/173/099 abonos
const CAT = {
  ingreso_comunidad: { label: '🏘️ Cobro comunidad',  flujo: 'entrada' },
  ingreso_otro:      { label: '⬇️ Otro ingreso',      flujo: 'entrada' },
  devolucion:        { label: '↩️ Devolución/abono',  flujo: 'entrada' },
  nomina:            { label: '👷 Nómina/pago trabajador', flujo: 'salida' },
  seguridad_social:  { label: '🏛️ Seguridad Social',  flujo: 'salida' },
  impuesto:          { label: '🧾 Impuesto',          flujo: 'salida' },
  seguro:            { label: '🛡️ Seguro',            flujo: 'salida' },
  telefonia:         { label: '📱 Telefonía',          flujo: 'salida' },
  software_suscrip:  { label: '💻 Software/suscripción', flujo: 'salida' },
  publicidad_rrhh:   { label: '📢 Publicidad/RRHH',    flujo: 'salida' },
  combustible:       { label: '⛽ Combustible',        flujo: 'salida' },
  gestoria:          { label: '📂 Gestoría',           flujo: 'salida' },
  material:          { label: '🧱 Material/proveedor', flujo: 'salida' },
  parking:           { label: '🅿️ Parking',            flujo: 'salida' },
  comision:          { label: '💳 Comisión/banco',     flujo: 'salida' },
  pago_proveedor:    { label: '🏭 Pago proveedor',     flujo: 'salida' },
  tarjeta_otro:      { label: '💳 Compra tarjeta',     flujo: 'salida' },
  otro_gasto:        { label: '➖ Otro gasto',          flujo: 'salida' },
};
// Categorías que por naturaleza se repiten cada mes/trimestre (semilla para la previsión)
const RECURRENTES = new Set(['nomina', 'seguridad_social', 'impuesto', 'seguro', 'telefonia', 'software_suscrip']);

function clasificar(concepto, codigo, importe) {
  const n = norm(concepto);
  const cod = String(codigo || '').padStart(3, '0');
  const entrada = importe > 0;

  // ── ENTRADAS ──
  if (entrada) {
    if (/cdad prop|comunitat|comunidad|ctat\.?\s*prop|com prop|macrocomunitat|propietaris|propietarios|habitat/.test(n))
      return mk('ingreso_comunidad', concepto);
    if (/devolucion|abono|modificacion de liquidacion/.test(n))
      return mk('devolucion', concepto);
    return mk('ingreso_otro', concepto);
  }

  // ── SALIDAS ──
  // impuestos / SS primero (a veces llegan como recibo 174 o domiciliación 074)
  if (cod === '074' || /a\.?e\.?a\.?t|aeat|abonare|impuesto|tributs|hacienda|\bmodelo \d/.test(n))
    return mk('impuesto', concepto);
  if (/tgss|seguridad social|cotizacion|autonomos|regimen general/.test(n))
    return mk('seguridad_social', concepto);

  // comisiones / liquidaciones de banco
  if (cod === '002' || cod === '100' || cod === '070' ||
      /traspaso:.*com\.|liquidacion de las tarjetas|notificaciones sir/.test(n))
    return mk('comision', concepto);

  // nómina: transferencia emitida a un trabajador conocido
  const trab = detectarTrabajador(n);
  if (trab && (cod === '072' || /a favor de|nomina|nómina|adelanto|a cuenta|paga|sueldo|bonificacion/.test(n)))
    return mk('nomina', concepto, trab);

  // proveedores / suministros por palabra clave (recibo 174 o compra 136 o transf 072)
  for (const r of REGLAS_PROVEEDOR) {
    if (r.re.test(n)) return mk(r.cat, concepto);
  }

  // fallback por código
  if (cod === '136') return mk('tarjeta_otro', concepto);
  if (cod === '174' || cod === '072') return mk('pago_proveedor', concepto);
  return mk('otro_gasto', concepto);
}

function mk(categoria, concepto, contraparte) {
  const def = CAT[categoria] || CAT.otro_gasto;
  return {
    categoria,
    label: def.label,
    flujo: def.flujo,
    recurrente: RECURRENTES.has(categoria),
    contraparte: contraparte || null,
  };
}

// ── PARSEO PURO ─────────────────────────────────────────────────────────────
// Acepta un Buffer del .xls/.xlsx (mismo esquema interno en ambos). Devuelve la
// cabecera (IBAN, titular, periodo) y la lista de movimientos normalizados.
function parseExcelBuffer(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });

  // cabecera: IBAN, titular, rango de fechas (filas 1-6 del export)
  const cuenta = { titular: null, iban: null };
  let periodo = { desde: null, hasta: null };
  let headerRow = -1;

  for (let i = 0; i < rows.length; i++) {
    const cells = (rows[i] || []).map(c => (c == null ? '' : String(c)));
    const joined = cells.join(' ');
    if (!cuenta.iban) {
      const ib = joined.match(/ES\d{2}[\d\s]{18,}/);
      if (ib) {
        const limpio = ib[0].replace(/\s+/g, '');     // ES + dígitos sin espacios
        if (/^ES\d{22}/.test(limpio)) cuenta.iban = limpio.slice(0, 24); // IBAN español = 24 chars
      }
    }
    if (!cuenta.titular) {
      const idx = cells.findIndex(c => /holding|s\.?l\.?$|s\.?a\.?$/i.test(c) && c.length > 6);
      if (idx >= 0 && /holding|corp projects/i.test(cells[idx])) cuenta.titular = cells[idx].trim();
    }
    const rango = joined.match(/desde\s+(\d{2}\/\d{2}\/\d{4}).*hasta\s+(\d{2}\/\d{2}\/\d{4})/i);
    if (rango) periodo = { desde: fechaISO(rango[1]), hasta: fechaISO(rango[2]) };
    // fila de encabezados de la tabla
    if (cells[0] && norm(cells[0]) === 'fecha operacion') { headerRow = i; break; }
  }

  const movimientos = [];
  if (headerRow >= 0) {
    for (let i = headerRow + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const fechaOp = String(r[0] == null ? '' : r[0]).trim();
      if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(fechaOp)) continue; // salta filas vacías/pie
      const concepto = String(r[2] == null ? '' : r[2]).trim();
      const importe  = toNum(r[3]);
      const saldo    = toNum(r[5]);
      const codigo   = String(r[7] == null ? '' : r[7]).trim().padStart(3, '0');
      const fechaOpISO = fechaISO(fechaOp);

      const c = clasificar(concepto, codigo, importe);
      const huella = `${cuenta.iban || 'NA'}|${fechaOpISO}|${importe.toFixed(2)}|${saldo.toFixed(2)}|${norm(concepto).slice(0, 40)}`;

      movimientos.push({
        huella,
        iban:          cuenta.iban || null,
        fechaOperacion: fechaOpISO,
        fechaValor:    fechaISO(String(r[1] == null ? '' : r[1]).trim()),
        mes:           fechaOpISO.slice(0, 7),       // YYYY-MM
        concepto,
        importe,
        saldo,
        codigo,
        numeroDocumento: r[8] != null ? String(r[8]).trim() : null,
        flujo:         c.flujo,
        categoria:     c.categoria,
        categoriaLabel: c.label,
        contraparte:   c.contraparte,
        recurrente:    c.recurrente,
      });
    }
  }

  return { cuenta, periodo, movimientos, total: movimientos.length };
}

// ── INGESTA (idempotente) ───────────────────────────────────────────────────
async function ingestExcelBuffer(buf, meta = {}) {
  const parsed = parseExcelBuffer(buf);
  if (!parsed.total) return { ok: false, error: 'No se encontraron movimientos en el archivo.', ...parsed };

  const db = await getDB();
  await db.collection('bancoMovimientos').createIndex({ huella: 1 }, { unique: true }).catch(() => {});
  await db.collection('bancoMovimientos').createIndex({ fechaOperacion: -1 }).catch(() => {});
  await db.collection('bancoMovimientos').createIndex({ mes: 1 }).catch(() => {});
  await db.collection('bancoMovimientos').createIndex({ categoria: 1 }).catch(() => {});

  let nuevos = 0, repetidos = 0;
  for (const m of parsed.movimientos) {
    try {
      const res = await db.collection('bancoMovimientos').updateOne(
        { huella: m.huella },
        {
          $setOnInsert: { ...m, importadoEl: new Date(), origen: meta.originalname || 'excel' },
          $set: { vistoEl: new Date() },
        },
        { upsert: true }
      );
      if (res.upsertedCount) nuevos++; else repetidos++;
    } catch (e) {
      if (e && e.code === 11000) repetidos++; else console.warn('[Banco] mov error:', e.message);
    }
  }

  // registro del import (para "último archivo subido")
  try {
    await db.collection('bancoImports').insertOne({
      fecha: new Date(), archivo: meta.originalname || null,
      iban: parsed.cuenta.iban, periodo: parsed.periodo,
      total: parsed.total, nuevos, repetidos,
    });
  } catch (e) {}

  console.log(`[Banco] Import: ${nuevos} nuevos, ${repetidos} ya existían (${parsed.periodo.desde}→${parsed.periodo.hasta})`);
  return { ok: true, cuenta: parsed.cuenta, periodo: parsed.periodo, total: parsed.total, nuevos, repetidos };
}

// ── LECTURA PARA EL DASHBOARD ───────────────────────────────────────────────
async function getMovimientos({ from, to, categoria, flujo, q, limit = 500 } = {}) {
  const db = await getDB();
  const query = {};
  if (from || to) { query.fechaOperacion = {}; if (from) query.fechaOperacion.$gte = from; if (to) query.fechaOperacion.$lte = to; }
  if (categoria) query.categoria = categoria;
  if (flujo)     query.flujo = flujo;
  if (q)         query.concepto = { $regex: q, $options: 'i' };
  return db.collection('bancoMovimientos').find(query).sort({ fechaOperacion: -1 }).limit(limit).toArray();
}

// Resumen mensual entradas/salidas + desglose por categoría (para Inicio / previsión)
async function getResumen({ from, to } = {}) {
  const db = await getDB();
  const match = {};
  if (from || to) { match.fechaOperacion = {}; if (from) match.fechaOperacion.$gte = from; if (to) match.fechaOperacion.$lte = to; }

  const movs = await db.collection('bancoMovimientos').find(match).toArray();
  const porMes = {}, porCategoria = {};
  let entradas = 0, salidas = 0;

  for (const m of movs) {
    if (!porMes[m.mes]) porMes[m.mes] = { mes: m.mes, entradas: 0, salidas: 0, neto: 0 };
    if (m.flujo === 'entrada') { porMes[m.mes].entradas += m.importe; entradas += m.importe; }
    else                       { porMes[m.mes].salidas  += m.importe; salidas  += m.importe; } // importe ya negativo
    porMes[m.mes].neto = porMes[m.mes].entradas + porMes[m.mes].salidas;

    if (!porCategoria[m.categoria]) porCategoria[m.categoria] = { categoria: m.categoria, label: m.categoriaLabel, flujo: m.flujo, total: 0, n: 0, recurrente: m.recurrente };
    porCategoria[m.categoria].total += m.importe;
    porCategoria[m.categoria].n++;
  }

  return {
    totales: { entradas, salidas, neto: entradas + salidas, n: movs.length },
    porMes: Object.values(porMes).sort((a, b) => a.mes.localeCompare(b.mes)),
    porCategoria: Object.values(porCategoria).sort((a, b) => Math.abs(b.total) - Math.abs(a.total)),
  };
}

// Gasto recurrente medio mensual por categoría (semilla de la previsión a fin de año)
async function getRecurrentesMensuales() {
  const db = await getDB();
  const movs = await db.collection('bancoMovimientos').find({ recurrente: true, flujo: 'salida' }).toArray();
  const acc = {};
  for (const m of movs) {
    const key = m.categoria + (m.contraparte ? `|${m.contraparte}` : '');
    if (!acc[key]) acc[key] = { categoria: m.categoria, label: m.categoriaLabel, contraparte: m.contraparte, meses: new Set(), total: 0 };
    acc[key].meses.add(m.mes);
    acc[key].total += m.importe;
  }
  return Object.values(acc).map(a => ({
    categoria: a.categoria, label: a.label, contraparte: a.contraparte,
    mediaMensual: a.meses.size ? +(a.total / a.meses.size).toFixed(2) : 0,
    mesesObservados: a.meses.size,
  })).sort((x, y) => x.mediaMensual - y.mediaMensual);
}

async function getUltimoImport() {
  const db = await getDB();
  return db.collection('bancoImports').find({}).sort({ fecha: -1 }).limit(1).next().catch(() => null);
}

module.exports = {
  // núcleo
  parseExcelBuffer, ingestExcelBuffer,
  // lectura dashboard
  getMovimientos, getResumen, getRecurrentesMensuales, getUltimoImport,
  // utilidades expuestas por si las quiere reusar el asistente
  clasificar, CAT, RECURRENTES, TRABAJADORES,
};
