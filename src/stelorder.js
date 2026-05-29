// src/stelorder.js — v5 definitivo
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

// ─── Facturas — todas las páginas ────────────────────────────────
// StelOrder devuelve máx 500 por llamada — si hay más hay que paginar
async function getInvoices() {
  try {
    const all = [];
    let offset = 0;
    while (true) {
      const url = `/ordinaryInvoices?limit=500${offset > 0 ? '&offset=' + offset : ''}`;
      const res = await client.get(url);
      const page = Array.isArray(res.data) ? res.data : [];
      all.push(...page);
      if (page.length < 500) break; // última página
      offset += 500;
    }
    console.log(`[StelOrder] Total facturas: ${all.length}`);
    return all;
  } catch (err) {
    console.error('[StelOrder] Error getInvoices:', err.response?.status, err.message);
    return [];
  }
}

// ─── Recibos — todas las páginas ─────────────────────────────────
async function getAllReceipts() {
  try {
    const all = [];
    let offset = 0;
    while (true) {
      const url = `/ordinaryInvoiceReceipts?limit=500${offset > 0 ? '&offset=' + offset : ''}`;
      const res = await client.get(url);
      const page = Array.isArray(res.data) ? res.data : [];
      all.push(...page);
      if (page.length < 500) break;
      offset += 500;
    }
    console.log(`[StelOrder] Total recibos: ${all.length}`);
    return all;
  } catch (err) {
    console.error('[StelOrder] Error getAllReceipts:', err.response?.status, err.message);
    return [];
  }
}

// ─── Clientes ─────────────────────────────────────────────────────
async function getClients() {
  try {
    const all = [];
    let offset = 0;
    while (true) {
      const url = `/clients?limit=500${offset > 0 ? '&offset=' + offset : ''}`;
      const res = await client.get(url);
      const page = Array.isArray(res.data) ? res.data : [];
      all.push(...page);
      if (page.length < 500) break;
      offset += 500;
    }
    console.log(`[StelOrder] Total clientes: ${all.length}`);
    return all;
  } catch (err) {
    console.error('[StelOrder] Error getClients:', err.response?.status, err.message);
    return [];
  }
}

// ─── Helper: extraer nombre de cliente de la factura ─────────────
// La factura tiene varios campos posibles con el nombre
function extractClientName(inv, clientMap) {
  // 1. Campos directos en la factura (el más fiable)
  const direct = inv['client-name'] || inv['contact-name'] ||
                 inv['fiscal-name'] || inv['commercial-name'] ||
                 inv.clientName || inv.contactName;
  if (direct && direct.trim()) return direct.trim();

  // 2. Desde el account-path: "app.stelorder.com/app/clients/12043668"
  const accountPath = inv['account-path'] || inv['client-path'] || '';
  const match = accountPath.match(/\/clients\/(\d+)/);
  if (match) {
    const name = clientMap[match[1]];
    if (name) return name;
  }

  // 3. Desde el path de la propia factura
  const invPath = inv['path'] || '';
  const pathMatch = invPath.match(/\/clients\/(\d+)/);
  if (pathMatch) {
    const name = clientMap[pathMatch[1]];
    if (name) return name;
  }

  return 'Cliente sin nombre';
}

// ─── Facturas pendientes ──────────────────────────────────────────
async function getPendingInvoices() {
  try {
    const now = new Date();
    const [invoices, receipts, clients] = await Promise.all([
      getInvoices(), getAllReceipts(), getClients()
    ]);

    // Mapa de clientes: id (string) → nombre
    const clientMap = {};
    clients.forEach(c => {
      const name = c['commercial-name'] || c['fiscal-name'] ||
                   c['client-name'] || c.name || '';
      if (name.trim()) clientMap[String(c.id)] = name.trim();
    });

    // Log ejemplo de cliente para debug
    if (clients.length > 0) {
      const ex = clients[0];
      console.log('[StelOrder] Ejemplo cliente keys:', Object.keys(ex).join(', '));
    }

    // Mapa de pagos: invoiceId → total cobrado
    // Solo recibos CON payment-date son pagos reales
    const paidByInvoice = {};
    receipts.forEach(r => {
      if (!r['payment-date']) return; // sin fecha = no cobrado
      const invoiceId = String(r['original-element-id'] || '');
      if (!invoiceId) return;
      const amount = parseFloat(r.amount || 0);
      if (amount > 0) {
        paidByInvoice[invoiceId] = (paidByInvoice[invoiceId] || 0) + amount;
      }
    });

    const cobradas = Object.keys(paidByInvoice).length;
    console.log(`[StelOrder] Facturas con algún cobro: ${cobradas}`);

    // Calcular pendientes
    const pending = [];
    const thisMonth = now.getMonth();
    const thisYear  = now.getFullYear();

    for (const inv of invoices) {
      const invId = String(inv.id);
      const total = parseFloat(inv['total-amount'] || inv.total || 0);
      if (total <= 0) continue;

      const paid          = paidByInvoice[invId] || 0;
      const pendingAmount = parseFloat((total - paid).toFixed(2));
      if (pendingAmount < 0.01) continue; // cobrada

      const rawDate    = inv.date || inv['issue-date'];
      const issueDate  = rawDate ? new Date(rawDate) : now;
      const daysOverdue = Math.max(0, Math.floor((now - issueDate) / 86400000));
      const clientName = extractClientName(inv, clientMap);
      const number     = inv.number || inv['invoice-number'] || `#${invId}`;

      // ¿Es de este mes?
      const isThisMonth = issueDate.getMonth() === thisMonth &&
                          issueDate.getFullYear() === thisYear;

      pending.push({
        id: invId, number, client: clientName,
        date: rawDate || now.toISOString(),
        dueDate: inv['due-date'] || null,
        total, paid, pending: pendingAmount,
        daysOverdue, alertLevel: getAlertLevel(daysOverdue),
        isThisMonth
      });
    }

    console.log(`[StelOrder] Pendientes: ${pending.length}/${invoices.length}`);
    return pending.sort((a, b) => b.daysOverdue - a.daysOverdue);

  } catch (err) {
    console.error('[StelOrder] Error getPendingInvoices:', err.message);
    return [];
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

    // Mapa de clientes
    const clientMap = {};
    clients.forEach(c => {
      const name = c['commercial-name'] || c['fiscal-name'] || c.name || '';
      if (name.trim()) clientMap[String(c.id)] = name.trim();
    });

    // Mapa de pagos
    const paidByInvoice = {};
    receipts.forEach(r => {
      if (!r['payment-date']) return;
      const invId = String(r['original-element-id'] || '');
      if (!invId) return;
      const amount = parseFloat(r.amount || 0);
      if (amount > 0) paidByInvoice[invId] = (paidByInvoice[invId] || 0) + amount;
    });

    // Calcular métricas
    let totalBilled = 0, totalBilledMonth = 0;
    let totalBilledMonthCount = 0;
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

      const daysOverdue = Math.max(0, Math.floor((now - issueDate) / 86400000));
      const clientName  = extractClientName(inv, clientMap);

      pending.push({
        id: invId,
        number: inv.number || inv['invoice-number'] || `#${invId}`,
        client: clientName,
        date: rawDate || now.toISOString(),
        dueDate: inv['due-date'] || null,
        total, paid, pending: pendingAmount,
        daysOverdue, alertLevel: getAlertLevel(daysOverdue)
      });
    }

    pending.sort((a, b) => b.daysOverdue - a.daysOverdue);

    return {
      totalInvoices:        invoices.length,
      totalInvoicesMonth:   totalBilledMonthCount,
      totalBilled,
      totalBilledMonth,
      pendingInvoices:      pending.length,
      totalPending:         pending.reduce((s,i) => s + i.pending, 0),
      overdueCount:         pending.filter(i => i.daysOverdue >= 30 && i.daysOverdue < 60).length,
      criticalCount:        pending.filter(i => i.daysOverdue >= 60).length,
      warningCount:         pending.filter(i => i.daysOverdue >= 15 && i.daysOverdue < 30).length,
      pendingList:          pending.slice(0, 25),
      lastUpdated:          now.toISOString()
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

module.exports = { getInvoices, getAllReceipts, getPendingInvoices, getClients, getSummary, getAlertLevel };
