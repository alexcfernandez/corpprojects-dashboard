// src/gestores.js — Mapa comunidad → gestor, aprendido pasivamente.
// Aprende de dos señales (sin enviar nada, solo observa y anota):
//   1) El asunto referencia una factura/pedido (RE: Factura FAC00759...).
//   2) El asunto/cuerpo NOMBRA la comunidad (ej. "C.P. PK PL. JOSEP IRLA 17-18-19"),
//      que casamos con los clientes de StelOrder por coincidencia de palabras clave.
// Colección: communityManagers
//   { accountId, communityName, family, managerEmail, managerName,
//     hits, refs[], firstSeenAt, lastSeenAt, confirmed }

async function getDB() {
  return require('./db').getDB();
}

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function parseRemitente(de) {
  const s = String(de || '').trim();
  const m = s.match(/^"?([^"<]*)"?\s*<([^>]+)>/);
  if (m) return { nombre: m[1].trim(), email: m[2].trim().toLowerCase() };
  return { nombre: s.split('@')[0], email: s.toLowerCase() };
}

// Palabras que no distinguen una comunidad (ruido común en nombres/asuntos)
const STOP = new Set([
  'cp', 'ctat', 'c', 'p', 'pl', 'sl', 'slu', 'sa', 'sccl', 'comunidad', 'comunitat',
  'propietarios', 'propietaris', 'com', 'de', 'del', 'la', 'el', 'los', 'las', 'y', 'i',
  'calle', 'carrer', 'av', 'avda', 'avenida', 'pza', 'plaza', 'placa', 'num', 'no',
  're', 'rv', 'fwd', 'fw', 'incidencia', 'incidencies', 'factura', 'presupuesto',
  'pedido', 'aviso', 'urgente', 'edificio', 'edifici', 'finca', 'sant', 'san', 'santa'
]);

function tokens(s) {
  return norm(s).replace(/[^a-z0-9ñ]+/g, ' ').split(/\s+/)
    .filter(t => t && !STOP.has(t) && (t.length >= 3 || /^\d+$/.test(t)));
}

// Identifica la comunidad por el texto (asunto + inicio del cuerpo), casándola
// con los nombres de cliente de StelOrder. Conservador: solo devuelve algo si
// hay un ganador claro (≥2 de puntuación y por delante del segundo).
async function identificarComunidad(asunto, cuerpo) {
  const tEmail = tokens(`${asunto || ''} ${String(cuerpo || '').slice(0, 200)}`);
  if (!tEmail.length) return null;
  const words = new Set(tEmail.filter(t => !/^\d+$/.test(t)));
  const nums  = new Set(tEmail.filter(t => /^\d+$/.test(t)));
  if (!words.size) return null;

  let clientMap;
  try { ({ clientMap } = await require('./stelorder').getClients()); }
  catch (e) { return null; }
  if (!clientMap) return null;

  let best = null, bestScore = 0, second = 0;
  for (const [accId, c] of Object.entries(clientMap)) {
    if (!c || !c.name) continue;
    const seen = new Set();
    let w = 0, n = 0;
    for (const t of tokens(c.name)) {
      if (seen.has(t)) continue; seen.add(t);
      if (/^\d+$/.test(t)) { if (nums.has(t)) n++; }
      else if (words.has(t)) w++;
    }
    const score = w + n * 0.4;
    if (w >= 1 && score > bestScore) { second = bestScore; bestScore = score; best = { accId, c }; }
    else if (score > second) second = score;
  }
  if (best && bestScore >= 2 && (bestScore - second) >= 0.8) {
    return { accountId: String(best.accId), communityName: best.c.name, family: best.c.family || '' };
  }
  return null;
}

// Aprende del email: resuelve la comunidad (por ref FAC/PDT o por nombre en el
// asunto) y asocia el remitente a ella. No envía nada.
async function aprenderDeEmail(de, asunto, cuerpo) {
  const { nombre, email } = parseRemitente(de);
  if (!email || !email.includes('@')) return null;
  if (/corpprojects\.es$/i.test(email)) return null;            // nosotros mismos
  if (/no-?reply|noreply|newsletter|notifica/i.test(email)) return null;

  const stel = require('./stelorder');
  let accountId = null, communityName = '', family = '', ref = null;

  // 1) Referencia a factura/pedido en el asunto
  const refMatch = String(asunto || '').match(/\b(FAC|PDT)\s?0*(\d{2,6})\b/i);
  if (refMatch) {
    const tipo = refMatch[1].toUpperCase();
    ref = `${tipo}${refMatch[2].padStart(5, '0')}`;
    try {
      if (tipo === 'FAC') {
        const invId = await stel.findInvoiceIdByNumber(ref);
        if (invId) {
          const inv = await stel.getInvoiceRaw(invId);
          accountId = inv ? String(inv['account-id'] || '') : null;
        }
      } else {
        const live = await stel.getWorkOrdersLive();
        const wo = (live || []).find(p => String(p.number).toUpperCase() === ref);
        if (wo) accountId = `name:${wo.client}`;
      }
    } catch (e) { accountId = null; }
  }

  // 2) Si no hubo ref resoluble, intentar por el nombre de la comunidad en el texto
  if (!accountId) {
    const com = await identificarComunidad(asunto, cuerpo);
    if (com) {
      accountId = com.accountId;
      communityName = com.communityName;
      family = com.family;
      ref = ref || 'asunto';
    }
  }
  if (!accountId) return null;

  // Resolver nombre/familia si vino por FAC/PDT
  if (!communityName) {
    try {
      const { clientMap } = await stel.getClients();
      if (accountId.startsWith('name:')) {
        communityName = accountId.slice(5);
        const hit = Object.values(clientMap || {}).find(c => c.name === communityName);
        family = hit ? hit.family : '';
      } else {
        const c = (clientMap || {})[accountId];
        communityName = c ? c.name : '';
        family = c ? c.family : '';
      }
    } catch (e) {}
  }

  const db = await getDB();
  await db.collection('communityManagers').updateOne(
    { accountId: String(accountId), managerEmail: email },
    {
      $inc: { hits: 1 },
      $set: { lastSeenAt: new Date(), managerName: nombre, communityName, family },
      $addToSet: { refs: ref },
      $setOnInsert: { firstSeenAt: new Date(), confirmed: false }
    },
    { upsert: true }
  );
  console.log(`[Gestores] Aprendido: ${communityName || accountId} ← ${email} (${ref})`);
  return { accountId, email, ref, communityName, family };
}

async function getManagers() {
  const db = await getDB();
  return db.collection('communityManagers')
    .find({}).sort({ lastSeenAt: -1 }).limit(300).toArray();
}

async function setConfirmed(id, confirmed) {
  const db = await getDB();
  const { ObjectId } = require('mongodb');
  await db.collection('communityManagers').updateOne(
    { _id: new ObjectId(id) }, { $set: { confirmed: !!confirmed, confirmedAt: new Date() } });
  return { confirmed: !!confirmed };
}

async function removeManager(id) {
  const db = await getDB();
  const { ObjectId } = require('mongodb');
  await db.collection('communityManagers').deleteOne({ _id: new ObjectId(id) });
  return { deleted: true };
}

module.exports = { aprenderDeEmail, identificarComunidad, getManagers, setConfirmed, removeManager };
