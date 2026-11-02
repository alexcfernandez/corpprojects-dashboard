// src/facturarParte.js — Botón «Facturar» del tablero del ciclo (2/11/2026, Álex: «haz el botón de facturar desde el parte»).
// 1) propuesta(): con el parte (o los partes) del pedido monta las líneas de la factura, que la oficina revisa y cambia:
//    · mano de obra por salida (día): horas × personas, mínimo HORAS_SALIDA h, al precio/hora del objetivo
//      (OBJETIVO_DIA_EQUIPO / 2 personas / 8 h = 56,25 €/h);
//    · cada material del parte a coste +30 % (MARGEN_MATERIAL), valorado como en la rentabilidad (almacén o última compra);
//    · «Desplazamiento, limpieza y retirada de residuos»: 20 € por salida;
//    · IVA 10 % si es una comunidad y el material no llega al 40 %; si no, 21 %. +10 % si el cliente es de la familia CINC.
// 2) facturar(): pasa las líneas al pedido de StelOrder y genera la factura DESDE el pedido (queda enlazada; el tablero
//    la pasa sola a «Por cobrar»). Un candado en Mongo (facturasParte) impide facturar dos veces el mismo pedido.

const TZ = 'Europe/Madrid';
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const OBJETIVO_DIA = () => Number(process.env.OBJETIVO_DIA_EQUIPO || 900);
const HORAS_MIN = () => Number(process.env.HORAS_SALIDA || 2);
const PRECIO_HORA = () => r2(OBJETIVO_DIA() / 2 / 8);
const MARGEN_MATERIAL = () => Number(process.env.MARGEN_MATERIAL || 1.30);
const DESPLAZAMIENTO = () => Number(process.env.DESPLAZAMIENTO_SALIDA || 20);
const COMUNIDAD = /\b(ctat|comunitat|comunidad|c\.?\s?prop|cp|propietaris|propietarios|com\.?\s?prop)\b/i;
const ddmm = f => { const [, m, d] = String(f || '').split('-'); return d ? `${d}/${m}` : ''; };
const corto = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

function totales(lineas, iva) {
  const base = r2(lineas.reduce((s, l) => s + r2((Number(l.unidades) || 0) * (Number(l.precio) || 0)), 0));
  const cuota = r2(base * (Number(iva) || 0) / 100);
  return { base, cuota, total: r2(base + cuota) };
}

async function propuesta(workOrderId, { _S = null, _db = null, _valorar = null } = {}) {
  const S = _S || require('./stelorder');
  const db = _db || await require('./db').getDB();
  const id = String(workOrderId || '');
  const [wos, { clientMap }] = await Promise.all([S.getAllWorkOrders(), S.getClients()]);
  const w = (wos || []).find(x => String(x.id) === id && !x.deleted);
  if (!w) throw new Error('No encuentro el pedido');
  const a = await db.collection('workOrderAssignments').findOne({ workOrderId: id });
  const hecho = await db.collection('facturasParte').findOne({ _id: id });
  const partes = await db.collection('partes').find({ workOrderId: id }).sort({ date: 1 }).toArray();
  const cli = clientMap[String(w['account-id'])] || {};
  const cliente = cli.name || (a && a.cliente) || '';
  const avisos = [];
  const lineas = [];

  // Mano de obra: una línea por salida (día). Si van dos y cada uno hace su parte, no se cuenta dos veces.
  const porDia = new Map();
  for (const p of partes) {
    const d = String(p.date || '').slice(0, 10);
    if (!porDia.has(d)) porDia.set(d, { horas: 0, quien: new Set(), equipo: 0, que: [] });
    const x = porDia.get(d);
    x.horas = Math.max(x.horas, Number(p.horas) || 0);
    if (p.workerName) x.quien.add(p.workerName);
    x.equipo = Math.max(x.equipo, (p.equipo || []).length);
    if (p.description) x.que.push(p.description);
  }
  for (const [d, x] of porDia) {
    const personas = Math.max(x.quien.size, 1 + x.equipo, 1 + ((a && a.equipo) || []).length);
    const horas = Math.max(HORAS_MIN(), x.horas);
    if (x.horas < HORAS_MIN()) avisos.push(`El ${ddmm(d)} el parte dice ${x.horas} h: cuento ${HORAS_MIN()} h (mínimo por salida).`);
    lineas.push({ tipo: 'mano', concepto: 'Mano de obra', descripcion: `${ddmm(d)}: ${horas} h × ${personas} operario${personas > 1 ? 's' : ''}${x.que.length ? ' — ' + corto([...new Set(x.que)].join('. '), 400) : ''}`, unidades: r2(horas * personas), precio: PRECIO_HORA() });
  }
  // Material a coste + margen
  const mats = await (_valorar || require('./parteExtra').valorarMateriales)(partes.flatMap(p => p.materiales || []), { _db: db });
  for (const m of mats) {
    if (!(Number(m.precio) > 0)) avisos.push(`«${m.nombre}» no tiene precio: ponlo tú.`);
    lineas.push({ tipo: 'material', concepto: corto(m.nombre, 200), descripcion: 'Material', unidades: Number(m.cantidad) || 1, precio: r2((Number(m.precio) || 0) * MARGEN_MATERIAL()), coste: r2(m.precio), precioFuente: m.precioFuente || null });
  }
  if (porDia.size) lineas.push({ tipo: 'desplazamiento', concepto: 'Desplazamiento, limpieza y retirada de residuos', descripcion: `${porDia.size} salida${porDia.size > 1 ? 's' : ''}`, unidades: porDia.size, precio: DESPLAZAMIENTO() });

  // Sin parte: lo que ya tenga el pedido con precio
  if (!partes.length) {
    avisos.push('Este pedido no tiene parte en la app: pongo lo que tiene el pedido en StelOrder; revisa horas y material.');
    for (const l of (w.lines || []).filter(l => !l.deleted && l['line-type'] !== 'SECTION'))
      lineas.push({ tipo: 'pedido', concepto: corto(l['item-name'] || 'Trabajo', 200), descripcion: corto(l['item-description'] || '', 1000), unidades: Number(l.units) || 1, precio: r2(l['item-base-price']) });
  }

  const yaFact = partes.filter(p => p.status === 'facturado');
  if (yaFact.length) avisos.unshift(`⚠️ El parte ya figura como facturado${yaFact[0].facturaRef ? ' (' + yaFact[0].facturaRef + ')' : ''}: mira que no se facture dos veces.`);
  // CINC cobra un 10 % de nuestro precio
  const cinc = /cinc/i.test(cli.family || '');
  if (cinc) { lineas.forEach(l => { l.precio = r2(l.precio * 1.10); }); avisos.push('Cliente de CINC: precios +10 %.'); }

  const baseMat = lineas.filter(l => l.tipo === 'material').reduce((s, l) => s + l.unidades * l.precio, 0);
  const base = lineas.reduce((s, l) => s + l.unidades * l.precio, 0);
  const comunidad = COMUNIDAD.test(cliente);
  const iva = comunidad && (!base || baseMat / base < 0.4) ? 10 : 21;

  const titulo = corto([(a && a.resumen) || (w.lines || []).map(l => l['item-description']).filter(Boolean)[0] || '', (a && a.direccion) || ''].filter(Boolean).join(' · '), 190);
  return {
    workOrderId: id, pedidoRef: w['full-reference'], incRef: (a && a.incidenciaRef) || null, cliente, familia: cli.family || '', accountId: String(w['account-id']),
    titulo, lineas, iva, ...totales(lineas, iva), avisos, partes: partes.length, cinc,
    yaFacturado: hecho && hecho.estado === 'hecha' ? { ref: hecho.facturaRef, at: hecho.at } : (a && a.facturaRef ? { ref: a.facturaRef } : null),
    enCurso: hecho && hecho.estado !== 'hecha' ? hecho.estado : null,
    pedidoConLineas: !!(hecho && hecho.lineasEnPedido),
    reglas: { precioHora: PRECIO_HORA(), horasMin: HORAS_MIN(), margenMaterial: MARGEN_MATERIAL(), desplazamiento: DESPLAZAMIENTO() },
  };
}

function limpiarLineas(lineas, iva) {
  const L = (Array.isArray(lineas) ? lineas : []).map(l => ({ concepto: corto(l.concepto, 200), descripcion: String(l.descripcion || '').slice(0, 1000), unidades: r2(String(l.unidades).replace(',', '.')), precio: r2(String(l.precio).replace(',', '.')), iva }))
    .filter(l => l.concepto && l.unidades > 0);
  if (L.some(l => !(l.precio >= 0))) throw new Error('Hay un precio que no es un número');
  return L;
}

// soloPedido: pasa las líneas al pedido sin crear la factura (para facturarlo luego a mano en StelOrder).
async function facturar(workOrderId, { lineas, iva = 21, titulo = '', soloPedido = false } = {}, por = 'Oficina', { _S = null, _db = null } = {}) {
  const S = _S || require('./stelorder');
  const db = _db || await require('./db').getDB();
  const id = String(workOrderId || '');
  if (![21, 10, 4, 0].includes(Number(iva))) throw new Error('IVA no válido');
  const L = limpiarLineas(lineas, Number(iva));
  if (!L.length) throw new Error('La factura no tiene líneas');
  const t = totales(L, iva);
  if (!soloPedido && !(t.base > 0)) throw new Error('La factura sale a 0 €');
  const wos = await S.getAllWorkOrders();
  const w = (wos || []).find(x => String(x.id) === id && !x.deleted);
  if (!w) throw new Error('No encuentro el pedido');
  const a = await db.collection('workOrderAssignments').findOne({ workOrderId: id });
  if (a && a.facturaRef) throw new Error(`Este pedido ya está facturado (${a.facturaRef})`);

  // Candado: un solo intento de factura por pedido
  const col = db.collection('facturasParte');
  let prev = await col.findOne({ _id: id });
  if (prev && prev.estado === 'hecha') throw new Error(`Ya se facturó (${prev.facturaRef})`);
  if (prev && (prev.estado === 'revisar' || prev.estado === 'enviando')) throw new Error('El último intento no tuvo respuesta de StelOrder: mira en StelOrder si la factura existe. Si no existe, pulsa «Desbloquear» y vuelve a intentarlo.');
  if (prev && prev.estado === 'en_curso' && Date.now() - new Date(prev.at).getTime() < 3 * 60000) throw new Error('Ya se está facturando este pedido');
  await col.updateOne({ _id: id }, { $set: { estado: 'en_curso', at: new Date(), por, pedidoRef: w['full-reference'] } }, { upsert: true });
  prev = prev || {};

  const out = { pedidoRef: w['full-reference'], ...t };
  try {
    // 1) Líneas al pedido (una sola vez)
    if (!prev.lineasEnPedido) {
      await S.ponerLineasPedido(id, L, { requestedBy: `${por} (Facturar)` });
      await col.updateOne({ _id: id }, { $set: { lineasEnPedido: true, lineas: L, iva: Number(iva) } });
      out.lineasEnPedido = true;
    }
    if (soloPedido) { await col.updateOne({ _id: id }, { $set: { estado: 'pedido' } }); return { ok: true, soloPedido: true, ...out }; }

    // 2) La factura desde el pedido
    const nota = `Generada desde el parte en el dashboard por ${por}. ${w['full-reference']}${a && a.incidenciaRef ? ' · ' + a.incidenciaRef : ''}.`;
    await col.updateOne({ _id: id }, { $set: { estado: 'enviando', enviandoAt: new Date() } });   // si el proceso muere aquí, queda para revisar
    let f;
    try { f = await S.crearFacturaDesdePedido({ workOrderId: id, accId: w['account-id'], lineas: L, titulo: titulo || null, nota, requestedBy: por }); }
    catch (e) { await col.updateOne({ _id: id }, { $set: { estado: e.sinRespuesta ? 'revisar' : 'error', error: e.message } }); throw e; }
    await col.updateOne({ _id: id }, { $set: { estado: 'hecha', facturaRef: f.ref, facturaId: f.id, total: f.total, hechaAt: new Date() } });
    // 3) Pedido y partes como facturados (el pedido pasa a Cerrado si la escritura de estados está activa)
    try { await require('./asignaciones').markInvoiced(id, f.ref); } catch (e) { console.warn('[Facturar] markInvoiced:', e.message); }
    await db.collection('partes').updateMany({ workOrderId: id }, { $set: { status: 'facturado', facturaRef: f.ref, updatedAt: new Date() } });
    out.factura = f;
    if (f.total != null && Math.abs(f.total - t.total) > 0.05) out.aviso = `El total en StelOrder (${f.total} €) no cuadra con el calculado (${t.total} €): revísala.`;
    return { ok: true, ...out };
  } catch (e) {
    const p2 = await col.findOne({ _id: id });
    if (p2 && p2.estado === 'en_curso') await col.updateOne({ _id: id }, { $set: { estado: 'error', error: e.message } });
    throw e;
  }
}

// Tras un «StelOrder no contestó», cuando ya se ha mirado que la factura NO existe.
async function desbloquear(workOrderId, por) {
  const db = await require('./db').getDB();
  const r = await db.collection('facturasParte').updateOne({ _id: String(workOrderId), estado: { $in: ['revisar', 'enviando', 'error'] } }, { $set: { estado: 'error', desbloqueadoPor: por, desbloqueadoAt: new Date() } });
  return { ok: !!r.matchedCount };
}

module.exports = { propuesta, facturar, desbloquear, totales, PRECIO_HORA };
