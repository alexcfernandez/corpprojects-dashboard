// src/conciliacion.js — «Puntear» el banco: cada movimiento con su documento.
//
// Funciones PURAS (sin Mongo ni StelOrder) para poder probarlas con datos reales:
//   conciliar({ movimientos, emitidas, recibidas }) → { filas, resumen, recibidasSinPago, ... }
//
//   movimientos: [{ fecha:'YYYY-MM-DD', concepto, importe (− cargo / + abono), saldo, codigo }]
//   emitidas:    [{ id, numero:'FAC00871', fecha, cliente, total }]        (todas, no solo el trimestre)
//   recibidas:   [{ id, numero:'FPR00648', refProveedor, proveedor, fecha, total }]
//
// Cada fila sale con un TIPO (qué es) y un ESTADO:
//   punteado      → casado con su(s) factura(s)
//   no_requiere   → no lleva factura (nómina, Seguridad Social, impuestos, traspasos propios,
//                   liquidación de la tarjeta de crédito, comisiones del banco)
//   revisar       → hay que mirarlo (efectivo, préstamo, varias facturas posibles…)
//   sin_documento → pago o cobro sin factura encontrada

// norm y clavesTercero se llaman millones de veces con los mismos textos al cruzar todo el histórico:
// se recuerdan (caché acotada).
const _normC = new Map();
const norm = s => {
  const k = String(s || '');
  let v = _normC.get(k);
  if (v === undefined) { v = k.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); if (_normC.size > 50000) _normC.clear(); _normC.set(k, v); }
  return v;
};
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const dias = (a, b) => Math.round((new Date(a + 'T12:00:00Z') - new Date(b + 'T12:00:00Z')) / 86400000);
const igual = (a, b) => Math.abs(r2(a) - r2(b)) < 0.015;

// Nombres que el banco escribe distinto que la factura (comercial vs razón social).
const ALIAS = [
  [/werkhaus|bauhaus/, ['werkhaus', 'bauhaus']],
  [/bricoman|obramat/, ['obramat', 'bricoman']],
  [/bon ?preu|esclat/, ['bonpreu', 'bon preu', 'esclat']],
  [/weber|saint ?gobain/, ['weber', 'saint gobain', 'saint-gobain']],
  [/som assessors|burocracia/, ['burocracia', 'som assessors']],
  [/palahi/, ['palahi']],
  [/mas ?movil|xfera/, ['masmovil', 'xfera', 'mas movil']],
  [/leroy/, ['leroy']],
  [/media ?markt/, ['media markt', 'mediamarkt']],
  [/sant narcis/, ['sant narcis', 'pintures sant n']],
  [/vidacaixa/, ['vidacaixa']],
  [/spass|prevencion ajeno/, ['spass', 'prevencion']],
  [/digi spain/, ['digi']],
];
const STOP = new Set(['sl', 'slu', 's l', 'sa', 'sau', 'scs', 'sll', 'cb', 'girona', 'gerona', 'grup', 'grupo', 'the', 'del', 'de', 'la', 'el', 'els', 'les', 'i', 'y', 'servicios', 'servicio', 'materials', 'materiales']);
const _clavesC = new Map();
function clavesTercero(nombre) {
  const k = String(nombre || '');
  if (_clavesC.has(k)) return _clavesC.get(k);
  const v = _clavesTercero(k); if (_clavesC.size > 20000) _clavesC.clear(); _clavesC.set(k, v);
  return v;
}
function _clavesTercero(nombre) {
  const n = norm(nombre);
  const out = new Set();
  for (const [re, ks] of ALIAS) if (re.test(n)) ks.forEach(k => out.add(k));
  n.split(' ').filter(t => t.length >= 4 && !STOP.has(t)).forEach(t => out.add(t));
  return [...out];
}
const nombraA = (concepto, nombre) => { const c = norm(concepto); return clavesTercero(nombre).some(k => c.includes(k)); };

// Qué es el movimiento (antes de buscar factura).
function tipoMovimiento(m) {
  const n = norm(m.concepto), cargo = m.importe < 0, cod = String(m.codigo || '').padStart(3, '0');
  if (/liquidacion de las tarjetas de credito/.test(n)) return { tipo: 'liquidacion_tarjeta', estado: 'no_requiere', nota: 'Pago de la tarjeta de crédito: el detalle va en su extracto' };
  if (/traspaso.*c[o0]m\s*10|c[o0]m 10/.test(n)) return { tipo: 'traspaso_propio', estado: 'no_requiere', nota: 'Traspaso «Com. 10%» entre cuentas propias' };
  if (/a favor de corp projects holding|corp projects holding sl concepto pago compras tarjetas|de corp projects holding/.test(n)) return { tipo: 'traspaso_propio', estado: 'no_requiere', nota: 'Traspaso entre cuentas propias (p. ej. a Revolut)' };
  if (/tgss|seguridad social|cotizacion/.test(n)) return { tipo: 'seguridad_social', estado: 'no_requiere' };
  if (cod === '074' || /\baeat\b|agencia tributaria|hacienda|impuesto|tributs|aplazamiento/.test(n)) return { tipo: 'impuestos', estado: 'no_requiere' };
  if (/learnbrokers|prestamo/.test(n)) return { tipo: 'prestamo', estado: 'revisar', nota: 'Préstamo entre sociedades: necesita contrato' };
  if (/reintegro|caixer|cajero|\batm\b/.test(n)) return { tipo: 'efectivo', estado: 'revisar', nota: 'Sacado en efectivo: justificar en qué se gastó' };
  if (cargo && (m.categoria === 'nomina' || /nomina|sueldo|paga extra|finiquito|liquidacio|a cuenta nomina|a cuenta paga/.test(n))) return { tipo: 'nomina', estado: 'no_requiere', nota: m.contraparte ? `Pago a ${m.contraparte}` : undefined };
  if (cargo && (m.categoria === 'seguro' || /seguros|reaseguros|occident|vidacaixa|mapfre|allianz|protect solutions|mutua|arag\b|axa\b|zurich|generali|liberty/.test(n))) return { tipo: 'seguro', estado: 'no_requiere', nota: 'Recibo de seguro (sin IVA): el recibo es el justificante' };
  if (cargo && (cod === '002' || cod === '100' || cod === '070' || /comision|cuota renov|mantenimiento cuenta|notificaciones sir/.test(n)) && !/tarjeta \d{8,}.*comision 0 00/.test(n)) return { tipo: 'comision_banco', estado: 'no_requiere', nota: 'Comisión del banco: el justificante es el extracto' };
  if (!cargo && /devolucion|abono|retrocesion|refund/.test(n)) return { tipo: 'devolucion', estado: null };
  if (!cargo && /remesa sepa|emision remesa/.test(n)) return { tipo: 'cobro', estado: 'revisar', nota: 'Remesa SEPA: cobro de varios recibos a la vez; ver el detalle de la remesa' };
  if (!cargo) return { tipo: 'cobro', estado: null };
  if (cod === '136' || /tarj|tarjeta|pago movil|compra internet|contactless/.test(n)) return { tipo: 'pago_tarjeta', estado: null };
  if (cod === '174' || /^recibo/.test(n)) return { tipo: 'recibo', estado: null };
  return { tipo: 'pago_transferencia', estado: null };
}

// Números de factura nuestros citados en el concepto: "Fac.821", "Factura 00807", "FAC00871", "Ftra 00890", "Fact. 00774".
function facturasCitadas(concepto) {
  const out = new Set();
  const re = /\b(?:fac(?:tura|t|tra)?|ftra|fra|fras|fctra)\.?\s*(?:n[ºo°]\.?\s*)?0*(\d{3,5})\b/gi;
  let m; while ((m = re.exec(String(concepto || '')))) out.add(Number(m[1]));
  // "fac 821 y 822", "facturas 821-822"
  const lista = /\bfac\w*\.?\s*((?:0*\d{3,5}\s*(?:,|y|-|\/|i)\s*)+0*\d{3,5})/i.exec(String(concepto || ''));
  if (lista) (lista[1].match(/\d{3,5}/g) || []).forEach(x => out.add(Number(x)));
  return [...out];
}
const numFactura = ref => { const m = /(\d+)\s*$/.exec(String(ref || '').split('/')[0]); return m ? Number(m[1]) : null; };

// Combinaciones pequeñas que suman un importe (pagos de varias facturas a la vez).
function combinacion(cands, objetivo, max = 4) {
  const lista = cands.slice(0, 18);
  let mejor = null;
  (function rec(i, suma, sel) {
    if (mejor) return;
    if (sel.length && igual(suma, objetivo)) { mejor = sel.slice(); return; }
    if (sel.length >= max || i >= lista.length || suma > objetivo + 0.02) return;
    sel.push(lista[i]); rec(i + 1, suma + lista[i].total, sel); sel.pop();
    rec(i + 1, suma, sel);
  })(0, 0, []);
  return mejor;
}

// Fecha de factura que cita el concepto del banco («Fecha Factura: 17/08/2026», recibos de Saltoki).
function fechaCitada(concepto) {
  const m = String(concepto || '').match(/fecha factura:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}
// Tramo seguido de facturas (ordenadas por fecha) que sume el objetivo, con tolerancia de céntimos.
// Se prefiere el que empieza antes (las más viejas se pagan primero).
// Con 1-2 documentos se toleran 3 céntimos de redondeo; con más, 1 céntimo como mucho.
const tolDe = n => (n <= 2 ? 0.03 : 0.015);
function tramo(cands, objetivo) {
  for (let i = 0; i < cands.length; i++) {
    let suma = 0;
    for (let j = i; j < cands.length && j - i < 15; j++) {
      suma += cands[j].total;
      if (Math.abs(suma - objetivo) <= Math.max(tolDe(j - i + 1), 0.02)) return cands.slice(i, j + 1);   // tramo seguido: hasta 2 cént. aunque sean muchas
    }
  }
  return null;
}
// Cualquier combinación (abonos incluidos) que sume el objetivo: hasta 5 documentos de 14 candidatos como mucho
// (con más, alguna combinación cuadraría por casualidad).
// Con poda por lo que aún se puede sumar o restar, y un tope de pasos para no colgarse.
function combinacionAmplia(cands, objetivo, max = 5) {
  const tol = 0.03;
  const l = cands.slice(0, 14);
  const pos = new Array(l.length + 1).fill(0), neg = new Array(l.length + 1).fill(0);
  for (let i = l.length - 1; i >= 0; i--) { pos[i] = pos[i + 1] + Math.max(l[i].total, 0); neg[i] = neg[i + 1] + Math.min(l[i].total, 0); }
  let mejor = null, pasos = 0;
  (function rec(i, suma, sel) {
    if (mejor || ++pasos > 300000) return;
    if (sel.length && Math.abs(suma - objetivo) <= tolDe(sel.length)) { mejor = sel.slice(); return; }
    if (i >= l.length || sel.length >= max) return;
    if (suma + pos[i] < objetivo - tol || suma + neg[i] > objetivo + tol) return;
    sel.push(l[i]); rec(i + 1, suma + l[i].total, sel); sel.pop();
    rec(i + 1, suma, sel);
  })(0, 0, []);
  return mejor;
}

function conciliar({ movimientos = [], emitidas = [], recibidas = [] } = {}) {
  const usadasRec = new Set(), usadasEm = new Set();
  const emPorNum = new Map(); emitidas.forEach(e => { const n = numFactura(e.numero); if (n != null) emPorNum.set(n, e); });
  const filas = movimientos.map((m, i) => ({ i, ...m, importe: r2(m.importe), ...(m.fijo || tipoMovimiento(m)), docs: [], confianza: null }));
  // Lo resuelto a mano manda: factura subida desde el punteo, o «es personal / no lleva factura».
  for (const f of filas) {
    const a = f.manual; if (!a) continue;
    if (a.compraId) { usadasRec.add('c:' + a.compraId); f.estado = 'punteado'; f.confianza = 'manual'; f.docs = [{ ref: 'Compra subida', tercero: a.proveedor || '', total: a.total, compraId: a.compraId }]; f.nota = a.cuadra === false ? `Factura subida a mano (importe ${a.total} € distinto)` : 'Factura subida a mano'; 
      // La misma factura suele estar también en StelOrder (llegó por correo / n8n): esa queda pagada con este
      // pago, para que no salga en «sin pago encontrado». Mismo proveedor, mismo importe y fechas cercanas.
      const imp = a.total != null ? Math.abs(a.total) : Math.abs(f.importe);
      const gemela = recibidas.find(r => !String(r.id).startsWith('c:') && !usadasRec.has(r.id) && Math.abs(Math.abs(r.total) - imp) < 0.03 && Math.abs(dias(f.fecha, r.fecha)) <= 60 && nombraA(`${f.concepto} ${a.proveedor || ''}`, r.proveedor));
      if (gemela) { usadasRec.add(gemela.id); f.docs = [{ ref: gemela.numero, tercero: gemela.proveedor, total: gemela.total, fecha: gemela.fecha, refProveedor: gemela.refProveedor, compraId: a.compraId }]; }
    }
    else if (a.decision === 'vehiculo') { f.estado = 'punteado'; f.confianza = 'manual'; f.tipo = 'gasto_vehiculo'; f.docs = [{ ref: 'Gasto de vehículo', tercero: a.vehiculoNombre || '' }]; f.nota = `Gasto del vehículo ${a.vehiculoNombre || ''} (${a.categoria || 'otros'}, sin factura)`; }
    else if (a.decision === 'tercero') { f.estado = 'no_requiere'; f.tipo = 'por_cuenta_tercero'; f.nota = `Por cuenta de ${a.empresa || 'otra empresa'}${a.nota ? ': ' + a.nota : ''}`; }
    else if (a.decision === 'facturas' && Array.isArray(a.recibidas)) {
      const dif = r2(-f.importe - (a.total || 0));
      f.estado = 'punteado'; f.confianza = 'manual'; f.docs = a.recibidas.map(r => ({ ref: r.ref, tercero: r.tercero, total: r.total, fecha: r.fecha, refProveedor: r.refProveedor }));
      f.nota = `${a.recibidas.length} factura${a.recibidas.length > 1 ? 's' : ''} elegida${a.recibidas.length > 1 ? 's' : ''} a mano` + (Math.abs(dif) >= 0.02 ? ` (faltan ${dif.toFixed(2)} € de facturas)` : '');
      a.recibidas.forEach(r => usadasRec.add(r.id));
    }
    else if (a.decision === 'factura') { f.estado = 'punteado'; f.confianza = 'manual'; f.docs = [{ ref: a.facturaNumero, tercero: a.cliente || '', total: a.total }]; f.nota = 'Asignado a mano'; }
    else if (a.decision === 'facturar') { f.estado = 'revisar'; f.tipo = 'falta_emitir'; f.nota = `Falta emitir la factura${a.nota ? ': ' + a.nota : ''}`; }
    else if (a.decision === 'obra') { f.estado = 'punteado'; f.confianza = 'manual'; f.tipo = 'gasto_obra'; f.docs = [{ ref: 'Gasto de obra', tercero: a.obraRef || '' }]; f.nota = `Gasto de la obra «${a.obraRef || ''}» (sin factura${a.nota ? ': ' + a.nota : ''})`; }
    else if (a.decision === 'dieta') { f.estado = 'no_requiere'; f.tipo = 'dieta'; f.nota = `Comida de trabajo (dieta): ${(a.personas || []).join(', ')}${a.obraRef ? ' · ' + a.obraRef : ''}${a.nota ? ' — ' + a.nota : ''}`; }
    else if (a.decision) { f.estado = 'no_requiere'; f.tipo = a.decision === 'personal' ? 'personal' : f.tipo; f.nota = (a.decision === 'personal' ? `Gasto personal${f.persona ? ' de ' + f.persona : ''}` : 'No lleva factura') + (a.nota ? `: ${a.nota}` : '') + (a.por ? ` (marcado por ${a.por})` : ''); }
  }

  // 1) COBROS con número de factura en el concepto
  for (const f of filas.filter(x => x.tipo === 'cobro')) {
    const nums = facturasCitadas(f.concepto).filter(n => emPorNum.has(n));
    if (!nums.length) continue;
    const docs = nums.map(n => emPorNum.get(n));
    const suma = r2(docs.reduce((s, d) => s + (Number(d.total) || 0), 0));
    f.docs = docs.map(d => ({ ref: d.numero, tercero: d.cliente, total: d.total, fecha: d.fecha }));
    f.estado = 'punteado'; f.confianza = 'alta';
    if (!igual(suma, f.importe)) { f.nota = f.importe < suma ? `Cobro parcial (factura ${suma.toFixed(2)} €)` : `Cobra más que la factura (${suma.toFixed(2)} €)`; f.confianza = 'media'; }
    docs.forEach(d => usadasEm.add(d.id));
  }

  // 2) PAGOS: candidatos con el MISMO importe, fecha razonable y, mejor, el nombre del proveedor en el concepto
  const pendientes = filas.filter(x => !x.estado && x.importe < 0);
  const parejas = [];
  for (const f of pendientes) {
    const imp = -f.importe;
    for (const r of recibidas) {
      if (!igual(r.total, imp)) continue;
      const d = dias(f.fecha, r.fecha);                      // + = el pago es posterior a la factura
      const anticipo = /proforma|a compte|a cuenta|anticipo|bestreta|pagament a compte/.test(norm(f.concepto));
      const ventana = f.tipo === 'pago_tarjeta' ? (d >= -5 && d <= 20) : (d >= (anticipo ? -60 : -10) && d <= 120);
      if (!ventana) continue;
      // El recibo cita la fecha de su factura («Fecha Factura: 24/08/2026»): no vale otra de otro mes por el mismo importe.
      const fCit = fechaCitada(f.concepto);
      if (fCit && !(dias(fCit, r.fecha) >= 0 && dias(fCit, r.fecha) <= 10)) continue;
      const nombre = nombraA(f.concepto, r.proveedor);
      parejas.push({ f, r, score: (nombre ? 100 : 0) + 50 - Math.min(Math.abs(d), 50), nombre });
    }
  }
  const proveedores = [...new Set(recibidas.map(r => r.proveedor).filter(Boolean))];
  const _otro = new Map();
  const nombraOtro = (concepto, prov) => { const k = concepto + '|' + prov; if (!_otro.has(k)) _otro.set(k, proveedores.some(x => norm(x) !== norm(prov) && nombraA(concepto, x))); return _otro.get(k); };
  parejas.sort((a, b) => b.score - a.score);
  for (const p of parejas) {
    if (p.f.estado || usadasRec.has(p.r.id)) continue;
    // Sin el nombre en el concepto, solo si es el único candidato libre con ese importe… y nunca si la
    // concepto nombra a OTRO proveedor conocido (pago a Rubén Esteban casaba con Davemar por el importe).
    // Un nombre desconocido sí vale: «Recibo Gerard Codina» es el coworking Cossi.
    if (!p.nombre && /a favor de|transferencia|recibo /i.test(p.f.concepto) && nombraOtro(p.f.concepto, p.r.proveedor)) continue;   // (en compras con tarjeta el pueblo confunde)
    if (!p.nombre) {
      const otros = parejas.filter(q => q.f === p.f && q.r.id !== p.r.id && !usadasRec.has(q.r.id));
      if (otros.length) continue;
    }
    p.f.estado = 'punteado'; p.f.confianza = p.nombre ? 'alta' : 'media';
    p.f.docs = [{ ref: p.r.numero, tercero: p.r.proveedor, total: p.r.total, fecha: p.r.fecha, refProveedor: p.r.refProveedor }];
    usadasRec.add(p.r.id);
  }

  // 2b) El concepto cita el nº de factura del proveedor ("Factura N: 4/147820"): casar por ese número
  const digitos = x => String(x || '').replace(/\D/g, '');
  for (const f of filas.filter(x => !x.estado && x.importe < 0)) {
    const nums = (String(f.concepto).match(/\d[\d\/\-]{3,}\d/g) || []).map(digitos).filter(x => x.length >= 4);
    if (!nums.length) continue;
    const r = recibidas.find(x => !usadasRec.has(x.id) && digitos(x.refProveedor).length >= 4 && nums.some(nn => nn === digitos(x.refProveedor) || nn.endsWith(digitos(x.refProveedor)) || digitos(x.refProveedor).endsWith(nn)) && nombraA(f.concepto, x.proveedor));
    if (r) {
      f.estado = 'punteado'; f.confianza = igual(r.total, -f.importe) ? 'alta' : 'media';
      if (!igual(r.total, -f.importe)) f.nota = `El recibo cita la factura ${r.refProveedor} (${r.total} €)`;
      f.docs = [{ ref: r.numero, tercero: r.proveedor, total: r.total, fecha: r.fecha, refProveedor: r.refProveedor }];
      usadasRec.add(r.id);
    }
  }

  // 2c) FACTURA MENSUAL que agrupa varias compras con tarjeta (Bon Preu, Amazon…): la suma de los
  //     pagos a ese proveedor en el periodo de la factura coincide con su total.
  for (const r of recibidas.filter(x => !usadasRec.has(x.id) && x.total > 0)) {
    // Cada canal por separado: la factura de Esclat es la gasolina pagada con la app desde la cuenta,
    // no las compras de súper hechas con una tarjeta de Revolut.
    const canales = [...new Set(filas.filter(f => !f.estado && f.importe < 0 && nombraA(f.concepto, r.proveedor)).map(f => f.origen || ''))];
    let grupo = null;
    for (const canal of canales) {
    const deCanal = f => (f.origen || '') === canal;
    const pagos = filas.filter(f => !f.estado && f.importe < 0 && deCanal(f) && nombraA(f.concepto, r.proveedor) && dias(r.fecha, f.fecha) >= -3 && dias(r.fecha, f.fecha) <= 35);
    if (pagos.length < 2) continue;
    const tot = r2(-pagos.reduce((a, f) => a + f.importe, 0));
    grupo = igual(tot, r.total) ? pagos : null;
    if (!grupo) { // pagos del mismo mes natural que la factura, o del mes anterior si la factura es de principios de mes
      for (const mes of [r.fecha.slice(0, 7), new Date(Date.UTC(Number(r.fecha.slice(0, 4)), Number(r.fecha.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7)]) {
        const g = filas.filter(f => !f.estado && f.importe < 0 && deCanal(f) && f.fecha.slice(0, 7) === mes && nombraA(f.concepto, r.proveedor));
        if (g.length >= 2 && igual(-g.reduce((a, f) => a + f.importe, 0), r.total)) { grupo = g; break; }
      }
    }
    if (!grupo) { // facturas quincenales (Bon Preu: día 16 y fin de mes): los pagos desde la factura anterior hasta esta
      const ant = recibidas.filter(x => x.id !== r.id && x.total > 0 && norm(x.proveedor) === norm(r.proveedor) && x.fecha < r.fecha).map(x => x.fecha).sort().pop();
      const desde = ant || new Date(Date.UTC(Number(r.fecha.slice(0, 4)), Number(r.fecha.slice(5, 7)) - 1, Number(r.fecha.slice(8, 10)) - 31)).toISOString().slice(0, 10);
      for (const incluyeDia of [false, true]) {
        const g = filas.filter(f => !f.estado && f.importe < 0 && deCanal(f) && nombraA(f.concepto, r.proveedor) && f.fecha > desde && (incluyeDia ? f.fecha <= r.fecha : f.fecha < r.fecha));
        if (g.length >= 2 && igual(-g.reduce((a, f) => a + f.importe, 0), r.total)) { grupo = g; break; }
      }
    }
    if (grupo) break;
    }
    if (!grupo) continue;
    for (const f of grupo) { f.estado = 'punteado'; f.confianza = 'media'; f.nota = `Incluida en la factura mensual ${r.refProveedor || r.numero}`; f.docs = [{ ref: r.numero, tercero: r.proveedor, total: r.total, fecha: r.fecha, refProveedor: r.refProveedor }]; }
    usadasRec.add(r.id);
  }

  // 2d) Proveedor con FACTURA MENSUAL que no cuadra exacto con los pagos con tarjeta del mes (p. ej.
  //     Bon Preu: parte de las compras pueden ser personales): se agrupan y se señala la diferencia.
  const porProvMes = new Map();
  for (const f of filas.filter(x => !x.estado && x.tipo === 'pago_tarjeta')) {
    const r = recibidas.find(x => x.total > 0 && nombraA(f.concepto, x.proveedor));
    if (!r) continue;
    const k = `${norm(r.proveedor)}|${f.fecha.slice(0, 7)}|${f.origen || ''}`;
    (porProvMes.get(k) || porProvMes.set(k, { proveedor: r.proveedor, mes: f.fecha.slice(0, 7), pagos: [] }).get(k)).pagos.push(f);
  }
  for (const g of porProvMes.values()) {
    if (g.pagos.length < 3) continue;
    const fin = new Date(Date.UTC(Number(g.mes.slice(0, 4)), Number(g.mes.slice(5, 7)), 5)).toISOString().slice(0, 10);
    const facts = recibidas.filter(x => !usadasRec.has(x.id) && x.total > 0 && norm(x.proveedor) === norm(g.proveedor) && x.fecha >= g.mes + '-01' && x.fecha <= fin);
    if (!facts.length) continue;
    // Solo quien factura por mes (1-2 facturas): Obramat o Leroy hacen una factura por compra y sus pagos
    // sueltos no se juntan en un bloque.
    const delMes = recibidas.filter(x => x.total > 0 && norm(x.proveedor) === norm(g.proveedor) && x.fecha >= g.mes + '-01' && x.fecha <= fin).length;
    if (facts.length > 2 || delMes > 2) continue;   // contando también las ya casadas
    const pagado = r2(-g.pagos.reduce((a, f) => a + f.importe, 0)), facturado = r2(facts.reduce((a, x) => a + x.total, 0));
    const dif = r2(pagado - facturado);
    for (const f of g.pagos) {
      f.estado = Math.abs(dif) < 1 ? 'punteado' : 'revisar'; f.confianza = 'baja';
      f.nota = `${g.proveedor} factura por mes: pagado ${pagado.toFixed(2)} € con tarjeta, facturado ${facturado.toFixed(2)} €${Math.abs(dif) >= 1 ? ` (diferencia ${dif.toFixed(2)} €: ¿compras personales o falta factura?)` : ''}`;
      f.docs = facts.map(x => ({ ref: x.numero, tercero: x.proveedor, total: x.total, fecha: x.fecha, refProveedor: x.refProveedor }));
    }
    facts.forEach(x => usadasRec.add(x.id));
  }

  // 3) RECIBOS y transferencias que pagan VARIAS facturas del mismo proveedor (remesas: Oliveras cobra el 25
  //    lo del mes anterior, Saltoki junta albarán + abono…). Cuentan los abonos (facturas en negativo).
  //    Del recibo más antiguo al más nuevo, para que cada uno se lleve las facturas más viejas; primero un
  //    tramo seguido de facturas (lo normal en una remesa) y, si no, cualquier combinación. Tolera céntimos.
  //    Si no cuadra, se deja la cuenta hecha: qué facturas hay pendientes de ese proveedor y cuánto falta.
  const grupales = filas.filter(x => !x.estado && x.importe < 0 && x.tipo !== 'pago_tarjeta').sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
  for (const f of grupales) {
    // Si el recibo cita la fecha de la factura («Fecha Factura: 17/08/2026», Saltoki), solo las de esa semana.
    const fCit = fechaCitada(f.concepto);
    // Las que StelOrder ya da por pagadas (pendiente 0) no entran: se pagaron en otro trimestre.
    const todas = recibidas.filter(r => !usadasRec.has(r.id) && Math.abs(r.total) > 0.005 && !(r.pendienteStel != null && Math.abs(r.pendienteStel) < 0.01) && nombraA(f.concepto, r.proveedor) && dias(f.fecha, r.fecha) >= -7 && dias(f.fecha, r.fecha) <= 150
      && (!fCit || (dias(fCit, r.fecha) >= 0 && dias(fCit, r.fecha) <= 10)));
    // Cada proveedor por separado («Sant Narcis» puede nombrar a más de uno): el de más facturas candidatas primero.
    const porProv = {}; todas.forEach(r => { (porProv[r.proveedor] = porProv[r.proveedor] || []).push(r); });
    const grupos = Object.values(porProv).sort((a, b) => b.length - a.length).map(g => g.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha))));
    const cands = grupos[0] || [];
    if (!cands.length) continue;
    const objetivo = -f.importe;
    let combo = null;
    for (const g of grupos) {
      // Combinación libre solo entre las 14 más cercanas al recibo (las de los últimos ~2,5 meses).
      const cerca = g.length <= 14 ? g : g.filter(r => dias(f.fecha, r.fecha) <= 75).slice(-14);
      combo = tramo(g, objetivo) || combinacionAmplia(cerca, objetivo);
      if (combo) break;
    }
    if (combo && !(combo.length === 1 && igual(combo[0].total, objetivo))) {
      const suma = r2(combo.reduce((a, r) => a + r.total, 0));
      const dif = r2(objetivo - suma);
      f.estado = 'punteado'; f.confianza = 'media';
      f.nota = (combo.length > 1 ? `Paga ${combo.filter(r => r.total > 0).length} factura${combo.filter(r => r.total > 0).length > 1 ? 's' : ''}${combo.some(r => r.total < 0) ? ' menos ' + combo.filter(r => r.total < 0).length + ' abono' + (combo.filter(r => r.total < 0).length > 1 ? 's' : '') : ''} juntas` : 'Factura') + (Math.abs(dif) >= 0.005 ? ` (diferencia de ${Math.round(Math.abs(dif) * 100)} cént.)` : '');
      f.docs = combo.map(r => ({ ref: r.numero, tercero: r.proveedor, total: r.total, fecha: r.fecha, refProveedor: r.refProveedor }));
      combo.forEach(r => usadasRec.add(r.id));
      continue;
    }
    // Sin cuadre: la cuenta con ese proveedor, para elegir a mano o ver cuánto falta por llegar.
    const antes = cands.filter(r => dias(f.fecha, r.fecha) >= 0);
    const pendiente = r2(antes.reduce((a, r) => a + r.total, 0));
    f.candidatas = cands.slice(-30).map(r => ({ id: r.id, ref: r.numero, refProveedor: r.refProveedor, tercero: r.proveedor, total: r.total, fecha: r.fecha }));
    f.nota = pendiente < objetivo - 0.02
      ? `De ${cands[0].proveedor} hay ${antes.length} factura${antes.length === 1 ? '' : 's'} sin pagar por ${pendiente.toFixed(2)} €: faltan facturas por ${(objetivo - pendiente).toFixed(2)} €`
      : `De ${cands[0].proveedor} hay ${antes.length} facturas sin pagar por ${pendiente.toFixed(2)} €, pero ninguna combinación da ${objetivo.toFixed(2)} €`;
  }

  // 4) COBROS sin número: misma cantidad que una factura emitida libre, y a poder ser el cliente en el concepto
  for (const f of filas.filter(x => x.tipo === 'cobro' && !x.estado)) {
    const cands = emitidas.filter(e => !usadasEm.has(e.id) && igual(e.total, f.importe) && dias(f.fecha, e.fecha) >= -5 && dias(f.fecha, e.fecha) <= 365);
    const conNombre = cands.filter(e => nombraA(f.concepto, e.cliente));
    const elegida = conNombre.length === 1 ? conNombre[0] : (cands.length === 1 ? cands[0] : null);
    if (elegida) {
      f.estado = 'punteado'; f.confianza = conNombre.length === 1 ? 'alta' : 'media';
      f.docs = [{ ref: elegida.numero, tercero: elegida.cliente, total: elegida.total, fecha: elegida.fecha }];
      usadasEm.add(elegida.id);
    } else if (cands.length > 1) { f.estado = 'revisar'; f.nota = `Puede ser ${cands.slice(0, 3).map(e => e.numero).join(', ')}`; }
    else {
      // Varias facturas del mismo cliente pagadas de una vez
      const delCliente = emitidas.filter(e => !usadasEm.has(e.id) && e.total > 0 && nombraA(f.concepto, e.cliente) && dias(f.fecha, e.fecha) >= -5 && dias(f.fecha, e.fecha) <= 365).sort((x, y) => y.fecha.localeCompare(x.fecha));
      const combo = delCliente.length >= 2 ? combinacion(delCliente, f.importe, 5) : null;
      if (combo && combo.length > 1) {
        f.estado = 'punteado'; f.confianza = 'media'; f.nota = `Cobra ${combo.length} facturas juntas`;
        f.docs = combo.map(e => ({ ref: e.numero, tercero: e.cliente, total: e.total, fecha: e.fecha }));
        combo.forEach(e => usadasEm.add(e.id));
      }
    }
  }

  // 5) DEVOLUCIONES de proveedor: casan con una rectificativa (total negativo) del mismo importe
  for (const f of filas.filter(x => x.tipo === 'devolucion' && !x.estado)) {
    const r = recibidas.find(x => !usadasRec.has(x.id) && x.total < 0 && igual(-x.total, f.importe) && Math.abs(dias(f.fecha, x.fecha)) <= 30);
    if (r) { f.estado = 'punteado'; f.confianza = 'media'; f.docs = [{ ref: r.numero, tercero: r.proveedor, total: r.total, fecha: r.fecha }]; usadasRec.add(r.id); }
    else { f.estado = 'no_requiere'; f.nota = 'Devolución de una compra (sin rectificativa encontrada)'; }
  }

  // 6) Lo que queda sin casar
  const MENOR = /estacioname|parking|aparcament|aparcamiento|peaje|autopista|bizum/;
  const ONLINE = /facebk|facebook|meta ?pay|framer|apple com|app store|google|adevinta|infojobs|jobtoday|canva|railway|openai|anthropic|notion|adobe|stelorder|yoigo|telefonica|movistar|vodafone|masmovil|digi|amazon/;
  const COMIDA = /restaurant|meson|bar |cafe|cafeteria|pizzeria|picana|braseria|tasca|burger|mcdonald|kebab|forn |panaderia|pasteleria/;
  const GASOLINA = /esclatoil|repsol|cepsa|galp|petroprix|petrem|bp |shell|e s |estacio de servei|gasolinera/;
  for (const f of filas) if (!f.estado) {
    f.estado = 'sin_documento';
    const n = norm(f.concepto);
    if (/airways|aviation|air solutions|aero|jet |flight|aviacion|justfly/.test(n)) f.nota = '¿Es por cuenta de JustFly? (aviación) Márcalo «Otra empresa»';
    else if (f.tipo === 'cobro') f.nota = 'Cobro sin factura identificada';
    else if (ONLINE.test(n)) f.nota = 'Servicio online: descargar la factura de su web';
    else if (GASOLINA.test(n)) f.nota = 'Gasolina: pedir factura (ticket con CIF) en la gasolinera';
    else if (COMIDA.test(n)) f.nota = 'Comida/dieta: guardar ticket si es de trabajo';
    else if (MENOR.test(n)) f.nota = 'Gasto menor (parking): normalmente sin factura';
    else if (/proforma|a compte|a cuenta|anticipo/.test(n)) f.nota = 'Pago anticipado (proforma / a cuenta): falta la factura definitiva';
  }

  const cuenta = k => filas.filter(f => f.estado === k).length;
  const requieren = filas.filter(f => f.estado !== 'no_requiere').length;
  const resumen = {
    movimientos: filas.length, punteados: cuenta('punteado'), noRequiere: cuenta('no_requiere'), revisar: cuenta('revisar'), sinDocumento: cuenta('sin_documento'),
    porcentaje: requieren ? Math.round(cuenta('punteado') / requieren * 100) : 100,
    // Por IMPORTE: de los euros que necesitan documento, cuántos están casados con factura.
    porcentajeImporte: (() => { const req = filas.filter(f => f.estado !== 'no_requiere'); const t = req.reduce((a, f) => a + Math.abs(f.importe), 0); const ok = req.filter(f => f.estado === 'punteado').reduce((a, f) => a + Math.abs(f.importe), 0); return t ? Math.round(ok / t * 100) : 100; })(),
    cargos: r2(filas.filter(f => f.importe < 0).reduce((s, f) => s + f.importe, 0)), abonos: r2(filas.filter(f => f.importe > 0).reduce((s, f) => s + f.importe, 0)),
  };
  return { filas, resumen, recibidasUsadas: usadasRec, emitidasUsadas: usadasEm };
}

// Avisos sobre las facturas recibidas (para la gestoría y para corregir en StelOrder):
//   · duplicadas: mismo proveedor + mismo nº de proveedor + mismo total
//   · IVA 0 % sospechoso: proveedor que normalmente cobra IVA y esta factura va sin IVA
function avisosRecibidas(recibidas = []) {
  // Mismo proveedor y mismo nº de factura del proveedor, con total igual o casi (±1 %: a veces se teclea distinto).
  const dup = [], vistos = new Map();
  for (const r of recibidas) {
    if (!r.refProveedor || Number(r.total) <= 0) continue;
    const k = `${norm(r.proveedor)}|${norm(r.refProveedor)}`;
    const prev = (vistos.get(k) || []).find(o => Math.abs(Number(o.total) - Number(r.total)) <= Math.max(0.02, Math.abs(Number(o.total)) * 0.01));
    if (prev) dup.push({ original: prev, duplicada: r }); else vistos.set(k, [...(vistos.get(k) || []), r]);
  }
  const conIva = {}; recibidas.forEach(r => { const k = norm(r.proveedor); if ((Number(r.iva) || 0) > 0) conIva[k] = (conIva[k] || 0) + 1; });
  const exentos = /\bboe\b|registro|tasa|spass|prevencion|seguro|vidacaixa|admiral|notari|ajuntament|ayuntamiento|aeat|gestores/;
  const iva0 = recibidas.filter(r => r.iva != null && Number(r.iva) === 0 && Number(r.total) > 0 && conIva[norm(r.proveedor)] && !exentos.test(norm(r.proveedor)));
  return { duplicadas: dup, iva0 };
}

module.exports = { conciliar, avisosRecibidas, tipoMovimiento, facturasCitadas, clavesTercero, norm };
