// src/memoria.js — MEMORIA DE CORPY (2/11/2026). Álex: «que se acuerde de todo lo que tenemos, pero que en un grupo no
// salga información de algo que no toca»; «que tenga una secuencia de todo lo que se ha ido haciendo en cada sitio» y
// «si en el parking pusimos un fluorescente de 1,80 o de 1,60, que se acuerde». Casos que lo motivaron:
//   · Corpy repitió cada día que Javi no estaba de alta (su ficha de Incorporaciones seguía abierta) aunque ya cobraba
//     nómina de Eduard.
//   · En el grupo de CINC pidió el contacto de Joan Maragall 5º 3ª que ya se había dado («te lo he pasado antes»).
//
// Un HECHO es lo que una persona recordaría: «Joan Maragall 44-46 · 5º 3ª: contacto Josep Maria», «2/11 pidieron mirar
// la pérdida del patio de luces → no hay pérdida, óxido en los montantes», «Javi: de alta desde el 19/10 (Álex)».
//   memoria { sujeto:{tipo:'cliente'|'obra'|'persona'|'empresa', id, nombre}, sitio, clave, sitioClave, clienteId,
//             tipo, texto, datos, unico, fecha, fuente:{tipo, ref, jid, por}, ambito:'interno'|'cliente', jids:[],
//             vigente, sustituidoPor, creado, actualizado }
//   · tipo: contacto · aviso (lo que piden) · trabajo · resultado · material · presupuesto · estado · correccion · dato.
//   · `unico`: los hechos que solo pueden tener un valor (el contacto de un piso, «de alta», el estado de un PRT): el
//     nuevo SUSTITUYE al viejo (vigente:false + sustituidoPor). El resto (avisos, trabajos, materiales) se acumula y
//     forma la línea de tiempo del sitio. Una petición del grupo es UNA línea (fuente.ref = su id) que se va poniendo al día.
//   · ámbito: lo de personas, nóminas y dinero es «interno» y solo lo ve Álex (nunca va a un grupo ni a un trabajador).
//     Lo de un cliente es «cliente» y en un grupo solo sale si es de ese grupo (jids) o de un cliente de ese grupo.
// Lo que ya vive en otro sitio no se copia: los presupuestos de StelOrder se leen de la caché al consultar y las notas de
// comunidad (comunidadNotas) también.
'use strict';
const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const COL = 'memoria';
const TIPOS = ['contacto', 'aviso', 'trabajo', 'resultado', 'material', 'presupuesto', 'estado', 'correccion', 'dato'];
const n = s => String(s || '').toLowerCase().replace(/º/g, 'o').replace(/ª/g, 'a').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
const corto = (s, m) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, m);
const fmt = d => { const x = new Date(d); return isNaN(x) ? '' : x.toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: '2-digit' }); };
// Palabras que no distinguen un sitio de otro («Ctat. Prop. Joan Maragall» = «Joan Maragall»).
const GENERICAS = new Set(['ctat', 'cdad', 'prop', 'propietaris', 'propietarios', 'comunitat', 'comunidad', 'cp', 'de', 'del', 'la', 'el', 'los', 'las', 'les', 'en', 'y', 'i', 'sl', 'sa', 'slu', 'calle', 'carrer', 'c', 'cl', 'avda', 'av', 'piso', 'obra', 'casa', 'que', 'lo', 'a', 'al', 'un', 'una']);
const palabras = q => n(q).split(' ').filter(w => w.length >= 2 && !GENERICAS.has(w));
// Clave de un cliente o sitio: el id de StelOrder si lo hay; si no, sus palabras (sin «Ctat. Prop.»), ordenadas.
const claveDe = (id, nombre) => (id ? 'id:' + id : 'n:' + palabras(nombre).sort().join(' '));
const sitioClaveDe = s => palabras(s).join(' ');
// Cuánto encaja un texto con lo buscado (los números cuentan doble: «Rutlla 202» ≠ «Rutlla 70»), como agenteExtra.puntos.
function puntos(texto, q) {
  const t = ' ' + n(texto) + ' '; let p = 0;
  for (const w of palabras(q)) {
    if (/^\d+$/.test(w)) { if (new RegExp(`(^|[^0-9])${w}([^0-9]|$)`).test(t)) p += 2; }
    else if ((w.length >= 3 || /\d/.test(w)) && t.includes(' ' + w)) p += 1;   // «5o», «3a» (pisos) también cuentan
  }
  return p;
}

// ── ESCRIBIR ──────────────────────────────────────────────────────────────────────────────────────────────
// apuntar(h): guarda un hecho. Si trae `unico`, el anterior con la misma clave, sitio, tipo y unico deja de valer. Si
// trae fuente.ref, el mismo origen no se repite: se pone al día.
async function apuntar(h, { _db = null } = {}) {
  if (!h || !h.sujeto || !h.texto) throw new Error('Falta de qué es el hecho o qué dice');
  const tipo = TIPOS.includes(h.tipo) ? h.tipo : 'dato';
  const db = _db || await getDB(); const col = db.collection(COL);
  const sujeto = { tipo: h.sujeto.tipo || 'cliente', id: h.sujeto.id ? String(h.sujeto.id) : null, nombre: corto(h.sujeto.nombre, 120) };
  const doc = {
    sujeto, clave: claveDe(sujeto.id, sujeto.nombre), sitio: corto(h.sitio, 80) || null, sitioClave: sitioClaveDe(h.sitio),
    clienteId: h.clienteId ? String(h.clienteId) : (sujeto.tipo === 'cliente' && sujeto.id ? sujeto.id : null),
    tipo, texto: corto(h.texto, 600), datos: h.datos || null, unico: h.unico || null,
    fecha: h.fecha ? new Date(h.fecha) : new Date(), fuente: { tipo: 'manual', ...(h.fuente || {}) },
    ambito: h.ambito === 'cliente' ? 'cliente' : 'interno', jids: [...new Set((h.jids || []).filter(Boolean).map(String))],
    vigente: true, actualizado: new Date(),
  };
  // El mismo origen (una petición, un parte, un PRT) es la misma línea: se pone al día.
  if (doc.fuente.ref) {
    const ya = await col.findOne({ 'fuente.tipo': doc.fuente.tipo, 'fuente.ref': String(doc.fuente.ref), tipo, clave: doc.clave, sitioClave: doc.sitioClave });
    if (ya) {
      const set = { ...doc, jids: [...new Set([...(ya.jids || []), ...doc.jids])], fecha: ya.fecha };
      delete set.vigente;
      await col.updateOne({ _id: ya._id }, { $set: set });
      return { ...ya, ...set, actualizado: true };
    }
  }
  doc.creado = new Date();
  const r = await col.insertOne(doc); doc._id = r.insertedId;
  if (doc.unico) await col.updateMany({ _id: { $ne: doc._id }, clave: doc.clave, sitioClave: doc.sitioClave, tipo, unico: doc.unico, vigente: true },
    { $set: { vigente: false, sustituidoPor: doc._id, actualizado: new Date() } });
  return doc;
}

// Una petición de un grupo (peticionesGrupo) → la línea de tiempo de su sitio + su contacto. Todo de ámbito cliente y
// atado a ese grupo.
async function dePeticion(p, { _db = null } = {}) {
  if (!p || !p.cliente) return null;
  const sujeto = { tipo: 'cliente', id: p.clienteId || null, nombre: p.clienteStel || p.cliente };
  const base = { sujeto, sitio: p.direccion || null, ambito: 'cliente', jids: [p.jid], fuente: { tipo: 'grupo', ref: String(p._id), jid: p.jid, por: p.quien || null } };
  const out = [];
  if (p.contacto) out.push(await apuntar({ ...base, tipo: 'contacto', unico: 'contacto', texto: p.contacto, fecha: p.actualizado || p.fecha }, { _db }));
  const estado = p.presupuestoFirmado ? `${p.presupuestoFirmado.ref} aceptado` : p.estado === 'hecho' ? 'hecho' : p.estado === 'descartado' ? 'descartado' : null;
  const refs = [p.incidencia, p.presupuesto].filter(Boolean).join(', ');
  const texto = `${p.resumen}${p.queHacer ? ` → ${p.queHacer}` : ''}${refs ? ` (${refs})` : ''}${estado ? ` [${estado}]` : ''}`;
  out.push(await apuntar({ ...base, tipo: ['trabajo', 'queja'].includes(p.tipo) ? 'aviso' : p.tipo === 'presupuesto' ? 'presupuesto' : 'aviso', texto, fecha: p.fecha, datos: { tipo: p.tipo, incidencia: p.incidencia || null, presupuesto: p.presupuesto || null } }, { _db }));
  return out;
}

// Un parte de trabajo con material puesto → material del sitio (lo que se puso y dónde).
async function deParte(parte, { _db = null } = {}) {
  if (!parte || !parte.clientName) return null;
  const mats = (parte.materiales || []).map(m => typeof m === 'string' ? m : [m.cantidad, m.unidad, m.nombre || m.descripcion || m.material].filter(Boolean).join(' ')).filter(Boolean);
  if (parte.materialDetalle) mats.push(parte.materialDetalle);
  if (!mats.length) return null;
  return apuntar({ sujeto: { tipo: parte.obraId ? 'obra' : 'cliente', id: parte.obraId || null, nombre: parte.obraRef || parte.clientName }, tipo: 'material', ambito: 'cliente',
    texto: `${mats.join(', ')}${parte.description ? ` — ${corto(parte.description, 120)}` : ''} (${parte.workerName || 'parte'})`, fecha: parte.date ? parte.date + 'T12:00:00Z' : new Date(),
    fuente: { tipo: 'parte', ref: String(parte._id || parte.id || ''), por: parte.workerName || null } }, { _db });
}

// ── CORREGIR: Álex corrige a Corpy → se guarda el hecho Y se arregla el origen (para que no lo vuelva a decir) ──
async function _persona(nombre) {
  const P = require('./nominasPagos'); const us = await require('./users').getUsers(false);
  const q = n(nombre);
  let c = us.filter(u => P.esDe(q, u) || n(u.name) === q);
  if (!c.length) c = us.filter(u => n(u.name).split(' ')[0].startsWith(q.split(' ')[0]) && q.split(' ')[0].length >= 3);
  const act = c.filter(u => u.active !== false);
  return (act.length ? act : c);
}
async function corregir({ sobre, texto, tipo = 'correccion', sitio = null, por = 'Álex' } = {}, { _db = null, _cerrarAlta = null } = {}) {
  if (!sobre || !texto) throw new Error('¿Sobre qué o quién, y qué es lo correcto?');
  const hechos = [], arreglos = [];
  const t = n(texto);
  const personas = await _persona(sobre).catch(() => []);
  if (personas.length === 1) {
    const u = personas[0];
    const sujeto = { tipo: 'persona', id: String(u._id), nombre: u.name };
    // «Está de alta» → se cierra su ficha de alta abierta (Incorporaciones), que era la que hacía repetir el aviso.
    if (/\balta\b/.test(t) && !/\b(no|sin|falta)\b.*\balta\b/.test(t)) {
      hechos.push(await apuntar({ sujeto, tipo: 'estado', unico: 'alta', texto: `De alta en la Seguridad Social (${texto})`, ambito: 'interno', fuente: { tipo: 'correccion', por } }, { _db }));
      const db = _db || await getDB();
      const abiertas = await db.collection('incorporaciones').find({ userId: String(u._id), estado: 'abierta' }).toArray();
      for (const i of abiertas) { await (_cerrarAlta || ((id, p) => require('./incorporaciones').accion(id, 'hecha', p)))(String(i._id), `${por} (Corpy: ya está de alta)`); arreglos.push(`cerrada la ficha de alta de ${i.nombre}`); }
      return { hechos, arreglos, sujeto: u.name };
    }
    hechos.push(await apuntar({ sujeto, tipo: TIPOS.includes(tipo) ? tipo : 'correccion', unico: tipo === 'estado' ? 'estado' : null, texto, ambito: 'interno', fuente: { tipo: 'correccion', por } }, { _db }));
    return { hechos, arreglos, sujeto: u.name };
  }
  // Un cliente / comunidad (con piso o zona): contacto → también en sus peticiones abiertas.
  const sujeto = { tipo: 'cliente', id: null, nombre: sobre };
  const db = _db || await getDB();
  const pets = (await db.collection('peticionesGrupo').find({ estado: { $in: ['pendiente', 'archivo'] } }).sort({ fecha: -1 }).limit(400).toArray())
    .filter(p => puntos(`${p.cliente} ${p.clienteStel || ''}`, sobre) >= Math.max(1, palabras(sobre).length) && (!sitio || puntos(p.direccion || '', sitio) > 0));
  if (pets[0] && pets[0].clienteId) Object.assign(sujeto, { id: pets[0].clienteId, nombre: pets[0].clienteStel || pets[0].cliente });
  const jids = [...new Set(pets.map(p => p.jid))];
  hechos.push(await apuntar({ sujeto, sitio, tipo: TIPOS.includes(tipo) ? tipo : 'correccion', unico: tipo === 'contacto' ? 'contacto' : null, texto, ambito: 'cliente', jids, fuente: { tipo: 'correccion', por } }, { _db }));
  if (tipo === 'contacto') for (const p of pets.slice(0, 3)) { await db.collection('peticionesGrupo').updateOne({ _id: p._id }, { $set: { contacto: corto(texto, 120), actualizado: new Date() } }); arreglos.push(`contacto puesto en la petición «${corto(p.resumen, 60)}»`); }
  return { hechos, arreglos, sujeto: sujeto.nombre };
}

// ── CONSULTAR ─────────────────────────────────────────────────────────────────────────────────────────────
// consultar({ texto, paraGrupo, interno }) → los hechos que encajan con el texto (nombre de comunidad, persona, piso),
// la línea de tiempo de cada sitio, los presupuestos de StelOrder de ese cliente (de la caché) y sus notas de comunidad.
//   · paraGrupo = jid → solo ámbito cliente y solo lo de ese grupo o de clientes de ese grupo. Nunca lo interno.
//   · interno = false (un trabajador pregunta) → solo ámbito cliente.
async function _clientesDelGrupo(db, jid) {
  return new Set((await db.collection('peticionesGrupo').distinct('clienteId', { jid })).filter(Boolean).map(String));
}
async function consultar({ texto = '', paraGrupo = null, interno = true, limite = 40, conPresupuestos = true } = {}, { _db = null, _presupuestos = null } = {}) {
  const db = _db || await getDB();
  let l = await db.collection(COL).find({ vigente: true }).sort({ fecha: -1 }).limit(3000).toArray();
  if (paraGrupo) {
    const cli = await _clientesDelGrupo(db, paraGrupo);
    l = l.filter(h => h.ambito === 'cliente' && ((h.jids || []).includes(paraGrupo) || (h.clienteId && cli.has(h.clienteId))));
  } else if (!interno) l = l.filter(h => h.ambito === 'cliente');
  if (texto) {
    const conPts = l.map(h => ({ h, p: puntos(`${h.sujeto.nombre} ${h.sitio || ''}`, texto) })).filter(x => x.p > 0);
    const max = Math.max(0, ...conPts.map(x => x.p));
    // Si nombra varias cosas, valen las que más encajan (y las que encajan casi igual).
    l = conPts.filter(x => x.p >= Math.max(1, max - 1)).map(x => x.h);
  }
  // Las personas primero: «Ramón» es antes Ramón Domínguez que la calle Ramon Turró.
  l = [...l.filter(h => h.sujeto.tipo === 'persona'), ...l.filter(h => h.sujeto.tipo !== 'persona')].slice(0, limite);
  // Notas de comunidad (anadir_nota_comunidad) del mismo cliente.
  const notas = [];
  if (texto && !paraGrupo) {
    for (const c of await db.collection('comunidadNotas').find({}).limit(500).toArray()) {
      if (puntos(c.comunidad, texto) < Math.max(1, palabras(c.comunidad).length - 1)) continue;
      for (const x of (c.notas || []).slice(-10)) notas.push({ sujeto: { tipo: 'cliente', nombre: c.comunidad }, tipo: 'dato', texto: x.texto, fecha: x.ts, fuente: { tipo: 'nota' } });
    }
  }
  // Presupuestos del cliente (caché de StelOrder, sin llamadas nuevas si está fresca).
  const prts = [];
  const ids = [...new Set(l.map(h => h.clienteId).filter(Boolean))];
  if (conPresupuestos && interno && !paraGrupo && ids.length) {
    try {
      const est = await (_presupuestos || require('./stelorder').getWorkEstimates)();
      const EST = { 1120641: 'pendiente', 1120642: 'rechazado', 1120656: 'aceptado', 1120650: 'cerrado' };
      const lim = Date.now() - 200 * 864e5;
      for (const e of est || []) if (!e.deleted && ids.includes(String(e['account-id'])) && new Date(e.date).getTime() >= lim)
        prts.push({ ref: e['full-reference'], fecha: String(e.date).slice(0, 10), estado: EST[e['document-state-id']] || '?', titulo: e.title || '', total: e['total-amount'], clienteId: String(e['account-id']) });
    } catch (e) {}
  }
  return { hechos: l, notas, presupuestos: prts };
}

// Texto corto para meter en un prompt: agrupado por cliente y sitio, lo vigente (contacto, estado) y la línea de tiempo.
function resumen({ hechos = [], notas = [], presupuestos = [] } = {}, { max = 3500 } = {}) {
  const grupos = new Map();
  for (const h of [...hechos, ...notas]) {
    const k = `${h.sujeto.nombre}${h.sitio ? ' · ' + h.sitio : ''}`;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(h);
  }
  const lineas = [];
  for (const [k, hs] of grupos) {
    const fijos = hs.filter(h => h.unico).map(h => `${h.tipo === 'contacto' ? 'contacto' : h.unico}: ${h.texto}`);
    const tiempo = hs.filter(h => !h.unico).sort((a, b) => new Date(a.fecha) - new Date(b.fecha)).slice(-8).map(h => `${fmt(h.fecha)} ${h.tipo === 'material' ? 'material: ' : h.tipo === 'correccion' ? 'corregido: ' : ''}${corto(h.texto, 220)}`);
    lineas.push(`• ${k}${fijos.length ? ` — ${fijos.join(' · ')}` : ''}${tiempo.length ? '\n   ' + tiempo.join('\n   ') : ''}`);
  }
  if (presupuestos.length) lineas.push('Presupuestos: ' + presupuestos.slice(0, 12).map(p => `${p.ref} ${p.estado} ${corto(p.titulo, 50)} ${p.total} €`).join(' · '));
  return lineas.join('\n').slice(0, max);
}
async function paraPrompt(texto, opts = {}) {
  try { const r = await consultar({ texto, ...opts }); return resumen(r); } catch (e) { return ''; }
}

// Correcciones y estados vigentes recientes (para la revisión de la noche: lo que Álex ya aclaró manda).
async function vigentesRecientes({ dias = 45 } = {}, { _db = null } = {}) {
  const db = _db || await getDB();
  return (await db.collection(COL).find({ vigente: true, tipo: { $in: ['correccion', 'estado'] }, fecha: { $gte: new Date(Date.now() - dias * 864e5) } }).sort({ fecha: -1 }).limit(60).toArray())
    .map(h => ({ sobre: h.sujeto.nombre, sitio: h.sitio || null, que: h.texto, fecha: fmt(h.fecha) }));
}

// ── COMPROBAR ANTES DE AVISAR ─────────────────────────────────────────────────────────────────────────────
// Quien ya tiene una nómina de la gestoría en Personal está de alta: su ficha de Incorporaciones se cierra sola
// (2/11/2026: «Javier Huaca lleva 13 días sin el alta» cuando ya salía en la nómina de octubre de Eduard).
async function conNomina({ _db = null } = {}) {
  const db = _db || await getDB();
  return new Set((await db.collection('docsPersonal').distinct('userId', { tipo: 'nomina', estado: 'ok' })).filter(Boolean).map(String));
}
async function cerrarAltasConNomina({ por = 'Corpy (tiene nómina)', _db = null, _cerrar = null } = {}) {
  const db = _db || await getDB();
  const nom = await conNomina({ _db: db });
  const cerradas = [];
  for (const i of await db.collection('incorporaciones').find({ estado: 'abierta', userId: { $in: [...nom] } }).toArray()) {
    await (_cerrar || ((id, p) => require('./incorporaciones').accion(id, 'hecha', p)))(String(i._id), por);
    await apuntar({ sujeto: { tipo: 'persona', id: i.userId, nombre: i.nombre }, tipo: 'estado', unico: 'alta', texto: 'De alta: ya cobra nómina de la gestoría', ambito: 'interno', fuente: { tipo: 'nomina', ref: String(i._id) } }, { _db: db });
    cerradas.push(i.nombre);
  }
  return cerradas;
}
// Los socios (Álex, Alfonso) no van en nómina ni se les piden papeles de trabajador.
const SOCIOS = /^(alfonso|alex|álex)\b/i;
const esSocio = u => SOCIOS.test(String((u && (u.name || u.nombre)) || '').trim()) && !/doncell/i.test(String(u.name || u.nombre || ''));

// Siembra inicial: todas las peticiones de los grupos (contacto + línea de tiempo) y los partes con material.
async function sembrar({ _db = null, log = null } = {}) {
  const db = _db || await getDB();
  let n1 = 0, n2 = 0;
  for (const p of await db.collection('peticionesGrupo').find({}).sort({ fecha: 1 }).toArray()) { try { await dePeticion(p, { _db: db }); n1++; } catch (e) { if (log) log(e.message); } }
  for (const p of await db.collection('partes').find({ $or: [{ 'materiales.0': { $exists: true } }, { materialDetalle: { $nin: [null, ''] } }] }).toArray()) { try { if (await deParte(p, { _db: db })) n2++; } catch (e) {} }
  return { peticiones: n1, partes: n2 };
}

async function indices() {
  const db = await getDB(); const c = db.collection(COL);
  await Promise.all([c.createIndex({ clave: 1, sitioClave: 1, tipo: 1 }), c.createIndex({ 'fuente.tipo': 1, 'fuente.ref': 1 }), c.createIndex({ vigente: 1, fecha: -1 }), c.createIndex({ jids: 1 })]);
}

module.exports = { apuntar, dePeticion, deParte, corregir, consultar, resumen, paraPrompt, vigentesRecientes, conNomina, cerrarAltasConNomina, esSocio, sembrar, indices, TIPOS, _puntos: puntos, _claveDe: claveDe };
