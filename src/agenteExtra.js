// src/agenteExtra.js — Más herramientas para el agente del dueño (17/10/2026). Álex: «las cosas que le pregunto no se
// entera de nada». Casos reales que fallaban por ir a reglas de palabras:
//   · «¿De Rutlla nos deben algo?» → miró Rutlla 70-72; «era Rutlla 202» → contestó pedidos, no facturas.
//   · «¿Qué suelo hemos comprado para el piso de Claudia?» → el gasto total en proveedores.
//   · «¿Cuánto gastamos en Obramat?» → «no conozco el proveedor» (en StelOrder es Bricoman).
//   · «La ficha técnica de la Nissan Primastar» → la ficha de un cliente.
//   · «El último repostaje es del coche de Alfonso» (contestando a Corpy) → no lo entendió.
//   · «Hecho el pendiente 1, 2 y 3» → solo cerró el 1.
// La IA interpreta; los datos salen de aquí. Si hay dudas (varios clientes, varios vehículos), se devuelven los candidatos
// para que el modelo PREGUNTE.

async function getDB() { return require('./db').getDB(); }
// Mientras el agente usa el asistente de siempre (consulta_clasica), ese asistente no puede volver a llamar al agente.
const { AsyncLocalStorage } = require('async_hooks');
const DENTRO = new AsyncLocalStorage();
const _n = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
const GENERICAS = new Set(['ctat', 'prop', 'propietaris', 'propietarios', 'comunitat', 'comunidad', 'cp', 'de', 'del', 'la', 'el', 'los', 'las', 'sl', 'sa', 'slu', 'cb', 'calle', 'carrer', 'c', 'piso', 'obra', 'casa', 'nos', 'debe', 'deben']);
const palabras = q => _n(q).split(' ').filter(w => w.length >= 2 && !GENERICAS.has(w));
// Cuántas palabras de la búsqueda están en el nombre (los números cuentan doble: «Rutlla 202» ≠ «Rutlla 70-72»).
function puntos(nombre, q) {
  const t = ' ' + _n(nombre) + ' ';
  let p = 0;
  for (const w of palabras(q)) {
    if (/^\d+$/.test(w)) { if (new RegExp(`(^|[^0-9])${w}([^0-9]|$)`).test(t)) p += 2; else p -= 1; }
    else if (t.includes(' ' + w) || t.includes(w)) p += 1;
  }
  return p;
}
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const dm = f => String(f || '').slice(0, 10).split('-').reverse().join('/');

// Mismo proveedor con distinto nombre en StelOrder / en la calle.
const ALIAS_PROV = [
  [/obramat|bricoman|bricomart/, ['obramat', 'bricoman', 'bricomart']],
  [/bauhaus|werkhaus/, ['bauhaus', 'werkhaus']],
  [/leroy/, ['leroy']],
  [/bon ?preu|esclat/, ['bon preu', 'bonpreu', 'esclat']],
  [/weber|saint.?gobain/, ['weber', 'saint gobain']],
  [/palahi/, ['palahi']],
];
function nombresProveedor(q) {
  const nq = _n(q);
  for (const [re, ns] of ALIAS_PROV) if (re.test(nq)) return ns;
  return [nq];
}
const casaProveedor = (nombre, q) => { const t = _n(nombre); return nombresProveedor(q).some(x => palabras(x).every(w => t.includes(w))); };

// Sinónimos para buscar material en las líneas de las compras.
const SIN_MATERIAL = [
  [/\bsuelo|pavimento|baldosa|porcelan|azulejo|ceramic/, ['suelo', 'pavimento', 'pav ', 'porcelan', 'porc ', 'porc', 'gres', 'ceramic', 'azulejo', 'parquet', 'laminad', 'tarima', 'baldosa', 'vinilo', 'spc', 'rodapie', 'peldano']],
  [/pintura|pintar/, ['pintura', 'plastica', 'esmalte', 'imprimacion', 'revestimiento']],
  [/pladur|yeso laminado/, ['placa', 'pladur', 'yeso laminado', 'montante', 'canal']],
  [/cable|electric/, ['cable', 'manguera', 'h07', 'rz1', 'utp', 'cat6', 'cat 6']],
  [/mortero|cemento/, ['mortero', 'cemento', 'cola', 'adhesivo cementoso']],
];
function terminosMaterial(q) {
  const nq = _n(q);
  for (const [re, ts] of SIN_MATERIAL) if (re.test(nq)) return ts;
  return palabras(q);
}

// ── LECTURAS ──
async function facturasCliente({ cliente } = {}) {
  const S = require('./stelorder');
  const pend = await S.getPendingInvoices();
  const porCli = {};
  for (const f of (pend || [])) (porCli[f.client] = porCli[f.client] || []).push(f);
  const { clients } = await S.getClients().catch(() => ({ clients: [] }));
  const nombres = new Set([...Object.keys(porCli), ...(clients || []).map(c => c['legal-name'] || c.name).filter(Boolean)]);
  const cand = [...nombres].map(n => ({ n, p: puntos(n, cliente) })).filter(x => x.p > 0).sort((a, b) => b.p - a.p).slice(0, 6);
  if (!cand.length) return { buscado: cliente, encontrados: 0, nota: 'Ningún cliente se parece a ese nombre.' };
  const mejor = cand[0].p;
  return {
    buscado: cliente,
    candidatos: cand.map(x => {
      const fs = porCli[x.n] || [];
      return { cliente: x.n, encaje: x.p === mejor ? 'mejor' : 'parecido', facturasPendientes: fs.length, totalPendiente: r2(fs.reduce((a, f) => a + (Number(f.pending) || 0), 0)),
        facturas: fs.slice(0, 15).map(f => ({ numero: f.number, fecha: dm(f.date), pendiente: r2(f.pending), diasVencida: f.daysOverdue })) };
    }),
    nota: cand.filter(x => x.p === mejor).length > 1 ? 'Hay varios igual de parecidos: pregunta cuál.' : null,
  };
}

async function buscarCompras({ que = '', obra = '', proveedor = '', desde = null, hasta = null } = {}) {
  const db = await getDB();
  const q = { estado: { $ne: 'descartada' }, duplicadoDe: null };
  if (desde || hasta) q.fecha = { ...(desde ? { $gte: desde } : {}), ...(hasta ? { $lte: hasta } : {}) };
  const cs = await db.collection('compras').find(q).project({ proveedor: 1, fecha: 1, total: 1, obraRef: 1, destino: 1, 'subidaPor.name': 1, lineas: 1, tipo: 1, numero: 1 }).sort({ fecha: -1 }).limit(3000).toArray();
  const terms = que ? terminosMaterial(que) : [];
  const out = [];
  for (const c of cs) {
    if (proveedor && !casaProveedor(c.proveedor, proveedor)) continue;
    if (obra && puntos(c.obraRef || '', obra) <= 0 && !(c.lineas || []).some(l => puntos(l.obraTexto || '', obra) > 0)) continue;
    for (const l of (c.lineas || [])) {
      const d = _n(l.descripcion);
      if (terms.length && !terms.some(t => d.includes(_n(t)))) continue;
      out.push({ fecha: dm(c.fecha), proveedor: c.proveedor, obra: c.obraRef || l.obraTexto || c.destino || null, quien: c.subidaPor && c.subidaPor.name, descripcion: String(l.descripcion).slice(0, 120), cantidad: l.cantidad, unidad: l.unidad || null, importe: l.importe != null ? r2(l.importe) : null, documento: [c.tipo, c.numero].filter(Boolean).join(' ') });
      if (out.length >= 60) break;
    }
    if (!terms.length && !out.some(x => x.documento === [c.tipo, c.numero].filter(Boolean).join(' '))) out.push({ fecha: dm(c.fecha), proveedor: c.proveedor, obra: c.obraRef || c.destino || null, quien: c.subidaPor && c.subidaPor.name, total: r2(c.total), documento: [c.tipo, c.numero].filter(Boolean).join(' ') });
    if (out.length >= 60) break;
  }
  return { filtro: { que, obra, proveedor, desde, hasta }, terminosBuscados: terms, encontradas: out.length, lineas: out, totalLineas: r2(out.reduce((a, x) => a + (Number(x.importe != null ? x.importe : x.total) || 0), 0)), nota: 'Son las compras subidas a Compras (fotos, correo, WhatsApp, subida masiva).' };
}

async function gastoProveedor({ proveedor, desde = null, hasta = null } = {}) {
  const S = require('./stelorder');
  const fp = (await S.getPurchaseInvoices()) || [];
  const d0 = desde || '0000', d1 = hasta || '9999';
  const l = fp.filter(x => casaProveedor(x.supplier, proveedor) && String(x.date).slice(0, 10) >= d0 && String(x.date).slice(0, 10) <= d1);
  if (!l.length) {
    const parecidos = [...new Set(fp.map(x => x.supplier))].filter(s => palabras(proveedor).some(w => _n(s).includes(w))).slice(0, 8);
    return { proveedor, facturas: 0, parecidos, nota: parecidos.length ? 'No hay facturas con ese nombre exacto; estos se parecen.' : 'No hay facturas de ese proveedor.' };
  }
  const porMes = {}; l.forEach(x => { const k = String(x.date).slice(0, 7); porMes[k] = r2((porMes[k] || 0) + x.total); });
  return { proveedor, nombresEnStelOrder: [...new Set(l.map(x => x.supplier))], facturas: l.length, total: r2(l.reduce((a, x) => a + x.total, 0)), pendienteDePago: r2(l.reduce((a, x) => a + (x.pending || 0), 0)), porMes: Object.entries(porMes).sort().slice(-12).map(([mes, total]) => ({ mes, total })), ultimas: l.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 8).map(x => ({ numero: x.number, fecha: dm(x.date), total: r2(x.total) })) };
}

async function _vehiculo(q) {
  const db = await getDB();
  const vs = await db.collection('vehiculos').find({}).project({ nombre: 1, marca: 1, modelo: 1, matricula: 1, conductor: 1, estado: 1, aliasEsclat: 1 }).toArray();
  const txt = v => [v.nombre, v.marca, v.modelo, v.matricula, v.conductor && v.conductor.name, ...(v.aliasEsclat || [])].join(' ');
  const c = vs.map(v => ({ v, p: puntos(txt(v), q) + (v.estado === 'activo' ? 0.1 : 0) })).filter(x => x.p >= 1).sort((a, b) => b.p - a.p);
  if (!c.length) return { ninguno: true, todos: vs.filter(v => v.estado === 'activo').map(v => `${v.nombre}${v.matricula ? ' ' + v.matricula : ''}`) };
  if (c.length > 1 && Math.floor(c[0].p) === Math.floor(c[1].p)) return { varios: c.slice(0, 5).map(x => `${x.v.nombre}${x.v.matricula ? ' ' + x.v.matricula : ''}${x.v.conductor ? ' (lo lleva ' + x.v.conductor.name + ')' : ''}`) };
  return { v: c[0].v };
}
async function documentosVehiculo({ vehiculo } = {}) {
  const r = await _vehiculo(vehiculo || '');
  if (r.ninguno) return { vehiculo, encontrado: false, vehiculosActivos: r.todos };
  if (r.varios) return { vehiculo, encontrado: false, varios: r.varios, nota: 'Pregunta cuál.' };
  const docs = await require('./vehiculos').documentos(String(r.v._id));
  return { vehiculo: `${r.v.nombre}${r.v.matricula ? ' ' + r.v.matricula : ''}`, conductor: r.v.conductor ? r.v.conductor.name : null, documentos: docs.map(d => ({ tipo: d.tipo, nombre: d.nombre, subido: dm(d.subido) })) };
}

// Lo de antes: el asistente de siempre (facturas por número, presupuestos, pedidos, resumen, cobros, conceptos…),
// con la consulta reescrita clara por la IA. Solo para CONSULTAR.
async function consultaClasica({ consulta } = {}, from) {
  const c = String(consulta || '').trim();
  if (!c) return { error: 'Falta la consulta' };
  if (/\b(crea|haz|hazme|genera|añade|anade|modifica|cambia|sube|baja|borra|elimina|envia|envía|manda|anula)\b/i.test(c)) return { error: 'consulta_clasica es solo para consultar; esto es una orden.' };
  const r = await DENTRO.run({ desdeAgente: true }, () => require('./asistente')._interna(c, from, [], { desdeAgente: true }));
  return { respuestaDelAsistente: String(r || '').slice(0, 6000) };
}

// ── ACCIONES ──
async function ejecutar(name, input, from) {
  if (name === 'cerrar_pendientes') {
    const P = require('./pendientes');
    const nums = [...new Set((input.numeros || []).map(Number).filter(n => n >= 1 && n <= 99))].sort((a, b) => b - a);
    if (!nums.length) return { handled: true, reply: '¿Qué número de pendiente cierro?' };
    const hechos = [], no = [];
    for (const n of nums) { const d = await P.cerrarPendiente({ idx: n }); if (d) hechos.unshift(`${n}. ${d.texto}`); else no.push(n); }
    return { handled: true, reply: `${hechos.length ? `✅ Hecho:\n${hechos.join('\n')}` : ''}${no.length ? `${hechos.length ? '\n\n' : ''}No encuentro el ${no.sort().join(', ')}. Mira la lista con *"pendientes"*.` : ''}` };
  }
  if (name === 'apuntar_pendiente') {
    const P = require('./pendientes');
    const para = /^\d{4}-\d{2}-\d{2}$/.test(String(input.fecha || '')) ? input.fecha : null;
    const p = await P.addPendiente(String(input.texto || '').trim(), from, { para });
    if (!p) return { handled: true, reply: '¿Qué te apunto?' };
    return { handled: true, reply: para ? `📌 Apuntado: *${p.texto}* — te lo recuerdo ${P.fechaConfirm(para)}.` : `📌 Apuntado: *${p.texto}*. Te lo recuerdo en el resumen de la mañana hasta que me digas que está hecho.` };
  }
  if (name === 'asignar_repostaje') {
    const R = require('./repostajes');
    const p = await R.pendientes();
    let id = input.repostajeId && /^[a-f0-9]{24}$/.test(String(input.repostajeId)) ? String(input.repostajeId) : null;
    const eur = n => (Number(n) || 0).toFixed(2).replace('.', ',') + ' €';
    const linea = (x, i) => `${i + 1}. ${dm(x.fecha)}${x.hora ? ' ' + x.hora : ''} · ${eur(x.importe)} · ${x.establecimiento || 'Esclat'}`;
    if (!id) {
      if (!p.length) return { handled: true, reply: 'No tengo ningún repostaje sin vehículo.' };
      let c = p;
      if (input.importe != null) c = c.filter(x => Math.abs((Number(x.importe) || 0) - Number(input.importe)) < 1);
      if (input.fecha) c = c.filter(x => x.fecha === input.fecha);
      if (input.numero && p[input.numero - 1]) c = [p[input.numero - 1]];
      if (c.length !== 1 && p.length > 1) return { handled: true, reply: `Tengo ${p.length} repostajes sin vehículo. ¿Cuál es el de *${input.vehiculo}*?\n\n${p.slice(0, 6).map(linea).join('\n')}\n\nDime el número (p. ej. «el 2 es de la ${input.vehiculo}»).`, aclara: true };
      id = (c[0] || p[0]).id;
    }
    const rep = p.find(x => x.id === id);
    // Gasolina para máquinas (cortacésped, desbrozadora, garrafa, generador…): no es de un vehículo.
    if (/cortac[eé]sped|desbrozador|motosierra|generador|garrafa|bid[oó]n|herramient|maquin|soplador|hormigonera|compresor/i.test(input.vehiculo || '')) {
      await require('./repostajes').aMaquinaria(id, String(input.vehiculo), 'Álex (Corpy)', { quien: input.quien || null });
      return { handled: true, reply: `⛽ Apuntado: el repostaje${rep ? ` de ${eur(rep.importe)} del ${dm(rep.fecha)}` : ''} es gasolina para *${input.vehiculo}*${input.quien ? `, lo puso *${input.quien}*` : ''}. Va como gasto de maquinaria, no de un vehículo.` };
    }
    const r = await _vehiculo(input.vehiculo || '');
    if (r.ninguno) return { handled: true, reply: `No tengo «${input.vehiculo}» en Flota. Los que hay: ${r.todos.join(', ')}.\n\n¿Es uno de esos? Si es nuevo, dime «créala como ${input.vehiculo}» (y si quieres la matrícula) y la doy de alta con este repostaje.`, aclara: true };
    if (r.varios) return { handled: true, reply: `¿Cuál? ${r.varios.join(' · ')}`, aclara: true };
    const x = await R.asignar(id, String(r.v._id), 'Álex (Corpy)', { quien: input.quien || null });
    return { handled: true, reply: `⛽ Apuntado: el repostaje${rep ? ` de ${eur(rep.importe)} del ${dm(rep.fecha)}` : ''} es de la *${x.vehiculo}*${input.quien ? `, lo puso *${input.quien}*` : x.conductor ? ` (la lleva ${x.conductor})` : ''}.` };
  }
  if (name === 'crear_vehiculo') {
    const V = require('./vehiculos');
    const tipo = V.TIPOS[input.tipo] ? input.tipo : (/moto/i.test(input.nombre || '') ? 'moto' : /coche|turismo/i.test(input.nombre || '') ? 'coche' : 'furgoneta');
    let v;
    try { v = await V.crear({ nombre: input.nombre, marca: input.marca || '', modelo: input.modelo || '', matricula: input.matricula || '', tipo }, 'Álex (Corpy)'); }
    catch (e) { return { handled: true, reply: e.message }; }
    const vid = String(v._id || v.id || v.insertedId || '');
    let extra = '';
    if (input.asignarRepostaje !== false) {
      try {
        const R = require('./repostajes'); const p = await R.pendientes();
        const id = input.repostajeId && /^[a-f0-9]{24}$/.test(String(input.repostajeId)) ? String(input.repostajeId) : (p.length === 1 ? p[0].id : null);
        if (id && vid) { await R.asignar(id, vid, 'Álex (Corpy)', { quien: input.quien || null }); extra = '\nY le he puesto el repostaje.'; }
        else if (p.length > 1) extra = `\nTengo ${p.length} repostajes sin vehículo: dime cuál es suyo (te los listo si me dices «repostajes sin vehículo»).`;
      } catch (e) { console.warn('[Agente] repostaje tras crear vehículo:', e.message); }
    }
    return { handled: true, reply: `🚐 Creada en Flota: *${v.nombre}*${v.matricula ? ' (' + v.matricula + ')' : ''}, ${(V.TIPOS[tipo] || tipo).toLowerCase()}.${extra}\nCompleta los datos (matrícula, ITV, seguro…) cuando puedas en https://dashboard.corpprojects.es/vehiculos` };
  }
  if (name === 'pedir_documento_vehiculo') {
    const r = await _vehiculo(input.vehiculo || '');
    if (r.ninguno || r.varios) return { handled: true, reply: r.varios ? `¿De cuál? ${r.varios.join(' · ')}` : `No encuentro el vehículo «${input.vehiculo}».`, aclara: true };
    let u = null;
    if (input.trabajador) { const us = (await require('./users').getUsers(false)).filter(x => x.active !== false && puntos(x.name, input.trabajador) > 0); u = us[0] || null; }
    else if (r.v.conductor && r.v.conductor.userId) u = { _id: r.v.conductor.userId, name: r.v.conductor.name };
    if (!u) return { handled: true, reply: `¿A quién se lo pido? La *${r.v.nombre}* no tiene conductor asignado.`, aclara: true };
    const que = String(input.que || 'ficha técnica').trim();
    const nombreV = `${r.v.nombre}${r.v.matricula ? ' (' + r.v.matricula + ')' : ''}`;
    const tipoDoc = /ficha|tecnic/i.test(que) ? 'ficha_tecnica' : /permiso|circul/i.test(que) ? 'permiso' : /seguro|poliza|póliza/i.test(que) ? 'seguro' : /itv/i.test(que) ? 'itv' : 'otro';
    await require('./encargos').crear({ userId: String(u._id), que: `${que} de la ${r.v.nombre}`.slice(0, 120), mensaje: `Necesito una foto de la *${que}* de la ${nombreV} que llevas (suele estar en la guantera). Mándamela por aquí, que se ve bien entera y con luz.`, origen: { tipo: 'vehiculo_doc', vehiculoId: String(r.v._id), docTipo: tipoDoc }, por: 'Álex (Corpy)' });
    return { handled: true, reply: `📨 Se lo he pedido a *${u.name}*: la ${que} de la ${nombreV}. Cuando la mande, la guardo en la ficha del vehículo y te aviso.` };
  }
  if (name === 'repostajes_sin_vehiculo') {
    const p = await require('./repostajes').pendientes();
    const eur = n => (Number(n) || 0).toFixed(2).replace('.', ',') + ' €';
    return { handled: true, reply: p.length ? `⛽ Repostajes sin vehículo (${p.length}):\n${p.slice(0, 10).map((x, i) => `${i + 1}. ${dm(x.fecha)}${x.hora ? ' ' + x.hora : ''} · ${eur(x.importe)} · ${x.establecimiento || 'Esclat'}`).join('\n')}\n\nDime «el 2 es de la Berlingo».` : '✅ No hay repostajes sin vehículo.' };
  }
  if (name === 'pasar_documento_vehiculo') {
    if (!require('./acceso').esOwner(from)) return { handled: true, reply: 'Los documentos de los vehículos solo se los paso a Álex.' };
    const r = await _vehiculo(input.vehiculo || '');
    if (r.ninguno) return { handled: true, reply: `No encuentro el vehículo «${input.vehiculo}». Los que hay: ${r.todos.join(', ')}.`, aclara: true };
    if (r.varios) return { handled: true, reply: `¿De cuál? ${r.varios.join(' · ')}`, aclara: true };
    const V = require('./vehiculos');
    const docs = await V.documentos(String(r.v._id));
    const nq = _n(input.que || '');
    const tipoDe = /ficha|tecnic/.test(nq) ? /ficha|tecnic/ : /permiso|circulacion/.test(nq) ? /permiso|circul/ : /seguro|poliza/.test(nq) ? /seguro|poliza/ : /itv/.test(nq) ? /itv/ : null;
    const cand = docs.filter(d => !tipoDe || tipoDe.test(_n(`${d.tipo} ${d.nombre}`)));
    const nombreV = `${r.v.nombre}${r.v.matricula ? ' (' + r.v.matricula + ')' : ''}`;
    if (!cand.length) return { handled: true, reply: `No tengo ${input.que ? '«' + input.que + '»' : 'documentos'} de la *${nombreV}*.${docs.length ? ` Tengo: ${docs.map(d => d.nombre || d.tipo).join(', ')}.` : ''}${r.v.conductor ? `\n\n¿Se lo pido a *${r.v.conductor.name}*, que es quien la lleva? Cuando me mande la foto, la guardo en la ficha de la furgoneta.` : '\nSi lo tienes, súbelo en su ficha: https://dashboard.corpprojects.es/vehiculos'}` };
    const d = cand[0];
    const raw = await V.documento(d.id);
    const W = require('./canalWhatsapp');
    if (raw && raw.data && W.canalActivo() === 'bridge') {
      const ok = await W.enviarArchivo(from, `📎 ${d.nombre || d.tipo} · ${nombreV}`, { data: raw.data.buffer ? Buffer.from(raw.data.buffer) : raw.data, mime: raw.mime || d.mime, nombre: d.nombre || d.tipo });
      if (ok) return { handled: true, reply: `Te lo mando aquí mismo: *${d.nombre || d.tipo}* de la ${nombreV}.` };
    }
    return { handled: true, reply: `📎 *${d.nombre || d.tipo}* de la ${nombreV}: está en su ficha, https://dashboard.corpprojects.es/vehiculos` };
  }
  return { handled: false };
}

// Lo último que se han dicho Álex y Corpy (para entender «era Rutlla 202» o «es del coche de Alfonso»).
async function contextoReciente(from, { n = 14 } = {}) {
  try {
    const h = await require('./waLog').hilo(from, { dias: 2 });
    const ms = (h.mensajes || []).slice(-(n + 1), -1);   // sin el mensaje que se está contestando
    return ms.map(m => `[${new Date(m.ts).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}] ${m.dir === 'in' ? 'Álex' : 'Corpy'}: ${String(m.texto || (m.media && m.media.length ? '[archivo]' : '')).replace(/\s+/g, ' ').slice(0, 350)}`).join('\n');
  } catch (e) { return ''; }
}

const TOOLS = [
  { name: 'facturas_cliente', description: 'Lo que NOS DEBE un cliente o comunidad (facturas pendientes de cobro): «¿de Rutlla nos deben algo?», «qué debe Claudia», «cuánto nos debe CINC». Devuelve los clientes que se parecen; si hay varios igual de parecidos, PREGUNTA cuál.', input_schema: { type: 'object', properties: { cliente: { type: 'string' } }, required: ['cliente'] } },
  { name: 'buscar_compras', description: 'Qué MATERIAL se ha comprado, dónde y para qué obra (líneas de las facturas y tickets de Compras): «qué suelo compramos para el piso de Claudia», «cuánta pintura llevamos en Rahola», «qué compró David en Obramat la semana pasada».', input_schema: { type: 'object', properties: { que: { type: 'string', description: 'Material o artículo (suelo, pintura, cable…); vacío si pregunta por todo.' }, obra: { type: 'string' }, proveedor: { type: 'string' }, desde: { type: ['string', 'null'] }, hasta: { type: ['string', 'null'] } } } },
  { name: 'gasto_proveedor', description: 'Cuánto GASTAMOS en un proveedor (facturas de proveedor de StelOrder), total y por meses: «cuánto gastamos en Obramat» (Obramat = Bricoman en StelOrder), «gasto en Saltoki este año».', input_schema: { type: 'object', properties: { proveedor: { type: 'string' }, desde: { type: ['string', 'null'] }, hasta: { type: ['string', 'null'] } }, required: ['proveedor'] } },
  { name: 'documentos_vehiculo', description: 'Qué papeles tenemos de un vehículo (ficha técnica, permiso de circulación, seguro, ITV) — solo mirar. Para MANDARLO usa pasar_documento_vehiculo.', input_schema: { type: 'object', properties: { vehiculo: { type: 'string', description: 'Nombre, marca/modelo, matrícula o quién lo lleva («el coche de Alfonso»).' } }, required: ['vehiculo'] } },
  { name: 'pasar_documento_vehiculo', description: 'MANDA a Álex un papel de un vehículo: «necesito la ficha técnica de la Nissan Primastar», «pásame el seguro de la Berlingo».', input_schema: { type: 'object', properties: { vehiculo: { type: 'string' }, que: { type: 'string', description: 'ficha técnica, permiso de circulación, seguro, ITV…' } }, required: ['vehiculo'] } },
  { name: 'asignar_repostaje', description: 'Dice de qué vehículo es un repostaje (o si es gasolina para una máquina: cortacésped, desbrozadora, garrafa, generador… → pon eso en «vehiculo») y, si lo dice, quién repostó. Úsalo cuando Corpy ha preguntado «¿de qué vehículo es?» y Álex contesta («la Berlingo», «es del coche de Alfonso», «lo puso Javi en la moto», «el 2 es de la Partner»). El id va en el mensaje de Corpy («ref. repostaje ID» o «#repostaje=ID»); si no lo ves, pon importe/fecha/número si los dice, o déjalo vacío.', input_schema: { type: 'object', properties: { vehiculo: { type: 'string' }, quien: { type: ['string', 'null'], description: 'Quién repostó, si lo dice («lo puso Javi»).' }, repostajeId: { type: ['string', 'null'] }, importe: { type: ['number', 'null'] }, fecha: { type: ['string', 'null'] }, numero: { type: ['integer', 'null'], description: 'Número de la lista que dio Corpy.' } }, required: ['vehiculo'] } },
  { name: 'crear_vehiculo', description: 'Da de alta un vehículo NUEVO en Flota cuando Álex lo pide («créala como la Peugeot Partner», «es una moto nueva, créala») — normalmente tras decirle Corpy que no existe. Si viene de un repostaje, se le asigna.', input_schema: { type: 'object', properties: { nombre: { type: 'string', description: 'Cómo la llamáis (Peugeot Partner, Moto de Javi…).' }, marca: { type: ['string', 'null'] }, modelo: { type: ['string', 'null'] }, matricula: { type: ['string', 'null'] }, tipo: { type: ['string', 'null'], enum: ['furgoneta', 'coche', 'camion', 'moto', 'remolque', 'otro', null] }, quien: { type: ['string', 'null'] }, repostajeId: { type: ['string', 'null'] } }, required: ['nombre'] } },
  { name: 'pedir_documento_vehiculo', description: 'Pide a quien lleva un vehículo (o a quien diga Álex) una foto de un papel de ese vehículo (ficha técnica, permiso, seguro, ITV). Úsalo cuando Corpy ha dicho que no tiene el papel y Álex dice «sí, pídeselo» o «pídele a Jose la ficha técnica de la Nissan».', input_schema: { type: 'object', properties: { vehiculo: { type: 'string' }, que: { type: 'string' }, trabajador: { type: ['string', 'null'] } }, required: ['vehiculo'] } },
  { name: 'repostajes_sin_vehiculo', description: 'Lista de repostajes que aún no tienen vehículo («qué repostajes faltan», «repostajes sin vehículo»).', input_schema: { type: 'object', properties: {} } },
  { name: 'apuntar_pendiente', description: 'Apunta un PENDIENTE o recordatorio para Álex («apúntame para el lunes repasar el PRT00852», «recuérdame llamar a Caterina»). Si dice un día, resuélvelo a YYYY-MM-DD. El texto es lo que hay que hacer, tal cual (con números de documento si los dice).', input_schema: { type: 'object', properties: { texto: { type: 'string' }, fecha: { type: ['string', 'null'] } }, required: ['texto'] } },
  { name: 'cerrar_pendientes', description: 'Cierra uno o VARIOS pendientes de Álex por su número: «hecho el pendiente 1, 2 y 3».', input_schema: { type: 'object', properties: { numeros: { type: 'array', items: { type: 'integer' } } }, required: ['numeros'] } },
  { name: 'consulta_clasica', description: 'El asistente de siempre, SOLO PARA CONSULTAR: un documento por número («dime el 309», «conceptos del 509»), presupuestos por estado o cliente, pedidos de trabajo, el resumen del negocio, cobros y a quién reclamar, el PDF de lo pendiente de cobro, notas de una comunidad. Escribe la consulta clara y completa con el nombre exacto (p. ej. «pedidos de CTAT PROP RUTLLA, 200-202»). Nunca para crear, cambiar, enviar o borrar.', input_schema: { type: 'object', properties: { consulta: { type: 'string' } }, required: ['consulta'] } },
];
const LECTURA = new Set(['facturas_cliente', 'buscar_compras', 'gasto_proveedor', 'documentos_vehiculo', 'consulta_clasica']);
const LECTORES = { facturas_cliente: facturasCliente, buscar_compras: buscarCompras, gasto_proveedor: gastoProveedor, documentos_vehiculo: documentosVehiculo, consulta_clasica: consultaClasica };

module.exports = { DENTRO, TOOLS, LECTURA, LECTORES, ejecutar, contextoReciente, _puntos: puntos, _casaProveedor: casaProveedor, _terminosMaterial: terminosMaterial };
