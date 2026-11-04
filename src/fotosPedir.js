// src/fotosPedir.js — Álex le PIDE fotos a Corpy (4/11/2026): «y que a Corpy, ahora que empieza a guardar fotos, le pueda
// pedir». «Mándame las fotos de Bellpuig 41», «pásame las fotos de la visita de ayer a Can Bells», «fotos de Remences 9 del 3/11».
// Busca en todo lo que guarda fotos de un sitio:
//   · visitas (las que cuenta Álex): con obra están en docsPersonal (fotos_obra); sin obra, en visitaFotos;
//   · «Fotos de la obra» subidas en la ficha (docsPersonal, ámbito obra);
//   · fotos de los grupos con la obra (grupoFotos.obraId) o de una petición de ese sitio (peticionesGrupo.fotoIds);
//   · las que mandan los operarios de un trabajo (workOrderAssignments.fotosOperario → grupoFotos).
// Las manda por el puente de WhatsApp, las más nuevas primero (máx. 10 por petición).
'use strict';
const { ObjectId } = require('mongodb');
const MAX = 10;
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9ñ]+/g, ' ').trim();
const VACIAS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'en', 'c', 'calle', 'carrer', 'cr', 'av', 'avda', 'avinguda', 'avenida', 'obra', 'casa', 'piso', 'y', 'i', 'a', 'al', 'fotos', 'foto', 'visita', 'comunidad', 'cdad', 'ctat', 'prop']);
const palabras = s => norm(s).split(' ').filter(w => w && !VACIAS.has(w) && !/^\d+$/.test(w) && w.length > 2);
const numeros = s => (norm(s).match(/\b\d+\b/g) || []);
const iso = d => d ? new Date(d).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' }) : null;
const fFecha = f => String(f || '').split('-').reverse().slice(0, 2).join('/');
const oids = l => (l || []).filter(x => ObjectId.isValid(String(x))).map(x => new ObjectId(String(x)));
const fechaOk = f => /^\d{4}-\d{2}-\d{2}$/.test(String(f || '')) ? f : null;

// ¿El texto (dirección, cliente, sitio) es ese sitio? Mismas palabras y, si se dice número, el mismo.
function casa(q, texto) {
  const ws = palabras(q), ns = numeros(q);
  if (!ws.length) return false;
  const wt = new Set(palabras(texto)), nt = new Set(numeros(texto));
  return ws.filter(w => wt.has(w)).length >= Math.min(2, ws.length) && ns.every(n => nt.has(n));
}

async function buscar(input = {}, { _db = null } = {}) {
  const db = _db || await require('./db').getDB();
  const sitio = String(input.sitio || '').trim();
  if (!sitio) return { aclara: '¿De qué sitio quieres las fotos? Dime la obra, la comunidad o la dirección.' };
  const fecha = fechaOk(input.fecha), desde = fechaOk(input.desde);
  const vale = f => !f || ((!fecha || f === fecha) && (!desde || f >= desde));

  let obra = null;
  if (/^[a-f0-9]{24}$/.test(String(input.obra_id || ''))) obra = await db.collection('obras').findOne({ _id: new ObjectId(String(input.obra_id)) }, { projection: { reference: 1, clientName: 1 } });
  else {
    const r = await require('./visitas').resolverObra(sitio, db);
    if (r.obra) obra = r.obra;
    else if (r.varias) return { aclara: `«${sitio}» puede ser varias obras:\n${r.parecidas.slice(0, 4).map((o, i) => `${i + 1}. *${o.reference}*${o.clientName ? ` (${o.clientName})` : ''}`).join('\n')}\n\n¿De cuál?` };
  }
  const obraId = obra ? String(obra._id) : null;
  const fotos = [], vistas = new Set();
  const add = f => { const k = f.col + ':' + f.id; if (vistas.has(k) || !vale(f.fecha)) return; vistas.add(k); fotos.push(f); };

  // 1) visitas
  const vis = await db.collection('visitas').find(obraId ? { obraId } : { 'fotos.0': { $exists: true } }).project({ fecha: 1, sitio: 1, cliente: 1, obraId: 1, fotos: 1 }).sort({ fecha: -1 }).limit(300).toArray();
  for (const v of vis.filter(v => obraId || casa(sitio, [v.sitio, v.cliente].join(' '))))
    for (const id of v.fotos || []) add({ col: v.obraId ? 'docsPersonal' : 'visitaFotos', id: String(id), fecha: v.fecha, origen: 'visita' });
  // 2) fotos de la obra subidas en su ficha
  if (obraId) for (const d of await db.collection('docsPersonal').find({ ambito: 'obra', obraId, tipo: 'fotos_obra' }).project({ fecha: 1, subido: 1 }).toArray())
    add({ col: 'docsPersonal', id: String(d._id), fecha: d.fecha || iso(d.subido), origen: 'obra' });
  // 3) grupos: con la obra, o de una petición de ese sitio
  const idsGrupo = new Map();   // id → origen
  if (obraId) for (const f of await db.collection('grupoFotos').find({ obraId }).project({ _id: 1 }).toArray()) idsGrupo.set(String(f._id), 'grupo');
  const pets = await db.collection('peticionesGrupo').find({ 'fotoIds.0': { $exists: true }, creado: { $gte: new Date(Date.now() - 365 * 864e5) } }).project({ direccion: 1, cliente: 1, fotoIds: 1 }).limit(800).toArray();
  for (const p of pets.filter(p => casa(sitio, [p.direccion, p.cliente].join(' ')))) for (const id of p.fotoIds) if (!idsGrupo.has(String(id))) idsGrupo.set(String(id), 'grupo');
  // 4) operarios en el trabajo
  const asig = await db.collection('workOrderAssignments').find({ 'fotosOperario.0': { $exists: true } }).project({ obraId: 1, cliente: 1, direccion: 1, fotosOperario: 1 }).limit(800).toArray();
  for (const a of asig.filter(a => (obraId && a.obraId === obraId) || casa(sitio, [a.cliente, a.direccion].join(' ')))) for (const id of a.fotosOperario) idsGrupo.set(String(id), 'operario');
  if (idsGrupo.size) for (const f of await db.collection('grupoFotos').find({ _id: { $in: oids([...idsGrupo.keys()]) } }).project({ ts: 1, quien: 1, mimetype: 1 }).toArray())
    if (/^image\//.test(f.mimetype || 'image/')) add({ col: 'grupoFotos', id: String(f._id), fecha: iso(f.ts), origen: idsGrupo.get(String(f._id)), quien: f.quien || null });

  fotos.sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
  return { obra, sitio: obra ? obra.reference : sitio, fecha, desde, fotos };
}

async function _datos(db, f) {
  const d = await db.collection(f.col).findOne({ _id: new ObjectId(f.id) });
  if (!d) return null;
  let data = d.data;
  if (!data && d.gridId) data = await require('./personalDocs').datos(d);
  if (!data) return null;
  return { data: Buffer.isBuffer(data) ? data : Buffer.from(data.buffer || data), mime: d.mime || d.mimetype || 'image/jpeg' };
}

const ORIGEN = { visita: 'visita', obra: 'ficha de la obra', grupo: 'grupo', operario: 'operario' };
async function pasar(input = {}, from, { _db = null, _enviar = null } = {}) {
  const db = _db || await require('./db').getDB();
  const r = await buscar(input, { _db: db });
  if (r.aclara) return { aclara: true, reply: r.aclara };
  const cuando = r.fecha ? ` del ${fFecha(r.fecha)}` : r.desde ? ` desde el ${fFecha(r.desde)}` : '';
  if (!r.fotos.length) return { reply: `No tengo fotos de *${r.sitio}*${cuando}.${r.obra ? '' : ' Si es una obra, dime su nombre como está en Obras.'}` };
  const W = require('./canalWhatsapp');
  const enviar = _enviar || ((to, pie, a) => W.canalActivo() === 'bridge' ? W.enviarArchivo(to, pie, a) : false);
  const tanda = r.fotos.slice(0, MAX);
  let ok = 0;
  for (const [i, f] of tanda.entries()) {
    const a = await _datos(db, f); if (!a) continue;
    const ext = /pdf/.test(a.mime) ? 'pdf' : 'jpg';
    const pie = `📸 ${r.sitio} · ${ORIGEN[f.origen]}${f.quien ? ` (${f.quien})` : ''}${f.fecha ? ' ' + fFecha(f.fecha) : ''} (${i + 1}/${tanda.length})`;
    if (await enviar(from, pie, { data: a.data, mime: a.mime, nombre: `${r.sitio.replace(/[^\w.-]+/g, '_')}_${f.fecha || ''}_${i + 1}.${ext}` })) ok++;
  }
  if (!ok) return { reply: `Tengo ${r.fotos.length} foto${r.fotos.length > 1 ? 's' : ''} de *${r.sitio}*${cuando}, pero ahora no te las puedo mandar por aquí.${r.obra ? ' Están en la obra, en Documentos: https://dashboard.corpprojects.es/obras' : ''}` };
  const resto = r.fotos.length - tanda.length;
  const dias = [...new Set(r.fotos.map(f => f.fecha).filter(Boolean))].slice(0, 6).map(fFecha);
  return { ok, total: r.fotos.length, reply: `Te mando ${ok === 1 ? 'la foto' : `${ok} fotos`} de *${r.sitio}*${cuando}${resto > 0 ? `, las más nuevas. Hay ${resto} más (días: ${dias.join(', ')}); dime un día y te mando las de ese día.` : '.'}` };
}

const TOOL = { name: 'pasar_fotos', description: 'MANDA a Álex FOTOS guardadas de un sitio (obra, comunidad o dirección): las de las visitas que contó, las de la ficha de la obra, las de los grupos y las que mandan los operarios. «mándame las fotos de Bellpuig 41», «pásame las fotos de la visita de ayer a Can Bells 30», «fotos de Remences 9 desde el lunes». Si antes preguntó entre varias obras, pon obra_id.', input_schema: { type: 'object', properties: {
  sitio: { type: 'string', description: 'Obra, comunidad o dirección tal como lo dice.' },
  obra_id: { type: ['string', 'null'], description: 'Id de la obra si ya se eligió entre varias.' },
  fecha: { type: ['string', 'null'], description: 'Un día concreto (AAAA-MM-DD): «las de ayer», «las del 3/11».' },
  desde: { type: ['string', 'null'], description: 'Desde un día (AAAA-MM-DD): «desde el lunes», «de esta semana».' },
}, required: ['sitio'] } };

module.exports = { TOOL, buscar, pasar, casa };
