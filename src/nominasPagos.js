// src/nominasPagos.js — NÓMINAS PAGADAS Y PENDIENTES: el líquido de cada nómina (docsPersonal, leído por la IA)
// frente a las transferencias del banco a ese trabajador.
//
// Las nóminas se pagan a trozos (adelantos, «tres hoy y tres otro día»): cada transferencia a un trabajador se
// reparte, por orden de fecha, a su nómina más antigua sin pagar (de ese mes o el anterior). Lo que no cabe en
// ninguna nómina sale como «pagos sin nómina» (adelantos del mes siguiente, o falta subir la nómina).
//
// Quién es quién en el banco: todas las palabras del nombre del trabajador (≥3 letras) en el concepto, o un alias
// (`users.aliasBanco`; p. ej. el usuario «David Taladros» cobra como «David Valencia»).
'use strict';
async function getDB() { return require('./db').getDB(); }
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();
const ALIAS = { 'david taladros': ['david valencia'] };      // los que ya sabemos; el resto en users.aliasBanco
const mesMas = (mes, n) => { const [y, m] = mes.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };

function nombresDe(u) {
  const base = [u.name, ...(ALIAS[norm(u.name)] || []), ...((u.aliasBanco || []))].map(norm).filter(Boolean);
  return base.map(n => n.split(' ').filter(w => w.length >= 3)).filter(ws => ws.length);
}
function esDe(concepto, u) {
  const c = norm(concepto);
  return nombresDe(u).some(ws => (ws.length >= 2 ? ws.slice(0, 2) : ws).every(w => c.includes(w)));
}

// meses: 'AAAA-MM' del que se quiere ver (se cuentan también los 2 anteriores para repartir bien los pagos).
async function estado(mes, { hoy = new Date() } = {}) {
  if (!/^\d{4}-\d{2}$/.test(String(mes || ''))) mes = hoy.toISOString().slice(0, 7);
  const db = await getDB();
  const meses = [mesMas(mes, -2), mesMas(mes, -1), mes];
  const desde = meses[0] + '-01', hasta = mesMas(mes, 1) + '-25';
  const [users, noms, movs] = await Promise.all([
    require('./users').getUsers(false),
    db.collection('docsPersonal').find({ tipo: 'nomina', mes: { $in: meses } }).project({ data: 0 }).toArray(),
    db.collection('bancoMovimientos').find({ fechaOperacion: { $gte: desde, $lte: hasta }, importe: { $lt: 0 } }).toArray(),
  ]);
  // Asalariados: ni autónomos (facturan) ni el dueño; y un nombre de una sola palabra («Alex») casaría con cualquiera.
  const plantilla = users.filter(u => u.active !== false && !u.autonomo && ['tecnico', 'encargado', 'oficina'].includes(require('./users').normalizeRole(u.role)) && nombresDe(u).some(ws => ws.length >= 2));
  const out = [];
  for (const u of plantilla) {
    const suyas = noms.filter(n => String(n.userId) === String(u._id)).sort((a, b) => a.mes.localeCompare(b.mes));
    const pagos = movs.filter(m => (m.categoria === 'nomina' || /transferencia|a favor de|bizum/i.test(m.concepto || '')) && esDe(m.concepto, u))
      .sort((a, b) => a.fechaOperacion.localeCompare(b.fechaOperacion)).map(m => ({ fecha: m.fechaOperacion, importe: r2(-m.importe), concepto: m.concepto, restante: r2(-m.importe) }));
    // Reparto: cada pago, a la nómina más antigua sin pagar cuyo mes sea ≤ el del pago (o el anterior).
    const estadoNom = suyas.map(n => ({ id: String(n._id), mes: n.mes, liquido: n.importes && n.importes.liquido != null ? n.importes.liquido : null, pagado: 0, pagos: [] }));
    for (const p of pagos) {
      for (const n of estadoNom) {
        if (p.restante <= 0.01) break;
        if (n.liquido == null || n.mes > p.fecha.slice(0, 7)) continue;
        const falta = r2(n.liquido - n.pagado); if (falta <= 0.01) continue;
        const usa = r2(Math.min(falta, p.restante));
        n.pagado = r2(n.pagado + usa); n.pagos.push({ fecha: p.fecha, importe: usa }); p.restante = r2(p.restante - usa);
      }
    }
    const delMes = estadoNom.find(n => n.mes === mes) || null;
    const sinNomina = pagos.filter(p => p.restante > 0.01 && p.fecha >= mes + '-01').map(p => ({ fecha: p.fecha, importe: p.restante, concepto: p.concepto }));
    const anteriores = estadoNom.filter(n => n.mes < mes && n.liquido != null && n.liquido - n.pagado > 0.01).map(n => ({ mes: n.mes, falta: r2(n.liquido - n.pagado) }));
    if (!delMes && !sinNomina.length && !anteriores.length) continue;
    out.push({
      userId: String(u._id), nombre: u.name,
      nomina: delMes ? { id: delMes.id, liquido: delMes.liquido, pagado: delMes.pagado, falta: delMes.liquido != null ? r2(delMes.liquido - delMes.pagado) : null, pagos: delMes.pagos } : null,
      estado: !delMes ? 'sin_nomina' : delMes.liquido == null ? 'sin_importe' : delMes.liquido - delMes.pagado <= 0.01 ? 'pagada' : delMes.pagado > 0 ? 'parcial' : 'pendiente',
      sinNomina, anteriores,
    });
  }
  const tot = k => r2(out.reduce((a, x) => a + ((x.nomina && x.nomina[k]) || 0), 0));
  return { mes, trabajadores: out.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')), totales: { liquido: tot('liquido'), pagado: tot('pagado'), falta: tot('falta'),
    pagadas: out.filter(x => x.estado === 'pagada').length, nominas: out.filter(x => x.nomina).length, sinImporte: out.filter(x => x.estado === 'sin_importe').length } };
}

// Para el WhatsApp del banco: a quién es la transferencia y cómo queda su nómina.
async function lineaPago(concepto, fecha) {
  const users = (await require('./users').getUsers(false)).filter(u => u.active !== false);
  const u = users.find(x => esDe(concepto, x)); if (!u) return null;
  for (const mes of [fecha.slice(0, 7), mesMas(fecha.slice(0, 7), -1)]) {
    const e = await estado(mes); const t = e.trabajadores.find(x => x.userId === String(u._id));
    if (t && t.nomina) return t.estado === 'pagada' ? `nómina de ${mes} de ${u.name.split(' ')[0]}: pagada` : t.nomina.falta != null ? `nómina de ${mes} de ${u.name.split(' ')[0]}: falta ${t.nomina.falta.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €` : null;
  }
  return null;
}

module.exports = { estado, lineaPago, esDe, nombresDe };
