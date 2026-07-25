// src/pendientes.js — Pendientes / recordatorios del owner ("no me lo dejes olvidar").
//
// PRINCIPIO: NO se inventan fechas. Se detecta una fecha EXPLÍCITA opcional; si la
// frase parece llevar fecha pero es ambigua → se pregunta (no se asume). Sin fecha
// → para:null (aparece cada mañana). Cálculo en Europe/Madrid, próxima ocurrencia.
//
// No choca con las notas de comunidad (comunidades.js): las notas requieren
// "apunta/anota … EN <comunidad>"; los pendientes usan verbos propios.
//
// Fecha → Google Calendar (reutiliza src/calendar.js): un pendiente CON fecha crea
// un evento (upsertEvent, guarda gcalEventId) y al cerrarlo lo borra (deleteEvent).
// Best-effort: si el calendario falla, el pendiente se guarda igual.

const COL = 'pendientes';
async function getDB() { return require('./db').getDB(); }
function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim(); }

// "Hoy" en Europe/Madrid como 'YYYY-MM-DD' (para producción; en test se inyecta).
function hoyMadridISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
}

// ── Almacén ──────────────────────────────────────────────────────
async function addPendiente(texto, from, { para = null } = {}) {
  const t = String(texto || '').trim();
  if (!t) return null;
  const db = await getDB();
  const doc = {
    texto: t, from: String(from || ''), estado: 'abierto', createdAt: new Date(),
    para: para ? new Date(para + 'T00:00:00Z') : null, paraISO: para || null, gcalEventId: null,
  };
  const r = await db.collection(COL).insertOne(doc);
  const id = String(r.insertedId);

  // Evento de calendario SOLO si hay fecha. Best-effort: no romper si falla.
  if (para) {
    try {
      const eventId = await require('./calendar').upsertEvent({ tipo: 'pendiente', client: t, date: para, _id: id });
      if (eventId) { await db.collection(COL).updateOne({ _id: r.insertedId }, { $set: { gcalEventId: eventId } }); doc.gcalEventId = eventId; }
    } catch (e) { console.error('[Pendientes] calendar upsert:', e.message); }
  }
  return { id, ...doc };
}

async function listPendientes({ soloAbiertos = true } = {}) {
  const db = await getDB();
  const q = soloAbiertos ? { estado: 'abierto' } : {};
  return db.collection(COL).find(q).sort({ createdAt: 1 }).toArray();
}

// Cierra por índice 1-based (el número que se muestra) o por id. Borra su evento.
async function cerrarPendiente({ idx = null, id = null } = {}) {
  const db = await getDB();
  let doc = null;
  if (id) {
    try { const { ObjectId } = require('mongodb'); doc = await db.collection(COL).findOne({ _id: new ObjectId(id) }); } catch (e) {}
  } else if (idx != null) {
    const abiertos = await listPendientes({ soloAbiertos: true });
    doc = abiertos[idx - 1] || null;
  }
  if (!doc) return null;
  await db.collection(COL).updateOne({ _id: doc._id }, { $set: { estado: 'hecho', doneAt: new Date() } });
  if (doc.gcalEventId) {
    try { await require('./calendar').deleteEvent(doc.gcalEventId); }
    catch (e) { console.error('[Pendientes] calendar delete:', e.message); }
  }
  return { id: String(doc._id), texto: doc.texto };
}

// ── Formato del resumen diario (colector). Marca vencido/hoy/futuro/sin fecha. ──
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
function isoToDate(iso) { return new Date(iso + 'T00:00:00Z'); }
function fechaCorta(iso) { const d = isoToDate(iso); return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()}`; }

function lineaPendiente(p, i, hoyISO) {
  const pi = p.paraISO || (p.para ? new Date(p.para).toISOString().slice(0, 10) : null);
  let marca = '•';
  if (pi && pi < hoyISO) marca = '⚠️ vencido';
  else if (pi && pi === hoyISO) marca = '📌 vence hoy';
  else if (pi) marca = `📅 ${fechaCorta(pi)}`;
  return `${i + 1}. ${p.texto}${pi ? ` — ${marca}` : ''}`;
}

async function seccionResumen(hoyISO = hoyMadridISO()) {
  const abiertos = await listPendientes({ soloAbiertos: true }).catch(() => []);
  if (!abiertos.length) return null;
  const orden = abiertos.slice().sort((a, b) => {
    const pa = a.paraISO || '9999', pb = b.paraISO || '9999';
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });
  const lineas = orden.map((p, i) => lineaPendiente(p, i, hoyISO)).join('\n');
  return `📌 *Pendientes* (${abiertos.length}):\n${lineas}\n_Para cerrar uno: "hecho el pendiente 1"._`;
}

// ── Parser de fecha (PURO, testeable). hoyISO = 'YYYY-MM-DD'. ─────
// Devuelve { iso } si hay fecha clara, { ambiguo:true } si parece fecha pero no se
// puede resolver, o null si no hay ninguna mención de fecha. `quitar` = regex para
// borrar la muletilla de fecha del texto (conservando el resto tal cual).
function parseFecha(texto, hoyISO) {
  const n = norm(texto);
  const base = isoToDate(hoyISO).getTime();
  const add = (days) => new Date(base + days * 86400000).toISOString().slice(0, 10);
  const dow = isoToDate(hoyISO).getUTCDay();

  if (/\bpasado( manana)?\b/.test(n)) return { iso: add(2), quitar: /\bpasado( ma[nñ]ana)?\b/i };
  if (/\bmanana\b/.test(n))           return { iso: add(1), quitar: /\bma[nñ]ana\b/i };
  if (/\bhoy\b/.test(n))              return { iso: add(0), quitar: /\bhoy\b/i };

  let m = n.match(/\ben (\d{1,3}) dias?\b/);
  if (m) return { iso: add(parseInt(m[1], 10)), quitar: /\ben \d{1,3} d[ií]as?\b/i };

  m = n.match(/\ben (una|dos|tres) semanas?\b/);
  if (m) return { iso: add(7 * { una: 1, dos: 2, tres: 3 }[m[1]]), quitar: /\ben (una|dos|tres) semanas?\b/i };

  if (/\b((la |esta )?(proxima|siguiente) semana|(la )?semana que viene)\b/.test(n))
    return { iso: add(7), quitar: /\b((la |esta )?(pr[oó]xima|siguiente) semana|(la )?semana que viene)\b/i };

  const DIAS_N = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };
  for (const [name, d] of Object.entries(DIAS_N)) {
    if (new RegExp('\\b(el |este |proximo )?' + name + '\\b').test(n)) {
      let delta = (d - dow + 7) % 7; if (delta === 0) delta = 7; // próxima ocurrencia
      return { iso: add(delta), quitar: new RegExp('\\b(el |este |pr[oó]ximo )?' + name + '\\b', 'i') };
    }
  }

  m = n.match(/\bel (dia )?(\d{1,2})\b/);
  if (m) {
    const D = parseInt(m[2], 10);
    if (D < 1 || D > 31) return { ambiguo: true };
    const todayD = parseInt(hoyISO.slice(8, 10), 10);
    if (D >= todayD) {
      const iso = `${hoyISO.slice(0, 7)}-${String(D).padStart(2, '0')}`;
      if (isoToDate(iso).getUTCDate() !== D) return { ambiguo: true }; // p.ej. 31 en mes de 30
      return { iso, quitar: /\bel (d[ií]a )?\d{1,2}\b/i };
    }
    return { ambiguo: true }; // ya pasó este mes → preguntar, no asumir
  }

  return null;
}

// ── Detección de intención (pura, testeable) ─────────────────────
function detectarIntent(texto) {
  const n = norm(texto);

  if (/^\s*(pendientes|mis pendientes|lista de pendientes|tareas pendientes|que tengo pendiente|que me queda pendiente|que tengo que hacer)\b/.test(n))
    return { tipo: 'list' };

  if (/\bpendiente\b/.test(n) && /\b(hecho|hecha|ya est[aá]|listo|completad\w*|termin\w*|cierra|cerrad\w*|quita|borra|elimina)\b/.test(n)) {
    const m = n.match(/\b(\d{1,3})\b/);
    return { tipo: 'done', idx: m ? parseInt(m[1], 10) : null };
  }

  const recuerda = /\b(recuerdame|acuerdate|no me( lo)? dejes olvidar|no me olvides)\b/.test(n);
  const conPendiente = /\bpendiente\b/.test(n) && /\b(tengo|queda|dejo|apunta\w*|anota\w*|a[nñ]ade|mete|pon|nuevo|otro)\b/.test(n);
  const apuntaMe = /\b(apuntame|anotame)\b/.test(n) && !/\ben\s+\S/.test(n);
  if (recuerda || conPendiente || apuntaMe) return { tipo: 'add', texto: limpiarVerbo(texto) };

  return null;
}

// Quita SOLO la muletilla-verbo del principio (y la coletilla final). Conserva el
// resto tal cual (mayúsculas y palabras): "de la EICA" se mantiene.
function limpiarVerbo(texto) {
  let t = String(texto || '').trim();
  t = t.replace(/^\s*(recu[eé]rdame|acu[eé]rdate|no me( lo)? dejes olvidar|no me olvides|ap[uú]ntame|an[oó]tame|a[nñ]ade(\s+un)?\s+pendiente|nuevo pendiente|tengo\s+(un\s+)?pendiente|queda pendiente)\b[:,]?\s*/i, '');
  t = t.replace(/^\s*que\s+/i, '');                        // "recuérdame QUE …"
  t = t.replace(/[,\s]*(que )?no me( lo)? dejes olvidar\.?$/i, ''); // coletilla final
  return t.trim() || String(texto || '').trim();
}

// Formato de la fecha para la confirmación: "el martes 28".
function fechaConfirm(iso) { return 'el ' + fechaCorta(iso); }

module.exports = {
  addPendiente, listPendientes, cerrarPendiente, seccionResumen,
  detectarIntent, limpiarVerbo, parseFecha, fechaConfirm, hoyMadridISO,
};
