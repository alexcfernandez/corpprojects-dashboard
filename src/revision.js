// src/revision.js — REVISIÓN DEL DÍA (Álex, 15/10/2026: «cada día a las 9 de la noche, una revisión de todo: los correos,
// lo que ha hecho el dashboard, lo que ha hecho Corpy… y en el inicio algo interactivo para corregir lo que esté mal»).
//
//   datos(fecha)  → todo lo del día en un solo sitio (conversaciones de Corpy, grupos, encargos, compras, viajes a tiendas,
//                   papeles subidos, correos, altas, escrituras en StelOrder). Lo lee la revisión de las 21:00.
//   guardar(rev)  → la revisión escrita: un resumen y una lista de puntos. Cada punto es «arreglado» (ya hecho, para que
//                   se sepa), «decidir» (con botones) o «aviso». Se ve en el inicio hasta que se marca.
//   ejecutar()    → los botones solo pueden hacer cosas de esta lista cerrada (ACCIONES), nunca nada libre.

const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const COL = 'revisiones';
const TZ = 'Europe/Madrid';
const hoyMadrid = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: TZ });
// Límites del día en Madrid (aprox.: +02/+01 según la fecha) en UTC.
function limites(fecha) {
  const off = -new Date(`${fecha}T12:00:00Z`).toLocaleString('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' }).match(/GMT([+-]\d+)/)[1] * 1;
  const ini = new Date(`${fecha}T00:00:00Z`); ini.setUTCHours(ini.getUTCHours() + off);
  return { ini, fin: new Date(ini.getTime() + 864e5) };
}
const corto = (t, n = 300) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);

async function datos(fecha = hoyMadrid()) {
  const db = await getDB();
  const { ini, fin } = limites(fecha);
  const out = { fecha, desde: ini, hasta: fin };
  const w = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = { error: e.message }; } };

  // Corpy: con quién ha hablado hoy y qué le han dicho (entrante entero; lo del bot, recortado).
  await w('whatsapp', async () => {
    const WL = require('./waLog');
    const conv = (await WL.conversaciones({ dias: 2 })).filter(c => c.ultimo && new Date(c.ultimo.ts) >= ini);
    const res = [];
    for (const c of conv) {
      const h = await WL.hilo(c.numero, { dias: 2 });
      const ms = (h.mensajes || h || []).filter(m => new Date(m.ts) >= ini && new Date(m.ts) < fin);
      if (!ms.length) continue;
      res.push({ numero: c.numero, nombre: c.nombre, rol: c.rol, entrantes: ms.filter(m => m.dir === 'in').length, salientes: ms.filter(m => m.dir !== 'in').length,
        mensajes: ms.map(m => ({ hora: new Date(m.ts).toLocaleTimeString('es-ES', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }), dir: m.dir, texto: m.dir === 'in' ? corto(m.texto, 600) : corto(m.texto, 220), media: (m.media || []).map(x => x.type).filter(Boolean) })) });
    }
    return res.sort((a, b) => b.entrantes - a.entrantes);
  });
  // Grupos de WhatsApp que escucha Corpy
  await w('grupos', async () => (await db.collection('grupoMensajes').find({ ts: { $gte: ini, $lt: fin } }).project({ grupo: 1, quien: 1, texto: 1, media: 1, compraId: 1, ts: 1 }).sort({ ts: 1 }).limit(300).toArray())
    .map(m => ({ grupo: m.grupo, quien: m.quien, hora: new Date(m.ts).toLocaleTimeString('es-ES', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }), texto: corto(m.texto, 300), media: (m.media || []).map(x => x.type), compraId: m.compraId || null })));
  // Encargos (lo que Corpy pide a la gente): abiertos, con días y recordatorios — lo que se queda «estancado».
  await w('encargos', async () => (await require('./encargos').lista({ abiertos: true })).map(e => ({ id: e.id, nombre: e.nombre, que: e.que, dias: e.dias, recordatorios: e.recordatorios, origen: e.origen && e.origen.tipo, compraId: e.origen && e.origen.compraId, ultima: e.ultimaRespuesta && corto(e.ultimaRespuesta.texto, 120) })));
  // Compras: las de hoy y cómo está la cola
  await w('compras', async () => {
    const hoy = await db.collection('compras').find({ createdAt: { $gte: ini, $lt: fin } }).project({ proveedor: 1, total: 1, tipo: 1, estado: 1, origen: 1, obraRef: 1, destino: 1, 'subidaPor.name': 1, fecha: 1, descarteMotivo: 1 }).toArray();
    const cola = await db.collection('compras').aggregate([{ $match: { estado: 'por_revisar' } }, { $group: { _id: { origen: '$origen', sinObra: { $in: ['$obraId', [null, '']] } }, n: { $sum: 1 }, total: { $sum: '$total' } } }]).toArray();
    return { hoy: hoy.map(c => ({ id: String(c._id), quien: c.subidaPor && c.subidaPor.name, proveedor: c.proveedor, total: c.total, tipo: c.tipo, estado: c.estado, origen: c.origen, obra: c.obraRef || c.destino || null, fecha: c.fecha, motivo: c.descarteMotivo || null })),
      porRevisar: cola.map(x => ({ origen: x._id.origen, sinObra: x._id.sinObra, n: x.n, total: Math.round((x.total || 0) * 100) / 100 })) };
  });
  // Cuántas veces ha ido cada uno a comprar (pagos con tarjeta en tiendas), hoy y media de los últimos 30 días.
  await w('viajes', async () => {
    const desde = new Date(ini.getTime() - 30 * 864e5).toISOString().slice(0, 10);
    const pagos = await require('./comprasVigilancia')._pagosTarjeta(desde);
    const TIENDA = /obramat|bricomart|leroy|bauhaus|werkhaus|bigmat|saltoki|palah|oliveras|placandreu|pintur|ferret|brico|weber|sanitari|electric|fontaner|ikea|aki\b|wurth|würth|amazon/i;
    const t = pagos.filter(p => TIENDA.test(p.concepto || ''));
    const por = {};
    for (const p of t) { const x = (por[p.persona] = por[p.persona] || { persona: p.persona, hoy: [], dias: new Set(), n30: 0 }); x.n30++; x.dias.add(p.fecha); if (p.fecha === fecha) x.hoy.push({ tienda: corto(p.concepto, 40), importe: p.importe }); }
    return Object.values(por).map(x => ({ persona: x.persona, hoy: x.hoy.length, detalleHoy: x.hoy, mediaDia30: Math.round((x.n30 / Math.max(1, x.dias.size)) * 10) / 10, diasConCompra30: x.dias.size, pagos30: x.n30 })).sort((a, b) => b.hoy - a.hoy || b.pagos30 - a.pagos30);
  });
  // Papeles que han entrado hoy en Personal
  await w('personal', async () => (await db.collection('docsPersonal').find({ subido: { $gte: ini, $lt: fin } }).project({ tipo: 1, nombre: 1, userId: 1, ambito: 1, subidoPor: 1, estado: 1 }).limit(100).toArray()).map(d => ({ id: String(d._id), tipo: d.tipo, nombre: d.nombre, userId: d.userId, ambito: d.ambito, por: d.subidoPor, estado: d.estado })));
  // Correos de hoy (lo que ha clasificado el dashboard)
  await w('correos', async () => (await db.collection('emails').find({ fecha: { $gte: ini, $lt: fin } }).project({ de: 1, asunto: 1, categoria: 1, urgencia: 1, compraId: 1, estado: 1, tieneAdjuntos: 1 }).sort({ fecha: 1 }).limit(200).toArray())
    .map(e => ({ de: corto(e.de, 60), asunto: corto(e.asunto, 120), categoria: e.categoria, urgencia: e.urgencia, adjuntos: !!e.tieneAdjuntos, compra: !!e.compraId, estado: e.estado || null })));
  // Altas de gente nueva abiertas: qué paso falta
  await w('altas', async () => (await require('./incorporaciones').lista({})).map(i => ({ id: i.id || String(i._id), nombre: i.nombre, inicio: i.fechaInicio, falta: (i.pasos || []).filter(p => !p.ok && p.antes).map(p => p.t + (p.nota ? ` (${p.nota})` : '')) })));
  // Lo que el dashboard ha escrito hoy en StelOrder
  await w('stel', async () => (await db.collection('stelWriteLog').find({ at: { $gte: ini, $lt: fin } }).project({ tipo: 1, doc: 1, tercero: 1, por: 1, hechos: 1 }).limit(100).toArray()).map(x => ({ tipo: x.tipo, doc: x.doc, tercero: x.tercero, por: x.por, n: (x.hechos || []).length })));
  // Revisiones anteriores con puntos sin resolver (para no repetir y para insistir)
  await w('pendientesDeAntes', async () => (await db.collection(COL).find({ 'items.estado': 'pendiente' }).project({ fecha: 1, items: 1 }).sort({ fecha: -1 }).limit(7).toArray())
    .flatMap(r => r.items.filter(i => i.estado === 'pendiente').map(i => ({ fecha: r.fecha, titulo: i.titulo }))));
  return out;
}

// Botones permitidos en los puntos de la revisión
const ACCIONES = {
  a_personal: async (p, por) => require('./compras').aPersonal(p.compraId, por, { tipo: p.tipo || 'otro', nombre: p.nombre || null }),
  a_obra: async (p, por) => require('./compras').aObra(p.compraId, por, { tipo: p.tipo || 'partes_trabajo', nombre: p.nombre || null }),
  descartar_compra: async (p, por) => require('./compras').descartar(p.compraId, por, p.motivo || 'Descartada desde la revisión del día', { avisar: !!p.avisar }),
  cerrar_encargo: async (p, por) => require('./encargos').cerrar(p.encargoId, { como: p.como === 'hecho' ? 'hecho' : 'cancelado', por }),
  // «Todo firmado y recibido»: mandar el alta a la gestoría (Eduard). Solo con el botón, nunca sola.
  enviar_gestoria: async (p, por) => require('./incorporaciones').enviarGestoria(p.incorporacionId, por),
};

function limpiarItem(i, k) {
  const tipo = ['arreglado', 'decidir', 'aviso'].includes(i.tipo) ? i.tipo : 'aviso';
  const acciones = (Array.isArray(i.acciones) ? i.acciones : []).filter(a => a && (ACCIONES[a.accion] || (a.accion === 'enlace' && /^\/[\w\-/?=&.#%]*$/.test(String(a.url || ''))))).slice(0, 4)
    .map(a => ({ label: corto(a.label, 40) || 'Hacer', accion: a.accion, url: a.accion === 'enlace' ? a.url : undefined, params: a.params && typeof a.params === 'object' ? JSON.parse(JSON.stringify(a.params)) : {} }));
  return { id: String(k + 1), tipo, area: corto(i.area, 30) || null, titulo: corto(i.titulo, 160), detalle: corto(i.detalle, 900) || null, acciones, estado: tipo === 'arreglado' ? 'hecho' : 'pendiente' };
}

async function guardar(rev = {}, por = 'Claude') {
  const db = await getDB();
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(rev.fecha || '')) ? rev.fecha : hoyMadrid();
  const items = (Array.isArray(rev.items) ? rev.items : []).slice(0, 40).map(limpiarItem).filter(i => i.titulo);
  const doc = { fecha, resumen: corto(rev.resumen, 2500), items, por, creadoAt: new Date() };
  await db.collection(COL).updateOne({ fecha }, { $set: doc }, { upsert: true });
  if (rev.avisar) {
    const dec = items.filter(i => i.tipo === 'decidir').length, arr = items.filter(i => i.tipo === 'arreglado').length;
    const txt = `🌙 *Revisión del día ${fecha.split('-').reverse().slice(0, 2).join('/')}*\n\n${doc.resumen}\n\n${arr ? `✔ Arreglado: ${arr}. ` : ''}${dec ? `👉 Para decidir: ${dec} (en el inicio del dashboard, con botones).` : ''}\nhttps://dashboard.corpprojects.es/`;
    try { const N = require('./notifications'); await N.sendWhatsAppTo(N.destinoDueno(), txt.slice(0, 3500)); } catch (e) { console.warn('[Revisión] aviso:', e.message); }
  }
  return { ok: true, fecha, items: items.length };
}

// Para el inicio: la última revisión y lo que quede pendiente de las anteriores (7 días).
async function paraInicio() {
  const db = await getDB();
  const rs = await db.collection(COL).find({}).sort({ fecha: -1 }).limit(7).toArray();
  if (!rs.length) return null;
  const ult = rs[0];
  const antes = rs.slice(1).flatMap(r => r.items.filter(i => i.estado === 'pendiente' && i.tipo === 'decidir').map(i => ({ ...i, revId: String(r._id), fecha: r.fecha })));
  return { id: String(ult._id), fecha: ult.fecha, resumen: ult.resumen, items: ult.items.map(i => ({ ...i, revId: String(ult._id), fecha: ult.fecha })), antes };
}

async function marcar(revId, itemId, estado, por) {
  const db = await getDB();
  if (!['hecho', 'ignorado', 'pendiente'].includes(estado)) throw new Error('Estado no válido');
  const r = await db.collection(COL).updateOne({ _id: new ObjectId(String(revId)), 'items.id': String(itemId) }, { $set: { 'items.$.estado': estado, 'items.$.resueltoPor': por, 'items.$.resueltoAt': new Date() } });
  if (!r.matchedCount) throw new Error('No encuentro ese punto');
  return { ok: true };
}

async function ejecutar(revId, itemId, n, por) {
  const db = await getDB();
  const r = await db.collection(COL).findOne({ _id: new ObjectId(String(revId)) });
  const it = r && r.items.find(i => i.id === String(itemId));
  const a = it && it.acciones[Number(n)];
  if (!a || !ACCIONES[a.accion]) throw new Error('Acción no válida');
  const res = await ACCIONES[a.accion](a.params || {}, por);
  await db.collection(COL).updateOne({ _id: r._id, 'items.id': it.id }, { $set: { 'items.$.estado': 'hecho', 'items.$.resueltoPor': por, 'items.$.resueltoAt': new Date(), 'items.$.hechoCon': a.label } });
  return { ok: true, res };
}

module.exports = { datos, guardar, paraInicio, marcar, ejecutar, limpiarItem, limites, ACCIONES };
