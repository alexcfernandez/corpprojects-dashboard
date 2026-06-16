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
