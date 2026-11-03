// src/materialesObra.js — PRESUPUESTO ACEPTADO → LISTA DE MATERIALES → PARTE DE TRABAJO (4/11/2026, Álex: «tiene que
// aceptarlo cuando es un presupuesto, ver lo que es, decirnos qué materiales necesitamos — para esto necesitará 40 sacos de
// Pegolán —, un PDF de compra de esa obra (lo de los pinchos: tantos metros, el pegante, que me he olvidado comprar);
// se va tachando a medida que se compra y, cuando esté todo, sale el parte de trabajo para el trabajador, asignárselo a
// quien lo va a hacer, con todas las instrucciones»).
//
//   1. alAceptar(prt): un PRT pasa a aceptado (Álex o Alfonso por Corpy, o en StelOrder: revisarAceptados) → su obra
//      (la que ya lo tiene o una nueva) → generar(): la IA lee las partidas y saca materiales con cantidad (consumibles
//      incluidos), herramientas, EPIs, medios e instrucciones paso a paso. A Álex: resumen + PDF «Lista de compra».
//   2. cruzar(): cada media hora, las compras de esa obra (Compras, con su obra puesta) tachan lo que cubren (la IA
//      convierte unidades: «2 × 50 varillas de 50 cm» = 50 m). También se tacha a mano (panel de la obra).
//   3. Cuando no falta nada → a Álex «🔧 ¿Quién va?» (trabajosSeguimiento) con una petición del trabajo: al contestar
//      «David y Diego el lunes a las 8» se crea incidencia + pedido + asignación como siempre, y al operario le llega la
//      ficha y el PDF del parte con las instrucciones.
//   Colección `listasMateriales`. Se apaga con MATERIALES_OBRA=off.
'use strict';
const { ObjectId } = require('mongodb');
const COL = 'listasMateriales';
const ESTADO_ACEPTADO = 1120656;
const DESDE = '2026-11-04';   // PRT aceptados en StelOrder a partir de aquí (los de antes, solo a mano)
async function getDB() { return require('./db').getDB(); }
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const corto = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const num = n => { const v = r2(n); return Number.isInteger(v) ? String(v) : String(v).replace('.', ','); };
const oid = id => new ObjectId(String(id));
const apagado = () => process.env.MATERIALES_OBRA === 'off';

// ── IA ──
const HERR_LISTA = {
  name: 'lista_obra',
  description: 'Lista de materiales y parte de trabajo de un presupuesto aceptado.',
  input_schema: { type: 'object', properties: {
    resumen: { type: 'string', description: 'Qué hay que hacer, en una frase para el operario.' },
    materiales: { type: 'array', items: { type: 'object', properties: {
      material: { type: 'string', description: 'Como lo pide un operario en la tienda (p. ej. «Pegolán gris saco 25 kg», «varillas antipalomas inox 50 cm», «adhesivo de montaje para exterior (cartucho)»).' },
      cantidad: { type: 'number', description: 'Cantidad a COMPRAR, por exceso (+10 % de merma) y redondeada a envases enteros.' },
      unidad: { type: 'string', description: 'sacos, ml, m², ud, cartuchos, cajas, litros…' },
      partida: { type: 'string', description: 'Para qué partida del presupuesto es.' },
      calculo: { type: 'string', description: 'Cómo sale la cantidad (p. ej. «104 ml + 10 %», «1 cartucho cada 3 m»).' },
      critico: { type: 'boolean', description: 'true si sin esto no se puede empezar.' },
    }, required: ['material', 'cantidad', 'unidad'] } },
    herramientas: { type: 'array', items: { type: 'string' } },
    epis: { type: 'array', items: { type: 'string' } },
    medios: { type: 'array', items: { type: 'string' }, description: 'Plataforma, andamio, grúa, línea de vida… con días si se sabe.' },
    instrucciones: { type: 'array', items: { type: 'string' }, description: 'Pasos del trabajo en orden, claros, para el operario.' },
    personas: { type: 'integer' }, jornadas: { type: 'number' },
    avisos: { type: 'array', items: { type: 'string' }, description: 'Cosas a vigilar o confirmar antes (medidas, accesos, permisos, vecinos…).' },
  }, required: ['resumen', 'materiales', 'instrucciones'] },
};
const HERR_CRUCE = {
  name: 'cruce',
  description: 'Qué cantidad de cada material de la lista cubre esta compra.',
  input_schema: { type: 'object', properties: { cubre: { type: 'array', items: { type: 'object', properties: {
    item: { type: 'string', description: 'id del material de la lista' },
    cantidad: { type: 'number', description: 'Cantidad que cubre, EN LA UNIDAD DE LA LISTA (convierte: 2 paquetes de 50 varillas de 50 cm = 50 ml).' },
    linea: { type: 'string', description: 'Línea de la compra que lo cubre' },
  }, required: ['item', 'cantidad'] } } }, required: ['cubre'] },
};

async function _ia(prompt, herr, maxTokens = 3000) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) throw new Error('Falta ANTHROPIC_API_KEY');
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: AbortSignal.timeout(120000),
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: require('./config').ia.agente, max_tokens: maxTokens, tools: [herr], tool_choice: { type: 'tool', name: herr.name }, messages: [{ role: 'user', content: prompt }] }) });
  const d = await r.json(); if (!r.ok) throw new Error(`IA ${r.status}: ${d.error?.message || ''}`);
  const tu = (d.content || []).find(b => b.type === 'tool_use');
  if (!tu) throw new Error('La IA no ha devuelto la lista');
  return tu.input;
}

// Partidas del PRT en texto (nombre, cantidad, precio y la descripción larga, que es donde está el detalle).
function textoPartidas(p) {
  return (p.lines || []).filter(l => l && !l.deleted && (l['line-type'] || 'ITEM') === 'ITEM').map(l =>
    `- ${num(l.units || 1)} × ${corto(l['item-name'] || 'Partida', 140)} (${num(l['item-base-price'])} €/ud): ${corto(l['item-description'] || '', 1200)}`).join('\n');
}

const promptLista = (p, obra) => `Eres el encargado de obra de Corp Projects (reformas y mantenimiento de comunidades en Girona). Este presupuesto está ACEPTADO. Prepara la compra y el parte de trabajo.
Presupuesto ${p['full-reference']}${p.title ? ` «${p.title}»` : ''} · Cliente: ${obra.clientName || ''} · Dirección: ${obra.address || '—'}
${p.notes || p['addendum'] ? `Notas: ${corto(p.notes || p.addendum, 600)}\n` : ''}Partidas:
${textoPartidas(p)}

REGLAS:
- MATERIALES: todo lo que hay que COMPRAR, con cantidad por exceso (+10 % de merma) y en envases enteros (sacos de 25 kg, cartuchos, cajas, rollos). No olvides los consumibles y fijaciones: adhesivos y siliconas (1 cartucho cada 2-3 m de perfil o pincho), tacos y tornillos, imprimaciones, cinta, discos, brocas, sacos de escombro, plástico de protección… Nombres de tienda (Obramat/Leroy), sin marcas raras. Cuando haya medidas en las partidas, úsalas y di el cálculo.
- NO son materiales: la mano de obra, el desplazamiento, la limpieza ni los medios auxiliares de alquiler (esos van en «medios», con días).
- Instrucciones para el operario: pasos concretos y en orden (preparación, seguridad, ejecución, comprobación, limpieza, fotos de antes y después para el parte).
- Si una medida es estimada («se ajustará a la medición real»), avísalo en «avisos» y pide medir antes de comprar todo.`;

const promptCruce = (lista, c) => `Lista de materiales de la obra (id · material · cantidad que falta):
${lista.items.filter(i => !i.ok).map(i => `${i.id} · ${i.material} · faltan ${num(Math.max(0, i.cantidad - (i.tenemos || 0)))} ${i.unidad}`).join('\n')}

Compra de ${c.proveedor || 'proveedor'} del ${c.fecha || ''}:
${(c.lineas || []).map(l => `- ${num(l.cantidad || 1)} ${l.unidad || 'ud'} · ${l.descripcion}`).join('\n') || '(sin líneas)'}

¿Qué materiales de la lista cubre esta compra y cuánto, en la unidad de la lista? Solo lo que encaje claramente (mismo material o equivalente). Si nada encaja, devuelve cubre vacío.`;

// ── Obra del PRT: la que ya lo tiene; si no, una nueva ──
async function _obraDe(db, p, por) {
  const ref = p['full-reference'];
  let o = await db.collection('obras').findOne({ $or: [{ 'presupuestosStel.id': String(p.id) }, { 'presupuestosStel.numero': ref }, { aliases: ref }] });
  if (o) return o;
  const S = require('./stelorder');
  const { clientMap } = await S.getClients().catch(() => ({ clientMap: {} }));
  const c = clientMap[String(p['account-id'])] || {};
  const a = c['main-address'] || {};
  const O = require('./obras');
  const nueva = await O.createObra({ clientName: c.name || c['legal-name'] || 'Cliente', reference: corto(`${c.name || ''} · ${p.title || ref}`, 120), address: [a['address-data'], a['city-town']].filter(Boolean).join(', '), status: 'activa', description: `${ref} aceptado. Obra creada sola para la lista de materiales (${por}).`, aliases: [ref] });
  const id = String(nueva._id || nueva.id || nueva.insertedId);
  const base = r2((Number(p['total-amount']) || 0) / 1.1);
  await O.updateObra(id, { presupuestosStel: [{ id: String(p.id), numero: ref, fecha: String(p.date || '').slice(0, 10), cliente: c.name || '', base: r2(p['total-amount-without-taxes'] || p.base || base), total: r2(p['total-amount']), estado: 'Aceptado' }] }).catch(() => {});
  return db.collection('obras').findOne({ _id: oid(id) });
}

async function _prt(ref) {
  const S = require('./stelorder');
  const n = 'PRT' + String((String(ref || '').match(/\d{3,5}/) || [''])[0]).padStart(5, '0');
  const p = (await S.getWorkEstimates()).find(e => e['full-reference'] === n || String(e.id) === String(ref));
  if (!p) throw new Error(`No encuentro el ${n} en StelOrder`);
  return p;
}

// ── 1. Generar la lista (una por PRT; regenerar=true la rehace conservando lo ya tachado a mano) ──
async function generar({ prt, regenerar = false } = {}, por = '', { _ia: ia = null, _db = null, _p = null, _obra = null } = {}) {
  const db = _db || await getDB();
  const p = _p || await _prt(prt);
  const prev = await db.collection(COL).findOne({ 'prt.id': String(p.id) });
  if (prev && !regenerar) return prev;
  const obra = _obra || await _obraDe(db, p, por);
  const out = await (ia || _ia)(promptLista(p, obra), HERR_LISTA);
  const items = (out.materiales || []).filter(m => m && m.material && Number(m.cantidad) > 0).slice(0, 60).map((m, i) => {
    const antes = prev && prev.items.find(x => x.material === m.material);
    return { id: `m${i + 1}`, material: corto(m.material, 120), cantidad: r2(m.cantidad), unidad: corto(m.unidad || 'ud', 20), partida: corto(m.partida, 120) || null, calculo: corto(m.calculo, 160) || null, critico: !!m.critico,
      tenemos: antes ? antes.tenemos : 0, ok: antes ? !!antes.ok : false, fuentes: antes ? antes.fuentes : [] };
  });
  const doc = { obraId: String(obra._id), obraRef: obra.reference, cliente: obra.clientName || null, direccion: obra.address || null,
    prt: { id: String(p.id), numero: p['full-reference'], titulo: p.title || null, total: r2(p['total-amount']), accountId: String(p['account-id'] || '') },
    resumen: corto(out.resumen, 300), items, herramientas: (out.herramientas || []).slice(0, 25).map(x => corto(x, 100)), epis: (out.epis || []).slice(0, 15).map(x => corto(x, 100)),
    medios: (out.medios || []).slice(0, 10).map(x => corto(x, 160)), instrucciones: (out.instrucciones || []).slice(0, 25).map(x => corto(x, 400)), avisos: (out.avisos || []).slice(0, 10).map(x => corto(x, 300)),
    personas: Number(out.personas) || null, jornadas: Number(out.jornadas) || null,
    estado: 'comprando', comprasVistas: prev ? prev.comprasVistas || [] : [], creadoPor: por, actualizado: new Date(), ...(prev ? {} : { creado: new Date() }) };
  if (prev) await db.collection(COL).updateOne({ _id: prev._id }, { $set: doc });
  else doc._id = (await db.collection(COL).insertOne(doc)).insertedId;
  return prev ? { ...prev, ...doc } : doc;
}

// ── 2. Cruzar con las compras de la obra ──
const completa = l => l.items.length > 0 && l.items.every(i => i.ok || (i.tenemos || 0) >= i.cantidad - 1e-9);

async function cruzar(listaId, { _ia: ia = null, _db = null, avisar = true } = {}) {
  const db = _db || await getDB();
  const l = await db.collection(COL).findOne({ _id: oid(listaId) });
  if (!l || l.estado !== 'comprando') return l;
  const vistas = new Set(l.comprasVistas || []);
  const compras = await db.collection('compras').find({ obraId: l.obraId, estado: { $nin: ['descartada', 'duplicada'] } }, { projection: { proveedor: 1, fecha: 1, lineas: 1 } }).toArray();
  let cambios = 0;
  for (const c of compras.filter(c => !vistas.has(String(c._id)))) {
    if (completa(l)) break;
    let r = { cubre: [] };
    try { r = await (ia || _ia)(promptCruce(l, c), HERR_CRUCE, 800); } catch (e) { console.warn('[Materiales] cruce:', e.message); continue; }
    for (const x of r.cubre || []) {
      const it = l.items.find(i => i.id === x.item); if (!it || !(Number(x.cantidad) > 0)) continue;
      it.tenemos = r2((it.tenemos || 0) + Number(x.cantidad));
      it.fuentes = [...(it.fuentes || []), { compraId: String(c._id), proveedor: c.proveedor || null, fecha: c.fecha || null, linea: corto(x.linea, 120) || null, cantidad: r2(x.cantidad) }].slice(-10);
      cambios++;
    }
    vistas.add(String(c._id));
  }
  const set = { items: l.items, comprasVistas: [...vistas], actualizado: new Date() };
  if (completa(l)) Object.assign(set, { estado: 'completa', completaAt: new Date() });
  await db.collection(COL).updateOne({ _id: l._id }, { $set: set });
  const nueva = { ...l, ...set };
  if (set.estado === 'completa' && avisar) { try { await alCompletar(nueva); } catch (e) { console.warn('[Materiales] al completar:', e.message); } }
  return { ...nueva, cambios };
}

// Tachar a mano (panel de la obra o Corpy): ok=true lo da por tenido; tenemos=n pone la cantidad.
async function marcar(listaId, itemId, { ok = null, tenemos = null } = {}, por = '', { _db = null, avisar = true } = {}) {
  const db = _db || await getDB();
  const l = await db.collection(COL).findOne({ _id: oid(listaId) });
  if (!l) throw new Error('No encuentro la lista');
  const it = l.items.find(i => i.id === String(itemId)); if (!it) throw new Error('No encuentro ese material');
  if (ok != null) it.ok = !!ok;
  if (tenemos != null && Number(tenemos) >= 0) it.tenemos = r2(tenemos);
  it.marcadoPor = por; it.marcadoAt = new Date();
  const set = { items: l.items, actualizado: new Date() };
  const antes = l.estado;
  if (l.estado === 'comprando' && completa(l)) Object.assign(set, { estado: 'completa', completaAt: new Date() });
  if (l.estado === 'completa' && !completa(l)) Object.assign(set, { estado: 'comprando', completaAt: null });
  await db.collection(COL).updateOne({ _id: l._id }, { $set: set });
  const nueva = { ...l, ...set };
  if (antes === 'comprando' && set.estado === 'completa' && avisar) { try { await alCompletar(nueva); } catch (e) { console.warn('[Materiales] al completar:', e.message); } }
  return nueva;
}

// ── 3. Material completo → «¿Quién va?» con la petición del trabajo ──
function textoTrabajo(l) {
  return [`${l.resumen || l.prt.titulo || 'Trabajo'} (${l.prt.numero}, aceptado). Material comprado.`,
    l.medios.length ? `Medios: ${l.medios.join('; ')}.` : '',
    l.instrucciones.length ? `Pasos: ${l.instrucciones.map((x, i) => `${i + 1}) ${x}`).join(' ')}` : '',
    l.avisos.length ? `Ojo: ${l.avisos.join(' ')}` : ''].filter(Boolean).join('\n');
}

async function alCompletar(l, { _db = null, _preguntar = null } = {}) {
  const db = _db || await getDB();
  if (l.peticionId) return null;
  const pet = { jid: 'materiales', grupo: null, fuente: 'materiales', origen: 'materiales', listaId: String(l._id), obraId: l.obraId,
    tipo: 'trabajo', estado: 'pendiente', urgente: false, cliente: l.cliente || l.obraRef, clienteStel: l.cliente || null, clienteId: l.prt.accountId || null,
    direccion: l.direccion || null, contacto: null, titulo: corto(l.prt.titulo || l.resumen, 60), resumen: corto(textoTrabajo(l), 1800), fotoIds: [], archivos: [],
    mensajes: [{ fecha: new Date(), quien: 'Corpy', texto: `Material completo para ${l.prt.numero} (${l.obraRef}).` }], fecha: new Date(), quien: 'Corpy', creado: new Date() };
  const r = await db.collection('peticionesGrupo').insertOne(pet); pet._id = r.insertedId;
  await db.collection(COL).updateOne({ _id: l._id }, { $set: { peticionId: String(pet._id) } });
  await (_preguntar || require('./trabajosSeguimiento').preguntarQuien)({ ...pet, resumen: `✅ Material completo de *${l.obraRef}* (${l.prt.numero}).\n${l.resumen || ''}${l.jornadas ? `\nPrevisión: ${num(l.jornadas)} jornada${l.jornadas > 1 ? 's' : ''}${l.personas ? ` · ${l.personas} personas` : ''}.` : ''}` });
  return pet;
}

// Al operario, cuando se le asigna el trabajo (trabajos.crear): el PDF del parte con las instrucciones.
async function pdfParaPeticion(peticionId) {
  const db = await getDB();
  const l = await db.collection(COL).findOne({ peticionId: String(peticionId) });
  if (!l) return null;
  return { nombre: `Parte ${corto(l.obraRef, 40).replace(/[\\/:*?"<>|]/g, '')}.pdf`, data: await pdf(l, { parte: true }) };
}

// ── PDF: «Lista de compra» (con lo que falta) o «Parte de trabajo» (con las instrucciones delante) ──
async function pdf(l, { parte = false } = {}) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const { limpio } = require('./planificacionPdf');
  const doc = await PDFDocument.create();
  const F = await doc.embedFont(StandardFonts.Helvetica), FB = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595, H = 842, M = 40;
  const C = { tinta: rgb(0.13, 0.15, 0.18), gris: rgb(0.45, 0.47, 0.5), linea: rgb(0.86, 0.87, 0.89), verde: rgb(0.18, 0.62, 0.38), rojo: rgb(0.85, 0.26, 0.24), fondo: rgb(0.965, 0.97, 0.975) };
  let pg, y;
  const lineas = (t, f, s, w) => { const out = []; let cur = ''; for (const pal of limpio(t).split(' ')) { const p2 = cur ? cur + ' ' + pal : pal; if (f.widthOfTextAtSize(p2, s) > w && cur) { out.push(cur); cur = pal; } else cur = p2; } if (cur) out.push(cur); return out; };
  const nueva = () => { pg = doc.addPage([W, H]); y = H - M; pg.drawText(limpio(`Corp Projects · ${parte ? 'Parte de trabajo' : 'Lista de compra'}`), { x: M, y: y - 4, size: 9, font: F, color: C.gris }); y -= 24; };
  const sitio = h => { if (y - h < M) nueva(); };
  const parrafo = (t, { s = 9.5, f = F, c = C.tinta, x = M, w = W - 2 * M, gap = 3 } = {}) => { for (const ln of lineas(t, f, s, w)) { sitio(s + gap); pg.drawText(ln, { x, y, size: s, font: f, color: c }); y -= s + gap; } };
  const titulo = t => { y -= 8; sitio(30); pg.drawText(limpio(t), { x: M, y, size: 12, font: FB, color: C.tinta }); y -= 6; pg.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: C.linea }); y -= 14; };
  nueva();
  parrafo(l.obraRef, { s: 16, f: FB, gap: 5 });
  parrafo(`${l.prt.numero}${l.prt.titulo ? ' · ' + l.prt.titulo : ''}${l.direccion ? ' · ' + l.direccion : ''}`, { c: C.gris });
  if (l.resumen) { y -= 4; parrafo(l.resumen, { s: 10.5 }); }
  if (l.jornadas || l.personas) parrafo(`Previsión: ${l.jornadas ? num(l.jornadas) + ' jornadas' : ''}${l.personas ? ` · ${l.personas} personas` : ''}`, { c: C.gris });

  const seccMateriales = () => {
    titulo(`Materiales (${l.items.filter(i => i.ok || (i.tenemos || 0) >= i.cantidad).length} de ${l.items.length} conseguidos)`);
    const X = { caja: M, mat: M + 18, cant: W - M - 150, ten: W - M - 75 };
    pg.drawText('Material', { x: X.mat, y, size: 8, font: FB, color: C.gris }); pg.drawText('Comprar', { x: X.cant, y, size: 8, font: FB, color: C.gris }); pg.drawText('Tenemos', { x: X.ten, y, size: 8, font: FB, color: C.gris }); y -= 12;
    for (const it of l.items) {
      const hecho = it.ok || (it.tenemos || 0) >= it.cantidad;
      const ls = lineas(it.material + (it.critico ? ' (imprescindible)' : ''), hecho ? F : FB, 9.5, X.cant - X.mat - 8);
      const sub = it.calculo ? lineas(it.calculo, F, 7.5, X.cant - X.mat - 8) : [];
      sitio(ls.length * 12 + sub.length * 10 + 6);
      pg.drawRectangle({ x: X.caja, y: y - 2, width: 10, height: 10, borderColor: C.tinta, borderWidth: 0.8, color: hecho ? C.verde : undefined });
      ls.forEach((t, i) => pg.drawText(t, { x: X.mat, y: y - i * 12, size: 9.5, font: hecho ? F : FB, color: hecho ? C.gris : C.tinta }));
      pg.drawText(limpio(`${num(it.cantidad)} ${it.unidad}`), { x: X.cant, y, size: 9.5, font: F, color: C.tinta });
      pg.drawText(limpio(it.ok ? 'sí' : it.tenemos ? `${num(it.tenemos)} ${it.unidad}` : '—'), { x: X.ten, y, size: 9.5, font: F, color: hecho ? C.verde : C.rojo });
      y -= ls.length * 12;
      sub.forEach(t => { pg.drawText(t, { x: X.mat, y, size: 7.5, font: F, color: C.gris }); y -= 10; });
      y -= 4;
    }
  };
  const lista = (t, xs) => { if (!xs || !xs.length) return; titulo(t); xs.forEach(x => parrafo(`• ${x}`)); };
  const pasos = () => { if (!l.instrucciones.length) return; titulo('Cómo se hace'); l.instrucciones.forEach((x, i) => parrafo(`${i + 1}. ${x}`)); };
  if (parte) { pasos(); lista('Medios', l.medios); lista('Herramientas', l.herramientas); lista('EPIs', l.epis); lista('Ojo', l.avisos); seccMateriales(); titulo('Al acabar'); parrafo('Haz fotos de antes y de después y rellena el parte en la app (horas, material gastado y si queda algo pendiente).'); }
  else { seccMateriales(); lista('Medios', l.medios); lista('Herramientas', l.herramientas); lista('EPIs', l.epis); lista('Ojo antes de comprar', l.avisos); pasos(); }
  return Buffer.from(await doc.save());
}

// Texto corto para WhatsApp.
function resumenTexto(l) {
  const falta = l.items.filter(i => !i.ok && (i.tenemos || 0) < i.cantidad);
  return `🧱 *Materiales de ${l.obraRef}* (${l.prt.numero})\n${l.resumen || ''}\n\n` +
    (falta.length ? `Falta comprar (${falta.length} de ${l.items.length}):\n${falta.slice(0, 20).map(i => `• ${num(Math.max(0, i.cantidad - (i.tenemos || 0)))} ${i.unidad} · ${i.material}${i.critico ? ' ⚠️' : ''}`).join('\n')}${falta.length > 20 ? '\n…' : ''}` : '✅ Está todo.') +
    `${l.medios.length ? `\n\nMedios: ${l.medios.join('; ')}` : ''}${l.avisos.length ? `\n\nOjo: ${l.avisos.slice(0, 3).join(' ')}` : ''}\n\nSe va tachando solo con las compras de la obra (y a mano en la obra → Materiales). Cuando esté todo, te pregunto quién va.`;
}

// PRT aceptado → lista + aviso a Álex con el PDF.
async function alAceptar(prt, por = '', { _enviar = null, _archivo = null } = {}) {
  if (apagado()) return null;
  const l = await generar({ prt }, por);
  let c = l; try { c = await cruzar(String(l._id), { avisar: true }); } catch (e) {}
  const N = require('./notifications');
  try { await (_enviar || N.sendWhatsApp)(resumenTexto(c)); } catch (e) {}
  try { await (_archivo || require('./canalWhatsapp').enviarArchivo)(N.destinoDueno(), `🧱 Lista de compra · ${corto(c.obraRef, 40)}`, { data: await pdf(c), mime: 'application/pdf', nombre: `Lista de compra ${corto(c.obraRef, 40).replace(/[\\/:*?"<>|]/g, '')}.pdf` }); } catch (e) { console.warn('[Materiales] PDF a Álex:', e.message); }
  return c;
}

// Cron: PRT aceptados en StelOrder (desde DESDE) sin lista → alAceptar; y las listas abiertas se cruzan con las compras.
async function revisar({ _db = null } = {}) {
  if (apagado()) return { nuevas: 0, cruzadas: 0 };
  const db = _db || await getDB();
  let nuevas = 0, cruzadas = 0;
  try {
    const W = await require('./stelorder').getWorkEstimates();
    const hechas = new Set((await db.collection(COL).find({}, { projection: { 'prt.id': 1 } }).toArray()).map(x => x.prt.id));
    const ac = W.filter(e => Number(e['document-state-id']) === ESTADO_ACEPTADO && String(e['utc-last-modification-date'] || e.date || '').slice(0, 10) >= DESDE && !hechas.has(String(e.id)));
    for (const p of ac.slice(0, 3)) { try { await alAceptar(p['full-reference'], 'StelOrder (aceptado)'); nuevas++; } catch (e) { console.warn('[Materiales] alAceptar', p['full-reference'], e.message); } }
  } catch (e) { console.warn('[Materiales] PRT aceptados:', e.message); }
  for (const l of await db.collection(COL).find({ estado: 'comprando' }).toArray()) { try { const r = await cruzar(String(l._id)); if (r && r.cambios) cruzadas++; } catch (e) { console.warn('[Materiales] cruzar:', e.message); } }
  return { nuevas, cruzadas };
}

async function deObra(obraId, { _db = null } = {}) {
  const db = _db || await getDB();
  return db.collection(COL).find({ obraId: String(obraId) }).sort({ creado: -1 }).toArray();
}

module.exports = { generar, cruzar, marcar, alAceptar, alCompletar, revisar, deObra, pdf, pdfParaPeticion, resumenTexto, textoTrabajo, completa, _promptLista: promptLista, COL };
