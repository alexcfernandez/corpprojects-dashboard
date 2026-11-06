// src/grupoWhatsapp.js — Corpy en grupos de WhatsApp (por el puente), en MODO ESCUCHA.
//
// El puente avisa de cada grupo en el que está el número de Corpy (`grupoVisto`), pero
// solo reenvía el CONTENIDO de los grupos que oficina ha activado (colección bridgeGrupos,
// activo:true). En un grupo activo:
//   · cada foto o PDF que parezca un albarán/factura/ticket → Compras (origen 'grupo'),
//     con quién lo mandó y el texto que lo acompañaba; las fotos que no son documentos
//     (fotos de la obra) no se guardan;
//   · los presupuestos y facturas NUESTROS no van a Compras; si el cliente devuelve uno con sello o firma se avisa
//     (peticionesGrupo.presupuestoDevuelto);
//   · las fotos que NO son documentos (fotos de la obra) se guardan aparte en grupoFotos (14/10/2026), con la
//     obra si el texto la nombra, para ir ordenándolas por obra;
//   · un PDF de presupuesto («PRT00853.pdf») que manda alguien de Corp → presupuesto enviado (peticionesGrupo.presupuestoEnviado);
//   · «adelanto de 50 a Diego» de alguien de Corp → registro de adelantos (adelantos.desdeGrupo);
//   · Corpy NO contesta en el grupo (modo escucha): el aviso va a oficina como cualquier compra.
//
//   bridgeGrupos  { _id: jid, nombre, activo, vistoAt, activadoAt, activadoPor, nMensajes, nCompras, ultimoMsgAt }
//   grupoMensajes { jid, grupo, from, quien, texto, media:[{type,name}], compraId, fotoIds, ts }   (se borran a los 90 días)
//   grupoFotos    { jid, grupo, msgId, from, quien, texto, obraId, obraRef, mimetype, bytes, data, ts }

async function getDB() { return require('./db').getDB(); }
const COL = 'bridgeGrupos', MSG = 'grupoMensajes', FOTOS = 'grupoFotos';
let _idx = false;
async function db() {
  const d = await getDB();
  if (!_idx) { _idx = true; d.collection(MSG).createIndex({ ts: 1 }, { expireAfterSeconds: 90 * 24 * 3600 }).catch(() => {}); d.collection(MSG).createIndex({ jid: 1, ts: -1 }).catch(() => {}); }
  return d;
}

// Grupo NUEVO (Corpy acaba de entrar): se activa solo en modo escucha, con peticiones e incidencias automáticas
// (6/11/2026, Álex: «he añadido a Corpy a más grupos: que escuche, cree incidencia y nos lo vaya organizando»). Corpy no
// escribe en él (sin corpyResponde). Se avisa a Álex por si no lo quiere. Los grupos que ya existían no cambian.
// El primer mensaje solo sirve para conocer el grupo (el puente lo reenvía cuando el grupo ya está permitido, en ≤5 min).
// Se apaga con GRUPOS_AUTO=off (entonces entran desactivados, como antes).
async function grupoVisto(jid, nombre, { _enviar = null } = {}) {
  if (!String(jid || '').endsWith('@g.us')) return;
  const d = await db();
  const auto = process.env.GRUPOS_AUTO !== 'off';
  const ins = auto ? { activo: true, peticiones: true, autoIncidencia: true, autoActivadoAt: new Date(), autoActivadoPor: 'Corpy (grupo nuevo)', activadoAt: new Date(), activadoPor: 'Corpy (grupo nuevo)' } : { activo: false };
  const r = await d.collection(COL).updateOne({ _id: jid }, { $set: { nombre: nombre || null, vistoAt: new Date() }, $setOnInsert: { ...ins, nMensajes: 0, nCompras: 0 } }, { upsert: true });
  if (auto && r.upsertedCount) {
    const N = require('./notifications');
    const txt = `👂 Corpy está en un grupo nuevo: *${nombre || jid}*.\nLo escucho desde ya: lo que pidan pasa a Peticiones, se crea la incidencia en StelOrder con sus fotos y te pregunto quién va. No escribo nada en el grupo.\nSi este grupo no es de trabajo, desactívalo en el panel: dashboard.corpprojects.es/diag → Grupos de WhatsApp.`;
    try { await (_enviar || N.sendWhatsAppTo)(N.destinoDueno(), txt, { sinTraducir: true }); } catch (e) { console.warn('[Grupo] aviso grupo nuevo:', e.message); }
  }
  return { nuevo: !!r.upsertedCount };
}
async function gruposPermitidos() {
  const d = await db();
  return (await d.collection(COL).find({ activo: true }).project({ _id: 1 }).toArray()).map(g => g._id);
}
async function listaGrupos() {
  const d = await db();
  return (await d.collection(COL).find({}).sort({ activo: -1, vistoAt: -1 }).toArray()).map(g => ({ jid: g._id, nombre: g.nombre, activo: !!g.activo, vistoAt: g.vistoAt, activadoPor: g.activadoPor || null, avisosPausa: !!g.avisosPausa, nMensajes: g.nMensajes || 0, nCompras: g.nCompras || 0, ultimoMsgAt: g.ultimoMsgAt || null }));
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
  // Un presupuesto que manda alguien de Corp al grupo queda como enviado (petición + nota en StelOrder). Sin esperar.
  const pdfs = doc.media.filter(m => /pdf/i.test(m.type) && m.name).map(m => m.name);
  if (quien.userId && pdfs.length) require('./peticionesGrupo').presupuestoEnviado({ jid, grupo: doc.grupo, nombres: pdfs, por: quien.name }).catch(e => console.warn('[Grupo] presupuesto enviado:', e.message));
  // «Adelanto de 50 a Diego» de alguien de Corp → registro de adelantos (por confirmar hasta que salga en el banco).
  if (quien.userId && texto) require('./adelantos').desdeGrupo({ texto, quien: quien.name, grupo: doc.grupo }).catch(e => console.warn('[Grupo] adelanto:', e.message));
  let nCompras = 0; const fotoIds = [];
  const docs = media.filter(m => /^image\//i.test(m.type) || /pdf/i.test(m.type));
  for (const m of docs) {
    // Un presupuesto nuestro que manda alguien de Corp ya lo marca presupuestoEnviado: no pasa por Compras.
    if (quien.userId && /pdf/i.test(m.type) && require('./peticionesGrupo').refDePdf(m.name)) continue;
    try {
      const buf = await require('./mediaPuente').leer(m.url);
      if (!buf) continue;
      const nota = [texto || await textoReciente(d, jid, p.from), `Grupo «${doc.grupo || 'WhatsApp'}»`].filter(Boolean).join(' · ').slice(0, 300);
      const r = await require('./compras').crear({
        fotos: [{ data: buf, mimetype: m.type }], destino: 'obra', origen: 'grupo', nota, soloSiDocumento: true,
        grupo: { jid, nombre: doc.grupo },
        subidaPor: { kind: 'grupo', userId: quien.userId || String(p.from || 'grupo'), name: quien.name },
      });
      if (r && r.nuestro) {
        // Documento nuestro de vuelta (el cliente lo reenvía, a veces sellado y firmado = aceptado).
        if (!quien.userId) await require('./peticionesGrupo').presupuestoDevuelto({ jid, grupo: doc.grupo, ref: r.numero, nombre: m.name, firmado: r.firmado, quien: quien.name, data: buf, mimetype: m.type, msgId: ins.insertedId }).catch(e => console.warn('[Grupo] presupuesto devuelto:', e.message));
        continue;
      }
      if (r && r.id) { nCompras++; await d.collection(MSG).updateOne({ _id: ins.insertedId }, { $set: { compraId: r.id } }); }
      else if (r && r.noEsDocumento && /^image\//i.test(m.type)) {
        // Foto de la obra: se guarda con la obra que nombre el texto (si nombra solo una).
        const txt = texto || await textoReciente(d, jid, p.from);
        let o = null; try { o = txt ? await require('./comprasVigilancia').obraDeTexto(txt) : null; } catch (e) {}
        const f = await d.collection(FOTOS).insertOne(await require('./archivosDisco').guardar(FOTOS, { jid, grupo: doc.grupo, msgId: ins.insertedId, from: p.from || null, quien: quien.name, texto: txt || null, obraId: o ? String(o._id) : null, obraRef: o ? (o.reference || o.clientName || null) : null, mimetype: m.type, bytes: buf.length, data: buf, ts: new Date() }));
        fotoIds.push(String(f.insertedId));
      }
    } catch (e) { console.error('[Grupo] compra:', e.message); }
  }
  // Vídeos (6/11/2026: Madrenas los manda mucho): aparte, en grupoVideos (en disco), para la petición y StelOrder.
  const videoIds = [];
  for (const m of media.filter(m => /^video\//i.test(m.type))) {
    try {
      const buf = await require('./mediaPuente').leer(m.url);
      if (!buf) continue;
      const v = await d.collection('grupoVideos').insertOne(await require('./archivosDisco').guardar('grupoVideos', { jid, grupo: doc.grupo, msgId: ins.insertedId, from: p.from || null, quien: quien.name, texto: texto || null, mimetype: m.type, bytes: buf.length, data: buf, ts: new Date() }));
      videoIds.push(String(v.insertedId));
    } catch (e) { console.error('[Grupo] vídeo:', e.message); }
  }
  if (fotoIds.length || videoIds.length) await d.collection(MSG).updateOne({ _id: ins.insertedId }, { $set: { fotoIds, ...(videoIds.length ? { videoIds } : {}) } });
  await d.collection(COL).updateOne({ _id: jid }, { $inc: { nMensajes: 1, nCompras, nFotos: fotoIds.length }, $set: { ultimoMsgAt: new Date(), ...(p.groupName ? { nombre: p.groupName } : {}) } });
  if (docs.length) console.log(`[Grupo] ${doc.grupo}: ${quien.name} mandó ${docs.length} archivo(s) → ${nCompras} a Compras, ${fotoIds.length} fotos de obra`);
  // Grupo de trabajos de un operario («Reparaciones David Valencia»): lo que dice de sus trabajos (cita, hecho, fotos).
  if (g.trabajosDe && (texto || fotoIds.length)) require('./trabajosSeguimiento').respuestaGrupo({ g, quien, texto, fotoIds }).then(r => { if (r && r.accion !== 'nada') console.log('[Trabajos] grupo:', JSON.stringify(r)); }).catch(e => console.warn('[Trabajos] grupo:', e.message));
  return { ok: true, nCompras, nFotos: fotoIds.length };
}

// Lo que Corpy ha leído en un grupo (para repasarlo con oficina): mensajes de los últimos `dias`.
async function mensajes(jid, { dias = 7 } = {}) {
  const d = await db();
  const desde = new Date(Date.now() - Math.min(90, Math.max(1, Number(dias) || 7)) * 24 * 3600 * 1000);
  return d.collection(MSG).find({ jid: String(jid), ts: { $gte: desde } }).sort({ ts: -1 }).limit(500).toArray();
}
async function foto(id) {
  const d = await db(); const { ObjectId } = require('mongodb');
  if (!ObjectId.isValid(String(id))) return null;
  return require('./archivosDisco').hidratar(await d.collection(FOTOS).findOne({ _id: new ObjectId(String(id)) }));
}

module.exports = { grupoVisto, gruposPermitidos, listaGrupos, setGrupo, procesar, quienEs, mensajes, foto };
