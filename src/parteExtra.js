// src/parteExtra.js — Lo que completa el parte del operario (fase 2 de trabajos.js, 21/10/2026):
//   · obra(): la obra del parte si el operario no la eligió — la del trabajo asignado o la que se llama como el cliente;
//   · valorarMateriales(): el material sin precio se valora con el precio medio del almacén o, si no, con el de la
//     última compra que lo lleve (para que en la rentabilidad no cuente 0 €). Se apunta de dónde sale el precio;
//   · albaranesACompras(): cada foto de albarán del parte entra en Compras con su obra (la IA la lee como cualquier
//     compra por foto); el parte guarda qué compras se crearon;
//   · firma(): la firma opcional de quien abrió (vecino, presidente…), pequeña y validada.
'use strict';
const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const VACIAS = new Set(['ctat', 'prop', 'comunitat', 'comunidad', 'propietaris', 'propietarios', 'calle', 'carrer', 'plaza', 'placa', 'plza', 'macro', 'de', 'del', 'la', 'el', 'les', 'els', 'y', 'i']);
const pals = s => (norm(s).match(/[a-z]{3,}|\d+/g) || []).filter(w => !VACIAS.has(w));
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

// Obra del parte: la elegida > la del trabajo asignado > la obra abierta que se llama como el cliente.
async function obra({ obraId = null, workOrderId = null, clientName = '' } = {}, { _db = null } = {}) {
  const db = _db || await getDB();
  if (obraId && ObjectId.isValid(String(obraId))) return { obraId: String(obraId), fuente: 'elegida' };
  if (workOrderId) {
    const a = await db.collection('workOrderAssignments').findOne({ workOrderId: String(workOrderId) });
    if (a && a.obraId) return { obraId: String(a.obraId), fuente: 'trabajo' };
    if (a && a.cliente && !clientName) clientName = a.cliente;
  }
  const w = pals(clientName);
  if (w.length < 2) return { obraId: null, fuente: null };
  const obras = await db.collection('obras').find({ status: { $in: ['activa', 'estudio', 'pausada'] } }).project({ reference: 1, clientName: 1, aliases: 1 }).toArray();
  const casa = o => [o.reference, o.clientName, ...(o.aliases || [])].some(n => { const x = pals(n); return x.length >= 2 && w.every(k => x.includes(k)) || (x.length >= 2 && x.every(k => w.includes(k))); });
  const ok = obras.filter(casa);
  return ok.length === 1 ? { obraId: String(ok[0]._id), obraRef: ok[0].reference, fuente: 'nombre' } : { obraId: null, fuente: ok.length > 1 ? 'varias' : null };
}

// Precio del material sin precio: almacén (precio medio) > última compra (importe/cantidad de la línea).
async function valorarMateriales(materiales, { _db = null } = {}) {
  const lista = (Array.isArray(materiales) ? materiales : []).filter(m => m && String(m.nombre || m.name || '').trim());
  if (!lista.length) return [];
  const db = _db || await getDB();
  const A = require('./almacen');
  const art = await db.collection('almacen').find({}).project({ nombre: 1, precioUd: 1, unidad: 1 }).toArray().catch(() => []);
  const desde = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
  const compras = await db.collection('compras').find({ fecha: { $gte: desde }, estado: { $in: ['revisada', 'archivo', 'por_revisar'] }, duplicadoDe: null }).project({ lineas: 1, proveedor: 1, fecha: 1 }).sort({ fecha: -1 }).limit(800).toArray();
  return lista.map(m => {
    const nombre = String(m.nombre || m.name).trim();
    const cantidad = Number(String(m.cantidad == null ? 1 : m.cantidad).replace(',', '.')) || 1;
    const precio = Number(m.precio) || 0;
    if (precio > 0) return { ...m, nombre, cantidad, precio, precioFuente: m.precioFuente || 'operario' };
    const k = A._norm(nombre);
    const a = art.find(x => A._norm(x.nombre) === k) || art.find(x => { const n = A._norm(x.nombre); return k.length >= 5 && (n.includes(k) || k.includes(n)); });
    if (a && Number(a.precioUd) > 0) return { ...m, nombre, cantidad, precio: r2(a.precioUd), precioFuente: `almacén (${a.nombre})` };
    const w = pals(nombre);
    if (w.length) {
      for (const c of compras) for (const l of c.lineas || []) {
        const lw = pals(l.descripcion);
        if (w.every(x => lw.includes(x)) && Number(l.importe) > 0 && Number(l.cantidad) > 0) return { ...m, nombre, cantidad, precio: r2(Number(l.importe) / Number(l.cantidad)), precioFuente: `compra ${c.proveedor || ''} ${c.fecha || ''}`.trim() };
      }
    }
    return { ...m, nombre, cantidad, precio: 0, precioFuente: null };
  });
}

// Fotos de albarán del parte → Compras (una compra por foto), con la obra del parte.
async function albaranesACompras(parte, fotos = [], { _crear = null } = {}) {
  const ids = [];
  for (const f of fotos) {
    try {
      const r = await (_crear || require('./compras').crear)({
        fotos: [{ data: f.buffer, mimetype: f.mimetype || 'image/jpeg' }], obraId: parte.obraId || null, destino: 'obra', origen: 'parte',
        nota: `Albarán del parte de ${parte.workerName} (${parte.date}${parte.workOrderNumber ? ' · ' + parte.workOrderNumber : ''}${parte.clientName ? ' · ' + parte.clientName : ''})`.slice(0, 300),
        subidaPor: { kind: 'worker', userId: String(parte.workerId), name: parte.workerName },
      });
      if (r && r.id) ids.push(String(r.id));
    } catch (e) { console.warn('[Parte] albarán → compras:', e.message); }
  }
  return ids;
}

// Firma opcional: PNG en data URL, máximo ~250 KB; con el nombre de quien firma.
function firma(f) {
  if (!f || typeof f !== 'object') return null;
  const png = String(f.png || '');
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(png) || png.length > 350000 || png.length < 200) return null;
  return { nombre: String(f.nombre || '').trim().slice(0, 80), png, at: new Date() };
}

module.exports = { obra, valorarMateriales, albaranesACompras, firma, _pals: pals };
