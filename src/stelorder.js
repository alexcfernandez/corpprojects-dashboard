// src/stelorder.js — v7 sin paginación (StelOrder no soporta offset), legal-name confirmado
const axios = require('axios');

const BASE_URL = 'https://app.stelorder.com/app';
const API_KEY  = process.env.STELORDER_API_KEY;

const client = axios.create({
  baseURL: BASE_URL,
  headers: { 'APIKEY': API_KEY, 'Accept': 'application/json' },
  timeout: 20000
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

// StelOrder: límite máximo 500, sin paginación por offset
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

// Nombre del cliente — campo legal-name confirmado como el correcto
function getClientName(obj) {
  return (
    obj['legal-name']      ||
    obj['fiscal-name']     ||
    obj['commercial-name'] ||
    obj['client-name']     ||
    obj['contact-name']    ||
    obj['company-name']    ||
    obj.name               ||
    ''
  ).trim();
}

// Extraer client-id del account-path
function extractClientId(obj) {
  const path = obj['account-path'] || obj['client-path'] || '';
  const m = path.match(/\/clients\/(\d+)/);
  return m ? m[1] : null;
}

async function getInvoices()        { const d = await fetchEndpoint('/ordinaryInvoices');       console.log(`[StelOrder] Facturas: ${d.length}`); return d; }
async function getAllReceipts()      { const d = await fetchEndpoint('/ordinaryInvoiceReceipts');console.log(`[StelOrder] Recibos: ${d.length}`);  return d; }
async function getClients()         { const d = await fetchEndpoint('/clients');                 console.log(`[StelOrder] Clientes: ${d.length}`); return d; }
async function getSalesEstimates()  { const d = await fetchEndpoint('/salesEstimates');          console.log(`[StelOrder] Presupuestos: ${d.length}`); return d; }
async function getDocumentStates()  { return fetchEndpoint('/documentStates'); }

// Construir mapa clientId → nombre
function buildClientMap(clients) {
  const map = {};
  clients.forEach(c => {
    const name = getClientName(c);
    if (name) map[String(c.id)] = name;
  });
  return map;
}

// Resolver nombre a partir de factura/presupuesto + mapa
function resolveClientName(item, clientMap) {
  // 1. Campo directo en el documento
  const direct = getClientName(item);
  if (direct) return direct;
  // 2. Cruzar con mapa por account-path
  const cid = extractClientId(item);
  if (cid && clientMap[cid]) return clientMap[cid];
  return 'Sin nombre';
}

// Construir mapa de pagos: invoiceId → total cobrado
function buildPaidMap(receipts) {
  const map = {};
  receipts.forEach(r => {
    if (!r['payment-date']) return; // sin fecha = no cobrado
    const invId = String(r['original-element-id'] || '');
    if (!invId) return;
    const amount = parseFloat(r.amount || 0);
    if (amount > 0) map[invId] = (map[invId] || 0) + amount;
  });
  return map;
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
    return pending.sort((a, b) => b.daysOverdue - a.daysOverdue);
  } catch (err) {
    console.error('[StelOrder] Error getPendingInvoices:', err.message);
    return [];
  }
}

// ─── Resumen de presupuestos ──────────────────────────────────────
async function getEstimatesSummary() {
  try {
    const [estimates, states, clients] = await Promise.all([getSalesEstimates(), getDocumentStates(), getClients()]);
    const clientMap = buildClientMap(clients);
    const now = new Date();
    const avgMonthlyExpenses = 36000;

    if (states.length > 0) {
      console.log('[StelOrder] Estados doc:', states.map(s => `${s.id}:${s.name||s.description||JSON.stringify(s)}`).slice(0,10).join(' | '));
    }

    const result = { total: estimates.length, accepted:[], pending:[], sent:[], rejected:[], expired:[], all:[] };

    estimates.forEach(est => {
      const stateName = (est['document-state-name'] || est['state-name'] || est.state || '').toLowerCase();
      const total     = parseFloat(est['total-amount'] || est.total || 0);
      const rawDate   = est.date || est['issue-date'] || est['created-at'];
      const estDate   = rawDate ? new Date(rawDate) : now;
      const daysOld   = Math.floor((now - estDate) / 86400000);

      const item = {
        id:        String(est.id),
        number:    est.number || est['estimate-number'] || `#${est.id}`,
        client:    resolveClientName(est, clientMap),
        date:      rawDate,
        dueDate:   est['due-date'] || est['expiry-date'],
        total, stateName, daysOld
      };

      result.all.push(item);

      if      (stateName.includes('acept') || stateName.includes('accept') || stateName === 'approved') result.accepted.push(item);
      else if (stateName.includes('rechaz') || stateName.includes('reject') || stateName === 'declined') result.rejected.push(item);
      else if (stateName.includes('enviad') || stateName.includes('sent'))  result.sent.push(item);
      else if (stateName.includes('caduc') || stateName.includes('expir'))  result.expired.push(item);
      else result.pending.push(item);
    });

    const totalAccepted = result.accepted.reduce((s,e) => s + e.total, 0);
    const totalPending  = result.pending.reduce((s,e) => s + e.total, 0);
    const totalSent     = result.sent.reduce((s,e) => s + e.total, 0);
    const totalAll      = result.all.reduce((s,e) => s + e.total, 0);
    const monthsCovered = totalAccepted > 0 ? (totalAccepted / avgMonthlyExpenses).toFixed(1) : '0';

    return { ...result, totalAccepted, totalPending, totalSent, totalAll, monthsCovered,
             statesDebug: states.slice(0,10).map(s => ({id:s.id, name:s.name||s.description})) };
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

    pending.sort((a, b) => b.daysOverdue - a.daysOverdue);

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

module.exports = { getInvoices, getAllReceipts, getPendingInvoices, getClients,
                   getSalesEstimates, getEstimatesSummary, getSummary, getAlertLevel };
