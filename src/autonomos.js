// src/autonomos.js — Autónomos que trabajan para Corp (no fichan: no son plantilla).
//
// Un autónomo es un usuario con `autonomo.activo`. No entra en el registro de jornada
// (ni fichajes, ni enlaces, ni avisos), pero SÍ en Presencia: qué día estuvo y en qué
// obra. Con eso se hace el CUADRE del mes: lo que sale según su tarifa frente a lo que
// él nos factura, para pagarle lo correcto y cargar su coste en cada obra.
//
//   user.autonomo = { activo, tarifaTipo:'dia'|'hora', tarifaDia, tarifaHora, nif, nombreFiscal, iva:21|10|0, irpf:0|1|7|15 }
//   (tarifas SIN IVA; iva 0 = inversión del sujeto pasivo en subcontratas de obra)
//   autonomoCuadres = { userId, mes:'YYYY-MM', facturado, numFactura, notas, estado:'pendiente'|'cuadrado', por, updatedAt }

async function getDB() { return require('./db').getDB(); }
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const HORAS_JORNADA = 8;

// Normaliza lo que llega del formulario. null = no es autónomo.
function limpiar(a) {
  if (!a || !a.activo) return null;
  const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(',', '.')); return Number.isFinite(n) && n > 0 ? r2(n) : null; };
  const tarifaTipo = a.tarifaTipo === 'hora' ? 'hora' : 'dia';
  const tarifaDia = num(a.tarifaDia), tarifaHora = num(a.tarifaHora);
  return {
    activo: true, tarifaTipo,
    tarifaDia: tarifaDia || (tarifaHora ? r2(tarifaHora * HORAS_JORNADA) : null),
    tarifaHora: tarifaHora || (tarifaDia ? r2(tarifaDia / HORAS_JORNADA) : null),
    nif: String(a.nif || '').trim().toUpperCase().slice(0, 20) || null,
    nombreFiscal: String(a.nombreFiscal || '').trim().slice(0, 120) || null,
    iva: [0, 10, 21].includes(Number(a.iva)) ? Number(a.iva) : 21,
    irpf: [0, 1, 7, 15].includes(Number(a.irpf)) ? Number(a.irpf) : 0,
  };
}
// Base → IVA, retención y total a pagar.
function importes(base, a) {
  const iva = a && a.iva != null ? Number(a.iva) : 21, irpf = a && a.irpf ? Number(a.irpf) : 0;
  const b = r2(base), cuotaIva = r2(b * iva / 100), retencion = r2(b * irpf / 100);
  return { base: b, iva, cuotaIva, irpf, retencion, total: r2(b + cuotaIva - retencion) };
}
function esAutonomo(u) { return !!(u && u.autonomo && u.autonomo.activo); }
// Coste/hora que usan las obras para un autónomo (su tarifa, no sueldo + SS).
function costeHora(u) {
  if (!esAutonomo(u)) return null;
  return u.autonomo.tarifaHora || (u.autonomo.tarifaDia ? r2(u.autonomo.tarifaDia / HORAS_JORNADA) : null);
}

async function lista() {
  const { getUsers } = require('./users');
  return (await getUsers(false)).filter(esAutonomo);
}

function rangoMes(mes) {
  if (!/^\d{4}-\d{2}$/.test(String(mes || ''))) throw new Error('Mes no válido (YYYY-MM)');
  const [y, m] = mes.split('-').map(Number);
  const fin = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${mes}-01`, to: `${mes}-${String(fin).padStart(2, '0')}`, y, m };
}

// Días de un autónomo en el mes, desde Presencia (los partes ya se reflejan ahí).
function diasDe(entries) {
  const { getObras } = require('./attendance');
  const dias = [];
  for (const e of entries) {
    const obras = getObras(e);
    const trabajado = obras.length || ['obra', 'oficina'].includes(e.estado);
    if (!trabajado) continue;
    const horasObras = obras.reduce((s, o) => s + (parseFloat(o.horas) || 0), 0);
    const horas = horasObras || parseFloat(e.horas) || HORAS_JORNADA;
    const lista = obras.length
      ? obras.map(o => ({ nombre: o.clientName || 'Sin obra', horas: parseFloat(o.horas) || (obras.length === 1 ? horas : 0) }))
      : [{ nombre: e.estado === 'oficina' ? 'Oficina / taller' : (e.clientName || 'Sin obra'), horas }];
    // Media jornada si el día tiene 4 h o menos; si no, jornada completa.
    dias.push({ fecha: e.date, horas: r2(horas), jornada: horas <= 4 ? 0.5 : 1, obras: lista, nota: e.notas || e.nota || '' });
  }
  return dias.sort((a, b) => a.fecha.localeCompare(b.fecha));
}

// Facturas/tickets que ha subido o mandado él (por NIF o nombre) en el mes y el siguiente.
async function facturasSuyas(db, a, nombre, desde, hasta) {
  const ors = [];
  if (a.nif) ors.push({ nif: a.nif });
  const claves = [a.nombreFiscal, nombre].map(norm).filter(x => x && x.length >= 4);
  for (const k of claves) ors.push({ proveedorNorm: { $regex: k.split(' ').filter(t => t.length > 2).join('.*') } });
  if (!ors.length) return [];
  const docs = await db.collection('compras').find({ $or: ors, estado: { $ne: 'descartada' }, $and: [{ $or: [{ fecha: { $gte: desde, $lte: hasta } }, { fecha: null, createdAt: { $gte: new Date(desde), $lte: new Date(hasta + 'T23:59:59Z') } }] }] })
    .project({ proveedor: 1, numero: 1, fecha: 1, base: 1, total: 1, tipo: 1, estado: 1, createdAt: 1 }).sort({ fecha: 1 }).limit(20).toArray();
  return docs.map(c => ({ id: String(c._id), proveedor: c.proveedor, numero: c.numero, fecha: c.fecha || (c.createdAt && c.createdAt.toISOString().slice(0, 10)), base: c.base != null ? r2(c.base) : null, total: c.total != null ? r2(c.total) : null, tipo: c.tipo, estado: c.estado }));
}

async function cuadre(mes) {
  const { from, to, y, m } = rangoMes(mes);
  const db = await getDB();
  const auts = await lista();
  const sig = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`;
  const hastaFact = `${sig}-${String(new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 0)).getUTCDate()).padStart(2, '0')}`;
  const out = [];
  for (const u of auts) {
    const id = String(u._id), a = u.autonomo;
    const [entries, guardado, facturas] = await Promise.all([
      db.collection('attendance').find({ workerId: id, date: { $gte: from, $lte: to } }).toArray(),
      db.collection('autonomoCuadres').findOne({ userId: id, mes }),
      facturasSuyas(db, a, u.name, from, hastaFact),
    ]);
    const dias = diasDe(entries);
    const jornadas = dias.reduce((s, d) => s + d.jornada, 0);
    const horas = dias.reduce((s, d) => s + d.horas, 0);
    const esperado = a.tarifaTipo === 'hora' ? r2(horas * (a.tarifaHora || 0)) : r2(jornadas * (a.tarifaDia || 0));
    const porObra = {};
    for (const d of dias) for (const o of d.obras) {
      const k = o.nombre; const p = (porObra[k] = porObra[k] || { nombre: k, dias: 0, horas: 0 });
      p.dias += d.obras.length > 1 ? 0 : d.jornada; p.horas += o.horas;
    }
    const obras = Object.values(porObra).map(p => ({ ...p, horas: r2(p.horas), coste: r2(p.horas * (costeHora(u) || 0)) })).sort((x, z) => z.horas - x.horas);
    const facturado = guardado && guardado.facturado != null ? r2(guardado.facturado) : null;
    out.push({
      userId: id, nombre: u.name, telefono: u.telefono || null,
      tarifa: { tipo: a.tarifaTipo, dia: a.tarifaDia, hora: a.tarifaHora }, nif: a.nif, nombreFiscal: a.nombreFiscal,
      iva: a.iva != null ? a.iva : 21, irpf: a.irpf || 0,
      dias, nDias: dias.length, jornadas, horas: r2(horas), esperado, esperadoImportes: importes(esperado, a), obras,
      facturas,
      facturado, numFactura: (guardado && guardado.numFactura) || null, notas: (guardado && guardado.notas) || '',
      estado: (guardado && guardado.estado) || 'pendiente',
      facturadoImportes: facturado != null ? importes(facturado, a) : null,
      diferencia: facturado != null ? r2(facturado - esperado) : null,   // se compara la BASE (sin IVA)
      sinTarifa: !(a.tarifaDia || a.tarifaHora),
    });
  }
  return { mes, from, to, autonomos: out };
}

async function guardarCuadre(userId, mes, data = {}, por) {
  rangoMes(mes);
  const db = await getDB();
  const set = { userId: String(userId), mes, updatedAt: new Date(), por: por || '' };
  if (data.facturado !== undefined) {
    const n = parseFloat(String(data.facturado == null ? '' : data.facturado).replace(',', '.'));
    set.facturado = Number.isFinite(n) ? r2(n) : null;
  }
  if (data.numFactura !== undefined) set.numFactura = String(data.numFactura || '').trim().slice(0, 60) || null;
  if (data.notas !== undefined) set.notas = String(data.notas || '').trim().slice(0, 500);
  if (data.estado !== undefined) set.estado = data.estado === 'cuadrado' ? 'cuadrado' : 'pendiente';
  await db.collection('autonomoCuadres').updateOne({ userId: String(userId), mes }, { $set: set }, { upsert: true });
  return { ok: true };
}

module.exports = { importes, limpiar, esAutonomo, costeHora, lista, cuadre, guardarCuadre, diasDe, HORAS_JORNADA };
