// src/colaTrabajos.js — COLA DE TRABAJOS ACEPTADOS (4/11/2026, Álex: «de los aceptados, que se vayan poniendo en cola
// para que se vayan haciendo… sincronizar con la grúa y que nos vaya recordando cuando iremos a hacer lo de los pinchos,
// o que está pendiente»).
// Cada presupuesto aceptado tiene su lista de materiales (materialesObra.js). La cola es esa lista más el campo `cola`:
//   · fecha prevista: la del trabajo si ya está mandado con día; si no, la que digan Álex o Alfonso (va al calendario),
//   · medio: grúa o plataforma (se alquilan → hay que reservarlas), andamio, escalera; si no se dice, sale de la lista,
//   · hecho: a mano, o solo cuando el parte del pedido dice «acabado».
// Pasos: 🛒 comprando material → 👷 por programar (falta quién o cuándo) → 📅 programado → ✅ hecho.
// Aviso L-V 9:10 a Álex con lo que pide algo (grúa sin reservar a 5 días o menos, día pasado sin parte, material
// completo sin programar, trabajos con grúa que se pueden juntar). El lunes, la cola entera. COLA_TRABAJOS=off lo apaga.
'use strict';

const { ObjectId } = require('mongodb');
const TZ = 'Europe/Madrid';
const COL = 'listasMateriales';
const HECHOS_DIAS = 15;
async function getDB() { return require('./db').getDB(); }
const hoyStr = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const ymd = x => { if (!x) return null; if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x)) return x.slice(0, 10); const d = new Date(x); return isNaN(d) ? null : d.toLocaleDateString('en-CA', { timeZone: TZ }); };
const entre = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const color = (d, [ambar, rojo]) => d >= rojo ? 'rojo' : d >= ambar ? 'ambar' : 'verde';
const corto = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const fechaTxt = (f, hoy = hoyStr()) => { if (!f) return ''; const d = entre(hoy, f); if (d === 0) return 'hoy'; if (d === 1) return 'mañana'; if (d === -1) return 'ayer'; const x = new Date(f + 'T12:00:00Z'); return `${DIAS[x.getUTCDay()]} ${x.getUTCDate()}/${x.getUTCMonth() + 1}`; };
// «para hoy», «para mañana», «para el jueves 12/11».
const cuando = (f, hoy = hoyStr()) => { const t = fechaTxt(f, hoy); return /^(hoy|mañana|ayer)$/.test(t) ? t : 'el ' + t; };
const apagado = () => process.env.COLA_TRABAJOS === 'off';

const MEDIOS = {
  grua: { txt: 'camión grúa', corto: 'grúa', icono: '🏗️', alquiler: true },
  plataforma: { txt: 'plataforma elevadora', corto: 'plataforma', icono: '🏗️', alquiler: true },
  andamio: { txt: 'andamio', icono: '🪜', alquiler: false },
  escalera: { txt: 'escalera', icono: '🪜', alquiler: false },
  ninguno: { txt: 'sin medios especiales', icono: '', alquiler: false },
};
// Lo que diga Álex manda; si no, la nota de Álex de la lista y después los medios que sacó la IA.
function medioDe(l) {
  if (l.cola && MEDIOS[l.cola.medio]) return l.cola.medio;
  for (const t of [l.nota || '', (l.medios || []).join(' · ')]) {
    const n = String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (/\bgrua\b|camion pluma|\bpluma\b/.test(n)) return 'grua';
    if (/plataforma|elevador|tijera|articulada/.test(n)) return 'plataforma';
    if (/andamio/.test(n)) return 'andamio';
    if (/escalera/.test(n)) return 'escalera';
  }
  return null;
}

const faltan = l => (l.items || []).filter(i => !i.ok && (i.tenemos || 0) < i.cantidad);

// Una tarjeta de la cola, sin tocar la base (para el tablero, los avisos y las pruebas).
// pet = la petición del trabajo (cuando el material está completo); asig = su asignación (pedido, operario, día).
function tarjeta(l, { pet = null, asig = null, acabado = false, hoy = hoyStr() } = {}) {
  const c = l.cola || {};
  const medio = medioDe(l);
  const M = MEDIOS[medio] || null;
  const fecha = (asig && asig.fecha) || (pet && pet.asignado && pet.asignado.fecha) || c.fecha || null;
  const hora = (asig && asig.fecha ? asig.hora : null) || (pet && pet.asignado && pet.asignado.fecha ? pet.asignado.hora : null) || c.hora || null;
  const operario = (asig && asig.userName) || (pet && pet.asignado && pet.asignado.nombre) || null;
  const equipo = (asig && asig.equipo) || (pet && pet.asignado && pet.asignado.equipo) || [];
  const hecho = !!c.hecho || acabado;
  const f = faltan(l);
  const alertas = [];
  let paso, dias = 0, semaforo = 'verde', etiqueta;
  const dHasta = fecha ? entre(hoy, fecha) : null;
  const sinReservar = !!(M && M.alquiler && !c.reservado);
  if (hecho) {
    paso = 'hecho'; dias = Math.max(0, entre(ymd(c.hechoAt) || hoy, hoy)); etiqueta = acabado && !c.hecho ? 'parte acabado' : 'hecho';
  } else if (l.estado === 'comprando') {
    paso = 'materiales'; dias = Math.max(0, entre(ymd(l.creado) || hoy, hoy)); semaforo = color(dias, [7, 14]);
    const aMedias = f.filter(i => (i.tenemos || 0) > 0).length;
    etiqueta = `${f.length} de ${(l.items || []).length} materiales por comprar${aMedias ? ` (${aMedias} a medias)` : ''}`;
    if (fecha && dHasta <= 3) { semaforo = 'rojo'; alertas.push(`🛒 Faltan ${f.length} materiales y ${dHasta < 0 ? 'era' : 'es'} ${cuando(fecha, hoy)}`); }
    else if (dias >= 7) alertas.push(`🛒 ${f.length} materiales por comprar desde hace ${dias} días`);
  } else if (!operario || !fecha) {
    paso = 'programar'; dias = Math.max(0, entre(ymd(l.completaAt) || hoy, hoy)); semaforo = color(dias, [2, 5]);
    etiqueta = !operario ? (fecha ? `material listo · falta quién va (previsto ${fechaTxt(fecha, hoy)})` : 'material listo · falta quién va') : 'falta el día';
    if (dias >= 2) alertas.push(`👷 Material completo hace ${dias} días; falta ${!operario ? 'decir quién va' : 'el día'}`);
  } else {
    paso = 'programado';
    etiqueta = `${fechaTxt(fecha, hoy)}${hora ? ' a las ' + hora : ''}`;
    if (dHasta < 0) { dias = -dHasta; semaforo = dias >= 2 ? 'rojo' : 'ambar'; etiqueta = `era ${etiqueta} · ¿se hizo?`; alertas.push(`❓ ¿Se hizo? Era ${cuando(fecha, hoy)} y no hay parte acabado`); }
  }
  // La grúa o la plataforma, con día y sin reservar: ámbar a 5 días, rojo a 2 (también si aún falta material).
  if (!hecho && fecha && dHasta >= 0 && sinReservar) {
    if (dHasta <= 2) semaforo = 'rojo'; else if (dHasta <= 5 && semaforo === 'verde') semaforo = 'ambar';
    if (dHasta <= 5) alertas.unshift(`📞 Reservar la ${M.corto} para ${cuando(fecha, hoy)}`);
  }
  return {
    id: 'cola:' + l._id, listaId: String(l._id), obraId: l.obraId, cola: true, col: 'q-' + paso, paso, dias, semaforo, etiqueta,
    ref: l.prt && l.prt.numero, cliente: l.obraRef || l.cliente, direccion: l.direccion || null, que: corto(l.resumen || (l.prt && l.prt.titulo), 160),
    importe: (l.prt && l.prt.total) || 0, fecha, hora, operario, equipo, pedidoRef: (asig && asig.pedidoRef) || (pet && pet.pedido && pet.pedido.ref) || null,
    pedidoId: (pet && pet.pedido && pet.pedido.id) || null, medio, medioTxt: M ? M.txt : null, alquiler: !!(M && M.alquiler), reservado: !!c.reservado,
    proveedorMedio: c.proveedorMedio || null, nota: c.nota || null, faltan: f.length, items: (l.items || []).length, hecho, alertas,
    asignado: !!operario, fechaCola: c.fecha || null,
  };
}

// Trabajos con grúa (o plataforma) sin reservar: si hay dos o más, se pueden juntar el mismo día y pagar una sola.
function sugerencias(ts, hoy = hoyStr()) {
  const out = [];
  for (const m of ['grua', 'plataforma']) {
    const l = ts.filter(t => !t.hecho && t.medio === m && !t.reservado);
    if (l.length < 2) continue;
    const conDia = l.filter(t => t.fecha);
    out.push(`${MEDIOS[m].icono} Hay ${l.length} trabajos con ${MEDIOS[m].txt} sin reservar: ${l.map(t => `${corto(t.cliente, 40)}${t.fecha ? ` (${fechaTxt(t.fecha, hoy)})` : ''}`).join(', ')}. ${conDia.length >= 2 && new Set(conDia.map(t => t.fecha)).size === 1 ? 'Ya caen el mismo día: una sola reserva.' : 'Si se hacen el mismo día, una sola reserva.'}`);
  }
  return out;
}

async function _cargar(db, { hoy = hoyStr() } = {}) {
  const desde = new Date(Date.now() - HECHOS_DIAS * 86400000);
  const listas = await db.collection(COL).find({ $or: [{ 'cola.hecho': { $ne: true } }, { 'cola.hechoAt': { $gte: desde } }] }).toArray();
  const petIds = listas.map(l => l.peticionId).filter(x => x && ObjectId.isValid(x)).map(x => new ObjectId(x));
  const pets = petIds.length ? await db.collection('peticionesGrupo').find({ _id: { $in: petIds } }).toArray() : [];
  const petDe = new Map(pets.map(p => [String(p._id), p]));
  const asigs = petIds.length ? await db.collection('workOrderAssignments').find({ peticionId: { $in: petIds.map(String) } }).toArray() : [];
  const asigDe = new Map(asigs.map(a => [String(a.peticionId), a]));
  const woIds = pets.map(p => p.pedido && String(p.pedido.id)).filter(Boolean);
  const acabados = new Set(woIds.length ? (await db.collection('partes').find({ workOrderId: { $in: woIds }, estadoTrabajo: 'completado' }, { projection: { workOrderId: 1 } }).toArray()).map(p => String(p.workOrderId)) : []);
  const ts = [];
  for (const l of listas) {
    const pet = l.peticionId ? petDe.get(String(l.peticionId)) || null : null;
    const acabado = !!(pet && pet.pedido && acabados.has(String(pet.pedido.id)));
    if (acabado && !(l.cola && l.cola.hecho)) await db.collection(COL).updateOne({ _id: l._id }, { $set: { 'cola.hecho': true, 'cola.hechoAt': new Date(), 'cola.hechoPor': 'parte acabado' } }).catch(() => {});
    ts.push(tarjeta(l, { pet, asig: l.peticionId ? asigDe.get(String(l.peticionId)) || null : null, acabado, hoy }));
  }
  return ts;
}

const PASOS = [
  ['materiales', '🛒 Comprando material', 'Se tacha solo con las compras de la obra'],
  ['programar', '👷 Por programar', 'Material listo: falta quién va o el día'],
  ['programado', '📅 Programado', 'Con día; grúa o plataforma, reservada'],
  ['hecho', '✅ Hecho', `Últimos ${HECHOS_DIAS} días`],
];
async function datos({ _db = null } = {}) {
  const db = _db || await getDB();
  const hoy = hoyStr();
  const ts = await _cargar(db, { hoy });
  const orden = { rojo: 0, ambar: 1, verde: 2 };
  const columnas = PASOS.map(([k, titulo, ayuda]) => {
    const l = ts.filter(t => t.paso === k).sort((a, b) => k === 'programado' ? String(a.fecha).localeCompare(String(b.fecha)) : (orden[a.semaforo] - orden[b.semaforo]) || (b.dias - a.dias));
    return { k: 'q-' + k, titulo, ayuda, tarjetas: l, total: l.length, rojos: l.filter(t => t.semaforo === 'rojo').length, ambar: l.filter(t => t.semaforo === 'ambar').length, importe: Math.round(l.reduce((s, t) => s + (Number(t.importe) || 0), 0) * 100) / 100 };
  });
  return { hoy, columnas, sugerencias: sugerencias(ts, hoy), medios: Object.fromEntries(Object.entries(MEDIOS).map(([k, v]) => [k, v.txt])) };
}

// ── Cambiar un trabajo de la cola (panel, Corpy de Álex o de Alfonso) ──
// fecha/hora: si ya está mandado al operario se cambia su cita (trabajos.fijarCita); si no, va al calendario.
async function actualizar(listaId, { fecha, hora, medio, reservado, proveedorMedio, hecho, nota } = {}, por = '', { _db = null, _cal = null, _fijar = null } = {}) {
  const db = _db || await getDB();
  const l = await db.collection(COL).findOne({ _id: new ObjectId(String(listaId)) });
  if (!l) throw new Error('No encuentro ese trabajo en la cola');
  const c = { ...(l.cola || {}) };
  const set = {};
  const cambios = [];
  let pet = null;
  if (l.peticionId && ObjectId.isValid(l.peticionId)) pet = await db.collection('peticionesGrupo').findOne({ _id: new ObjectId(l.peticionId) });
  // El mismo día y hora que ya tiene (el panel siempre los manda): no se toca ni la cita ni el calendario.
  const ahora = tarjeta(l, { pet });
  if (fecha !== undefined && (fecha || null) === (ahora.fecha || null) && (!fecha || (hora || null) === (ahora.hora || null))) fecha = undefined;
  if (fecha !== undefined) {
    if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(String(fecha))) throw new Error('El día no se entiende');
    if (hora && !/^\d{1,2}:\d{2}$/.test(String(hora))) throw new Error('La hora no se entiende');
    c.fecha = fecha || null; c.hora = fecha ? (hora || null) : null;
    cambios.push(fecha ? `📅 ${fechaTxt(fecha)}${hora ? ' a las ' + hora : ''}` : '📅 sin día');
  }
  if (medio !== undefined && medio !== null) {
    if (!MEDIOS[medio]) throw new Error('Medio desconocido');
    if (c.medio !== medio) { c.medio = medio; c.reservado = false; }
    cambios.push(`${MEDIOS[medio].icono} ${MEDIOS[medio].txt}`.trim());
  }
  if (reservado !== undefined && reservado !== null) { c.reservado = !!reservado; cambios.push(reservado ? '✅ reservada' : 'sin reservar'); }
  if (proveedorMedio) c.proveedorMedio = corto(proveedorMedio, 60);
  if (nota !== undefined && nota !== null) c.nota = corto(nota, 300) || null;
  if (hecho !== undefined && hecho !== null) { c.hecho = !!hecho; c.hechoAt = hecho ? new Date() : null; c.hechoPor = hecho ? por : null; cambios.push(hecho ? '✅ hecho' : 'vuelve a la cola'); }
  c.por = por; c.at = new Date();

  // El día: al trabajo ya mandado (su cita y su planificación) o al calendario mientras no lo esté.
  if (fecha !== undefined) {
    const cal = _cal || require('./calendar');
    if (c.eventoId) { try { await cal.deleteEvent(c.eventoId); } catch (e) {} c.eventoId = null; }
    if (fecha && pet && pet.pedido && pet.pedido.id) {
      try { await (_fijar || require('./trabajos').fijarCita)(String(pet.pedido.id), { fecha, hora: hora || null }, por); } catch (e) { console.warn('[Cola] cita del trabajo:', e.message); }
    } else if (fecha) {
      const M = MEDIOS[c.medio || medioDe(l)];
      try { c.eventoId = await cal.crearEventoPersonal({ date: fecha, hora: hora || null, titulo: `${l.obraRef}${l.prt ? ' · ' + l.prt.numero : ''}${M && M.alquiler ? ' (' + M.txt + ')' : ''}`, lugar: l.direccion || null, nota: `Trabajo aceptado en cola: ${l.resumen || ''}` }); }
      catch (e) { console.warn('[Cola] calendario:', e.message); }
    }
  }
  set.cola = c;
  await db.collection(COL).updateOne({ _id: l._id }, { $set: set });
  const t = tarjeta({ ...l, cola: c }, { pet });
  return { ok: true, tarjeta: t, cambios };
}

// Buscar un trabajo de la cola por obra, cliente, calle o PRT («Cartagena», «la farmacia», «876»).
async function buscar(texto, { _db = null, conHechos = false } = {}) {
  const db = _db || await getDB();
  const q = conHechos ? {} : { 'cola.hecho': { $ne: true } };
  const ls = await db.collection(COL).find(q).toArray();
  const n = (String(texto || '').match(/\b(?:prt)?\s*0*(\d{3,5})\b/i) || [])[1];
  if (n) { const x = ls.filter(l => l.prt && Number(String(l.prt.numero).replace(/\D/g, '')) === Number(n)); if (x.length) return x; }
  const P = require('./agenteExtra')._puntos;
  // El nombre de la obra pesa más que la dirección o el resumen (dos trabajos de pinchos no deben empatar).
  const c = ls.map(l => ({ l, p: 2 * Math.max(0, P([l.obraRef, l.cliente].join(' '), texto)) + Math.max(0, P([l.direccion, l.prt && l.prt.titulo, l.resumen].join(' '), texto)) })).filter(x => x.p >= 1).sort((a, b) => b.p - a.p);
  if (!c.length) return [];
  return c.filter(x => x.p === c[0].p).map(x => x.l);
}

// ── Textos de WhatsApp ──
const lineaT = (t, hoy) => `• *${corto(t.cliente, 45)}* (${t.ref}) · ${t.etiqueta}${t.medio && MEDIOS[t.medio].alquiler ? ` · ${MEDIOS[t.medio].txt}${t.reservado ? ' reservada' : ' *sin reservar*'}` : t.medioTxt && t.medio !== 'ninguno' ? ` · ${t.medioTxt}` : ''}${t.operario ? ` · 👷 ${t.operario}${t.equipo.length ? ' +' + t.equipo.length : ''}` : ''}`;
function textoCola(d, { completo = true } = {}) {
  const hoy = d.hoy;
  const vivos = d.columnas.filter(c => c.k !== 'q-hecho');
  const n = vivos.reduce((s, c) => s + c.total, 0);
  if (!n) return '🧱 No hay trabajos aceptados en cola.';
  const partes = [`🧱 *Cola de trabajos aceptados* (${n})`];
  for (const c of vivos) if (c.total) partes.push(`\n*${c.titulo}* (${c.total})\n${c.tarjetas.slice(0, completo ? 15 : 5).map(t => lineaT(t, hoy)).join('\n')}`);
  const al = vivos.flatMap(c => c.tarjetas).flatMap(t => t.alertas.map(a => `${a} — ${corto(t.cliente, 40)}`));
  if (al.length) partes.push(`\n*Pide algo:*\n${al.join('\n')}`);
  if (d.sugerencias.length) partes.push('\n' + d.sugerencias.join('\n'));
  return partes.join('\n');
}

// Aviso diario a Álex (L-V 9:10): solo si algo pide acción; el lunes, la cola entera.
async function avisoDiario({ _enviar = null, _db = null, lunes = null } = {}) {
  if (apagado()) return null;
  const d = await datos({ _db });
  const esLunes = lunes != null ? lunes : new Date().toLocaleDateString('en-US', { weekday: 'short', timeZone: TZ }) === 'Mon';
  const vivos = d.columnas.filter(c => c.k !== 'q-hecho').flatMap(c => c.tarjetas);
  const al = vivos.flatMap(t => t.alertas.map(a => `${a} — *${corto(t.cliente, 40)}* (${t.ref})`));
  let txt = null;
  if (esLunes && vivos.length) txt = textoCola(d) + '\n\nPara cambiarlo dímelo aquí: «Cartagena el martes con la grúa», «grúa de Cartagena reservada», «Creu 42 hecho».';
  else if (al.length || d.sugerencias.length) txt = `🧱 *Trabajos aceptados — hoy pide algo:*\n${al.join('\n')}${d.sugerencias.length ? (al.length ? '\n\n' : '') + d.sugerencias.join('\n') : ''}\n\nContesta aquí («grúa de Cartagena reservada», «Cartagena el jueves», «Creu 42 hecho») o en Obras → 🚦.`;
  if (!txt) return null;
  await (_enviar || require('./notifications').sendWhatsApp)(txt);
  return txt;
}

// ── Corpy (Álex y Alfonso): ver la cola o cambiar un trabajo ──
async function corpy(input = {}, por = '', deps = {}) {
  if (!input.trabajo) return textoCola(await datos(deps));
  const ls = await buscar(input.trabajo, { ...deps, conHechos: input.hecho === false });
  if (!ls.length) return { aclara: true, reply: `No encuentro «${input.trabajo}» en la cola de trabajos aceptados.` };
  if (ls.length > 1) return { aclara: true, reply: `¿Cuál? ${ls.slice(0, 5).map(l => `${corto(l.obraRef, 40)} (${l.prt.numero})`).join(' · ')}` };
  const cambio = {};
  for (const k of ['fecha', 'hora', 'medio', 'reservado', 'proveedorMedio', 'hecho', 'nota']) if (input[k] !== undefined && input[k] !== null && input[k] !== '') cambio[k] = input[k];
  if (cambio.hora && !cambio.fecha) { const l0 = ls[0]; cambio.fecha = (l0.cola && l0.cola.fecha) || undefined; if (!cambio.fecha) return { aclara: true, reply: '¿Qué día?' }; }
  if (!Object.keys(cambio).length) {
    const d = await datos(deps); const t = d.columnas.flatMap(c => c.tarjetas).find(x => x.listaId === String(ls[0]._id));
    return t ? `🧱 ${lineaT(t, d.hoy).slice(2)}${t.alertas.length ? '\n' + t.alertas.join('\n') : ''}` : `🧱 ${ls[0].obraRef}: hecho.`;
  }
  const r = await actualizar(String(ls[0]._id), cambio, por, deps);
  const t = r.tarjeta;
  return `🧱 *${corto(t.cliente, 50)}* (${t.ref}): ${r.cambios.join(' · ')}.${t.alquiler && t.fecha && !t.reservado && !t.hecho ? `\n📞 Falta reservar la ${MEDIOS[t.medio].corto}: te lo recuerdo hasta que me digas «reservada».` : ''}${t.paso === 'materiales' ? `\n🛒 Aún faltan ${t.faltan} materiales.` : ''}${t.fecha && !t.asignado && !t.hecho ? '\nEstá en el calendario; cuando esté todo el material te pregunto quién va.' : ''}`;
}

module.exports = { datos, actualizar, buscar, avisoDiario, corpy, textoCola, tarjeta, sugerencias, medioDe, MEDIOS, _fechaTxt: fechaTxt };
