// src/facturasProveedorCheck.js — Facturas de proveedor mal pasadas a StelOrder (20/10/2026). Caso que lo origina: la
// FPR00968 de Bauhaus (23/09) entró por 920,23 € en vez de 460,11 € porque la línea «DESCONTAR PAGA Y SEÑAL» se pasó en
// POSITIVO, y no se vio hasta después de presentar el 3T. Álex: «habrá que hacerlo de forma que sea más útil las
// siguientes veces».
//
// Cada mañana (L-V) se miran las facturas de proveedor de los últimos 45 días (la lista de StelOrder ya trae las líneas,
// no gasta peticiones de más) y se avisa a Álex y a la oficina, una sola vez por factura, de:
//   · una línea de descuento / señal / anticipo / a cuenta / abono que SUMA en vez de restar;
//   · que el total no cuadra con la misma factura subida al dashboard (foto o correo), o que es justo el doble.
// Lo que salga queda en `fprAvisos` y también aparece en /trimestre («Lo que nos pidió la gestoría») mientras no se
// arregle, para verlo ANTES de cerrar el trimestre.
'use strict';
async function getDB() { return require('./db').getDB(); }
const COL = 'fprAvisos';
// Líneas que deberían RESTAR. Ojo: la factura de «paga y señal» (anticipo) de Bauhaus va en positivo y está bien; lo que
// resta es «DESCONTAR paga y señal». El «palet retornable» se cobra de verdad.
const RESTA = /descont|descuento|\bdto\b|abono|devoluci|devoluc|reintegr/i;
// Alias de proveedor (el nombre cambia entre la foto y StelOrder).
const ALIAS = [[/werkhaus|bauhaus/, 'bauhaus'], [/bricoman|obramat/, 'obramat'], [/palah/, 'palahi'], [/oliveras/, 'oliveras'], [/saltoki/, 'saltoki'], [/leroy/, 'leroy']];
const provKey = s => { const t = String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); const a = ALIAS.find(([re]) => re.test(t)); return a ? a[1] : (t.replace(/^x-/, '').match(/[a-z0-9]{3,}/) || [''])[0]; };
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const nn = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^0+/, '');
const eur = n => Number(n).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

// Problemas de UNA factura de proveedor (con sus líneas) frente a las compras del dashboard.
function problemas(f, compras = []) {
  const out = [];
  // En un abono (total negativo) el signo va al revés: no se mira.
  for (const l of Number(f.total) < 0 ? [] : (f.lines || [])) {
    if (l.deleted || l['line-type'] === 'SECTION') continue;
    // El nombre de la línea (la descripción trae coletillas como «NO SE ADMITEN DEVOLUCIONES»).
    const txt = String(l['item-name'] || l['item-description'] || '').replace(/no se admiten devoluciones|sin devoluci[oó]n/ig, '');
    const imp = Number(l['total-amount'] != null ? l['total-amount'] : (Number(l.units) || 0) * (Number(l['item-base-price']) || 0));
    if (RESTA.test(txt) && imp > 1) out.push({ tipo: 'signo', que: `La línea «${txt.trim().slice(0, 60)}» suma ${eur(imp)}: un descuento, señal o anticipo debería RESTAR` });
  }
  const refs = [f.extraReference, f.title].map(nn).filter(x => x.length >= 4);
  const pk = provKey(f.supplier);
  const c = compras.find(x => x.numero && nn(x.numero).length >= 4 && provKey(x.proveedor) === pk && refs.some(r => r === nn(x.numero) || (r.length >= 6 && (r.includes(nn(x.numero)) || nn(x.numero).includes(r)))));
  if (c && Number(c.total) > 0 && Number(f.total) > 0) {
    const d = Number(f.total) - Number(c.total);
    if (Math.abs(d) > Math.max(2, Number(c.total) * 0.03)) {
      const doble = Math.abs(Number(f.total) - 2 * Number(c.total)) <= Math.max(2, Number(c.total) * 0.03);
      out.push({ tipo: 'descuadre', que: `En StelOrder ${eur(f.total)} y en la factura subida (${c.proveedor} ${c.numero}) ${eur(c.total)}${doble ? ': es justo el DOBLE' : ''}` });
    }
  }
  return out;
}

async function revisar({ dias = 45, avisar = true, _stel = null, _db = null, _enviar = null } = {}) {
  const stel = _stel || require('./stelorder');
  const db = _db || await getDB();
  const desde = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
  const lista = (await stel.getPurchaseInvoices()).filter(f => String(f.date).slice(0, 10) >= desde);
  if (!lista.length) return { revisadas: 0, nuevas: [] };
  const compras = await db.collection('compras').find({ tipo: { $in: ['factura', 'ticket'] }, fecha: { $gte: new Date(Date.now() - (dias + 30) * 86400000).toISOString().slice(0, 10) }, duplicadoDe: null })
    .project({ proveedor: 1, numero: 1, total: 1, fecha: 1 }).toArray();
  const ya = new Map((await db.collection(COL).find({ id: { $in: lista.map(f => f.id) } }).toArray()).map(x => [x.id, x]));
  const nuevas = [];
  for (const f of lista) {
    const ps = problemas(f, compras);
    const prev = ya.get(f.id);
    if (!ps.length) { if (prev && !prev.resuelto) await db.collection(COL).updateOne({ id: f.id }, { $set: { resuelto: true, resueltoAt: new Date() } }); continue; }
    const firma = ps.map(p => p.que).join('|');
    if (prev && prev.firma === firma && !prev.resuelto) continue;   // ya avisado
    const doc = { id: f.id, numero: f.number, proveedor: f.supplier, fecha: String(f.date).slice(0, 10), total: r2(f.total), problemas: ps, firma, resuelto: false, at: new Date() };
    await db.collection(COL).updateOne({ id: f.id }, { $set: doc }, { upsert: true });
    nuevas.push(doc);
  }
  if (avisar && nuevas.length) {
    const txt = `🧾 *Facturas de proveedor mal pasadas a StelOrder* (${nuevas.length})\nArréglalas antes de cerrar el trimestre, que luego ya no se pueden tocar:\n\n` +
      nuevas.map(n => `• ${n.numero} · ${n.proveedor} (${n.fecha.split('-').reverse().join('/')}) · ${eur(n.total)}\n  ${n.problemas.map(p => p.que).join('\n  ')}`).join('\n\n');
    const N = require('./notifications');
    for (const to of [...new Set([N.destinoDueno(), process.env.OFICINA_TELEFONO || '+34674013723'].filter(Boolean))]) {
      try { await (_enviar || N.sendWhatsAppTo)(to, txt); } catch (e) { console.warn('[FPR] aviso:', e.message); }
    }
  }
  return { revisadas: lista.length, nuevas };
}

// Para /trimestre: las que siguen mal dentro del rango.
async function pendientes(R, _db = null) {
  const db = _db || await getDB();
  return (await db.collection(COL).find({ resuelto: false, fecha: { $gte: R.from, $lte: R.to } }).toArray())
    .flatMap(x => x.problemas.map(p => ({ ref: x.numero, fecha: x.fecha, quien: x.proveedor, total: x.total, que: `Factura de proveedor: ${p.que}` })));
}

module.exports = { revisar, pendientes, problemas, provKey, RESTA };
