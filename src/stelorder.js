// src/stelorder.js — v10 fetch recientes por ID desc + estados workEstimate
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

// ─── Traer facturas: antiguas (por defecto) + recientes (por ID alto) ──────
// Estrategia: hacer DOS llamadas en paralelo
//   1. Las 500 más antiguas (el comportamiento por defecto)
//   2. Las más recientes filtrando por utc-last-modification-date o ID alto
// Luego combinar y deduplicar por ID
async function fetchAllInvoices() {
  try {
    // Llamada 1: defecto (probablemente las más antiguas)
    const [defaultBatch, receipts] = await Promise.all([
      client.get('/ordinaryInvoices?limit=500').then(r => Array.isArray(r.data) ? r.data : []),
      // Llamada 2: intentar filtrar facturas recientes por fecha de modificación
      client.get('/ordinaryInvoices?limit=500&utc-last-modification-date>=2024-01-01T00:00:00+0000')
        .then(r => Array.isArray(r.data) ? r.data : [])
        .catch(() => [])
    ]);

    // Combinar y deduplicar
    const allById = new Map();
    [...defaultBatch, ...receipts].forEach(inv => allById.set(String(inv.id), inv));
    const all = Array.from(allById.values());

    // Log rango de fechas para diagnóstico
    const dates = all.map(i => i.date || i['issue-date'] || '').filter(Boolean).sort();
    if (dates.length > 0) {
      console.log(`[StelOrder] Facturas: ${all.length} | Rango: ${dates[0].slice(0,10)} → ${dates[dates.length-1].slice(0,10)}`);
    }

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
async function getAllReceipts()     { const d = await fetchEndpoint('/ordinaryInvoiceReceipts'); console.log(`[StelOrder] Recibos: ${d.length}`); return d; }
async function getClients()        { const d = await fetchEndpoint('/clients'); console.log(`[StelOrder] Clientes: ${d.length}`); return d; }
async function getDocumentStates() { return fetchEndpoint('/documentStates'); }
async function getBankAccounts()   { return fetchEndpoint('/bankAccounts'); }

async function getWorkEstimates() {
  const d = await fetchEndpoint('/workEstimates');
  console.log(`[StelOrder] WorkEstimates: ${d.length}`);
  if (d.length > 0) {
    // Log estructura completa del primero para ver campos de estado
    const first = d[0];
    const stateFields = Object.entries(first)
      .filter(([k]) => k.includes('state') || k.includes('status') || k.includes('document'))
      .map(([k,v]) => `${k}=${JSON.stringify(v)}`);
    console.log('[StelOrder] WorkEstimate campos estado:', stateFields.join(' | '));
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
    return pending.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  } catch (err) {
    console.error('[StelOrder] Error getPendingInvoices:', err.message);
    return [];
  }
}

// ─── Presupuestos SAT ─────────────────────────────────────────────
async function getEstimatesSummary() {
  try {
    const [estimates, states, clients] = await Promise.all([
      getWorkEstimates(), getDocumentStates(), getClients()
    ]);
    const clientMap = buildClientMap(clients);
    const now = new Date();
    const avgMonthlyExpenses = 36000;

    // Log completo de estados disponibles
    console.log('[StelOrder] DocumentStates completo:', JSON.stringify(states));

    const result = { total: estimates.length, accepted:[], pending:[], sent:[], rejected:[], expired:[], all:[] };

    // Crear mapa de estados por ID para clasificar correctamente
    const stateById = {};
    states.forEach(s => {
      stateById[String(s.id)] = (s.name || s.description || s['state-name'] || '').toLowerCase();
    });

    estimates.forEach(est => {
      const stateId   = est['document-state-id'] ?? est['state-id'] ?? est.stateId ?? null;
      // Buscar nombre del estado primero en el mapa, luego en el propio objeto
      const stateFromMap = stateId ? (stateById[String(stateId)] || '') : '';
      const stateRaw  = est['document-state-name'] ?? est['state-name'] ?? est.state ?? stateFromMap ?? '';
      const stateName = String(stateRaw || stateFromMap).toLowerCase();
      const total     = parseFloat(est['total-amount'] ?? est.total ?? 0);
      const rawDate   = est.date ?? est['issue-date'] ?? est['created-at'];
      const estDate   = rawDate ? new Date(rawDate) : now;
      const daysOld   = Math.floor((now - estDate) / 86400000);

      const item = {
        id:       String(est.id),
        number:   est.number ?? `#${est.id}`,
        client:   resolveClientName(est, clientMap),
        date:     rawDate,
        dueDate:  est['due-date'] ?? est['expiry-date'],
        total, stateName, stateId: String(stateId), stateRaw: stateFromMap || stateRaw, daysOld
      };

      result.all.push(item);

      // Clasificar por estado — ampliado con los IDs más comunes de StelOrder
      const sid = Number(stateId);
      if (stateName.includes('acept') || stateName.includes('accept') ||
          stateName.includes('confirm') || stateName.includes('aprob') ||
          stateName === 'approved' || sid === 2 || sid === 3) {
        result.accepted.push(item);
      } else if (stateName.includes('rechaz') || stateName.includes('reject') ||
                 stateName.includes('cancel') || sid === 5 || sid === 6) {
        result.rejected.push(item);
      } else if (stateName.includes('enviad') || stateName.includes('sent') ||
                 stateName.includes('present') || sid === 4) {
        result.sent.push(item);
      } else if (stateName.includes('caduc') || stateName.includes('expir')) {
        result.expired.push(item);
      } else {
        result.pending.push(item);
      }
    });

    // Siempre loguear distribución real
    console.log(`[StelOrder] Presupuestos — aceptados:${result.accepted.length} pendientes:${result.pending.length} enviados:${result.sent.length} rechazados:${result.rejected.length}`);
    if (result.all.length > 0) {
      const uniqueStates = [...new Set(result.all.map(e => `id:${e.stateId}="${e.stateRaw}"`))];
      console.log('[StelOrder] Estados únicos presupuestos:', uniqueStates.join(' | '));
    }

    // Ordenar recientes primero en todos los grupos
    Object.keys(result).forEach(k => {
      if (Array.isArray(result[k])) result[k].sort((a,b) => new Date(b.date||0) - new Date(a.date||0));
    });

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
