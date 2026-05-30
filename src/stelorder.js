// src/stelorder.js — v14 con familias de clientes + gastos banco estructurados
const axios = require('axios');

const BASE_URL = 'https://app.stelorder.com/app';
const API_KEY  = process.env.STELORDER_API_KEY;

const client = axios.create({
  baseURL: BASE_URL,
  headers: { 'APIKEY': API_KEY, 'Accept': 'application/json' },
  timeout: 25000
});

function getAlertLevel(days) {
  const W = parseInt(process.env.ALERT_WARNING_DAYS  || 15);
  const S = parseInt(process.env.ALERT_SECOND_DAYS   || 30);
  const U = parseInt(process.env.ALERT_URGENT_DAYS   || 45);
  const C = parseInt(process.env.ALERT_CRITICAL_DAYS || 60);
  if (days >= C) return 'critical';
  if (days >= U) return 'urgent';
  if (days >= S) return 'warning2';
  if (days >= W) return 'warning1';
  return 'ok';
}

async function fetchAllPages(endpoint, extraParams = '') {
  const all = [];
  let start = 0;
  const limit = 500;
  while (true) {
    try {
      const sep = endpoint.includes('?') ? '&' : '?';
      const url = `${endpoint}${sep}limit=${limit}&start=${start}${extraParams}`;
      const res = await client.get(url);
      const page = Array.isArray(res.data) ? res.data : [];
      all.push(...page);
      if (page.length < limit) break;
      start += limit;
      await new Promise(r => setTimeout(r, 1100));
    } catch (err) {
      console.error(`[StelOrder] Error ${endpoint} start=${start}:`, err.response?.status, err.message);
      break;
    }
  }
  return all;
}

async function fetchEndpoint(endpoint) { return fetchAllPages(endpoint); }

function getClientName(obj) {
  return (obj['legal-name'] || obj['fiscal-name'] || obj['commercial-name'] ||
          obj['client-name'] || obj['contact-name'] || obj.name || '').trim();
}

function extractClientId(obj) {
  const path = obj['account-path'] || obj['client-path'] || '';
  const m = path.match(/\/(?:clients|accounts)\/(\d+)/);
  return m ? m[1] : null;
}

function buildClientMap(clients, familyMap) {
  const map = {};
  clients.forEach(c => {
    const name   = getClientName(c);
    const catId  = c['account-category-id'];
    const family = catId ? (familyMap[String(catId)] || 'Sin familia') : 'Sin familia';
    map[String(c.id)] = { name: name || 'Sin nombre', family, email: c.email || '', phone: c.phone || '' };
  });
  return map;
}

function resolveClient(item, clientMap) {
  const accId = String(item['account-id'] || '');
  if (accId && clientMap[accId]) return clientMap[accId];
  const cid = extractClientId(item);
  if (cid && clientMap[cid]) return clientMap[cid];
  const name = getClientName(item);
  return { name: name || 'Sin nombre', family: 'Sin familia', email: '', phone: '' };
}

// ─── Familias de clientes (accountCategories) ─────────────────────
async function getAccountCategories() {
  try {
    const res = await client.get('/accountCategories?limit=500');
    const cats = Array.isArray(res.data) ? res.data : [];
    console.log(`[StelOrder] Familias/Categorías: ${cats.length}`);
    if (cats.length > 0) console.log('[StelOrder] Familias:', cats.map(c => `${c.id}:${c.name}`).join(' | '));
    const map = {};
    cats.forEach(c => { map[String(c.id)] = c.name || `Cat-${c.id}`; });
    return { list: cats, map };
  } catch (err) {
    console.error('[StelOrder] Error accountCategories:', err.message);
    return { list: [], map: {} };
  }
}

async function getClients() {
  const { list: cats, map: familyMap } = await getAccountCategories();
  const d = await fetchAllPages('/clients');
  console.log(`[StelOrder] Clientes: ${d.length}`);
  return { clients: d, clientMap: buildClientMap(d, familyMap), families: cats, familyMap };
}

async function getWorkEstimates()  { const d = await fetchAllPages('/workEstimates');            console.log(`[StelOrder] WorkEstimates: ${d.length}`); return d; }
async function getBankAccounts()   { return fetchEndpoint('/bankAccounts'); }
async function getDocumentStates() { return fetchEndpoint('/documentStates'); }

async function getAllReceipts() {
  console.log('[StelOrder] Cargando recibos con paginación...');
  const all = await fetchAllPages('/ordinaryInvoiceReceipts', '&sort=original-element-id:desc');
  console.log(`[StelOrder] Total recibos: ${all.length}`);
  return all;
}

// Construir facturas desde recibos agrupando por original-element-id
function buildInvoicesFromReceipts(receipts, clientMap) {
  const invoiceMap = new Map();
  receipts.forEach(r => {
    const invId = String(r['original-element-id'] || '');
    if (!invId || invId === '0') return;
    const amount = parseFloat(r.amount || 0);
    const isPaid = r.paid === true || r['payment-date'] != null;
    if (!invoiceMap.has(invId)) {
      const accId = String(r['account-id'] || '');
      const clientInfo = (accId && clientMap[accId]) ? clientMap[accId] : { name: 'Sin nombre', family: 'Sin familia' };
      invoiceMap.set(invId, {
        id: invId,
        number:      r['full-reference'] || `FAC #${invId}`,
        client:      clientInfo.name,
        family:      clientInfo.family,
        date:        r['payment-term-date'] || r['utc-last-modification-date'],
        totalAmount: 0,
        paidAmount:  0
      });
    }
    const inv = invoiceMap.get(invId);
    inv.totalAmount += amount;
    if (isPaid) inv.paidAmount += amount;
    const rDate = r['payment-term-date'];
    if (rDate && (!inv.date || rDate < inv.date)) inv.date = rDate;
  });
  return Array.from(invoiceMap.values());
}

// ─── Facturas pendientes con familia ─────────────────────────────
async function getPendingInvoices() {
  try {
    const now = new Date();
    const [receipts, { clientMap }] = await Promise.all([getAllReceipts(), getClients()]);
    const allInvoices = buildInvoicesFromReceipts(receipts, clientMap);
    const pending = [];

    for (const inv of allInvoices) {
      const pendingAmount = parseFloat((inv.totalAmount - inv.paidAmount).toFixed(2));
      if (pendingAmount < 0.01) continue;
      const issueDate   = inv.date ? new Date(inv.date) : now;
      const daysOverdue = Math.max(0, Math.floor((now - issueDate) / 86400000));
      pending.push({
        id: inv.id, number: inv.number, client: inv.client,
        family: inv.family, date: inv.date,
        total: inv.totalAmount, paid: inv.paidAmount, pending: pendingAmount,
        daysOverdue, alertLevel: getAlertLevel(daysOverdue)
      });
    }
    console.log(`[StelOrder] Pendientes: ${pending.length}/${allInvoices.length}`);
    return pending.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  } catch (err) {
    console.error('[StelOrder] Error getPendingInvoices:', err.message);
    return [];
  }
}

// ─── Estados WORKESTIMATE confirmados ─────────────────────────────
const WORK_ESTIMATE_STATES = {
  1120641: 'pending',
  1120642: 'rejected',
  1120656: 'accepted',
  1120650: 'closed'
};

// ─── Presupuestos SAT con familia ────────────────────────────────
async function getEstimatesSummary() {
  try {
    const [estimates, { clientMap, families }] = await Promise.all([getWorkEstimates(), getClients()]);
    const now = new Date();
    const avgMonthlyExpenses = 36000;
    const result = { total: estimates.length, accepted:[], pending:[], closed:[], rejected:[], all:[], families };

    estimates.forEach(est => {
      const stateId    = Number(est['document-state-id'] ?? 0);
      const stateKey   = WORK_ESTIMATE_STATES[stateId] || 'pending';
      const stateLabel = { pending:'Pendiente', accepted:'Aceptado', rejected:'Rechazado', closed:'Cerrado' }[stateKey];
      const total      = parseFloat(est['total-amount'] ?? est.total ?? 0);
      const rawDate    = est.date ?? est['issue-date'] ?? est['created-at'];
      const estDate    = rawDate ? new Date(rawDate) : now;
      const daysOld    = Math.floor((now - estDate) / 86400000);
      const clientInfo = resolveClient(est, clientMap);

      const item = {
        id: String(est.id), number: est.number ?? `#${est.id}`,
        client: clientInfo.name, family: clientInfo.family,
        date: rawDate, dueDate: est['due-date'] ?? est['expiry-date'],
        total, stateKey, stateLabel, stateId, daysOld
      };
      result.all.push(item);
      if      (stateKey === 'accepted') result.accepted.push(item);
      else if (stateKey === 'rejected') result.rejected.push(item);
      else if (stateKey === 'closed')   result.closed.push(item);
      else                              result.pending.push(item);
    });

    Object.keys(result).forEach(k => {
      if (Array.isArray(result[k])) result[k].sort((a,b) => new Date(b.date||0) - new Date(a.date||0));
    });
    console.log(`[StelOrder] Presupuestos — aceptados:${result.accepted.length} pendientes:${result.pending.length} cerrados:${result.closed.length} rechazados:${result.rejected.length}`);

    const totalAccepted = result.accepted.reduce((s,e) => s+e.total, 0);
    const totalPending  = result.pending.reduce((s,e)  => s+e.total, 0);
    const totalClosed   = result.closed.reduce((s,e)   => s+e.total, 0);
    const totalAll      = result.all.reduce((s,e)      => s+e.total, 0);
    const monthsCovered = totalAccepted > 0 ? (totalAccepted/avgMonthlyExpenses).toFixed(1) : '0';
    return { ...result, totalAccepted, totalPending, totalClosed, totalAll, monthsCovered };
  } catch (err) {
    console.error('[StelOrder] Error getEstimatesSummary:', err.message);
    return { total:0, accepted:[], pending:[], closed:[], rejected:[], all:[], families:[],
             totalAccepted:0, totalPending:0, totalClosed:0, totalAll:0, monthsCovered:'0' };
  }
}

// ─── Resumen general ──────────────────────────────────────────────
async function getSummary() {
  try {
    const now = new Date();
    const thisMonth = now.getMonth(), thisYear = now.getFullYear();
    const [receipts, { clientMap }] = await Promise.all([getAllReceipts(), getClients()]);
    const allInvoices = buildInvoicesFromReceipts(receipts, clientMap);

    let totalBilled = 0, totalBilledMonth = 0, totalBilledMonthCount = 0;
    const pending = [];

    for (const inv of allInvoices) {
      const total = inv.totalAmount;
      if (total <= 0) continue;
      totalBilled += total;
      const issueDate = inv.date ? new Date(inv.date) : now;
      if (issueDate.getMonth() === thisMonth && issueDate.getFullYear() === thisYear) {
        totalBilledMonth += total; totalBilledMonthCount++;
      }
      const pendingAmount = parseFloat((total - inv.paidAmount).toFixed(2));
      if (pendingAmount < 0.01) continue;
      const daysOverdue = Math.max(0, Math.floor((now - issueDate) / 86400000));
      pending.push({
        id: inv.id, number: inv.number, client: inv.client,
        family: inv.family, date: inv.date,
        total, paid: inv.paidAmount, pending: pendingAmount,
        daysOverdue, alertLevel: getAlertLevel(daysOverdue)
      });
    }
    pending.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    return {
      totalInvoices: allInvoices.length, totalInvoicesMonth: totalBilledMonthCount,
      totalBilled, totalBilledMonth,
      pendingInvoices:  pending.length,
      totalPending:     pending.reduce((s,i) => s+i.pending, 0),
      overdueCount:     pending.filter(i => i.daysOverdue >= 30 && i.daysOverdue < 60).length,
      criticalCount:    pending.filter(i => i.daysOverdue >= 60).length,
      warningCount:     pending.filter(i => i.daysOverdue >= 15 && i.daysOverdue < 30).length,
      pendingList:      pending.slice(0, 30),
      lastUpdated:      now.toISOString()
    };
  } catch (err) {
    console.error('[StelOrder] Error getSummary:', err.message);
    return { totalInvoices:0, totalInvoicesMonth:0, totalBilled:0, totalBilledMonth:0,
             pendingInvoices:0, totalPending:0, overdueCount:0, criticalCount:0,
             warningCount:0, pendingList:[], lastUpdated: new Date().toISOString() };
  }
}

// Ruta de familias para el frontend
async function getFamiliesSummary() {
  try {
    const [receipts, { clientMap, families, familyMap }] = await Promise.all([getAllReceipts(), getClients()]);
    const allInvoices = buildInvoicesFromReceipts(receipts, clientMap);
    const now = new Date();

    // Agrupar por familia
    const byFamily = {};
    families.forEach(f => {
      byFamily[f.name] = { name: f.name, id: f.id, totalBilled: 0, totalPending: 0, invoiceCount: 0, pendingCount: 0 };
    });
    byFamily['Sin familia'] = { name: 'Sin familia', id: null, totalBilled: 0, totalPending: 0, invoiceCount: 0, pendingCount: 0 };

    allInvoices.forEach(inv => {
      const fam = inv.family || 'Sin familia';
      if (!byFamily[fam]) byFamily[fam] = { name: fam, totalBilled: 0, totalPending: 0, invoiceCount: 0, pendingCount: 0 };
      byFamily[fam].totalBilled   += inv.totalAmount;
      byFamily[fam].invoiceCount  += 1;
      const pend = inv.totalAmount - inv.paidAmount;
      if (pend > 0.01) { byFamily[fam].totalPending += pend; byFamily[fam].pendingCount += 1; }
    });

    return Object.values(byFamily).filter(f => f.invoiceCount > 0).sort((a,b) => b.totalBilled - a.totalBilled);
  } catch (err) {
    console.error('[StelOrder] Error getFamiliesSummary:', err.message);
    return [];
  }
}

async function getInvoices() {
  const [receipts, { clientMap }] = await Promise.all([getAllReceipts(), getClients()]);
  return buildInvoicesFromReceipts(receipts, clientMap);
}

module.exports = {
  getInvoices, getAllReceipts, getPendingInvoices, getClients,
  getWorkEstimates, getEstimatesSummary, getBankAccounts, getSummary,
  getAlertLevel, getFamiliesSummary, getAccountCategories
};
