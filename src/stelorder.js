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
  incidentTypes:     parseInt(process.env.STEL_TTL_INCTYPES   || 360) * MIN  // 6 h
};

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
      { headers: { 'Content-Type': 'application/json' } });
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
      { headers: { 'Content-Type': 'application/json' } });
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

module.exports = {
  getInvoices, getAllReceipts, getPendingInvoices, getClients,
  getWorkEstimates, getEstimatesSummary, getBankAccounts, getSummary,
  getAlertLevel, getFamiliesSummary, getAccountCategories, clearCache,
  sendInvoiceByEmail, findInvoiceIdByNumber, getInvoiceRaw, getInvoicePdfPath, getEntityRawByRef,
  getWorkOrdersLive, getWorkOrderAlertLevel, setWorkOrderState, setWorkOrderStateLight,
  getMonthlyBilling,
  getAllWorkOrders, getWorkOrderStateMap, getEmployeeMap,
  getIncidentTypeMaps, getAllIncidents, getIncidentStateMap
};
