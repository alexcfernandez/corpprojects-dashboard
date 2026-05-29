// src/stelorder.js — v3 corregido
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
 
// ─── Facturas emitidas ────────────────────────────────────────────
// StelOrder usa parámetro 'limit' sin offset — máximo 500
async function getInvoices() {
  try {
    const res = await client.get('/ordinaryInvoices?limit=500');
    console.log('[StelOrder] ordinaryInvoices status:', res.status, 'count:', Array.isArray(res.data) ? res.data.length : typeof res.data);
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    console.error('[StelOrder] Error getInvoices:', err.response?.status, err.response?.data || err.message);
    return [];
  }
}
 
// ─── Recibos de facturas (estado de cobro) ────────────────────────
async function getInvoiceReceipts() {
  try {
    const res = await client.get('/ordinaryInvoiceReceipts?limit=500');
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    console.error('[StelOrder] Error getReceipts:', err.response?.status, err.message);
    return [];
  }
}
 
// ─── Clientes ─────────────────────────────────────────────────────
async function getClients() {
  try {
    const res = await client.get('/clients?limit=500');
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
    const [invoices, receipts] = await Promise.all([getInvoices(), getInvoiceReceipts()]);
 
    // Log primer elemento para ver estructura real
    if (invoices.length > 0) console.log('[StelOrder] Ejemplo factura:', JSON.stringify(invoices[0]).slice(0, 400));
    if (receipts.length > 0) console.log('[StelOrder] Ejemplo recibo:', JSON.stringify(receipts[0]).slice(0, 400));
 
    // Mapear recibos por ID de factura — probar varios nombres de campo posibles
    const paidByInvoice = {};
    receipts.forEach(r => {
      const keys = ['ordinary-invoice-id','ordinaryInvoiceId','invoice-id','invoiceId','document-id'];
      const invId = keys.reduce((found, k) => found || r[k], null);
      if (!invId) return;
      const payDate = r['payment-date'] || r.paymentDate || r['paid-date'] || r['date'];
      const amount  = parseFloat(r.amount || r.total || r['receipt-amount'] || 0);
      if (payDate && amount > 0) {
        paidByInvoice[invId] = (paidByInvoice[invId] || 0) + amount;
      }
    });
 
    const pending = [];
    for (const inv of invoices) {
      const invId = inv.id;
      // Intentar varios campos de total
      const total = parseFloat(
        inv.total || inv['total-amount'] || inv.amount ||
        inv['total-with-taxes'] || inv.totalAmount || 0
      );
      if (total <= 0) continue;
 
      const paid    = paidByInvoice[invId] || 0;
      const pendingAmount = total - paid;
      if (pendingAmount < 0.01) continue;
 
      // Fecha — varios posibles nombres
      const rawDate = inv.date || inv['issue-date'] || inv['created-at'] || inv.createdAt;
      const issueDate = rawDate ? new Date(rawDate) : now;
      const daysOverdue = Math.max(0, Math.floor((now - issueDate) / 86400000));
 
      const clientName = inv['client-name'] || inv.clientName ||
                         inv['contact-name'] || inv.client?.name || 'Cliente';
      const number = inv.number || inv['invoice-number'] ||
                     inv['document-number'] || `#${invId}`;
 
      pending.push({
        id: invId, number, client: clientName,
        date: rawDate || now.toISOString(),
        dueDate: inv['due-date'] || inv.dueDate,
        total, paid, pending: pendingAmount,
        daysOverdue, alertLevel: getAlertLevel(daysOverdue)
      });
    }
 
    console.log(`[StelOrder] Pendientes encontradas: ${pending.length}`);
    return pending.sort((a, b) => b.daysOverdue - a.daysOverdue);
 
  } catch (err) {
    console.error('[StelOrder] Error getPendingInvoices:', err.message);
    return [];
  }
}
 
// ─── Resumen ──────────────────────────────────────────────────────
async function getSummary() {
  try {
    const now = new Date();
    const [invoices, pending] = await Promise.all([getInvoices(), getPendingInvoices()]);
 
    const thisMonth = now.getMonth(), thisYear = now.getFullYear();
    const monthInv = invoices.filter(i => {
      const d = new Date(i.date || i['issue-date'] || i['created-at'] || 0);
      return d.getMonth() === thisMonth && d.getFullYear() === thisYear;
    });
 
    const totalBilled      = invoices.reduce((s,i) => s + parseFloat(i.total || i['total-amount'] || 0), 0);
    const totalBilledMonth = monthInv.reduce((s,i) => s + parseFloat(i.total || i['total-amount'] || 0), 0);
    const totalPending     = pending.reduce((s,i) => s + i.pending, 0);
 
    return {
      totalInvoices:    invoices.length,
      totalBilled,      totalBilledMonth,
      pendingInvoices:  pending.length,
      totalPending,
      overdueCount:     pending.filter(i => i.daysOverdue >= 30).length,
      criticalCount:    pending.filter(i => i.daysOverdue >= 60).length,
      pendingList:      pending.slice(0, 25),
      lastUpdated:      now.toISOString()
    };
  } catch (err) {
    console.error('[StelOrder] Error getSummary:', err.message);
    return { totalInvoices:0, totalBilled:0, totalBilledMonth:0,
             pendingInvoices:0, totalPending:0, overdueCount:0,
             criticalCount:0, pendingList:[], lastUpdated: new Date().toISOString() };
  }
}
 
module.exports = { getInvoices, getInvoiceReceipts, getPendingInvoices, getClients, getSummary, getAlertLevel };
 
