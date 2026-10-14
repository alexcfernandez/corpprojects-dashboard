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
        quien: c.subidaPor && c.subidaPor.kind === 'worker' ? c.subidaPor.name : (c.compradoPor && c.compradoPor.name) || null, compraId: String(c._id) });
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
  return Object.values(porCat).filter(g => g.compras.length > 1).sort((a, b) => b.repetidas - a.repetidas || b.compras.length - a.compras.length);
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
  const stop = new Set(['obra', 'obras', 'para', 'esta', 'este', 'compra', 'creo', 'casa', 'calle', 'carrer', 'piso', 'comunidad']);
  const t = n(texto).split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !stop.has(w));
  if (!t.length) return null;
  const sc = os.map(o => { const s = n([o.reference, o.clientName, o.address, ...(o.aliases || [])].join(' ')); return { o, hits: t.filter(w => s.includes(w)).length }; }).filter(x => x.hits).sort((a, b) => b.hits - a.hits);
  return sc.length && (sc.length === 1 || sc[0].hits > sc[1].hits) ? sc[0].o : null;
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
  const quien = compra.subidaPor && compra.subidaPor.kind === 'worker' ? compra.subidaPor : null;
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

// El trabajador contesta a la pregunta de una compra: se guarda en la compra y, si nombra una obra, se pone.
async function respuestaCompra(origen, texto, nombre) {
  const db = await getDB();
  const c = await db.collection('compras').findOne({ _id: new ObjectId(String(origen.compraId)) });
  if (!c) return null;
  const set = { updatedAt: new Date() };
  let obra = null;
  if (!c.obraId && origen.sinObra && texto) { obra = await obraDeTexto(texto); if (obra) { set.obraId = String(obra._id); set.obraRef = obra.reference; set.destino = 'obra'; } }
  await db.collection('compras').updateOne({ _id: c._id }, { $set: set, $push: { respuestasTrabajador: { at: new Date(), por: nombre || '', texto: String(texto || '').slice(0, 600) } } });
  return obra ? { obra: obra.reference } : {};
}

module.exports = { duplicados, limpiarDuplicados, obrasDesdePistas, categoria, historial, repetidas, textoInforme, alSubir, respuestaCompra, obraDeTexto, DURABLES, VENTANA };
