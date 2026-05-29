// src/stelorder.js
// Cliente para la API de StelOrder — endpoints correctos según documentación oficial
const axios = require('axios');

const BASE_URL = 'https://app.stelorder.com/app';
const API_KEY  = process.env.STELORDER_API_KEY;

const client = axios.create({
  baseURL: BASE_URL,
  headers: {
    'APIKEY': API_KEY,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  },
  timeout: 15000
});

// ─── Helper: nivel de alerta por días ────────────────────────────
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

// ─── Facturas emitidas (ordinaryInvoices) ────────────────────────
async function getInvoices({ limit = 100, offset = 0 } = {}) {
  try {
    const res = await client.get('/ordinaryInvoices', {
      params: { limit, offset }
    });
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    console.error('[StelOrder] Error getInvoices:', err.response?.status, err.message);
    return [];
  }
}

// ─── Recibos de facturas (cobros) ─────────────────────────────────
// ordinaryInvoiceReceipts contiene el estado de cobro de cada factura
async function getInvoiceReceipts({ limit = 500 } = {}) {
  try {
    const res = await client.get('/ordinaryInvoiceReceipts', {
      params: { limit }
    });
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    console.error('[StelOrder] Error getInvoiceReceipts:', err.response?.status, err.message);
    return [];
  }
}

// ─── Clientes ────────────────────────────────────────────────────
async function getClients({ limit = 500 } = {}) {
  try {
    const res = await client.get('/clients', { params: { limit } });
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    console.error('[StelOrder] Error getClients:', err.response?.status, err.message);
    return [];
  }
}

// ─── Facturas pendientes de cobro ─────────────────────────────────
async function getPendingInvoices() {
  try {
    const now = new Date();

    // Traer facturas e invoiceReceipts en paralelo
    const [invoices, receipts] = await Promise.all([
      getInvoices({ limit: 500 }),
      getInvoiceReceipts({ limit: 500 })
    ]);

    console.log(`[StelOrder] Facturas obtenidas: ${invoices.length}, Recibos: ${receipts.length}`);

    // Crear mapa de recibos por invoiceId para cruzar datos
    // Cada receipt tiene: id, invoiceId (o similar), amount, paymentDate, etc.
    const receiptsByInvoice = {};
    receipts.forEach(r => {
      const invId = r['ordinary-invoice-id'] || r.invoiceId || r['invoice-id'] || r.ordinaryInvoiceId;
      if (!invId) return;
      if (!receiptsByInvoice[invId]) receiptsByInvoice[invId] = [];
      receiptsByInvoice[invId].push(r);
    });

    const pending = [];

    for (const inv of invoices) {
      const invId = inv.id;
      const total = parseFloat(inv.total || inv.amount || inv['total-amount'] || 0);
      if (total <= 0) continue;

      // Calcular cuánto está cobrado de esta factura
      const invReceipts = receiptsByInvoice[invId] || [];
      const paid = invReceipts.reduce((sum, r) => {
        // Si tiene fecha de cobro, está cobrado
        const payDate = r['payment-date'] || r.paymentDate || r['paid-date'];
        const amount  = parseFloat(r.amount || r.total || 0);
        return payDate ? sum + amount : sum;
      }, 0);

      const pendingAmount = total - paid;
      if (pendingAmount <= 0.01) continue; // Cobrado (margen centavos)

      // Fecha de emisión
      const rawDate = inv.date || inv['issue-date'] || inv['created-at'] || inv.createdAt;
      const issueDate = rawDate ? new Date(rawDate) : now;
      const daysOverdue = Math.max(0, Math.floor((now - issueDate) / (1000 * 60 * 60 * 24)));

      // Nombre cliente
      const clientName = inv['client-name'] || inv.clientName ||
                         inv.client?.name || inv['contact-name'] || 'Cliente';

      // Número de factura
      const number = inv.number || inv['invoice-number'] || inv['document-number'] || `#${invId}`;

      pending.push({
        id:          invId,
        number,
        client:      clientName,
        date:        rawDate || now.toISOString(),
        dueDate:     inv['due-date'] || inv.dueDate || inv['expiry-date'],
        total,
        paid,
        pending:     pendingAmount,
        daysOverdue,
        alertLevel:  getAlertLevel(daysOverdue),
        receipts:    invReceipts.length
      });
    }

    return pending.sort((a, b) => b.daysOverdue - a.daysOverdue);

  } catch (err) {
    console.error('[StelOrder] Error getPendingInvoices:', err.message);
    return [];
  }
}

// ─── Resumen general ─────────────────────────────────────────────
async function getSummary() {
  try {
    const now = new Date();
    const thisMonth = now.getMonth();
    const thisYear  = now.getFullYear();

    const [invoices, pending] = await Promise.all([
      getInvoices({ limit: 500 }),
      getPendingInvoices()
    ]);

    // Facturas de este mes
    const thisMonthInvoices = invoices.filter(inv => {
      const d = new Date(inv.date || inv['issue-date'] || inv['created-at'] || 0);
      return d.getMonth() === thisMonth && d.getFullYear() === thisYear;
    });

    const totalBilled      = invoices.reduce((s, i) => s + parseFloat(i.total || i.amount || 0), 0);
    const totalBilledMonth = thisMonthInvoices.reduce((s, i) => s + parseFloat(i.total || i.amount || 0), 0);
    const totalPending     = pending.reduce((s, i) => s + i.pending, 0);
    const overdueCount     = pending.filter(i => i.daysOverdue >= 30).length;
    const criticalCount    = pending.filter(i => i.daysOverdue >= 60).length;

    return {
      totalInvoices:     invoices.length,
      totalBilled,
      totalBilledMonth,
      pendingInvoices:   pending.length,
      totalPending,
      overdueCount,
      criticalCount,
      pendingList:       pending.slice(0, 25),
      lastUpdated:       now.toISOString()
    };
  } catch (err) {
    console.error('[StelOrder] Error getSummary:', err.message);
    return {
      totalInvoices: 0, totalBilled: 0, totalBilledMonth: 0,
      pendingInvoices: 0, totalPending: 0, overdueCount: 0,
      criticalCount: 0, pendingList: [], lastUpdated: new Date().toISOString()
    };
  }
}

module.exports = { getInvoices, getInvoiceReceipts, getPendingInvoices, getClients, getSummary, getAlertLevel };
