// src/sitiosDia.js — Los que trabajan por partes (varios sitios al día, p. ej. David con Juan Carlos).
// No eligen una obra al fichar: al terminar la jornada (o a las 18:30 si no fichan la salida) Corpy les
// pregunta por WhatsApp dónde han estado. Contestan como les salga, en texto o audio («Creu 2 por la
// mañana, luego Pacheco y por la tarde Montseny 2»), la IA lo casa con las obras y rellena la Presencia
// suya y de quien fue con ellos. Los partes del día se usan de pista.
// Colección preguntasSitios {workerId, workerName, fecha, enviadaAt, motivo, estado, partes, respuesta, sitios}.
'use strict';
async function getDB() { return require('./db').getDB(); }
const fm = () => require('./fichajeMarcas');
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const COL = 'preguntasSitios';
// Nombre de pila; los compuestos enteros («Juan Carlos», «José María»).
const nombre1 = n => { const w = String(n || '').trim().split(/\s+/); return (w.length >= 2 && /^(juan|jos[eé]|mar[ií]a|ana|luis|miguel)$/i.test(w[0]) && !/^(de|del|la)$/i.test(w[1])) ? w.slice(0, 2).join(' ') : (w[0] || ''); };

async function _trabajador(id) { return (await fm().trabajadoresQueFichan().catch(() => [])).find(w => w.id === String(id)) || null; }
async function _partesDe(db, workerId, fecha) {
  const ps = await db.collection('partes').find({ date: fecha, $or: [{ workerId: String(workerId) }, { 'equipo.id': String(workerId) }] }).project({ obraRef: 1, clientName: 1, obraId: 1, horas: 1 }).toArray();
  const vistos = new Set();
  return ps.map(p => ({ nombre: p.obraRef || p.clientName || '', obraId: p.obraId || null, horas: p.horas || null }))
    .filter(p => p.nombre && !vistos.has(p.nombre) && vistos.add(p.nombre));
}
async function _equipo(db, workerId, fecha) {
  const a = await db.collection('attendance').findOne({ workerId: String(workerId), date: fecha });
  const ids = new Map();
  ((a && a.equipo) || []).filter(e => e.id).forEach(e => ids.set(String(e.id), e.nombre || ''));
  // Quien eligió «voy con David» al fichar también va con él.
  (await db.collection('attendance').find({ date: fecha, $or: [{ partesCon: String(workerId) }, { dePartes: true, 'equipo.id': String(workerId) }] }).project({ workerId: 1, workerName: 1 }).toArray())
    .forEach(x => { if (String(x.workerId) !== String(workerId)) ids.set(String(x.workerId), x.workerName || ''); });
  return { att: a, ids: [...ids.entries()].map(([id, nombre]) => ({ id, nombre })) };
}

function textoPregunta(nombre, equipo, partes) {
  const plural = equipo.length > 0;
  return `👋 ${nombre1(nombre)}, ¿dónde ${plural ? 'habéis' : 'has'} estado hoy${plural ? ` (tú y ${equipo.map(e => nombre1(e.nombre)).join(', ')})` : ''}?`
    + (partes.length ? `\nTengo los partes de: ${partes.map(p => p.nombre).join(', ')}. ¿Algún sitio más?` : '')
    + `\n\nContéstame aquí con un mensaje o un audio, por ejemplo: «Creu 2 por la mañana y Pacheco 17 por la tarde».`;
}

async function preguntar(workerId, { motivo = 'salida', forzar = false, dryRun = false } = {}) {
  const w = await _trabajador(workerId);
  if (!w || !w.porPartes) return { saltado: 'no trabaja por partes' };
  if (!w.whatsapp) return { saltado: 'sin teléfono' };
  const db = await getDB();
  const fecha = fm().fechaHoy();
  if (!forzar && await db.collection(COL).findOne({ workerId: w.id, fecha })) return { ya: true };
  if (!forzar && !(await db.collection('fichajeMarcas').countDocuments({ userId: w.id, fecha, tipo: 'entrada' }))) return { saltado: 'no ha fichado hoy' };
  if (!dryRun && await require('./avisos').isGlobalPaused()) return { pausado: true };
  const [partes, { ids: equipo }] = await Promise.all([_partesDe(db, w.id, fecha), _equipo(db, w.id, fecha)]);
  const texto = textoPregunta(w.name, equipo, partes);
  if (dryRun) return { texto, a: w.whatsapp };
  const ok = await require('./notifications').sendWhatsAppTo(w.whatsapp, texto).catch(e => { console.error('[Sitios] envío:', e.message); return false; });
  await db.collection(COL).updateOne({ workerId: w.id, fecha }, { $set: { workerName: w.name, enviadaAt: new Date(), motivo, estado: ok ? 'enviada' : 'fallo', partes, equipo }, $setOnInsert: { workerId: w.id, fecha } }, { upsert: true });
  return { enviado: !!ok, texto };
}
// 18:30 (L-V): a los de partes que han fichado y aún no se les ha preguntado (no fichan la salida).
async function repasar({ dryRun = false } = {}) {
  const ws = (await fm().trabajadoresQueFichan().catch(() => [])).filter(w => w.porPartes);
  const out = [];
  for (const w of ws) out.push({ quien: w.name, ...(await preguntar(w.id, { motivo: 'repaso', dryRun })) });
  return out;
}
// Pregunta abierta: la de hoy, o la de ayer si contesta antes de las 10 de la mañana.
async function pendiente(workerId) {
  if (!workerId) return null;
  const db = await getDB();
  const hoy = fm().fechaHoy();
  const p = await db.collection(COL).findOne({ workerId: String(workerId), fecha: hoy, estado: { $in: ['enviada', 'respondida'] } });
  if (p) return p;
  const h = Number(new Date().toLocaleTimeString('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hourCycle: 'h23' }));
  if (h >= 10) return null;
  const d = new Date(hoy + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1);
  return db.collection(COL).findOne({ workerId: String(workerId), fecha: d.toISOString().slice(0, 10), estado: 'enviada' });
}

// ── LEER LA RESPUESTA (IA) ──
const HERRAMIENTA = {
  name: 'sitios_del_dia',
  description: 'Sitios (obras) donde dice el trabajador que ha estado hoy',
  input_schema: { type: 'object', properties: {
    esRespuesta: { type: 'boolean', description: 'true si el mensaje dice dónde ha estado; false si habla de otra cosa' },
    sitios: { type: 'array', items: { type: 'object', properties: { obraId: { type: ['string', 'null'] }, nombre: { type: 'string' }, horas: { type: ['number', 'null'] } }, required: ['nombre'] } },
  }, required: ['esRespuesta', 'sitios'] },
};
async function _leer(texto, obras, partes) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) throw new Error('ANTHROPIC_API_KEY no configurada');
  const lista = obras.map(o => `${o.id} | ${o.reference}${o.address ? ' | ' + o.address : ''}${(o.aliases || []).length ? ' | también: ' + o.aliases.join(', ') : ''}`).join('\n');
  const prompt = `Un trabajador de una empresa de reformas de Girona contesta a «¿dónde habéis estado hoy?». Su mensaje:\n«${String(texto).slice(0, 1500)}»\n\n`
    + (partes.length ? `Partes de trabajo que entregó hoy (pista): ${partes.map(p => p.nombre).join(', ')}.\n\n` : '')
    + `Obras (id | referencia | dirección):\n${lista}\n\n`
    + `Devuelve cada sitio que nombra, en orden. Si casa con una obra de la lista (por calle y número, o por el nombre del cliente), pon su id; si no, obraId null y el nombre tal como lo dice. Si dice horas («por la mañana» ≈ 4, «un rato» ≈ 1, «2 horas»), ponlas; si no, null. Si el mensaje no dice dónde ha estado (por ejemplo «mañana llego tarde»), esRespuesta=false.`;
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 45000);
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: c.signal, headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: require('./config').ia.vision, max_tokens: 1500, tools: [HERRAMIENTA], tool_choice: { type: 'tool', name: HERRAMIENTA.name }, messages: [{ role: 'user', content: prompt }] }) }).finally(() => clearTimeout(t));
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || 'La IA no respondió');
  const tu = (j.content || []).find(x => x.type === 'tool_use');
  return tu ? tu.input : { esRespuesta: false, sitios: [] };
}
// Horas por sitio: las que dijo; el resto del día se reparte a partes iguales entre los demás.
function repartirHoras(sitios, total) {
  const T = Number(total) > 0 ? Number(total) : 8;
  const dichas = sitios.filter(s => Number(s.horas) > 0).reduce((a, s) => a + Number(s.horas), 0);
  const sinH = sitios.filter(s => !(Number(s.horas) > 0)).length;
  const resto = Math.max(0, T - dichas);
  const cada = sinH ? Math.round(resto / sinH * 2) / 2 : 0;   // medias horas
  return sitios.map(s => ({ ...s, horas: Number(s.horas) > 0 ? r2(s.horas) : cada }));
}

// Devuelve el texto de respuesta, o null si el mensaje no es la respuesta a la pregunta (sigue el flujo normal).
async function responder(workerId, workerName, texto, { _leerIA = _leer } = {}) {
  const p = await pendiente(workerId);
  if (!p || !String(texto || '').trim()) return null;
  const db = await getDB();
  const OD = require('./obraDelDia');
  const obras = await require('./obras').getSelector({ todas: false, conEstudio: false });
  const leido = await _leerIA(texto, obras, p.partes || []);
  if (!leido || !leido.esRespuesta || !(leido.sitios || []).length) return null;
  const porId = new Map(obras.map(o => [o.id, o]));
  const sitios = leido.sitios.map(s => { const o = s.obraId && porId.get(String(s.obraId)); return { obraId: o ? o.id : null, nombre: o ? o.reference : String(s.nombre || '').trim().slice(0, 80), horas: s.horas }; }).filter(s => s.nombre);
  if (!sitios.length) return null;
  const { ids: equipo } = await _equipo(db, workerId, p.fecha);
  const personas = [{ id: String(workerId), nombre: workerName }, ...equipo.filter(e => e.id !== String(workerId))];
  const apuntados = [], respetados = [];
  for (const per of personas) {
    const a = await db.collection('attendance').findOne({ workerId: per.id, date: p.fecha });
    if (a && a.estado && a.estado !== 'obra') continue;                                  // vacaciones, baja…
    if (OD.esManual(a) && OD._obraDe(a) && !a.dePartes) {                                 // oficina ya lo puso: no se pisa
      await db.collection('attendance').updateOne({ _id: a._id }, { $set: { sitiosDichos: String(texto).slice(0, 300), updatedAt: new Date() } });
      respetados.push(nombre1(per.nombre)); continue;
    }
    const filas = repartirHoras(sitios, a && a.horas);
    await db.collection('attendance').updateOne({ workerId: per.id, date: p.fecha },
      { $set: { estado: 'obra', obras: filas.map(f => ({ obraId: f.obraId, clientName: f.nombre, horas: f.horas })), clientName: filas[0].nombre, dePartes: true, obraFuente: 'whatsapp', sitiosDichos: String(texto).slice(0, 300), sitiosPor: per.id === String(workerId) ? null : workerName, updatedAt: new Date() },
        $setOnInsert: { workerId: per.id, workerName: per.nombre, date: p.fecha, horas: 0, autoGenerated: true, autoFromFichaje: true } }, { upsert: true });
    apuntados.push(per.id === String(workerId) ? 'ti' : nombre1(per.nombre));
  }
  await db.collection(COL).updateOne({ _id: p._id }, { $set: { estado: 'respondida', respuesta: String(texto).slice(0, 1000), sitios, respondidaAt: new Date() } });
  const sinObra = sitios.filter(s => !s.obraId).map(s => s.nombre);
  return `✅ Apuntado${apuntados.length > 1 ? ' para ' + apuntados.join(' y ') : ''}: ${sitios.map(s => s.nombre).join(', ')}.`
    + (sinObra.length ? `\n(No tengo como obra: ${sinObra.join(', ')}. La oficina lo revisará.)` : '')
    + (respetados.length ? `\n(A ${respetados.join(', ')} ya le había puesto la obra la oficina; se lo dejo anotado.)` : '')
    + `\nSi algo no está bien, mándame otro mensaje y lo corrijo.`;
}

module.exports = { preguntar, repasar, pendiente, responder, repartirHoras, textoPregunta };
