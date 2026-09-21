// src/fichajeAvisos.js — Avisos por WhatsApp del fichaje legal (Fase 2).
//   · 20:00 → al TRABAJADOR que sigue con la jornada abierta (se olvidó de terminar).
//   · 09:15 (L-V) → a OFICINA: quién no ha fichado, días sin cerrar y correcciones pendientes.
//   · Al momento → a OFICINA cuando un trabajador pide una corrección.
// Salen por el canal activo (puente/Twilio). Respetan la pausa global de avisos y no
// se repiten en el mismo día (alertLog). Destino de oficina: FICHAJE_AVISOS_TO
// (números separados por comas, ej. el de Judit); si no está, WHATSAPP_TO (el dueño).

const fm = require('./fichajeMarcas');
const avisos = require('./avisos');

function _oficina() {
  return String(process.env.FICHAJE_AVISOS_TO || process.env.WHATSAPP_TO || '')
    .split(',').map(s => s.trim().replace(/^whatsapp:/i, '')).filter(Boolean);
}
function _hhmm(d) {
  return d ? new Date(d).toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' }) : '';
}
function _nombre(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }
async function _enviar(to, texto) {
  try { return await require('./notifications').sendWhatsAppTo(to, texto); }
  catch (e) { console.error('[FichajeAvisos] envío:', e.message); return false; }
}

// 20:00 — a cada trabajador con la jornada aún abierta (trabajando o en pausa).
async function avisarSalidasOlvidadas({ dryRun = false } = {}) {
  if (!dryRun && await avisos.isGlobalPaused()) return { pausado: true };
  const fecha = fm.fechaHoy();
  const [dia, plantilla] = await Promise.all([fm.getDia(fecha), fm.trabajadoresQueFichan()]);
  const tel = {}; plantilla.forEach(w => { tel[w.id] = w.whatsapp; });
  const out = [];
  for (const d of dia.filter(x => x.estado !== 'fuera')) {
    const to = tel[String(d.userId)];
    if (!to) { out.push({ name: d.userName, enviado: false, motivo: 'sin teléfono' }); continue; }
    const clave = 'fichaje-abierto-' + d.userId;
    if (!dryRun && await avisos.wasAlertSentToday(clave, fecha)) continue;
    const inicio = (d.tramos[0] && d.tramos[0].entrada) || d.desde;
    const texto = `Hola ${_nombre(d.userName)} 👋 Tu jornada de hoy sigue abierta (empezaste a las ${_hhmm(inicio)}).\n\n` +
      `Si ya has terminado, entra en la app y pulsa *Termino la jornada*. Si se te pasó la hora, usa *Me olvidé de fichar* y pon a qué hora acabaste.`;
    if (dryRun) { out.push({ name: d.userName, to, enviado: false }); continue; }
    const ok = await _enviar(to, texto);
    if (ok) await avisos.markAlertSent(clave, fecha);
    out.push({ name: d.userName, to, enviado: !!ok });
  }
  return { fecha, avisos: out };
}

// 09:15 L-V — resumen a oficina. Solo se envía si hay algo que revisar.
async function resumenOficina({ dryRun = false, forzarHora } = {}) {
  if (!dryRun && await avisos.isGlobalPaused()) return { pausado: true };
  const a = await fm.alertas(fm.fechaHoy(), { forzarHora });
  const lineas = [];
  if (a.noFicho.length) lineas.push(`🔴 *Sin fichar hoy (${a.noFicho.length}):* ${a.noFicho.map(x => _nombre(x.userName)).join(', ')}`);
  if (a.sinCerrarPrevios.length) lineas.push(`🟠 *Jornadas sin cerrar:* ${a.sinCerrarPrevios.slice(0, 8).map(x => `${_nombre(x.userName)} (${x.fecha.slice(8, 10)}/${x.fecha.slice(5, 7)})`).join(', ')}`);
  if (a.correccionesPendientes) lineas.push(`📝 *Correcciones por revisar:* ${a.correccionesPendientes}`);
  if (!lineas.length) return { fecha: a.fecha, enviado: false, motivo: 'nada que revisar' };
  const texto = `🕐 *Fichajes — ${a.fecha.slice(8, 10)}/${a.fecha.slice(5, 7)}*\n\n${lineas.join('\n')}\n\nRevisar: https://dashboard.corpprojects.es/fichajes`;
  if (dryRun) return { fecha: a.fecha, enviado: false, texto, a: _oficina() };
  const clave = 'fichaje-resumen-oficina';
  if (await avisos.wasAlertSentToday(clave, a.fecha)) return { fecha: a.fecha, enviado: false, motivo: 'ya enviado hoy' };
  let alguno = false;
  for (const to of _oficina()) alguno = (await _enviar(to, texto)) || alguno;
  if (alguno) await avisos.markAlertSent(clave, a.fecha);
  return { fecha: a.fecha, enviado: alguno, texto };
}

// Al momento — un trabajador ha pedido una corrección (para que no pasen días).
async function avisarCorreccionNueva({ userName, fecha, hora, tipo, motivo }) {
  try {
    if (await avisos.isGlobalPaused()) return false;
    const que = { entrada: 'entrada', pausa_inicio: 'inicio de pausa', pausa_fin: 'fin de pausa', salida: 'salida' }[tipo] || tipo;
    const texto = `📝 *${_nombre(userName)}* pide corregir su fichaje: *${que}* el ${fecha.slice(8, 10)}/${fecha.slice(5, 7)} a las ${hora}.\nMotivo: “${String(motivo || '').slice(0, 160)}”\n\nAprobar o rechazar: https://dashboard.corpprojects.es/fichajes`;
    let alguno = false;
    for (const to of _oficina()) alguno = (await _enviar(to, texto)) || alguno;
    return alguno;
  } catch (e) { console.error('[FichajeAvisos] corrección:', e.message); return false; }
}

module.exports = { avisarSalidasOlvidadas, resumenOficina, avisarCorreccionNueva };
