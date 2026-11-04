// src/ciclo.js — TABLERO DEL CICLO DE UN TRABAJO (2/11/2026, Álex: «incidencia → parte de trabajo → el técnico lo recibe
// → horas, materiales, trabajos realizados, si se ha acabado o no → factura → cobro. Que se vea en el dashboard muy
// claro, como en modo restaurante: amarillo pendiente de muchos días, rojo, bien vistoso»).
// Como el «job board» de los programas de servicios técnicos (ServiceTitan, Jobber, simPRO…) y la pantalla de cocina
// de un restaurante: una columna por paso, una tarjeta por trabajo, y el color dice cuánto lleva parada en ESE paso.
//   📥 Por asignar → 📞 Sin cita → 📅 Programado → 🧾 Por facturar → 💶 Por cobrar → ✅ Cobrado
// Y aparte la fila de presupuestos: 📝 Por hacer → 📤 Enviado esperando respuesta.
// Solo lectura de StelOrder (con las cachés de siempre, sin gastar cupo) + nuestra base: asignaciones, partes, peticiones.
// El enlace pedido → factura sale de StelOrder: la factura generada desde el pedido guarda `parent-document-id`.

const TZ = 'Europe/Madrid';
const VIVO_NO = /cerrad|rechazad/i;
const INC_ABIERTA = /pendiente|en proceso|programado|parte de trabajo/i;
// Días en el paso a partir de los cuales la tarjeta se pone ámbar / roja.
const LIMITES = {
  asignar: [2, 4], asignarUrgente: [0, 1], cita: [2, 4], facturar: [3, 7], cobrar: [30, 60],
  presupuesto: [3, 7], enviado: [15, 30],
};
const COBRADO_DIAS = 15, FACTURAR_DIAS = 90, ENVIADOS_DIAS = 180;

const hoyStr = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
// StelOrder trae «2026-10-13T00:00:00+0000» (día local); Mongo trae Date.
const ymd = x => { if (!x) return null; if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x)) return x.slice(0, 10); const d = new Date(x); return isNaN(d) ? null : d.toLocaleDateString('en-CA', { timeZone: TZ }); };
const entre = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const diasDesde = (f, hoy) => { const d = ymd(f); return d ? Math.max(0, entre(d, hoy)) : 0; };
const color = (d, [ambar, rojo]) => d >= rojo ? 'rojo' : d >= ambar ? 'ambar' : 'verde';
const corto = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const fechaCorta = (f, hoy) => { if (!f) return ''; const d = entre(hoy, f); if (d === 0) return 'hoy'; if (d === 1) return 'mañana'; if (d === -1) return 'ayer'; const x = new Date(f + 'T12:00:00Z'); return `${DIAS[x.getUTCDay()]} ${x.getUTCDate()}/${x.getUTCMonth() + 1}`; };

async function datos({ _S = null, _db = null } = {}) {
  const S = _S || require('./stelorder');
  const db = _db || await require('./db').getDB();
  const hoy = hoyStr();
  const [incs, incSt, tm, { clientMap }, wos, woSt, facMap0, ests] = await Promise.all([
    S.getAllIncidents(), S.getIncidentStateMap(), S.getIncidentTypeMaps(), S.getClients(),
    S.getAllWorkOrders(), S.getWorkOrderStateMap(), S.getAllOrdinaryInvoices().catch(() => ({})), S.getWorkEstimates().catch(() => []),
  ]);
  // Copia de facturas de antes del 2/11/2026 (sin el pedido del que salen): se renueva una vez (2 llamadas a StelOrder).
  let facMap = facMap0;
  const unaFac = Object.values(facMap || {})[0];
  if (unaFac && unaFac.lineParents === undefined && S.invalidate) { try { S.invalidate('ordinaryInvoices'); facMap = await S.getAllOrdinaryInvoices(); } catch (e) {} }
  const tipos = (tm && tm.typeName) || {};
  const cliente = id => { const c = clientMap[String(id)]; return c ? (c['legal-name'] || c.name || '') : ''; };

  const [asigs, timers, ignorados] = await Promise.all([
    db.collection('workOrderAssignments').find({}).toArray(),
    db.collection('workOrderTimers').find({ finishedAt: null }).toArray(),
    db.collection('cicloIgnorar').find({}).toArray(),
  ]);
  const asig = new Map(asigs.map(a => [String(a.workOrderId), a]));
  const trabajando = new Map(timers.map(t => [String(t.workOrderId), t]));
  const ignorar = new Set(ignorados.map(x => String(x._id)));

  // Facturas por pedido del que salen
  const facDe = new Map();
  for (const [id, f] of Object.entries(facMap || {})) {
    for (const p of [f.parentId, ...(f.lineParents || [])].filter(Boolean)) {
      if (!facDe.has(p)) facDe.set(p, []);
      facDe.get(p).push({ id, ...f });
    }
  }
  const facPorRef = new Map(Object.entries(facMap || {}).map(([id, f]) => [f.number, { id, ...f }]));

  // Incidencias
  const incPorId = new Map((incs || []).filter(i => !i.deleted).map(i => [String(i.id), i]));
  const incInfo = i => i && ({ id: String(i.id), ref: i['full-reference'], fecha: ymd(i.date), estado: String(incSt[i['incident-state-id']] || '').trim(), tipo: String(tipos[i['incident-type-id']] || '').trim(), que: i.description || '', cliente: cliente(i['account-id']) });

  // Partes enlazados a pedidos
  const woIds = (wos || []).filter(w => !w.deleted).map(w => String(w.id));
  const partes = await db.collection('partes').find({ workOrderId: { $in: woIds } }, { projection: { workOrderId: 1, workerName: 1, date: 1, horas: 1, materiales: 1, description: 1, estadoTrabajo: 1, pendienteDetalle: 1, status: 1, facturaRef: 1, createdAt: 1 } }).sort({ date: 1 }).toArray();
  const partesDe = new Map();
  partes.forEach(p => { const k = String(p.workOrderId); if (!partesDe.has(k)) partesDe.set(k, []); partesDe.get(k).push(p); });

  // Peticiones (grupos y correo)
  const pets = await db.collection('peticionesGrupo').find({ estado: 'pendiente', noCliente: { $exists: false }, tipo: { $in: ['trabajo', 'queja', 'presupuesto'] } }).sort({ fecha: -1 }).limit(200).toArray();
  const petPorInc = new Map(pets.filter(p => p.incidencia).map(p => [p.incidencia, p]));

  const tarjetas = [], presupuestos = [];
  const conPedido = new Set();
  const limpieza = [];

  for (const w of (wos || [])) {
    if (w.deleted) continue;
    const id = String(w.id);
    const estadoPed = String(woSt[String(w['document-state-id'])] || '').trim();
    const a = asig.get(id) || null;
    const inc = incInfo(incPorId.get(String(w['parent-incident-id'] || '')));
    if (inc) conPedido.add(inc.ref);
    const facs = (facDe.get(id) || []).slice();
    if (!facs.length && a && a.facturaRef && facPorRef.has(a.facturaRef)) facs.push(facPorRef.get(a.facturaRef));
    const ps = partesDe.get(id) || [];
    const ultimoParte = ps[ps.length - 1] || null;
    const hecho = (a && (a.status === 'done' || a.status === 'invoiced')) || ps.some(p => p.estadoTrabajo === 'completado');
    const vivo = !VIVO_NO.test(estadoPed);
    const esPres = !!(inc && /presupuesto/i.test(inc.tipo));
    if (ignorar.has('wo:' + id)) continue;

    // ¿En qué columna está?
    let col = null, desde = null, lim = null, etiqueta = '';
    const totalFac = r2(facs.reduce((s, f) => s + (Number(f.total) || 0), 0));
    const pendFac = r2(facs.reduce((s, f) => s + (f.pendiente == null ? (Number(f.total) || 0) : Number(f.pendiente)), 0));
    // Ya facturado y la incidencia sigue abierta en StelOrder: candidata a cerrar en la limpieza
    if (facs.length && inc && INC_ABIERTA.test(inc.estado) && !limpieza.some(x => x.ref === inc.ref)) limpieza.push({ ref: inc.ref, cliente: inc.cliente, que: corto(inc.que, 80), motivo: `ya facturada (${facs.map(f => f.number).join(', ')})` });
    if (facs.length) {
      const fFac = facs.map(f => ymd(f.date)).sort()[0];
      if (pendFac > 0.01) { col = 'cobrar'; desde = fFac; lim = LIMITES.cobrar; etiqueta = `${pendFac.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} € sin cobrar`; }
      else {
        const fMod = facs.map(f => ymd(f.modificada) || ymd(f.date)).sort().pop();
        if (diasDesde(fMod, hoy) > COBRADO_DIAS) continue;
        col = 'cobrado'; desde = fMod; lim = [9999, 9999]; etiqueta = 'cobrado';
      }
    } else if (inc && /facturad/i.test(inc.estado)) {
      continue;   // la incidencia dice Facturado aunque la factura no salga del pedido (factura agrupada o hecha aparte)
    } else if (hecho || (!vivo && /cerrad/i.test(estadoPed))) {
      if (!hecho && esPres) continue;   // una visita para presupuestar no se factura
      const fHecho = ymd((a && a.doneAt) || (ultimoParte && ultimoParte.date) || w['utc-last-modification-date'] || w.date);
      if (diasDesde(fHecho, hoy) > FACTURAR_DIAS) continue;   // cerrados viejos: fuera (eso es la limpieza, no el día a día)
      col = 'facturar'; desde = fHecho; lim = LIMITES.facturar;
      etiqueta = hecho ? 'parte hecho, sin factura' : '¿cerrado en StelOrder sin factura?';
    } else if (vivo) {
      if (esPres && (!a || !a.userId)) { col = 'porHacer'; desde = (inc && inc.fecha) || ymd(w.date); lim = LIMITES.presupuesto; etiqueta = 'presupuesto por hacer'; }
      else if (!a || !a.userId) { col = 'asignar'; desde = ymd(w.date) || (inc && inc.fecha); lim = (a && a.priority === 'urgent') ? LIMITES.asignarUrgente : LIMITES.asignar; etiqueta = 'pedido sin técnico'; }
      else if (!a.fecha) { col = 'cita'; desde = ymd(a.reabiertoAt || a.assignedAt || w.date); lim = LIMITES.cita; etiqueta = a.motivoPendiente ? `hay que volver: ${corto(a.motivoPendiente, 40)}` : 'queda con el cliente'; }
      else {
        col = 'programado';
        const atraso = entre(a.fecha, hoy);   // >0 = la cita ya pasó y no hay parte
        desde = a.fecha; lim = null;
        etiqueta = atraso > 0 ? `era ${fechaCorta(a.fecha, hoy)}${a.hora ? ' ' + a.hora : ''} · falta el parte` : `${fechaCorta(a.fecha, hoy)}${a.hora ? ' ' + a.hora : ''}`;
      }
    } else continue;

    const dias = col === 'programado' ? Math.max(0, entre(desde, hoy)) : diasDesde(desde, hoy);
    const semaforo = col === 'programado' ? (dias >= 2 ? 'rojo' : dias === 1 ? 'ambar' : 'verde') : color(dias, lim);
    const pet = inc ? petPorInc.get(inc.ref) : null;
    const operario = (a && a.userName) || (ultimoParte && ultimoParte.workerName) || '';
    const que = (a && a.resumen) || (inc && inc.que) || (w.lines || []).filter(l => !l.deleted).map(l => l['item-description'] || l['item-name']).filter(Boolean).join(' · ') || w.title || '';
    const t = trabajando.get(id);

    (col === 'porHacer' ? presupuestos : tarjetas).push({
      id: 'wo:' + id, col, dias, semaforo, etiqueta, cerrable: !!(inc && INC_ABIERTA.test(inc.estado) && (col === 'porHacer' || col === 'asignar')),
      ref: w['full-reference'], incRef: inc && inc.ref, incId: inc && inc.id, woId: id,
      facturas: facs.map(f => ({ id: f.id, ref: f.number, total: r2(f.total), pendiente: f.pendiente == null ? null : r2(f.pendiente), fecha: ymd(f.date) })),
      cliente: (a && a.cliente) || cliente(w['account-id']) || (inc && inc.cliente) || '',
      que: corto(que, 160), direccion: (a && a.direccion) || (pet && pet.direccion) || '',
      operario, equipo: (a && a.equipo) || [], urgente: !!(a && a.priority === 'urgent') || !!(pet && pet.urgente),
      tipo: (inc && inc.tipo) || estadoPed, estadoPedido: estadoPed,
      trabajandoAhora: t ? { quien: t.workerName, desde: t.startedAt } : null,
      importe: col === 'cobrar' ? pendFac : (facs.length ? totalFac : null),
      pasos: pasos({ inc, pet, w, a, ps, facs, hoy }),
    });
  }

  // Incidencias abiertas sin pedido: presupuestos por hacer o trabajos por asignar
  for (const i of incPorId.values()) {
    const x = incInfo(i);
    if (!INC_ABIERTA.test(x.estado) || conPedido.has(x.ref) || ignorar.has('inc:' + x.ref)) continue;
    const pet = petPorInc.get(x.ref);
    const esPres = /presupuesto/i.test(x.tipo);
    const dias = diasDesde(x.fecha, hoy);
    const urg = !!(pet && pet.urgente);
    const t = {
      id: 'inc:' + x.ref, col: esPres ? 'porHacer' : 'asignar', dias,
      semaforo: color(dias, esPres ? LIMITES.presupuesto : urg ? LIMITES.asignarUrgente : LIMITES.asignar),
      etiqueta: esPres ? 'presupuesto por hacer' : (pet && pet.quienPreguntadoAt ? 'Corpy te ha preguntado quién va' : 'sin pedido ni técnico'),
      ref: x.ref, incRef: x.ref, incId: x.id, cliente: x.cliente || (pet && pet.cliente) || '', que: corto((pet && pet.resumen) || x.que, 160),
      direccion: (pet && pet.direccion) || '', urgente: urg, tipo: x.tipo, estadoInc: x.estado, origen: pet ? (pet.grupo || 'grupo') : 'StelOrder',
      pasos: pasos({ inc: x, pet, hoy }), cerrable: true,
    };
    (esPres ? presupuestos : tarjetas).push(t);
  }
  // Peticiones que aún no tienen incidencia
  for (const p of pets.filter(p => !p.incidencia)) {
    const dias = diasDesde(p.fecha, hoy);
    const esPres = p.tipo === 'presupuesto';
    const t = {
      id: 'pet:' + p._id, col: esPres ? 'porHacer' : 'asignar', dias, semaforo: color(dias, esPres ? LIMITES.presupuesto : p.urgente ? LIMITES.asignarUrgente : LIMITES.asignar),
      etiqueta: 'pedido sin incidencia todavía', ref: 'sin INC', cliente: p.cliente || '', que: corto(p.resumen, 160), direccion: p.direccion || '',
      urgente: !!p.urgente, tipo: p.tipo, origen: p.grupo || 'grupo', pasos: pasos({ pet: p, hoy }), peticionId: String(p._id), descartable: true,
    };
    (esPres ? presupuestos : tarjetas).push(t);
  }
  // Presupuestos enviados esperando respuesta
  const limEnv = new Date(Date.now() - ENVIADOS_DIAS * 86400000).toISOString().slice(0, 10);
  for (const e of (ests || [])) {
    if (e.deleted || Number(e['document-state-id']) !== 1120641 || ymd(e.date) < limEnv) continue;
    const dias = diasDesde(e.date, hoy);
    presupuestos.push({ id: 'prt:' + e.id, col: 'enviado', dias, semaforo: color(dias, LIMITES.enviado), etiqueta: 'esperando respuesta', ref: e['full-reference'],
      cliente: cliente(e['account-id']), que: corto(e.title || '', 160), importe: r2(e['total-amount']), tipo: 'Presupuesto' });
  }

  const orden = { rojo: 0, ambar: 1, verde: 2 };
  const ordenar = l => l.sort((a, b) => (orden[a.semaforo] - orden[b.semaforo]) || (b.urgente - a.urgente) || (b.dias - a.dias));
  const COLS = [
    ['asignar', '📥 Por asignar', 'Falta decidir quién va'],
    ['cita', '📞 Sin cita', 'El técnico tiene que quedar con el cliente'],
    ['programado', '📅 Programado', 'Con día; rojo si pasó y no hay parte'],
    ['facturar', '🧾 Por facturar', 'Parte hecho y sin factura'],
    ['cobrar', '💶 Por cobrar', 'Facturado y sin cobrar'],
    ['cobrado', '✅ Cobrado', `Últimos ${COBRADO_DIAS} días`],
  ];
  const resumenCol = (k, tit, ayuda, lista) => ({ k, titulo: tit, ayuda, tarjetas: ordenar(lista), total: lista.length,
    rojos: lista.filter(t => t.semaforo === 'rojo').length, ambar: lista.filter(t => t.semaforo === 'ambar').length,
    importe: r2(lista.reduce((s, t) => s + (Number(t.importe) || 0), 0)) });
  const columnas = COLS.map(([k, tit, ayuda]) => resumenCol(k, tit, ayuda, tarjetas.filter(t => t.col === k)));
  const filaPresupuestos = [
    resumenCol('porHacer', '📝 Presupuestos por hacer', 'Los haces tú', presupuestos.filter(t => t.col === 'porHacer')),
    resumenCol('enviado', '📤 Enviados sin respuesta', `Últimos ${ENVIADOS_DIAS} días`, presupuestos.filter(t => t.col === 'enviado')),
  ];
  return { hoy, generado: new Date().toISOString(), columnas, presupuestos: filaPresupuestos, limpieza, limites: LIMITES };
}

// Los seis pasos del ciclo de una tarjeta, para el detalle: hecho / actual / pendiente.
function pasos({ inc = null, pet = null, w = null, a = null, ps = [], facs = [], hoy }) {
  const L = [];
  const add = (titulo, hecho, fecha, detalle) => L.push({ titulo, hecho: !!hecho, fecha: fecha || null, detalle: detalle || '' });
  add('Petición', !!(pet || inc), ymd((pet && pet.fecha) || (inc && inc.fecha)), pet ? `${pet.grupo || 'Grupo'}${pet.canal === 'correo' ? ' (correo)' : ''}: ${corto(pet.resumen, 120)}` : (inc ? 'Entró directamente en StelOrder' : ''));
  add('Incidencia', !!inc, inc && inc.fecha, inc ? `${inc.ref} · ${inc.tipo || 'sin tipo'} · ${inc.estado}` : 'Falta crear la incidencia');
  add('Pedido y técnico', !!(w && a && a.userId), ymd(a && a.assignedAt), w ? `${w['full-reference']}${a && a.userName ? ' · ' + a.userName : ' · sin técnico'}${a && a.equipo && a.equipo.length ? ' con ' + a.equipo.join(', ') : ''}` : 'Sin pedido de trabajo');
  add('Cita', !!(a && a.fecha) || ps.length > 0, a && a.fecha, a && a.fecha ? `${fechaCorta(a.fecha, hoy)}${a.hora ? ' a las ' + a.hora : ''}${(a.citasAnteriores || []).length ? ` (cambiada ${(a.citasAnteriores || []).length} vez/veces)` : ''}` : (a && a.motivoPendiente ? `Hay que volver: ${a.motivoPendiente}` : 'Sin día'));
  const ultimo = ps[ps.length - 1];
  const horas = ps.reduce((s, p) => s + (Number(p.horas) || 0), 0);
  const mats = ps.reduce((s, p) => s + ((p.materiales || []).length), 0);
  add('Parte de trabajo', ps.some(p => p.estadoTrabajo === 'completado') || !!(a && a.status === 'done'), ultimo && ymd(ultimo.date),
    ps.length ? `${ps.length} parte(s) · ${horas} h · ${mats} material(es) · ${ultimo.estadoTrabajo === 'completado' ? 'acabado' : 'NO acabado' + (ultimo.pendienteDetalle ? ': ' + corto(ultimo.pendienteDetalle, 80) : '')}${ultimo.description ? ' — ' + corto(ultimo.description, 120) : ''}` : 'Aún no hay parte');
  add('Factura', facs.length > 0, facs.length ? ymd(facs[0].date) : null, facs.length ? facs.map(f => `${f.number} · ${r2(f.total).toLocaleString('es-ES')} €`).join(', ') : 'Sin factura');
  const pend = facs.reduce((s, f) => s + (f.pendiente == null ? (Number(f.total) || 0) : Number(f.pendiente)), 0);
  add('Cobro', facs.length > 0 && pend <= 0.01, facs.length && pend <= 0.01 ? ymd(facs[0].modificada) : null, facs.length ? (pend <= 0.01 ? 'Cobrada' : `Faltan ${r2(pend).toLocaleString('es-ES')} €`) : '');
  const i = L.findIndex(p => !p.hecho);
  L.forEach((p, k) => { p.estado = p.hecho ? 'hecho' : (k === i ? 'actual' : 'pendiente'); });
  return L;
}

// Acciones desde el tablero
async function cerrarIncidencia(ref, estado, por) {
  const S = require('./stelorder');
  const BUSCA = { cerrada: /^cerrad/i, rechazada: /rechazad/i, presupuesto_hecho: /presupuesto hecho/i };
  if (!BUSCA[estado]) throw new Error('Estado no válido');
  const st = await S.getIncidentStateMap();
  const est = Object.entries(st).find(([, n]) => BUSCA[estado].test(String(n).trim()));
  if (!est) throw new Error('No encuentro ese estado en StelOrder');
  const i = (await S.getAllIncidents()).find(x => x['full-reference'] === ref && !x.deleted);
  if (!i) throw new Error(`No encuentro la ${ref}`);
  await S.setIncidentState(i.id, Number(est[0]), { requestedBy: `${por || 'Oficina'} (tablero)` });
  // Si venía de una petición, que deje de salir como pendiente
  try { const db = await require('./db').getDB(); await db.collection('peticionesGrupo').updateMany({ incidencia: ref, estado: 'pendiente' }, { $set: { estado: 'hecho', cerradaDesdeTablero: { por, at: new Date(), estado } } }); } catch (e) {}
  return { ok: true, ref, estado: String(est[1]).trim() };
}

async function ignorar(id, motivo, por) {
  if (!/^(wo|inc):[\w-]+$/.test(String(id || ''))) throw new Error('Tarjeta no válida');
  const db = await require('./db').getDB();
  await db.collection('cicloIgnorar').updateOne({ _id: String(id) }, { $set: { motivo: String(motivo || '').slice(0, 200), por: por || null, at: new Date() } }, { upsert: true });
  return { ok: true };
}

module.exports = { datos, pasos, cerrarIncidencia, ignorar, LIMITES, _ymd: ymd, _fechaCorta: fechaCorta };
