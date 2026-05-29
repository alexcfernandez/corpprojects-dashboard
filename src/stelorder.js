// src/stelorder.js — v4 campos reales confirmados
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
async function getInvoices() {
  try {
    const res = await client.get('/ordinaryInvoices?limit=500');
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    console.error('[StelOrder] Error getInvoices:', err.response?.status, err.message);
    return [];
  }
}
 
// ─── Recibos — TODOS (paginando si hace falta) ───────────────────
// Cada recibo tiene 'original-element-id' = ID de la factura
// y 'payment-date' si está cobrado
async function getAllReceipts() {
  try {
    // Intentamos traer hasta 500 — si hay más habría que paginar
    const res = await client.get('/ordinaryInvoiceReceipts?limit=500');
    const receipts = Array.isArray(res.data) ? res.data : [];
    console.log(`[StelOrder] Recibos obtenidos: ${receipts.length}`);
    return receipts;
  } catch (err) {
    console.error('[StelOrder] Error getAllReceipts:', err.response?.status, err.message);
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
 
    // Traer todo en paralelo
    const [invoices, receipts, clients] = await Promise.all([
      getInvoices(),
      getAllReceipts(),
      getClients()
    ]);
 
    console.log(`[StelOrder] Facturas: ${invoices.length} | Recibos: ${receipts.length} | Clientes: ${clients.length}`);
 
    // Mapa de clientes por ID para nombre rápido
    // El client en la factura referencia por account-path que contiene el ID
    const clientMap = {};
    clients.forEach(c => {
      clientMap[c.id] = c['commercial-name'] || c['fiscal-name'] || c.name || 'Cliente';
    });
 
    // Mapa de cobros por ID de factura
    // 'original-element-id' es el ID de la factura en string
    // Solo contamos como cobrado si tiene 'payment-date'
    const paidByInvoice = {};
    receipts.forEach(r => {
      const invoiceId = String(r['original-element-id'] || '');
      if (!invoiceId) return;
      const payDate = r['payment-date'];
      const amount  = parseFloat(r.amount || 0);
      if (payDate && amount > 0) {
        paidByInvoice[invoiceId] = (paidByInvoice[invoiceId] || 0) + amount;
      }
    });
 
    const pending = [];
 
    for (const inv of invoices) {
      const invId   = String(inv.id);
      const total   = parseFloat(inv['total-amount'] || inv.total || 0);
      if (total <= 0) continue;
 
      const paid          = paidByInvoice[invId] || 0;
      const pendingAmount = parseFloat((total - paid).toFixed(2));
      if (pendingAmount < 0.01) continue; // cobrada completamente
 
      // Extraer client-id del account-path: "app.stelorder.com/app/clients/12043668"
      const accountPath = inv['account-path'] || '';
      const clientIdMatch = accountPath.match(/\/clients\/(\d+)/);
      const clientId = clientIdMatch ? clientIdMatch[1] : null;
      const clientName = clientId ? (clientMap[parseInt(clientId)] || `Cliente ${clientId}`) : 'Cliente';
 
      const rawDate   = inv.date || inv['issue-date'];
      const issueDate = rawDate ? new Date(rawDate) : now;
      const daysOverdue = Math.max(0, Math.floor((now - issueDate) / 86400000));
 
      const number = inv.number || inv['invoice-number'] || inv['document-number'] || `#${invId}`;
 
      pending.push({
        id: invId, number, client: clientName,
        date: rawDate || now.toISOString(),
        dueDate: inv['due-date'] || null,
        total, paid, pending: pendingAmount,
        daysOverdue, alertLevel: getAlertLevel(daysOverdue)
      });
    }
 
    console.log(`[StelOrder] Pendientes reales: ${pending.length} de ${invoices.length} facturas`);
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
    const monthInv  = invoices.filter(i => {
      const d = new Date(i.date || i['issue-date'] || 0);
      return d.getMonth() === thisMonth && d.getFullYear() === thisYear;
    });
 
    const totalBilled      = invoices.reduce((s,i) => s + parseFloat(i['total-amount'] || i.total || 0), 0);
    const totalBilledMonth = monthInv.reduce((s,i)  => s + parseFloat(i['total-amount'] || i.total || 0), 0);
    const totalPending     = pending.reduce((s,i)   => s + i.pending, 0);
 
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
    return {
      totalInvoices:0, totalBilled:0, totalBilledMonth:0,
      pendingInvoices:0, totalPending:0, overdueCount:0,
      criticalCount:0, pendingList:[], lastUpdated: new Date().toISOString()
    };
  }
}
 
module.exports = { getInvoices, getAllReceipts, getPendingInvoices, getClients, getSummary, getAlertLevel };
