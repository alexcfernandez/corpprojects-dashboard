// src/precios.js — EVOLUCIÓN DE PRECIOS Y SUBIDAS (14/10/2026). Álex: «ver de un vistazo, con colores, dónde se compra y
// cómo evoluciona el precio (el caso Weber), y avisos en Inicio de las subidas del último año, últimos meses, semana».
//   · historial(): cada línea comprada (Compras + facturas de StelOrder) con su precio por unidad YA con descuento.
//   · buscar(q): puntos por tienda para la gráfica + resumen (último, mínimo, variación en 12 meses).
//   · subidas(): lo que más ha subido (vs hace un año, hace 3 meses, la compra anterior) y lo que está más barato en otra
//     tienda. Sale en Inicio.
//   · alComprar(compra): al entrar una compra, si algo está ≥8 % más caro que la última vez o ≥10 % más barato en otra
//     tienda (últimos 6 meses), WhatsApp a Álex.
'use strict';
async function getDB() { return require('./db').getDB(); }
const n = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const DIA = 864e5;
const SUBE = Number(process.env.PRECIO_SUBIDA_PCT || 8) / 100, BARATO = Number(process.env.PRECIO_BARATO_PCT || 10) / 100;
const RUIDO = /\b(contribucion|scrap|envalora|ecotasa|ecoraee|por unid|portes?|transporte|recargo|desplazamiento|descuento|redondeo|ticket desayuno|bolsa|kilometraje|kilometros|km|dietas?)\b/;
// Servicios y mano de obra no son «precios de material» (partidas, mantenimiento, expedientes, reconocimientos…).
const SERVICIO = /\b(partida|mantenimiento|reparacion|expediente|vigilancia|servicio|mano de obra|conceptos?|honorarios|cuota|alquiler|horas?|jornada|trabajos?|instalacion de|montaje|desmontaje|revision|certificado|tasa|licencia|plus cuba|cuba parcial)\b/;
// El combustible ya se sigue en Vehículos (precio por litro de cada gasolinera): aquí no.
const COMBUSTIBLE = /\b(diesel|gas.?oil|gasoleo|gasolina|sin plomo|adblue|efitec|carburante)\b/;
// Proveedores que no son tiendas ni subcontratas (comisiones, alquileres, ITV, seguros, gestoría, chatarra/residuos)
// y nosotros mismos (cuando la IA lee mal el proveedor): fuera de los precios.
const NO_TIENDA = /corp\.?\s*projects?|\bcinc\b|loxam|alquiler|lloguer|revisions? de vehicles|\bitv\b|quartix|gestio|assessors|spass|prevencio|asseguran|seguros|mutua|recuperaci|residus|residuos|contenidors|runa|deixalle|ajuntament|hisenda|tesoreria/;
const esMaterial = d => { if (COMBUSTIBLE.test(n(d))) return false; if (MO.test(n(d))) return false; return _esMat(d); };
// Mano de obra de TALLER (Álex: «me gustó verlo, es mucha diferencia»): se compara el precio de la hora entre talleres.
const MO = /\b(ma d.?obra|mano de obra|m\.?o\.?\b)/;
const TALLER = /taller|classicauto|norauto|midas|feu vert|recanvi|recambi|mecanic|carrosser|neumat|auto /;
const moTaller = (desc, prov) => MO.test(n(desc)) && TALLER.test(n(prov) + ' ' + n(desc));
// Mano de obra de SUBCONTRATAS (Rubén, 9electric…): €/hora del oficial o del ayudante. Una «unidad» entre 12 y 90 €
// o en horas; lo que va por servicio cerrado (315 €) no es comparable y se deja fuera.
const MO_SUB = /\b(servicio|mano de obra|ma d.?obra|mantenimiento y reparacion|reparacion y mantenimiento|hora|horas|oficial|ayudante)\b/;
const moSub = (desc, prov, unidad, precio) => !TALLER.test(n(prov) + ' ' + n(desc)) && MO_SUB.test(n(desc)) && !/desplazamiento|kilometr|dieta/.test(n(desc)) && (/^h(oras?)?$/i.test(String(unidad || '')) || (precio >= 12 && precio <= 90));
// Familias para ver de un vistazo: materiales, consumibles, herramientas y mano de obra.
const CONSUMIBLE = /\b(disco|broca|silicona|silecona|sellador|cinta|tornill|taco|tacos|cola|masilla|aguaplast|pasta|cutter|cuchilla|lija|guante|rodillo|brocha|paletin|espuma|abrazadera|brida|capazo|cubo|plastico|film|cartucho|grapa|clavo|spray|punta|hoja|regleta|estano|pegamento|limpiador|trapo|esponja|mascarilla|gafas|tapon|teflon)\b/;
const FAMILIAS = { material: 'Materiales', consumible: 'Consumibles', herramienta: 'Herramientas', mo_sub: 'Mano de obra · subcontratas', mo_taller: 'Mano de obra · taller' };
function familia(p) {
  if (p.mo === 'taller') return 'mo_taller';
  if (p.mo === 'sub') return 'mo_sub';
  try { if (require('./comprasVigilancia').categoria(p.articulo, p.precio)) return 'herramienta'; } catch (e) {}
  if (CONSUMIBLE.test(n(p.articulo))) return 'consumible';
  return 'material';
}
const _esMat = d => { const x = n(d).split(/\s+[-—]\s+/)[0]; return !RUIDO.test(x) && !SERVICIO.test(x); };

// Nombre de tienda estable («Saint-Gobain Weber Cemarksa, S.A.U» y «Weber» → «Weber»; Werkhaus → Bauhaus).
function tienda(p) {
  const x = n(p);
  const M = [[/rachid|ayada|9 ?electric|nou ?electric/, '9electric (Rachid)'], [/ruben esteban/, 'Rubén Esteban'], [/weber/, 'Weber'], [/bauhaus|werkhaus/, 'Bauhaus'], [/obramat|bricomart/, 'Obramat'], [/leroy/, 'Leroy Merlin'], [/saltoki/, 'Saltoki'], [/oliveras/, 'Oliveras'], [/palah/, 'Palahí'],
    [/bigmat|materials camps|forcemat/, 'BigMat'], [/sant narcis/, 'Pintures Sant Narcís'], [/bricoman|brico depot|bricodepot/, 'Brico Depôt'], [/grimal/, 'Ferretería Grimal'], [/ikea/, 'Ikea'], [/amazon/, 'Amazon']];
  for (const [re, nom] of M) if (re.test(x)) return nom;
  const w = x.replace(/[^a-z0-9 ]/g, ' ').replace(/\b(sl|slu|sa|sau|scs|scp|sc|servicio|de|del|la|el|i|y)\b/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return w.length ? w.map(t => t.charAt(0).toUpperCase() + t.slice(1)).join(' ') : '¿?';
}
// Clave del artículo: lo esencial del nombre (sin códigos, tasas ni medidas sueltas).
function clave(desc) {
  let x = n(desc).split(/\s+[-—]\s+|\(|\[/)[0];
  x = x.replace(/\b\d{5,}\b/g, ' ').replace(/[^a-z0-9 ]/g, ' ');
  const t = x.split(/\s+/).filter(w => w.length >= 3 && !/^(con|para|por|los|las|del|uds?|und|caja|pack)$/.test(w) && !/^\d+$/.test(w));
  return t.slice(0, 4).join(' ');
}

// «Es lo mismo» (Álex, 14/10: «el mortero M-7,5 y el sac morter sec gris silíceo es lo mismo»): varios nombres → un
// artículo. appSettings 'preciosEquivalencias' = [{ nombre, claves: [] }]. Las de serie, aquí.
const EQ_SERIE = [{ nombre: 'Mortero seco M-7,5 (saco 25 kg)', claves: ['mortero', 'sac morter sec gris', 'bensec morter', 'mortero gris 25kg', 'mortero seco', 'morter sec gris valsec', 'sac morter sec 25kg', 'mortero pro one 25kg'] }];
async function equivalencias() {
  let l = [];
  try { const d = await (await getDB()).collection('appSettings').findOne({ key: 'preciosEquivalencias' }); l = (d && d.lista) || []; } catch (e) {}
  return [...EQ_SERIE, ...l];
}
async function unir({ nombre, claves = [] } = {}, por = '') {
  if (!nombre || claves.length < 2) throw new Error('Di el nombre y al menos dos artículos');
  const db = await getDB(); const d = await db.collection('appSettings').findOne({ key: 'preciosEquivalencias' });
  const l = ((d && d.lista) || []).filter(x => x.nombre !== nombre); l.push({ nombre: String(nombre).slice(0, 80), claves: [...new Set(claves.map(String))], por, at: new Date() });
  await db.collection('appSettings').updateOne({ key: 'preciosEquivalencias' }, { $set: { lista: l } }, { upsert: true });
  return { ok: true, total: l.length };
}

async function historial({ dias = 760, _stel = null } = {}) {
  const db = await getDB();
  const EQ = await equivalencias().catch(() => EQ_SERIE);
  const eqDe = k => EQ.find(e => e.claves.includes(k) || e.claves.some(c => k.startsWith(c + ' ') && c.split(' ').length >= 2));
  const desde = new Date(Date.now() - dias * DIA).toISOString().slice(0, 10);
  const out = [], ya = new Set();
  const add = (p) => { if (p.clave && !p.mo) { const e = eqDe(p.clave); if (e) { p.clave = 'eq:' + e.nombre; p.nombreEq = e.nombre; } }
    if (!p.clave || p.precio == null || !(p.precio >= 0.05) || NO_TIENDA.test(n(p.tiendaRaw || p.tienda)) || (!p.mo && !esMaterial(p.articulo))) return; const k = `${p.tienda}|${p.fecha}|${p.clave}`; if (ya.has(k)) return; ya.add(k); p.familia = familia(p); out.push(p); };
  const cs = await db.collection('compras').find({ estado: { $in: ['revisada', 'por_revisar', 'archivo'] }, fecha: { $gte: desde }, tipo: { $in: ['factura', 'ticket', 'albaran'] } }).project({ proveedor: 1, fecha: 1, lineas: 1, numero: 1, obraRef: 1 }).toArray();
  for (const c of cs) for (const l of c.lineas || []) {
    const cant = Number(l.cantidad) || null;
    let pu = l.importe != null && cant ? Number(l.importe) / cant : l.precio != null ? Number(l.precio) * (1 - (Number(l.dto) || 0) / 100) : null;
    if (pu != null) pu = Math.round(pu * 100) / 100;
    const mt = moTaller(l.descripcion, c.proveedor), ms = !mt && moSub(l.descripcion, c.proveedor, l.unidad, pu), ay = ms && /ayudante|peon/.test(n(l.descripcion));
    const mo = mt ? 'taller' : ms ? 'sub' : null;
    add({ fecha: c.fecha, tienda: tienda(c.proveedor), tiendaRaw: c.proveedor, articulo: mt ? 'Mano de obra de taller (€/h)' : ms ? (ay ? 'Ayudante subcontratado (€/h)' : 'Oficial subcontratado (€/h)') : l.descripcion, clave: mt ? 'mano obra taller' : ms ? (ay ? 'mano obra ayudante' : 'mano obra oficial') : clave(l.descripcion), mo, precio: pu, cantidad: cant, unidad: l.unidad || null, ref: c.numero || '', compraId: String(c._id), obra: c.obraRef || null });
  }
  try {
    const invs = _stel ? await _stel() : await require('./stelorder').getPurchaseInvoices();
    for (const inv of invs || []) {
      const f = String(inv.date || '').slice(0, 10); if (!f || f < desde) continue;
      for (const l of inv.lines || []) {
        if (l.deleted || (l['line-type'] && l['line-type'] !== 'ITEM')) continue;
        const nom = String(l['item-name'] || l['item-description'] || '').trim();
        const u = Number(l.units ?? l.quantity) || null;
        let t = Number(l['total-amount']), p = Number(l['unit-price'] ?? l.price);
        let pu = Number.isFinite(t) && u ? t / u : Number.isFinite(p) ? p : null;
        if (pu != null) pu = Math.round(pu * 100) / 100;
        const mt = moTaller(nom, inv.supplier), ms = !mt && moSub(nom, inv.supplier, null, pu), ay = ms && /ayudante|peon/.test(n(nom));
        const mo = mt ? 'taller' : ms ? 'sub' : null;
        add({ fecha: f, tienda: tienda(inv.supplier), tiendaRaw: inv.supplier, articulo: mt ? 'Mano de obra de taller (€/h)' : ms ? (ay ? 'Ayudante subcontratado (€/h)' : 'Oficial subcontratado (€/h)') : nom, clave: mt ? 'mano obra taller' : ms ? (ay ? 'mano obra ayudante' : 'mano obra oficial') : clave(nom), mo, precio: pu, cantidad: u, unidad: null, ref: inv.number, compraId: null, obra: null });
      }
    }
  } catch (e) { /* StelOrder sin cupo: solo Compras */ }
  return out.sort((a, b) => a.fecha.localeCompare(b.fecha));
}

const cerca = (lista, fecha, minD, maxD) => { const t = new Date(fecha).getTime(); const c = lista.filter(p => { const d = (t - new Date(p.fecha).getTime()) / DIA; return d >= minD && d <= maxD; }); return c.length ? c[c.length - 1] : null; };
const pct = (a, b) => b ? Math.round((a - b) / b * 1000) / 10 : null;

// Para la gráfica: los artículos que encajan con la búsqueda (uno por clave) y los puntos de UNO (el elegido o el más
// comprado), por tienda. Así no se mezclan cosas distintas que comparten una palabra («obra»: discos, capazos, mano de obra).
async function buscar(q, { clave: cl = null, ...deps } = {}) {
  const pal = n(q).split(/\s+/).filter(w => w.length >= 3);
  if (!pal.length && !cl) return { articulos: [], series: [], resumen: null };
  const h0 = await historial(deps);
  // Lo que encaja con la búsqueda y, de esos artículos, TODAS sus compras (también las que se llaman distinto en otra
  // tienda pero están unidas: «mortero» trae el «sac morter sec gris» de Oliveras).
  const casa = cl ? null : new Set(h0.filter(p => pal.every(w => n(p.articulo).includes(w) || p.clave.includes(w) || n(p.nombreEq).includes(w))).map(p => p.clave));
  const enc = cl ? h0.filter(p => p.clave === cl) : h0.filter(p => casa.has(p.clave));
  const porC = {};
  for (const p of enc) (porC[p.clave] = porC[p.clave] || []).push(p);
  const articulos = Object.entries(porC).map(([k, ps]) => ({ clave: k, nombre: bonito(ps[ps.length - 1].articulo, ps[ps.length - 1].nombreEq), familia: FAMILIAS[ps[0].familia] || '', compras: ps.length, tiendas: [...new Set(ps.map(p => p.tienda))], ultimo: ps[ps.length - 1].precio, fecha: ps[ps.length - 1].fecha }))
    .sort((a, b) => b.compras - a.compras || b.fecha.localeCompare(a.fecha)).slice(0, 15);
  const elegida = cl || (articulos[0] && articulos[0].clave);
  const h = elegida ? (porC[elegida] || []) : [];
  const porT = {};
  for (const p of h) (porT[p.tienda] = porT[p.tienda] || []).push(p);
  const series = Object.entries(porT).map(([t, ps]) => ({ tienda: t, puntos: ps.map(p => ({ fecha: p.fecha, precio: p.precio, articulo: p.articulo, cantidad: p.cantidad, ref: p.ref, compraId: p.compraId, obra: p.obra })) })).sort((a, b) => b.puntos.length - a.puntos.length);
  let resumen = null;
  if (h.length) {
    const ult = h[h.length - 1], min = h.reduce((a, p) => p.precio < a.precio ? p : a, h[0]);
    const haceAno = cerca(h.filter(p => p.tienda === ult.tienda), ult.fecha, 270, 460);
    resumen = { nombre: bonito(ult.articulo, ult.nombreEq), ultimo: ult, minimo: min, haceAno, variacionAno: haceAno ? pct(ult.precio, haceAno.precio) : null, compras: h.length };
  }
  return { articulos, clave: elegida, series, resumen };
}

// Lo que más ha subido y lo que está más barato en otra tienda (artículos comprados al menos 2 veces).
async function subidas({ limite = 12, ...deps } = {}) {
  const h = await historial(deps);
  const porClave = {};
  for (const p of h) (porClave[p.clave] = porClave[p.clave] || []).push(p);
  const subs = [], baratos = [];
  const hoy = Date.now();
  for (const [k, ps] of Object.entries(porClave)) {
    if (ps.length < 2) continue;
    const ult = ps[ps.length - 1];
    if ((hoy - new Date(ult.fecha).getTime()) / DIA > 200) continue;   // ya no se compra
    const misma = ps.filter(p => p.tienda === ult.tienda);
    const ant = misma.length > 1 ? misma[misma.length - 2] : null;
    const ano = cerca(misma, ult.fecha, 270, 460), tres = cerca(misma, ult.fecha, 60, 130);
    const cmp = [['hace un año', ano], ['hace unos meses', tres], ['la compra anterior', ant]].filter(([, p]) => p && p !== ult);
    for (const [cuando, p] of cmp) {
      const v = pct(ult.precio, p.precio);
      // más del 80 % suele ser otra unidad (paquete / m², caja / ud), no una subida
      if (v != null && v >= SUBE * 100 && v <= 80) { subs.push({ articulo: ult.articulo, nombre: bonito(ult.articulo, ult.nombreEq), clave: k, tienda: ult.tienda, antes: p.precio, ahora: ult.precio, fechaAntes: p.fecha, fechaAhora: ult.fecha, pct: v, cuando, impacto: Math.round((ult.precio - p.precio) * (ult.cantidad || 1) * 100) / 100 }); break; }
    }
    // Más barato en otra tienda en los últimos 6 meses.
    const otras = ps.filter(p => p.tienda !== ult.tienda && (new Date(ult.fecha) - new Date(p.fecha)) / DIA <= 180);
    const mejor = otras.reduce((a, p) => !a || p.precio < a.precio ? p : a, null);
    if (mejor && mejor.precio < ult.precio * (1 - BARATO) && mejor.precio >= ult.precio * 0.5) baratos.push({ articulo: ult.articulo, nombre: bonito(ult.articulo, ult.nombreEq), clave: k, tienda: ult.tienda, precio: ult.precio, fecha: ult.fecha, otra: mejor.tienda, precioOtra: mejor.precio, fechaOtra: mejor.fecha, pct: pct(ult.precio, mejor.precio) });
  }
  subs.sort((a, b) => b.impacto - a.impacto || b.pct - a.pct);
  baratos.sort((a, b) => b.pct - a.pct);
  return { subidas: subs.slice(0, limite), masBaratoEnOtra: baratos.slice(0, limite), nSubidas: subs.length, nBaratos: baratos.length };
}

// ── RESUMEN POR FAMILIAS (último año): dónde sale más barato de media y el precio de cada artículo en cada tienda ──
// Índice de tienda: para los artículos comprados en 2+ tiendas, su precio / el más barato → media (100 % = siempre la más barata).
async function familias({ dias = 365, porFamilia = 12, ...deps } = {}) {
  const desde = new Date(Date.now() - dias * DIA).toISOString().slice(0, 10);
  const h = (await historial(deps)).filter(p => p.fecha >= desde);
  const out = {};
  for (const [fk, fnom] of Object.entries(FAMILIAS)) {
    const ps = h.filter(p => p.familia === fk);
    const porC = {};
    for (const p of ps) (porC[p.clave] = porC[p.clave] || []).push(p);
    const arts = Object.entries(porC).map(([k, l]) => {
      const ult = {}; for (const p of l) ult[p.tienda] = p;   // último precio en cada tienda
      const tiendas = Object.values(ult).map(p => ({ tienda: p.tienda, precio: p.precio, fecha: p.fecha })).sort((a, b) => a.precio - b.precio);
      const primero = l[0], ultimo = l[l.length - 1];
      return { clave: k, nombre: bonito(ultimo.articulo, ultimo.nombreEq), compras: l.length, tiendas, ultimo: { precio: ultimo.precio, tienda: ultimo.tienda, fecha: ultimo.fecha },
        variacion: (() => { if (primero.tienda !== ultimo.tienda || primero === ultimo) return null; const v = pct(ultimo.precio, primero.precio); return v != null && Math.abs(v) <= 80 ? v : null; })() };
    }).sort((a, b) => b.compras - a.compras);
    const idx = {};
    for (const a of arts.filter(a => a.tiendas.length > 1)) { const min = a.tiendas[0].precio; if (a.tiendas[a.tiendas.length - 1].precio > min * 2.5) continue; for (const t of a.tiendas) { (idx[t.tienda] = idx[t.tienda] || []).push(t.precio / min); } }
    const ranking = Object.entries(idx).filter(([, r]) => r.length >= (fk.startsWith('mo') ? 1 : 3)).map(([t, r]) => ({ tienda: t, indice: Math.round(r.reduce((x, y) => x + y, 0) / r.length * 100), articulos: r.length })).sort((a, b) => a.indice - b.indice);
    out[fk] = { nombre: fnom, articulos: arts.slice(0, porFamilia), total: arts.length, compras: ps.length, ranking: ranking.slice(0, 8) };
  }
  return out;
}

// ── PALETS Y ENVASES RETORNABLES (Álex, 14/10: «Weber nos cobra un montón de palets: ¿nos los abonan al devolverlos o se
// pierden?»). Por proveedor: palets cobrados (uds y €) frente a abonados (líneas en negativo / facturas de abono). La
// diferencia es dinero que se puede recuperar devolviéndolos (o que ya se ha perdido).
// Solo el PALET en sí (la línea empieza por «palet» o es el «coste palet retornable»), no el producto que viene en palet
// o en big bag («lana de roca… 1 palet», «arena… bigbag 1000 kg»).
const RETORNABLE = /^(?:\d+\s+)*(?:palet|palets|pallet|europalet)\b|coste palet|palet retornable|envase retornable|fianza envase/;
const sinCodigo = d => n(d).replace(/^[\s\d./-]+/, '').trim();
async function retornables({ desde = '2025-01-01', _stel = null } = {}) {
  const db = await getDB();
  const lineas = [];
  const cs = await db.collection('compras').find({ estado: { $ne: 'descartada' }, fecha: { $gte: desde } }).project({ proveedor: 1, fecha: 1, numero: 1, tipo: 1, lineas: 1 }).toArray();
  for (const c of cs) for (const l of c.lineas || []) if (RETORNABLE.test(sinCodigo(l.descripcion))) lineas.push({ fuente: 'compras', tienda: tienda(c.proveedor), fecha: c.fecha, ref: c.numero, articulo: l.descripcion, uds: (c.tipo === 'devolucion' ? -1 : 1) * Math.abs(Number(l.cantidad) || 1) * Math.sign(Number(l.importe) || 1) * (c.tipo === 'devolucion' && Number(l.importe) < 0 ? -1 : 1), importe: Number(l.importe) || 0 });
  try {
    for (const inv of (_stel ? await _stel() : await require('./stelorder').getPurchaseInvoices()) || []) {
      const f = String(inv.date || '').slice(0, 10); if (!f || f < desde) continue;
      for (const l of inv.lines || []) {
        if (l.deleted || (l['line-type'] && l['line-type'] !== 'ITEM')) continue;
        const nom = String(l['item-name'] || l['item-description'] || '');
        if (!RETORNABLE.test(sinCodigo(nom))) continue;
        const u = Number(l.units ?? l.quantity) || 0, t = Number(l['total-amount']);
        lineas.push({ fuente: 'stel', tienda: tienda(inv.supplier), fecha: f, ref: inv.number, articulo: nom, uds: u, importe: Number.isFinite(t) ? t : 0 });
      }
    }
  } catch (e) {}
  // Misma factura en Compras y en StelOrder: una vez (se queda StelOrder, que es la contabilidad).
  const out = [];
  for (const l of lineas.sort((a, b) => (a.fuente === 'stel' ? 0 : 1) - (b.fuente === 'stel' ? 0 : 1))) {
    // La misma línea en Compras y en StelOrder (a veces con 1-3 días de diferencia): una vez.
    if (l.fuente === 'compras' && out.some(o => o.fuente === 'stel' && o.tienda === l.tienda && Math.abs(o.importe - l.importe) < 0.02 && Math.abs(new Date(o.fecha) - new Date(l.fecha)) <= 3 * DIA)) continue;
    out.push(l);
  }
  const porT = {};
  for (const l of out) {
    const g = (porT[l.tienda] = porT[l.tienda] || { tienda: l.tienda, cobrados: 0, cobradoEur: 0, abonados: 0, abonadoEur: 0, lineas: [] });
    if (l.importe < 0 || l.uds < 0) { g.abonados += Math.abs(l.uds); g.abonadoEur += Math.abs(l.importe); } else { g.cobrados += Math.abs(l.uds); g.cobradoEur += l.importe; }
    g.lineas.push(l);
  }
  return Object.values(porT).map(g => ({ ...g, cobradoEur: Math.round(g.cobradoEur * 100) / 100, abonadoEur: Math.round(g.abonadoEur * 100) / 100,
    precioCobro: g.cobrados ? Math.round(g.cobradoEur / g.cobrados * 100) / 100 : null, precioAbono: g.abonados ? Math.round(g.abonadoEur / g.abonados * 100) / 100 : null, sinAbonar: Math.max(0, g.cobrados - g.abonados), sinAbonarEur: Math.round((g.cobradoEur - g.abonadoEur) * 100) / 100,
    lineas: g.lineas.sort((a, b) => b.fecha.localeCompare(a.fecha)) })).sort((a, b) => b.sinAbonarEur - a.sinAbonarEur);
}

// Al entrar una compra: ¿algo más caro que la última vez o más barato en otra tienda?
async function alComprar(compra, { _avisar = null, _hist = null } = {}) {
  if (!compra || !(compra.lineas || []).length || !compra.fecha) return { avisos: [] };
  const h = _hist ? await _hist() : await historial({ dias: 500 });
  const t = tienda(compra.proveedor), avisos = [];
  for (const l of compra.lineas) {
    const k = clave(l.descripcion); if (!k || !esMaterial(l.descripcion)) continue;
    const cant = Number(l.cantidad) || null;
    const pu = l.importe != null && cant ? Math.round(Number(l.importe) / cant * 100) / 100 : l.precio != null ? Math.round(Number(l.precio) * (1 - (Number(l.dto) || 0) / 100) * 100) / 100 : null;
    if (!(pu > 0)) continue;
    const prev = h.filter(p => p.clave === k && p.compraId !== String(compra._id) && p.fecha < compra.fecha);
    const mismaAnt = prev.filter(p => p.tienda === t).pop();
    if (mismaAnt && pu >= mismaAnt.precio * (1 + SUBE) && pu <= mismaAnt.precio * 1.8) avisos.push(`📈 *${l.descripcion}*: ${pu.toFixed(2)} € en ${t}; el ${String(mismaAnt.fecha).split('-').reverse().join('/')} costaba ${mismaAnt.precio.toFixed(2)} € (+${pct(pu, mismaAnt.precio)} %).`);
    const otra = prev.filter(p => p.tienda !== t && (new Date(compra.fecha) - new Date(p.fecha)) / DIA <= 180).reduce((a, p) => !a || p.precio < a.precio ? p : a, null);
    if (otra && otra.precio <= pu * (1 - BARATO) && otra.precio >= pu * 0.5) avisos.push(`💡 *${l.descripcion}*: ${pu.toFixed(2)} € en ${t}; en *${otra.tienda}* lo pagamos a ${otra.precio.toFixed(2)} € el ${String(otra.fecha).split('-').reverse().join('/')} (${pct(pu, otra.precio)} % más barato allí).`);
  }
  if (avisos.length) { try { await (_avisar || require('./notifications').sendWhatsApp)(`🏷️ *Precios* — compra de ${t}${compra.numero ? ' nº ' + compra.numero : ''}:\n${avisos.slice(0, 6).join('\n')}`); } catch (e) {} }
  return { avisos };
}

// Nombre para mostrar: sin códigos, sin paréntesis ni lo que va tras « - », y en minúsculas con mayúscula inicial.
function bonito(desc, eq) {
  if (eq) return eq;
  let x = String(desc || '').split(/\s+[-—]\s+/)[0].replace(/\([^)]*\)/g, ' ').replace(/\b\d{5,}\b/g, ' ').replace(/^\s*[\d/]+\s+/, '').replace(/\s{2,}/g, ' ').trim();
  if (x === x.toUpperCase()) x = x.toLowerCase();
  x = x.charAt(0).toUpperCase() + x.slice(1);
  return x.length > 46 ? x.slice(0, 44).trim() + '…' : x;
}
module.exports = { unir, equivalencias, retornables, familias, FAMILIAS, bonito, historial, buscar, subidas, alComprar, tienda, clave };
