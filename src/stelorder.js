// src/stelorder.js — v15: familias + gastos banco + CACHÉ (TTL + dedup en vuelo)
const axios = require('axios');
const { cached, invalidate } = require('./cache');

// ─── TTL de caché por tipo de dato (ms). Configurable por entorno. ──────────
// Datos que cambian poco -> TTL largo. Datos de dinero -> TTL corto.
const MIN = 60 * 1000;
const TTL = {
  accountCategories: parseInt(process.env.STEL_TTL_FAMILIES  || 360) * MIN, // 6 h
  clients:           parseInt(process.env.STEL_TTL_CLIENTS   || 60)  * MIN, // 1 h
  receipts:          parseInt(process.env.STEL_TTL_RECEIPTS  || 10)  * MIN, // 10 min
  workEstimates:     parseInt(process.env.STEL_TTL_ESTIMATES || 15)  * MIN, // 15 min
  bankAccounts:      parseInt(process.env.STEL_TTL_BANK      || 360) * MIN, // 6 h
  documentStates:    parseInt(process.env.STEL_TTL_DOCSTATES || 360) * MIN, // 6 h
  workOrders:        parseInt(process.env.STEL_TTL_WORKORDERS || 10)  * MIN, // 10 min
  incidents:         parseInt(process.env.STEL_TTL_INCIDENTS  || 30)  * MIN, // 30 min
  incidentTypes:     parseInt(process.env.STEL_TTL_INCTYPES   || 360) * MIN, // 6 h
  purchases:         parseInt(process.env.STEL_TTL_PURCHASES  || 15)  * MIN, // 15 min
  suppliers:         parseInt(process.env.STEL_TTL_SUPPLIERS  || 60)  * MIN, // 1 h
  expenses:          parseInt(process.env.STEL_TTL_EXPENSES   || 15)  * MIN  // 15 min
};

const BASE_URL = 'https://app.stelorder.com/app';
const API_KEY  = process.env.STELORDER_API_KEY;

const client = axios.create({
  baseURL: BASE_URL,
  headers: { 'APIKEY': API_KEY, 'Accept': 'application/json', 'Content-Type': 'application/json; charset=utf-8' },
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

async function fetchAllPages(endpoint, extraParams = '') {
  const all = [];
  let start = 0;
  const limit = 500;
  while (true) {
    try {
      const sep = endpoint.includes('?') ? '&' : '?';
      // No añadir start=0 en la primera llamada — StelOrder no lo acepta
      const startParam = start > 0 ? `&start=${start}` : '';
      const url = `${endpoint}${sep}limit=${limit}${startParam}${extraParams}`;
      const res = await client.get(url);
      const page = Array.isArray(res.data) ? res.data : [];
      all.push(...page);
      if (page.length < limit) break;
      start += limit;
      await new Promise(r => setTimeout(r, 1100));
    } catch (err) {
      console.error(`[StelOrder] Error ${endpoint} start=${start}:`, err.response?.status, err.message);
      break;
    }
  }
  return all;
}

async function fetchEndpoint(endpoint) { return fetchAllPages(endpoint); }

function getClientName(obj) {
  return (obj['legal-name'] || obj['fiscal-name'] || obj['commercial-name'] ||
          obj['client-name'] || obj['contact-name'] || obj.name || '').trim();
}

function extractClientId(obj) {
  const path = obj['account-path'] || obj['client-path'] || '';
  const m = path.match(/\/(?:clients|accounts)\/(\d+)/);
  return m ? m[1] : null;
}

function buildClientMap(clients, familyMap) {
  const map = {};
  clients.forEach(c => {
    const name   = getClientName(c);
    const catId  = c['account-category-id'];
    const family = catId ? (familyMap[String(catId)] || 'Sin familia') : 'Sin familia';
    map[String(c.id)] = { name: name || 'Sin nombre', family, email: c.email || '', phone: c.phone || '' };
  });
  return map;
}

function resolveClient(item, clientMap) {
  const accId = String(item['account-id'] || '');
  if (accId && clientMap[accId]) return clientMap[accId];
  const cid = extractClientId(item);
  if (cid && clientMap[cid]) return clientMap[cid];
  const name = getClientName(item);
  return { name: name || 'Sin nombre', family: 'Sin familia', email: '', phone: '' };
}

// ─── Familias de clientes (accountCategories) ─────────────────────
async function _getAccountCategories() {
  try {
    const res = await client.get('/accountCategories?limit=500');
    const cats = Array.isArray(res.data) ? res.data : [];
    console.log(`[StelOrder] Familias/Categorías: ${cats.length}`);
    if (cats.length > 0) console.log('[StelOrder] Familias:', cats.map(c => `${c.id}:${c.name}`).join(' | '));
    const map = {};
    cats.forEach(c => { map[String(c.id)] = c.name || `Cat-${c.id}`; });
    return { list: cats, map };
  } catch (err) {
    console.error('[StelOrder] Error accountCategories:', err.message);
    return { list: [], map: {} };
  }
}
async function getAccountCategories() {
  return cached('accountCategories', TTL.accountCategories, _getAccountCategories);
}

async function _getClients() {
  const { list: cats, map: familyMap } = await getAccountCategories();
  const d = await fetchAllPages('/clients');
  console.log(`[StelOrder] Clientes: ${d.length}`);
  return { clients: d, clientMap: buildClientMap(d, familyMap), families: cats, familyMap };
}
async function getClients() {
  return cached('clients', TTL.clients, _getClients);
}

async function getWorkEstimates() {
  return cached('workEstimates', TTL.workEstimates, async () => {
    const d = await fetchAllPages('/workEstimates');
    console.log(`[StelOrder] WorkEstimates: ${d.length}`);
    return d;
  });
}
async function getBankAccounts()   { return cached('bankAccounts',   TTL.bankAccounts,   () => fetchEndpoint('/bankAccounts')); }
async function getDocumentStates() { return cached('documentStates', TTL.documentStates, () => fetchEndpoint('/documentStates')); }

async function getAllReceipts() {
  return cached('receipts', TTL.receipts, async () => {
    console.log('[StelOrder] Cargando recibos con paginación...');
    const all = await fetchAllPages('/ordinaryInvoiceReceipts', '&sort=original-element-id:desc');
    console.log(`[StelOrder] Total recibos: ${all.length}`);
    return all;
  });
}

// Construir facturas desde recibos agrupando por original-element-id
function buildInvoicesFromReceipts(receipts, clientMap) {
  const invoiceMap = new Map();
  receipts.forEach(r => {
    const invId = String(r['original-element-id'] || '');
    if (!invId || invId === '0') return;
    const amount = parseFloat(r.amount || 0);
    const isPaid = r.paid === true || r['payment-date'] != null;
    if (!invoiceMap.has(invId)) {
      const accId = String(r['account-id'] || '');
      const clientInfo = (accId && clientMap[accId]) ? clientMap[accId] : { name: 'Sin nombre', family: 'Sin familia' };
      invoiceMap.set(invId, {
        id: invId,
        number:      r['full-reference'] || `FAC #${invId}`,
        client:      clientInfo.name,
        family:      clientInfo.family,
        accountId:   accId,
        clientEmail: clientInfo.email || '',
        date:        r['payment-term-date'] || r['utc-last-modification-date'],
        totalAmount: 0,
        paidAmount:  0
      });
    }
    const inv = invoiceMap.get(invId);
    inv.totalAmount += amount;
    if (isPaid) inv.paidAmount += amount;
    const rDate = r['payment-term-date'];
    if (rDate && (!inv.date || rDate < inv.date)) inv.date = rDate;
  });
  return Array.from(invoiceMap.values());
}

// ─── Facturas pendientes con familia ─────────────────────────────
async function getPendingInvoices() {
  try {
    const now = new Date();
    const [receipts, { clientMap }] = await Promise.all([getAllReceipts(), getClients()]);
    const allInvoices = buildInvoicesFromReceipts(receipts, clientMap);
    const pending = [];

    for (const inv of allInvoices) {
      const pendingAmount = parseFloat((inv.totalAmount - inv.paidAmount).toFixed(2));
      if (pendingAmount < 0.01) continue;
      const issueDate   = inv.date ? new Date(inv.date) : now;
      const daysOverdue = Math.max(0, Math.floor((now - issueDate) / 86400000));
      pending.push({
        id: inv.id, number: inv.number, client: inv.client,
        family: inv.family, date: inv.date,
        accountId: inv.accountId, clientEmail: inv.clientEmail,
        total: inv.totalAmount, paid: inv.paidAmount, pending: pendingAmount,
        daysOverdue, alertLevel: getAlertLevel(daysOverdue)
      });
    }
    console.log(`[StelOrder] Pendientes: ${pending.length}/${allInvoices.length}`);
    return pending.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  } catch (err) {
    console.error('[StelOrder] Error getPendingInvoices:', err.message);
    return [];
  }
}

// ─── Estados WORKESTIMATE confirmados ─────────────────────────────
const WORK_ESTIMATE_STATES = {
  1120641: 'pending',
  1120642: 'rejected',
  1120656: 'accepted',
  1120650: 'closed'
};

// ─── Presupuestos SAT con familia ────────────────────────────────
async function getEstimatesSummary() {
  try {
    const [estimates, { clientMap, families }] = await Promise.all([getWorkEstimates(), getClients()]);
    const now = new Date();
    const avgMonthlyExpenses = 36000;
    const result = { total: estimates.length, accepted:[], pending:[], closed:[], rejected:[], all:[], families };

    estimates.forEach(est => {
      const stateId    = Number(est['document-state-id'] ?? 0);
      const stateKey   = WORK_ESTIMATE_STATES[stateId] || 'pending';
      const stateLabel = { pending:'Pendiente', accepted:'Aceptado', rejected:'Rechazado', closed:'Cerrado' }[stateKey];
      const total      = parseFloat(est['total-amount'] ?? est.total ?? 0);
      const rawDate    = est.date ?? est['issue-date'] ?? est['created-at'];
      const estDate    = rawDate ? new Date(rawDate) : now;
      const daysOld    = Math.floor((now - estDate) / 86400000);
      const clientInfo = resolveClient(est, clientMap);

      const item = {
        id: String(est.id), number: est.number ?? `#${est.id}`,
        ref: est['full-reference'] || est.reference || est.number || `#${est.id}`,
        client: clientInfo.name, family: clientInfo.family,
        date: rawDate, dueDate: est['due-date'] ?? est['expiry-date'],
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
    return { total:0, accepted:[], pending:[], closed:[], rejected:[], all:[], families:[],
             totalAccepted:0, totalPending:0, totalClosed:0, totalAll:0, monthsCovered:'0' };
  }
}

// ─── Resumen general ──────────────────────────────────────────────
async function getSummary() {
  try {
    const now = new Date();
    const thisMonth = now.getMonth(), thisYear = now.getFullYear();
    const [receipts, { clientMap }] = await Promise.all([getAllReceipts(), getClients()]);
    const allInvoices = buildInvoicesFromReceipts(receipts, clientMap);

    let totalBilled = 0, totalBilledMonth = 0, totalBilledMonthCount = 0;
    const pending = [];

    for (const inv of allInvoices) {
      const total = inv.totalAmount;
      if (total <= 0) continue;
      totalBilled += total;
      const issueDate = inv.date ? new Date(inv.date) : now;
      if (issueDate.getMonth() === thisMonth && issueDate.getFullYear() === thisYear) {
        totalBilledMonth += total; totalBilledMonthCount++;
      }
      const pendingAmount = parseFloat((total - inv.paidAmount).toFixed(2));
      if (pendingAmount < 0.01) continue;
      const daysOverdue = Math.max(0, Math.floor((now - issueDate) / 86400000));
      pending.push({
        id: inv.id, number: inv.number, client: inv.client,
        family: inv.family, date: inv.date,
        total, paid: inv.paidAmount, pending: pendingAmount,
        daysOverdue, alertLevel: getAlertLevel(daysOverdue)
      });
    }
    pending.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    return {
      totalInvoices: allInvoices.length, totalInvoicesMonth: totalBilledMonthCount,
      totalBilled, totalBilledMonth,
      pendingInvoices:  pending.length,
      totalPending:     pending.reduce((s,i) => s+i.pending, 0),
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

// Ruta de familias para el frontend
async function getFamiliesSummary() {
  try {
    const [receipts, { clientMap, families, familyMap }] = await Promise.all([getAllReceipts(), getClients()]);
    const allInvoices = buildInvoicesFromReceipts(receipts, clientMap);
    const now = new Date();

    // Agrupar por familia
    const byFamily = {};
    families.forEach(f => {
      byFamily[f.name] = { name: f.name, id: f.id, totalBilled: 0, totalPending: 0, invoiceCount: 0, pendingCount: 0 };
    });
    byFamily['Sin familia'] = { name: 'Sin familia', id: null, totalBilled: 0, totalPending: 0, invoiceCount: 0, pendingCount: 0 };

    allInvoices.forEach(inv => {
      const fam = inv.family || 'Sin familia';
      if (!byFamily[fam]) byFamily[fam] = { name: fam, totalBilled: 0, totalPending: 0, invoiceCount: 0, pendingCount: 0 };
      byFamily[fam].totalBilled   += inv.totalAmount;
      byFamily[fam].invoiceCount  += 1;
      const pend = inv.totalAmount - inv.paidAmount;
      if (pend > 0.01) { byFamily[fam].totalPending += pend; byFamily[fam].pendingCount += 1; }
    });

    return Object.values(byFamily).filter(f => f.invoiceCount > 0).sort((a,b) => b.totalBilled - a.totalBilled);
  } catch (err) {
    console.error('[StelOrder] Error getFamiliesSummary:', err.message);
    return [];
  }
}

async function getInvoices() {
  const [receipts, { clientMap }] = await Promise.all([getAllReceipts(), getClients()]);
  return buildInvoicesFromReceipts(receipts, clientMap);
}

// Pide a StelOrder que ENVÍE la factura oficial (su PDF) por email al destinatario indicado.
// Usa PUT /sendDocument/{ID} con body { email }. Devuelve { ok, status } o lanza error.
async function sendInvoiceByEmail(invoiceId, email) {
  if (!invoiceId) throw new Error('Falta el ID de la factura');
  if (!email)     throw new Error('Falta el email de destino');
  // sendDocument es lento (>25s). Le damos 60s solo a esta llamada.
  const res = await client.put(`/sendDocument/${invoiceId}`, { email }, { timeout: 60000 });
  console.log('[sendDocument] respuesta StelOrder:', res.status, JSON.stringify(res.data));
  return { ok: true, status: res.status, data: res.data };
}

// DEBUG: devuelve el objeto completo de una factura ordinaria (para inspeccionar campos,
// p.ej. si hay alguna URL/token del documento). GET /ordinaryInvoices/{id}
async function getInvoiceRaw(invoiceId) {
  if (!invoiceId) throw new Error('Falta el ID de la factura');
  const res = await client.get(`/ordinaryInvoices/${invoiceId}`);
  return res.data;
}

// Devuelve el enlace público al PDF de una factura (campo pdf-path de StelOrder).
// Es estable (no caduca), así que lo cacheamos con TTL largo: 1 llamada por factura y a correr.
const PDF_TTL = parseInt(process.env.STEL_TTL_PDFPATH || 10080) * MIN; // 7 días

// Throttle anti-pico: separa las llamadas REALES a StelOrder para PDFs ~1.1s
// (StelOrder limita a 60/min). Solo afecta a llamadas reales; las cacheadas no esperan.
let _lastDocFetch = 0;
const PDF_GAP_MS = parseInt(process.env.STEL_PDF_GAP_MS || 1100);
async function _throttleDoc() {
  const now = Date.now();
  const wait = Math.max(0, _lastDocFetch + PDF_GAP_MS - now);
  if (wait) await new Promise(r => setTimeout(r, wait));
  _lastDocFetch = Date.now();
}

async function getInvoicePdfPath(invoiceId) {
  if (!invoiceId) return null;
  return cached(`pdfPath:${invoiceId}`, PDF_TTL, async () => {
    try {
      await _throttleDoc();   // solo se ejecuta en llamada real (cache miss)
      const res = await client.get(`/ordinaryInvoices/${invoiceId}`);
      const inv = Array.isArray(res.data) ? res.data[0] : res.data;
      return (inv && inv['pdf-path']) ? inv['pdf-path'] : null;
    } catch (err) {
      console.error('[pdfPath] error factura', invoiceId, err.response?.status, err.message);
      return null;
    }
  });
}

// ── PEDIDOS DE TRABAJO (Fase 1: ver y vigilar) ───────────────────────────
// Nivel de alerta de un pedido según días abiertos y tipo de incidencia.
// Actuación (urgente) avisa antes; Presupuesto tiene más margen.
function getWorkOrderAlertLevel(days, typeName) {
  const isActuacion = /actuaci/i.test(typeName || '');
  const amber = isActuacion
    ? parseInt(process.env.WO_ACT_AMBER || 2)
    : parseInt(process.env.WO_PRE_AMBER || 8);
  const red = isActuacion
    ? parseInt(process.env.WO_ACT_RED || 3)
    : parseInt(process.env.WO_PRE_RED || 15);
  if (days >= red)   return { level: 'red',   color: '#dc2626', label: 'Crítico' };
  if (days >= amber) return { level: 'amber', color: '#f97316', label: 'Atención' };
  return { level: 'green', color: '#16a34a', label: 'En plazo' };
}

// Mapa estado-de-documento (solo WORKORDER): id -> nombre
async function getWorkOrderStateMap() {
  const states = await getDocumentStates();
  const map = {};
  (Array.isArray(states) ? states : []).forEach(s => {
    if (s.type === 'WORKORDER') map[String(s.id)] = s.name;
  });
  return map;
}

// Lista COMPLETA de pedidos (incluye cerrados). Para el log de actividad.
async function getAllWorkOrders() {
  return cached('workOrders', TTL.workOrders, () => fetchAllPages('/workOrders'));
}

// Mapa empleado/técnico: id -> nombre (defensivo ante distintos nombres de campo).
async function getEmployeeMap() {
  const list = await cached('employees', 360 * MIN, () => fetchAllPages('/employees'));
  const map = {};
  (Array.isArray(list) ? list : []).forEach(e => {
    const nombre = e.name
      || [e['first-name'], e['last-name']].filter(Boolean).join(' ').trim()
      || e['full-name'] || e.email || ('#' + e.id);
    map[String(e.id)] = nombre;
  });
  return map;
}

// Mapa incidencia -> tipo (para heredar Actuación/Presupuesto en el pedido)
async function getIncidentTypeMaps() {
  const [incidents, types] = await Promise.all([
    cached('incidents',     TTL.incidents,     () => fetchAllPages('/incidents')),
    cached('incidentTypes', TTL.incidentTypes, () => fetchAllPages('/incidentTypes'))
  ]);
  const typeName = {};
  (Array.isArray(types) ? types : []).forEach(t => { typeName[String(t.id)] = t.name; });
  const incToType = {};
  (Array.isArray(incidents) ? incidents : []).forEach(i => {
    incToType[String(i.id)] = typeName[String(i['incident-type-id'])] || 'Sin tipo';
  });
  return { incToType, typeName };
}

// Lista completa de incidencias (para el log de actividad).
async function getAllIncidents() {
  return cached('incidents', TTL.incidents, () => fetchAllPages('/incidents'));
}

// Mapa estado de incidencia: id -> nombre.
async function getIncidentStateMap() {
  const states = await cached('incidentStates', TTL.incidentTypes, () => fetchAllPages('/incidentStates'));
  const map = {};
  (Array.isArray(states) ? states : []).forEach(s => { map[String(s.id)] = s.name; });
  return map;
}

function daysSince(dateStr) {
  if (!dateStr) return 0;
  const d = new Date(dateStr);
  if (isNaN(d)) return 0;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
}

// Devuelve los pedidos de trabajo "vivos" (Pendiente o En curso) con días, tipo,
// cliente y nivel de alerta. NO escribe nada en StelOrder.
async function getWorkOrdersLive() {
  const [orders, stateMap, { incToType }, { clientMap }] = await Promise.all([
    cached('workOrders', TTL.workOrders, () => fetchAllPages('/workOrders')),
    getWorkOrderStateMap(),
    getIncidentTypeMaps(),
    getClients()
  ]);

  const live = [];
  (Array.isArray(orders) ? orders : []).forEach(o => {
    if (o.deleted) return;
    const stateName = stateMap[String(o['document-state-id'])] || '';
    // Vivos = Pendiente o En curso. Fuera: Cerrado, Rechazado.
    if (!/pendiente|en curso/i.test(stateName)) return;

    const accId = String(o['account-id'] || '');
    const cli   = clientMap[accId] || { name: 'Sin nombre', family: 'Sin familia' };
    const incId = String(o['parent-incident-id'] || '');
    const typeName = incId ? (incToType[incId] || 'Sin tipo') : 'Sin tipo';
    const startRef = o['assigned-date'] || o['creation-date'] || o.date;
    const days = daysSince(startRef);
    const alert = getWorkOrderAlertLevel(days, typeName);

    // Descripción del trabajo (lo que pidió el cliente): nombre + detalle de las líneas
    const lines = Array.isArray(o.lines) ? o.lines.filter(l => !l.deleted) : [];
    const description = lines
      .map(l => [l['item-name'], l['item-description']].filter(Boolean).join(' — '))
      .filter(Boolean).join('\n') || (o['private-comments'] || '');

    live.push({
      id:          o.id,
      number:      o['full-reference'] || `PDT #${o.id}`,
      client:      cli.name,
      family:      cli.family,
      type:        typeName,
      state:       stateName,
      days,
      since:       startRef,
      description,
      incidentId:  incId || null,
      pdfPath:     o['pdf-path'] || null,
      alertLevel:  alert.level,
      alertColor:  alert.color,
      alertLabel:  alert.label
    });
  });

  // Más urgentes primero (rojo, luego ámbar, luego verde; y dentro, más días arriba)
  const rank = { red: 0, amber: 1, green: 2 };
  live.sort((a, b) => (rank[a.alertLevel] - rank[b.alertLevel]) || (b.days - a.days));
  return live;
}


// (FAC..., INC..., PDT...) o una lista de catálogo por palabra clave
// (ESTADOS-INC, TIPOS-INC, ESTADOS-DOC) para inspeccionar campos y relaciones.
async function getEntityRawByRef(ref) {
  const r = String(ref || '').trim().toUpperCase();

  // Catálogos completos (diccionarios de estados/tipos)
  if (r === 'ESTADOS-INC') return await fetchAllPages('/incidentStates');
  if (r === 'TIPOS-INC')   return await fetchAllPages('/incidentTypes');
  if (r === 'ESTADOS-DOC') return await fetchAllPages('/documentStates');
  if (r === 'EMPLEADOS')   return await fetchAllPages('/employees');

  let endpoint;
  if      (r.startsWith('FAC')) endpoint = '/ordinaryInvoices';
  else if (r.startsWith('INC')) endpoint = '/incidents';
  else if (r.startsWith('PDT')) endpoint = '/workOrders';
  else throw new Error('Referencia no reconocida. Usa FAC.../INC.../PDT... o ESTADOS-INC, TIPOS-INC, ESTADOS-DOC');
  const list = await fetchAllPages(endpoint);
  const numPart = r.replace(/^[A-Z]+/, '');  // "00560"
  const found = list.find(x => String(x['full-reference'] || '').toUpperCase() === r)
             || list.find(x => String(x['reference'] || '').toUpperCase() === numPart);
  if (!found) return { notFound: true, endpoint, total: list.length };
  return found;
}

// ── SONDA (solo lectura): descubrir el campo de IMPUESTO de una línea ──
// Lee presupuestos reales y vuelca, de una línea ITEM, las claves y cualquier
// campo que huela a impuesto (tax/vat/iva), con su valor. Para saber cómo se
// llama el campo del IVA y a qué corresponde 21/10/0 ANTES de escribirlo.
async function diagLineaImpuesto() {
  const list = await fetchAllPages('/workEstimates');
  const out = { totalPresupuestos: list.length, traeLineasEnListado: false, ejemplos: [], clavesPresupuesto: null };
  if (list.length) out.clavesPresupuesto = Object.keys(list[0]);
  let n = 0;
  for (const est of list) {
    const lines = est.lines || est.items || est['document-lines'] || [];
    if (!Array.isArray(lines) || !lines.length) continue;
    out.traeLineasEnListado = true;
    const linea = lines.find(l => String(l['line-type'] || '').toUpperCase() === 'ITEM') || lines[0];
    out.ejemplos.push({
      ref: est['full-reference'] || est.reference || ('#' + est.id),
      estadoId: est['document-state-id'],
      clavesDeLinea: Object.keys(linea),
      camposImpuesto: Object.fromEntries(Object.entries(linea).filter(([k]) => /tax|vat|iva|impue/i.test(k))),
      lineaCompleta: linea
    });
    if (++n >= 4) break;
  }
  return out;
}

// ── SONDA (solo lectura): volcar el CATÁLOGO DE IMPUESTOS con su id y % ──
// La línea apunta a taxLines/{id}; probamos ese endpoint (y /taxes por si acaso)
// para mapear 21% / 10% / 0% a su primary-tax-id, necesario al escribir el IVA.
async function diagImpuestos() {
  const out = {};
  for (const ep of ['/taxLines', '/taxes']) {
    try {
      const list = await fetchAllPages(ep);
      out[ep] = (list || []).map(t => ({
        id: t.id,
        percentage: t.percentage ?? t['tax-percentage'] ?? t.value ?? t.rate ?? null,
        name: t.name ?? t['tax-name'] ?? t.description ?? null,
        deleted: t.deleted ?? null,
        claves: Object.keys(t)
      }));
    } catch (e) {
      out[ep] = { error: `${e.response?.status || ''} ${e.message}`.trim() };
    }
  }
  return out;
}

// Resuelve el ID interno de una factura a partir de su número (ej. "FAC00791").
async function findInvoiceIdByNumber(number) {
  const invoices = await getInvoices();
  const norm = String(number || '').trim().toLowerCase();
  const found = invoices.find(i => String(i.number || '').trim().toLowerCase() === norm);
  return found ? found.id : null;
}

// Vaciar la caché de StelOrder (para un botón "Actualizar ahora" en el dashboard)
function clearCache() { invalidate(); }

// ── FASE 4: ESCRIBIR ESTADO DE UN PEDIDO EN STELORDER (con red de seguridad) ──
// Patrón: LEER → COPIA DE SEGURIDAD en Mongo → PUT solo del estado → RELEER →
// COMPARAR campos clave. Si algo más cambió, lo reporta. Todo queda en stelWriteLog.
// Nota: la API de StelOrder no permite GET /workOrders/{id} individual, así que
// leemos la lista completa y filtramos (mismo método probado que la herramienta raw).

async function _findWorkOrderRaw(idOrRef) {
  const list = await fetchAllPages('/workOrders');
  const s = String(idOrRef || '').trim().toUpperCase();
  if (s.startsWith('PDT')) {
    return list.find(x => String(x['full-reference'] || '').toUpperCase() === s) || null;
  }
  return list.find(x => String(x.id) === s) || null;
}

async function setWorkOrderState(workOrderId, stateId, requestedBy) {
  if (!workOrderId || !stateId) throw new Error('Faltan datos (pedido o estado)');

  // 1) Leer el pedido completo ANTES (de la lista, sin caché)
  const before = await _findWorkOrderRaw(workOrderId);
  if (!before || !before.id) throw new Error(`No se encontró el pedido "${workOrderId}" en StelOrder (prueba con el ID numérico o la referencia PDT)`);
  const id = String(before.id);

  // 2) Copia de seguridad en nuestra base de datos
  const db = await require('./db').getDB();
  const logDoc = {
    workOrderId: id,
    reference: before['full-reference'] || null,
    requestedState: stateId,
    requestedBy: requestedBy || null,
    before,
    at: new Date(),
    result: 'pending'
  };
  const ins = await db.collection('stelWriteLog').insertOne(logDoc);

  // 3) Escribir SOLO el estado
  let putStatus = null;
  try {
    const putRes = await client.put(`/workOrders/${id}`, { 'document-state-id': Number(stateId) },
      { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    putStatus = putRes.status;
  } catch (err) {
    await db.collection('stelWriteLog').updateOne({ _id: ins.insertedId },
      { $set: { result: 'error', error: `${err.response?.status || ''} ${err.message}`, errorBody: err.response?.data || null } });
    throw new Error(`StelOrder rechazó la escritura: ${err.response?.status || ''} ${err.message}`);
  }

  // 4) Releer (de la lista de nuevo) y 5) comparar campos clave
  await new Promise(r => setTimeout(r, 1200));   // respiro para la API
  const after = (await _findWorkOrderRaw(id)) || {};
  const linesBefore = (before.lines || []).filter(l => !l.deleted).length;
  const linesAfter  = (after.lines  || []).filter(l => !l.deleted).length;
  const checks = {
    estadoCambiado:  Number(after['document-state-id']) === Number(stateId),
    estadoAntes:     before['document-state-id'],
    estadoDespues:   after['document-state-id'],
    lineasAntes:     linesBefore,
    lineasDespues:   linesAfter,
    lineasIntactas:  linesBefore === linesAfter,
    clienteIntacto:  String(before['account-id']) === String(after['account-id']),
    referenciaIntacta: before['full-reference'] === after['full-reference'],
    totalAntes:      before['total'] ?? before['total-amount'] ?? null,
    totalDespues:    after['total']  ?? after['total-amount']  ?? null
  };
  checks.todoOk = checks.estadoCambiado && checks.lineasIntactas && checks.clienteIntacto && checks.referenciaIntacta;

  await db.collection('stelWriteLog').updateOne({ _id: ins.insertedId },
    { $set: { result: checks.todoOk ? 'ok' : 'review', putStatus, after, checks } });

  // Invalidar caché de pedidos para que el dashboard refleje el cambio
  try { invalidate('workOrders'); } catch (e) { try { invalidate(); } catch (e2) {} }

  return { putStatus, checks };
}

// Versión LIGERA para automatismos: PUT directo (seguridad ya demostrada en las
// pruebas manuales) + registro en stelWriteLog. Sin verificación pesada.
async function setWorkOrderStateLight(workOrderId, stateId, trigger) {
  const id = String(workOrderId);
  const db = await require('./db').getDB();
  try {
    const putRes = await client.put(`/workOrders/${id}`, { 'document-state-id': Number(stateId) },
      { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    await db.collection('stelWriteLog').insertOne({
      workOrderId: id, requestedState: Number(stateId), trigger: trigger || 'auto',
      mode: 'light', putStatus: putRes.status, result: 'ok', at: new Date()
    });
    try { invalidate('workOrders'); } catch (e) {}
    return { ok: true, putStatus: putRes.status };
  } catch (err) {
    await db.collection('stelWriteLog').insertOne({
      workOrderId: id, requestedState: Number(stateId), trigger: trigger || 'auto',
      mode: 'light', result: 'error', error: `${err.response?.status || ''} ${err.message}`, at: new Date()
    });
    return { ok: false, error: err.message };
  }
}

// Serie de facturación de los últimos N meses (para la gráfica de Inicio).
async function getMonthlyBilling(months = 6) {
  const MESES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  try {
    const [receipts, { clientMap }] = await Promise.all([getAllReceipts(), getClients()]);
    const allInvoices = buildInvoicesFromReceipts(receipts, clientMap);
    const now = new Date();
    const buckets = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      buckets.push({ year: d.getFullYear(), month: d.getMonth(),
        label: MESES[d.getMonth()], total: 0, count: 0 });
    }
    for (const inv of allInvoices) {
      if (!inv || inv.totalAmount <= 0 || !inv.date) continue;
      const d = new Date(inv.date);
      if (isNaN(d)) continue;
      const b = buckets.find(x => x.year === d.getFullYear() && x.month === d.getMonth());
      if (b) { b.total += inv.totalAmount; b.count++; }
    }
    return buckets.map(b => ({ label: b.label, total: parseFloat(b.total.toFixed(2)), count: b.count }));
  } catch (err) {
    console.error('[StelOrder] Error getMonthlyBilling:', err.message);
    throw err;
  }
}

// ── COMPRAS: proveedores, facturas de proveedor y gastos ──────────────────
async function getSuppliers() {
  return cached('suppliers', TTL.suppliers, async () => {
    const raw = await fetchAllPages('/suppliers');
    const supplierMap = {};
    const suppliers = (raw || []).filter(x => !x.deleted).map(x => {
      const name = (x['legal-name'] && x['legal-name'] !== 'null') ? x['legal-name']
                 : (x.name && x.name !== 'null') ? x.name
                 : (x['full-reference'] || `Proveedor ${x.id}`);
      supplierMap[String(x.id)] = { name, ref: x['full-reference'] || '' };
      return { id: String(x.id), name, ref: x['full-reference'] || '', email: x.email && x.email !== 'null' ? x.email : '' };
    });
    console.log(`[StelOrder] Suppliers: ${suppliers.length}`);
    return { suppliers, supplierMap };
  });
}

async function getPurchaseInvoices() {
  return cached('purchases', TTL.purchases, async () => {
    const [raw, { supplierMap }] = await Promise.all([fetchAllPages('/purchaseInvoices'), getSuppliers()]);
    const list = (raw || []).filter(x => !x.deleted).map(x => {
      const sup = supplierMap[String(x['account-id'] || '')] || {};
      const total = Number(x['total-amount']) || 0;
      const pending = Number(x['remaining-total-amount']);
      return {
        id: String(x.id),
        number: x['full-reference'] || `FPR #${x.id}`,
        supplierId: String(x['account-id'] || ''),
        supplier: sup.name || '—',
        title: (x.title && x.title !== 'null') ? x.title : '',
        total,
        paid: Number(x['paid-total-amount']) || 0,
        pending: Number.isFinite(pending) ? pending : total,
        date: x.date || x['creation-date'] || '',
        settled: x.settled === true || String(x.settled) === 'true',
        lines: Array.isArray(x.lines) ? x.lines : []
      };
    });
    console.log(`[StelOrder] PurchaseInvoices: ${list.length}`);
    return list;
  });
}

async function getExpenses() {
  return cached('expenses', TTL.expenses, async () => {
    const [raw, { supplierMap }] = await Promise.all([fetchAllPages('/expenses'), getSuppliers()]);
    const list = (raw || []).filter(x => !x.deleted).map(x => {
      const sup = supplierMap[String(x['account-id'] || '')] || {};
      return {
        id: String(x.id),
        number: x['full-reference'] || `GAS #${x.id}`,
        supplierId: String(x['account-id'] || ''),
        supplier: sup.name || '—',
        amount: Number(x.amount) || 0,
        date: x.date || '',
        description: (x.description && x.description !== 'null') ? x.description : '',
        categoryId: String(x['expense-category-id'] || '')
      };
    });
    console.log(`[StelOrder] Expenses: ${list.length}`);
    return list;
  });
}

// ── DIAGNÓSTICO: muestra los campos reales de los endpoints de compras ──
// Endpoints confirmados en la doc oficial de la API. Devuelve, por cada uno,
// si responde, cuántos registros y los CAMPOS del primer registro (sin volcar
// datos). Para purchaseInvoices/suppliers incluye un ejemplo de valores no
// sensibles para entender el formato.
async function diagProveedores() {
  const candidatos = [
    '/purchaseInvoices', '/purchaseInvoiceReceipts', '/suppliers',
    '/purchaseOrders', '/purchaseDeliveryNotes', '/expenses', '/expensesAndInvestments'
  ];
  const out = [];
  for (const ep of candidatos) {
    try {
      const res = await client.get(`${ep}?limit=1`);
      const data = res.data;
      const arrData = Array.isArray(data) ? data : null;
      const first = arrData && arrData[0] ? arrData[0] : null;
      out.push({
        endpoint: ep,
        status: res.status,
        registros: arrData ? arrData.length : null,
        campos: first ? Object.keys(first) : (arrData ? '(array vacío)' : typeof data),
        // muestra acotada de valores para ver formatos (recortada)
        ejemplo: first ? Object.fromEntries(Object.entries(first).slice(0, 60).map(([k, v]) => {
          const s = (v && typeof v === 'object') ? (Array.isArray(v) ? `[array ${v.length}]` : '{obj}') : String(v);
          return [k, s.length > 60 ? s.slice(0, 60) + '…' : s];
        })) : null
      });
    } catch (e) {
      out.push({ endpoint: ep, status: e.response?.status || 'ERROR', error: (e.response?.data ? JSON.stringify(e.response.data).slice(0, 150) : e.message) });
    }
    await new Promise(r => setTimeout(r, 350));
  }
  return out;
}

// ── DIAGNÓSTICO DE ESCRITURA (Paso 0, SIN RIESGO) ──────────────────────────
// Averigua qué permite la API sin crear nada real:
//  1) Lee catálogos (estados/tipos de incidencia y de documento) → opciones para clasificar/cambiar estado.
//  2) Lee un documento real de cada tipo → qué campos trae (lo que pediría un CREATE).
//  3) (opcional, probe=1) Sondea POST con cuerpo VACÍO: 404=no existe · 400/422=existe y pide datos · 405=no permitido.
async function diagEscritura({ probePost = false } = {}) {
  const out = { ts: new Date().toISOString(), catalogos: {}, muestras: {}, endpoints: {}, nota: '' };
  const campos = (obj) => (obj && typeof obj === 'object') ? Object.keys(obj).filter(k => k !== 'lines').sort() : null;

  // 1) Catálogos (solo lectura)
  try {
    const [incStates, incTypes, docStates] = await Promise.all([
      fetchAllPages('/incidentStates'),
      fetchAllPages('/incidentTypes'),
      fetchAllPages('/documentStates')
    ]);
    out.catalogos.incidentStates = (incStates || []).map(s => ({ id: s.id, name: s.name }));
    out.catalogos.incidentTypes  = (incTypes  || []).map(s => ({ id: s.id, name: s.name }));
    out.catalogos.documentStates = (docStates || []).map(s => ({ id: s.id, name: s.name, type: s['document-type'] || s.type || null }));
  } catch (e) { out.catalogos.error = e.message; }

  // 2) Muestras reales (solo lectura): campos disponibles por tipo
  try {
    const ests = await getWorkEstimates();
    const e0 = (ests || []).find(x => !x.deleted) || null;
    out.muestras.presupuesto = e0
      ? { ref: e0['full-reference'] || null, campos: campos(e0), tieneLineas: Array.isArray(e0.lines), camposLinea: (e0.lines && e0.lines[0]) ? Object.keys(e0.lines[0]).sort() : null }
      : 'sin datos';
  } catch (e) { out.muestras.presupuestoError = e.message; }
  try {
    const incs = await getAllIncidents();
    const i0 = (incs || []).find(x => !x.deleted) || null;
    out.muestras.incidencia = i0 ? { ref: i0['full-reference'] || null, campos: campos(i0) } : 'sin datos';
  } catch (e) { out.muestras.incidenciaError = e.message; }
  try {
    const ords = await getAllWorkOrders();
    const o0 = (ords || []).find(x => !x.deleted) || null;
    out.muestras.pedido = o0
      ? { ref: o0['full-reference'] || null, campos: campos(o0), camposLinea: (o0.lines && o0.lines[0]) ? Object.keys(o0.lines[0]).sort() : null }
      : 'sin datos';
  } catch (e) { out.muestras.pedidoError = e.message; }

  // 3) Sondas POST (cuerpo vacío → no crea datos reales)
  if (probePost) {
    for (const ep of ['/incidents', '/workEstimates', '/workOrders', '/ordinaryInvoices']) {
      try {
        const r = await client.post(ep, {}, { headers: { 'Content-Type': 'application/json; charset=utf-8' }, timeout: 20000 });
        out.endpoints[ep] = { status: r.status, veredicto: '⚠️ CREO_ALGO_REVISAR', body: JSON.stringify(r.data).slice(0, 300) };
      } catch (err) {
        const st = err.response?.status;
        let veredicto = 'otro';
        if (st === 404) veredicto = 'NO_EXISTE';
        else if (st === 400 || st === 422) veredicto = 'EXISTE_pide_datos';
        else if (st === 405) veredicto = 'METODO_NO_PERMITIDO';
        else if (st === 401 || st === 403) veredicto = 'AUTH';
        out.endpoints[ep] = { status: st || null, veredicto, body: err.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : err.message };
      }
      await new Promise(r => setTimeout(r, 1200));
    }
    out.nota = 'Sondas POST con cuerpo vacío. Si alguna dice CREO_ALGO_REVISAR, revisa ese endpoint en StelOrder por si quedó un registro vacío.';
  } else {
    out.nota = 'Modo solo-lectura. Añade ?probe=1 para sondear si POST está permitido (cuerpo vacío, no crea datos reales).';
  }
  return out;
}

// ── VERIFICACIÓN: ¿la API crea y respeta parent-incident-id? (Paso 1, prueba que TÚ borras) ──
// Crea una incidencia de PRUEBA + un pedido enlazado a ella, y comprueba si el vínculo
// "generado a partir de" se mantiene. Devuelve los IDs para que los borres en StelOrder.
async function diagCrearEnlace({ accId = null, go = false } = {}) {
  const out = { ts: new Date().toISOString(), pasos: {}, aBorrar: [], veredicto: '', nota: '' };
  if (!go) {
    out.nota = 'Simulación. Añade ?go=1 para crear de verdad una incidencia y un pedido de PRUEBA (los borras tú luego).';
    return out;
  }

  // 0) Resolver un account-id real (el que pidas, o "Mela Mutermilch", o el primero)
  try {
    const { clientMap } = await getClients();
    if (!accId) {
      const entradas = Object.entries(clientMap || {});
      const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const mela = entradas.find(([id, c]) => norm(c.name).includes('mela mutermilch'));
      accId = mela ? mela[0] : (entradas[0] ? entradas[0][0] : null);
    }
    out.pasos.cliente = { accId, nombre: (clientMap[String(accId)] || {}).name || null };
  } catch (e) { out.pasos.clienteError = e.message; return out; }
  if (!accId) { out.veredicto = 'NO_HAY_CLIENTE'; return out; }

  const H = { headers: { 'Content-Type': 'application/json; charset=utf-8' }, timeout: 25000 };
  const extraerId = (data) => {
    const d = Array.isArray(data) ? data[0] : data;
    return d && (d.id || d['id']) ? String(d.id || d['id']) : null;
  };

  // 1) Crear incidencia de PRUEBA
  let incId = null;
  try {
    const body = {
      'account-id': Number(accId),
      description: 'PRUEBA API - BORRAR. Verificación de creación por API.',
      'incident-type-id': 3146,    // Actuación
      'incident-state-id': 1120644 // Pendiente
    };
    const r = await client.post('/incidents', body, H);
    incId = extraerId(r.data);
    out.pasos.incidencia = { status: r.status, id: incId, body: JSON.stringify(r.data).slice(0, 400) };
    if (incId) out.aBorrar.push(`Incidencia id ${incId}`);
  } catch (err) {
    out.pasos.incidencia = { status: err.response?.status, error: err.response?.data ? JSON.stringify(err.response.data).slice(0, 400) : err.message };
    out.veredicto = 'FALLO_AL_CREAR_INCIDENCIA';
    return out;
  }

  await new Promise(r => setTimeout(r, 1200));

  // 2) Crear pedido de trabajo enlazado a esa incidencia
  let pdtId = null;
  try {
    const body = {
      'account-id': Number(accId),
      'document-state-id': 1120651, // Pendiente (WORKORDER)
      title: 'PRUEBA API - BORRAR'
    };
    if (incId) body['parent-incident-id'] = Number(incId);
    const r = await client.post('/workOrders', body, H);
    pdtId = extraerId(r.data);
    out.pasos.pedido = { status: r.status, id: pdtId, body: JSON.stringify(r.data).slice(0, 400) };
    if (pdtId) out.aBorrar.push(`Pedido de trabajo id ${pdtId}`);
  } catch (err) {
    out.pasos.pedido = { status: err.response?.status, error: err.response?.data ? JSON.stringify(err.response.data).slice(0, 400) : err.message };
    out.veredicto = 'FALLO_AL_CREAR_PEDIDO';
    return out;
  }

  await new Promise(r => setTimeout(r, 1500));

  // 3) Releer el pedido y comprobar si el vínculo parent-incident-id se mantuvo
  try {
    const orders = await fetchAllPages('/workOrders');
    const o = (orders || []).find(x => String(x.id) === String(pdtId));
    if (o) {
      const linked = String(o['parent-incident-id'] || '') === String(incId);
      out.pasos.verificacion = {
        pedidoRef: o['full-reference'] || null,
        parentIncidentId: o['parent-incident-id'] || null,
        vinculoCorrecto: linked,
        clienteOk: String(o['account-id']) === String(accId)
      };
      out.veredicto = linked ? '✅ VINCULO_OK_PODEMOS_REPLICAR_GENERAR' : '⚠️ CREA_PERO_SIN_VINCULO_NATIVO';
    } else {
      out.pasos.verificacion = { aviso: 'No encontré el pedido recién creado en la lista (puede tardar en indexar).' };
      out.veredicto = 'CREADO_PERO_NO_RELEIDO';
    }
  } catch (e) { out.pasos.verificacionError = e.message; }

  out.nota = '⚠️ BORRA estos documentos de prueba en StelOrder (SAT → Incidencias y Pedidos de trabajo): ' + out.aBorrar.join(' · ');
  return out;
}

// ── SONDA: ¿acepta líneas LIBRES (sin producto de catálogo)? (prueba que TÚ borras) ──
// Intenta crear pedidos de PRUEBA con la línea escrita de varias formas, para ver
// cuál acepta StelOrder sin exigir item-id. Para en cuanto una funcione.
async function diagLineaLibre({ accId = null, go = false } = {}) {
  const out = { ts: new Date().toISOString(), cliente: {}, intentos: [], ganador: null, aBorrar: [], nota: '' };
  if (!go) { out.nota = 'Simulación. Añade ?go=1 para crear pedidos de PRUEBA (los borras tú).'; return out; }

  try {
    const { clientMap } = await getClients();
    if (!accId) {
      const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const entradas = Object.entries(clientMap || {});
      const mela = entradas.find(([id, c]) => norm(c.name).includes('mela mutermilch'));
      accId = mela ? mela[0] : (entradas[0] ? entradas[0][0] : null);
    }
    out.cliente = { accId, nombre: (clientMap[String(accId)] || {}).name || null };
  } catch (e) { out.cliente = { error: e.message }; return out; }
  if (!accId) { out.nota = 'No hay cliente.'; return out; }

  const H = { headers: { 'Content-Type': 'application/json; charset=utf-8' }, timeout: 25000 };
  const extraerId = (data) => { const d = Array.isArray(data) ? data[0] : data; return d && (d.id) ? String(d.id) : null; };
  const TXT = 'PRUEBA API - BORRAR: reparación baldosas sueltas fachada';

  // Distintas formas de escribir una línea libre (sin item-id)
  const variantes = [
    { etq: 'A: line-type TEXT', linea: { 'line-type': 'TEXT', 'item-description': TXT, units: 1 } },
    { etq: 'B: line-type COMMENT', linea: { 'line-type': 'COMMENT', 'item-description': TXT } },
    { etq: 'C: item-name + units sin tipo', linea: { 'item-name': TXT, 'item-description': TXT, units: 1, 'item-base-price': 0 } },
    { etq: 'D: line-type ITEM sin item-id', linea: { 'line-type': 'ITEM', 'item-name': TXT, units: 1, 'item-base-price': 0 } },
    { etq: 'E: line-type FREE', linea: { 'line-type': 'FREE', 'item-description': TXT, units: 1, 'item-base-price': 100 } }
  ];

  for (const v of variantes) {
    const body = { 'account-id': Number(accId), 'document-state-id': 1120651, title: 'PRUEBA API - BORRAR', lines: [v.linea] };
    try {
      const r = await client.post('/workOrders', body, H);
      const id = extraerId(r.data);
      out.intentos.push({ variante: v.etq, status: r.status, ok: true, id });
      if (id) { out.aBorrar.push(`Pedido id ${id}`); out.ganador = v.etq; break; }
    } catch (err) {
      const code = err.response?.data?.[0]?.['error-code'] || err.response?.status;
      out.intentos.push({ variante: v.etq, status: err.response?.status, ok: false, error: err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message, code });
    }
    await new Promise(r => setTimeout(r, 1300));
  }

  out.nota = out.ganador
    ? `✅ Funciona la variante "${out.ganador}". BORRA en StelOrder: ${out.aBorrar.join(' · ')}`
    : '❌ Ninguna variante de línea libre fue aceptada → tocará Camino A (crear el producto). No quedó nada que borrar.';
  return out;
}

// ── SONDA FINAL: crear producto → pedido con línea ITEM + parent-incident-id + SECTION ──
// Confirma el Camino A completo. Crea documentos de PRUEBA que TÚ borras.
async function diagCaminoA({ accId = null, go = false } = {}) {
  const out = { ts: new Date().toISOString(), cliente: {}, producto: {}, incidencia: {}, pedido: {}, seccion: {}, aBorrar: [], veredicto: '', nota: '' };
  if (!go) { out.nota = 'Simulación. Añade ?go=1 para crear producto/incidencia/pedido de PRUEBA (los borras tú).'; return out; }

  // 0) Cliente real
  try {
    const { clientMap } = await getClients();
    if (!accId) {
      const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const ent = Object.entries(clientMap || {});
      const mela = ent.find(([id, c]) => norm(c.name).includes('mela mutermilch'));
      accId = mela ? mela[0] : (ent[0] ? ent[0][0] : null);
    }
    out.cliente = { accId, nombre: (clientMap[String(accId)] || {}).name || null };
  } catch (e) { out.cliente = { error: e.message }; return out; }
  if (!accId) { out.nota = 'No hay cliente.'; return out; }

  const H = { headers: { 'Content-Type': 'application/json; charset=utf-8' }, timeout: 25000 };
  const idOf = (data) => { const d = Array.isArray(data) ? data[0] : data; return d && d.id ? String(d.id) : null; };

  // 1) Crear PRODUCTO de catálogo — probar endpoints/campos hasta acertar
  let itemId = null;
  const prodBodies = [
    { ep: '/products', body: { name: 'PRUEBA API - BORRAR baldosas', reference: 'PRUEBA-API', 'base-price': 100, type: 'PRODUCT' } },
    { ep: '/products', body: { name: 'PRUEBA API - BORRAR baldosas', 'base-price': 100 } },
    { ep: '/items',    body: { name: 'PRUEBA API - BORRAR baldosas', 'base-price': 100 } },
    { ep: '/catalog',  body: { name: 'PRUEBA API - BORRAR baldosas', 'base-price': 100 } }
  ];
  out.producto.intentos = [];
  for (const p of prodBodies) {
    try {
      const r = await client.post(p.ep, p.body, H);
      itemId = idOf(r.data);
      out.producto.intentos.push({ ep: p.ep, status: r.status, ok: true, id: itemId, body: JSON.stringify(r.data).slice(0, 250) });
      if (itemId) { out.producto.endpoint = p.ep; out.aBorrar.push(`Producto id ${itemId} (Catálogo)`); break; }
    } catch (err) {
      out.producto.intentos.push({ ep: p.ep, status: err.response?.status, ok: false, error: err.response?.data ? JSON.stringify(err.response.data).slice(0, 250) : err.message });
    }
    await new Promise(r => setTimeout(r, 1200));
  }
  if (!itemId) { out.veredicto = '❌ NO_PUDE_CREAR_PRODUCTO (revisa intentos para ver el endpoint correcto)'; out.nota = 'Nada que borrar salvo lo que diga aBorrar.'; return out; }

  await new Promise(r => setTimeout(r, 1200));

  // 2) Crear incidencia de PRUEBA (para enlazar)
  let incId = null;
  try {
    const r = await client.post('/incidents', { 'account-id': Number(accId), description: 'PRUEBA API - BORRAR (camino A)', 'incident-type-id': 3146, 'incident-state-id': 1120644 }, H);
    incId = idOf(r.data);
    out.incidencia = { status: r.status, id: incId };
    if (incId) out.aBorrar.push(`Incidencia id ${incId}`);
  } catch (err) { out.incidencia = { status: err.response?.status, error: err.response?.data ? JSON.stringify(err.response.data).slice(0, 250) : err.message }; }

  await new Promise(r => setTimeout(r, 1200));

  // 3) Crear PEDIDO con línea ITEM (item-id) + parent-incident-id
  let pdtId = null;
  try {
    const body = {
      'account-id': Number(accId),
      'document-state-id': 1120651,
      title: 'PRUEBA API - BORRAR',
      lines: [{ 'line-type': 'ITEM', 'item-id': Number(itemId), units: 1, 'item-base-price': 100, 'item-description': 'Reparación baldosas sueltas fachada (PRUEBA)' }]
    };
    if (incId) body['parent-incident-id'] = Number(incId);
    const r = await client.post('/workOrders', body, H);
    pdtId = idOf(r.data);
    out.pedido = { status: r.status, id: pdtId, body: JSON.stringify(r.data).slice(0, 300) };
    if (pdtId) out.aBorrar.push(`Pedido id ${pdtId}`);
  } catch (err) { out.pedido = { status: err.response?.status, error: err.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : err.message }; }

  // 3b) Releer pedido → ¿se mantuvo parent-incident-id?
  if (pdtId) {
    await new Promise(r => setTimeout(r, 1500));
    try {
      const orders = await fetchAllPages('/workOrders');
      const o = (orders || []).find(x => String(x.id) === String(pdtId));
      if (o) out.pedido.verificacion = {
        ref: o['full-reference'] || null,
        parentIncidentId: o['parent-incident-id'] || null,
        vinculoOk: String(o['parent-incident-id'] || '') === String(incId),
        lineas: (o.lines || []).filter(l => !l.deleted).length
      };
    } catch (e) { out.pedido.verificacionError = e.message; }
  }

  await new Promise(r => setTimeout(r, 1200));

  // 4) Probar línea SECTION (texto sin producto) — para el paso a paso de la Pieza B
  try {
    const body = {
      'account-id': Number(accId),
      'document-state-id': 1120651,
      title: 'PRUEBA API SECTION - BORRAR',
      lines: [
        { 'line-type': 'SECTION', 'item-description': '1) Retirada de baldosas sueltas y limpieza' },
        { 'line-type': 'ITEM', 'item-id': Number(itemId), units: 1, 'item-base-price': 100 }
      ]
    };
    const r = await client.post('/workOrders', body, H);
    const secId = idOf(r.data);
    out.seccion = { status: r.status, id: secId, ok: !!secId, body: JSON.stringify(r.data).slice(0, 250) };
    if (secId) out.aBorrar.push(`Pedido SECTION id ${secId}`);
  } catch (err) { out.seccion = { status: err.response?.status, ok: false, error: err.response?.data ? JSON.stringify(err.response.data).slice(0, 250) : err.message }; }

  const linkOk = out.pedido.verificacion && out.pedido.verificacion.vinculoOk;
  out.veredicto = (pdtId ? '✅ PEDIDO_CREADO_CON_ITEM' : '⚠️ PEDIDO_NO_CREADO') +
                  (linkOk ? ' · ✅ PARENT_OK' : ' · ⚠️ PARENT_REVISAR') +
                  (out.seccion.ok ? ' · ✅ SECTION_OK' : ' · ⚠️ SECTION_NO');
  out.nota = '⚠️ BORRA en StelOrder: ' + out.aBorrar.join(' · ');
  return out;
}

// ── CREAR INCIDENCIA (escritura real, con copia de seguridad en stelWriteLog) ──
async function crearIncidencia({ accId, descripcion, tipoId = null, estadoId = 1120644, requestedBy = null }) {
  if (!accId || !descripcion) throw new Error('Faltan datos (cliente o descripción)');
  const db = await require('./db').getDB();
  const body = { 'account-id': Number(accId), description: String(descripcion), 'incident-state-id': Number(estadoId) };
  if (tipoId) body['incident-type-id'] = Number(tipoId);
  const ins = await db.collection('stelWriteLog').insertOne({ tipo: 'incidencia', body, requestedBy, at: new Date(), result: 'pending' });
  try {
    const r = await client.post('/incidents', body, { headers: { 'Content-Type': 'application/json; charset=utf-8' }, timeout: 25000 });
    const d = Array.isArray(r.data) ? r.data[0] : r.data;
    const id = d && d.id ? String(d.id) : null;
    const ref = (d && (d['full-reference'] || (d.reference ? 'INC' + d.reference : null))) || (id ? '#' + id : null);
    await db.collection('stelWriteLog').updateOne({ _id: ins.insertedId }, { $set: { result: 'ok', status: r.status, incidentId: id, ref } });
    try { invalidate('incidents'); } catch (e) {}
    return { ok: true, id, ref, status: r.status };
  } catch (err) {
    await db.collection('stelWriteLog').updateOne({ _id: ins.insertedId }, { $set: { result: 'error', error: `${err.response?.status || ''} ${err.message}`, errorBody: err.response?.data || null } });
    throw new Error(`StelOrder rechazó: ${err.response?.status || ''} ${JSON.stringify(err.response?.data || err.message).slice(0, 200)}`);
  }
}

// Resuelve el account-id interno a partir del nombre exacto del cliente
async function accountIdByName(nombre) {
  const { clientMap } = await getClients().catch(() => ({ clientMap: {} }));
  const n = String(nombre || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  for (const [id, ci] of Object.entries(clientMap || {})) {
    if (String(ci.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim() === n) return id;
  }
  return null;
}

// ── Producto GENÉRICO reutilizable (uno por tipo): se crea 1 vez y se guarda su id ──
// Evita ensuciar el catálogo con un producto por cada pedido. La descripción real
// de cada trabajo va en la LÍNEA (item-description), no en el producto.
async function getProductoGenerico(tipo /* 'actuacion' | 'presupuesto' */) {
  const nombre = tipo === 'presupuesto' ? 'Presupuesto' : 'Actuación';
  const clave = tipo === 'presupuesto' ? 'generico:presupuesto' : 'generico:actuacion';
  const db = await require('./db').getDB();
  // 1) ¿Ya lo tenemos guardado y sigue existiendo?
  const guard = await db.collection('config').findOne({ _id: clave }).catch(() => null);
  if (guard && guard.itemId) {
    // Verificar que no esté en la papelera: si los productos vivos no lo incluyen, lo recreamos
    return guard.itemId;
  }
  // 2) Crearlo una vez y guardar su id
  const prod = await crearProducto({ nombre, descripcion: `Línea genérica de ${nombre.toLowerCase()} (la descripción real va en cada línea)`, precio: 0 });
  await db.collection('config').updateOne({ _id: clave }, { $set: { _id: clave, itemId: prod.id, nombre, at: new Date() } }, { upsert: true });
  return prod.id;
}

// ── CREAR PRODUCTO de catálogo (necesario para líneas ITEM) ──
async function crearProducto({ nombre, descripcion = null, precio = 0 }) {
  if (!nombre) throw new Error('Falta el nombre del producto');
  const body = { name: String(nombre).slice(0, 200), 'base-price': Number(precio) || 0 };
  if (descripcion) body.description = String(descripcion);
  const r = await client.post('/products', body, { headers: { 'Content-Type': 'application/json; charset=utf-8' }, timeout: 25000 });
  const d = Array.isArray(r.data) ? r.data[0] : r.data;
  const id = d && d.id ? String(d.id) : null;
  if (!id) throw new Error('StelOrder no devolvió id de producto');
  return { id, ref: d.reference || null };
}

// ── GENERAR PEDIDO DE TRABAJO desde una incidencia (réplica del "Generar" nativo) ──
// Usa un producto GENÉRICO reutilizable (Actuación/Presupuesto); la descripción de la
// incidencia va en la línea (item-description). Enlazado por parent-incident-id.
async function generarPedidoDesdeIncidencia({ incidentId, accId, descripcion, tipo = 'actuacion', estadoId = 1120651, requestedBy = null }) {
  if (!incidentId || !accId) throw new Error('Faltan datos (incidencia o cliente)');
  const desc = String(descripcion || 'Trabajo a realizar').trim();
  const db = await require('./db').getDB();

  // 1) Producto genérico reutilizable según el tipo (NO se crea uno nuevo cada vez)
  const itemId = await getProductoGenerico(tipo);

  // 2) Pedido enlazado a la incidencia; la descripción real va en la línea
  const body = {
    'account-id': Number(accId),
    'document-state-id': Number(estadoId),
    'parent-incident-id': Number(incidentId),
    lines: [{ 'line-type': 'ITEM', 'item-id': Number(itemId), units: 1, 'item-base-price': 0, 'item-description': desc }]
  };
  const ins = await db.collection('stelWriteLog').insertOne({ tipo: 'pedido-desde-incidencia', incidentId, itemId, body, requestedBy, at: new Date(), result: 'pending' });
  try {
    const r = await client.post('/workOrders', body, { headers: { 'Content-Type': 'application/json; charset=utf-8' }, timeout: 25000 });
    const d = Array.isArray(r.data) ? r.data[0] : r.data;
    const id = d && d.id ? String(d.id) : null;
    const ref = (d && (d['full-reference'] || (d.reference ? 'PDT' + d.reference : null))) || (id ? '#' + id : null);
    await db.collection('stelWriteLog').updateOne({ _id: ins.insertedId }, { $set: { result: 'ok', status: r.status, workOrderId: id, ref } });
    try { invalidate('workOrders'); } catch (e) {}
    return { ok: true, id, ref };
  } catch (err) {
    await db.collection('stelWriteLog').updateOne({ _id: ins.insertedId }, { $set: { result: 'error', error: `${err.response?.status || ''} ${err.message}`, errorBody: err.response?.data || null } });
    throw new Error(`StelOrder rechazó el pedido: ${err.response?.status || ''} ${JSON.stringify(err.response?.data || err.message).slice(0, 200)}`);
  }
}

// ── CREAR PRESUPUESTO (workEstimate) desde un borrador de la IA ──
// Estructura ya probada en /workOrders y replicada en /workEstimates:
//   · 1 línea SECTION con las observaciones técnicas (si las hay)
//   · 1 línea ITEM por partida, con el producto GENÉRICO "Presupuesto"
//     (item-id reutilizable); el nombre + paso a paso van en item-description.
// Estado por defecto: Pendiente (1120641) — en este StelOrder no existe un estado
// "borrador" separado; un presupuesto nuevo nace Pendiente a la espera de aceptación.
// IVA por línea NO se fija aquí (queda al de por defecto del producto): es el trozo 4.
// Enlace opcional a incidencia vía parent-incident-id. Todo queda en stelWriteLog.
async function crearPresupuestoStel({ accId, titulo = null, observaciones = null, partidas, incidentId = null, estadoId = 1120641, requestedBy = null }) {
  if (!accId) throw new Error('Falta el cliente (account-id)');
  if (!Array.isArray(partidas) || !partidas.length) throw new Error('El presupuesto no tiene partidas');
  const db = await require('./db').getDB();

  // 1) Producto genérico reutilizable (NO se crea uno por presupuesto)
  const itemId = await getProductoGenerico('presupuesto');

  // 2) Construir líneas: SECTION (observaciones) + ITEM por partida
  const lines = [];
  const obs = String(observaciones || '').trim();
  if (obs) lines.push({ 'line-type': 'SECTION', 'item-description': obs.slice(0, 4000) });
  for (const p of partidas) {
    const nombre = String(p.nombre || 'Partida').trim();
    const desc = String(p.descripcion || '').trim();
    lines.push({
      'line-type': 'ITEM',
      'item-id': Number(itemId),
      'item-name': nombre.slice(0, 200),   // título de la partida en la columna Nombre (sobrescribe el del producto genérico)
      units: Number(p.uds) || 1,
      'item-base-price': Number(p.precio) || 0,
      'item-description': desc.slice(0, 4000)  // solo el paso a paso (el título ya va en item-name)
    });
  }

  const body = { 'account-id': Number(accId), 'document-state-id': Number(estadoId), lines };
  if (titulo) body.title = String(titulo).slice(0, 200);
  if (incidentId) body['parent-incident-id'] = Number(incidentId);

  const ins = await db.collection('stelWriteLog').insertOne({ tipo: 'presupuesto', accId, incidentId, itemId, body, requestedBy, at: new Date(), result: 'pending' });
  try {
    const r = await client.post('/workEstimates', body, { headers: { 'Content-Type': 'application/json; charset=utf-8' }, timeout: 25000 });
    const d = Array.isArray(r.data) ? r.data[0] : r.data;
    const id = d && d.id ? String(d.id) : null;
    const ref = (d && (d['full-reference'] || d.reference)) || (id ? '#' + id : null);
    await db.collection('stelWriteLog').updateOne({ _id: ins.insertedId }, { $set: { result: 'ok', status: r.status, workEstimateId: id, ref } });
    try { invalidate('workEstimates'); } catch (e) {}
    return { ok: true, id, ref };
  } catch (err) {
    await db.collection('stelWriteLog').updateOne({ _id: ins.insertedId }, { $set: { result: 'error', error: `${err.response?.status || ''} ${err.message}`, errorBody: err.response?.data || null } });
    throw new Error(`StelOrder rechazó el presupuesto: ${err.response?.status || ''} ${JSON.stringify(err.response?.data || err.message).slice(0, 200)}`);
  }
}

// Busca la última incidencia (más reciente) — para "el pedido de la última incidencia"
async function ultimaIncidencia() {
  const incs = await getAllIncidents().catch(() => []);
  const vivas = (incs || []).filter(i => !i.deleted);
  if (!vivas.length) return null;
  vivas.sort((a, b) => new Date(b['creation-date'] || b.date || 0) - new Date(a['creation-date'] || a.date || 0));
  return _incInfo(vivas[0]);
}

// Busca una incidencia por su referencia (ej. "INC00575" o "575")
async function incidenciaPorRef(ref) {
  const incs = await getAllIncidents().catch(() => []);
  const q = parseInt(String(ref || '').replace(/\D/g, ''), 10);
  const i = (incs || []).filter(x => !x.deleted).find(x => parseInt(String(x['full-reference'] || x.reference || '').replace(/\D/g, ''), 10) === q);
  return i ? _incInfo(i) : null;
}

function _incInfo(i) {
  const tid = Number(i['incident-type-id']);
  const tipo = tid === 3145 ? 'presupuesto' : 'actuacion';
  return {
    id: String(i.id), accId: String(i['account-id'] || ''),
    descripcion: i.description || '', tipo,
    ref: i['full-reference'] || (i.reference ? 'INC' + i.reference : '#' + i.id)
  };
}

module.exports = {
  getInvoices, getAllReceipts, getPendingInvoices, getClients,
  getWorkEstimates, getEstimatesSummary, getBankAccounts, getSummary, diagProveedores,
  getSuppliers, getPurchaseInvoices, getExpenses,
  getAlertLevel, getFamiliesSummary, getAccountCategories, clearCache,
  sendInvoiceByEmail, findInvoiceIdByNumber, getInvoiceRaw, getInvoicePdfPath, getEntityRawByRef,
  getWorkOrdersLive, getWorkOrderAlertLevel, setWorkOrderState, setWorkOrderStateLight,
  getMonthlyBilling,
  getAllWorkOrders, getWorkOrderStateMap, getEmployeeMap,
  getIncidentTypeMaps, getAllIncidents, getIncidentStateMap, diagEscritura, diagCrearEnlace, diagLineaLibre, diagCaminoA, diagLineaImpuesto, diagImpuestos,
  crearIncidencia, accountIdByName, crearProducto, getProductoGenerico, generarPedidoDesdeIncidencia, crearPresupuestoStel, ultimaIncidencia, incidenciaPorRef
};
