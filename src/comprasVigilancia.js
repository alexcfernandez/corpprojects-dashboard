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
  const propias = await db.collection('compras').find({ estado: { $ne: 'descartada' }, fecha: { $gte: desde } }).project({ proveedor: 1, fecha: 1, lineas: 1, obraRef: 1, subidaPor: 1, numero: 1, duplicadoDe: 1 }).toArray();
  for (const c of propias) {
    if (c.duplicadoDe || !c.fecha) continue;
    for (const l of c.lineas || []) {
      const cant = Number(l.cantidad) || 1;
      const imp = l.importe != null ? Number(l.importe) : (l.precio != null ? Number(l.precio) * cant : null);
      const cat = categoria(l.descripcion, l.precio != null ? l.precio : (imp != null ? imp / cant : null));
      if (!cat) continue;
      const k = clave(c.proveedor, c.fecha, cat.id, imp); if (ya.has(k)) continue; ya.add(k);
      out.push({ cat: cat.id, nombre: cat.nombre, fecha: c.fecha, proveedor: c.proveedor || '', articulo: l.descripcion, importe: imp, cantidad: cant, obra: c.obraRef || null,
        quien: c.subidaPor && c.subidaPor.kind === 'worker' ? c.subidaPor.name : null, compraId: String(c._id) });
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
        out.push({ cat: cat.id, nombre: cat.nombre, fecha: f, proveedor: inv.supplier || '', articulo: nom, importe: Number.isFinite(t) ? t : null, cantidad: u, obra: null, quien: null, fpr: inv.number });
      }
    }
  } catch (e) { /* StelOrder sin cupo: solo con las de Compras */ }
  return out.sort((a, b) => a.fecha.localeCompare(b.fecha));
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

// Al entrar una compra (ya leída por la IA).
async function alSubir(compra, { _avisar = null, _crearEncargo = null, _hist = null } = {}) {
  if (!compra) return {};
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

module.exports = { categoria, historial, repetidas, textoInforme, alSubir, respuestaCompra, obraDeTexto, DURABLES, VENTANA };
