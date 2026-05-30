// src/stelorder.js — v12 SOLUCIÓN DEFINITIVA facturas recientes
// Las facturas recientes no aparecen en el listado de 500 NI individualmente (error API)
// PERO los ordinaryInvoiceReceipts SÍ tienen toda la info necesaria:
// - original-element-id = ID de factura
// - amount = importe
// - payment-date = si está cobrado
// - account-path = cliente
// Construimos las facturas faltantes desde los recibos directamente.

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

async function getClients()        { const d = await fetchEndpoint('/clients');                  console.log(`[StelOrder] Clientes: ${d.length}`);      return d; }
async function getDocumentStates() { return fetchEndpoint('/documentStates'); }
async function getBankAccounts()   { return fetchEndpoint('/bankAccounts'); }
async function getWorkEstimates()  { const d = await fetchEndpoint('/workEstimates');            console.log(`[StelOrder] WorkEstimates: ${d.length}`); return d; }

async function getAllReceipts() {
  const d = await fetchEndpoint('/ordinaryInvoiceReceipts');
  console.log(`[StelOrder] Recibos: ${d.length}`);
  return d;
}

// ─── SOLUCIÓN DEFINITIVA: facturas desde batch + reconstruidas desde recibos ──
async function getInvoicesAndReceipts() {
  try {
    const [batchRaw, receipts] = await Promise.all([
      fetchEndpoint('/ordinaryInvoices'),
      fetchEndpoint('/ordinaryInvoiceReceipts')
    ]);

    // Mapa de facturas del batch por ID
    const invoiceMap = new Map();
    batchRaw.forEach(inv => invoiceMap.set(String(inv.id), inv));

    // Mapa de pagos: invoiceId → total cobrado
    // Y mapa de info de recibos: invoiceId → datos del recibo (fecha, cliente, importe)
    const paidMap    = new Map(); // invoiceId → total pagado
    const receiptInfo = new Map(); // invoiceId → {date, clientPath, amount, number}

    receipts.forEach(r => {
      const invId  = String(r['original-element-id'] || '');
      if (!invId) return;

      // Acumular pagos
      if (r['payment-date']) {
        const amount = parseFloat(r.amount || 0);
        if (amount > 0) paidMap.set(invId, (paidMap.get(invId) || 0) + amount);
      }

      // Guardar info del recibo para reconstruir factura si no está en batch
      if (!receiptInfo.has(invId)) {
        receiptInfo.set(invId, {
          id:           invId,
          date:         r['creation-date'] || r['utc-last-modification-date'],
          accountPath:  r['account-path'] || '',
          amount:       parseFloat(r.amount || 0),
          concept:      r.concept || '',
          receiptId:    r.id,
          number:       r['document-number'] || r.number || null
        });
      } else {
        // Si ya existe, acumular importe para saber el total de la factura
        const existing = receiptInfo.get(invId);
        existing.amount += parseFloat(r.amount || 0);
      }
    });

    // IDs de facturas en recibos que NO están en el batch
    const missingIds = [...receiptInfo.keys()].filter(id => !invoiceMap.has(id));
    console.log(`[StelOrder] Batch: ${batchRaw.length} | IDs en recibos no en batch: ${missingIds.length}`);

    // Reconstruir facturas faltantes desde los datos del recibo
    // Estas son las facturas recientes que la API no devuelve en el listado
    missingIds.forEach(invId => {
      const info = receiptInfo.get(invId);
      invoiceMap.set(invId, {
        id:             invId,
        'total-amount': info.amount,
        total:          info.amount,
        date:           info.date,
        'account-path': info.accountPath,
        number:         info.number || `#${invId}`,
        _reconstructed: true  // marcar para debug
      });
    });

    const allInvoices = Array.from(invoiceMap.values());
    const dates = allInvoices.map(i => (i.date || '').slice(0,10)).filter(Boolean).sort();
    const reconstructedCount = allInvoices.filter(i => i._reconstructed).length;
    console.log(`[StelOrder] Total facturas: ${allInvoices.length} (${reconstructedCount} reconstruidas desde recibos)`);
    if (dates.length > 0) console.log(`[StelOrder] Rango fechas: ${dates[0]} → ${dates[dates.length-1]}`);

    return { invoices: allInvoices, paidMap, receipts };
  } catch (err) {
    console.error('[StelOrder] Error getInvoicesAndReceipts:', err.message);
    return { invoices: [], paidMap: new Map(), receipts: [] };
  }
}

// ─── Facturas pendientes de cobro ─────────────────────────────────
async function getPendingInvoices() {
  try {
    const now = new Date();
    const clients = await getClients();
    const clientMap = buildClientMap(clients);
    const { invoices, paidMap } = await getInvoicesAndReceipts();
    const pending = [];

    for (const inv of invoices) {
      const invId = String(inv.id);
      const total = parseFloat(inv['total-amount'] || inv.total || 0);
      if (total <= 0) continue;
      const paid          = paidMap.get(invId) || 0;
      const pendingAmount = parseFloat((total - paid).toFixed(2));
      if (pendingAmount < 0.01) continue;
      const rawDate     = inv.date || inv['issue-date'];
      const issueDate   = rawDate ? new Date(rawDate) : now;
      const daysOverdue = Math.max(0, Math.floor((now - issueDate) / 86400000));
      pending.push({
        id: invId,
        number:    inv.number || inv['invoice-number'] || `FAC #${invId}`,
        client:    resolveClientName(inv, clientMap),
        date:      rawDate,
        dueDate:   inv['due-date'] || null,
        total, paid, pending: pendingAmount,
        daysOverdue, alertLevel: getAlertLevel(daysOverdue),
        reconstructed: !!inv._reconstructed
      });
    }
    console.log(`[StelOrder] Pendientes: ${pending.length} (${pending.filter(p=>p.reconstructed).length} de recibos)`);
    return pending.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  } catch (err) {
    console.error('[StelOrder] Error getPendingInvoices:', err.message);
    return [];
  }
}

// ─── ESTADOS WORKESTIMATE confirmados ─────────────────────────────
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
      result[stateKey === 'closed' ? 'closed' : stateKey].push(item);
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
    const clients = await getClients();
    const clientMap = buildClientMap(clients);
    const { invoices, paidMap } = await getInvoicesAndReceipts();

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
      const paid          = paidMap.get(invId) || 0;
      const pendingAmount = parseFloat((total - paid).toFixed(2));
      if (pendingAmount < 0.01) continue;
      const daysOverdue = Math.max(0, Math.floor((now - issueDate) / 86400000));
      pending.push({
        id: invId,
        number: inv.number || `FAC #${invId}`,
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

// Para compatibilidad con scheduler
async function getInvoices() {
  const { invoices } = await getInvoicesAndReceipts();
  return invoices;
}

module.exports = {
  getInvoices, getAllReceipts, getPendingInvoices, getClients,
  getWorkEstimates, getEstimatesSummary, getBankAccounts, getSummary, getAlertLevel
};
