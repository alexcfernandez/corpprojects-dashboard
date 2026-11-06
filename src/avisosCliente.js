// src/avisosCliente.js — El grupo del cliente se entera cuando el trabajo avanza (6/11/2026, Álex: «lo chulo sería que
// cuando pasamos de una cosa a otra en el proceso también se avisara… automático, y que yo lo pueda poner en pausa»).
// Pasos que se avisan en el grupo de WhatsApp del que vino la petición (Corpy escribe en él solo para esto):
//   · programado: ya hay técnico y día («el lunes 9 pasa David»); si cambia el día, se vuelve a avisar;
//   · hecho: el técnico cierra el parte como completado.
// No se avisa si: el trabajo no vino de un grupo (correo, llamada, StelOrder), el grupo no está activo, el grupo tiene
// los avisos en pausa (bridgeGrupos.avisosPausa) o están en pausa todos (config 'avisosCliente'.pausa, botón del tablero).
// Un pedido cerrado en StelOrder a mano NO avisa: lo cerró la oficina y ya lo habrá dicho.
// También aquí: mandar a un técnico desde el tablero (asignar), aunque la incidencia se creara en StelOrder sin petición.
'use strict';
const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const CFG = 'avisosCliente';
const corto = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const nombrePila = n => String(n || '').trim().split(/\s+/)[0] || 'el técnico';

async function estado({ _db = null } = {}) {
  const db = _db || await getDB();
  const c = await db.collection('config').findOne({ _id: CFG });
  // Hasta que Álex los active la primera vez (botón del tablero), en pausa: Corpy no escribe a ningún cliente sin su OK.
  if (!c) return { pausa: true, nuncaActivado: true, desde: null, por: null };
  return { pausa: !!c.pausa, desde: c.pausaAt || null, por: c.pausaPor || null };
}
async function pausar(on, por = '') {
  const db = await getDB();
  await db.collection('config').updateOne({ _id: CFG }, { $set: { pausa: !!on, pausaAt: new Date(), pausaPor: por } }, { upsert: true });
  return estado({ _db: db });
}
async function pausarGrupo(jid, on, por = '') {
  const db = await getDB();
  const r = await db.collection('bridgeGrupos').updateOne({ _id: String(jid) }, { $set: { avisosPausa: !!on, avisosPausaAt: new Date(), avisosPausaPor: por } });
  if (!r.matchedCount) throw new Error('Ese grupo no lo conozco');
  return { ok: true, pausa: !!on };
}

function texto(pasoN, a, p) {
  const que = `lo de ${corto(a.direccion || p.direccion || a.cliente || p.clienteStel || p.cliente, 70)}${a.incidenciaRef ? ` (${a.incidenciaRef})` : ''}`;
  const extras = (a.extras || []).length ? `\nTambién: ${a.extras.map(e => corto(`${e.direccion ? e.direccion + ': ' : ''}${e.que}`, 80)).join('; ')}.` : '';
  if (pasoN === 'programado') {
    const f = require('./trabajos')._fechaTxt(a.fecha);
    return `Hola, soy Corpy, de la oficina de Corp Projects. Para ${que}: pasa ${nombrePila(a.userName)} el ${f}${a.hora ? ' a las ' + a.hora : ''}.${extras}\nSi hay que cambiar algo, decídnoslo aquí. Gracias.`;
  }
  return `Hola, soy Corpy, de la oficina de Corp Projects. ${que.charAt(0).toUpperCase() + que.slice(1)}: ya está hecho.${extras}\nCualquier cosa, nos decís. Gracias.`;
}

// Avisa (una vez por paso; «programado», una vez por día) en el grupo del que vino la petición.
async function paso(workOrderId, pasoN, { _db = null, _enviar = null } = {}) {
  if (process.env.AVISOS_CLIENTE === 'off') return { no: 'apagado' };
  const db = _db || await getDB();
  const a = await db.collection('workOrderAssignments').findOne({ workOrderId: String(workOrderId) });
  if (!a || !a.peticionId || !ObjectId.isValid(String(a.peticionId))) return { no: 'sin petición' };
  if (pasoN === 'programado' && !a.fecha) return { no: 'sin día' };
  const clave = pasoN === 'programado' ? `programado:${a.fecha}${a.hora ? ' ' + a.hora : ''}` : pasoN;
  if ((a.avisosCliente || []).some(x => x.clave === clave)) return { no: 'ya avisado' };
  const p = await db.collection('peticionesGrupo').findOne({ _id: new ObjectId(String(a.peticionId)) });
  if (!p) return { no: 'sin petición' };
  // Petición apuntada a mano de un grupo que Corpy aún no conocía (Oviedo 16, del chat exportado de Madrenas): por su nombre.
  if (!String(p.jid || '').endsWith('@g.us') && p.grupo) { const gg = await db.collection('bridgeGrupos').findOne({ nombre: p.grupo }); if (gg) p.jid = gg._id; }
  if (!String(p.jid || '').endsWith('@g.us')) return { no: 'no viene de un grupo' };
  if ((await estado({ _db: db })).pausa) return { no: 'en pausa (todos)' };
  const g = await db.collection('bridgeGrupos').findOne({ _id: p.jid });
  if (!g || !g.activo) return { no: 'grupo no activo' };
  if (g.avisosPausa) return { no: 'en pausa (grupo)' };
  const txt = texto(pasoN, a, p);
  const ok = (await (_enviar || require('./notifications').sendWhatsAppTo)(p.jid, txt, { sinTraducir: true, importante: true })) !== false;
  if (ok) await db.collection('workOrderAssignments').updateOne({ _id: a._id }, { $push: { avisosCliente: { clave, paso: pasoN, grupo: g.nombre || p.jid, at: new Date() } } });
  return { ok, grupo: g.nombre || p.jid, texto: txt };
}
const pasoSinEsperar = (woId, pasoN) => paso(woId, pasoN).then(r => { if (r.ok) console.log(`[AvisosCliente] ${pasoN} → ${r.grupo}`); }).catch(e => console.warn('[AvisosCliente]', e.message));

// Nombre y teléfono que haya en el texto («Llogater - Paco 609 76 89 10», «Jimi 647437957»).
function contactosDe(texto) {
  const out = [];
  const re = /([A-ZÀ-Ý][A-Za-zÀ-ÿ'·.]+(?:\s+[A-ZÀ-Ý][A-Za-zÀ-ÿ'·.]+){0,3})?\s*[-:–(]?\s*((?:\+?34\s?)?[6789](?:[\s.]?\d){8})(?!\d)/g;
  let m; while ((m = re.exec(String(texto || ''))) && out.length < 4) {
    const tel = m[2].replace(/\D/g, '').slice(-9);
    if (!out.some(o => o.tel === tel)) out.push({ nombre: (m[1] || '').trim(), tel });
  }
  return out.map(o => `${o.nombre ? o.nombre + ' ' : ''}${o.tel.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3')}`).join(' · ');
}

// Desde el tablero: la tarjeta (petición o incidencia de StelOrder) → trabajo para el técnico, con su día.
// Una incidencia creada a mano en StelOrder no tiene petición: se le hace una con su texto (y los teléfonos que lleve).
async function asignar({ peticionId = null, incRef = null, userId, fecha = null, hora = null, nota = '' }, por = '') {
  const db = await getDB();
  let pid = peticionId;
  if (!pid && incRef) {
    const ya = await db.collection('peticionesGrupo').findOne({ incidencia: incRef });
    if (ya) pid = String(ya._id);
    else {
      const S = require('./stelorder');
      const [incs, { clientMap }] = await Promise.all([S.getAllIncidents(), S.getClients()]);
      const i = incs.find(x => x['full-reference'] === incRef);
      if (!i) throw new Error(`No encuentro ${incRef} en StelOrder`);
      const c = clientMap[String(i['account-id'])] || {};
      const desc = String(i.description || '').replace(/\r/g, '').trim();
      const r = await db.collection('peticionesGrupo').insertOne({
        jid: 'stelorder', grupo: 'StelOrder', fuente: 'stelorder', tipo: 'trabajo', estado: 'pendiente', situacion: 'ya_hay_incidencia',
        clienteId: String(i['account-id']), clienteStel: c.name || null, cliente: c.name || incRef, direccion: null,
        contacto: contactosDe(desc) || null, resumen: corto(desc, 600) || incRef, queHacer: corto(desc, 300),
        incidencia: incRef, incidenciaId: String(i.id), incidenciaCreadaAt: new Date(i.date), mensajes: [{ fecha: new Date(i.date), quien: 'StelOrder', texto: corto(desc, 1500) }],
        fotoIds: [], fecha: new Date(i.date), creado: new Date(), creadoPor: `${por || 'Oficina'} (tablero)`,
      });
      pid = String(r.insertedId);
    }
  }
  if (!pid) throw new Error('Falta la petición o la incidencia');
  return require('./trabajos').crear(pid, { userId, fecha: fecha || null, hora: hora || null, nota }, por);
}

module.exports = { paso, pasoSinEsperar, estado, pausar, pausarGrupo, asignar, contactosDe, _texto: texto };
