// src/stelorder.js — v13 DEFINITIVO usando ordinaryInvoiceReceipts correctamente
// Los receipts tienen: full-reference (nº factura), original-element-id (ID factura),
// amount, paid, payment-date, account-path (cliente), payment-term-date
// Soportan: paginación (start+limit), sort, filtros (paid=false, etc.)
// Con esto tenemos TODAS las facturas, no solo las 500 más antiguas.

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

// Paginación real con start+limit (confirmado en la documentación)
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
      if (page.length < limit) break; // última página
      start += limit;
      // Pausa pequeña para respetar rate limit (60/min)
      await new Promise(r => setTimeout(r, 1100));
    } catch (err) {
      console.error(`[StelOrder] Error ${endpoint} start=${start}:`, err.response?.status, err.message);
      break;
    }
  }
  return all;
}

async function fetchEndpoint(endpoint) {
  return fetchAllPages(endpoint);
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
  // account-id es directo en los receipts
  const accId = String(item['account-id'] || '');
  if (accId && clientMap[accId]) return clientMap[accId];
  // fallback por account-path
  const cid = extractClientId(item);
  if (cid && clientMap[cid]) return clientMap[cid];
  return 'Sin nombre';
}

async function getClients() {
  const d = await fetchAllPages('/clients');
  console.log(`[StelOrder] Clientes: ${d.length}`);
  return d;
}

async function getWorkEstimates() {
  const d = await fetchAllPages('/workEstimates');
  console.log(`[StelOrder] WorkEstimates: ${d.length}`);
  return d;
}

async function getBankAccounts() { return fetchEndpoint('/bankAccounts'); }

// ─── NÚCLEO: traer todos los recibos con paginación real ──────────
// Un "recibo" en StelOrder = una línea de pago de una factura
// Si una factura tiene importe X y está sin pagar, tiene un recibo con paid=false
// Si está pagada parcialmente, tiene recibos paid=true (cobrado) y paid=false (resto)
async function fetchAllReceiptsPages() {
  console.log('[StelOrder] Cargando todos los recibos con paginación...');
  const all = await fetchAllPages('/ordinaryInvoiceReceipts', '&sort=original-element-id:desc');
  console.log(`[StelOrder] Total recibos: ${all.length}`);
  if (all.length > 0) {
    // Log rango de fechas de vencimiento para verificar que llegan facturas recientes
    const refs = all.map(r => r['full-reference']).filter(Boolean).slice(0, 3);
    console.log(`[StelOrder] Primeros refs: ${refs.join(', ')}`);
  }
  return all;
}

// ─── Construir facturas desde recibos ────────────────────────────
// Cada factura puede tener varios recibos (pagos parciales).
// Agrupamos por original-element-id para obtener el total y lo cobrado.
function buildInvoicesFromReceipts(receipts, clientMap) {
  const invoiceMap = new Map();

  receipts.forEach(r => {
    const invId = String(r['original-element-id'] || '');
    if (!invId || invId === '0') return;

    const amount = parseFloat(r.amount || 0);
    const isPaid = r.paid === true || r['payment-date'] != null;

    if (!invoiceMap.has(invId)) {
      // Resolver nombre cliente: account-id es el campo directo en receipts
      const accId = String(r['account-id'] || '');
      const clientName = (accId && clientMap[accId]) ? clientMap[accId] : resolveClientName(r, clientMap);

      invoiceMap.set(invId, {
        id:          invId,
        number:      r['full-reference'] || `FAC #${invId}`,
        client:      clientName,
        date:        r['payment-term-date'] || r['utc-last-modification-date'],
        totalAmount: 0,
        paidAmount:  0,
        receipts:    []
      });
    }

    const inv = invoiceMap.get(invId);
    inv.totalAmount  += amount;
    if (isPaid) inv.paidAmount += amount;
    inv.receipts.push(r);

    // La fecha más antigua de vencimiento = fecha de emisión aproximada
    const rDate = r['payment-term-date'];
    if (rDate && (!inv.date || rDate < inv.date)) inv.date = rDate;
  });

  return Array.from(invoiceMap.values());
}

// ─── Facturas pendientes de cobro ─────────────────────────────────
async function getPendingInvoices() {
  try {
    const now = new Date();
    const [receipts, clients] = await Promise.all([
      fetchAllReceiptsPages(),
      getClients()
    ]);
    const clientMap = buildClientMap(clients);
    const allInvoices = buildInvoicesFromReceipts(receipts, clientMap);

    console.log(`[StelOrder] Facturas únicas desde recibos: ${allInvoices.length}`);

    const pending = [];
    for (const inv of allInvoices) {
      const pendingAmount = parseFloat((inv.totalAmount - inv.paidAmount).toFixed(2));
      if (pendingAmount < 0.01) continue;

      const rawDate     = inv.date;
      const issueDate   = rawDate ? new Date(rawDate) : now;
      const daysOverdue = Math.max(0, Math.floor((now - issueDate) / 86400000));

      pending.push({
        id:          inv.id,
        number:      inv.number,
        client:      inv.client,
        date:        rawDate,
        total:       inv.totalAmount,
        paid:        inv.paidAmount,
        pending:     pendingAmount,
        daysOverdue, alertLevel: getAlertLevel(daysOverdue)
      });
    }

    console.log(`[StelOrder] Facturas pendientes: ${pending.length}/${allInvoices.length}`);
    // Más recientes primero
    return pending.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  } catch (err) {
    console.error('[StelOrder] Error getPendingInvoices:', err.message);
    return [];
  }
}

// ─── ESTADOS WORKESTIMATE confirmados de los logs ─────────────────
const WORK_ESTIMATE_STATES = {
  1120641: 'pending',
  1120642: 'rejected',
  1120656: 'accepted',
  1120650: 'closed'
};

// ─── Presupuestos SAT ─────────────────────────────────────────────
async function getEstimatesSummary() {
  try {
    const [estimates, clients] = await Promise.all([getWorkEstimates(), getClients()]);
    const clientMap = buildClientMap(clients);
    const now = new Date();
    const avgMonthlyExpenses = 36000;

    const result = { total: estimates.length, accepted:[], pending:[], closed:[], rejected:[], all:[] };

    estimates.forEach(est => {
      const stateId    = Number(est['document-state-id'] ?? 0);
      const stateKey   = WORK_ESTIMATE_STATES[stateId] || 'pending';
      const stateLabel = { pending:'Pendiente', accepted:'Aceptado', rejected:'Rechazado', closed:'Cerrado' }[stateKey];
      const total      = parseFloat(est['total-amount'] ?? est.total ?? 0);
      const rawDate    = est.date ?? est['issue-date'] ?? est['created-at'];
      const estDate    = rawDate ? new Date(rawDate) : now;
      const daysOld    = Math.floor((now - estDate) / 86400000);

      const item = {
        id:         String(est.id),
        number:     est.number ?? `#${est.id}`,
        client:     resolveClientName(est, clientMap),
        date:       rawDate,
        dueDate:    est['due-date'] ?? est['expiry-date'],
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
    return { total:0, accepted:[], pending:[], closed:[], rejected:[], all:[],
             totalAccepted:0, totalPending:0, totalClosed:0, totalAll:0, monthsCovered:'0' };
  }
}

// ─── Resumen general ──────────────────────────────────────────────
async function getSummary() {
  try {
    const now = new Date();
    const thisMonth = now.getMonth(), thisYear = now.getFullYear();
    const [receipts, clients] = await Promise.all([fetchAllReceiptsPages(), getClients()]);
    const clientMap   = buildClientMap(clients);
    const allInvoices = buildInvoicesFromReceipts(receipts, clientMap);

    let totalBilled = 0, totalBilledMonth = 0, totalBilledMonthCount = 0;
    const pending = [];

    for (const inv of allInvoices) {
      const total = inv.totalAmount;
      if (total <= 0) continue;
      totalBilled += total;

      const rawDate   = inv.date;
      const issueDate = rawDate ? new Date(rawDate) : now;
      if (issueDate.getMonth() === thisMonth && issueDate.getFullYear() === thisYear) {
        totalBilledMonth += total; totalBilledMonthCount++;
      }

      const pendingAmount = parseFloat((total - inv.paidAmount).toFixed(2));
      if (pendingAmount < 0.01) continue;
      const daysOverdue = Math.max(0, Math.floor((now - issueDate) / 86400000));
      pending.push({
        id: inv.id, number: inv.number, client: inv.client,
        date: rawDate, total, paid: inv.paidAmount, pending: pendingAmount,
        daysOverdue, alertLevel: getAlertLevel(daysOverdue)
      });
    }

    pending.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

    return {
      totalInvoices:       allInvoices.length,
      totalInvoicesMonth:  totalBilledMonthCount,
      totalBilled,         totalBilledMonth,
      pendingInvoices:     pending.length,
      totalPending:        pending.reduce((s,i) => s+i.pending, 0),
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

async function getInvoices() {
  const receipts = await fetchAllReceiptsPages();
  const clients  = await getClients();
  return buildInvoicesFromReceipts(receipts, buildClientMap(clients));
}

async function getAllReceipts() { return fetchAllReceiptsPages(); }

module.exports = {
  getInvoices, getAllReceipts, getPendingInvoices, getClients,
  getWorkEstimates, getEstimatesSummary, getBankAccounts, getSummary, getAlertLevel
};
