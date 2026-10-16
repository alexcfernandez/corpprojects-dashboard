// src/comprasVigilancia.js — HERRAMIENTAS QUE SE COMPRAN UNA Y OTRA VEZ + «¿para qué obra es?» (14/10/2026).
// Álex: «me da la sensación de que han comprado muchos enrollacables… hay que vigilar cada cuánto compran, si es la
// misma persona y por qué; y cuando compren, preguntar para qué obra». (Enrolladores: 07/04 y 18/04, 20/09 y 21/09.)
//   · categoria(): solo herramientas y equipos que DURAN (enrollador, radial, taladro, escalera…), no el material que
//     se gasta ni sus recambios (discos, brocas, cable por metros).
//   · historial() / repetidas(): de Compras (fotos y correo, con quién y obra) + líneas de las facturas de StelOrder.
//   · alSubir(compra): al entrar una compra, si trae una herramienta que ya se compró en los últimos 120 días → aviso a
//     Álex con las anteriores; y si la sube un trabajador, Corpy le pregunta para qué obra es (si no la dijo) y qué
//     pasó con la anterior. La pregunta queda como encargo: su respuesta se guarda en la compra y pone la obra sola.
'use strict';
const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const n = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const VENTANA = Number(process.env.COMPRAS_REPETIDAS_DIAS || 120);
const MIN_EUR = 15;   // por debajo no es una herramienta (un cutter, una paleta)

const DURABLES = [
  { id: 'enrollador', nombre: 'enrollador / alargador de cable', re: /enrolla\w*|alargador|prolongador|carrete (de )?cable/ },
  { id: 'radial', nombre: 'radial / amoladora', re: /\bradial\b|amoladora|esmeriladora/ },
  { id: 'taladro', nombre: 'taladro / atornillador', re: /taladr\w*|atornillador|martillo (percutor|perforador|electro\w*)|rotomartillo/ },
  { id: 'sierra', nombre: 'sierra / ingletadora', re: /ingletadora|sierra (circular|de calar|sable)|caladora|tronzadora/ },
  { id: 'laser', nombre: 'nivel láser', re: /nivel\s+laser|laser (de )?(lineas|cruz)/ },
  { id: 'escalera', nombre: 'escalera', re: /\bescalera\b/ },
  { id: 'carretilla', nombre: 'carretilla', re: /carretilla/ },
  { id: 'aspirador', nombre: 'aspirador', re: /aspirador/ },
  { id: 'hormigonera', nombre: 'hormigonera', re: /hormigonera/ },
  { id: 'pintar', nombre: 'máquina / pistola de pintar', re: /pistola (de )?pintura|airless|maquina (de )?pintar/ },
  { id: 'batidora', nombre: 'batidora / mezcladora', re: /batidora|mezcladora/ },
  { id: 'foco', nombre: 'foco de obra', re: /\bfoco\b|proyector led/ },
];
const NO_ES = /\bdisco|broca|punta|hoja (de )?sierra|recambio|escobilla|cepillo|accesorio|soporte|funda|adaptador|^ml |\bml cable|rz1|rv-k|h07|manguera|bombilla|bolsa/;

function categoria(desc, precioUnidad) {
  const d = n(desc);
  if (!d || NO_ES.test(d)) return null;
  const c = DURABLES.find(x => x.re.test(d));
  if (!c) return null;
  if (precioUnidad != null && Number(precioUnidad) < MIN_EUR) return null;
  return c;
}
const clave = (prov, fecha, cat, imp) => `${n(prov).split(/\s+/)[0] || ''}|${fecha}|${cat}|${Math.round(Number(imp) || 0)}`;
const fmtF = f => String(f || '').slice(0, 10).split('-').reverse().join('/');
const eur = v => v == null ? '' : `${Number(v).toFixed(2).replace('.', ',')} €`;

// Todas las compras de herramientas que duran, de las dos fuentes, sin repetir la misma compra.
async function historial({ dias = 400, _stel = null } = {}) {
  const db = await getDB();
  const desde = new Date(Date.now() - dias * 864e5).toISOString().slice(0, 10);
  const out = [], ya = new Set();
  const propias = await db.collection('compras').find({ estado: { $ne: 'descartada' }, fecha: { $gte: desde } }).project({ proveedor: 1, fecha: 1, lineas: 1, obraRef: 1, subidaPor: 1, compradoPor: 1, numero: 1, duplicadoDe: 1, total: 1 }).toArray();
  for (const c of propias) {
    if (c.duplicadoDe || !c.fecha) continue;
    for (const l of c.lineas || []) {
      const cant = Number(l.cantidad) || 1;
      const imp = l.importe != null ? Number(l.importe) : (l.precio != null ? Number(l.precio) * cant : null);
      const cat = categoria(l.descripcion, l.precio != null ? l.precio : (imp != null ? imp / cant : null));
      if (!cat) continue;
      const k = clave(c.proveedor, c.fecha, cat.id, imp);
      if (ya.has(k)) { const e = out.find(x => x._k === k); if (e) { e.obra = e.obra || c.obraRef || null; e.quien = e.quien || (c.subidaPor && c.subidaPor.kind === 'worker' ? c.subidaPor.name : null); } continue; }
      ya.add(k);
      out.push({ _k: k, cat: cat.id, nombre: cat.nombre, fecha: c.fecha, proveedor: c.proveedor || '', articulo: l.descripcion, importe: imp, cantidad: cant, obra: c.obraRef || null, totalDoc: c.total,
        quien: c.subidaPor && c.subidaPor.kind === 'worker' ? c.subidaPor.name : (c.compradoPor && c.compradoPor.name) || null, compraId: String(c._id), numero: c.numero || null });
    }
  }
  try {
    const invs = _stel ? await _stel() : await require('./stelorder').getPurchaseInvoices();
    for (const inv of invs || []) {
      const f = String(inv.date || '').slice(0, 10); if (!f || f < desde) continue;
      for (const l of inv.lines || []) {
        if (l.deleted || (l['line-type'] && l['line-type'] !== 'ITEM')) continue;
        const nom = String(l['item-name'] || l['item-description'] || '').trim();
        const u = Number(l.units ?? l.quantity) || 1;
        let t = Number(l['total-amount']), p = Number(l['unit-price'] ?? l.price);
        if (!Number.isFinite(p) && Number.isFinite(t)) p = t / u; if (!Number.isFinite(t) && Number.isFinite(p)) t = p * u;
        const cat = categoria(nom, Number.isFinite(p) ? p : null);
        if (!cat) continue;
        const k = clave(inv.supplier, f, cat.id, t); if (ya.has(k)) continue; ya.add(k);
        out.push({ _k: k, cat: cat.id, nombre: cat.nombre, fecha: f, proveedor: inv.supplier || '', articulo: nom, importe: Number.isFinite(t) ? t : null, cantidad: u, obra: null, quien: null, fpr: inv.number, totalDoc: inv.total });
      }
    }
  } catch (e) { /* StelOrder sin cupo: solo con las de Compras */ }
  // Quién pagó: el pago con tarjeta del mismo comercio, por el total del documento, ese día o hasta 3 días antes.
  try { await ponerTarjetas(out, desde); } catch (e) { /* sin banco: sin nombre */ }
  return out.map(({ _k, totalDoc, ...x }) => x).sort((a, b) => a.fecha.localeCompare(b.fecha));
}

// Pagos con tarjeta (Revolut de cada uno y la de Santander) con la persona de cada tarjeta (Cierre del trimestre).
async function pagosTarjeta(desde) {
  const db = await getDB();
  const [tm, bm, tarjetas, users] = await Promise.all([
    db.collection('tarjetaMovimientos').find({ fecha: { $gte: desde }, importe: { $lt: 0 }, tipo: 'CARD_PAYMENT', interno: { $ne: true } }).project({ fecha: 1, importe: 1, concepto: 1, tarjeta: 1, estado: 1 }).toArray(),
    db.collection('bancoMovimientos').find({ fechaOperacion: { $gte: desde }, importe: { $lt: 0 }, concepto: { $regex: 'tarj', $options: 'i' } }).project({ fechaOperacion: 1, importe: 1, concepto: 1 }).toArray(),
    db.collection('tarjetas').find({}).toArray(), require('./users').getUsers(false),
  ]);
  const quien = last4 => { try { const q = require('./ticketsAviso')._quien(tarjetas, users, last4); return q ? ((q.user && q.user.name) || q.persona || null) : null; } catch (e) { return null; } };
  return [
    ...tm.filter(m => !/declined|reverted|failed/i.test(m.estado || '')).map(m => ({ fecha: String(m.fecha).slice(0, 10), importe: Math.abs(m.importe), concepto: m.concepto, persona: quien(m.tarjeta) })),
    ...bm.map(m => { const t = /\*\s*\d*?(\d{4})\b/.exec(m.concepto || ''); return { fecha: String(m.fechaOperacion).slice(0, 10), importe: Math.abs(m.importe), concepto: m.concepto, persona: t ? quien(t[1]) : null }; }),
  ].filter(p => p.persona);
}
async function ponerTarjetas(items, desde) {
  const sin = items.filter(x => !x.quien && x.totalDoc);
  if (!sin.length) return;
  const pagos = await pagosTarjeta(desde);
  for (const x of sin) {
    const tok = n(x.proveedor).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).find(w => w.length >= 4 && !/^(girona|materials|materiales|derivats|sociedad|limitada)$/.test(w));
    if (!tok) continue;
    const c = pagos.filter(p => n(p.concepto).includes(tok) && Math.abs(p.importe - Math.abs(x.totalDoc)) < 0.6 && (new Date(x.fecha) - new Date(p.fecha)) / 864e5 >= -1 && (new Date(x.fecha) - new Date(p.fecha)) / 864e5 <= 3);
    const ps = [...new Set(c.map(p => p.persona))];
    if (ps.length === 1) { x.quien = ps[0]; x.porTarjeta = true; }
  }
}

// Por herramienta: cuántas se han comprado y las que caen a menos de VENTANA días de la anterior.
async function repetidas({ dias = 400, ventana = VENTANA, ...deps } = {}) {
  const h = await historial({ dias, ...deps });
  const porCat = {};
  for (const x of h) (porCat[x.cat] = porCat[x.cat] || { cat: x.cat, nombre: x.nombre, compras: [], repetidas: 0, total: 0 }).compras.push(x);
  for (const g of Object.values(porCat)) {
    g.compras.forEach((x, i) => { const ant = g.compras[i - 1]; x.diasDesdeAnterior = ant ? Math.round((new Date(x.fecha) - new Date(ant.fecha)) / 864e5) : null; if (ant && x.diasDesdeAnterior <= ventana) g.repetidas++; });
    g.total = Math.round(g.compras.reduce((a, x) => a + (Number(x.importe) || 0), 0) * 100) / 100;
  }
  // ¿Ya está en Herramientas? (por la compra enlazada o por la referencia de la factura)
  try {
    const act = await (await getDB()).collection('activos').find({ tipo: 'herramienta', $or: [{ compraId: { $ne: null } }, { compraRef: { $ne: null } }] }).project({ compraId: 1, compraRef: 1, codigo: 1, nombre: 1 }).toArray();
    for (const g of Object.values(porCat)) for (const x of g.compras) { const a = act.find(a => (x.compraId && a.compraId === x.compraId && n(a.nombre) === n(x.articulo)) || (x.fpr && a.compraRef && a.compraRef.includes(x.fpr) && n(a.nombre) === n(x.articulo))); if (a) x.activo = { id: String(a._id), codigo: a.codigo }; }
  } catch (e) {}
  return Object.values(porCat).filter(g => g.compras.length > 1).sort((a, b) => b.repetidas - a.repetidas || b.compras.length - a.compras.length);
}

// Dar de alta en Herramientas lo comprado (desde la pestaña de repetidas): una ficha por unidad, enlazada a su factura.
async function altaHerramientas(items, por) {
  const act = require('./activos'); const out = [];
  const db = await getDB();
  for (const x of (items || []).slice(0, 60)) {
    const nombre = String(x.articulo || '').trim().slice(0, 120); if (!nombre) continue;
    const ref = `${x.proveedor || ''}${x.numero ? ' nº ' + x.numero : x.fpr ? ' ' + x.fpr : ''}`.trim();
    const ya = await db.collection('activos').findOne({ tipo: 'herramienta', nombre, $or: [x.compraId ? { compraId: String(x.compraId) } : { _id: null }, ref ? { compraRef: ref } : { _id: null }] });
    if (ya) { out.push({ codigo: ya.codigo, nombre, ya: true }); continue; }
    const cant = Math.min(10, Math.max(1, Math.round(Number(x.cantidad) || 1)));
    for (let i = 0; i < cant; i++) {
      const r = await act.crearActivo({ tipo: 'herramienta', nombre, valor: x.importe != null ? Math.round(Math.abs(Number(x.importe)) / cant * 100) / 100 : 0, fechaCompra: x.fecha || null, obraRef: x.obra || '',
        compraId: x.compraId || null, compraRef: ref, notas: `Alta desde Compras (herramientas repetidas)${x.quien ? ' · la compró ' + x.quien : ''}. Comprobar dónde está.` }, por);
      out.push({ codigo: r.codigo, nombre });
    }
  }
  return out;
}

function textoInforme(gs) {
  if (!gs.length) return '✔ No hay herramientas compradas más de una vez en el último año.';
  return '🔁 *Herramientas compradas más de una vez* (último año)\n' + gs.map(g => `\n*${g.nombre}*: ${g.compras.length} (${eur(g.total)})${g.repetidas ? ` · ${g.repetidas} a menos de ${VENTANA} días de la anterior` : ''}\n` +
    g.compras.slice(-6).map(x => `• ${fmtF(x.fecha)} · ${x.proveedor.split(/[\s,]+/).slice(0, 2).join(' ')} · ${eur(x.importe)}${x.quien ? ' · ' + x.quien : ''}${x.obra ? ' · ' + x.obra : ''}`).join('\n')).join('\n');
}

// Obra de las activas que nombra un texto («es de Rutlla», «para Sant Fos»).
async function obraDeTexto(texto) {
  const db = await getDB();
  const os = await db.collection('obras').find({ status: { $nin: ['terminada', 'facturada', 'archivada', 'descartada'] } }, { projection: { reference: 1, clientName: 1, address: 1, aliases: 1 } }).toArray();
  // «Múltiples comunidades», «varias obras»: no es de una obra.
  if (/m[uú]ltiples|varias|varios|diverses|diversas/i.test(String(texto || ''))) return null;
  const stop = new Set(['obra', 'obras', 'para', 'esta', 'este', 'compra', 'creo', 'casa', 'calle', 'carrer', 'piso', 'comunidad', 'comunidades', 'propietarios', 'propietaris', 'girona', 'corporacio', 'corp', 'projects', 'holding', 'direccion', 'entrega', 'nuestra', 'nuestro', 'obres', 'portal', 'bajo', 'baixos', 'planta']);
  const t = n(texto).split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !stop.has(w) && !/^\d+$/.test(w));
  if (!t.length) return null;
  const sc = os.map(o => { const s = n([o.reference, o.clientName, o.address, ...(o.aliases || [])].join(' ')); return { o, hits: t.filter(w => s.includes(w)).length }; }).filter(x => x.hits).sort((a, b) => b.hits - a.hits);
  // Solo si el texto apunta a UNA obra (si nombra dos o más, p. ej. un albarán con varias direcciones, que lo mire una persona).
  return sc.length === 1 ? sc[0].o : null;
}

// ── Duplicados: misma compra subida dos veces (foto del trabajador + correo + subida masiva…) ──
const nnum = x => String(x || '').replace(/[^0-9a-z]/gi, '').replace(/^0+/, '').toLowerCase();
function puntos(c) {   // cuál se ve mejor / tiene más datos
  return (c.estado === 'revisada' ? 100 : c.estado === 'por_revisar' ? 10 : 0) + (c.subidaPor && c.subidaPor.kind === 'worker' ? 5 : 0) + Math.min(c.nLineas || 0, 60) / 4
    + (c.ia && c.ia.calidad === 'legible' ? 6 : c.ia && c.ia.calidad === 'cortado' ? -25 : 0) + (c.obraId ? 4 : 0) + Math.min(c.nFotos || 1, 4) + (c.total ? 2 : 0);
}
async function duplicados() {
  const db = await getDB();
  const l = (await db.collection('compras').find({ estado: { $ne: 'descartada' } }).project({ lineas: 0 }).sort({ createdAt: -1 }).limit(1500).toArray()).map(c => ({ ...c, _id: String(c._id) }));
  const nl = await db.collection('compras').aggregate([{ $match: { estado: { $ne: 'descartada' } } }, { $project: { n: { $size: { $ifNull: ['$lineas', []] } } } }]).toArray().catch(() => []);
  const nPor = Object.fromEntries(nl.map(x => [String(x._id), x.n])); l.forEach(c => { c.nLineas = nPor[c._id] || 0; });
  const usado = new Set(), out = [];
  for (const a of l) {
    if (usado.has(a._id)) continue;
    const g = [a];
    for (const b of l) {
      if (b === a || usado.has(b._id)) continue;
      if (!((a.proveedorNorm && a.proveedorNorm === b.proveedorNorm) || (a.nif && a.nif === b.nif))) continue;
      if ((a.tipo === 'albaran') !== (b.tipo === 'albaran')) continue;   // factura + su albarán no es un duplicado (se casan)
      const mismoNum = a.numero && b.numero && nnum(a.numero) === nnum(b.numero);
      const mismoImp = a.total != null && b.total != null && Math.abs(a.total - b.total) < 0.02;
      const df = a.fecha && b.fecha ? Math.abs(new Date(a.fecha) - new Date(b.fecha)) / 864e5 : 99;
      if (mismoNum || (mismoImp && df <= 1)) g.push(b);
    }
    if (g.length < 2 || !g.some(x => x.estado === 'por_revisar')) continue;
    g.forEach(x => usado.add(x._id));
    const orden = g.slice().sort((x, y) => puntos(y) - puntos(x));
    const seguro = g.every(x => nnum(x.numero) && nnum(x.numero) === nnum(g[0].numero) && x.total != null && Math.abs(x.total - g[0].total) < 0.02 && x.tipo === g[0].tipo)
      && !(g.filter(x => x.obraId).length > 1 && new Set(g.filter(x => x.obraId).map(x => x.obraId)).size > 1)   // obras distintas: que lo mire una persona
      && !(orden[0].estado === 'revisada' && orden.slice(1).some(x => x.obraId && !orden[0].obraId));            // la que se va tiene la obra y la revisada no
    out.push({ seguro, mantener: orden[0]._id, compras: orden.map(c => ({ id: c._id, estado: c.estado, tipo: c.tipo, proveedor: c.proveedor, numero: c.numero, fecha: c.fecha, total: c.total, nFotos: c.nFotos || 1, nLineas: c.nLineas, origen: c.origen,
      subidaPor: (c.subidaPor || {}).name || '', calidad: c.ia && c.ia.calidad, obraRef: c.obraRef || null, puntos: Math.round(puntos(c)) })) });
  }
  return out;
}
// Limpieza: los duplicados seguros se resuelven solos (se queda la que más puntúa).
async function limpiarDuplicados({ por = 'Corpy (limpieza)' } = {}) {
  const C = require('./compras'); const r = { resueltos: [], paraMirar: [] };
  for (const d of await duplicados()) {
    if (!d.seguro) { r.paraMirar.push(d); continue; }
    for (const c of d.compras.slice(1)) { try { r.resueltos.push({ ...(await C.resolverDuplicado(d.mantener, c.id, por)), proveedor: c.proveedor, numero: c.numero }); } catch (e) { r.paraMirar.push({ ...d, error: e.message }); } }
  }
  return r;
}

// ── La obra escrita en el papel («obra Rutlla», la dirección de entrega) → se pone sola ──
async function obrasDesdePistas({ aplicar = false, soloId = null } = {}) {
  const db = await getDB();
  const q = { estado: 'por_revisar', obraId: { $in: [null, ''] }, varias: { $ne: true } };
  if (soloId) q._id = new ObjectId(String(soloId));
  const cs = await db.collection('compras').find(q).project({ obraPista: 1, nota: 1, destino: 1, proveedor: 1, numero: 1, total: 1, 'lineas.obraTexto': 1 }).toArray();
  const out = [];
  for (const c of cs) {
    if (c.destino && c.destino !== 'obra') continue;
    const pistas = [c.obraPista, ...new Set((c.lineas || []).map(l => l.obraTexto).filter(Boolean))].filter(Boolean);
    if (!pistas.length) continue;
    const o = await obraDeTexto(pistas.join(' · '));
    if (!o) continue;
    out.push({ id: String(c._id), proveedor: c.proveedor, numero: c.numero, total: c.total, pista: pistas.join(' · ').slice(0, 120), obra: o.reference });
    if (aplicar) await db.collection('compras').updateOne({ _id: c._id }, { $set: { obraId: String(o._id), obraRef: o.reference, destino: 'obra', obraAuto: { desde: pistas.join(' · ').slice(0, 160), at: new Date() }, updatedAt: new Date() } });
  }
  return { n: out.length, aplicado: aplicar, lista: out };
}

// Al entrar una compra (ya leída por la IA).
const _dig = x => String(x || '').replace(/\D/g, '').slice(-9);
async function esDelDueno(userId) {
  try {
    if (!/^[a-f0-9]{24}$/.test(String(userId))) return false;
    const u = await (await getDB()).collection('users').findOne({ _id: new ObjectId(String(userId)) }, { projection: { whatsapp: 1, telefono: 1, esDueno: 1 } });
    const d = _dig(require('./notifications').destinoDueno());
    return !!(u && (u.esDueno || (d && [u.whatsapp, u.telefono].some(t => _dig(t) === d))));
  } catch (e) { return false; }
}
async function alSubir(compra, { _avisar = null, _crearEncargo = null, _hist = null } = {}) {
  if (!compra) return {};
  // Si el papel dice la obra, se pone sola (y no se le pregunta al trabajador).
  if (!compra.obraId && compra.obraPista && !compra.varias && (!compra.destino || compra.destino === 'obra')) {
    try { const r = await obrasDesdePistas({ aplicar: true, soloId: compra._id }); if (r.lista[0]) { compra.obraRef = r.lista[0].obra; compra.obraId = 'auto'; } } catch (e) {}
  }
  const nuevas = [];
  for (const l of compra.lineas || []) { const cant = Number(l.cantidad) || 1; const imp = l.importe != null ? Number(l.importe) : null; const c = categoria(l.descripcion, l.precio != null ? l.precio : (imp != null ? imp / cant : null)); if (c && !nuevas.some(x => x.cat.id === c.id)) nuevas.push({ cat: c, l, imp }); }
  const out = { repetidas: [] };
  if (nuevas.length) {
    const h = _hist ? await _hist() : await historial({ dias: VENTANA + 10 });
    const f0 = compra.fecha || new Date().toISOString().slice(0, 10);
    for (const x of nuevas) {
      const antes = h.filter(y => y.cat === x.cat.id && y.compraId !== String(compra._id) && y.fecha <= f0 && (new Date(f0) - new Date(y.fecha)) / 864e5 <= VENTANA && !(n(y.proveedor).split(/\s+/)[0] === n(compra.proveedor).split(/\s+/)[0] && y.fecha === f0));
      if (antes.length) out.repetidas.push({ ...x, antes });
    }
  }
  let quien = compra.subidaPor && compra.subidaPor.kind === 'worker' ? compra.subidaPor : null;
  // Álex también tiene ficha de trabajador (con su móvil): a él no se le pregunta «¿para qué obra?» (14/10/2026: BAUHAUS).
  if (quien && await esDelDueno(quien.userId)) quien = null;
  const sinObra = !compra.obraId && (!compra.destino || compra.destino === 'obra') && !compra.varias;
  if (out.repetidas.length) {
    const t = out.repetidas.map(r => `⚠️ *Otra compra de ${r.cat.nombre}*: ${eur(r.imp)} en ${compra.proveedor || '¿?'} (${fmtF(compra.fecha)})${quien ? ` · la sube *${quien.name}*` : ''}${compra.obraRef ? ' · ' + compra.obraRef : ''}.\nEn los últimos ${VENTANA} días ya se compró:\n` +
      r.antes.slice(-5).map(y => `• ${fmtF(y.fecha)} · ${y.proveedor.split(/[\s,]+/).slice(0, 2).join(' ')} · ${eur(y.importe)}${y.quien ? ' · ' + y.quien : ''}${y.obra ? ' · ' + y.obra : ''}`).join('\n')).join('\n\n');
    try { await (_avisar || require('./notifications').sendWhatsApp)(t + (quien ? `\n\nLe he preguntado a ${quien.name.split(' ')[0]} qué pasó con el anterior.` : '')); } catch (e) {}
  }
  // Al trabajador que la sube: para qué obra (si no lo dijo) y qué pasó con la herramienta anterior.
  if (quien && quien.userId && /^[a-f0-9]{24}$/.test(String(quien.userId)) && (sinObra || out.repetidas.length)) {
    const que = `${compra.proveedor || 'la compra'}${compra.total != null ? ' de ' + eur(compra.total) : ''}`;
    const partes = [];
    if (sinObra) partes.push(`¿para qué obra es la compra de ${que}?`);
    for (const r of out.repetidas) partes.push(`veo que hace poco ya compramos ${r.cat.nombre.split(' / ')[0] === 'enrollador' ? 'un enrollador' : 'un/a ' + r.cat.nombre.split(' / ')[0]} (${fmtF(r.antes[r.antes.length - 1].fecha)}). ¿Qué pasó con el anterior: se rompió, se perdió o se quedó en otra obra? ¿Dónde está ahora?`);
    const pregunta = partes.length > 1 ? `Una cosa: ${partes[0]} Y otra: ${partes.slice(1).join(' ')}` : `Una cosa: ${partes[0].charAt(0).toUpperCase() + partes[0].slice(1)}`;
    try {
      await (_crearEncargo || ((o, d) => require('./encargos').crear(o, d)))({ userId: quien.userId, que: (sinObra ? 'obra de la compra' : '') + (sinObra && out.repetidas.length ? ' y ' : '') + (out.repetidas.length ? `por qué otro ${out.repetidas[0].cat.nombre.split(' / ')[0]}` : '') + ` (${String(compra.proveedor || '').slice(0, 30)})`,
        mensaje: pregunta, textoCompleto: pregunta, origen: { tipo: 'compra', compraId: String(compra._id), sinObra, repetida: out.repetidas.map(r => r.cat.id) }, por: 'Corpy' }, { _enviar: async () => true });   // la pregunta va en la misma respuesta del bot
      out.pregunta = pregunta;
    } catch (e) { console.warn('[Compras] pregunta al trabajador:', e.message); }
  }
  try { if (out.repetidas.length) await (await getDB()).collection('compras').updateOne({ _id: new ObjectId(String(compra._id)) }, { $set: { repetida: out.repetidas.map(r => ({ cat: r.cat.id, nombre: r.cat.nombre, antes: r.antes.slice(-5) })) } }); } catch (e) {}
  return out;
}

// ── 17:00 (L-V): «¿para qué obra era?» a quien compró lo que sigue sin obra (Álex: «a las 17 ya han plegado y lo miran
// con calma en casa»). Quién: el que la subió o, si llegó por correo, el de la tarjeta con la que se pagó. Una pregunta por
// compra (queda como encargo: su respuesta pone la obra y, si todo cuadra, la compra se revisa y sube sola).
async function compradorDe(c, users) {
  if (c.subidaPor && c.subidaPor.kind === 'worker' && /^[a-f0-9]{24}$/.test(String(c.subidaPor.userId))) return { userId: String(c.subidaPor.userId), name: c.subidaPor.name };
  if (!c.total || !c.fecha) return null;
  const desde = new Date(new Date(c.fecha).getTime() - 2 * 864e5).toISOString().slice(0, 10);
  const x = { proveedor: c.proveedor || '', fecha: c.fecha, totalDoc: c.total, quien: null };
  try { await ponerTarjetas([x], desde); } catch (e) {}
  if (!x.quien) return null;
  const u = users.find(u => n(u.name) === n(x.quien));
  return u ? { userId: String(u._id), name: u.name } : null;
}
async function preguntarObras({ dryRun = false, porPersona = 4, _crear = null, _avisar = null } = {}) {
  const db = await getDB();
  const U = require('./users');
  const FD = require('./fichaDatos');   // solo el equipo (no Álex, ni autónomos)
  const dueno = _dig(require('./notifications').destinoDueno());
  const users = (await U.getUsers(false)).filter(u => u.active !== false && ['tecnico', 'encargado'].includes(U.normalizeRole(u.role)) && FD.delEquipo(u) && !(dueno && [u.whatsapp, u.telefono].some(t => _dig(t) === dueno)));
  const desde = new Date(Date.now() - 45 * 864e5);
  // De lo comprado hace más de 90 días ya nadie se acuerda (15/10: a Jose se le preguntó por una de noviembre de 2025).
  const fechaMin = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
  const cs = await db.collection('compras').find({ estado: 'por_revisar', obraId: { $in: [null, ''] }, varias: { $ne: true }, tipo: { $in: ['factura', 'ticket', 'albaran'] }, createdAt: { $gte: desde }, preguntaObra: { $exists: false } })
    .project({ proveedor: 1, fecha: 1, total: 1, destino: 1, subidaPor: 1, 'lineas.descripcion': 1, numero: 1 }).sort({ fecha: 1 }).toArray();
  const porU = {}, hechas = [], sinQuien = [], porLista = {};
  for (const c of cs) {
    if (c.destino && c.destino !== 'obra') continue;
    if (!c.fecha || c.fecha < fechaMin) continue;
    const q = await compradorDe(c, users);
    if (!q || !users.some(u => String(u._id) === q.userId)) { sinQuien.push(c); continue; }
    if ((porU[q.userId] = (porU[q.userId] || 0) + 1) > porPersona) continue;
    const art = (c.lineas || []).slice(0, 2).map(l => String(l.descripcion).slice(0, 40)).join(', ');
    // Donde estaba él ese día según la presencia: se le propone («¿era para Claudia?»).
    let suya = null;
    try { const a = await db.collection('attendance').findOne({ workerId: q.userId, date: c.fecha, estado: 'obra' }, { projection: { clientName: 1, obras: 1 } }); suya = a && (((a.obras || [])[0] || {}).clientName || a.clientName) || null; } catch (e) {}
    const mensaje = `¿Para qué obra fue la compra de *${c.proveedor || 'la tienda'}* del ${fmtF(c.fecha)} (${eur(c.total)})${art ? `: ${art}${(c.lineas || []).length > 2 ? '…' : ''}` : ''}?${suya ? ` ¿Era para *${suya}*, donde estabas ese día?` : ''} Dime la obra, o si era para el almacén, herramienta o la furgoneta.`;
    const linea = `*${c.proveedor || 'la tienda'}* del ${fmtF(c.fecha)} (${eur(c.total)})${art ? `: ${art}${(c.lineas || []).length > 2 ? '…' : ''}` : ''}${suya ? ` — ¿*${suya}*?` : ''}`;
    (porLista[q.userId] = porLista[q.userId] || { q, items: [] }).items.push({ c, mensaje, linea });
    hechas.push({ a: q.name, proveedor: c.proveedor, fecha: c.fecha, total: c.total });
  }
  // Una sola lista numerada por persona (16/10/2026: a Manolo y a David les llegaban 4 mensajes seguidos).
  if (!dryRun) {
    for (const { q, items } of Object.values(porLista)) {
      const grupo = `${q.userId}:${Date.now()}`;
      const uno = items.length === 1;
      for (const [i, it] of items.entries()) {
        try {
          await (_crear || ((o, d) => require('./encargos').crear(o, d)))({ userId: q.userId, que: `obra de la compra (${String(it.c.proveedor || '').slice(0, 30)} ${fmtF(it.c.fecha)})`, mensaje: it.mensaje, origen: { tipo: 'compra', compraId: String(it.c._id), sinObra: true, ...(uno ? {} : { grupo, n: i + 1 }) }, por: 'Corpy' }, uno ? {} : { _enviar: async () => true });
          await db.collection('compras').updateOne({ _id: it.c._id }, { $set: { preguntaObra: { at: new Date(), a: q.name } } });
        } catch (e) { console.warn('[Compras] pregunta obra:', e.message); }
      }
      if (!uno) {
        const nom = String(q.name || '').split(/\s+/)[0];
        const txt = `Hola ${nom} 👋 Soy Corpy, de la oficina de Corp Projects. Tengo ${items.length} compras sin obra. ¿Para qué obra fue cada una?\n\n${items.map((it, i) => `${i + 1}. ${it.linea}`).join('\n')}\n\nContéstame en un mensaje con el número y la obra, por ejemplo: «1 Rahola, 2 almacén, 3 y 4 Rahola». Si son todas de la misma obra, dime solo la obra. También vale «herramienta» o «furgoneta».`;
        try { await (_avisar ? (async () => true) : (async () => { const U = require('./users'); const u = (await U.getUsers(false)).find(x => String(x._id) === q.userId); const tel = require('./recordatoriosCobro')._movil(u && (u.whatsapp || u.telefono)); if (tel) await require('./notifications').sendWhatsAppTo(tel, txt); }))(); } catch (e) { console.warn('[Compras] lista de obra:', e.message); }
      }
    }
  }
  if (!dryRun && hechas.length) {
    const g = {}; hechas.forEach(h => (g[h.a] = g[h.a] || []).push(h));
    try { await (_avisar || require('./notifications').sendWhatsApp)(`📨 *Compras sin obra* — les he preguntado para qué obra eran:\n${Object.entries(g).map(([a, l]) => `• ${a}: ${l.map(h => `${h.proveedor} ${eur(h.total)}`).join(', ')}`).join('\n')}${sinQuien.length ? `\n\n${sinQuien.length} sin saber quién las compró: míralas en Compras.` : ''}`); } catch (e) {}
  }
  return { preguntadas: hechas.length, hechas, sinQuien: sinQuien.length };
}

// ── «SIN OBRA»: las compras por revisar sin obra, con quién las compró y la obra PROBABLE: donde trabajaba la gente ese
// día según la presencia (si solo hubo una obra, casi seguro es esa). Para ponerlas de un vistazo (Álex, 14/10/2026).
async function sinObra({ limite = 300 } = {}) {
  const db = await getDB();
  const cs = await db.collection('compras').find({ estado: 'por_revisar', obraId: { $in: [null, ''] }, varias: { $ne: true } })
    .project({ proveedor: 1, fecha: 1, total: 1, tipo: 1, destino: 1, subidaPor: 1, numero: 1, obraPista: 1, preguntaObra: 1, origen: 1, 'lineas.descripcion': 1 }).sort({ fecha: -1 }).limit(limite).toArray();
  const fechas = [...new Set(cs.map(c => c.fecha).filter(Boolean))];
  const att = fechas.length ? await db.collection('attendance').find({ date: { $in: fechas }, estado: 'obra' }, { projection: { date: 1, workerName: 1, clientName: 1, obras: 1 } }).toArray().catch(() => []) : [];
  const obras = await db.collection('obras').find({}, { projection: { reference: 1, status: 1 } }).toArray();
  const porRef = new Map(obras.map(o => [n(o.reference), o]));
  const delDia = {};
  for (const a of att) {
    const lista = (a.obras || []).filter(x => x.obraId).map(x => ({ id: String(x.obraId), ref: x.clientName })).concat(a.clientName && porRef.get(n(a.clientName)) ? [{ id: String(porRef.get(n(a.clientName))._id), ref: a.clientName }] : []);
    for (const o of lista) { const k = a.date + '|' + o.id; (delDia[a.date] = delDia[a.date] || {}); delDia[a.date][o.id] = delDia[a.date][o.id] || { id: o.id, ref: (obras.find(x => String(x._id) === o.id) || {}).reference || o.ref, gente: new Set() }; delDia[a.date][o.id].gente.add(String(a.workerName || '').split(' ')[0]); }
  }
  const out = [];
  for (const c of cs) {
    const sug = Object.values(delDia[c.fecha] || {}).map(x => ({ id: x.id, ref: x.ref, gente: [...x.gente] })).sort((a, b) => b.gente.length - a.gente.length).slice(0, 3);
    let quien = c.subidaPor && c.subidaPor.kind === 'worker' ? c.subidaPor.name : null, porTarjeta = false;
    if (!quien && c.total && c.fecha) { const x = { proveedor: c.proveedor || '', fecha: c.fecha, totalDoc: c.total, quien: null }; try { await ponerTarjetas([x], new Date(new Date(c.fecha).getTime() - 2 * 864e5).toISOString().slice(0, 10)); } catch (e) {} quien = x.quien; porTarjeta = !!x.quien; }
    // Si sabemos quién la compró, primero la obra donde estaba ÉL ese día.
    if (quien) { const yo = n(String(quien).split(' ')[0]); sug.forEach(x => { x.suya = x.gente.some(g => n(g) === yo); }); sug.sort((a, b) => (b.suya ? 1 : 0) - (a.suya ? 1 : 0)); }
    out.push({ id: String(c._id), fecha: c.fecha, proveedor: c.proveedor, numero: c.numero, total: c.total, tipo: c.tipo, destino: c.destino || 'obra', origen: c.origen, quien, porTarjeta, pista: c.obraPista || null,
      articulos: (c.lineas || []).slice(0, 3).map(l => String(l.descripcion).slice(0, 50)), nLineas: (c.lineas || []).length, sugerencias: sug, preguntado: c.preguntaObra ? c.preguntaObra.a : null });
  }
  return out;
}

// ── CADA 3 DÍAS: resumen para repasar Compras con Álex (Álex: «revisamos una vez cada tres días tú y yo»). ──
async function resumenRevision({ _avisar = null, dryRun = false } = {}) {
  const db = await getDB();
  const hace3 = new Date(Date.now() - 3 * 864e5);
  const [pend, auto, dups, sin, subs] = await Promise.all([
    db.collection('compras').countDocuments({ estado: 'por_revisar' }),
    db.collection('compras').countDocuments({ 'autoRevisada.at': { $gte: hace3 } }),
    duplicados().then(l => l.length).catch(() => 0),
    sinObra().catch(() => []),
    require('./precios').subidas({ limite: 3 }).catch(() => ({ subidas: [], nSubidas: 0 })),
  ]);
  const unaObra = sin.filter(c => c.sugerencias.length === 1).length;
  const t = `🧾 *Repaso de Compras* (cada 3 días)\n• Por revisar: *${pend}*${auto ? ` · ${auto} subidas solas a StelOrder estos días` : ''}\n• Sin obra: *${sin.length}*${unaObra ? ` (${unaObra} con una sola obra posible ese día: casi elegir y seguir)` : ''}\n• Duplicados por mirar: ${dups}` +
    (subs.subidas.length ? `\n• Subidas de precio: ${subs.nSubidas}, p. ej. ${subs.subidas.slice(0, 2).map(x => `${x.articulo.slice(0, 30)} +${x.pct} % (${x.tienda})`).join(', ')}` : '') +
    `\n\nCuando tengas un rato, ábreme (Claude) y lo repasamos juntos. Pestañas: https://dashboard.corpprojects.es/compras`;
  if (!dryRun) { try { await (_avisar || require('./notifications').sendWhatsApp)(t); } catch (e) {} }
  return { texto: t };
}

// El trabajador contesta a la pregunta de una compra: se guarda en la compra y, si nombra una obra, se pone.
async function respuestaCompra(origen, texto, nombre) {
  const db = await getDB();
  const c = await db.collection('compras').findOne({ _id: new ObjectId(String(origen.compraId)) });
  if (!c) return null;
  const set = { updatedAt: new Date() };
  let obra = null;
  if (!c.obraId && origen.sinObra && texto) { obra = await obraDeTexto(texto); if (obra) { set.obraId = String(obra._id); set.obraRef = obra.reference; set.destino = 'obra'; } }
  await db.collection('compras').updateOne({ _id: c._id }, { $set: set, $push: { respuestasTrabajador: { at: new Date(), por: nombre || '', texto: String(texto || '').slice(0, 600) } } });
  let auto = null; if (obra) { try { auto = await require('./compras').autoRevisar(String(c._id)); } catch (e) {} }
  return obra ? { obra: obra.reference, subida: !!(auto && auto.revisada) } : {};
}

module.exports = { _pagosTarjeta: pagosTarjeta, resumenRevision, sinObra, preguntarObras, altaHerramientas, duplicados, limpiarDuplicados, obrasDesdePistas, categoria, historial, repetidas, textoInforme, alSubir, respuestaCompra, obraDeTexto, DURABLES, VENTANA };
