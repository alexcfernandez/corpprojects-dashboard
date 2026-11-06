// src/trabajos.js — De la petición al operario (21/10/2026, Álex: «entra por el grupo → se genera la incidencia → se
// asigna a David o a quien sea → él lo recibe en su app y pone albarán, material y horas, y nosotros tenemos los datos»).
//
// FASE 1 (esto): «Crear trabajo» desde una petición de los grupos (peticionesGrupo.js).
//   · Corpy PROPONE operario y día (quien más ha ido a esa comunidad, quien menos tiene ese día, sin ausencias) y la
//     oficina lo confirma o lo cambia.
//   · Al confirmar: incidencia en StelOrder (si no la hay) → pedido (PDT) enlazado → asignación con día y hora
//     (workOrderAssignments) → Planificación (planning, va a Google Calendar) → WhatsApp + push al operario con un
//     enlace que le abre «Mis trabajos» (/parte), donde ve día, dirección, contacto, lo que pidieron y las fotos.
// FASE 2/3 (después): firma opcional en el parte, albarán → Compras, precio del material, líneas al pedido de StelOrder
//   y cierre de incidencia y petición.
'use strict';
const { ObjectId } = require('mongodb');
const corto = (t, n) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);
async function getDB() { return require('./db').getDB(); }
const TZ = 'Europe/Madrid';
const hoyISO = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: TZ });
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const VACIAS = new Set(['ctat', 'prop', 'comunitat', 'comunidad', 'propietaris', 'propietarios', 'parquing', 'parking', 'calle', 'carrer', 'plaza', 'placa', 'plza', 'macro', 'travessia', 'trav', 'del', 'de', 'la', 'les', 'els']);
const palabras = s => (norm(s).match(/[a-z]{3,}|\d+/g) || []).filter(w => !VACIAS.has(w));
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const fechaTxt = f => { const d = new Date(f + 'T12:00:00Z'); return `${DIAS[d.getUTCDay()]} ${f.slice(8, 10)}/${f.slice(5, 7)}`; };
const HUECOS = ['09:00', '11:30', '16:00'];

// Siguiente día laborable (L-V). Urgente: hoy si es antes de las 13:00.
function diaPropuesto({ urgente = false, ahora = new Date() } = {}) {
  const h = Number(ahora.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }));
  const d = new Date(hoyISO(ahora) + 'T12:00:00Z');
  if (!(urgente && h < 13)) d.setUTCDate(d.getUTCDate() + 1);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Operarios que pueden ir (activos, de campo).
async function operarios() {
  const us = await require('./users').getUsers(false);
  const N = require('./users').normalizeRole;
  // Los socios (Alfonso, Álex) no salen como propuesta (2/11/2026: propuso a Alfonso para Bellpuig); se les puede asignar a mano.
  const socio = require('./memoria').esSocio;
  return us.filter(u => u.active !== false && ['tecnico', 'encargado'].includes(N(u.role)) && !socio(u)).map(u => ({ id: String(u._id), name: u.name, telefono: u.whatsapp || u.telefono || '' }));
}

async function _peticion(db, id) {
  if (!ObjectId.isValid(String(id))) throw new Error('Petición no encontrada');
  const p = await db.collection('peticionesGrupo').findOne({ _id: new ObjectId(String(id)) });
  if (!p) throw new Error('Petición no encontrada');
  return p;
}

// Propuesta de Corpy para una petición.
// ¿Está atado a una obra ese día? Obra fija o 3+ de los últimos días en la misma obra (2/11/2026: propuso a Abdellah
// «el martes lo tiene libre» y está cada día en el INSS). Si la petición es de esa misma obra, no cuenta como ocupado.
function ocupadoEn(workerId, { fijas = [], recientes = [], fecha, casa = () => false } = {}) {
  const f = fijas.find(x => String(x.workerId) === String(workerId) && x.activa !== false && String(x.desde || '') <= fecha && (!x.hasta || x.hasta >= fecha));
  if (f && !casa(f.obraRef)) return f.obraRef || 'su obra fija';
  const dias = {};
  for (const a of recientes.filter(a => String(a.workerId) === String(workerId) && (a.estado || 'obra') === 'obra')) {
    const ns = (a.obras && a.obras.length ? a.obras.map(o => o.clientName) : [a.clientName]).filter(Boolean);
    for (const n of new Set(ns)) (dias[n] = dias[n] || new Set()).add(a.date);
  }
  const top = Object.entries(dias).map(([n, d]) => [n, d.size]).sort((x, y) => y[1] - x[1])[0];
  return top && top[1] >= 3 && !casa(top[0]) ? top[0] : null;
}

async function propuesta(peticionId, { ahora = new Date() } = {}) {
  const db = await getDB();
  const p = await _peticion(db, peticionId);
  const ops = await operarios();
  const fecha = diaPropuesto({ urgente: !!p.urgente, ahora });
  const claves = palabras(p.clienteStel || p.cliente).slice(0, 3);
  const desde = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  const [att, asig, aus] = await Promise.all([
    claves.length ? db.collection('attendance').find({ date: { $gte: desde } }).project({ workerId: 1, clientName: 1, obras: 1, date: 1 }).toArray() : [],
    db.collection('workOrderAssignments').find({ status: { $nin: ['done', 'invoiced'] } }).toArray(),
    require('./ausencias').lista().catch(() => []),
  ]);
  const hace7 = new Date(new Date(fecha + 'T12:00:00Z').getTime() - 7 * 86400000).toISOString().slice(0, 10);
  const [fijas, recientes] = await Promise.all([
    db.collection('obrasFijas').find({ activa: true }).toArray().catch(() => []),
    db.collection('attendance').find({ date: { $gte: hace7, $lt: fecha } }).project({ workerId: 1, clientName: 1, obras: 1, date: 1, estado: 1 }).toArray().catch(() => []),
  ]);
  const deDia = require('./ausencias').deDia;
  const casa = s => { const w = palabras(s); return claves.length && claves.every(k => w.includes(k)); };
  const filas = ops.map(o => {
    const dias = new Set(att.filter(a => String(a.workerId) === o.id && (casa(a.clientName) || (a.obras || []).some(x => casa(x.clientName)))).map(a => a.date)).size;
    const mios = asig.filter(a => String(a.userId) === o.id);
    const eseDia = mios.filter(a => a.fecha === fecha);
    const ausente = deDia(aus, o.id, fecha);
    return { ...o, conoce: dias, abiertos: mios.length, eseDia: eseDia.length, horas: eseDia.map(a => a.hora).filter(Boolean), ausente: ausente ? ausente.tipo : null, ocupado: ocupadoEn(o.id, { fijas, recientes, fecha, casa }) };
  });
  const candidatos = filas.filter(f => !f.ausente && !f.ocupado).sort((a, b) => (b.conoce > 0) - (a.conoce > 0) || a.eseDia - b.eseDia || b.conoce - a.conoce || a.abiertos - b.abiertos);
  const el = candidatos[0] || null;
  const hora = el ? (HUECOS.find(h => !el.horas.includes(h)) || '09:00') : '09:00';
  const atados = filas.filter(f => f.ocupado && !f.ausente).map(f => `${f.name.split(' ')[0]} (${f.ocupado})`);
  const motivo = !el ? `No hay nadie libre ese día${atados.length ? ': ' + atados.join(', ') : ''}. Dime a quién se lo damos.` :
    [el.conoce ? `ha ido ${el.conoce} día${el.conoce > 1 ? 's' : ''} a ${p.clienteStel || p.cliente} en los últimos 4 meses` : null,
      el.eseDia ? `ese día ya tiene ${el.eseDia} trabajo${el.eseDia > 1 ? 's' : ''}` : 'ese día lo tiene libre',
      el.abiertos ? `${el.abiertos} trabajo${el.abiertos > 1 ? 's' : ''} abierto${el.abiertos > 1 ? 's' : ''}` : null].filter(Boolean).join(' · ');
  return {
    peticion: { id: String(p._id), cliente: p.clienteStel || p.cliente, clienteId: p.clienteId || null, tipo: p.tipo, resumen: p.resumen, direccion: p.direccion, contacto: p.contacto, urgente: !!p.urgente, incidencia: p.incidencia || null, pedido: p.pedido || null },
    propuesta: el ? { userId: el.id, nombre: el.name, fecha, hora, fechaTxt: fechaTxt(fecha), motivo } : null,
    operarios: filas.map(f => ({ id: f.id, nombre: f.name, conoce: f.conoce, abiertos: f.abiertos, ausente: f.ausente, ocupado: f.ocupado })),
    motivo: el ? null : motivo,
  };
}

// Crea el trabajo: incidencia (si falta) → pedido → asignación con día → planificación → aviso al operario.
// Sin día (2/11/2026, Álex: «David queda con el cliente»): fecha null → el pedido sale igual y el seguimiento
// (trabajosSeguimiento.js) le pregunta cada día hasta que diga cuándo ha quedado. `acompanan`: nombres de quien va con él.
async function crear(peticionId, { userId, fecha = null, hora = null, urgente = null, nota = '', clienteId = null, acompanan = [] } = {}, por = '', { _stel = null, _enviar = null } = {}) {
  const db = await getDB();
  const S = _stel || require('./stelorder');
  const p = await _peticion(db, peticionId);
  if (p.pedido && p.pedido.id) throw new Error(`Ya tiene el pedido ${p.pedido.ref}`);
  if (p.porConfirmar) throw new Error('Esta petición está por confirmar (no sabemos si quien llamó es de ese cliente): confírmala primero');
  if (p.noCliente) throw new Error('Esta petición no es de un cliente (proveedor, comercial o administrativo): si sí lo es, confírmala con su cliente primero');
  if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(String(fecha))) throw new Error('El día no se entiende');
  if (hora && !/^\d{1,2}:\d{2}$/.test(String(hora))) throw new Error('La hora no se entiende');
  // Trabajo aceptado de la cola (colaTrabajos.js) con día previsto: si no se dice otro, va ese.
  // Su evento del calendario sobra en cuanto el trabajo tiene planificación (que ya sale en el calendario).
  let colaLista = null;
  if (p.listaId && ObjectId.isValid(p.listaId)) colaLista = await db.collection('listasMateriales').findOne({ _id: new ObjectId(p.listaId) }, { projection: { cola: 1 } }).catch(() => null);
  if (!fecha && colaLista && colaLista.cola && colaLista.cola.fecha && !colaLista.cola.hecho && colaLista.cola.fecha >= new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' })) { fecha = colaLista.cola.fecha; hora = hora || colaLista.cola.hora || null; }
  if (!fecha) { fecha = null; hora = null; }
  const u = await require('./users').getUser(String(userId || '')).catch(() => null);
  if (!u) throw new Error('Elige el operario');
  if (clienteId && /^\d+$/.test(String(clienteId)) && String(clienteId) !== String(p.clienteId || '')) {
    const { clientMap } = await S.getClients();
    const c = clientMap[String(clienteId)];
    if (!c) throw new Error('Ese cliente no está en StelOrder');
    await db.collection('peticionesGrupo').updateOne({ _id: p._id }, { $set: { clienteId: String(clienteId), clienteStel: c.name } });
    p.clienteId = String(clienteId); p.clienteStel = c.name;
  }
  if (!p.clienteId) throw new Error('Elige el cliente de StelOrder (la comunidad)');
  const cliente = p.clienteStel || p.cliente;
  // 1) Incidencia
  let incidencia = p.incidencia ? { ref: p.incidencia, id: p.incidenciaId || null } : null;
  // Si la incidencia que relacionó la IA es antigua (más de 30 días antes de la petición) o ya está cerrada o
  // facturada, es otro aviso: se crea una nueva (21/10/2026, Major 75: INC00478 de marzo era de otra filtración).
  if (incidencia && !p.incidenciaCreadaAt) {
    const [inc, st] = await Promise.all([S.getAllIncidents().then(l => l.find(i => i['full-reference'] === p.incidencia)), S.getIncidentStateMap()]);
    const vieja = !inc || new Date(inc.date) < new Date(new Date(p.fecha).getTime() - 30 * 86400000) || /cerrad|factur|rechaz/i.test(st[inc['incident-state-id']] || '');
    if (vieja) { await db.collection('peticionesGrupo').updateOne({ _id: p._id }, { $set: { incidenciaAnterior: p.incidencia }, $unset: { incidencia: '', incidenciaId: '' } }); p.incidencia = null; incidencia = null; }
    else incidencia = { ref: p.incidencia, id: String(inc.id) };
  }
  if (!incidencia || !incidencia.id) {
    if (p.incidencia) {   // ya la había (ref): buscar su id
      const inc = (await S.getAllIncidents()).find(i => i['full-reference'] === p.incidencia);
      incidencia = inc ? { ref: p.incidencia, id: String(inc.id) } : null;
    }
    if (!incidencia) {
      const r = await require('./peticionesGrupo').crearIncidencia(String(p._id), por);
      incidencia = { ref: r.ref, id: r.id || null };
    }
  }
  if (!incidencia.id) throw new Error('No encuentro la incidencia en StelOrder');
  // 2) Pedido
  // Título corto, y en la línea el resumen con dónde, contacto y de dónde vino (3/11/2026); lo dicho tal cual, en la nota privada.
  // El producto de la línea sigue siendo el genérico «Presupuesto» o «Actuación» según lo que piden.
  const PG = require('./peticionesGrupo');
  const clientMap = S.getClients ? ((await S.getClients().catch(() => null)) || {}).clientMap || {} : {};
  const det = PG.detalle(p, { clientMap, incidencia: incidencia.ref });   // [Dónde, Contacto, origen]: el origen al final
  const desc = [p.resumen, ...det.slice(0, -1), nota ? `Nota de oficina: ${nota}` : '', det[det.length - 1]].filter(Boolean).join('\n');
  const ped = await S.generarPedidoDesdeIncidencia({ incidentId: incidencia.id, accId: p.clienteId, descripcion: desc, titulo: PG.tituloPeticion({ ...p, clienteStel: cliente }), notaPrivada: PG.original(p).join('\n'), tipo: p.tipo === 'presupuesto' ? 'presupuesto' : 'actuacion', requestedBy: por || 'Crear trabajo' });
  // 3) Asignación con día y hora
  const urg = urgente == null ? !!p.urgente : !!urgente;
  await require('./asignaciones').setAssignment(ped.id, String(u._id), por || null, urg ? 'urgent' : 'normal');
  let obraId = null; try { obraId = (await require('./parteExtra').obra({ clientName: cliente }, { _db: db })).obraId; } catch (e) {}
  const equipo = (acompanan || []).map(x => String(x).trim()).filter(Boolean).slice(0, 4);
  await db.collection('workOrderAssignments').updateOne({ workOrderId: String(ped.id) }, { $set: { obraId, fecha, hora, citaPendiente: !fecha, equipo, nota: String(nota || '').slice(0, 300), direccion: p.direccion || null, contacto: p.contacto || null, cliente, resumen: p.resumen, peticionId: String(p._id), incidenciaRef: incidencia.ref, pedidoRef: ped.ref, fotoIds: p.fotoIds || [], tipo: p.tipo } });
  // 4) Planificación (y Google Calendar), si ya hay día
  if (fecha) try { await require('./planning').createPlanning({ date: fecha, workerId: String(u._id), workerName: u.name, tipo: p.tipo === 'presupuesto' ? 'visita' : 'trabajo', client: cliente, address: p.direccion || '', workOrderId: String(ped.id), workOrderNumber: ped.ref, nota: p.resumen, horaInicio: hora }); }
  catch (e) { console.warn('[Trabajos] planificación:', e.message); }
  // 5) Petición
  await db.collection('peticionesGrupo').updateOne({ _id: p._id }, { $set: { incidencia: incidencia.ref, incidenciaId: incidencia.id, situacion: 'ya_hay_incidencia', pedido: { id: String(ped.id), ref: ped.ref }, asignado: { userId: String(u._id), nombre: u.name, fecha, hora, equipo }, asignadoPor: por, asignadoAt: new Date() } });
  // Las fotos del aviso, adjuntas también al pedido en StelOrder (adjuntosStel.js), sin esperar.
  if (!_stel && (p.fotoIds || []).length) require('./adjuntosStel').subirPorId(String(p._id), { _db: db, por: por || 'Crear trabajo' }).catch(e => console.warn('[Trabajos] fotos a StelOrder:', e.message));
  // 5b) Lo demás pendiente de la misma comunidad va en este parte (trabajosJuntar.js, 6/11/2026, Joan Maragall).
  let junto = { extras: [] };
  try { junto = await require('./trabajosJuntar').juntar(await db.collection('workOrderAssignments').findOne({ workOrderId: String(ped.id) }), { _db: db, por, _stel: _stel ? false : null }); } catch (e) { console.warn('[Trabajos] juntar:', e.message); }
  // 6) Aviso al operario: en SU grupo de trabajos si lo tiene (bridgeGrupos.trabajosDe, «Reparaciones David Valencia»;
  // 2/11/2026, Álex: «que se vayan acumulando ahí»), si no por privado. Con las fotos del aviso.
  let avisado = false, enGrupo = null;
  try {
    const url = (await require('./fichajeAvisos').enlacePersonal(String(u._id))) + '&ir=parte';
    // Comunidad sin día: se puede ir cuando vaya bien, no hace falta quedar (5/11/2026, Álex).
    const cuando = fecha ? `para el *${fechaTxt(fecha)}${hora ? ' a las ' + hora : ''}*` : esComunidad(cliente) ? '— *es una comunidad: ve cuando te vaya bien y di aquí qué día vas*' : '— *queda tú con el cliente*';
    const txt = `🔧 *Trabajo nuevo* ${cuando}${urg ? ' (URGENTE)' : ''}\n*${cliente}*${p.direccion ? ' · ' + p.direccion : ''}\n${p.resumen}${p.contacto ? `\nContacto: ${p.contacto}` : ''}${equipo.length ? `\nVas con: ${equipo.join(', ')}` : ''}${nota ? `\nNota: ${nota}` : ''}\nPedido ${ped.ref} · ${incidencia.ref}${require('./trabajosJuntar').textoExtras(junto.extras)}\n\n${fecha ? '' : 'Cuando quedes, contesta aquí el día y la hora (p. ej. «' + corto(cliente, 25) + ' el jueves a las 10») o ponlo en la app.\n'}En tu app, con las fotos, en «Mis trabajos»:\n${url}`;
    const enviar = _enviar || require('./notifications').sendWhatsAppTo;
    const g = await db.collection('bridgeGrupos').findOne({ trabajosDe: String(u._id), activo: true });
    const tel = u.whatsapp || u.telefono;
    if (g) { enGrupo = g.nombre || g._id; avisado = (await enviar(g._id, txt, { importante: true, sinTraducir: true })) !== false; }
    else if (tel) avisado = (await enviar(tel, txt, { importante: true })) !== false;
    if (avisado && !_enviar) {
      const fotos = await require('./archivosDisco').hidratar(await db.collection('grupoFotos').find({ _id: { $in: (p.fotoIds || []).filter(f => ObjectId.isValid(f)).slice(0, 3).map(f => new ObjectId(f)) } }).toArray());
      for (const f of fotos) { try { await require('./canalWhatsapp').enviarArchivo(g ? g._id : tel, `📷 ${corto(cliente, 40)}`, { data: Buffer.from(f.data.buffer || f.data), mime: f.mimetype || 'image/jpeg', nombre: 'aviso.jpg' }); } catch (e) {} }
    }
    // El pedido sin valorar, para que lo tenga con el mensaje (5/11/2026).
    if (avisado && !_enviar) {
      try { const data = await pdfPedido({ ref: ped.ref, incidencia: incidencia.ref, cliente, p, fecha, hora, urgente: urg, operario: u.name, equipo, nota, detalle: det, extras: junto.extras }); await require('./canalWhatsapp').enviarArchivo(g ? g._id : tel, `📄 Pedido ${ped.ref} · ${corto(cliente, 40)}`, { data, mime: 'application/pdf', nombre: `Pedido ${ped.ref}.pdf` }); } catch (e) { console.warn('[Trabajos] PDF del pedido:', e.message); }
    }
    // Trabajo de un presupuesto aceptado con su lista de materiales: el PDF del parte con las instrucciones (materialesObra.js).
    if (avisado && !_enviar && p.origen === 'materiales') {
      try { const f = await require('./materialesObra').pdfParaPeticion(String(p._id)); if (f) await require('./canalWhatsapp').enviarArchivo(g ? g._id : tel, `📋 Parte e instrucciones · ${corto(cliente, 40)}`, { data: f.data, mime: 'application/pdf', nombre: f.nombre }); } catch (e) { console.warn('[Trabajos] PDF del parte:', e.message); }
    }
    try { await require('./push').sendToWorker(String(u._id), { title: 'Trabajo nuevo', body: `${fecha ? fechaTxt(fecha) + (hora ? ' ' + hora : '') : 'Sin día'} · ${cliente}`, url: '/parte' }); } catch (e) {}
  } catch (e) { console.warn('[Trabajos] aviso:', e.message); }
  if (fecha && colaLista && colaLista.cola && colaLista.cola.eventoId) {
    try { await require('./calendar').deleteEvent(colaLista.cola.eventoId); await db.collection('listasMateriales').updateOne({ _id: colaLista._id }, { $set: { 'cola.eventoId': null } }); } catch (e) { console.warn('[Trabajos] evento de la cola:', e.message); }
  }
  return { ok: true, incidencia: incidencia.ref, pedido: ped.ref, pedidoId: String(ped.id), operario: u.name, equipo, fecha, hora, fechaTxt: fecha ? fechaTxt(fecha) : null, avisado, enGrupo, juntos: junto.extras.length };
}

const esComunidad = c => /\b(ctat|c\.?\s?p\.?|com\.?\s?prop|comunitat|comunidad|propietaris|propietarios)\b/i.test(String(c || ''));
// PDF del pedido SIN VALORAR para el operario (5/11/2026, Álex: «que lo mandemos sin valorar, que tenga también ese
// pedido de trabajo»). El PDF de StelOrder sale valorado (precios a 0), así que se hace aquí: lo que hay que hacer, dónde,
// contacto, día y quién va, sin ni un precio.
async function pdfPedido({ ref, incidencia = null, cliente, p, fecha = null, hora = null, urgente = false, operario = '', equipo = [], nota = '', detalle = [], extras = [] }) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const { limpio } = require('./planificacionPdf');
  const doc = await PDFDocument.create();
  const F = await doc.embedFont(StandardFonts.Helvetica), FB = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595, H = 842, M = 44;
  const C = { tinta: rgb(0.13, 0.15, 0.18), gris: rgb(0.45, 0.47, 0.5), linea: rgb(0.86, 0.87, 0.89), naranja: rgb(0.93, 0.45, 0.16), rojo: rgb(0.85, 0.26, 0.24) };
  const pg = doc.addPage([W, H]); let y = H - M;
  const lineas = (t, f, s, w) => { const out = []; let cur = ''; for (const pal of limpio(t).split(' ')) { const p2 = cur ? cur + ' ' + pal : pal; if (f.widthOfTextAtSize(p2, s) > w && cur) { out.push(cur); cur = pal; } else cur = p2; } if (cur) out.push(cur); return out; };
  const parrafo = (t, { s = 10, f = F, c = C.tinta, x = M, w = W - 2 * M, gap = 3.5 } = {}) => { for (const tr of String(t || '').split('\n')) for (const ln of lineas(tr, f, s, w)) { pg.drawText(ln, { x, y, size: s, font: f, color: c }); y -= s + gap; } };
  const titulo = t => { y -= 10; pg.drawText(limpio(t), { x: M, y, size: 10, font: FB, color: C.naranja }); y -= 5; pg.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: C.linea }); y -= 14; };
  pg.drawText('CORP PROJECTS', { x: M, y: y - 6, size: 15, font: FB, color: C.tinta });
  pg.drawText(limpio('Corp Projects Holding, S.L. · C/ Nou 12, 2º 2B · 17001 Girona · 674 013 723'), { x: M, y: y - 20, size: 8, font: F, color: C.gris });
  y -= 52;
  parrafo('PEDIDO DE TRABAJO', { s: 18, f: FB, gap: 6 });
  parrafo(`${ref}${incidencia ? ' · ' + incidencia : ''}${urgente ? ' · URGENTE' : ''}`, { s: 11, f: FB, c: urgente ? C.rojo : C.gris, gap: 4 });
  titulo('Cliente y lugar');
  parrafo(cliente, { s: 11.5, f: FB, gap: 5 });
  for (const d of detalle.filter(x => !/^Pedido en el grupo|^Llamada del|^Correo de/.test(x))) parrafo(d);
  titulo('Cuándo y quién va');
  parrafo(fecha ? `${fechaTxt(fecha)}${hora ? ' a las ' + hora : ''}` : esComunidad(cliente) ? 'Sin día: es una comunidad, ve cuando te vaya bien y di en el grupo qué día vas.' : 'Sin día: queda tú con el cliente y contesta en el grupo el día y la hora.', { f: FB });
  parrafo(`Va: ${operario}${equipo.length ? ' con ' + equipo.join(', ') : ''}`);
  titulo('Trabajo a realizar');
  parrafo(p.resumen || p.titulo || '', { s: 11 });
  if (nota) { y -= 4; parrafo(`Nota de oficina: ${nota}`, { c: C.gris }); }
  // Lo demás pendiente de la misma comunidad (trabajosJuntar.js, 6/11/2026).
  if (extras.length) {
    titulo('En esta comunidad también (en la misma visita)');
    for (const e of extras) { parrafo(`- ${e.direccion ? e.direccion + ': ' : ''}${e.que}${e.incidencia ? ` (${e.incidencia})` : ''}`, { s: 11, gap: 3 }); if (e.contacto) parrafo(`  Contacto: ${e.contacto}`, { c: C.gris }); y -= 3; }
  }
  titulo('Al acabar');
  parrafo('Pon el parte en tu app (Mis trabajos): horas, material usado y fotos de antes y después.', { c: C.gris });
  pg.drawText(limpio(`${ref} · sin valorar`), { x: M, y: 28, size: 8, font: F, color: C.gris });
  return Buffer.from(await doc.save());
}

// El PDF del pedido otra vez, desde lo que ya hay guardado (para mandarlo actualizado cuando se le añade algo).
async function pdfDeTrabajo(workOrderId, { _db = null } = {}) {
  const db = _db || await getDB();
  const a = await db.collection('workOrderAssignments').findOne({ workOrderId: String(workOrderId) });
  if (!a || !a.pedidoRef) return null;
  const p = a.peticionId && ObjectId.isValid(String(a.peticionId)) ? await db.collection('peticionesGrupo').findOne({ _id: new ObjectId(String(a.peticionId)) }) : null;
  const S = require('./stelorder');
  const clientMap = ((await S.getClients().catch(() => null)) || {}).clientMap || {};
  const det = p ? require('./peticionesGrupo').detalle(p, { clientMap, incidencia: a.incidenciaRef }) : [];
  const data = await pdfPedido({ ref: a.pedidoRef, incidencia: a.incidenciaRef, cliente: a.cliente || (p && (p.clienteStel || p.cliente)) || '', p: { ...(p || {}), resumen: a.resumen || (p && p.resumen) || '' },   // el resumen de cuando se mandó: el de la petición cambia con lo que se dice después
    fecha: a.fecha || null, hora: a.hora || null, urgente: a.priority === 'urgent', operario: a.userName || '', equipo: a.equipo || [], nota: a.nota || '', detalle: det, extras: a.extras || [] });
  return { data, nombre: `Pedido ${a.pedidoRef}.pdf` };
}

// El operario dice cuándo ha quedado (grupo, app o Álex por Corpy): día y hora en la asignación, en Planificación
// (Google Calendar) y en la petición. A partir de aquí el seguimiento avisa el día antes y el mismo día.
async function fijarCita(workOrderId, { fecha, hora = null, nota = null } = {}, por = '') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha || ''))) throw new Error('Falta el día');
  if (hora && !/^\d{1,2}:\d{2}$/.test(String(hora))) throw new Error('La hora no se entiende');
  const db = await getDB();
  const a = await db.collection('workOrderAssignments').findOne({ workOrderId: String(workOrderId) });
  if (!a) throw new Error('No encuentro ese trabajo');
  const antes = a.fecha ? { fecha: a.fecha, hora: a.hora || null } : null;
  await db.collection('workOrderAssignments').updateOne({ _id: a._id }, { $set: { fecha, hora: hora || null, citaPendiente: false, citaPor: por, citaAt: new Date(), ...(nota ? { notaCita: String(nota).slice(0, 200) } : {}) }, ...(antes ? { $push: { citasAnteriores: { ...antes, cambiada: new Date(), por } } } : {}) });
  if (a.peticionId && ObjectId.isValid(a.peticionId)) await db.collection('peticionesGrupo').updateOne({ _id: new ObjectId(a.peticionId) }, { $set: { 'asignado.fecha': fecha, 'asignado.hora': hora || null } });
  try {
    const pl = await db.collection('planning').findOne({ workOrderId: String(workOrderId) });
    if (pl) await require('./planning').updatePlanning(String(pl._id), { date: fecha, horaInicio: hora || '' });
    else await require('./planning').createPlanning({ date: fecha, workerId: a.userId, workerName: a.userName, tipo: a.tipo === 'presupuesto' ? 'visita' : 'trabajo', client: a.cliente || '', address: a.direccion || '', workOrderId: String(workOrderId), workOrderNumber: a.pedidoRef || '', nota: a.resumen || '', horaInicio: hora || '' });
  } catch (e) { console.warn('[Trabajos] planificación cita:', e.message); }
  return { ok: true, cliente: a.cliente, pedido: a.pedidoRef, fecha, hora: hora || null, fechaTxt: fechaTxt(fecha), cambiada: !!antes };
}

// En observación (6/11/2026, Álex con Illa Verda: «a David no le tiene que llegar; lo seguimos yo o la oficina, a ver
// cuando llueva»): el trabajo sigue abierto y asignado, pero el operario no lo ve en su app ni le llegan recordatorios;
// sale en el tablero (columna «cita») como «en observación». on=false lo devuelve a su sitio.
async function observacion(workOrderId, { on = true, motivo = '', contacto = '', nota = '' } = {}, por = '', { _enviar = null } = {}) {
  const db = await getDB();
  const a = await db.collection('workOrderAssignments').findOne({ workOrderId: String(workOrderId) });
  if (!a) throw new Error('No encuentro ese trabajo');
  if (on) {
    await db.collection('workOrderAssignments').updateOne({ _id: a._id }, { $set: { observacion: { motivo: String(motivo || '').slice(0, 200), ...(contacto ? { contacto: String(contacto).slice(0, 120) } : {}), por, desde: new Date() } } });
    return { ok: true, cliente: a.cliente, pedido: a.pedidoRef, observacion: true };
  }
  // Vuelve al técnico (Álex: «cuando se lo devuelva a David, lo que yo ponga que salga en el parte»): la nota es lo que
  // tiene que hacer y sale en su app (📝 del trabajo); se le avisa por su grupo y el seguimiento vuelve a contar desde hoy.
  const n = String(nota || '').trim().slice(0, 600);
  const $set = { reabiertoAt: new Date(), ...(n ? { nota: n } : {}), ...(!a.contacto && a.observacion && a.observacion.contacto ? { contacto: a.observacion.contacto } : {}) };
  await db.collection('workOrderAssignments').updateOne({ _id: a._id }, { $set, $unset: { observacion: '' }, $push: { observacionesAnteriores: { ...(a.observacion || {}), hasta: new Date(), por, ...(a.nota && n ? { notaAnterior: a.nota } : {}) } } });
  let avisado = false;
  if (a.userId) {
    try {
      const g = await db.collection('bridgeGrupos').findOne({ trabajosDe: String(a.userId), activo: true });
      const u = await db.collection('users').findOne({ _id: new ObjectId(String(a.userId)) }, { projection: { name: 1, whatsapp: 1, telefono: 1, avisosWa: 1 } });
      const to = g ? g._id : (u && u.avisosWa !== 'ninguno' ? (u.whatsapp || u.telefono) : null);
      const contacto = $set.contacto || a.contacto;
      if (to) avisado = await (_enviar || require('./notifications').sendWhatsAppTo)(to,
        `🔧 ${u && u.name ? String(u.name).split(' ')[0] + ', ' : ''}*${a.cliente}*${a.direccion ? ' · ' + a.direccion : ''} (${a.pedidoRef || ''}) vuelve a ser tuyo.` +
        `${n ? `

📝 *Qué hay que hacer:*
${n}` : ''}${contacto ? `

👤 ${contacto}` : ''}

Lo tienes en la app. ¿Cuándo puedes ir? Contesta «${String(a.cliente || '').split(/\s*[,–(]\s*/)[0].slice(0, 25)} el jueves a las 10».`,
        { sinTraducir: true }) !== false;
    } catch (e) { console.warn('[Trabajos] aviso al volver de observación:', e.message); }
  }
  return { ok: true, cliente: a.cliente, pedido: a.pedidoRef, observacion: false, avisado };
}

// Foto de la petición para el operario que tiene ese trabajo.
async function fotoParaOperario(fotoId, workerId) {
  const db = await getDB();
  const a = await db.collection('workOrderAssignments').findOne({ userId: String(workerId), fotoIds: String(fotoId) });
  if (!a) return null;
  return require('./grupoWhatsapp').foto(fotoId);
}

module.exports = { propuesta, crear, fijarCita, observacion, operarios, diaPropuesto, fotoParaOperario, pdfPedido, pdfDeTrabajo, _palabras: palabras, _fechaTxt: fechaTxt, _ocupadoEn: ocupadoEn };
