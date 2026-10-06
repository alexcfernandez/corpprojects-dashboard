// src/fichajeAvisos.js — Avisos del fichaje legal: PUSH de la app (canal principal) y
// WhatsApp (solo como último escalón, para no arriesgar el número).
//   · MAÑANA, escalera de 3 (hora de inicio FICHAJE_HORA_INICIO, def. 08:00; L-V):
//       +10 min push suave → +30 min 2º push → +60 min UN WhatsApp (o push si no hay tel.).
//     Se corta en cuanto ficha; nunca a quien está de vacaciones/baja/libre.
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

async function _pushWorker(userId, payload) {
  try { return await require('./push').sendToWorker(userId, payload); }
  catch (e) { console.error('[FichajeAvisos] push:', e.message); return 0; }
}
async function _pushOficina(payload) {
  try { return await require('./push').sendToOficina(payload); }
  catch (e) { console.error('[FichajeAvisos] push oficina:', e.message); return 0; }
}

// ── ENLACES DE FICHAR (implantación) ──────────────────────────────
// Mientras la plantilla no tiene la app instalada: cada día laborable, un WhatsApp con
// SU enlace personal (abre su pantalla de fichar sin PIN) por la mañana y otro por la
// tarde. Se activa/desactiva y se elige quién lo recibe desde Fichajes → Enlaces.
//   config en appSettings { key:'fichajeEnlaces', activo, excluidos:[userId] }
const BASE_URL = (process.env.PUBLIC_URL || 'https://dashboard.corpprojects.es').replace(/\/+$/, '');
function horasEnlaces() {
  const h = (v, d) => (/^\d{1,2}:\d{2}$/.test(String(v || '').trim()) ? String(v).trim().padStart(5, '0') : d);
  return { manana: h(process.env.FICHAJE_ENLACE_MANANA, '07:45'), tarde: h(process.env.FICHAJE_ENLACE_TARDE, '16:00') };
}
function cronDe(hhmm) { const [H, M] = hhmm.split(':').map(Number); return `${M} ${H} * * 1-5`; }
async function _db() { return require('./db').getDB(); }
async function getConfigEnlaces() {
  const doc = await (await _db()).collection('appSettings').findOne({ key: 'fichajeEnlaces' });
  return { activo: !!(doc && doc.activo), excluidos: (doc && Array.isArray(doc.excluidos)) ? doc.excluidos.map(String) : [], ...horasEnlaces() };
}
async function setConfigEnlaces({ activo, excluir } = {}, por) {
  const db = await _db();
  const cfg = await getConfigEnlaces();
  const ex = new Set(cfg.excluidos);
  if (excluir && typeof excluir === 'object') for (const [id, v] of Object.entries(excluir)) { if (v) ex.add(String(id)); else ex.delete(String(id)); }
  const set = { key: 'fichajeEnlaces', excluidos: [...ex], updatedAt: new Date(), updatedBy: por || '' };
  if (typeof activo === 'boolean') set.activo = activo;
  await db.collection('appSettings').updateOne({ key: 'fichajeEnlaces' }, { $set: set }, { upsert: true });
  return getConfigEnlaces();
}
async function enlacePersonal(userId) {
  const { token } = await require('./users').ensureMagicToken(String(userId));
  return `${BASE_URL}/fichar?t=${token}`;
}
function textoEnlace(momento, nombre, url, estado) {
  const n = _nombre(nombre);
  if (momento === 'manana') {
    return `Buenos días ${n} 👋 Desde ahora apuntamos la jornada con el móvil.\n\n` +
      `Cuando empieces, abre tu enlace y pulsa *Empiezo*:\n${url}\n\n` +
      `Elige la obra en la que estás antes de pulsar. Ahí mismo marcas las pausas y el final del día. El enlace es solo tuyo: no lo reenvíes.`;
  }
  if (estado === 'sin_fichar') {
    return `Hola ${n} 👋 Hoy no consta tu entrada.\n\n` +
      `Si has trabajado, abre tu enlace y usa *Me olvidé de fichar* para poner la hora real:\n${url}`;
  }
  return `Hola ${n} 👋 Cuando acabes la jornada, abre tu enlace y pulsa *Termino la jornada*` +
    `${estado === 'pausa' ? ' (ahora estás en pausa)' : ''}:\n${url}`;
}
// Quién lo recibiría ahora y con qué texto (base de la lista de la pantalla y de los envíos).
async function destinatariosEnlaces(momento, { fecha } = {}) {
  const f = fecha || fm.fechaHoy();
  const [cfg, plantilla, dia] = await Promise.all([getConfigEnlaces(), fm.trabajadoresQueFichan(), fm.getDia(f)]);
  const sf = await fm.sinFichar(f, { dia, plantilla });
  const ausente = {}; (sf.ausentes || []).forEach(a => { ausente[a.id] = a.estado; });
  const estadoDe = {}; dia.forEach(d => { estadoDe[String(d.userId)] = d.estado; });
  return plantilla.map(w => {
    const est = estadoDe[w.id] || 'sin_fichar';
    let motivo = null;
    if (!sf.laborable) motivo = 'hoy no es laborable';
    else if (cfg.excluidos.includes(w.id)) motivo = 'no lo recibe (desmarcado)';
    else if (!w.whatsapp) motivo = 'sin teléfono en su ficha';
    else if (ausente[w.id]) motivo = `hoy está de ${ausente[w.id]}`;
    else if (momento === 'tarde' && est === 'fuera') motivo = 'ya ha terminado la jornada';
    return { ...w, estadoHoy: est, ausente: ausente[w.id] || null, excluido: cfg.excluidos.includes(w.id), recibe: !motivo, motivo };
  });
}
async function enviarEnlaces(momento, { dryRun = false, soloUserId = null, forzar = false } = {}) {
  if (!['manana', 'tarde'].includes(momento)) throw new Error('Momento no válido');
  const cfg = await getConfigEnlaces();
  if (!soloUserId && !cfg.activo) return { momento, activo: false, motivo: 'envío de enlaces desactivado' };
  if (!dryRun && !soloUserId && await avisos.isGlobalPaused()) return { pausado: true };
  const fecha = fm.fechaHoy();
  let lista = await destinatariosEnlaces(momento, { fecha });
  if (soloUserId) {
    lista = lista.filter(w => w.id === String(soloUserId));
    if (!lista.length) throw new Error('Ese trabajador no está en la plantilla que ficha');
    if (!lista[0].whatsapp) throw new Error('No tiene teléfono en su ficha');
    lista[0].recibe = true;   // envío manual: se manda aunque esté desmarcado
  }
  const out = [];
  for (const w of lista.filter(x => x.recibe)) {
    const clave = `fichaje-enlace-${momento}-${w.id}`;
    if (!dryRun && !forzar && !soloUserId && await avisos.wasAlertSentToday(clave, fecha)) continue;
    const texto = textoEnlace(momento, w.name, await enlacePersonal(w.id), w.estadoHoy);
    if (dryRun) { out.push({ name: w.name, to: w.whatsapp, texto }); continue; }
    const ok = !!(await _enviar(w.whatsapp, texto));
    if (ok) await avisos.markAlertSent(clave, fecha);
    out.push({ name: w.name, to: w.whatsapp, enviado: ok });
  }
  return { momento, fecha, avisos: out };
}

// ── ESCALERA DE LA MAÑANA ─────────────────────────────────────────
// paso 1 y 2 = push; paso 3 = el ÚNICO WhatsApp del día (si no tiene teléfono, push).
// Si en el paso 3 no ha fichado NADIE, casi seguro es festivo: no se molesta a la
// plantilla por WhatsApp y se avisa a oficina para que lo confirme.
const PASOS = {
  1: { title: '¿Empiezas? ⏱', body: 'Buenos días. Acuérdate de fichar tu entrada: es un toque.' },
  2: { title: 'Aún no has fichado', body: 'Si ya estás trabajando, ficha tu entrada para que cuenten tus horas.' },
  3: { title: 'Sigues sin fichar hoy', body: 'Ficha tu entrada. Si se te pasó la hora, usa «Me olvidé de fichar».' },
};
async function recordatorioEntrada(paso, { dryRun = false } = {}) {
  const p = PASOS[paso]; if (!p) throw new Error('Paso no válido');
  if (!dryRun && await avisos.isGlobalPaused()) return { pausado: true };
  const r = await fm.sinFichar(fm.fechaHoy());
  if (!r.laborable) return { fecha: r.fecha, paso, motivo: 'no laborable / festivo', avisos: [] };
  if (!r.faltan.length) return { fecha: r.fecha, paso, motivo: 'todos han fichado', avisos: [] };
  const posibleFestivo = paso === 3 && r.fichados === 0;
  // En implantación (enlaces activos) ya han recibido su enlace a primera hora: sin WhatsApp extra.
  const enlacesActivos = (await getConfigEnlaces()).activo;
  const out = [];
  if (posibleFestivo) {
    if (!dryRun && !(await avisos.wasAlertSentToday('fichaje-posible-festivo', r.fecha))) {
      await _pushOficina({ title: 'Hoy no ha fichado nadie', body: '¿Es festivo? No he avisado a la plantilla por WhatsApp. Si se trabaja, revisa Fichajes.', url: '/fichajes', tag: 'fichaje-festivo' });
      await avisos.markAlertSent('fichaje-posible-festivo', r.fecha);
    }
    return { fecha: r.fecha, paso, motivo: 'nadie ha fichado: posible festivo (no se envía WhatsApp)', avisos: [] };
  }
  for (const w of r.faltan) {
    const clave = `fichaje-entrada-p${paso}-${w.id}`;
    if (!dryRun && await avisos.wasAlertSentToday(clave, r.fecha)) continue;
    const usarWa = paso === 3 && !!w.whatsapp && !enlacesActivos;
    if (dryRun) { out.push({ name: w.name, canal: usarWa ? 'whatsapp' : 'push', to: usarWa ? w.whatsapp : undefined }); continue; }
    let ok = false;
    if (usarWa) {
      ok = !!(await _enviar(w.whatsapp, `Hola ${_nombre(w.name)} 👋 Hoy todavía no has fichado la entrada.\n\nEntra en la app y pulsa *Empiezo*. Si empezaste antes y se te pasó, usa *Me olvidé de fichar* y pon la hora real.\nhttps://dashboard.corpprojects.es/fichar`));
      await _pushWorker(w.id, { ...p, url: '/fichar', tag: 'fichaje-entrada' }); // y también en la app, por si acaso
    } else {
      ok = (await _pushWorker(w.id, { ...p, url: '/fichar', tag: 'fichaje-entrada' })) > 0;
    }
    if (ok) await avisos.markAlertSent(clave, r.fecha);
    out.push({ name: w.name, canal: usarWa ? 'whatsapp' : 'push', enviado: ok });
  }
  return { fecha: r.fecha, paso, faltan: r.faltan.length, fichados: r.fichados, avisos: out };
}
// Expresiones cron de la escalera a partir de la hora de inicio (HH:MM) + 10/30/60 min.
function cronsEscalera() {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(process.env.FICHAJE_HORA_INICIO || '08:00').trim()) || [null, '8', '00'];
  const base = Number(m[1]) * 60 + Number(m[2]);
  return [10, 30, 60].map((mas, i) => { const t = (base + mas) % 1440; return { paso: i + 1, cron: `${t % 60} ${Math.floor(t / 60)} * * 1-5`, hora: `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` }; });
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
    const clave = 'fichaje-abierto-' + d.userId;
    if (!dryRun && await avisos.wasAlertSentToday(clave, fecha)) continue;
    const inicio = (d.tramos[0] && d.tramos[0].entrada) || d.desde;
    const texto = `Hola ${_nombre(d.userName)} 👋 Tu jornada de hoy sigue abierta (empezaste a las ${_hhmm(inicio)}).\n\n` +
      `Si ya has terminado, entra en la app y pulsa *Termino la jornada*. Si se te pasó la hora, usa *Me olvidé de fichar* y pon a qué hora acabaste.` +
      (to ? `\n${await enlacePersonal(d.userId).catch(() => BASE_URL + '/fichar')}` : '');
    if (dryRun) { out.push({ name: d.userName, to: to || '(sin teléfono: solo push)', enviado: false }); continue; }
    const nPush = await _pushWorker(d.userId, { title: 'Tu jornada sigue abierta', body: `Empezaste a las ${_hhmm(inicio)}. Si ya has acabado, pulsa «Termino la jornada».`, url: '/fichar', tag: 'fichaje-abierto' });
    const okWa = to ? await _enviar(to, texto) : false;
    if (okWa || nPush) await avisos.markAlertSent(clave, fecha);
    // En Presencia cuenta la jornada completa con aviso «no fichó la salida» (al corregirla se recalcula).
    try { await require('./attendance').jornadaSinSalida(String(d.userId), fecha); } catch (e) { console.warn('[FichajeAvisos] jornada sin salida:', e.message); }
    out.push({ name: d.userName, to: to || null, whatsapp: !!okWa, push: nPush });
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
  try { const so = await require('./obraDelDia').sinObraHoy(a.fecha); if (so.length) lineas.push(`❓ *Han fichado sin decir la obra:* ${so.map(x => _nombre(x.name)).join(', ')}`); } catch (e) {}
  if (!lineas.length) return { fecha: a.fecha, enviado: false, motivo: 'nada que revisar' };
  const texto = `🕐 *Fichajes — ${a.fecha.slice(8, 10)}/${a.fecha.slice(5, 7)}*\n\n${lineas.join('\n')}\n\nRevisar: https://dashboard.corpprojects.es/fichajes`;
  if (dryRun) return { fecha: a.fecha, enviado: false, texto, a: _oficina() };
  const clave = 'fichaje-resumen-oficina';
  if (await avisos.wasAlertSentToday(clave, a.fecha)) return { fecha: a.fecha, enviado: false, motivo: 'ya enviado hoy' };
  let alguno = false;
  for (const to of _oficina()) alguno = (await _enviar(to, texto)) || alguno;
  const partes = [a.noFicho.length ? `${a.noFicho.length} sin fichar` : '', a.sinCerrarPrevios.length ? `${a.sinCerrarPrevios.length} sin cerrar` : '', a.correccionesPendientes ? `${a.correccionesPendientes} correcciones` : ''].filter(Boolean).join(' · ');
  const nPush = await _pushOficina({ title: 'Fichajes de hoy', body: partes, url: '/fichajes', tag: 'fichaje-resumen' });
  if (alguno || nPush) await avisos.markAlertSent(clave, a.fecha);
  return { fecha: a.fecha, enviado: alguno || nPush > 0, push: nPush, texto };
}

// Al momento — un trabajador ha pedido una corrección (para que no pasen días).
async function avisarCorreccionNueva({ userName, fecha, hora, tipo, motivo }) {
  try {
    if (await avisos.isGlobalPaused()) return false;
    const que = { entrada: 'entrada', pausa_inicio: 'inicio de pausa', pausa_fin: 'fin de pausa', salida: 'salida' }[tipo] || tipo;
    const texto = `📝 *${_nombre(userName)}* pide corregir su fichaje: *${que}* el ${fecha.slice(8, 10)}/${fecha.slice(5, 7)} a las ${hora}.\nMotivo: “${String(motivo || '').slice(0, 160)}”\n\nAprobar o rechazar: https://dashboard.corpprojects.es/fichajes`;
    await _pushOficina({ title: `${_nombre(userName)} pide una corrección`, body: `${que} el ${fecha.slice(8, 10)}/${fecha.slice(5, 7)} a las ${hora} — “${String(motivo || '').slice(0, 80)}”`, url: '/fichajes', tag: 'fichaje-correccion' });
    let alguno = false;
    for (const to of _oficina()) alguno = (await _enviar(to, texto)) || alguno;
    return alguno;
  } catch (e) { console.error('[FichajeAvisos] corrección:', e.message); return false; }
}

// Al trabajador: su corrección ha sido aprobada o rechazada (solo push).
async function avisarCorreccionResuelta({ userId, fecha, estado }) {
  const okTxt = estado === 'valido';
  return _pushWorker(userId, { title: okTxt ? 'Corrección aprobada ✅' : 'Corrección rechazada', body: okTxt ? `Tu corrección del ${fecha.slice(8, 10)}/${fecha.slice(5, 7)} ya cuenta en tus horas.` : `Oficina ha rechazado tu corrección del ${fecha.slice(8, 10)}/${fecha.slice(5, 7)}. Mira el motivo en la app.`, url: '/fichar', tag: 'fichaje-correccion' });
}

// Día 2 de cada mes: push a quien tenga el resumen del mes pasado sin firmar.
async function recordarFirmaMensual({ dryRun = false } = {}) {
  if (!dryRun && await avisos.isGlobalPaused()) return { pausado: true };
  const hoy = fm.fechaHoy(); const [y, m] = hoy.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 2, 1)); const mes = prev.toISOString().slice(0, 7);
  const inf = await require('./fichajeInformes').informeMes(mes);
  const faltan = inf.trabajadores.filter(t => t.totales.dias > 0 && ['pendiente', 'cambiado'].includes(t.firma.estado));
  const out = [];
  for (const t of faltan) {
    if (dryRun) { out.push({ name: t.userName }); continue; }
    const n = await _pushWorker(t.userId, { title: 'Firma tu resumen del mes 🖊', body: 'Revisa tus horas del mes pasado y fírmalo en «Mis horas». Es un minuto.', url: '/fichar', tag: 'fichaje-firma' });
    out.push({ name: t.userName, push: n });
  }
  return { mes, avisos: out };
}

module.exports = { horasEnlaces, cronDe, getConfigEnlaces, enlacePersonal, setConfigEnlaces, destinatariosEnlaces, enviarEnlaces, textoEnlace, recordatorioEntrada, cronsEscalera, avisarSalidasOlvidadas, resumenOficina, avisarCorreccionNueva, avisarCorreccionResuelta, recordarFirmaMensual };
