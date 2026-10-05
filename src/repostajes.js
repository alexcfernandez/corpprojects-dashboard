// src/repostajes.js — Combustible de cada vehículo y sus kilómetros.
//   · Capturas de la app Bonpreu Esclat Mobilitat: la IA lee cada tiquet con su vehículo
//     («Ticket 4063A0321313 · Citroën berlingo»). En la factura quincenal de Esclat esa línea sale como
//     «Tiquet 321313 (18-09-2026)» de la planta 4063: es el mismo tiquet, así se sabe de qué vehículo es.
//   · El trabajador apunta desde la app de fichar que ha repostado (con los km) y, una vez a la semana,
//     los km de la furgoneta que lleva.
//   · En Compras, cada línea de una factura de combustible va a su vehículo (propuesta automática).
//   · Con los km y el gasto: €/km y litros a los 100 en la ficha del vehículo.
// Colecciones: repostajes {vehiculoId, fecha, hora, ticket, numTicket, planta, alias, importe, litros, km,
//   origen: esclat_app | trabajador | oficina, compraId, lineaIdx, por} · vehiculoKm {vehiculoId, fecha, km, origen, por}.
'use strict';
const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const fechaOk = s => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : null);
const num = v => (v === '' || v == null || isNaN(Number(String(v).replace(',', '.'))) ? null : Number(String(v).replace(',', '.')));
const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
const dias = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);
function _oid(id) { try { return new ObjectId(String(id)); } catch (e) { throw new Error('Vehículo no válido'); } }

// «4063A0321313» → { planta: '4063', num: '321313' }; «321313» → { planta: null, num: '321313' }
function partesTicket(t) {
  const s = String(t || '').toUpperCase().replace(/\s+/g, '');
  const m = /^(\d{3,5})[A-Z]+0*(\d+)$/.exec(s);
  if (m) return { ticket: s, planta: m[1], num: m[2] };
  const d = s.replace(/\D/g, '').replace(/^0+/, '');
  return { ticket: s, planta: null, num: d || null };
}
// Línea de factura de gasolinera: «GAS-OIL A 1 LT - Tiquet 321313 (18-09-2026)»
function leerLinea(l) {
  const t = String(l.descripcion || '');
  const mt = /ti[qc]u?[ek]?e?t\s*:?\s*([A-Z0-9]+)/i.exec(t);
  const mf = /(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(t);
  const fecha = mf ? `${mf[3].length === 2 ? '20' + mf[3] : mf[3]}-${mf[2].padStart(2, '0')}-${mf[1].padStart(2, '0')}` : null;
  const combustible = /gas-?oil|gasoil|diesel|di[eé]sel|gas[oó]leo/i.test(t) ? 'diésel' : /gasolina|s\/?plom|sin plomo|\b9[58]\b/i.test(t) ? 'gasolina' : /adblue/i.test(t) ? 'adblue' : null;
  const litros = /^l(t|ts|itros?)?$/i.test(String(l.unidad || '').trim()) || /\bLT\b|litros/i.test(t) ? num(l.cantidad) : null;
  return { ticket: mt ? partesTicket(mt[1]) : null, fecha: fechaOk(fecha), combustible, litros };
}
const esCombustible = c => (c.lineas || []).filter(l => { const x = leerLinea(l); return x.ticket || x.combustible; }).length >= 1;

// ── CAPTURAS DE LA APP ESCLAT (IA) ──
const HERRAMIENTA = {
  name: 'tiquets_esclat',
  description: 'Tiquets de repostaje que se ven en las capturas de la app Bonpreu Esclat Mobilitat',
  input_schema: { type: 'object', properties: { tiquets: { type: 'array', items: { type: 'object', properties: {
    fecha: { type: 'string', description: 'YYYY-MM-DD' }, hora: { type: 'string', description: 'HH:MM' }, ticket: { type: 'string', description: 'tal cual, p. ej. 4063A0315452' },
    vehiculo: { type: 'string', description: 'texto de «Vehículo:» tal cual' }, importe: { type: ['number', 'null'] }, litros: { type: ['number', 'null'] }, km: { type: ['number', 'null'] } }, required: ['ticket'] } } }, required: ['tiquets'] },
};
async function _leerIA(archivos) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) throw new Error('ANTHROPIC_API_KEY no configurada');
  const content = archivos.slice(0, 10).map(a => /pdf/i.test(a.mimetype || '')
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.buffer.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: a.mimetype || 'image/jpeg', data: a.buffer.toString('base64') } });
  content.push({ type: 'text', text: 'Son capturas de la app de la tarjeta de gasolinera (Bonpreu Esclat Mobilitat). Devuelve TODOS los tiquets que se vean, cada uno con su fecha (el año sale en la cabecera del mes o en la fecha «14/9/26» = 2026-09-14), hora, número de ticket exacto y el texto de «Vehículo». Si la captura muestra el detalle de un tiquet con importe, litros o km, ponlos; si no, null. No inventes tiquets que no se vean.' });
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 90000);
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: c.signal, headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: require('./config').ia.vision, max_tokens: 4000, tools: [HERRAMIENTA], tool_choice: { type: 'tool', name: HERRAMIENTA.name }, messages: [{ role: 'user', content }] }) }).finally(() => clearTimeout(t));
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || 'La IA no respondió');
  const tu = (j.content || []).find(x => x.type === 'tool_use');
  return (tu && Array.isArray(tu.input.tiquets)) ? tu.input.tiquets : [];
}
// Vehículo por el nombre que tiene en la app (aliasEsclat, o parecido al nombre / matrícula de la ficha).
function vehiculoPorAlias(vs, alias) {
  const a = norm(alias); if (!a) return null;
  return vs.find(v => (v.aliasEsclat || []).some(x => norm(x) === a))
    || vs.find(v => v.matricula && a.replace(/[^a-z0-9]/g, '').includes(String(v.matricula).toLowerCase()))
    || vs.find(v => norm(v.nombre) === a) || null;
}
async function guardarCapturas(archivos, por) {
  if (!archivos || !archivos.length) throw new Error('Sube alguna captura');
  const leidos = await _leerIA(archivos);
  const db = await getDB();
  const vs = await db.collection('vehiculos').find({}).project({ nombre: 1, matricula: 1, aliasEsclat: 1 }).toArray();
  let nuevos = 0; const filas = [];
  for (const x of leidos) {
    const p = partesTicket(x.ticket); if (!p.num) continue;
    const v = vehiculoPorAlias(vs, x.vehiculo);
    const set = { ticket: p.ticket, planta: p.planta, numTicket: p.num, alias: String(x.vehiculo || '').trim().slice(0, 60) || null, fecha: fechaOk(x.fecha), hora: /^\d{1,2}:\d{2}$/.test(String(x.hora || '')) ? x.hora : null, actualizado: new Date() };
    if (num(x.importe) != null) set.importe = r2(num(x.importe));
    if (num(x.litros) != null) set.litros = r2(num(x.litros));
    if (num(x.km) != null) set.km = Math.round(num(x.km));
    if (v) set.vehiculoId = String(v._id);
    // Mismo repostaje que ya llegó por correo (misma fecha y hora): se completa ese, no se duplica.
    if (set.fecha && set.hora && !(await db.collection('repostajes').findOne({ ticket: p.ticket }))) {
      const delCorreo = (await db.collection('repostajes').find({ fecha: set.fecha, ticket: null, gmailId: { $ne: null } }).toArray()).find(r => _cerca(r, set));
      if (delCorreo) { const s2 = { ...set }; delete s2.hora; if (delCorreo.vehiculoId) delete s2.vehiculoId; await db.collection('repostajes').updateOne({ _id: delCorreo._id }, { $set: s2 }); filas.push({ ...set, vehiculo: v ? v.nombre : null }); continue; }
    }
    const r = await db.collection('repostajes').updateOne({ ticket: p.ticket }, { $set: set, $setOnInsert: { origen: 'esclat_app', creado: new Date(), por: por || '' } }, { upsert: true });
    if (r.upsertedCount) nuevos++;
    filas.push({ ...set, vehiculo: v ? v.nombre : null });
  }
  const sinVehiculo = [...new Set(filas.filter(f => !f.vehiculoId && f.alias).map(f => f.alias))];
  return { leidos: filas.length, nuevos, filas, sinVehiculo };
}

// ── KILÓMETROS ──
async function ultimaLectura(db, vehiculoId) {
  return db.collection('vehiculoKm').find({ vehiculoId: String(vehiculoId) }).sort({ fecha: -1, km: -1 }).limit(1).next();
}
async function apuntarKm(vehiculoId, km, { fecha, origen = 'oficina', por = '', workerId = null, repostajeId = null } = {}) {
  const db = await getDB();
  const v = await db.collection('vehiculos').findOne({ _id: _oid(vehiculoId) }, { projection: { nombre: 1, km: 1 } });
  if (!v) throw new Error('Vehículo no encontrado');
  const k = Math.round(num(km));
  if (!(k > 0) || k > 2000000) throw new Error('Pon los km que marca el cuentakilómetros');
  const f = fechaOk(fecha) || hoy();
  const ult = await ultimaLectura(db, vehiculoId);
  if (ult && f >= ult.fecha) {
    if (k < ult.km) throw new Error(`Son menos km que la última vez (${ult.km.toLocaleString('es-ES')} km el ${ult.fecha.split('-').reverse().join('/')}). Revisa el número.`);
    if (k - ult.km > 1500 * Math.max(1, dias(ult.fecha, f))) throw new Error(`Son ${(k - ult.km).toLocaleString('es-ES')} km más que la última vez: revisa el número.`);
  }
  await db.collection('vehiculoKm').insertOne({ vehiculoId: String(v._id), fecha: f, km: k, origen, por: por || '', workerId: workerId ? String(workerId) : null, creado: new Date() });
  if (!ult || f >= ult.fecha) await db.collection('vehiculos').updateOne({ _id: v._id }, { $set: { km: k, kmFecha: f, kmPor: por || '' } });
  if (repostajeId && /^[a-f0-9]{24}$/.test(String(repostajeId))) await db.collection('repostajes').updateOne({ _id: new ObjectId(String(repostajeId)), vehiculoId: String(v._id) }, { $set: { km: k } });
  return { ok: true, vehiculo: v.nombre, km: k, fecha: f };
}
// Repostaje apuntado a mano (trabajador desde la app de fichar u oficina).
async function registrar({ vehiculoId, km, importe, litros, fecha, workerId, workerName, origen = 'trabajador', por } = {}) {
  const db = await getDB();
  const v = await db.collection('vehiculos').findOne({ _id: _oid(vehiculoId) }, { projection: { nombre: 1 } });
  if (!v) throw new Error('Elige el vehículo');
  const f = fechaOk(fecha) || hoy();
  if (km != null && km !== '') await apuntarKm(vehiculoId, km, { fecha: f, origen: 'repostaje', por: por || workerName || '', workerId });
  const doc = { vehiculoId: String(v._id), fecha: f, hora: new Date().toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' }),
    importe: num(importe) != null ? r2(num(importe)) : null, litros: num(litros) != null ? r2(num(litros)) : null, km: num(km) != null ? Math.round(num(km)) : null,
    origen, workerId: workerId ? String(workerId) : null, workerName: workerName || null, por: por || workerName || '', creado: new Date() };
  await db.collection('repostajes').insertOne(doc);
  return { ok: true, vehiculo: v.nombre };
}

// Para la app de fichar: los vehículos (sin nada de dinero) y si toca apuntar los km de la suya.
async function paraTrabajador(workerId) {
  const db = await getDB();
  const vs = await db.collection('vehiculos').find({ estado: 'activo' }).project({ nombre: 1, matricula: 1, conductor: 1, km: 1, kmFecha: 1 }).sort({ nombre: 1 }).toArray();
  const h = hoy();
  const lista = vs.map(v => ({ id: String(v._id), nombre: v.nombre, matricula: v.matricula || '', mio: !!(v.conductor && String(v.conductor.userId) === String(workerId)), km: v.km || null, kmFecha: v.kmFecha || null }));
  const mios = lista.filter(v => v.mio).map(v => v.id);
  const sinKm = mios.length ? await db.collection('repostajes').find({ vehiculoId: { $in: mios }, km: null, fecha: { $gte: addDias(h, -3) } }).sort({ fecha: -1 }).limit(3).toArray() : [];
  const pideKm = lista.filter(v => v.mio && (!v.kmFecha || dias(v.kmFecha, h) >= 7 || sinKm.some(r => r.vehiculoId === v.id && (!v.kmFecha || v.kmFecha < r.fecha))))
    .map(v => ({ ...v, repostaje: (r => r ? { id: String(r._id), fecha: r.fecha, hora: r.hora || null } : null)(sinKm.find(r => r.vehiculoId === v.id)) }));
  return { vehiculos: lista, pideKm };
}

// ── LÍNEAS DE FACTURA → VEHÍCULO ──
// Por cada línea: 1) tiquet visto en la app Esclat (o apuntado con su nº), 2) repostaje que apuntó un
// trabajador ese día por el mismo importe, 3) si solo un vehículo gasta ese combustible, ese.
async function propuestaLineas(compra) {
  const db = await getDB();
  const lineas = (compra.lineas || []).map((l, i) => ({ i, l, x: leerLinea(l) }));
  const nums = lineas.map(o => o.x.ticket && o.x.ticket.num).filter(Boolean);
  const fechas = lineas.map(o => o.x.fecha).filter(Boolean).sort();
  const desde = fechas[0] || compra.fecha, hasta = fechas[fechas.length - 1] || compra.fecha;
  const [vs, reps] = await Promise.all([
    db.collection('vehiculos').find({}).project({ nombre: 1, matricula: 1, combustible: 1, estado: 1, aliasEsclat: 1 }).toArray(),
    db.collection('repostajes').find({ $or: [{ numTicket: { $in: nums } }, ...(desde ? [{ fecha: { $gte: desde, $lte: hasta || desde } }] : [])] }).toArray(),
  ]);
  const activos = vs.filter(v => v.estado !== 'baja');
  const nombre = id => { const v = vs.find(x => String(x._id) === String(id)); return v ? v.nombre : null; };
  const usados = new Set();
  return lineas.map(({ i, l, x }) => {
    const out = { idx: i, ticket: x.ticket ? x.ticket.ticket : null, fecha: x.fecha, combustible: x.combustible, litros: x.litros, vehiculoId: l.vehiculoId || null, motivo: l.vehiculoId ? 'elegido' : null, alias: null };
    if (x.ticket && x.ticket.num) {
      const r = reps.find(r => r.numTicket === x.ticket.num && (!x.fecha || !r.fecha || Math.abs(dias(r.fecha, x.fecha)) <= 2));
      if (r) {
        out.alias = r.alias || null; usados.add(String(r._id));
        if (!out.vehiculoId && r.vehiculoId) { out.vehiculoId = r.vehiculoId; out.motivo = r.origen === 'esclat_app' ? `app Esclat: «${r.alias || nombre(r.vehiculoId)}»` : 'tiquet apuntado'; }
      }
    }
    if (!out.vehiculoId && x.fecha && l.importe != null) {
      const r = reps.find(r => !usados.has(String(r._id)) && r.vehiculoId && r.importe != null && r.fecha && Math.abs(dias(r.fecha, x.fecha)) <= 1
        && (Math.abs(r.importe - l.importe) <= 0.1 || Math.abs(r.importe - l.importe * 1.21) <= 0.5));
      if (r) { usados.add(String(r._id)); out.vehiculoId = r.vehiculoId; out.motivo = r.gmailId ? `correo de Esclat de las ${r.hora || '?'} (${String(r.importe).replace('.', ',')} €)` : `${r.workerName || 'alguien'} apuntó ${String(r.importe).replace('.', ',')} € ese día`; }
    }
    if (!out.vehiculoId && x.combustible && !out.alias) {
      const mismo = activos.filter(v => v.combustible === x.combustible);
      if (mismo.length === 1) { out.vehiculoId = String(mismo[0]._id); out.motivo = `es el único de ${x.combustible}`; }
    }
    if (out.vehiculoId) out.vehiculo = nombre(out.vehiculoId);
    return out;
  });
}

// Al confirmar la factura: cada tiquet queda unido a su línea (litros e importe sin IVA) y, si en la app
// tenía un nombre que aún no conocíamos, se aprende para la próxima.
async function alConfirmar(compra) {
  const db = await getDB();
  const prop = await propuestaLineas(compra);
  let aprendidos = 0;
  for (const p of prop) {
    const l = (compra.lineas || [])[p.idx]; if (!l || !l.vehiculoId || !p.ticket) continue;
    const t = partesTicket(p.ticket);
    const r = await db.collection('repostajes').findOne({ numTicket: t.num, ...(p.fecha ? { fecha: { $gte: addDias(p.fecha, -2), $lte: addDias(p.fecha, 2) } } : {}) });
    const set = { compraId: String(compra._id), lineaIdx: p.idx, vehiculoId: l.vehiculoId, importeFactura: l.importe != null ? r2(l.importe) : null, ...(p.litros != null ? { litros: p.litros } : {}) };
    if (r) {
      await db.collection('repostajes').updateOne({ _id: r._id }, { $set: set });
      if (r.alias) { const u = await db.collection('vehiculos').updateOne({ _id: _oid(l.vehiculoId), aliasEsclat: { $ne: r.alias } }, { $addToSet: { aliasEsclat: r.alias } }); aprendidos += u.modifiedCount; }
    } else {
      await db.collection('repostajes').insertOne({ ...set, ticket: t.ticket, planta: t.planta, numTicket: t.num, fecha: p.fecha || compra.fecha, origen: 'factura', creado: new Date() });
    }
  }
  return { aprendidos };
}
function addDias(f, n) { const d = new Date(f + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

// ── CORREO DE ESCLAT EN CADA REPOSTAJE ──
// «Subministrament Completat | App Mobilitat»: Import: 100,00 · Establiment: EsclatOil Girona I ·
// Data i hora: 05/10/2026 10:59. Trae el importe con IVA y la hora exacta, pero no el vehículo: se
// pregunta a oficina con un enlace (un toque) y después se piden los km a quien lleva ese vehículo.
function leerCorreoEsclat(asunto, cuerpo) {
  const t = `${asunto || ''} ${cuerpo || ''}`.replace(/\*/g, ' ').replace(/\s+/g, ' ');
  if (!/subministrament|suministro|app de mobilitat|movilidad/i.test(t)) return null;
  const mi = /Import\w*\s*:\s*([\d.]*\d(?:,\d{1,2})?)/i.exec(t);
  const mf = /Data i hora\s*:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}:\d{2})/i.exec(t) || /Fecha y hora\s*:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}:\d{2})/i.exec(t);
  if (!mi || !mf) return null;
  const me = /Establiment\s*:\s*(.+?)\s+(?:Data i hora|Fecha)/i.exec(t) || /Establecimiento\s*:\s*(.+?)\s+Fecha/i.exec(t);
  return { importe: r2(Number(mi[1].replace(/\./g, '').replace(',', '.'))), establecimiento: me ? me[1].trim().slice(0, 60) : null,
    fecha: `${mf[3]}-${mf[2].padStart(2, '0')}-${mf[1].padStart(2, '0')}`, hora: mf[4].padStart(5, '0') };
}
const _min = h => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(h || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const _cerca = (a, b, n = 3) => a.fecha === b.fecha && _min(a.hora) != null && _min(b.hora) != null && Math.abs(_min(a.hora) - _min(b.hora)) <= n;
const URL_BASE = () => (process.env.DASHBOARD_URL || 'https://dashboard.corpprojects.es').replace(/\/$/, '');
async function desdeCorreo({ gmailId, importe, establecimiento, fecha, hora }, { avisar = true } = {}) {
  const db = await getDB();
  if (await db.collection('repostajes').findOne({ gmailId })) return { ya: true };
  const base = { gmailId, importe, establecimiento, fecha, hora, actualizado: new Date() };
  // ¿Ya está por la captura de la app (misma hora) o porque lo apuntó el trabajador (mismo importe ese día)?
  const mismoDia = await db.collection('repostajes').find({ fecha, gmailId: null }).toArray();
  const igual = mismoDia.find(r => r.origen === 'esclat_app' && _cerca(r, base))
    || mismoDia.find(r => r.origen === 'trabajador' && r.importe != null && Math.abs(r.importe - importe) <= 0.5);
  let id;
  if (igual) { await db.collection('repostajes').updateOne({ _id: igual._id }, { $set: { ...base, ...(igual.origen === 'trabajador' ? { hora } : {}) } }); id = igual._id; }
  else id = (await db.collection('repostajes').insertOne({ ...base, origen: 'esclat_email', vehiculoId: null, creado: new Date() })).insertedId;
  const r = await db.collection('repostajes').findOne({ _id: id });
  if (avisar && !r.vehiculoId) {
    const url = `${URL_BASE()}/vehiculos#repostaje=${id}`;
    const txt = `⛽ Repostaje de ${String(importe.toFixed(2)).replace('.', ',')} € en ${establecimiento || 'Esclat'} (${fecha.split('-').reverse().slice(0, 2).join('/')} a las ${hora}). ¿De qué vehículo es?\n${url}`;
    try { await require('./notifications').sendWhatsApp(txt); } catch (e) { console.warn('[Repostajes] WhatsApp:', e.message); }
    try { await require('./push').sendToOficina({ title: '⛽ ¿De qué vehículo es este repostaje?', body: txt.split('\n')[0], url: `/vehiculos#repostaje=${id}`, tag: 'repostaje-' + id }); } catch (e) {}
  }
  return { id: String(id), vehiculoId: r.vehiculoId || null, unido: !!igual };
}
// Correos de septiembre en adelante que no entraron (el programa no los leía aún). Sin avisos.
async function recuperarCorreos({ desde = '2026-09-01' } = {}) {
  const ei = require('./email-intelligence');
  const gmail = ei.getGmailClient();
  const q = `from:bonpreu.cat (subject:Subministrament OR subject:Suministro) after:${desde.replace(/-/g, '/')}`;
  let pageToken, n = 0, nuevos = 0;
  do {
    const res = await gmail.users.messages.list({ userId: 'me', q, maxResults: 100, pageToken });
    for (const m of res.data.messages || []) {
      n++;
      const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
      const h = msg.data.payload.headers || [];
      const dato = leerCorreoEsclat((h.find(x => x.name === 'Subject') || {}).value, ei.extractBody(msg.data.payload));
      if (dato) { const r = await desdeCorreo({ ...dato, gmailId: m.id }, { avisar: false }); if (!r.ya) nuevos++; }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken && n < 500);
  return { correos: n, nuevos };
}
// Oficina dice de qué vehículo es; se le piden los km a quien lo lleva (push con enlace a su app).
async function asignar(id, vehiculoId, por) {
  const db = await getDB();
  let rid; try { rid = new ObjectId(String(id)); } catch (e) { throw new Error('Repostaje no válido'); }
  const r = await db.collection('repostajes').findOne({ _id: rid });
  if (!r) throw new Error('Repostaje no encontrado');
  const v = await db.collection('vehiculos').findOne({ _id: _oid(vehiculoId) }, { projection: { nombre: 1, conductor: 1 } });
  if (!v) throw new Error('Elige el vehículo');
  await db.collection('repostajes').updateOne({ _id: rid }, { $set: { vehiculoId: String(v._id), asignadoPor: por || '', asignadoAt: new Date() } });
  let pedidoKm = false;
  if (v.conductor && v.conductor.userId && r.km == null) {
    try { pedidoKm = (await require('./push').sendToWorker(v.conductor.userId, { title: `⛽ ¿Cuántos km marca la ${v.nombre}?`, body: 'Apúntalo en tu app al repostar: así sabemos lo que gasta.', url: '/fichar#km', tag: 'km-' + v._id })) > 0; } catch (e) {}
  }
  return { ok: true, vehiculo: v.nombre, conductor: v.conductor ? v.conductor.name : null, pedidoKm };
}
async function pendientes() {
  const db = await getDB();
  const desde = addDias(hoy(), -60);
  const rs = await db.collection('repostajes').find({ vehiculoId: null, fecha: { $gte: desde } }).sort({ fecha: -1, hora: -1 }).limit(100).toArray();
  return rs.map(r => ({ id: String(r._id), fecha: r.fecha, hora: r.hora || null, importe: r.importe, establecimiento: r.establecimiento || null, alias: r.alias || null, ticket: r.ticket || null, origen: r.origen }));
}

// ── €/km EN LA FICHA ──
// Desde la primera lectura de km: km hechos, gasto de ese periodo, €/km y litros a los 100.
async function resumenKm(vehiculoId) {
  const db = await getDB();
  const id = String(vehiculoId);
  const [lect, reps] = await Promise.all([
    db.collection('vehiculoKm').find({ vehiculoId: id }).sort({ fecha: 1, km: 1 }).toArray(),
    db.collection('repostajes').find({ vehiculoId: id }).sort({ fecha: -1, hora: -1 }).limit(40).toArray(),
  ]);
  const out = { lecturas: lect.slice(-15).reverse().map(l => ({ fecha: l.fecha, km: l.km, origen: l.origen, por: l.por })), repostajes: reps.map(r => ({ fecha: r.fecha, hora: r.hora || null, ticket: r.ticket || null, alias: r.alias || null, importe: r.importeFactura != null ? r.importeFactura : r.importe, conIva: r.importeFactura == null && r.importe != null, litros: r.litros || null, km: r.km || null, origen: r.origen, quien: r.workerName || null, enFactura: !!r.compraId })) };
  if (lect.length >= 2) {
    const a = lect[0], b = lect[lect.length - 1];
    const km = b.km - a.km;
    if (km > 0) {
      const gs = (await require('./vehiculos').gastos({ desde: a.fecha, hasta: b.fecha })).filter(g => g.vehiculoId === id);
      const gasto = r2(gs.reduce((s, g) => s + g.importe, 0));
      const litros = r2(gs.reduce((s, g) => s + (g.litros || 0), 0));
      Object.assign(out, { desde: a.fecha, hasta: b.fecha, km, gasto, eurKm: r2(gasto / km * 100) / 100, litros, l100: litros ? r2(litros / km * 100) : null,
        combustible: r2(gs.filter(g => g.categoria === 'combustible').reduce((s, g) => s + g.importe, 0)) });
    }
  }
  return out;
}

module.exports = { leerCorreoEsclat, desdeCorreo, recuperarCorreos, asignar, pendientes, partesTicket, leerLinea, esCombustible, vehiculoPorAlias, guardarCapturas, apuntarKm, registrar, paraTrabajador, propuestaLineas, alConfirmar, resumenKm };
