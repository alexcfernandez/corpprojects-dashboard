// src/horasFacturables.js — Por día y trabajador: lo que fichó DE VERDAD y lo que se factura (mínimo 8 h
// por día trabajado; si fichó más, lo real). Para ver quién está por debajo o por encima y cuánto
// facturar a cada obra.
//
// Fuentes: las marcas del fichaje (registro legal, se reconstruyen como en la app) y la Presencia del día
// (obra, estado, horas que puso oficina).

async function getDB() { return require('./db').getDB(); }
const r1 = n => Math.round((Number(n) || 0) * 100) / 100;
const MINIMO = () => Number(process.env.JORNADA_HORAS || 8);
const hhmm = d => (d ? new Date(d).toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' }) : null);

async function informe({ desde, hasta } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(desde)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(hasta))) throw new Error('Fechas no válidas');
  const fm = require('./fichajeMarcas');
  const db = await getDB();
  const [marcas, pres, usuarios] = await Promise.all([
    db.collection('fichajeMarcas').find({ fecha: { $gte: desde, $lte: hasta } }).sort({ hora: 1 }).toArray(),
    db.collection('attendance').find({ date: { $gte: desde, $lte: hasta } }).toArray(),
    require('./users').getUsers(false).catch(() => []),
  ]);
  // Desde cuándo ficha toda la plantilla (antes, «no fichó» no tiene sentido; hay marcas sueltas de prueba).
  const fichajeDesde = process.env.FICHAJE_DESDE || '2026-10-01';
  const nombre = {}; (usuarios || []).forEach(u => { nombre[String(u._id)] = u.name; });
  const autonomo = {}; (usuarios || []).forEach(u => { if (u.autonomo && u.autonomo.activo) autonomo[String(u._id)] = true; });

  const porDia = {};   // userId|fecha → marcas
  marcas.forEach(m => { const k = `${m.userId}|${m.fecha}`; (porDia[k] = porDia[k] || []).push(m); if (m.userName) nombre[m.userId] = nombre[m.userId] || m.userName; });
  const presDe = {}; pres.forEach(a => { presDe[`${a.workerId}|${a.date}`] = a; if (a.workerName) nombre[a.workerId] = nombre[a.workerId] || a.workerName; });

  const claves = new Set([...Object.keys(porDia), ...pres.filter(a => a.estado === 'obra').map(a => `${a.workerId}|${a.date}`)]);
  const filas = [];
  for (const k of claves) {
    const [userId, fecha] = k.split('|');
    const p = presDe[k] || null;
    if (p && p.estado && p.estado !== 'obra') continue;                       // baja, vacaciones, festivo…
    const rec = porDia[k] ? fm.reconstruir(porDia[k], fecha) : null;
    const real = rec ? r1(rec.minutos / 60) : null;
    const abierto = !!rec && (rec.sinCerrar || (rec.estado !== 'fuera' && fecha === fm.fechaHoy()));
    const tramos = rec ? rec.tramos : [];
    // A facturar: mínimo 8 h por día trabajado; si fichó más, lo real. Si oficina escribió las horas a mano, esas.
    const base = p && p.horasManual ? Number(p.horas) || 0 : (real != null ? real : (p ? Number(p.horas) || 0 : 0));
    const facturar = r1(Math.max(MINIMO(), base));
    const obras = p && Array.isArray(p.obras) && p.obras.length ? p.obras.filter(o => o && o.clientName) : (p && p.clientName ? [{ clientName: p.clientName, horas: p.horas }] : []);
    filas.push({
      fecha, userId, nombre: nombre[userId] || userId,
      obras: obras.map(o => o.clientName), obrasHoras: obras.map(o => Number(o.horas) || 0),
      entrada: hhmm(tramos[0] && tramos[0].entrada), salida: hhmm(tramos.length && tramos[tramos.length - 1].salida),
      pausas: Math.max(0, tramos.length - 1),
      real, facturar, enPresencia: p ? r1(p.horas) : null, horasManual: !!(p && p.horasManual),
      diferencia: real != null ? r1(real - MINIMO()) : null,
      aviso: (porDia[k] || []).some(m => m.estado === 'pendiente') ? 'corrección pendiente de aprobar' : abierto ? (fecha === fm.fechaHoy() ? 'en curso' : 'no fichó la salida') : (real == null ? (autonomo[userId] ? 'autónomo (no ficha)' : (fichajeDesde && fecha < fichajeDesde ? 'antes del fichaje' : 'no fichó')) : (real < 6 ? 'jornada corta' : null)),
    });
  }
  filas.sort((a, b) => b.fecha.localeCompare(a.fecha) || a.nombre.localeCompare(b.nombre));

  // Reparto por obra: si el día tiene varias obras, en proporción a sus horas (o a partes iguales).
  const porObra = {}, porTrab = {};
  for (const f of filas) {
    const lista = f.obras.length ? f.obras : ['Sin obra'];
    const pesos = f.obras.length ? f.obrasHoras : [1];
    const tot = pesos.reduce((a, b) => a + b, 0);
    lista.forEach((o, i) => {
      const parte = tot > 0 ? pesos[i] / tot : 1 / lista.length;
      const g = (porObra[o] = porObra[o] || { obra: o, dias: 0, real: 0, facturar: 0, sinFichaje: 0 });
      g.dias = r1(g.dias + parte); g.facturar = r1(g.facturar + f.facturar * parte);
      if (f.real != null) g.real = r1(g.real + f.real * parte); else g.sinFichaje++;
    });
    const t = (porTrab[f.userId] = porTrab[f.userId] || { userId: f.userId, nombre: f.nombre, dias: 0, real: 0, facturar: 0, diasMenos: 0, diasMas: 0, sinSalida: 0 });
    t.dias++; t.facturar = r1(t.facturar + f.facturar);
    if (f.real != null) { t.real = r1(t.real + f.real); if (f.real < MINIMO() - 0.05) t.diasMenos++; if (f.real > MINIMO() + 0.05) t.diasMas++; }
    if (f.aviso === 'no fichó la salida') t.sinSalida++;
  }
  const conReal = filas.filter(f => f.real != null);
  return {
    desde, hasta, minimo: MINIMO(),
    totales: { dias: filas.length, real: r1(conReal.reduce((a, f) => a + f.real, 0)), facturar: r1(filas.reduce((a, f) => a + f.facturar, 0)), diasConFichaje: conReal.length,
      diasMenos: conReal.filter(f => f.real < MINIMO() - 0.05).length, diasMas: conReal.filter(f => f.real > MINIMO() + 0.05).length },
    porObra: Object.values(porObra).sort((a, b) => b.facturar - a.facturar),
    porTrabajador: Object.values(porTrab).sort((a, b) => a.nombre.localeCompare(b.nombre)),
    filas,
  };
}

module.exports = { informe };
