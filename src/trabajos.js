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
  return us.filter(u => ['tecnico', 'encargado'].includes(N(u.role))).map(u => ({ id: String(u._id), name: u.name, telefono: u.whatsapp || u.telefono || '' }));
}

async function _peticion(db, id) {
  if (!ObjectId.isValid(String(id))) throw new Error('Petición no encontrada');
  const p = await db.collection('peticionesGrupo').findOne({ _id: new ObjectId(String(id)) });
  if (!p) throw new Error('Petición no encontrada');
  return p;
}

// Propuesta de Corpy para una petición.
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
  const deDia = require('./ausencias').deDia;
  const casa = s => { const w = palabras(s); return claves.length && claves.every(k => w.includes(k)); };
  const filas = ops.map(o => {
    const dias = new Set(att.filter(a => String(a.workerId) === o.id && (casa(a.clientName) || (a.obras || []).some(x => casa(x.clientName)))).map(a => a.date)).size;
    const mios = asig.filter(a => String(a.userId) === o.id);
    const eseDia = mios.filter(a => a.fecha === fecha);
    const ausente = deDia(aus, o.id, fecha);
    return { ...o, conoce: dias, abiertos: mios.length, eseDia: eseDia.length, horas: eseDia.map(a => a.hora).filter(Boolean), ausente: ausente ? ausente.tipo : null };
  });
  const candidatos = filas.filter(f => !f.ausente).sort((a, b) => (b.conoce > 0) - (a.conoce > 0) || a.eseDia - b.eseDia || b.conoce - a.conoce || a.abiertos - b.abiertos);
  const el = candidatos[0] || null;
  const hora = el ? (HUECOS.find(h => !el.horas.includes(h)) || '09:00') : '09:00';
  const motivo = !el ? 'No hay nadie disponible ese día' :
    [el.conoce ? `ha ido ${el.conoce} día${el.conoce > 1 ? 's' : ''} a ${p.clienteStel || p.cliente} en los últimos 4 meses` : null,
      el.eseDia ? `ese día ya tiene ${el.eseDia} trabajo${el.eseDia > 1 ? 's' : ''}` : 'ese día lo tiene libre',
      el.abiertos ? `${el.abiertos} trabajo${el.abiertos > 1 ? 's' : ''} abierto${el.abiertos > 1 ? 's' : ''}` : null].filter(Boolean).join(' · ');
  return {
    peticion: { id: String(p._id), cliente: p.clienteStel || p.cliente, clienteId: p.clienteId || null, tipo: p.tipo, resumen: p.resumen, direccion: p.direccion, contacto: p.contacto, urgente: !!p.urgente, incidencia: p.incidencia || null, pedido: p.pedido || null },
    propuesta: el ? { userId: el.id, nombre: el.name, fecha, hora, fechaTxt: fechaTxt(fecha), motivo } : null,
    operarios: filas.map(f => ({ id: f.id, nombre: f.name, conoce: f.conoce, abiertos: f.abiertos, ausente: f.ausente })),
  };
}

// Crea el trabajo: incidencia (si falta) → pedido → asignación con día → planificación → aviso al operario.
async function crear(peticionId, { userId, fecha, hora = '09:00', urgente = null, nota = '', clienteId = null } = {}, por = '', { _stel = null, _enviar = null } = {}) {
  const db = await getDB();
  const S = _stel || require('./stelorder');
  const p = await _peticion(db, peticionId);
  if (p.pedido && p.pedido.id) throw new Error(`Ya tiene el pedido ${p.pedido.ref}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha || ''))) throw new Error('Pon el día');
  if (!/^\d{1,2}:\d{2}$/.test(String(hora || ''))) throw new Error('Pon la hora');
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
  const desc = [p.resumen, p.direccion ? `Dónde: ${p.direccion}` : '', p.contacto ? `Contacto: ${p.contacto}` : '', nota ? `Nota de oficina: ${nota}` : '', `Pedido en el grupo «${p.grupo || 'WhatsApp'}» el ${new Date(p.fecha).toLocaleDateString('es-ES', { timeZone: TZ })}.`].filter(Boolean).join('\n');
  const ped = await S.generarPedidoDesdeIncidencia({ incidentId: incidencia.id, accId: p.clienteId, descripcion: desc, tipo: p.tipo === 'presupuesto' ? 'presupuesto' : 'actuacion', requestedBy: por || 'Crear trabajo' });
  // 3) Asignación con día y hora
  const urg = urgente == null ? !!p.urgente : !!urgente;
  await require('./asignaciones').setAssignment(ped.id, String(u._id), por || null, urg ? 'urgent' : 'normal');
  let obraId = null; try { obraId = (await require('./parteExtra').obra({ clientName: cliente }, { _db: db })).obraId; } catch (e) {}
  await db.collection('workOrderAssignments').updateOne({ workOrderId: String(ped.id) }, { $set: { obraId, fecha, hora, nota: String(nota || '').slice(0, 300), direccion: p.direccion || null, contacto: p.contacto || null, cliente, resumen: p.resumen, peticionId: String(p._id), incidenciaRef: incidencia.ref, pedidoRef: ped.ref, fotoIds: p.fotoIds || [], tipo: p.tipo } });
  // 4) Planificación (y Google Calendar)
  try { await require('./planning').createPlanning({ date: fecha, workerId: String(u._id), workerName: u.name, tipo: p.tipo === 'presupuesto' ? 'visita' : 'trabajo', client: cliente, address: p.direccion || '', workOrderId: String(ped.id), workOrderNumber: ped.ref, nota: p.resumen, horaInicio: hora }); }
  catch (e) { console.warn('[Trabajos] planificación:', e.message); }
  // 5) Petición
  await db.collection('peticionesGrupo').updateOne({ _id: p._id }, { $set: { incidencia: incidencia.ref, incidenciaId: incidencia.id, situacion: 'ya_hay_incidencia', pedido: { id: String(ped.id), ref: ped.ref }, asignado: { userId: String(u._id), nombre: u.name, fecha, hora }, asignadoPor: por, asignadoAt: new Date() } });
  // 6) Aviso al operario
  let avisado = false;
  try {
    const url = (await require('./fichajeAvisos').enlacePersonal(String(u._id))) + '&ir=parte';
    const txt = `🔧 *Trabajo nuevo* para el *${fechaTxt(fecha)} a las ${hora}*${urg ? ' (URGENTE)' : ''}\n*${cliente}*${p.direccion ? ' · ' + p.direccion : ''}\n${p.resumen}${p.contacto ? `\nContacto: ${p.contacto}` : ''}${nota ? `\nNota: ${nota}` : ''}\n\nLo tienes en tu app, con las fotos, en «Mis trabajos»:\n${url}`;
    const tel = u.whatsapp || u.telefono;
    if (tel) avisado = (await (_enviar || require('./notifications').sendWhatsAppTo)(tel, txt, { importante: true })) !== false;
    try { await require('./push').sendToWorker(String(u._id), { title: 'Trabajo nuevo', body: `${fechaTxt(fecha)} ${hora} · ${cliente}`, url: '/parte' }); } catch (e) {}
  } catch (e) { console.warn('[Trabajos] aviso:', e.message); }
  return { ok: true, incidencia: incidencia.ref, pedido: ped.ref, pedidoId: String(ped.id), operario: u.name, fecha, hora, fechaTxt: fechaTxt(fecha), avisado };
}

// Foto de la petición para el operario que tiene ese trabajo.
async function fotoParaOperario(fotoId, workerId) {
  const db = await getDB();
  const a = await db.collection('workOrderAssignments').findOne({ userId: String(workerId), fotoIds: String(fotoId) });
  if (!a) return null;
  return require('./grupoWhatsapp').foto(fotoId);
}

module.exports = { propuesta, crear, operarios, diaPropuesto, fotoParaOperario, _palabras: palabras, _fechaTxt: fechaTxt };
