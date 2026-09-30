// src/grupoWhatsapp.js — Corpy en grupos de WhatsApp (por el puente), en MODO ESCUCHA.
//
// El puente avisa de cada grupo en el que está el número de Corpy (`grupoVisto`), pero
// solo reenvía el CONTENIDO de los grupos que oficina ha activado (colección bridgeGrupos,
// activo:true). En un grupo activo:
//   · cada foto o PDF que parezca un albarán/factura/ticket → Compras (origen 'grupo'),
//     con quién lo mandó y el texto que lo acompañaba; las fotos que no son documentos
//     (fotos de la obra) no se guardan;
//   · Corpy NO contesta en el grupo (modo escucha): el aviso va a oficina como cualquier compra.
//
//   bridgeGrupos  { _id: jid, nombre, activo, vistoAt, activadoAt, activadoPor, nMensajes, nCompras, ultimoMsgAt }
//   grupoMensajes { jid, grupo, from, quien, texto, media:[{type,name}], compraId, ts }   (se borran a los 90 días)

async function getDB() { return require('./db').getDB(); }
const COL = 'bridgeGrupos', MSG = 'grupoMensajes';
let _idx = false;
async function db() {
  const d = await getDB();
  if (!_idx) { _idx = true; d.collection(MSG).createIndex({ ts: 1 }, { expireAfterSeconds: 90 * 24 * 3600 }).catch(() => {}); d.collection(MSG).createIndex({ jid: 1, ts: -1 }).catch(() => {}); }
  return d;
}

async function grupoVisto(jid, nombre) {
  if (!String(jid || '').endsWith('@g.us')) return;
  const d = await db();
  await d.collection(COL).updateOne({ _id: jid }, { $set: { nombre: nombre || null, vistoAt: new Date() }, $setOnInsert: { activo: false, nMensajes: 0, nCompras: 0 } }, { upsert: true });
}
async function gruposPermitidos() {
  const d = await db();
  return (await d.collection(COL).find({ activo: true }).project({ _id: 1 }).toArray()).map(g => g._id);
}
async function listaGrupos() {
  const d = await db();
  return (await d.collection(COL).find({}).sort({ activo: -1, vistoAt: -1 }).toArray()).map(g => ({ jid: g._id, nombre: g.nombre, activo: !!g.activo, vistoAt: g.vistoAt, activadoPor: g.activadoPor || null, nMensajes: g.nMensajes || 0, nCompras: g.nCompras || 0, ultimoMsgAt: g.ultimoMsgAt || null }));
}
async function setGrupo(jid, { activo }, por) {
  if (!String(jid).endsWith('@g.us')) throw new Error('Grupo no válido');
  const d = await db();
  const r = await d.collection(COL).updateOne({ _id: jid }, { $set: { activo: !!activo, ...(activo ? { activadoAt: new Date(), activadoPor: por || '' } : { desactivadoAt: new Date() }) } });
  if (!r.matchedCount) throw new Error('Ese grupo aún no lo ha visto el puente');
  return { ok: true, activo: !!activo, nota: 'El puente lo aplica en menos de 5 minutos.' };
}

// Nombre de quien escribe: su ficha (por teléfono) o el nombre que tiene en WhatsApp.
async function quienEs(from, pushName) {
  const dig = String(from || '').replace(/\D/g, '').slice(-9);
  if (dig.length === 9) {
    try {
      const us = await require('./users').getUsers(false);
      const u = us.find(x => [x.whatsapp, x.telefono].some(t => String(t || '').replace(/\D/g, '').slice(-9) === dig));
      if (u) return { userId: String(u._id), name: u.name };
    } catch (e) {}
  }
  return { userId: null, name: pushName || from || 'Alguien del grupo' };
}

// Texto reciente de la misma persona (la instrucción suele ir en otro mensaje: "albarán de Rutlla").
async function textoReciente(d, jid, from) {
  const m = await d.collection(MSG).find({ jid, from, texto: { $nin: [null, ''] }, ts: { $gte: new Date(Date.now() - 10 * 60 * 1000) } }).sort({ ts: -1 }).limit(1).toArray();
  return m[0] ? m[0].texto : '';
}

// Mensaje de un grupo ACTIVO (el puente ya filtra, pero se vuelve a comprobar aquí).
// `media` llega ya guardada en memoria por el servidor: [{ url:'bridge-media:…', type, name }].
async function procesar(p) {
  const d = await db();
  const jid = String(p.chatId || '');
  const g = await d.collection(COL).findOne({ _id: jid });
  if (!g || !g.activo) return { ignorado: true };
  const quien = await quienEs(p.from, p.pushName);
  const texto = String(p.body || '').trim().slice(0, 1000);
  const media = (p.media || []).filter(m => m && m.url);
  const doc = { jid, grupo: p.groupName || g.nombre || null, from: p.from || null, quien: quien.name, texto: texto || null, media: (p.media || []).map(m => ({ type: m.type, name: m.name || null, fallo: !m.url })), compraId: null, ts: new Date() };
  const ins = await d.collection(MSG).insertOne(doc);
  let nCompras = 0;
  const docs = media.filter(m => /^image\//i.test(m.type) || /pdf/i.test(m.type));
  for (const m of docs) {
    try {
      const buf = await require('./mediaPuente').leer(m.url);
      if (!buf) continue;
      const nota = [texto || await textoReciente(d, jid, p.from), `Grupo «${doc.grupo || 'WhatsApp'}»`].filter(Boolean).join(' · ').slice(0, 300);
      const r = await require('./compras').crear({
        fotos: [{ data: buf, mimetype: m.type }], destino: 'obra', origen: 'grupo', nota, soloSiDocumento: true,
        grupo: { jid, nombre: doc.grupo },
        subidaPor: { kind: 'grupo', userId: quien.userId || String(p.from || 'grupo'), name: quien.name },
      });
      if (r && r.id) { nCompras++; await d.collection(MSG).updateOne({ _id: ins.insertedId }, { $set: { compraId: r.id } }); }
    } catch (e) { console.error('[Grupo] compra:', e.message); }
  }
  await d.collection(COL).updateOne({ _id: jid }, { $inc: { nMensajes: 1, nCompras }, $set: { ultimoMsgAt: new Date(), ...(p.groupName ? { nombre: p.groupName } : {}) } });
  if (docs.length) console.log(`[Grupo] ${doc.grupo}: ${quien.name} mandó ${docs.length} archivo(s) → ${nCompras} a Compras`);
  return { ok: true, nCompras };
}

module.exports = { grupoVisto, gruposPermitidos, listaGrupos, setGrupo, procesar, quienEs };
