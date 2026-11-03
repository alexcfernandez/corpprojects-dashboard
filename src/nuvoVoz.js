// src/nuvoVoz.js — Avisos de NUVO VOZ, la centralita de Corp en voz.nuvoialabs.com (3/11/2026, Álex: «que los recados de
// SecretarIA creen solos la incidencia y que Corpy meta un resumen de las llamadas en la revisión»).
//
// Nuvo Voz manda un POST JSON firmado a /api/nuvo-voz/eventos: cabeceras x-nuvo-tiempo (segundos Unix) y x-nuvo-firma =
// HMAC-SHA256 hex de «<tiempo>.<cuerpo tal cual>» con NUVO_VOZ_WEBHOOK_SECRETO (la clave la genera Nuvo Voz). Si no le
// contestamos 2xx en 10 s reintenta (1, 5, 30, 120 y 360 min), así que se contesta enseguida y se procesa detrás, y cada
// aviso se guarda una sola vez por evento + llamada.
//
//   recado.nuevo     → peticionesGrupo.deRecado(): petición + incidencia; si es urgente, WhatsApp al momento.
//   llamada.perdida  → solo se guarda. Cuando la coge SecretarIA llegan la perdida y el recado de la misma llamada: lo que
//                      sale en la revisión y en el aviso de las 8:15 son las perdidas SIN recado (hay que devolverlas).
//   resumen.diario   → 20:30, cifras del día para la revisión de las 21:05.
//   prueba           → botón de Nuvo Voz: 200 y nada más.
//
//   llamadasVoz { _id: '<evento>:<llamada>', evento, llamada, fecha, urgente, resumen, contacto, final, motivo, estado, intentos, resultado, recibido }
//   llamadasDia { _id: 'AAAA-MM-DD', entrantes, salientes, atendidas, perdidas, secretaria, recados, minutos, porPersona, recibido }
'use strict';
const crypto = require('crypto');
async function getDB() { return require('./db').getDB(); }
const COL = 'llamadasVoz', DIA = 'llamadasDia';
const VENTANA_S = 300, MAX_INTENTOS = 4;
const TZ = 'Europe/Madrid';
const corto = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const num = n => Math.max(0, Math.round(Number(n) || 0));
const hora = d => new Date(d).toLocaleTimeString('es-ES', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const diaHora = d => new Date(d).toLocaleString('es-ES', { timeZone: TZ, weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// Firma: tiempo dentro de 5 minutos y HMAC comparado en tiempo constante.
function firmaValida({ tiempo, firma, cuerpo, secreto = process.env.NUVO_VOZ_WEBHOOK_SECRETO, ahora = Date.now() }) {
  if (!secreto) return { ok: false, motivo: 'falta NUVO_VOZ_WEBHOOK_SECRETO' };
  if (!/^\d{9,11}$/.test(String(tiempo || '')) || Math.abs(ahora / 1000 - Number(tiempo)) > VENTANA_S) return { ok: false, motivo: 'tiempo fuera de margen' };
  const esperada = crypto.createHmac('sha256', secreto).update(`${tiempo}.`).update(cuerpo).digest();
  const dada = /^[0-9a-f]+$/i.test(String(firma || '')) ? Buffer.from(String(firma), 'hex') : Buffer.alloc(0);
  if (dada.length !== esperada.length || !crypto.timingSafeEqual(dada, esperada)) return { ok: false, motivo: 'firma no válida' };
  return { ok: true };
}

const _contacto = c => c && typeof c === 'object' ? { nombre: corto(c.nombre, 120) || null, externalId: corto(c.externalId, 40) || null } : null;

// Guarda el aviso. Devuelve { id } si hay algo que procesar, { ya: true } si es un reintento ya guardado.
async function recibir(ev, { _db = null } = {}) {
  if (!ev || typeof ev !== 'object') throw new Error('cuerpo no válido');
  if (ev.empresa && ev.empresa !== 'corp') return { ignorado: 'otra empresa' };
  const db = _db || await getDB();
  if (ev.evento === 'prueba') return { prueba: true };
  if (ev.evento === 'resumen.diario') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ev.fecha || ''))) throw new Error('fecha no válida');
    const d = { entrantes: num(ev.entrantes), salientes: num(ev.salientes), atendidas: num(ev.atendidas), perdidas: num(ev.perdidas), secretaria: num(ev.secretaria),
      recados: num(ev.recados), minutos: num(ev.minutos), porPersona: (Array.isArray(ev.porPersona) ? ev.porPersona : []).slice(0, 40).map(p => ({ nombre: corto(p && p.nombre, 60) || '¿?', atendidas: num(p && p.atendidas), minutos: num(p && p.minutos) })), recibido: new Date() };
    await db.collection(DIA).updateOne({ _id: ev.fecha }, { $set: d }, { upsert: true });
    return { resumen: ev.fecha };
  }
  if (ev.evento !== 'recado.nuevo' && ev.evento !== 'llamada.perdida') return { ignorado: `evento ${corto(ev.evento, 40)}` };
  const llamada = corto(ev.llamada, 80);
  if (!llamada) throw new Error('falta la llamada');
  const fecha = new Date(ev.fecha); if (isNaN(fecha)) throw new Error('fecha no válida');
  const doc = { _id: `${ev.evento}:${llamada}`, evento: ev.evento, llamada, fecha, contacto: _contacto(ev.contacto), final: corto(ev.final, 3).replace(/\D/g, '') || null, recibido: new Date() };
  if (ev.evento === 'recado.nuevo') Object.assign(doc, { resumen: corto(ev.resumen, 3000), titulo: corto(ev.titulo, 60) || null, urgente: !!ev.urgente || /^\s*URGENTE\b/i.test(ev.resumen || ''), estado: 'pendiente', intentos: 0 });
  else Object.assign(doc, { motivo: corto(ev.motivo, 60) || null, estado: 'hecho' });
  try { await db.collection(COL).insertOne(doc); }
  catch (e) { if (e && e.code === 11000) return { ya: true }; throw e; }
  return doc.estado === 'pendiente' ? { id: doc._id } : { guardado: doc._id };
}

// Recado guardado → petición. Si falla (IA, StelOrder…) queda en error y lo reintenta reintentar().
async function procesar(id, { _db = null, _deRecado = null } = {}) {
  const db = _db || await getDB();
  const r0 = await db.collection(COL).findOneAndUpdate({ _id: id, estado: { $in: ['pendiente', 'error'] } }, { $set: { estado: 'procesando', empezado: new Date() }, $inc: { intentos: 1 } }, { returnDocument: 'after' });
  const d = r0 && (r0.value !== undefined ? r0.value : r0);
  if (!d || !d._id) return null;
  try {
    const res = await (_deRecado || require('./peticionesGrupo').deRecado)({ llamada: d.llamada, fecha: d.fecha, urgente: d.urgente, resumen: d.resumen, titulo: d.titulo || null, contacto: d.contacto, final: d.final });
    await db.collection(COL).updateOne({ _id: d._id }, { $set: { estado: 'hecho', resultado: res, hechoAt: new Date() }, $unset: { error: '' } });
    return res;
  } catch (e) {
    console.warn('[NuvoVoz] recado', d.llamada, e.message);
    await db.collection(COL).updateOne({ _id: d._id }, { $set: { estado: 'error', error: corto(e.message, 300) } });
    return { error: e.message };
  }
}

// Cada 10 min: los recados que quedaron a medias (error o un reinicio a mitad) se vuelven a intentar.
async function reintentar({ _db = null, _deRecado = null } = {}) {
  const db = _db || await getDB();
  const l = await db.collection(COL).find({ evento: 'recado.nuevo', intentos: { $lt: MAX_INTENTOS }, $or: [{ estado: 'error' }, { estado: { $in: ['pendiente', 'procesando'] }, recibido: { $lt: new Date(Date.now() - 10 * 60 * 1000) } }] }).limit(20).toArray();
  for (const d of l) { if (d.estado === 'procesando') await db.collection(COL).updateOne({ _id: d._id }, { $set: { estado: 'error' } }); await procesar(d._id, { _db: db, _deRecado }); }
  return l.length;
}

// Handler de Express (el cuerpo llega crudo: express.raw en server.js).
async function manejar(req, res) {
  const cuerpo = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : '');
  const f = firmaValida({ tiempo: req.get('x-nuvo-tiempo'), firma: req.get('x-nuvo-firma'), cuerpo });
  if (!f.ok) { console.warn('[NuvoVoz] rechazado:', f.motivo); return res.status(401).json({ error: f.motivo }); }
  let ev; try { ev = JSON.parse(cuerpo.toString('utf8')); } catch (e) { return res.status(400).json({ error: 'JSON no válido' }); }
  let r;
  try { r = await recibir(ev); } catch (e) { console.warn('[NuvoVoz]', e.message); return res.status(/no válid|falta/.test(e.message) ? 400 : 500).json({ error: e.message }); }
  res.json({ ok: true, ...r });
  if (r.id) setImmediate(() => procesar(r.id).catch(e => console.warn('[NuvoVoz] procesar:', e.message)));
}

// ── Lo del día (revisión de las 21:05 y aviso de las 8:15) ──
async function perdidasSinRecado(desde, hasta, { _db = null } = {}) {
  const db = _db || await getDB();
  const perdidas = await db.collection(COL).find({ evento: 'llamada.perdida', fecha: { $gte: desde, $lt: hasta } }).sort({ fecha: 1 }).limit(200).toArray();
  if (!perdidas.length) return [];
  const conRecado = new Set((await db.collection(COL).find({ evento: 'recado.nuevo', llamada: { $in: perdidas.map(p => p.llamada) } }).project({ llamada: 1 }).toArray()).map(r => r.llamada));
  return perdidas.filter(p => !conRecado.has(p.llamada) && !p.devuelta);   // «Ya la he devuelto» en 📞 Llamadas
}

// ── Pantalla «📞 Llamadas» del panel (3/11/2026): lo de los últimos días, de un vistazo y sin gastar StelOrder ──
async function panel({ dias = 7, ahora = new Date(), _db = null } = {}) {
  const db = _db || await getDB();
  const desde = new Date(ahora.getTime() - dias * 24 * 3600 * 1000);
  const hoy = new Date(ahora).toLocaleDateString('sv-SE', { timeZone: TZ });
  const [perdidas, recados, resumenHoy, ultimo] = await Promise.all([
    perdidasSinRecado(desde, ahora, { _db: db }),
    db.collection(COL).find({ evento: 'recado.nuevo', fecha: { $gte: desde } }).sort({ fecha: -1 }).limit(60).toArray(),
    db.collection(DIA).findOne({ _id: hoy }),
    db.collection(COL).find({}).sort({ recibido: -1 }).limit(1).toArray(),
  ]);
  const quien = p => ({ nombre: (p.contacto && p.contacto.nombre) || null, final: p.final || null });
  return {
    dias, hoy,
    perdidas: perdidas.sort((a, b) => b.fecha - a.fecha).map(p => ({ id: p._id, fecha: p.fecha, ...quien(p), motivo: p.motivo || null })),
    recados: recados.map(r => ({ id: r._id, fecha: r.fecha, ...quien(r), urgente: !!r.urgente, titulo: r.titulo || null, resumen: r.resumen || '', estado: r.estado,
      error: r.estado === 'error' ? (r.error || null) : null,
      peticiones: ((r.resultado && r.resultado.nuevas) || []).map(n => ({ id: n.id, porConfirmar: n.porConfirmar || null, incidencia: n.incidencia || null })) })),
    resumenHoy: resumenHoy || null,
    ultimoAviso: (ultimo[0] && ultimo[0].recibido) || null,
  };
}

// «Ya la he devuelto»: la perdida deja de salir aquí, en la revisión y en el aviso de las 8:15.
async function marcarDevuelta(id, por = '', { _db = null } = {}) {
  const db = _db || await getDB();
  const r = await db.collection(COL).updateOne({ _id: String(id), evento: 'llamada.perdida' }, { $set: { devuelta: true, devueltaPor: corto(por, 60), devueltaAt: new Date() } });
  if (!r.matchedCount) throw new Error('Llamada no encontrada');
  return { ok: true };
}

async function datosDia(fecha, { _db = null } = {}) {
  const db = _db || await getDB();
  const { ini, fin } = require('./revision').limites(fecha);
  const [resumen, recados, perdidas] = await Promise.all([
    db.collection(DIA).findOne({ _id: fecha }),
    db.collection(COL).find({ evento: 'recado.nuevo', fecha: { $gte: ini, $lt: fin } }).sort({ fecha: 1 }).limit(100).toArray(),
    perdidasSinRecado(ini, fin, { _db: db }),
  ]);
  return { resumen: resumen || null, recados, perdidasSinRecado: perdidas };
}

const _quien = p => `${corto(p.contacto && p.contacto.nombre, 40) || 'sin identificar'}${p.final ? ` …${p.final}` : ''}`;

// Bloque fijo del WhatsApp de la revisión. null si no ha habido nada.
function textoDia({ resumen, recados = [], perdidasSinRecado = [] }) {
  if (!resumen && !recados.length && !perdidasSinRecado.length) return null;
  const l = ['📞 *Llamadas de hoy*'];
  if (resumen) {
    l.push(`Entrantes ${resumen.entrantes} · salientes ${resumen.salientes}`);
    l.push(`✅ Atendidas ${resumen.atendidas} · ❌ perdidas ${resumen.perdidas} · 🤖 SecretarIA ${resumen.secretaria} · 📝 recados ${resumen.recados} · ⏱ ${resumen.minutos} min`);
    const pp = (resumen.porPersona || []).filter(p => p.atendidas || p.minutos);
    if (pp.length) l.push(`Por persona: ${pp.map(p => `${p.nombre} ${p.atendidas} (${p.minutos} min)`).join(' · ')}`);
  } else l.push(`(Nuvo Voz no ha mandado el resumen del día; solo lo que ha llegado: ${recados.length} recado${recados.length === 1 ? '' : 's'}, ${perdidasSinRecado.length} perdida${perdidasSinRecado.length === 1 ? '' : 's'} sin recado)`);
  const urg = recados.filter(r => r.urgente).length;
  if (recados.length) l.push(`Recados: ${recados.slice(0, 8).map(r => `${r.urgente ? '🚨 ' : ''}${_quien(r)} · ${corto(String(r.resumen || '').replace(/^\s*URGENTE\s*·\s*/i, ''), 60)}`).join(' | ')}${recados.length > 8 ? ` …y ${recados.length - 8} más` : ''}${urg ? ` (${urg} urgente${urg > 1 ? 's' : ''})` : ''}`);
  if (perdidasSinRecado.length) l.push(`Perdidas sin recado (devolver): ${perdidasSinRecado.slice(0, 8).map(p => `${_quien(p)} ${hora(p.fecha)}${p.motivo ? ` (${p.motivo.toLowerCase()})` : ''}`).join(' · ')}${perdidasSinRecado.length > 8 ? ` …y ${perdidasSinRecado.length - 8} más` : ''}`);
  return l.join('\n');
}

// Para el aviso de las 8:15: perdidas sin recado desde el aviso anterior (el lunes, desde el sábado).
async function perdidasParaAviso({ ahora = new Date(), _db = null } = {}) {
  const lunes = new Date(ahora).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' }) === 'Mon';
  return (await perdidasSinRecado(new Date(ahora.getTime() - (lunes ? 48 : 24) * 3600 * 1000), ahora, { _db }))
    .map(p => ({ quien: _quien(p), cuando: diaHora(p.fecha), motivo: p.motivo || null }));
}

module.exports = { firmaValida, recibir, procesar, reintentar, manejar, perdidasSinRecado, datosDia, textoDia, perdidasParaAviso, panel, marcarDevuelta, COL, DIA };
