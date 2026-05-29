// src/stelorder.js — v6 con presupuestos y nombre jurídico
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

// ─── Paginación genérica ──────────────────────────────────────────
async function fetchAll(endpoint) {
  const all = [];
  let offset = 0;
  while (true) {
    const sep = endpoint.includes('?') ? '&' : '?';
    const url = `${endpoint}${sep}limit=500${offset > 0 ? '&offset=' + offset : ''}`;
    try {
      const res = await client.get(url);
      const page = Array.isArray(res.data) ? res.data : [];
      all.push(...page);
      if (page.length < 500) break;
      offset += 500;
    } catch (err) {
      console.error(`[StelOrder] Error ${endpoint}:`, err.response?.status, err.message);
      break;
    }
  }
  return all;
}

// ─── Extraer nombre del cliente ───────────────────────────────────
// StelOrder guarda el nombre jurídico en varios campos según el plan
function getClientName(obj) {
  return (
    obj['legal-name']        ||  // nombre jurídico (el que usáis)
    obj['fiscal-name']       ||  // nombre fiscal
    obj['commercial-name']   ||  // nombre comercial
    obj['client-name']       ||  // campo directo en facturas
    obj['contact-name']      ||  // contacto
    obj['company-name']      ||  // empresa
    obj['nombre-juridico']   ||  // por si acaso en español
    obj.name                 ||  // campo genérico
    obj['business-name']     ||  // negocio
    ''
  ).trim();
}

// ─── Clientes ─────────────────────────────────────────────────────
async function getClients() {
  const clients = await fetchAll('/clients');
  console.log(`[StelOrder] Clientes: ${clients.length}`);
  if (clients.length > 0) {
    // Log todos los campos del primer cliente para debug
    console.log('[StelOrder] Campos cliente:', Object.keys(clients[0]).join(' | '));
    console.log('[StelOrder] Nombre extraído:', getClientName(clients[0]));
  }
  return clients;
}

// ─── Facturas ─────────────────────────────────────────────────────
async function getInvoices() {
  const invoices = await fetchAll('/ordinaryInvoices');
  console.log(`[StelOrder] Facturas: ${invoices.length}`);
  return invoices;
}

// ─── Recibos ─────────────────────────────────────────────────────
async function getAllReceipts() {
  const receipts = await fetchAll('/ordinaryInvoiceReceipts');
  console.log(`[StelOrder] Recibos: ${receipts.length}`);
  return receipts;
}

// ─── Presupuestos ─────────────────────────────────────────────────
async function getSalesEstimates() {
  const estimates = await fetchAll('/salesEstimates');
  console.log(`[StelOrder] Presupuestos: ${estimates.length}`);
  if (estimates.length > 0) {
    console.log('[StelOrder] Campos presupuesto:', Object.keys(estimates[0]).join(' | '));
  }
  return estimates;
}

// ─── Estados de documento ─────────────────────────────────────────
async function getDocumentStates() {
  try {
    const res = await client.get('/documentStates?limit=100');
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    console.error('[StelOrder] Error documentStates:', err.message);
    return [];
  }
}

// ─── Facturas pendientes de cobro ─────────────────────────────────
async function getPendingInvoices() {
  try {
    const now = new Date();
    const [invoices, receipts, clients] = await Promise.all([
      getInvoices(), getAllReceipts(), getClients()
    ]);

    // Mapa clientes id → nombre
    const clientMap = {};
    clients.forEach(c => {
      const name = getClientName(c);
      if (name) clientMap[String(c.id)] = name;
    });

    // Mapa pagos: invoiceId → total cobrado
    const paidByInvoice = {};
    receipts.forEach(r => {
      if (!r['payment-date']) return;
      const invId = String(r['original-element-id'] || '');
      if (!invId) return;
      const amount = parseFloat(r.amount || 0);
      if (amount > 0) paidByInvoice[invId] = (paidByInvoice[invId] || 0) + amount;
    });

    const pending = [];
    for (const inv of invoices) {
      const invId = String(inv.id);
      const total = parseFloat(inv['total-amount'] || inv.total || 0);
      if (total <= 0) continue;

      const paid          = paidByInvoice[invId] || 0;
      const pendingAmount = parseFloat((total - paid).toFixed(2));
      if (pendingAmount < 0.01) continue;

      // Nombre cliente: primero campos directos en factura, luego mapa
      let clientName = getClientName(inv);
      if (!clientName || clientName === '') {
        const accountPath = inv['account-path'] || '';
        const match = accountPath.match(/\/clients\/(\d+)/);
        if (match) clientName = clientMap[match[1]] || '';
      }
      if (!clientName) clientName = 'Sin nombre';

      const rawDate    = inv.date || inv['issue-date'];
      const issueDate  = rawDate ? new Date(rawDate) : now;
      const daysOverdue = Math.max(0, Math.floor((now - issueDate) / 86400000));
      const number     = inv.number || inv['invoice-number'] || `#${invId}`;

      pending.push({
        id: invId, number, client: clientName,
        date: rawDate, dueDate: inv['due-date'] || null,
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
    const [estimates, states, clients] = await Promise.all([
      getSalesEstimates(), getDocumentStates(), getClients()
    ]);

    // Log estados para saber cuáles son "aceptado", "pendiente", etc.
    console.log('[StelOrder] Estados disponibles:', states.map(s => `${s.id}:${s.name||s.description||JSON.stringify(s)}`).join(' | '));

    // Mapa clientes
    const clientMap = {};
    clients.forEach(c => {
      const name = getClientName(c);
      if (name) clientMap[String(c.id)] = name;
    });

    const now = new Date();
    const thisMonth = now.getMonth();
    const thisYear  = now.getFullYear();

    // Categorizar presupuestos
    // Los estados de StelOrder suelen tener nombres como: pending, accepted, rejected, sent, etc.
    const result = {
      total: estimates.length,
      accepted: [],
      pending: [],
      sent: [],
      rejected: [],
      expired: [],
      all: []
    };

    estimates.forEach(est => {
      const stateId   = est['document-state-id'] || est.stateId || est['state-id'];
      const stateName = (est['document-state-name'] || est.state || est['state-name'] || '').toLowerCase();
      const total     = parseFloat(est['total-amount'] || est.total || 0);

      // Extraer cliente
      let clientName = getClientName(est);
      if (!clientName) {
        const path = est['account-path'] || '';
        const match = path.match(/\/clients\/(\d+)/);
        if (match) clientName = clientMap[match[1]] || 'Sin nombre';
      }
      if (!clientName) clientName = 'Sin nombre';

      const rawDate   = est.date || est['issue-date'] || est['created-at'];
      const estDate   = rawDate ? new Date(rawDate) : now;
      const daysOld   = Math.floor((now - estDate) / 86400000);
      const isThisMonth = estDate.getMonth() === thisMonth && estDate.getFullYear() === thisYear;
      const number    = est.number || est['estimate-number'] || `#${est.id}`;

      const item = {
        id: String(est.id), number, client: clientName,
        date: rawDate, total, stateId, stateName,
        daysOld, isThisMonth,
        dueDate: est['due-date'] || est['expiry-date']
      };

      result.all.push(item);

      // Clasificar por estado
      if (stateName.includes('acept') || stateName.includes('accept') || stateName === 'approved') {
        result.accepted.push(item);
      } else if (stateName.includes('rechaz') || stateName.includes('reject') || stateName === 'declined') {
        result.rejected.push(item);
      } else if (stateName.includes('enviad') || stateName.includes('sent')) {
        result.sent.push(item);
      } else if (stateName.includes('caduc') || stateName.includes('expir')) {
        result.expired.push(item);
      } else {
        result.pending.push(item); // pendiente / borrador / sin estado claro
      }
    });

    // Totales económicos
    const totalAccepted  = result.accepted.reduce((s,e) => s + e.total, 0);
    const totalPending   = result.pending.reduce((s,e) => s + e.total, 0);
    const totalSent      = result.sent.reduce((s,e) => s + e.total, 0);
    const totalAll       = result.all.reduce((s,e) => s + e.total, 0);

    // Meses cubiertos con los aceptados (asumiendo facturación mensual media)
    const avgMonthlyExpenses = 36000; // media gastos reales 2026
    const monthsCovered = totalAccepted > 0 ? (totalAccepted / avgMonthlyExpenses).toFixed(1) : 0;

    return {
      ...result,
      totalAccepted, totalPending, totalSent, totalAll,
      monthsCovered,
      statesDebug: states.map(s => ({id:s.id, name:s.name||s.description}))
    };
  } catch (err) {
    console.error('[StelOrder] Error getEstimatesSummary:', err.message);
    return { total:0, accepted:[], pending:[], sent:[], rejected:[], expired:[], all:[],
             totalAccepted:0, totalPending:0, totalSent:0, totalAll:0, monthsCovered:0 };
  }
}

// ─── Resumen general ──────────────────────────────────────────────
async function getSummary() {
  try {
    const now = new Date();
    const thisMonth = now.getMonth();
    const thisYear  = now.getFullYear();

    const [invoices, receipts, clients] = await Promise.all([
      getInvoices(), getAllReceipts(), getClients()
    ]);

    const clientMap = {};
    clients.forEach(c => {
      const name = getClientName(c);
      if (name) clientMap[String(c.id)] = name;
    });

    const paidByInvoice = {};
    receipts.forEach(r => {
      if (!r['payment-date']) return;
      const invId = String(r['original-element-id'] || '');
      if (!invId) return;
      const amount = parseFloat(r.amount || 0);
      if (amount > 0) paidByInvoice[invId] = (paidByInvoice[invId] || 0) + amount;
    });

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

      const paid          = paidByInvoice[invId] || 0;
      const pendingAmount = parseFloat((total - paid).toFixed(2));
      if (pendingAmount < 0.01) continue;

      let clientName = getClientName(inv);
      if (!clientName) {
        const path = inv['account-path'] || '';
        const match = path.match(/\/clients\/(\d+)/);
        if (match) clientName = clientMap[match[1]] || 'Sin nombre';
      }
      if (!clientName) clientName = 'Sin nombre';

      const daysOverdue = Math.max(0, Math.floor((now - issueDate) / 86400000));
      pending.push({
        id: invId,
        number: inv.number || inv['invoice-number'] || `#${invId}`,
        client: clientName,
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
    return {
      totalInvoices:0, totalInvoicesMonth:0, totalBilled:0, totalBilledMonth:0,
      pendingInvoices:0, totalPending:0, overdueCount:0, criticalCount:0,
      warningCount:0, pendingList:[], lastUpdated: new Date().toISOString()
    };
  }
}

module.exports = {
  getInvoices, getAllReceipts, getPendingInvoices,
  getClients, getSalesEstimates, getEstimatesSummary,
  getDocumentStates, getSummary, getAlertLevel
};
