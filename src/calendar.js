// src/calendar.js — Integración con Google Calendar (diagnóstico + base para la sync).
// Reutiliza las MISMAS credenciales que Gmail: GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN.
//
// IMPORTANTE: para escribir/leer en Calendar, el GMAIL_REFRESH_TOKEN debe haberse
// generado CON el scope de calendario (https://www.googleapis.com/auth/calendar).
// Si el token solo tiene permisos de Gmail, diagnose() lo detecta y avisa.
//
// De momento este módulo SOLO diagnostica (lectura). La escritura de la
// planificación se añadirá en el siguiente paso, una vez confirmado el permiso.

const { google } = require('googleapis');

// Cliente OAuth autenticado con el refresh token (mismas credenciales que Gmail).
function getAuth() {
  const oauth2 = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI
  );
  oauth2.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return oauth2;
}

// Cliente de la API de Calendar v3.
function getCalendar() {
  return google.calendar({ version: 'v3', auth: getAuth() });
}

// Diagnóstico: confirma que el token tiene permiso de Calendar y lista los
// calendarios visibles con su ID y rol de acceso (para saber en cuál escribir).
async function diagnose() {
  const out = {
    ok: false,
    hasClientId:     !!process.env.GMAIL_CLIENT_ID,
    hasClientSecret: !!process.env.GMAIL_CLIENT_SECRET,
    hasRefreshToken: !!process.env.GMAIL_REFRESH_TOKEN,
    calendars: [],
    error: null,
    hint: null
  };

  if (!out.hasClientId || !out.hasClientSecret || !out.hasRefreshToken) {
    out.error = 'Faltan credenciales de Google en Railway (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN).';
    return out;
  }

  try {
    const cal = getCalendar();
    const r = await cal.calendarList.list({ maxResults: 250 });
    const items = r.data.items || [];
    out.calendars = items.map(c => ({
      id:         c.id,
      summary:    c.summary,
      primary:    !!c.primary,
      accessRole: c.accessRole   // owner / writer / reader / freeBusyReader
    }));
    out.ok = true;
    const writable = out.calendars.filter(c => c.accessRole === 'owner' || c.accessRole === 'writer');
    out.hint = `Token OK. ${out.calendars.length} calendario(s) visibles, ${writable.length} con permiso de escritura.`;
  } catch (err) {
    out.error = (err && err.message) ? err.message : String(err);
    const m = (out.error || '').toLowerCase();
    if (m.includes('insufficient') || m.includes('scope') || m.includes('forbidden') || m.includes('permission') || m.includes('access_denied')) {
      out.hint = 'El token NO tiene permiso de Calendar. Hay que regenerar el GMAIL_REFRESH_TOKEN añadiendo el scope https://www.googleapis.com/auth/calendar (con el OAuth Playground, como ya hiciste otra vez con el de Gmail).';
    } else if (m.includes('invalid_grant')) {
      out.hint = 'El refresh token no es válido o ha caducado. Hay que regenerarlo.';
    } else {
      out.hint = 'Error al contactar con Google Calendar. Revisa el mensaje de error de arriba.';
    }
  }

  return out;
}

module.exports = { getAuth, getCalendar, diagnose };

// ─────────────────────────────────────────────────────────────────
// ESCRITURA: reflejar la planificación en Google Calendar.
// Calendario destino: GCAL_CALENDAR_ID (por defecto 'primary' = el principal
// de la cuenta, que es "Planificación Corp Projects").
// ─────────────────────────────────────────────────────────────────

const TZ = 'Europe/Madrid';

function targetCalendarId() {
  return process.env.GCAL_CALENDAR_ID || 'primary';
}

// Duración por defecto de un evento con hora (minutos). Configurable.
function eventMinutes() {
  const n = parseInt(process.env.GCAL_EVENT_MINUTES || '60', 10);
  return (n > 0 && n < 1440) ? n : 60;
}

const _pad = n => String(n).padStart(2, '0');

// Construye el cuerpo del evento de Google a partir de un doc de planning.
function buildEventBody(plan) {
  // Pendiente del owner (Fase 4b): evento de DÍA COMPLETO con el texto del pendiente.
  if (plan.tipo === 'pendiente') {
    const date = String(plan.date || '').slice(0, 10);
    const next = new Date(new Date(date + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);
    return {
      summary: `📌 ${String(plan.client || 'Pendiente').trim()}`,
      description: 'Pendiente — Corp Projects Dashboard',
      start: { date }, end: { date: next },
      extendedProperties: { private: { cpPendienteId: String(plan._id || ''), cpSource: 'dashboard' } },
    };
  }
  const emoji  = plan.tipo === 'visita' ? '👤' : '🔧';
  const titulo = String(plan.client || plan.address || 'Planificación').trim();
  const worker = String(plan.workerName || 'Sin asignar').trim();
  const summary = `${emoji} ${titulo} · ${worker}`;

  const desc = [];
  desc.push(plan.tipo === 'visita' ? 'Tipo: Visita' : 'Tipo: Trabajo');
  if (plan.workOrderNumber) desc.push('Pedido: ' + plan.workOrderNumber);
  if (plan.address && plan.address !== plan.client) desc.push('Dirección: ' + plan.address);
  if (plan.nota) desc.push('Nota: ' + plan.nota);
  desc.push('— Corp Projects Dashboard');

  const body = {
    summary,
    description: desc.join('\n'),
    extendedProperties: {
      private: { cpPlanId: String(plan._id || ''), cpSource: 'dashboard' }
    }
  };

  const date = String(plan.date || '').slice(0, 10);
  const hora = String(plan.horaInicio || '').trim();

  if (/^\d{2}:\d{2}$/.test(hora)) {
    // Evento con hora. Calculamos el fin sumando la duración por defecto.
    const [hh, mm] = hora.split(':').map(Number);
    let fin = hh * 60 + mm + eventMinutes();
    if (fin > 23 * 60 + 59) fin = 23 * 60 + 59; // no cruzar medianoche
    const eh = _pad(Math.floor(fin / 60)), em = _pad(fin % 60);
    body.start = { dateTime: `${date}T${hora}:00`,      timeZone: TZ };
    body.end   = { dateTime: `${date}T${eh}:${em}:00`,  timeZone: TZ };
  } else {
    // Evento de día completo. end.date es EXCLUSIVO (día siguiente).
    const d    = new Date(date + 'T00:00:00Z');
    const next = new Date(d.getTime() + 86400000).toISOString().slice(0, 10);
    body.start = { date };
    body.end   = { date: next };
  }
  return body;
}

// Crea o actualiza el evento de una planificación. Devuelve el eventId de Google.
async function upsertEvent(plan) {
  const cal = getCalendar();
  const calendarId = targetCalendarId();
  const requestBody = buildEventBody(plan);

  if (plan.gcalEventId) {
    try {
      const r = await cal.events.update({ calendarId, eventId: plan.gcalEventId, requestBody });
      return r.data.id;
    } catch (err) {
      // Si alguien lo borró a mano en Google (404/410), lo recreamos.
      if (err && (err.code === 404 || err.code === 410)) {
        const r = await cal.events.insert({ calendarId, requestBody });
        return r.data.id;
      }
      throw err;
    }
  }
  const r = await cal.events.insert({ calendarId, requestBody });
  return r.data.id;
}

// Borra el evento de Google. Ignora si ya no existe.
async function deleteEvent(eventId) {
  if (!eventId) return;
  const cal = getCalendar();
  const calendarId = targetCalendarId();
  try {
    await cal.events.delete({ calendarId, eventId });
  } catch (err) {
    if (err && (err.code === 404 || err.code === 410)) return;
    throw err;
  }
}

module.exports = { getAuth, getCalendar, diagnose, buildEventBody, upsertEvent, deleteEvent, targetCalendarId };

// ─────────────────────────────────────────────────────────────────
// LECTURA / SONDEO: traer de Google los cambios y aplicarlos a MongoDB.
// Estrategia: sync token incremental + "último cambio gana".
// La PRIMERA pasada (sin token) solo fija el punto de partida y enlaza
// eventos que ya tienen su doc; NO importa eventos antiguos (evita duplicar).
// ─────────────────────────────────────────────────────────────────

async function _db() {
  const { db } = await require('./db').getDBLegacy();
  return db;
}

// Extrae fecha (YYYY-MM-DD) y hora (HH:MM, zona Madrid) de un evento.
function parseStart(ev) {
  if (ev.start && ev.start.date) {
    return { date: String(ev.start.date).slice(0, 10), horaInicio: '' };
  }
  if (ev.start && ev.start.dateTime) {
    const d = new Date(ev.start.dateTime);
    const f = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    });
    const p = {};
    for (const part of f.formatToParts(d)) p[part.type] = part.value;
    const hh = (p.hour === '24') ? '00' : p.hour;
    return { date: `${p.year}-${p.month}-${p.day}`, horaInicio: `${hh}:${p.minute}` };
  }
  return { date: '', horaInicio: '' };
}

// Aplica un evento de Google a la colección planning.
// allowForeignCreate=false en la pasada inicial: no crea altas de eventos ajenos.
async function applyEvent(db, ev, allowForeignCreate) {
  const { ObjectId } = require('mongodb');
  const eventId = ev.id;
  const priv = (ev.extendedProperties && ev.extendedProperties.private) || {};
  if (priv.cpSource === 'agenda' || priv.cpAgenda) return 'skip'; // agenda personal, no planning
  let doc = await db.collection('planning').findOne({ gcalEventId: eventId });
  if (!doc && priv.cpPlanId) {
    try { doc = await db.collection('planning').findOne({ _id: new ObjectId(priv.cpPlanId) }); } catch (e) {}
  }

  // Borrado en Google → borrado en el dashboard (último cambio gana).
  if (ev.status === 'cancelled') {
    if (doc) { await db.collection('planning').deleteOne({ _id: doc._id }); return 'deleted'; }
    return 'skip';
  }

  const { date, horaInicio } = parseStart(ev);
  if (!date) return 'skip';

  if (doc) {
    // Solo sincronizamos fecha y hora (lo que se mueve en el móvil).
    // Operario/obra los gestiona el dashboard y no se tocan desde el título.
    await db.collection('planning').updateOne(
      { _id: doc._id },
      { $set: { date, horaInicio, gcalEventId: eventId, gcalSyncedAt: new Date(), updatedAt: new Date() } }
    );
    return 'updated';
  }

  if (!allowForeignCreate) return 'skip';

  // Evento creado directamente en el calendario (móvil) → alta best-effort.
  const title = String(ev.summary || '(sin título)').trim();
  await db.collection('planning').insertOne({
    date, horaInicio,
    workerId: null, workerName: '', color: '#6b7280',
    tipo: 'trabajo', client: title, address: '',
    workOrderId: null, workOrderNumber: '', nota: '',
    gcalEventId: eventId, gcalSyncedAt: new Date(),
    createdAt: new Date(), updatedAt: new Date()
  });
  return 'created';
}

// Sondea Google y aplica los cambios. Devuelve un resumen.
async function pullChanges() {
  const summary = { created: 0, updated: 0, deleted: 0, skipped: 0, pages: 0, mode: null, error: null };
  let db, cal, calendarId, stateCol;
  try {
    db = await _db();
    cal = getCalendar();
    calendarId = targetCalendarId();
    stateCol = db.collection('syncState');
  } catch (err) { summary.error = err.message; return summary; }

  let state = null;
  try { state = await stateCol.findOne({ _id: 'gcal_planning' }); } catch (e) {}
  let syncToken = (state && state.syncToken) || null;
  const allowForeignCreate = !!syncToken;        // la baseline no importa ajenos
  summary.mode = syncToken ? 'incremental' : 'baseline';

  try {
    let pageToken = null, nextSyncToken = null, safety = 0;
    do {
      if (++safety > 60) { summary.error = 'Tope de páginas alcanzado'; break; }
      const params = { calendarId, singleEvents: true, maxResults: 250 };
      if (syncToken) { params.syncToken = syncToken; params.showDeleted = true; }
      else { params.timeMin = new Date(Date.now() - 60 * 86400000).toISOString(); }
      if (pageToken) params.pageToken = pageToken;

      let resp;
      try {
        resp = await cal.events.list(params);
      } catch (err) {
        if (err && err.code === 410) {           // token caducado → resync completo
          syncToken = null; pageToken = null; nextSyncToken = null;
          summary.mode = 'baseline (resync)';
          await stateCol.updateOne({ _id: 'gcal_planning' }, { $set: { syncToken: null } }, { upsert: true });
          continue;
        }
        throw err;
      }

      for (const ev of (resp.data.items || [])) {
        const res = await applyEvent(db, ev, !!syncToken);
        if (res === 'created') summary.created++;
        else if (res === 'updated') summary.updated++;
        else if (res === 'deleted') summary.deleted++;
        else summary.skipped++;
      }
      summary.pages++;
      pageToken = resp.data.nextPageToken || null;
      if (resp.data.nextSyncToken) nextSyncToken = resp.data.nextSyncToken;
    } while (pageToken);

    if (nextSyncToken) {
      await stateCol.updateOne({ _id: 'gcal_planning' }, { $set: { syncToken: nextSyncToken, updatedAt: new Date() } }, { upsert: true });
    }
  } catch (err) {
    summary.error = err.message;
  }
  return summary;
}

// Agenda personal dictada por WhatsApp (Fase 1 del agente). NO es planificación de
// operarios: se etiqueta cpSource:'agenda' para que applyEvent la ignore (arriba).
// date: 'YYYY-MM-DD'. hora: 'HH:MM' (opcional; sin ella = día completo).
async function crearEventoPersonal({ date, hora, titulo }) {
  const cal = getCalendar();
  const calendarId = targetCalendarId();
  const summary = `🗓️ ${String(titulo || 'Recordatorio').trim()}`;
  const body = {
    summary,
    description: 'Agenda personal — vía asistente de WhatsApp',
    extendedProperties: { private: { cpSource: 'agenda', cpAgenda: '1' } },
  };
  if (/^\d{1,2}:\d{2}$/.test(String(hora || ''))) {
    const [hh, mm] = String(hora).split(':').map(Number);
    let fin = hh * 60 + mm + eventMinutes();
    if (fin > 23 * 60 + 59) fin = 23 * 60 + 59;
    const eh = _pad(Math.floor(fin / 60)), em = _pad(fin % 60);
    const h0 = `${_pad(hh)}:${_pad(mm)}`;
    body.start = { dateTime: `${date}T${h0}:00`,       timeZone: TZ };
    body.end   = { dateTime: `${date}T${eh}:${em}:00`, timeZone: TZ };
  } else {
    const d    = new Date(date + 'T00:00:00Z');
    const next = new Date(d.getTime() + 86400000).toISOString().slice(0, 10);
    body.start = { date };
    body.end   = { date: next };
  }
  const r = await cal.events.insert({ calendarId, requestBody: body });
  return r.data.id;
}

// Eventos de HOY en el calendario objetivo (Europe/Madrid). Read-only, best-effort
// (devuelve [] si el calendario falla). hoyISO opcional (para tests / claridad).
async function eventosDeHoy(hoyISO = null) {
  try {
    const cal = getCalendar();
    const calendarId = targetCalendarId();
    const dia = hoyISO || new Date().toLocaleDateString('en-CA', { timeZone: TZ });
    const base = new Date(dia + 'T00:00:00Z').getTime();
    const prev = new Date(base - 86400000).toISOString().slice(0, 10);
    const next = new Date(base + 86400000).toISOString().slice(0, 10);
    const resp = await cal.events.list({
      calendarId, singleEvents: true, orderBy: 'startTime', maxResults: 50,
      timeMin: prev + 'T00:00:00Z', timeMax: next + 'T23:59:59Z',
    });
    const enMadrid = (dt) => new Date(dt).toLocaleDateString('en-CA', { timeZone: TZ });
    return (resp.data.items || [])
      .filter(ev => { const s = ev.start || {}; return s.date ? s.date === dia : (s.dateTime ? enMadrid(s.dateTime) === dia : false); })
      .map(ev => {
        const s = ev.start || {};
        const hora = s.dateTime ? new Date(s.dateTime).toLocaleTimeString('es-ES', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : null;
        return { summary: ev.summary || '(sin título)', hora };
      });
  } catch (e) { console.error('[Calendar] eventosDeHoy:', e.message); return []; }
}

module.exports = { getAuth, getCalendar, diagnose, buildEventBody, upsertEvent, deleteEvent, targetCalendarId, pullChanges, eventosDeHoy, crearEventoPersonal };
