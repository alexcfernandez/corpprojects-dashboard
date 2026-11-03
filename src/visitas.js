// src/visitas.js — VISITAS que Álex le cuenta a Corpy (3/11/2026). Álex: «que yo le pudiera decir a Corpy por un audio:
// hoy he ido a tal sitio, he visto esto, le aporto un par de fotos, y ya lo guarde en la ficha; o mis notas del móvil».
// Ese día se le olvidó apuntar Bellpuig 41 3-1 (Marta) y Can Bells 30, y un administrador se quejó de que «no habíamos ido».
//   · La herramienta del agente `registrar_visita` llama a registrar(): apunta el rato de Álex/Alfonso (tiempoSocios),
//     guarda la visita (colección `visitas`), las fotos (en la obra como «Fotos de la obra»; sin obra, en `visitaFotos`),
//     la nota en la ficha de la comunidad si no hay obra, la visita en la petición/incidencia abierta de ese sitio, el
//     contacto si da teléfono y un recordatorio en la agenda por cada siguiente paso con fecha.
//   · Si el sitio se parece a una obra pero no es («Can Bells 30» y la obra «can bells 20»), PREGUNTA en vez de adivinar.
//   · Fotos: las que manda junto al relato (o en los 15 min de antes, el buffer de server.js) llegan aquí por
//     guardarFotosPendientes(); las que manda en los 10 min DESPUÉS de una visita van a esa visita (anadirFotos).
'use strict';
const COL = 'visitas';
const VENTANA_FOTOS = 10 * 60 * 1000;     // fotos sueltas justo después de contar la visita → a esa visita
const TTL_PENDIENTES = 15 * 60 * 1000;    // fotos que esperan a que se aclare la obra
async function getDB() { return require('./db').getDB(); }
const hoyISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9ñ]+/g, ' ').trim();
const corto = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const fFecha = f => String(f || '').split('-').reverse().join('/');
const VACIAS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'en', 'c', 'calle', 'carrer', 'cr', 'av', 'avda', 'avinguda', 'avenida', 'obra', 'casa', 'piso', 'y', 'i', 'a', 'al']);
const palabras = s => norm(s).split(' ').filter(w => w && !VACIAS.has(w) && !/^\d+$/.test(w) && w.length > 2);
const numeros = s => (norm(s).match(/\b\d+\b/g) || []);

// ¿Es un relato de visita? (audio transcrito, texto o notas pegadas). Las órdenes («hazme…», «crea…») no.
function esRelato(texto) {
  const t = norm(texto);
  if (!t || /^(haz|hazme|crea|prepara|redacta|genera|manda|envia|pasame|dime|cuanto|que|quien|cuando)\b/.test(t)) return false;
  if (/\b(he|hemos|ha) (ido|estado|pasado|visitado|quedado con)\b|\b(estoy|estamos) en\b|\bvisita (hecha|hoy)\b|\b(vengo|venimos) de\b|\b(he|hemos) visto\b|\bson (las )?fotos de\b|\bfotos de la visita\b/.test(t)) return true;
  // Notas del móvil pegadas: texto largo, de varias líneas, sin pregunta.
  return String(texto).length >= 160 && String(texto).split(/\n/).filter(l => l.trim()).length >= 3 && !/\?\s*$/.test(String(texto).trim());
}

// ── Fotos que esperan al relato (o a que se aclare la obra) ──
const pendientes = new Map();   // from → { imagenes: [{data(base64), media_type}], ts }
const ultima = new Map();       // from → { visitaId, sitio, ts }
function guardarFotosPendientes(from, imagenes = []) {
  if (!imagenes.length) return;
  const p = pendientes.get(from);
  const prev = p && (Date.now() - p.ts) < TTL_PENDIENTES ? p.imagenes : [];
  pendientes.set(from, { imagenes: [...prev, ...imagenes].slice(-12), ts: Date.now() });
}
function _tomarFotosPendientes(from) {
  const p = pendientes.get(from); pendientes.delete(from);
  return p && (Date.now() - p.ts) < TTL_PENDIENTES ? p.imagenes : [];
}
function visitaReciente(from) {
  const u = ultima.get(from);
  return u && (Date.now() - u.ts) < VENTANA_FOTOS ? u : null;
}

// ¿Qué obra es? Una sola que casa (y con el mismo número si se dice) → esa. Si solo casan obras con OTRO número
// («Can Bells 30» → «can bells 20»), se devuelven como parecidas para preguntar.
async function resolverObra(texto, db) {
  const ws = palabras(texto), ns = numeros(texto);
  if (!ws.length) return { obra: null, parecidas: [] };
  const l = await db.collection('obras').find({ status: { $nin: ['descartada', 'archivada'] } }).project({ reference: 1, aliases: 1, address: 1, clientName: 1, status: 1 }).toArray();
  const cand = [];
  for (const o of l) {
    const nombres = [o.reference, o.address, ...(o.aliases || [])].filter(Boolean);
    const wo = new Set(nombres.flatMap(palabras));
    const comunes = ws.filter(w => wo.has(w)).length;
    if (!comunes || comunes < Math.min(2, ws.length)) continue;
    const no = new Set(nombres.flatMap(numeros));
    const numOk = !ns.length || ns.every(n => no.has(n));
    cand.push({ o, comunes, numOk, choca: !numOk });
  }
  const buenas = cand.filter(c => c.numOk);
  const max = Math.max(0, ...buenas.map(c => c.comunes));
  const top = buenas.filter(c => c.comunes === max);
  if (top.length === 1) return { obra: top[0].o, parecidas: [] };
  if (top.length > 1) return { obra: null, parecidas: top.map(c => c.o), varias: true };
  return { obra: null, parecidas: cand.filter(c => c.choca).map(c => c.o) };
}

// Petición/incidencia abierta de ese sitio (la del grupo o del correo): mismas palabras y, si hay número, el mismo.
async function peticionAbierta(texto, db) {
  const ws = palabras(texto), ns = numeros(texto);
  if (!ws.length) return null;
  const l = await db.collection('peticionesGrupo').find({ estado: { $nin: ['hecho', 'archivo', 'descartada'] }, creado: { $gte: new Date(Date.now() - 120 * 864e5) } })
    .project({ direccion: 1, cliente: 1, clienteId: 1, incidencia: 1, resumen: 1, creado: 1 }).sort({ creado: -1 }).limit(400).toArray();
  return l.find(p => {
    const d = [p.direccion, p.cliente].join(' '), wd = new Set(palabras(d)), nd = new Set(numeros(d));
    return ws.some(w => wd.has(w)) && (!ns.length || ns.every(n => nd.has(n))) && (wd.size > 0);
  }) || null;
}

const socioDe = q => /alfons/i.test(q) ? 'Alfonso' : /(^|\s)(alex|álex|yo)(\s|$)/i.test(q) ? 'Álex' : null;

async function registrar(input = {}, por = 'Álex (Corpy)', { from = null, _db = null, _apuntarTiempo = null, _subirFoto = null, _notaComunidad = null, _evento = null, _contacto = null } = {}) {
  const db = _db || await getDB();
  const sitio = corto([input.obra, input.sitio].filter(Boolean).join(' · ') || input.cliente, 140);
  if (!sitio) return { aclara: true, reply: '¿Dónde ha sido la visita? Dime la obra, la comunidad o la dirección.' };
  const quienes = (Array.isArray(input.quienes) ? input.quienes : [input.quienes]).map(q => String(q || '').trim()).filter(Boolean);
  const socios = [...new Set(quienes.map(socioDe).filter(Boolean))];
  if (!socios.length) socios.push('Álex');   // habla Álex en primera persona
  const acompanan = quienes.filter(q => !socioDe(q));
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(input.fecha || '')) ? input.fecha : hoyISO();

  // 1) la obra: elegida a mano (obra_id tras preguntar), sin obra a propósito, o resuelta por el nombre
  let obra = null;
  if (/^[a-f0-9]{24}$/.test(String(input.obra_id || ''))) obra = await db.collection('obras').findOne({ _id: new (require('mongodb').ObjectId)(String(input.obra_id)) }, { projection: { reference: 1, clientName: 1, address: 1 } });
  else if (!input.sin_obra) {
    const r = await resolverObra([input.obra, input.sitio].filter(Boolean).join(' '), db);
    if (r.obra) obra = r.obra;
    else if (r.parecidas.length) {
      const l = r.parecidas.slice(0, 4).map((o, i) => `${i + 1}. *${o.reference}*${o.clientName ? ` (${o.clientName})` : ''}`).join('\n');
      return { aclara: true, reply: `${r.varias ? `«${sitio}» puede ser varias obras` : `No tengo una obra que sea exactamente «${sitio}». Se parece a`}:\n${l}\n\n¿Es alguna de estas o la apunto sin obra (en el cliente)?` };
    }
  }
  // 2) cuánto rato (lo necesita el tiempo de socios)
  if (!(Number(input.minutos) > 0) && !(input.desde && input.hasta)) return { aclara: true, reply: `¿Cuánto rato fue la visita a ${obra ? obra.reference : sitio}, más o menos?` };

  const que = corto(input.que_se_vio || input.que, 1500);
  const pasos = (Array.isArray(input.siguientes_pasos) ? input.siguientes_pasos : []).map(p => typeof p === 'string' ? { que: p } : p).filter(p => p && p.que).slice(0, 8)
    .map(p => ({ que: corto(p.que, 200), fecha: /^\d{4}-\d{2}-\d{2}$/.test(String(p.fecha || '')) ? p.fecha : null, hora: /^\d{1,2}:\d{2}$/.test(String(p.hora || '')) ? p.hora.padStart(5, '0') : null }));

  // 3) el rato de los socios (en la obra si la hay)
  let tiempo = null;
  try {
    tiempo = await (_apuntarTiempo || require('./tiempoSocios').apuntar)({ quienes: socios, obra: obra ? obra.reference : (input.sitio || ''), cliente: input.cliente || '', obraId: obra ? String(obra._id) : null, sinObra: !obra,
      que: corto(que, 200) || 'Visita', tipo: ['visita', 'presupuesto', 'intervencion'].includes(input.tipo) ? input.tipo : 'visita', fecha, desde: input.desde || null, hasta: input.hasta || null,
      minutos: Number(input.minutos) || null, facturable: input.facturable !== false }, por);
  } catch (e) { return { aclara: true, reply: e.message }; }

  // 4) la petición/incidencia abierta de ese sitio
  let pet = null; try { pet = await peticionAbierta([input.sitio, input.obra, input.cliente].filter(Boolean).join(' '), db); } catch (e) {}

  const doc = { fecha, quienes: socios, acompanan, sitio, obraId: obra ? String(obra._id) : null, obraRef: obra ? obra.reference : null, cliente: corto(input.cliente || (obra && obra.clientName) || (pet && pet.cliente), 120) || null,
    peticionId: pet ? String(pet._id) : null, incidencia: pet && pet.incidencia || null, que, siguientes: pasos, contacto: input.contacto && input.contacto.nombre ? input.contacto : null,
    tiempoId: tiempo && tiempo._id ? String(tiempo._id) : null, minutos: tiempo ? tiempo.minutos : null, fotos: [], por, creado: new Date() };
  const ins = await db.collection(COL).insertOne(doc); doc._id = ins.insertedId;

  if (pet) {
    try { await db.collection('peticionesGrupo').updateOne({ _id: pet._id }, { $set: { visitaHecha: { fecha, por: socios.join(' y '), nota: corto(que, 600), visitaId: String(doc._id) }, actualizado: new Date() }, $push: { visitas: { fecha, por: socios.join(' y '), visitaId: String(doc._id), que: corto(que, 300) } } }); } catch (e) { console.warn('[Visitas] petición:', e.message); }
  }
  // 5) sin obra: la nota va a la ficha de la comunidad (si se reconoce con seguridad)
  let notaEn = null;
  if (!obra && (input.cliente || input.sitio)) {
    try { const r = await (_notaComunidad || require('./asistente')._ejecutarNotaComunidad)(input.cliente || input.sitio, `Visita ${fFecha(fecha)} (${socios.join(' y ')}): ${corto(que, 400)}${pasos.length ? ' · Siguiente: ' + pasos.map(p => p.que).join('; ') : ''}`); if (r && r.ok) notaEn = r.target; } catch (e) {}
  }
  // 6) fotos
  const nFotos = await _guardarFotos(db, doc, from ? _tomarFotosPendientes(from) : [], { _subirFoto, por });
  // 7) contacto con teléfono
  let contacto = null;
  if (doc.contacto && doc.contacto.telefono) {
    try { contacto = await (_contacto || require('./contactos').guardar)({ cliente: doc.cliente || '', clienteId: pet && pet.clienteId || null, nombre: doc.contacto.nombre, telefonos: [doc.contacto.telefono], piso: doc.contacto.piso || '', rol: doc.contacto.rol || 'vecino', nota: `Visita ${fFecha(fecha)}`, origen: 'visita' }, por); } catch (e) { console.warn('[Visitas] contacto:', e.message); }
  }
  // 8) recordatorios en la agenda de Álex
  let eventos = 0;
  for (const p of pasos.filter(p => p.fecha)) {
    try { await (_evento || require('./calendar').crearEventoPersonal)({ date: p.fecha, hora: p.hora, titulo: `${p.que} · ${obra ? obra.reference : sitio}`, lugar: sitio, nota: `De la visita del ${fFecha(fecha)}: ${corto(que, 300)}` }); eventos++; } catch (e) { console.warn('[Visitas] agenda:', e.message); }
  }
  if (from) ultima.set(from, { visitaId: String(doc._id), sitio: obra ? obra.reference : sitio, ts: Date.now() });

  const h = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
  const lineas = [`📍 *Visita apuntada* — ${obra ? `obra *${obra.reference}*` : `*${sitio}*`} · ${fFecha(fecha)}`,
    `⏱️ ${socios.join(' y ')}${acompanan.length ? ` (con ${acompanan.join(', ')})` : ''} · ${tiempo ? h(tiempo.minutos) + ' h' : ''}${tiempo && tiempo.km ? ` · ${tiempo.km} km` : ''}${input.facturable === false ? ' · no facturable' : ''}`];
  if (que) lineas.push(`📝 ${corto(que, 300)}`);
  if (pasos.length) lineas.push(`➡️ Siguiente: ${pasos.map(p => p.que + (p.fecha ? ` (${fFecha(p.fecha)}${p.hora ? ' ' + p.hora : ''})` : '')).join('; ')}${eventos ? ` — ${eventos} en tu agenda` : ''}`);
  if (pet) lineas.push(`🔧 Anotada en ${pet.incidencia ? '*' + pet.incidencia + '*' : 'la petición'}${pet.resumen ? ` (${corto(pet.resumen, 60)})` : ''}`);
  if (notaEn) lineas.push(`📒 Nota en la ficha de *${notaEn}*`);
  if (contacto) lineas.push(`📇 Contacto guardado: ${doc.contacto.nombre}`);
  lineas.push(nFotos ? `📸 ${nFotos} foto${nFotos > 1 ? 's' : ''} guardada${nFotos > 1 ? 's' : ''}${obra ? ' en la obra' : ''}` : '📸 Si tienes fotos, mándamelas ahora y van a esta visita.');
  return { ok: true, visita: doc, reply: lineas.join('\n') };
}

// Fotos a la visita: en la obra como «Fotos de la obra» (se ven en sus documentos); sin obra, en `visitaFotos`.
async function _guardarFotos(db, visita, imagenes = [], { _subirFoto = null, por = 'Álex (Corpy)' } = {}) {
  let n = 0;
  for (const img of imagenes.slice(0, 12)) {
    try {
      const buffer = Buffer.from(img.data, 'base64'), mimetype = img.media_type || 'image/jpeg';
      let id;
      if (visita.obraId) {
        const r = await (_subirFoto || require('./personalDocs').subir)({ ambito: 'obra', obraId: visita.obraId, tipo: 'fotos_obra', archivo: { buffer, mimetype, originalname: `Visita ${fFecha(visita.fecha).replace(/\//g, '-')} (${visita.fotos.length + n + 1}).jpg` }, fecha: visita.fecha, notas: corto(`Visita ${visita.quienes.join(' y ')}: ${visita.que}`, 280) }, por);
        id = r && (r.id || r._id);
      } else {
        const r = await db.collection('visitaFotos').insertOne({ visitaId: String(visita._id), data: buffer, mimetype, creado: new Date() });
        id = r.insertedId;
      }
      if (id) { await db.collection(COL).updateOne({ _id: visita._id }, { $push: { fotos: String(id) } }); n++; }
    } catch (e) { console.warn('[Visitas] foto:', e.message); }
  }
  return n;
}

// Fotos sueltas que llegan justo después de contar una visita.
async function anadirFotos(from, imagenes = [], { _db = null, _subirFoto = null } = {}) {
  const u = visitaReciente(from); if (!u) return null;
  const db = _db || await getDB();
  const v = await db.collection(COL).findOne({ _id: new (require('mongodb').ObjectId)(u.visitaId) });
  if (!v) return null;
  const n = await _guardarFotos(db, v, imagenes, { _subirFoto });
  u.ts = Date.now();
  if (!n) return null;
  // WhatsApp manda cada foto en un mensaje: se contesta a la primera y las siguientes (en 1 min) van en silencio ('').
  u.fotos = (u.fotos || 0) + n;
  if (u.acuse && Date.now() - u.acuse < 60 * 1000) return '';
  u.acuse = Date.now();
  return `📸 Guardada${n > 1 ? 's' : ''} en la visita de *${u.sitio}* (las que mandes ahora también van ahí).`;
}

async function deObra(obraId, { _db = null } = {}) {
  const db = _db || await getDB();
  return db.collection(COL).find({ obraId: String(obraId) }).project({ fecha: 1, quienes: 1, acompanan: 1, que: 1, siguientes: 1, minutos: 1, fotos: 1, incidencia: 1 }).sort({ fecha: -1 }).limit(30).toArray();
}

module.exports = { esRelato, registrar, guardarFotosPendientes, visitaReciente, anadirFotos, deObra, resolverObra, peticionAbierta, _pendientes: pendientes, _ultima: ultima };
