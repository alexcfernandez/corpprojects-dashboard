// src/bancoSync.js — Movimientos del banco SOLOS, sin subir extractos (Enable Banking, banca abierta PSD2).
//
// Álex da permiso a cada banco una vez (en la web del banco, con su usuario: aquí nunca pasan contraseñas);
// el permiso dura lo que deje el banco (hasta ~180 días) y se renueva con un clic. Es solo LECTURA: no se
// puede pagar nada desde aquí.
//
//   Cuenta con IBAN (Santander)          → bancoMovimientos  (igual que el Excel de la cuenta)
//   Revolut y tarjetas (sin IBAN propio) → tarjetaMovimientos (igual que el CSV de Revolut)
//
// Lo que ya se había subido a mano no se duplica: un movimiento del banco con la misma cuenta, día e importe
// (y saldo, si lo hay) que uno del Excel se enlaza con él; y al revés, si después se sube el Excel o el CSV,
// sus filas se enlazan con las que ya entraron solas (gemelaDeExcel / gemelaDeTarjeta).
//
// La normativa deja leer cada cuenta unas 4 veces al día sin que la persona esté delante: se sincroniza a las
// 7:15, 11:15, 15:15 y 19:15 (scheduler.js), y a mano con «Sincronizar ahora».
//
//   bancoConexiones { _id: session_id, banco, psuType, validoHasta, estado: activa|caducada|revocada,
//                     cuentas: [{ uid, iban, nombre, moneda, destino: banco|tarjeta, ultimaSync, hasta, nuevos, error }],
//                     creadaPor, createdAt, avisos: {…} }
//   bancoAuthPendiente { _id: state, banco, psuType, por, createdAt }   (caduca a los 30 min)
//
// Variables (las pone Álex en Railway): EB_APP_ID (id de la aplicación) y EB_PRIVATE_KEY (el .pem que descarga
// el navegador al registrarla; vale el texto tal cual o en base64).
'use strict';
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
async function getDB() { return require('./db').getDB(); }

const API = 'https://api.enablebanking.com';
const BASE_URL = (process.env.PUBLIC_URL || 'https://dashboard.corpprojects.es').replace(/\/+$/, '');
const REDIRECT = BASE_URL + '/api/banco-sync/callback';
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const DIA = 86400000;

function _clave() {
  let k = String(process.env.EB_PRIVATE_KEY || '').trim();
  if (!k) return null;
  if (!/-----BEGIN/.test(k)) { try { k = Buffer.from(k, 'base64').toString('utf8'); } catch (e) { return null; } }
  return k.replace(/\\n/g, '\n');
}
function configurado() { return !!(process.env.EB_APP_ID && _clave()); }
function _token() {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + 3600 }, _clave(), { algorithm: 'RS256', keyid: process.env.EB_APP_ID, header: { typ: 'JWT' } });
}
async function _api(method, path, body, { _fetch = fetch } = {}) {
  if (!configurado()) throw new Error('Falta conectar Enable Banking (EB_APP_ID y EB_PRIVATE_KEY en Railway)');
  const r = await _fetch(API + path, { method, headers: { Authorization: 'Bearer ' + _token(), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let d = null; try { d = txt ? JSON.parse(txt) : {}; } catch (e) { d = { message: txt.slice(0, 200) }; }
  if (!r.ok) { const e = new Error((d && (d.message || d.error)) || ('HTTP ' + r.status)); e.status = r.status; e.code = d && (d.error || d.code); throw e; }
  return d;
}

// ── Conectar un banco ─────────────────────────────────────────────
async function bancos(psuType = 'business') {
  const d = await _api('GET', `/aspsps?country=ES&psu_type=${encodeURIComponent(psuType)}`);
  return (d.aspsps || []).map(a => ({ nombre: a.name, logo: a.logo || null, maxDias: a.maximum_consent_validity ? Math.floor(a.maximum_consent_validity / 86400) : null }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}
// Devuelve la dirección del banco donde Álex da el permiso; al volver, el banco llama a callback().
async function conectar(banco, { psuType = 'business', por = '' } = {}) {
  if (!banco) throw new Error('Elige el banco');
  const lista = await _api('GET', `/aspsps?country=ES&psu_type=${encodeURIComponent(psuType)}`);
  const a = (lista.aspsps || []).find(x => x.name === banco);
  if (!a) throw new Error('No encuentro ese banco en Enable Banking');
  const segs = Math.min(Number(a.maximum_consent_validity) || 90 * 86400, 180 * 86400);
  const state = crypto.randomBytes(18).toString('hex');
  const db = await getDB();
  await db.collection('bancoAuthPendiente').insertOne({ _id: state, banco, psuType, por, createdAt: new Date() });
  const d = await _api('POST', '/auth', { access: { valid_until: new Date(Date.now() + segs * 1000 - 60000).toISOString() }, aspsp: { name: banco, country: 'ES' }, state, redirect_url: REDIRECT, psu_type: psuType, language: 'es' });
  return { url: d.url };
}
async function callback({ code, state, error }) {
  const db = await getDB();
  const p = state ? await db.collection('bancoAuthPendiente').findOne({ _id: String(state) }) : null;
  if (!p || Date.now() - new Date(p.createdAt).getTime() > 30 * 60000) throw new Error('El enlace ha caducado: vuelve a pulsar «Conectar»');
  await db.collection('bancoAuthPendiente').deleteOne({ _id: p._id });
  if (error || !code) throw new Error('El banco no dio el permiso' + (error ? ` (${error})` : ''));
  const s = await _api('POST', '/sessions', { code: String(code) });
  const cuentas = (s.accounts || []).map(a => _cuenta(a, p.banco));
  await db.collection('bancoConexiones').updateOne({ _id: s.session_id }, { $set: {
    banco: p.banco, psuType: p.psuType, validoHasta: s.access && s.access.valid_until ? new Date(s.access.valid_until) : null,
    estado: 'activa', cuentas, creadaPor: p.por, createdAt: new Date(), avisos: {},
  } }, { upsert: true });
  // Si es una renovación, la conexión vieja del mismo banco deja de usarse.
  await db.collection('bancoConexiones').updateMany({ _id: { $ne: s.session_id }, banco: p.banco, estado: { $in: ['activa', 'caducada'] } }, { $set: { estado: 'sustituida', sustituidaPor: s.session_id } });
  const r = await sincronizar({ soloId: s.session_id }).catch(e => ({ error: e.message }));
  return { banco: p.banco, cuentas: cuentas.length, sync: r };
}
function _cuenta(a, banco = '') {
  const iban = (a.account_id && a.account_id.iban) || null;
  const nombre = [a.name, a.product, a.details].filter(Boolean).join(' · ').slice(0, 120) || iban || 'Cuenta';
  const otra = a.account_id && a.account_id.other && a.account_id.other.identification;
  // Revolut tiene IBAN, pero su detalle (cada compra con tarjeta) va con las tarjetas, como su CSV.
  const esTarjeta = /revolut/i.test(banco) || !iban || String(a.cash_account_type || '').toUpperCase() === 'CARD';
  return { uid: a.uid, iban, nombre, moneda: a.currency || 'EUR', destino: esTarjeta ? 'tarjeta' : 'banco', tarjeta: esTarjeta ? (String(otra || a.name || '').replace(/\D/g, '').slice(-4) || null) : null, ultimaSync: null, hasta: null, nuevos: 0, error: null };
}

// ── Pasar un movimiento del banco a nuestro formato ───────────────────────────
function _concepto(t) {
  const rem = [].concat(t.remittance_information || []).join(' ').replace(/\s+/g, ' ').trim();
  const entra = t.credit_debit_indicator === 'CRDT';
  const otro = entra ? (t.debtor && t.debtor.name) : (t.creditor && t.creditor.name);
  // Igual que lo escribe Santander en su Excel, para que se reconozcan las nóminas y los proveedores.
  if (otro && !new RegExp(otro.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(rem)) return (entra ? `Transferencia De ${otro}` : `Transferencia A Favor De ${otro}`) + (rem ? ` Concepto: ${rem}` : '');
  return rem || otro || (t.bank_transaction_code && t.bank_transaction_code.description) || 'Movimiento';
}
function _codigo(t, concepto) {
  const n = require('./banco').norm(concepto);
  if (/\b(compra|pago movil|tarjeta|card)\b/.test(n)) return '136';
  if (/\brecibo\b|adeudo|domicili/.test(n) || /DD|DDBT/.test(String(t.bank_transaction_code && (t.bank_transaction_code.code || t.bank_transaction_code.sub_code) || ''))) return '174';
  if (/transferencia|a favor de/.test(n) || (t.credit_debit_indicator === 'DBIT' && t.creditor && t.creditor.name)) return '072';
  return '';
}
function _fechas(t) { return [...new Set([t.booking_date, t.transaction_date, t.value_date].filter(Boolean).map(x => String(x).slice(0, 10)))]; }
// Por IBAN (no por la cuenta de la sesión): la misma cuenta enlazada dos veces (Revolut sale repetida) no duplica.
const _idCuenta = cuenta => cuenta.iban || cuenta.uid;
function _ref(cuenta, t) {
  const id = t.entry_reference || t.transaction_id;
  if (id) return `eb|${_idCuenta(cuenta)}|${id}`;
  const h = crypto.createHash('sha1').update([_fechas(t)[0], t.transaction_amount && t.transaction_amount.amount, t.credit_debit_indicator, [].concat(t.remittance_information || []).join(' ')].join('|')).digest('hex').slice(0, 16);
  return `eb|${_idCuenta(cuenta)}|h${h}`;
}
function aBanco(cuenta, t) {
  const B = require('./banco');
  const imp = r2(Math.abs(Number(t.transaction_amount && t.transaction_amount.amount) || 0) * (t.credit_debit_indicator === 'DBIT' ? -1 : 1));
  const fecha = _fechas(t)[0];
  const saldo = t.balance_after_transaction && t.balance_after_transaction.balance_amount ? r2(t.balance_after_transaction.balance_amount.amount) : null;
  const concepto = _concepto(t), codigo = _codigo(t, concepto);
  const c = B.clasificar(concepto, codigo, imp);
  const ref = _ref(cuenta, t);
  return { huella: ref, ebRef: ref, iban: cuenta.iban, fechaOperacion: fecha, fechaValor: t.value_date ? String(t.value_date).slice(0, 10) : fecha, mes: fecha.slice(0, 7), concepto, importe: imp, saldo, codigo, numeroDocumento: null,
    flujo: c.flujo, categoria: c.categoria, categoriaLabel: c.label, contraparte: c.contraparte, recurrente: c.recurrente, _fechas: _fechas(t) };
}
function aTarjeta(cuenta, t, propias = new Set()) {
  const imp = r2(Math.abs(Number(t.transaction_amount && t.transaction_amount.amount) || 0) * (t.credit_debit_indicator === 'DBIT' ? -1 : 1));
  const concepto = _concepto(t), n = require('./banco').norm(concepto);
  const otro = require('./banco').norm((t.credit_debit_indicator === 'CRDT' ? t.debtor : t.creditor) && ((t.credit_debit_indicator === 'CRDT' ? t.debtor : t.creditor).name) || '');
  const transf = /^(to|from)\s|transferencia/.test(n) || !!otro;
  const interno = (otro && propias.has(otro)) || /^(to|from)\s+(.+)$/.test(n) && propias.has(n.replace(/^(to|from)\s+/, '').split(' concepto')[0].trim()) || /top.?up|recarga/.test(n);
  const ref = _ref(cuenta, t);
  const banco = /revolut/i.test(cuenta.banco || cuenta.nombre || '');
  return { huella: ref, ebRef: ref, fuente: banco ? 'revolut' : 'santander_credito', fecha: _fechas(t)[0], concepto, importe: imp,
    tipo: /comision|cuota|fee/.test(n) ? 'FEE' : transf ? 'TRANSFER' : (imp > 0 ? 'CARD_REFUND' : 'CARD_PAYMENT'), estado: 'COMPLETED',
    tarjeta: cuenta.tarjeta || null, etiqueta: null, titular: null, cuenta: cuenta.nombre, interno: !!interno, beneficiario: (t.creditor && t.creditor.name) || null, _fechas: _fechas(t) };
}

// ── Gemelas: lo mismo subido a mano y traído del banco ───────────────────────
// Del banco → ¿ya está del Excel? (misma cuenta, día de operación/valor, importe y, si ambos lo tienen, saldo)
async function _gemelaExcelDe(db, m) {
  const q = { iban: m.iban, fechaOperacion: { $in: m._fechas || [m.fechaOperacion] }, importe: { $gte: m.importe - 0.005, $lte: m.importe + 0.005 }, ebRef: null };
  const cands = await db.collection('bancoMovimientos').find(q).limit(5).toArray();
  return cands.find(c => m.saldo == null || c.saldo == null || Math.abs(c.saldo - m.saldo) < 0.01) || null;
}
// Del Excel → ¿ya entró del banco? (lo llama banco.ingestExcelBuffer)
async function gemelaDeExcel(db, m) {
  const cands = await db.collection('bancoMovimientos').find({ ebRef: { $ne: null }, excelHuella: null, iban: m.iban, importe: { $gte: m.importe - 0.005, $lte: m.importe + 0.005 }, $or: [{ fechaOperacion: m.fechaOperacion }, { fechaValor: m.fechaOperacion }, { fechaOperacion: m.fechaValor }] }).limit(5).toArray();
  return cands.find(c => m.saldo == null || c.saldo == null || Math.abs(c.saldo - m.saldo) < 0.01) || null;
}
async function _gemelaCsvDe(db, m) {
  return db.collection('tarjetaMovimientos').findOne({ fuente: m.fuente, ebRef: null, fecha: { $in: m._fechas || [m.fecha] }, importe: { $gte: m.importe - 0.005, $lte: m.importe + 0.005 } });
}
// Del CSV de Revolut → ¿ya entró del banco? (lo llama tarjetas.guardar)
async function gemelaDeTarjeta(db, m) {
  if (!m.fecha) return null;
  const d = new Date(m.fecha + 'T12:00:00Z'), f = x => new Date(d.getTime() + x * DIA).toISOString().slice(0, 10);
  return db.collection('tarjetaMovimientos').findOne({ fuente: m.fuente, ebRef: { $ne: null }, csvHuella: null, fecha: { $in: [f(-1), f(0), f(1)] }, importe: { $gte: m.importe - 0.005, $lte: m.importe + 0.005 } });
}

async function guardarMovimientos(db, cuenta, txs, propias) {
  let nuevos = 0, repetidos = 0;
  const col = cuenta.destino === 'banco' ? 'bancoMovimientos' : 'tarjetaMovimientos';
  for (const t of txs) {
    if (!t || !t.transaction_amount) continue;
    if (t.status && !/BOOK/i.test(t.status)) continue;           // solo lo ya apuntado (lo pendiente cambia)
    const m = cuenta.destino === 'banco' ? aBanco(cuenta, t) : aTarjeta(cuenta, t, propias);
    if (!m.fechaOperacion && !m.fecha) continue;
    if (await db.collection(col).findOne({ $or: [{ huella: m.huella }, { ebRef: m.ebRef }] }, { projection: { _id: 1 } })) { repetidos++; continue; }
    const gem = cuenta.destino === 'banco' ? await _gemelaExcelDe(db, m) : await _gemelaCsvDe(db, m);
    if (gem) { await db.collection(col).updateOne({ _id: gem._id }, { $set: { ebRef: m.ebRef, vistoEl: new Date() } }); repetidos++; continue; }
    const { _fechas: _f, ...doc } = m;
    await db.collection(col).insertOne({ ...doc, importadoEl: new Date(), origen: 'enablebanking', archivo: null });
    nuevos++;
  }
  return { nuevos, repetidos };
}

// Desde cuándo pedir: lo último que ya tenemos de esa cuenta menos 5 días (por si el banco apunta tarde), o 90 días.
async function _desde(db, cuenta) {
  const hoy = Date.now();
  let ult = cuenta.hasta;
  if (!ult) {
    const q = cuenta.destino === 'banco' ? db.collection('bancoMovimientos').find({ iban: cuenta.iban }).sort({ fechaOperacion: -1 }).limit(1) : db.collection('tarjetaMovimientos').find({ ebRef: { $regex: '^eb\\|' + _idCuenta(cuenta).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\|' } }).sort({ fecha: -1 }).limit(1);
    const u = (await q.toArray())[0]; ult = u ? (u.fechaOperacion || u.fecha) : null;
  }
  const t = ult ? Math.max(new Date(ult + 'T00:00:00Z').getTime() - 5 * DIA, hoy - 365 * DIA) : hoy - 90 * DIA;
  return new Date(t).toISOString().slice(0, 10);
}

async function sincronizar({ soloId = null, _api: api = _api } = {}) {
  if (!configurado()) return { configurado: false, nuevos: 0 };
  const db = await getDB();
  const conns = await db.collection('bancoConexiones').find(soloId ? { _id: soloId } : { estado: 'activa' }).toArray();
  const propias = new Set(conns.flatMap(c => (c.cuentas || []).map(a => require('./banco').norm(a.nombre.split(' · ')[0]))).concat(['corp projects holding sl', 'corp projects holding', 'corp projects']));
  const out = []; let total = 0;
  for (const c of conns) {
    if (c.validoHasta && new Date(c.validoHasta) < new Date()) { await _caducada(db, c); out.push({ banco: c.banco, error: 'permiso caducado' }); continue; }
    for (const [i, cuenta] of (c.cuentas || []).entries()) {
      const cu = { ...cuenta, banco: c.banco };
      try {
        const desde = await _desde(db, cu);
        let ck = null, n = 0, pags = 0; const txs = [];
        do {
          const d = await api('GET', `/accounts/${encodeURIComponent(cu.uid)}/transactions?date_from=${desde}${ck ? '&continuation_key=' + encodeURIComponent(ck) : ''}`);
          txs.push(...(d.transactions || [])); ck = d.continuation_key || null; pags++;
        } while (ck && pags < 30);
        const r = await guardarMovimientos(db, cu, txs, propias);
        n = r.nuevos; total += n;
        const fechas = txs.flatMap(_fechas).sort();
        await db.collection('bancoConexiones').updateOne({ _id: c._id }, { $set: { [`cuentas.${i}.ultimaSync`]: new Date(), [`cuentas.${i}.nuevos`]: n, [`cuentas.${i}.error`]: null, ...(fechas.length ? { [`cuentas.${i}.hasta`]: fechas[fechas.length - 1] } : {}) } });
        out.push({ banco: c.banco, cuenta: cu.nombre, desde, recibidos: txs.length, nuevos: n, repetidos: r.repetidos });
      } catch (e) {
        if (e.status === 401 || /expired|EXPIRED|revoked|not authorized/i.test(e.message || '') || e.status === 403 && /session/i.test(e.message || '')) { await _caducada(db, c); out.push({ banco: c.banco, error: 'permiso caducado o retirado' }); break; }
        await db.collection('bancoConexiones').updateOne({ _id: c._id }, { $set: { [`cuentas.${i}.error`]: String(e.message || e).slice(0, 200), [`cuentas.${i}.errorAt`]: new Date() } });
        out.push({ banco: c.banco, cuenta: cu.nombre, error: e.message });
      }
    }
  }
  if (total) { try { require('./trimestre').olvidarMapaPagos(); } catch (e) {} }
  if (out.length) console.log('[BancoSync]', out.map(o => `${o.banco}${o.cuenta ? ' · ' + o.cuenta : ''}: ${o.error || o.nuevos + ' nuevos'}`).join(' | '));
  return { configurado: true, nuevos: total, detalle: out };
}

// ── Avisos: el permiso caduca y hay que renovarlo (lo hace Álex en un minuto) ─────────
function _destinos() { return String(process.env.BANCO_AVISOS_TO || process.env.FICHAJE_AVISOS_TO || process.env.WHATSAPP_TO || '').split(',').map(s => s.trim().replace(/^whatsapp:/i, '')).filter(Boolean); }
async function _avisar(titulo, texto) {
  for (const to of _destinos()) { try { await require('./notifications').sendWhatsAppTo(to, texto); } catch (e) { console.warn('[BancoSync] aviso:', e.message); } }
  try { await require('./push').sendToOficina({ title: titulo, body: texto.slice(0, 140), url: '/trimestre#bancos' }); } catch (e) {}
}
async function _caducada(db, c) {
  if (c.estado === 'caducada') return;
  await db.collection('bancoConexiones').updateOne({ _id: c._id }, { $set: { estado: 'caducada', caducadaAt: new Date() } });
  await _avisar(`🏦 ${c.banco}: hay que renovar el permiso`, `🏦 El permiso para leer ${c.banco} ha caducado y los movimientos ya no entran solos. Renuévalo en un minuto: ${BASE_URL}/trimestre#bancos → «Renovar».`);
}
async function revisarCaducidad(hoy = new Date()) {
  const db = await getDB();
  const conns = await db.collection('bancoConexiones').find({ estado: 'activa', validoHasta: { $ne: null } }).toArray();
  const hechos = [];
  for (const c of conns) {
    const dias = Math.ceil((new Date(c.validoHasta) - hoy) / DIA);
    const tramo = dias <= 1 ? 'd1' : dias <= 7 ? 'd7' : null;
    if (!tramo || (c.avisos || {})[tramo]) continue;
    await _avisar(`🏦 ${c.banco}: el permiso caduca ${dias <= 1 ? 'mañana' : 'en ' + dias + ' días'}`, `🏦 El permiso para leer los movimientos de ${c.banco} caduca ${dias <= 1 ? 'mañana' : 'en ' + dias + ' días'}. Renuévalo en un minuto (entras con tu usuario del banco): ${BASE_URL}/trimestre#bancos → «Renovar».`);
    await db.collection('bancoConexiones').updateOne({ _id: c._id }, { $set: { ['avisos.' + tramo]: new Date() } });
    hechos.push({ banco: c.banco, dias });
  }
  return hechos;
}

async function estado() {
  const db = await getDB();
  const conns = await db.collection('bancoConexiones').find({ estado: { $in: ['activa', 'caducada'] } }).sort({ createdAt: -1 }).toArray();
  return {
    configurado: configurado(), redirectUrl: REDIRECT,
    conexiones: conns.map(c => ({ id: c._id, banco: c.banco, estado: c.estado, validoHasta: c.validoHasta, diasRestantes: c.validoHasta ? Math.ceil((new Date(c.validoHasta) - Date.now()) / DIA) : null, psuType: c.psuType,
      cuentas: (c.cuentas || []).map(a => ({ nombre: a.nombre, iban: a.iban ? a.iban.slice(0, 4) + ' … ' + a.iban.slice(-4) : null, destino: a.destino, ultimaSync: a.ultimaSync, hasta: a.hasta, nuevos: a.nuevos, error: a.error })) })),
  };
}
async function desconectar(id) {
  const db = await getDB();
  try { await _api('DELETE', '/sessions/' + encodeURIComponent(id)); } catch (e) { console.warn('[BancoSync] borrar sesión:', e.message); }
  await db.collection('bancoConexiones').updateOne({ _id: String(id) }, { $set: { estado: 'revocada', revocadaAt: new Date() } });
  return { ok: true };
}

module.exports = { configurado, bancos, conectar, callback, sincronizar, revisarCaducidad, estado, desconectar, gemelaDeExcel, gemelaDeTarjeta, aBanco, aTarjeta, guardarMovimientos, _cuenta, REDIRECT };
