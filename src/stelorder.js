// src/stelorder.js — v9 orden desc + paginación correcta + estados workEstimate
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

// Fetch con orden descendente por fecha — para traer las más recientes
// StelOrder acepta: order-by=date&order=desc (probamos varias variantes)
async function fetchEndpoint(endpoint, extraParams = '') {
  try {
    const sep = endpoint.includes('?') ? '&' : '?';
    // Intentar con orden descendente para traer las más recientes primero
    const url = `${endpoint}${sep}limit=500${extraParams}`;
    const res = await client.get(url);
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    console.error(`[StelOrder] Error ${endpoint}:`, err.response?.status, err.message);
    return [];
  }
}

// Para facturas: intentar traer ordenadas desc y también las últimas
async function fetchInvoices() {
  // Intentar varias formas de ordenar desc para traer las más recientes
  const attempts = [
    '&order-by=date&order=desc',
    '&orderBy=date&order=desc',
    '&sort=date&dir=desc',
    '&order=desc',
    '' // sin orden como fallback
  ];

  for (const params of attempts) {
    try {
      const url = `/ordinaryInvoices?limit=500${params}`;
      const res = await client.get(url);
      if (Array.isArray(res.data) && res.data.length > 0) {
        // Comprobar si la primera factura es reciente (2025 o 2026)
        const firstDate = res.data[0]?.date || '';
        const isRecent  = firstDate.startsWith('2025') || firstDate.startsWith('2026');
        console.log(`[StelOrder] Facturas con params "${params}": ${res.data.length} — primera fecha: ${firstDate} ${isRecent ? '✅ reciente' : '⚠️ antigua'}`);
        if (isRecent) return res.data;
      }
    } catch (err) {
      // Ignorar errores de parámetros no soportados
    }
  }

  // Fallback: coger las 500 y ordenar en memoria
  const res = await client.get('/ordinaryInvoices?limit=500');
  const all = Array.isArray(res.data) ? res.data : [];
  console.log(`[StelOrder] Facturas (ordenadas en memoria): ${all.length}`);
  return all.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
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

async function getInvoices()       { return fetchInvoices(); }
async function getAllReceipts()     { const d = await fetchEndpoint('/ordinaryInvoiceReceipts'); console.log(`[StelOrder] Recibos: ${d.length}`); return d; }
async function getClients()        { const d = await fetchEndpoint('/clients'); console.log(`[StelOrder] Clientes: ${d.length}`); return d; }
async function getDocumentStates() { return fetchEndpoint('/documentStates'); }
async function getBankAccounts()   { return fetchEndpoint('/bankAccounts'); }

// workEstimates con log completo del primer elemento para ver estados
async function getWorkEstimates() {
  const d = await fetchEndpoint('/workEstimates');
  console.log(`[StelOrder] WorkEstimates: ${d.length}`);
  if (d.length > 0) {
    console.log('[StelOrder] WorkEstimate[0] COMPLETO:', JSON.stringify(d[0]));
  }
  return d;
}

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
    // Más recientes primero
    return pending.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  } catch (err) {
    console.error('[StelOrder] Error getPendingInvoices:', err.message);
    return [];
  }
}

// ─── Resumen presupuestos SAT workEstimates ───────────────────────
async function getEstimatesSummary() {
  try {
    const [estimates, states, clients] = await Promise.all([getWorkEstimates(), getDocumentStates(), getClients()]);
    const clientMap = buildClientMap(clients);
    const now = new Date();
    const avgMonthlyExpenses = 36000;

    if (states.length > 0) {
      console.log('[StelOrder] DocumentStates:', JSON.stringify(states));
    }

    const result = { total: estimates.length, accepted:[], pending:[], sent:[], rejected:[], expired:[], all:[] };

    estimates.forEach(est => {
      // Capturar TODOS los posibles campos de estado
      const stateId   = est['document-state-id'] ?? est['state-id'] ?? est.stateId ?? null;
      const stateRaw  = est['document-state-name'] ?? est['state-name'] ?? est['status-name'] ??
                        est.state ?? est.status ?? est['document-state'] ?? '';
      const stateName = String(stateRaw).toLowerCase();
      const total     = parseFloat(est['total-amount'] ?? est.total ?? 0);
      const rawDate   = est.date ?? est['issue-date'] ?? est['created-at'];
      const estDate   = rawDate ? new Date(rawDate) : now;
      const daysOld   = Math.floor((now - estDate) / 86400000);

      const item = {
        id:       String(est.id),
        number:   est.number ?? est['estimate-number'] ?? `#${est.id}`,
        client:   resolveClientName(est, clientMap),
        date:     rawDate,
        dueDate:  est['due-date'] ?? est['expiry-date'],
        total, stateName, stateId, stateRaw: String(stateRaw), daysOld
      };

      result.all.push(item);

      if      (stateName.includes('acept') || stateName.includes('accept') ||
               stateName.includes('confirm') || stateName === 'approved' || stateId === 2) result.accepted.push(item);
      else if (stateName.includes('rechaz') || stateName.includes('reject') ||
               stateName.includes('cancel') || stateName === 'declined')                    result.rejected.push(item);
      else if (stateName.includes('enviad') || stateName.includes('sent') ||
               stateName.includes('present'))                                               result.sent.push(item);
      else if (stateName.includes('caduc') || stateName.includes('expir'))                  result.expired.push(item);
      else                                                                                  result.pending.push(item);
    });

    // Ordenar cada grupo: más recientes primero
    Object.keys(result).forEach(k => {
      if (Array.isArray(result[k])) {
        result[k].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
      }
    });

    if (result.pending.length > 0 && result.accepted.length === 0) {
      const uniq = [...new Set(result.all.map(e => `"${e.stateRaw}"(id:${e.stateId})`))];
      console.log('[StelOrder] ⚠️ Estados únicos en presupuestos:', uniq.join(' | '));
    }

    const totalAccepted = result.accepted.reduce((s,e) => s + e.total, 0);
    const totalPending  = result.pending.reduce((s,e) => s + e.total, 0);
    const totalSent     = result.sent.reduce((s,e) => s + e.total, 0);
    const totalAll      = result.all.reduce((s,e) => s + e.total, 0);
    const monthsCovered = totalAccepted > 0 ? (totalAccepted / avgMonthlyExpenses).toFixed(1) : '0';

    return { ...result, totalAccepted, totalPending, totalSent, totalAll, monthsCovered };
  } catch (err) {
    console.error('[StelOrder] Error getEstimatesSummary:', err.message);
    return { total:0, accepted:[], pending:[], sent:[], rejected:[], expired:[], all:[],
             totalAccepted:0, totalPending:0, totalSent:0, totalAll:0, monthsCovered:'0' };
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
        totalBilledMonth += total;
        totalBilledMonthCount++;
      }
      const paid          = paidMap[invId] || 0;
      const pendingAmount = parseFloat((total - paid).toFixed(2));
      if (pendingAmount < 0.01) continue;
      const daysOverdue = Math.max(0, Math.floor((now - issueDate) / 86400000));
      pending.push({
        id: invId,
        number: inv.number || inv['invoice-number'] || `#${invId}`,
        client: resolveClientName(inv, clientMap),
        date: rawDate, dueDate: inv['due-date'] || null,
        total, paid, pending: pendingAmount,
        daysOverdue, alertLevel: getAlertLevel(daysOverdue)
      });
    }
    pending.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    return {
      totalInvoices:       invoices.length,
      totalInvoicesMonth:  totalBilledMonthCount,
      totalBilled,         totalBilledMonth,
      pendingInvoices:     pending.length,
      totalPending:        pending.reduce((s,i) => s + i.pending, 0),
      overdueCount:        pending.filter(i => i.daysOverdue >= 30 && i.daysOverdue < 60).length,
      criticalCount:       pending.filter(i => i.daysOverdue >= 60).length,
      warningCount:        pending.filter(i => i.daysOverdue >= 15 && i.daysOverdue < 30).length,
      pendingList:         pending.slice(0, 30),
      lastUpdated:         now.toISOString()
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
