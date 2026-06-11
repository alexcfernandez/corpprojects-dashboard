// src/gestores.js — Mapa comunidad → gestor, aprendido pasivamente.
// Cuando alguien responde a un aviso (RE: Factura FAC00759...), el remitente
// queda asociado a la comunidad de esa factura/pedido. No envía nada: solo
// observa y anota. Colección: communityManagers
//   { accountId, communityName, family, managerEmail, managerName,
//     hits, refs[], firstSeenAt, lastSeenAt, confirmed }

async function getDB() {
  return require('./db').getDB();
}

function parseRemitente(de) {
  const s = String(de || '').trim();
  const m = s.match(/^"?([^"<]*)"?\s*<([^>]+)>/);
  if (m) return { nombre: m[1].trim(), email: m[2].trim().toLowerCase() };
  return { nombre: s.split('@')[0], email: s.toLowerCase() };
}

// Aprende del email si: el remitente no es nuestro ni un noreply, y el asunto
// referencia una factura (FAC...) o pedido (PDT...) que podamos resolver a comunidad.
async function aprenderDeEmail(de, asunto) {
  const { nombre, email } = parseRemitente(de);
  if (!email || !email.includes('@')) return null;
  if (/corpprojects\.es$/i.test(email)) return null;            // nosotros mismos
  if (/no-?reply|noreply|newsletter|notifica/i.test(email)) return null;

  const refMatch = String(asunto || '').match(/\b(FAC|PDT)\s?0*(\d{2,6})\b/i);
  if (!refMatch) return null;
  const tipo = refMatch[1].toUpperCase();
  const ref  = `${tipo}${refMatch[2].padStart(5, '0')}`;

  // Resolver la referencia a comunidad (account-id) con lo ya cacheado
  const stel = require('./stelorder');
  let accountId = null;
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
      // getWorkOrdersLive no expone account-id; usamos el nombre del cliente para el mapa
      if (wo) accountId = `name:${wo.client}`;
    }
  } catch (e) { return null; }
  if (!accountId) return null;

  // Nombre y familia de la comunidad
  let communityName = '', family = '';
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
  return { accountId, email, ref };
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

module.exports = { aprenderDeEmail, getManagers, setConfirmed, removeManager };
