// src/stelorder.js — v11 IDs de estados confirmados + facturas recientes por receipts
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

async function fetchEndpoint(endpoint) {
  try {
    const sep = endpoint.includes('?') ? '&' : '?';
    const res = await client.get(`${endpoint}${sep}limit=500`);
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    console.error(`[StelOrder] Error ${endpoint}:`, err.response?.status, err.message);
    return [];
  }
}

// ─── Facturas: combinar batch antiguo + batch por receipts recientes ──────────
// Los receipts SÍ tienen 'original-element-id' de facturas recientes
// que no aparecen en el batch de 500 facturas.
// Estrategia: traer IDs de facturas recientes desde los receipts y
// buscarlas individualmente si no están en el batch.
async function fetchAllInvoices() {
  try {
    // 1. Batch normal (500 más antiguas)
    const batchRes = await client.get('/ordinaryInvoices?limit=500');
    const batch    = Array.isArray(batchRes.data) ? batchRes.data : [];

    // 2. Receipts tienen las facturas más recientes referenciadas
    const receiptsRes = await client.get('/ordinaryInvoiceReceipts?limit=500');
    const receipts    = Array.isArray(receiptsRes.data) ? receiptsRes.data : [];

    // IDs que ya tenemos
    const knownIds = new Set(batch.map(i => String(i.id)));

    // IDs de facturas referenciadas en receipts que NO están en el batch
    const missingIds = [...new Set(
      receipts
        .map(r => String(r['original-element-id'] || ''))
        .filter(id => id && !knownIds.has(id))
    )];

    console.log(`[StelOrder] Batch: ${batch.length} | Receipts refs faltantes: ${missingIds.length}`);

    // 3. Traer las facturas faltantes en paralelo (máx 50 para no sobrepasar rate limit)
    const missing = [];
    const toFetch = missingIds.slice(0, 50);
    if (toFetch.length > 0) {
      const results = await Promise.allSettled(
        toFetch.map(id => client.get(`/ordinaryInvoices/${id}`).then(r => r.data))
      );
      results.forEach(r => { if (r.status === 'fulfilled' && r.value?.id) missing.push(r.value); });
      console.log(`[StelOrder] Facturas adicionales traídas: ${missing.length}`);
    }

    // Combinar todo
    const allById = new Map();
    [...batch, ...missing].forEach(inv => allById.set(String(inv.id), inv));
    const all = Array.from(allById.values());

    const dates = all.map(i => (i.date || '').slice(0,10)).filter(Boolean).sort();
    console.log(`[StelOrder] Total facturas: ${all.length} | Rango: ${dates[0]} → ${dates[dates.length-1]}`);

    return all;
  } catch (err) {
    console.error('[StelOrder] Error fetchAllInvoices:', err.message);
    return [];
  }
}

function getClientName(obj) {
  return (obj['legal-name'] || obj['fiscal-name'] || obj['commercial-name'] ||
          obj['client-name'] || obj['contact-name'] || obj.name || '').trim();
}

function extractClientId(obj) {
  const path = obj['account-path'] || obj['client-path'] || '';
  const m = path.match(/\/(?:clients|accounts)\/(\d+)/);
  return m ? m[1] : null;
}

function buildClientMap(clients) {
  const map = {};
  clients.forEach(c => { const n = getClientName(c); if (n) map[String(c.id)] = n; });
  return map;
}

function resolveClientName(item, clientMap) {
  const direct = getClientName(item);
  if (direct) return direct;
  const cid = extractClientId(item);
  return (cid && clientMap[cid]) ? clientMap[cid] : 'Sin nombre';
}

function buildPaidMap(receipts) {
  const map = {};
  receipts.forEach(r => {
    if (!r['payment-date']) return;
    const invId = String(r['original-element-id'] || '');
    if (!invId) return;
    const amount = parseFloat(r.amount || 0);
    if (amount > 0) map[invId] = (map[invId] || 0) + amount;
  });
  return map;
}

async function getInvoices()       { return fetchAllInvoices(); }
async function getClients()        { const d = await fetchEndpoint('/clients');                  console.log(`[StelOrder] Clientes: ${d.length}`);      return d; }
async function getDocumentStates() { return fetchEndpoint('/documentStates'); }
async function getBankAccounts()   { return fetchEndpoint('/bankAccounts'); }

async function getAllReceipts() {
  const d = await fetchEndpoint('/ordinaryInvoiceReceipts');
  console.log(`[StelOrder] Recibos: ${d.length}`);
  return d;
}

async function getWorkEstimates() {
  const d = await fetchEndpoint('/workEstimates');
  console.log(`[StelOrder] WorkEstimates: ${d.length}`);
  return d;
}

// ─── ESTADOS WORKESTIMATE (confirmados de los logs) ───────────────
// 1120641 = Pendiente
// 1120642 = Rechazado
// 1120656 = Aceptado
// 1120650 = Cerrado
const WORK_ESTIMATE_STATES = {
  1120641: 'pending',
  1120642: 'rejected',
  1120656: 'accepted',
  1120650: 'closed'
};

// ─── Facturas pendientes ──────────────────────────────────────────
async function getPendingInvoices() {
  try {
    const now = new Date();
    const [invoices, receipts, clients] = await Promise.all([getInvoices(), getAllReceipts(), getClients()]);
    const clientMap = buildClientMap(clients);
    const paidMap   = buildPaidMap(receipts);
    const pending   = [];

    for (const inv of invoices) {
      const invId = String(inv.id);
      const total = parseFloat(inv['total-amount'] || inv.total || 0);
      if (total <= 0) continue;
      const paid          = paidMap[invId] || 0;
      const pendingAmount = parseFloat((total - paid).toFixed(2));
      if (pendingAmount < 0.01) continue;
      const rawDate     = inv.date || inv['issue-date'];
      const issueDate   = rawDate ? new Date(rawDate) : now;
      const daysOverdue = Math.max(0, Math.floor((now - issueDate) / 86400000));
      pending.push({
        id: invId,
        number:    inv.number || inv['invoice-number'] || `#${invId}`,
        client:    resolveClientName(inv, clientMap),
        date:      rawDate,
        dueDate:   inv['due-date'] || null,
        total, paid, pending: pendingAmount,
        daysOverdue, alertLevel: getAlertLevel(daysOverdue)
      });
    }
    console.log(`[StelOrder] Pendientes: ${pending.length}/${invoices.length}`);
    return pending.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  } catch (err) {
    console.error('[StelOrder] Error getPendingInvoices:', err.message);
    return [];
  }
}

// ─── Presupuestos SAT con estados confirmados ─────────────────────
async function getEstimatesSummary() {
  try {
    const [estimates, clients] = await Promise.all([getWorkEstimates(), getClients()]);
    const clientMap = buildClientMap(clients);
    const now = new Date();
    const avgMonthlyExpenses = 36000;

    const result = { total: estimates.length, accepted:[], pending:[], closed:[], rejected:[], all:[] };

    estimates.forEach(est => {
      const stateId   = Number(est['document-state-id'] ?? est['state-id'] ?? 0);
      const stateKey  = WORK_ESTIMATE_STATES[stateId] || 'pending';
      const stateLabel = { pending:'Pendiente', accepted:'Aceptado', rejected:'Rechazado', closed:'Cerrado' }[stateKey] || 'Pendiente';
      const total     = parseFloat(est['total-amount'] ?? est.total ?? 0);
      const rawDate   = est.date ?? est['issue-date'] ?? est['created-at'];
      const estDate   = rawDate ? new Date(rawDate) : now;
      const daysOld   = Math.floor((now - estDate) / 86400000);

      const item = {
        id:        String(est.id),
        number:    est.number ?? `#${est.id}`,
        client:    resolveClientName(est, clientMap),
        date:      rawDate,
        dueDate:   est['due-date'] ?? est['expiry-date'],
        total, stateKey, stateLabel, stateId, daysOld
      };

      result.all.push(item);
      if (stateKey === 'accepted') result.accepted.push(item);
      else if (stateKey === 'rejected') result.rejected.push(item);
      else if (stateKey === 'closed') result.closed.push(item);
      else result.pending.push(item);
    });

    // Recientes primero en todos los grupos
    Object.keys(result).forEach(k => {
      if (Array.isArray(result[k])) result[k].sort((a,b) => new Date(b.date||0) - new Date(a.date||0));
    });

    console.log(`[StelOrder] Presupuestos — aceptados:${result.accepted.length} pendientes:${result.pending.length} cerrados:${result.closed.length} rechazados:${result.rejected.length}`);

    const totalAccepted = result.accepted.reduce((s,e) => s + e.total, 0);
    const totalPending  = result.pending.reduce((s,e) => s + e.total, 0);
    const totalClosed   = result.closed.reduce((s,e) => s + e.total, 0);
    const totalAll      = result.all.reduce((s,e) => s + e.total, 0);
    const monthsCovered = totalAccepted > 0 ? (totalAccepted / avgMonthlyExpenses).toFixed(1) : '0';

    return { ...result, totalAccepted, totalPending, totalClosed, totalAll, monthsCovered };
  } catch (err) {
    console.error('[StelOrder] Error getEstimatesSummary:', err.message);
    return { total:0, accepted:[], pending:[], closed:[], rejected:[], all:[],
             totalAccepted:0, totalPending:0, totalClosed:0, totalAll:0, monthsCovered:'0' };
  }
}

// ─── Resumen general ──────────────────────────────────────────────
async function getSummary() {
  try {
    const now = new Date();
    const thisMonth = now.getMonth(), thisYear = now.getFullYear();
    const [invoices, receipts, clients] = await Promise.all([getInvoices(), getAllReceipts(), getClients()]);
    const clientMap = buildClientMap(clients);
    const paidMap   = buildPaidMap(receipts);
    let totalBilled = 0, totalBilledMonth = 0, totalBilledMonthCount = 0;
    const pending = [];

    for (const inv of invoices) {
      const invId = String(inv.id);
      const total = parseFloat(inv['total-amount'] || inv.total || 0);
      if (total <= 0) continue;
      totalBilled += total;
      const rawDate   = inv.date || inv['issue-date'];
      const issueDate = rawDate ? new Date(rawDate) : now;
      if (issueDate.getMonth() === thisMonth && issueDate.getFullYear() === thisYear) {
        totalBilledMonth += total; totalBilledMonthCount++;
      }
      const paid          = paidMap[invId] || 0;
      const pendingAmount = parseFloat((total - paid).toFixed(2));
      if (pendingAmount < 0.01) continue;
      const daysOverdue = Math.max(0, Math.floor((now - issueDate) / 86400000));
      pending.push({
        id: invId, number: inv.number || `#${invId}`,
        client: resolveClientName(inv, clientMap),
        date: rawDate, dueDate: inv['due-date'] || null,
        total, paid, pending: pendingAmount,
        daysOverdue, alertLevel: getAlertLevel(daysOverdue)
      });
    }
    pending.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    return {
      totalInvoices: invoices.length, totalInvoicesMonth: totalBilledMonthCount,
      totalBilled, totalBilledMonth,
      pendingInvoices:  pending.length,
      totalPending:     pending.reduce((s,i) => s + i.pending, 0),
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

module.exports = {
  getInvoices, getAllReceipts, getPendingInvoices, getClients,
  getWorkEstimates, getEstimatesSummary, getBankAccounts, getSummary, getAlertLevel
};
