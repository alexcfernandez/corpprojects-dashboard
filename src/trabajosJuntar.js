// src/trabajosJuntar.js — Lo pendiente de la MISMA comunidad va en el mismo parte (6/11/2026, Álex con Joan Maragall
// 44-46: CINC avisó de la luz de la 6ª el 4/11 y de la de la 5ª el 5/11; a David solo le llegó la 5ª y la 6ª se quedó
// sin hacer. «Se debería actualizar solo el parte si es de la misma comunidad, para poder hacerlo todo de golpe»).
//
// A un trabajo abierto (workOrderAssignments) se le cuelgan como `extras` las peticiones de trabajo del mismo cliente
// que aún no tienen pedido propio. Salen en su parte («📌 En esta comunidad también»), en el WhatsApp del trabajo nuevo
// y, si llegan después, en un WhatsApp aparte a su grupo. La petición queda marcada `juntoA` (en el tablero: «va con
// PDT…»). Si después tiene su propio pedido o se cierra, sale de la lista sola.
// También en el pedido de StelOrder (una línea a 0 € «Misma comunidad · INC…» por cosa) y en el PDF del pedido, que se
// le vuelve a mandar al operario cuando cambia (6/11/2026, Álex: «el papel, el PDF, también; y en StelOrder»).
// Cron cada 15 min de 8 a 20 (scheduler). Se apaga con JUNTAR_TRABAJOS=off.
'use strict';
const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const DIAS = 60;
const corto = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// Peticiones de trabajo del cliente sin pedido propio (ni presupuestos, ni resueltas en el chat, ni dudosas).
async function pendientesDe(db, clienteId, { excluir = [] } = {}) {
  if (!clienteId) return [];
  return db.collection('peticionesGrupo').find({
    clienteId: String(clienteId), estado: 'pendiente', tipo: 'trabajo', 'pedido.id': { $exists: false },
    hechoEnChat: { $ne: true }, porConfirmar: { $ne: true }, noCliente: { $exists: false },
    fecha: { $gte: new Date(Date.now() - DIAS * 86400000) },
    _id: { $nin: excluir.filter(x => ObjectId.isValid(String(x))).map(x => new ObjectId(String(x))) },
  }).sort({ fecha: 1 }).toArray();
}

const extraDe = p => ({ peticionId: String(p._id), incidencia: p.incidencia || null, direccion: p.direccion || null, que: corto(p.queHacer || p.resumen, 200), contacto: p.contacto || null, fecha: p.fecha });
const linea = e => `• ${e.direccion ? e.direccion + ': ' : ''}${e.que}${e.incidencia ? ` (${e.incidencia})` : ''}`;

// Recalcula los extras de un trabajo. Devuelve { extras, nuevos }.
// `_stel`: false = no tocar StelOrder (pruebas).
async function juntar(a, { _db = null, por = 'Corpy', _stel = null } = {}) {
  const db = _db || await getDB();
  if (!a || !a.peticionId || a.status === 'done' || a.cerrado || a.observacion) return { extras: [], nuevos: [] };
  // Pedido ya cerrado en StelOrder (se cerró allí sin parte, como PDT00560 el 6/11): no se le cuelga nada, y lo que
  // tuviera vuelve a quedar suelto para que salga en el tablero y se le haga su propio pedido.
  // Además el trabajo pasa a hecho aquí: si no, el seguimiento seguía preguntando al operario cuándo iba.
  if (_stel !== false && a.workOrderId && await cerradoEnStel(a.workOrderId, _stel)) return { ...(await soltar(db, a)), cerradoStel: await hechoPorStel(db, a) };
  const pet = ObjectId.isValid(String(a.peticionId)) ? await db.collection('peticionesGrupo').findOne({ _id: new ObjectId(String(a.peticionId)) }, { projection: { clienteId: 1 } }) : null;
  if (!pet || !pet.clienteId) return { extras: a.extras || [], nuevos: [] };
  // Las que ya van con OTRO trabajo abierto no se repiten.
  const lista = (await pendientesDe(db, pet.clienteId, { excluir: [a.peticionId] }))
    .filter(p => !p.juntoA || p.juntoA.workOrderId === String(a.workOrderId));
  const antes = new Set((a.extras || []).map(e => e.peticionId));
  const extras = lista.map(extraDe);
  const nuevos = extras.filter(e => !antes.has(e.peticionId));
  const fuera = (a.extras || []).filter(e => !extras.some(x => x.peticionId === e.peticionId));
  if (nuevos.length || fuera.length) {
    await db.collection('workOrderAssignments').updateOne({ _id: a._id }, { $set: { extras, extrasAt: new Date() } });
    if (nuevos.length) await db.collection('peticionesGrupo').updateMany({ _id: { $in: nuevos.map(e => new ObjectId(e.peticionId)) } }, { $set: { juntoA: { workOrderId: String(a.workOrderId), pedidoRef: a.pedidoRef || null, userId: a.userId || null, userName: a.userName || null, at: new Date(), por } } });
    if (fuera.length) await db.collection('peticionesGrupo').updateMany({ _id: { $in: fuera.map(e => new ObjectId(e.peticionId)) }, 'juntoA.workOrderId': String(a.workOrderId) }, { $unset: { juntoA: '' } });
  }
  // StelOrder: solo si lo que tiene el pedido allí no es lo de ahora. Si falla, se reintenta en la próxima vuelta.
  let stel = null;
  const clave = extras.map(e => e.peticionId).join(',');
  if (_stel !== false && a.workOrderId && clave !== (a.extrasStel || []).join(',') && (extras.length || (a.extrasStel || []).length)) {
    try {
      stel = await (_stel || require('./stelorder')).lineasMismaComunidad(a.workOrderId, extras, { requestedBy: `${por} (misma comunidad)` });
      await db.collection('workOrderAssignments').updateOne({ _id: a._id }, { $set: { extrasStel: extras.map(e => e.peticionId), extrasStelAt: new Date() } });
    } catch (e) {
      if (/E000152|cannot be edited/i.test(e.message)) return { ...(await soltar(db, a)), cerradoStel: await hechoPorStel(db, a) };
      console.warn('[Juntar] StelOrder:', e.message); stel = { error: e.message };
    }
  }
  return { extras, nuevos, fuera, stel };
}

// Estado del pedido en StelOrder desde la caché (1 h): no gasta llamadas en cada vuelta. Si no está, no se sabe: abierto.
async function cerradoEnStel(workOrderId, _stel = null) {
  try {
    const S = _stel || require('./stelorder');
    const [lista, estados] = await Promise.all([S.getAllWorkOrders(), S.getWorkOrderStateMap()]);
    const w = (lista || []).find(x => String(x.id) === String(workOrderId));
    return !!w && (w.deleted === true || /cerrad|factur|anulad|rechaz/i.test(estados[String(w['document-state-id'])] || ''));
  } catch (e) { return false; }
}

// Pedido cerrado o facturado en StelOrder sin parte en el panel (Joan Maragall PDT00560, 6/11/2026): el trabajo queda hecho.
async function hechoPorStel(db, a) {
  await db.collection('workOrderAssignments').updateOne({ _id: a._id, status: { $nin: ['done', 'invoiced'] } }, { $set: { status: 'done', cerradoEnStelAt: new Date() } });
  return true;
}

// Quita los extras de un trabajo y suelta sus peticiones.
async function soltar(db, a) {
  const fuera = a.extras || [];
  if (fuera.length) {
    await db.collection('workOrderAssignments').updateOne({ _id: a._id }, { $set: { extras: [], extrasAt: new Date() } });
    await db.collection('peticionesGrupo').updateMany({ _id: { $in: fuera.filter(e => ObjectId.isValid(e.peticionId)).map(e => new ObjectId(e.peticionId)) }, 'juntoA.workOrderId': String(a.workOrderId) }, { $unset: { juntoA: '' } });
  }
  return { extras: [], nuevos: [], fuera };
}

// Texto para el WhatsApp del trabajo nuevo.
const textoExtras = extras => extras.length ? `\n\n📌 *En esta comunidad también hay que* (hazlo en la misma visita):\n${extras.map(linea).join('\n')}` : '';

// Cron: todos los trabajos abiertos; lo que se haya añadido, al grupo del operario.
async function revisar({ _db = null, _enviar = null, _stel = null, _archivo = null } = {}) {
  if (process.env.JUNTAR_TRABAJOS === 'off') return { apagado: true };
  const db = _db || await getDB();
  const abiertos = await require('./trabajosSeguimiento').abiertos({ _db: db });
  const res = { trabajos: abiertos.length, avisos: [] };
  for (const a of abiertos) {
    const { nuevos } = await juntar(a, { _db: db, _stel });
    if (!nuevos.length || !a.userId) continue;
    const txt = `📌 *Añadido a tu trabajo de ${corto(a.cliente, 45)}*${a.pedidoRef ? ` (${a.pedidoRef})` : ''}\n` +
      `En la misma comunidad también ${nuevos.length === 1 ? 'hay que' : 'hay que hacer'}:\n${nuevos.map(linea).join('\n')}\n\nHazlo en la misma visita. Lo tienes en tu parte y en el pedido actualizado (PDF).`;
    res.avisos.push({ workOrderId: a.workOrderId, cliente: a.cliente, nuevos: nuevos.length });
    try {
      const enviar = _enviar || require('./notifications').sendWhatsAppTo;
      const g = await db.collection('bridgeGrupos').findOne({ trabajosDe: String(a.userId), activo: true });
      const u = g ? null : await db.collection('users').findOne({ _id: new ObjectId(String(a.userId)) }, { projection: { whatsapp: 1, telefono: 1 } });
      const to = g ? g._id : (u && (u.whatsapp || u.telefono));
      if (to) await enviar(to, txt, { importante: true, sinTraducir: true });
      // El pedido en PDF otra vez, ya con lo añadido.
      if (to && (_archivo || !_enviar)) {
        const f = await require('./trabajos').pdfDeTrabajo(a.workOrderId, { _db: db });
        if (f) await (_archivo || require('./canalWhatsapp').enviarArchivo)(to, `📄 Pedido ${a.pedidoRef || ''} actualizado · ${corto(a.cliente, 40)}`, { data: f.data, mime: 'application/pdf', nombre: f.nombre });
      }
    } catch (e) { console.warn('[Juntar] aviso:', e.message); }
  }
  return res;
}

module.exports = { juntar, revisar, pendientesDe, textoExtras, cerradoEnStel, _linea: linea };
