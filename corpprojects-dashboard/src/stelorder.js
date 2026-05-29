// src/stelorder.js
// Cliente para la API de StelOrder
const axios = require('axios');

const BASE_URL = 'https://app.stelorder.com/api';
const API_KEY  = process.env.STELORDER_API_KEY;

const client = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Authorization': API_KEY,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  },
  timeout: 15000
});

// ─── Facturas emitidas ───────────────────────────────────────────
async function getInvoices({ page = 1, limit = 100, status } = {}) {
  try {
    const params = { page, limit };
    if (status) params.status = status;
    const res = await client.get('/invoices', { params });
    return res.data;
  } catch (err) {
    console.error('[StelOrder] Error obteniendo facturas:', err.message);
    return { data: [], total: 0 };
  }
}

// ─── Facturas pendientes de cobro ────────────────────────────────
async function getPendingInvoices() {
  try {
    // Obtenemos todas y filtramos las no cobradas
    const all = await getInvoices({ limit: 500 });
    const invoices = Array.isArray(all) ? all : (all.data || []);
    const now = new Date();

    return invoices
      .filter(inv => {
        // Estado no cobrado: pending, unpaid, overdue según StelOrder
        const unpaidStatuses = ['pending', 'unpaid', 'overdue', 'parcial', 'partial', '0', 0];
        const isPending = unpaidStatuses.includes(inv.status) ||
                          unpaidStatuses.includes(inv.payment_status) ||
                          (inv.total_paid !== undefined && parseFloat(inv.total_paid) < parseFloat(inv.total || 0));
        return isPending;
      })
      .map(inv => {
        const issueDate = new Date(inv.date || inv.created_at);
        const daysOverdue = Math.floor((now - issueDate) / (1000 * 60 * 60 * 24));
        const total = parseFloat(inv.total || inv.amount || 0);
        const paid  = parseFloat(inv.total_paid || inv.paid_amount || 0);
        const pending = total - paid;

        return {
          id:          inv.id,
          number:      inv.number || inv.invoice_number || `#${inv.id}`,
          client:      inv.client?.name || inv.customer_name || inv.contact_name || 'Cliente',
          date:        inv.date || inv.created_at,
          dueDate:     inv.due_date || inv.expiry_date,
          total:       total,
          paid:        paid,
          pending:     pending,
          daysOverdue: daysOverdue,
          status:      inv.status || inv.payment_status,
          alertLevel:  getAlertLevel(daysOverdue)
        };
      })
      .sort((a, b) => b.daysOverdue - a.daysOverdue);

  } catch (err) {
    console.error('[StelOrder] Error en getPendingInvoices:', err.message);
    return [];
  }
}

// ─── Clientes ────────────────────────────────────────────────────
async function getClients() {
  try {
    const res = await client.get('/contacts', { params: { limit: 500, type: 'client' } });
    return Array.isArray(res.data) ? res.data : (res.data?.data || []);
  } catch (err) {
    console.error('[StelOrder] Error obteniendo clientes:', err.message);
    return [];
  }
}

// ─── Resumen general ─────────────────────────────────────────────
async function getSummary() {
  try {
    const allInvoices = await getInvoices({ limit: 500 });
    const invoices = Array.isArray(allInvoices) ? allInvoices : (allInvoices.data || []);
    const pending  = await getPendingInvoices();
    const now      = new Date();
    const thisMonth = now.getMonth();
    const thisYear  = now.getFullYear();

    const invoicesThisMonth = invoices.filter(inv => {
      const d = new Date(inv.date || inv.created_at);
      return d.getMonth() === thisMonth && d.getFullYear() === thisYear;
    });

    const totalBilled       = invoices.reduce((s, i) => s + parseFloat(i.total || 0), 0);
    const totalBilledMonth  = invoicesThisMonth.reduce((s, i) => s + parseFloat(i.total || 0), 0);
    const totalPending      = pending.reduce((s, i) => s + i.pending, 0);
    const overdueCount      = pending.filter(i => i.daysOverdue > 30).length;
    const criticalCount     = pending.filter(i => i.daysOverdue >= 60).length;

    return {
      totalInvoices:      invoices.length,
      totalBilled,
      totalBilledMonth,
      pendingInvoices:    pending.length,
      totalPending,
      overdueCount,
      criticalCount,
      pendingList:        pending.slice(0, 20),
      lastUpdated:        new Date().toISOString()
    };
  } catch (err) {
    console.error('[StelOrder] Error en getSummary:', err.message);
    return null;
  }
}

// ─── Helper nivel de alerta ──────────────────────────────────────
function getAlertLevel(days) {
  const W  = parseInt(process.env.ALERT_WARNING_DAYS  || 15);
  const S  = parseInt(process.env.ALERT_SECOND_DAYS   || 30);
  const U  = parseInt(process.env.ALERT_URGENT_DAYS   || 45);
  const C  = parseInt(process.env.ALERT_CRITICAL_DAYS || 60);

  if (days >= C) return 'critical';   // 🔴🔴 60+ días
  if (days >= U) return 'urgent';     // 🔴 45+ días
  if (days >= S) return 'warning2';   // ⚠️⚠️ 30+ días
  if (days >= W) return 'warning1';   // ⚠️ 15+ días
  return 'ok';
}

module.exports = { getInvoices, getPendingInvoices, getClients, getSummary, getAlertLevel };
