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
const RUIDO = /\b(contribucion|scrap|envalora|ecotasa|ecoraee|por unid|portes?|transporte|recargo|desplazamiento|descuento|redondeo|ticket desayuno|bolsa)\b/;
// Servicios y mano de obra no son «precios de material» (partidas, mantenimiento, expedientes, reconocimientos…).
const SERVICIO = /\b(ma d.?obra|partida|mantenimiento|reparacion|expediente|vigilancia|servicio|mano de obra|conceptos?|honorarios|cuota|alquiler|horas?|jornada|trabajos?|instalacion de|montaje|desmontaje|revision|certificado|tasa|licencia|plus cuba|cuba parcial)\b/;
const esMaterial = d => { const x = n(d).split(/\s+[-—]\s+/)[0]; return !RUIDO.test(x) && !SERVICIO.test(x); };

// Nombre de tienda estable («Saint-Gobain Weber Cemarksa, S.A.U» y «Weber» → «Weber»; Werkhaus → Bauhaus).
function tienda(p) {
  const x = n(p);
  const M = [[/weber/, 'Weber'], [/bauhaus|werkhaus/, 'Bauhaus'], [/obramat|bricomart/, 'Obramat'], [/leroy/, 'Leroy Merlin'], [/saltoki/, 'Saltoki'], [/oliveras/, 'Oliveras'], [/palah/, 'Palahí'],
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

async function historial({ dias = 760, _stel = null } = {}) {
  const db = await getDB();
  const desde = new Date(Date.now() - dias * DIA).toISOString().slice(0, 10);
  const out = [], ya = new Set();
  const add = (p) => { if (!p.clave || p.precio == null || !(p.precio >= 0.05) || !esMaterial(p.articulo)) return; const k = `${p.tienda}|${p.fecha}|${p.clave}|${p.precio.toFixed(2)}`; if (ya.has(k)) return; ya.add(k); out.push(p); };
  const cs = await db.collection('compras').find({ estado: { $in: ['revisada', 'por_revisar', 'archivo'] }, fecha: { $gte: desde }, tipo: { $in: ['factura', 'ticket', 'albaran'] } }).project({ proveedor: 1, fecha: 1, lineas: 1, numero: 1, obraRef: 1 }).toArray();
  for (const c of cs) for (const l of c.lineas || []) {
    const cant = Number(l.cantidad) || null;
    let pu = l.importe != null && cant ? Number(l.importe) / cant : l.precio != null ? Number(l.precio) * (1 - (Number(l.dto) || 0) / 100) : null;
    if (pu != null) pu = Math.round(pu * 100) / 100;
    add({ fecha: c.fecha, tienda: tienda(c.proveedor), articulo: l.descripcion, clave: clave(l.descripcion), precio: pu, cantidad: cant, unidad: l.unidad || null, ref: c.numero || '', compraId: String(c._id), obra: c.obraRef || null });
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
        add({ fecha: f, tienda: tienda(inv.supplier), articulo: nom, clave: clave(nom), precio: pu, cantidad: u, unidad: null, ref: inv.number, compraId: null, obra: null });
      }
    }
  } catch (e) { /* StelOrder sin cupo: solo Compras */ }
  return out.sort((a, b) => a.fecha.localeCompare(b.fecha));
}

const cerca = (lista, fecha, minD, maxD) => { const t = new Date(fecha).getTime(); const c = lista.filter(p => { const d = (t - new Date(p.fecha).getTime()) / DIA; return d >= minD && d <= maxD; }); return c.length ? c[c.length - 1] : null; };
const pct = (a, b) => b ? Math.round((a - b) / b * 1000) / 10 : null;

// Para la gráfica: los puntos de lo que se busca, por tienda, y un resumen.
async function buscar(q, deps = {}) {
  const pal = n(q).split(/\s+/).filter(w => w.length >= 3);
  if (!pal.length) return { series: [], resumen: null, puntos: [] };
  const h = (await historial(deps)).filter(p => pal.every(w => n(p.articulo).includes(w) || p.clave.includes(w)));
  const porT = {};
  for (const p of h) (porT[p.tienda] = porT[p.tienda] || []).push(p);
  const series = Object.entries(porT).map(([t, ps]) => ({ tienda: t, puntos: ps.map(p => ({ fecha: p.fecha, precio: p.precio, articulo: p.articulo, cantidad: p.cantidad, ref: p.ref, compraId: p.compraId })) })).sort((a, b) => b.puntos.length - a.puntos.length);
  let resumen = null;
  if (h.length) {
    const ult = h[h.length - 1], min = h.reduce((a, p) => p.precio < a.precio ? p : a, h[0]);
    const haceAno = cerca(h.filter(p => p.tienda === ult.tienda), ult.fecha, 270, 460);
    resumen = { ultimo: ult, minimo: min, haceAno, variacionAno: haceAno ? pct(ult.precio, haceAno.precio) : null, compras: h.length };
  }
  return { series, resumen, puntos: h.slice(-200) };
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
      if (v != null && v >= SUBE * 100 && v <= 80) { subs.push({ articulo: ult.articulo, clave: k, tienda: ult.tienda, antes: p.precio, ahora: ult.precio, fechaAntes: p.fecha, fechaAhora: ult.fecha, pct: v, cuando, impacto: Math.round((ult.precio - p.precio) * (ult.cantidad || 1) * 100) / 100 }); break; }
    }
    // Más barato en otra tienda en los últimos 6 meses.
    const otras = ps.filter(p => p.tienda !== ult.tienda && (new Date(ult.fecha) - new Date(p.fecha)) / DIA <= 180);
    const mejor = otras.reduce((a, p) => !a || p.precio < a.precio ? p : a, null);
    if (mejor && mejor.precio < ult.precio * (1 - BARATO) && mejor.precio >= ult.precio * 0.5) baratos.push({ articulo: ult.articulo, clave: k, tienda: ult.tienda, precio: ult.precio, fecha: ult.fecha, otra: mejor.tienda, precioOtra: mejor.precio, fechaOtra: mejor.fecha, pct: pct(ult.precio, mejor.precio) });
  }
  subs.sort((a, b) => b.impacto - a.impacto || b.pct - a.pct);
  baratos.sort((a, b) => b.pct - a.pct);
  return { subidas: subs.slice(0, limite), masBaratoEnOtra: baratos.slice(0, limite), nSubidas: subs.length, nBaratos: baratos.length };
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

module.exports = { historial, buscar, subidas, alComprar, tienda, clave };
