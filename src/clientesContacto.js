// src/clientesContacto.js — Móvil, email y persona de contacto de cada cliente, apuntados en el dashboard (9/10/2026).
//
// Muchos clientes (Construccions i Obres Pedrosa, comunidades…) no tienen móvil ni email en StelOrder, y así el
// sistema no les puede mandar el recordatorio de cobro. Aquí la oficina los va metiendo y mandan sobre lo de
// StelOrder (que no se toca: cada escritura gasta cupo de la API). Se guardan por la cuenta de StelOrder del cliente
// y, si no la hay, por el nombre.
'use strict';
async function getDB() { return require('./db').getDB(); }
const COL = 'clientesContacto';
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const clave = ({ accountId, cliente }) => (accountId ? 'acc:' + String(accountId) : cliente ? 'n:' + norm(cliente) : null);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function mapa() {
  const db = await getDB();
  const l = await db.collection(COL).find({}).toArray();
  return Object.fromEntries(l.map(d => [String(d._id), d]));
}
// Lo apuntado para ese cliente (por cuenta y, si no, por nombre).
const de = (m, { accountId, cliente }) => (accountId && m['acc:' + accountId]) || (cliente && m['n:' + norm(cliente)]) || null;

async function guardar({ accountId, cliente, telefono, email, persona, nota } = {}, por) {
  const id = clave({ accountId, cliente });
  if (!id) throw new Error('Falta el cliente');
  const tel = String(telefono || '').trim().slice(0, 30);
  const mail = String(email || '').trim().toLowerCase().slice(0, 120);
  if (mail && !EMAIL.test(mail)) throw new Error('Ese email no parece válido');
  if (tel && String(tel).replace(/\D/g, '').length < 9) throw new Error('Ese teléfono no parece válido');
  if (!tel && !mail && !String(persona || '').trim()) throw new Error('Pon al menos el móvil o el email');
  const db = await getDB();
  const set = { accountId: accountId ? String(accountId) : null, cliente: String(cliente || '').slice(0, 160), telefono: tel || null, email: mail || null,
    persona: String(persona || '').trim().slice(0, 80) || null, nota: String(nota || '').trim().slice(0, 200) || null, por: por || '', at: new Date() };
  await db.collection(COL).updateOne({ _id: id }, { $set: set }, { upsert: true });
  return { ok: true, ...set };
}

// Clientes con facturas pendientes y cómo se les puede escribir (lo apuntado aquí manda sobre StelOrder).
async function conPendientes() {
  const S = require('./stelorder');
  const movil = require('./recordatoriosCobro')._movil;
  const [pend, cl, m] = await Promise.all([S.getPendingInvoices(), S.getClients().catch(() => ({ clientMap: {} })), mapa()]);
  const por = {};
  for (const inv of pend) {
    if (inv.pending < 1) continue;
    const k = inv.accountId ? 'acc:' + inv.accountId : 'n:' + norm(inv.client);
    const c = (cl.clientMap || {})[String(inv.accountId)] || {};
    const ov = de(m, { accountId: inv.accountId, cliente: inv.client });
    const x = por[k] = por[k] || { accountId: inv.accountId || null, cliente: inv.client, pendiente: 0, facturas: 0, masAntigua: 0,
      telefono: (ov && ov.telefono) || c.phone || null, email: (ov && ov.email) || inv.clientEmail || c.email || null, persona: (ov && ov.persona) || null,
      telStel: c.phone || null, emailStel: inv.clientEmail || c.email || null, apuntado: !!ov };
    x.pendiente = Math.round((x.pendiente + inv.pending) * 100) / 100; x.facturas++;
    x.masAntigua = Math.max(x.masAntigua, Number(inv.daysOverdue) || 0);
  }
  const l = Object.values(por).map(x => ({ ...x, whatsapp: movil(x.telefono) }));
  l.forEach(x => { x.falta = !x.whatsapp && !x.email ? 'todo' : !x.whatsapp ? 'movil' : !x.email ? 'email' : null; });
  const peso = { todo: 0, movil: 1, email: 2 };
  l.sort((a, b) => (peso[a.falta] ?? 3) - (peso[b.falta] ?? 3) || b.pendiente - a.pendiente);
  return { clientes: l, sinNada: l.filter(x => x.falta === 'todo').length, sinMovil: l.filter(x => x.falta === 'movil').length };
}

module.exports = { mapa, de, guardar, conPendientes };
