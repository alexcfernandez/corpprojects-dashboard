// src/tarjetas.js — Movimientos de TARJETAS (Revolut Business y tarjetas de crédito Santander)
// para puntearlos compra a compra con su factura, igual que la cuenta del banco.
//
// La cuenta de Santander solo ve el traspaso a Revolut o la liquidación mensual de la tarjeta
// de crédito; el detalle (cada compra en Obramat, Leroy…) está aquí.
//
//   tarjetaMovimientos { huella, fuente:'revolut'|'santander_credito', fecha, concepto, importe,
//                        tipo, tarjeta:'4522', etiqueta, titular, cuenta, estado, mcc, importadoEl }
//   tarjetas           { _id:'4522', banco, persona, etiqueta, nota }   ← quién lleva cada tarjeta
//
// El titular que pone el banco NO siempre es quien la usa (en Revolut casi todas están a nombre
// de Alfonso): manda la tabla `tarjetas`, que se edita desde Cierre del trimestre.

const XLSX = require('xlsx');
async function getDB() { return require('./db').getDB(); }
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const num = v => { if (typeof v === 'number') return v; let s = String(v == null ? '' : v).replace(/eur|€/gi, '').replace(/\s/g, ''); if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); else s = s.replace(/,/g, ''); const n = parseFloat(s); return Number.isFinite(n) ? n : 0; };
const iso = s => { const t = String(s == null ? '' : s).trim(); if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10); const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null; };

// Quién lleva cada tarjeta (confirmado por Álex el 1/10/2026). Se siembra sin pisar lo editado.
const TARJETAS_INICIALES = [
  { _id: '4522', banco: 'Revolut', etiqueta: 'compras corp', persona: 'Alfonso' },
  { _id: '1643', banco: 'Revolut', etiqueta: 'oficina', persona: 'Manolo' },
  { _id: '6439', banco: 'Revolut', etiqueta: 'David taladros', persona: 'David Taladros' },
  { _id: '5039', banco: 'Revolut', etiqueta: 'Virtual OFI', persona: 'Virtual (pruebas)' },
  { _id: '7925', banco: 'Santander débito', etiqueta: '', persona: 'Álex' },
  { _id: '9259', banco: 'Santander crédito', etiqueta: 'a nombre de Silvana', persona: 'Álex' },
  { _id: '6302', banco: 'Santander crédito', etiqueta: '', persona: 'Jose Beliard' },
  { _id: '0519', banco: 'Santander débito', etiqueta: '', persona: 'Sin titular (no se usa)' },
  { _id: '8715', banco: 'Santander débito', etiqueta: '', persona: 'Sin titular (no se usa)' },
];
async function sembrarTarjetas() {
  const db = await getDB();
  for (const t of TARJETAS_INICIALES) await db.collection('tarjetas').updateOne({ _id: t._id }, { $setOnInsert: t }, { upsert: true });
}
async function listaTarjetas() {
  const db = await getDB();
  await sembrarTarjetas();
  const [ts, cobertura] = await Promise.all([
    db.collection('tarjetas').find({}).sort({ banco: 1, _id: 1 }).toArray(),
    db.collection('tarjetaMovimientos').aggregate([{ $group: { _id: '$tarjeta', desde: { $min: '$fecha' }, hasta: { $max: '$fecha' }, n: { $sum: 1 } } }]).toArray(),
  ]);
  const cob = {}; cobertura.forEach(c => { cob[c._id] = c; });
  return ts.map(t => ({ ...t, last4: t._id, desde: cob[t._id] ? cob[t._id].desde : null, hasta: cob[t._id] ? cob[t._id].hasta : null, nMovimientos: cob[t._id] ? cob[t._id].n : 0 }));
}
async function setPersona(last4, persona) {
  const db = await getDB();
  if (!/^\d{4}$/.test(String(last4))) throw new Error('Tarjeta no válida');
  await db.collection('tarjetas').updateOne({ _id: String(last4) }, { $set: { persona: String(persona || '').trim().slice(0, 60) } }, { upsert: true });
  return { ok: true };
}

// ── Lectores ──────────────────────────────────────────────────────
function parseRevolutCsv(texto) {
  const wb = XLSX.read(String(texto).replace(/^﻿/, ''), { type: 'string', raw: true });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: true, defval: '' });
  if (!rows.length || !('Card number' in rows[0]) || !('Date started (UTC)' in rows[0])) throw new Error('No parece un extracto CSV de Revolut Business');
  // Subcuentas propias: los «To X / From X» entre ellas son traspasos internos.
  const propias = new Set(rows.map(r => String(r.Account || '').replace(/^[A-Z]{3}\s+/, '').trim().toLowerCase()).filter(Boolean));
  return rows.filter(r => r.ID && r['Date started (UTC)']).map(r => {
    const desc = String(r.Description || '').trim();
    const destino = /^(to|from)\s+(.+)$/i.exec(desc);
    const interno = r.Type === 'TOPUP' || (r.Type === 'TRANSFER' && destino && propias.has(destino[2].trim().toLowerCase()));
    return {
      huella: 'revolut|' + r.ID + '|' + String(r.Account || ''), fuente: 'revolut', fecha: iso(r['Date started (UTC)']), concepto: desc + (r.Reference ? ` (${r.Reference})` : ''),
      importe: r2(num(r.Amount)), tipo: r.Type, estado: r.State, tarjeta: String(r['Card number'] || '').slice(-4) || null, etiqueta: r['Card label'] || null,
      titular: r.Payer || null, cuenta: r.Account || null, mcc: r.MCC || null, interno, beneficiario: r['Beneficiary name'] || null,
    };
  });
}
function parseSantanderCredito(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, blankrows: false });
  const h = rows.findIndex(r => (r || []).some(c => /fecha operaci/i.test(String(c))) && (r || []).some(c => /n[ºo°]\s*tarjeta/i.test(String(c))));
  if (h < 0) throw new Error('No parece un extracto de tarjeta de Santander');
  const H = rows[h].map(c => String(c || '').toLowerCase());
  const col = re => H.findIndex(c => re.test(c));
  const cF = col(/fecha operaci/), cH = col(/^hora/), cC = col(/concepto/), cB = col(/beneficiario/), cT = col(/tarjeta/), cS = col(/situaci/), cI = col(/importe/);
  return rows.slice(h + 1).filter(r => r && iso(r[cF])).map(r => {
    const tarjeta = String(r[cT] || '').replace(/\D/g, '').slice(-4) || null, fecha = iso(r[cF]), importe = r2(num(r[cI])), concepto = String(r[cC] || '').replace(/\s+/g, ' ').trim();
    return {
      huella: `santcred|${tarjeta}|${fecha}|${String(r[cH] || '')}|${importe.toFixed(2)}|${concepto.slice(0, 40).toLowerCase()}`,
      fuente: 'santander_credito', fecha, concepto, importe, tipo: /cuota|comision|renov/i.test(concepto) ? 'FEE' : (importe > 0 ? 'CARD_REFUND' : 'CARD_PAYMENT'),
      estado: r[cS] || null, tarjeta, etiqueta: null, titular: r[cB] || null, cuenta: 'Santander crédito', interno: false,
    };
  });
}

// Detecta el formato: CSV de Revolut, Excel de tarjeta de crédito Santander o Excel de la cuenta Santander.
async function importar(buf, nombre = '') {
  const texto = buf.slice(0, 4000).toString('utf8');
  if (/Date started \(UTC\)/.test(texto)) return guardar(parseRevolutCsv(buf.toString('utf8')), 'Revolut', nombre);
  let wb = null; try { wb = XLSX.read(buf, { type: 'buffer' }); } catch (e) {}
  if (wb) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, blankrows: false }).slice(0, 12).map(r => (r || []).join(' | ').toLowerCase());
    if (rows.some(r => /n[ºo°] tarjeta/.test(r))) return guardar(parseSantanderCredito(buf), 'tarjeta de crédito Santander', nombre);
    if (rows.some(r => /fecha valor/.test(r))) {
      const r = await require('./banco').ingestExcelBuffer(buf, { originalname: nombre });
      if (!r.ok) throw new Error(r.error || 'No se pudo leer el extracto de la cuenta');
      return { tipo: 'cuenta Santander', nuevos: r.nuevos, repetidos: r.repetidos, desde: r.periodo && r.periodo.desde, hasta: r.periodo && r.periodo.hasta };
    }
  }
  throw new Error('No reconozco el archivo. Sirven: el CSV de Revolut, el Excel de movimientos de una tarjeta de crédito de Santander o el Excel de la cuenta de Santander.');
}
// Dos movimientos idénticos (misma compra repetida en el mismo minuto) no son duplicados:
// se numeran dentro del archivo, así reimportar el mismo archivo da las mismas huellas.
function numerarHuellas(movs) {
  const vistos = {};
  return movs.map(m => { const n = (vistos[m.huella] = (vistos[m.huella] || 0) + 1); return n > 1 ? { ...m, huella: m.huella + '#' + n } : m; });
}
async function guardar(movs, tipo, nombre) {
  movs = numerarHuellas(movs);
  const db = await getDB();
  await db.collection('tarjetaMovimientos').createIndex({ huella: 1 }, { unique: true }).catch(() => {});
  await db.collection('tarjetaMovimientos').createIndex({ fecha: 1 }).catch(() => {});
  await sembrarTarjetas();
  let nuevos = 0, repetidos = 0;
  for (const m of movs) {
    // «estado» va solo en $set (cambia: Autorizado → Liquidado); repetirlo en $setOnInsert da conflicto en Mongo.
    const { estado, ...resto } = m;
    // Ya entró por la conexión automática con el banco (bancoSync): el CSV completa sus datos (tarjeta, quién, tipo).
    if (!m.ebRef && !(await db.collection('tarjetaMovimientos').findOne({ $or: [{ huella: m.huella }, { csvHuella: m.huella }] }, { projection: { _id: 1 } }))) {
      const gem = await require('./bancoSync').gemelaDeTarjeta(db, m);
      if (gem) {
        const { huella, fuente, fecha, importe, ...extra } = resto;
        await db.collection('tarjetaMovimientos').updateOne({ _id: gem._id }, { $set: { ...extra, csvHuella: m.huella, archivo: nombre || null, estado: estado == null ? null : estado } });
        repetidos++; continue;
      }
    }
    const r = await db.collection('tarjetaMovimientos').updateOne({ huella: m.huella }, { $setOnInsert: { ...resto, importadoEl: new Date(), archivo: nombre || null }, $set: { estado: estado == null ? null : estado } }, { upsert: true });
    if (r.upsertedCount) nuevos++; else repetidos++;
  }
  const fechas = movs.map(m => m.fecha).filter(Boolean).sort();
  return { tipo, nuevos, repetidos, desde: fechas[0] || null, hasta: fechas[fechas.length - 1] || null };
}

// Movimientos para el punteo (mismo formato que los del banco). Los internos, las cuotas y las
// recargas no son gastos con factura: van como «no requiere».
async function movimientosPunteo(R) {
  const db = await getDB();
  await sembrarTarjetas();
  const [ms, ts] = await Promise.all([
    db.collection('tarjetaMovimientos').find({ fecha: { $gte: R.from, $lte: R.to } }).sort({ fecha: 1 }).toArray(),
    db.collection('tarjetas').find({}).toArray(),
  ]);
  const persona = {}; ts.forEach(t => { persona[t._id] = t.persona; });
  return ms.filter(m => !/declined|reverted|failed/i.test(m.estado || '')).map(m => {
    const quien = m.tarjeta ? (persona[m.tarjeta] || m.titular || null) : null;
    const origen = m.fuente === 'revolut' ? `Revolut${m.tarjeta ? ' …' + m.tarjeta : ''}` : `Crédito …${m.tarjeta}`;
    let fijo = null;
    if (m.interno) fijo = { tipo: 'traspaso_propio', estado: 'no_requiere', nota: 'Traspaso entre cuentas propias de Revolut' };
    else if (m.tipo === 'FEE') fijo = { tipo: 'comision_banco', estado: 'no_requiere', nota: 'Cuota o comisión de la tarjeta' };
    return {
      id: String(m._id), fecha: m.fecha, concepto: m.concepto, importe: m.importe, saldo: null,
      codigo: m.tipo === 'TRANSFER' ? '072' : '136', categoria: null, contraparte: null,
      origen, persona: quien, fijo,
    };
  });
}

module.exports = { importar, parseRevolutCsv, parseSantanderCredito, movimientosPunteo, listaTarjetas, setPersona, TARJETAS_INICIALES };
