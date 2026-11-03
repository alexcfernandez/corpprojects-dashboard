// Avisos de Nuvo Voz (centralita): firma, idempotencia, recado → petición, urgentes, perdidas y bloque del día (3/11/2026).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const V = require('../src/nuvoVoz');

// Mongo de mentira: lo justo para estas consultas (igualdad, $in, $lt/$gte, $or, $ne).
function fakeDB() {
  const cols = {};
  const ok = (d, q) => Object.entries(q || {}).every(([k, v]) => {
    if (k === '$or') return v.some(x => ok(d, x));
    const x = k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), d);
    if (v && typeof v === 'object' && !(v instanceof Date) && Object.keys(v).some(c => c[0] === '$')) {
      return Object.entries(v).every(([op, w]) => op === '$in' ? (Array.isArray(x) ? x.some(y => w.includes(y)) : w.includes(x)) : op === '$lt' ? x < w : op === '$gte' ? x >= w : op === '$ne' ? x !== w : true);
    }
    return Array.isArray(x) ? x.includes(v) : (v instanceof Date ? +x === +v : (v && v._bsontype === 'ObjectId') ? String(x) === String(v) : x === v);
  });
  const upd = (d, u) => {
    for (const [k, v] of Object.entries(u.$set || {})) d[k] = v;
    for (const [k, v] of Object.entries(u.$inc || {})) d[k] = (d[k] || 0) + v;
    for (const k of Object.keys(u.$unset || {})) delete d[k];
    for (const [k, v] of Object.entries(u.$addToSet || {})) { d[k] = d[k] || []; for (const y of (v && v.$each) || [v]) if (!d[k].includes(y)) d[k].push(y); }
    for (const [k, v] of Object.entries(u.$push || {})) { d[k] = d[k] || []; d[k].push(...((v && v.$each) || [v])); }
  };
  const cursor = l => { const c = { sort: () => c, limit: n => { l = l.slice(0, n); return c; }, project: () => c, toArray: async () => l }; return c; };
  const collection = n => {
    const l = cols[n] = cols[n] || [];
    return {
      _l: l,
      insertOne: async d => { if (d._id == null) d._id = new (require('mongodb').ObjectId)(); if (l.some(x => x._id === d._id)) { const e = new Error('dup'); e.code = 11000; throw e; } l.push(d); return { insertedId: d._id }; },
      findOne: async q => l.find(d => ok(d, q)) || null,
      find: q => cursor(l.filter(d => ok(d, q))),
      updateOne: async (q, u, o = {}) => { let d = l.find(x => ok(x, q)); if (!d && o.upsert) { d = { _id: q._id }; l.push(d); } if (d) upd(d, u); return { matchedCount: d ? 1 : 0 }; },
      updateMany: async (q, u) => { l.filter(x => ok(x, q)).forEach(d => upd(d, u)); return {}; },
      findOneAndUpdate: async (q, u) => { const d = l.find(x => ok(x, q)); if (d) upd(d, u); return d || null; },
      countDocuments: async q => l.filter(d => ok(d, q)).length,
    };
  };
  return { collection, cols };
}

const SECRETO = 'clave-de-prueba-123';
const firmar = (cuerpo, t = Math.floor(Date.now() / 1000)) => ({ 'x-nuvo-tiempo': String(t), 'x-nuvo-firma': crypto.createHmac('sha256', SECRETO).update(`${t}.${cuerpo}`).digest('hex') });

test('firma: vale la buena; no valen otra clave, cuerpo tocado, más de 5 minutos ni basura', () => {
  const cuerpo = Buffer.from('{"evento":"prueba"}');
  const h = firmar(cuerpo);
  const base = { tiempo: h['x-nuvo-tiempo'], firma: h['x-nuvo-firma'], cuerpo, secreto: SECRETO };
  assert.strictEqual(V.firmaValida(base).ok, true);
  assert.strictEqual(V.firmaValida({ ...base, secreto: 'otra' }).ok, false);
  assert.strictEqual(V.firmaValida({ ...base, cuerpo: Buffer.from('{"evento":"prueba" }') }).ok, false);
  assert.strictEqual(V.firmaValida({ ...base, ahora: Date.now() + 301 * 1000 }).motivo, 'tiempo fuera de margen');
  assert.strictEqual(V.firmaValida({ ...base, firma: 'zz' }).ok, false);
  assert.strictEqual(V.firmaValida({ ...base, firma: undefined }).ok, false);
  assert.strictEqual(V.firmaValida({ ...base, secreto: '' }).ok, false);
});

test('recibir: recado una sola vez aunque reintenten; perdida guardada sin procesar; resumen por fecha; prueba sin nada', async () => {
  const db = fakeDB();
  const rec = { evento: 'recado.nuevo', empresa: 'corp', llamada: 'L1', fecha: '2026-11-03T10:15:00Z', urgente: false, resumen: 'URGENTE · Entra agua por el techo del 3º 1ª', contacto: { nombre: 'Marta', externalId: '123' }, final: '456' };
  const a = await V.recibir(rec, { _db: db });
  assert.strictEqual(a.id, 'recado.nuevo:L1');
  assert.deepStrictEqual(await V.recibir(rec, { _db: db }), { ya: true });
  assert.strictEqual(db.cols.llamadasVoz[0].urgente, true, 'urgente por el «URGENTE · » del resumen');
  const p = await V.recibir({ evento: 'llamada.perdida', empresa: 'corp', llamada: 'L1', fecha: '2026-11-03T10:14:00Z', motivo: 'Nadie ha podido atender', contacto: null, final: '456' }, { _db: db });
  assert.ok(p.guardado && !p.id);
  assert.deepStrictEqual(await V.recibir({ evento: 'prueba', empresa: 'corp', fecha: '2026-11-03T10:00:00Z' }, { _db: db }), { prueba: true });
  assert.ok((await V.recibir({ evento: 'recado.nuevo', empresa: 'otra' }, { _db: db })).ignorado);
  const r = { evento: 'resumen.diario', empresa: 'corp', fecha: '2026-11-03', entrantes: 20, salientes: 5, atendidas: 15, perdidas: 5, secretaria: 3, recados: 2, minutos: 140, porPersona: [{ nombre: 'Álex', atendidas: 9, minutos: 80 }] };
  await V.recibir(r, { _db: db }); await V.recibir({ ...r, minutos: 141 }, { _db: db });
  assert.strictEqual(db.cols.llamadasDia.length, 1);
  assert.strictEqual(db.cols.llamadasDia[0].minutos, 141);
  await assert.rejects(V.recibir({ evento: 'recado.nuevo', empresa: 'corp', fecha: '2026-11-03T10:00:00Z' }, { _db: db }), /falta la llamada/);
});

test('procesar: deRecado una vez, error → se reintenta y queda hecho', async () => {
  const db = fakeDB();
  await V.recibir({ evento: 'recado.nuevo', empresa: 'corp', llamada: 'L2', fecha: '2026-11-03T11:00:00Z', resumen: 'Presupuesto para pintar la escalera', contacto: null, final: '789' }, { _db: db });
  let n = 0;
  const falla = async () => { n++; throw new Error('IA caída'); };
  assert.deepStrictEqual(await V.procesar('recado.nuevo:L2', { _db: db, _deRecado: falla }), { error: 'IA caída' });
  assert.strictEqual(db.cols.llamadasVoz[0].estado, 'error');
  let visto = null;
  assert.strictEqual(await V.reintentar({ _db: db, _deRecado: async a => { visto = a; return { nuevas: [{ incidencia: 'INC00900' }] }; } }), 1);
  assert.strictEqual(db.cols.llamadasVoz[0].estado, 'hecho');
  assert.strictEqual(visto.final, '789');
  assert.strictEqual(await V.procesar('recado.nuevo:L2', { _db: db, _deRecado: falla }), null, 'ya hecho: no se repite');
  assert.strictEqual(n, 1);
});

test('bloque del día y perdidas sin recado (la perdida de una llamada que dejó recado no cuenta)', async () => {
  const db = fakeDB();
  await V.recibir({ evento: 'llamada.perdida', empresa: 'corp', llamada: 'A', fecha: '2026-11-03T09:00:00Z', motivo: 'Nadie ha podido atender', contacto: { nombre: 'Ctat. Bellpuig 41', externalId: '1' }, final: '111' }, { _db: db });
  await V.recibir({ evento: 'recado.nuevo', empresa: 'corp', llamada: 'A', fecha: '2026-11-03T09:01:00Z', urgente: true, resumen: 'URGENTE · Agua en el parking', contacto: { nombre: 'Ctat. Bellpuig 41', externalId: '1' }, final: '111' }, { _db: db });
  await V.recibir({ evento: 'llamada.perdida', empresa: 'corp', llamada: 'B', fecha: '2026-11-03T19:40:00Z', motivo: 'Fuera de horario', contacto: null, final: '222' }, { _db: db });
  const d = await V.datosDia('2026-11-03', { _db: db });
  assert.deepStrictEqual(d.perdidasSinRecado.map(p => p.llamada), ['B']);
  let t = V.textoDia(d);
  assert.match(t, /no ha mandado el resumen/);
  assert.match(t, /🚨 Ctat\. Bellpuig 41 …111 · Agua en el parking/);
  assert.match(t, /Perdidas sin recado \(devolver\): sin identificar …222 20:40 \(fuera de horario\)/);
  await V.recibir({ evento: 'resumen.diario', empresa: 'corp', fecha: '2026-11-03', entrantes: 20, salientes: 5, atendidas: 15, perdidas: 5, secretaria: 3, recados: 2, minutos: 140, porPersona: [{ nombre: 'Álex', atendidas: 9, minutos: 80 }, { nombre: 'Oficina', atendidas: 6, minutos: 60 }] }, { _db: db });
  t = V.textoDia(await V.datosDia('2026-11-03', { _db: db }));
  assert.match(t, /✅ Atendidas 15 · ❌ perdidas 5 · 🤖 SecretarIA 3 · 📝 recados 2 · ⏱ 140 min/);
  assert.match(t, /Por persona: Álex 9 \(80 min\) · Oficina 6 \(60 min\)/);
  assert.strictEqual(V.textoDia({ resumen: null, recados: [], perdidasSinRecado: [] }), null);
  const av = await V.perdidasParaAviso({ ahora: new Date('2026-11-04T07:15:00Z'), _db: db });
  assert.deepStrictEqual(av.map(p => p.quien), ['sin identificar …222']);
  const ID = require('../src/incidenciasDia');
  assert.match(ID.texto({ presupuestos: [], trabajos: [], sinInc: [], perdidas: av }), /Llamadas perdidas sin recado: devolverlas\* \(1\)\n• sin identificar …222/);
});

test('HTTP: la ruta firma sobre el cuerpo crudo aunque luego haya express.json; 401 sin firma; 200 y reintento sin duplicar', async () => {
  const dbm = require('../src/db'); const real = dbm.getDB; const db = fakeDB();
  const prev = process.env.NUVO_VOZ_WEBHOOK_SECRETO; process.env.NUVO_VOZ_WEBHOOK_SECRETO = SECRETO;
  const PG = require('../src/peticionesGrupo'); const realRec = PG.deRecado; let recados = 0;
  dbm.getDB = async () => db; PG.deRecado = async () => { recados++; return { nuevas: [] }; };
  const app = express();
  app.post('/api/nuvo-voz/eventos', express.raw({ type: () => true, limit: '256kb' }), (req, res) => V.manejar(req, res));
  app.use(express.json());
  const srv = http.createServer(app); await new Promise(r => srv.listen(0, r));
  const url = `http://127.0.0.1:${srv.address().port}/api/nuvo-voz/eventos`;
  try {
    // Con espacios y acentos: lo que se firma es el texto exacto, no el JSON re-serializado.
    const cuerpo = '{ "evento": "recado.nuevo", "empresa": "corp", "llamada": "H1", "fecha": "2026-11-03T12:00:00Z", "urgente": false, "resumen": "Gotera en el baño", "contacto": null, "final": "333" }';
    const post = (h, b = cuerpo) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'NuvoVoz/1', ...h }, body: b });
    assert.strictEqual((await post({})).status, 401);
    assert.strictEqual((await post(firmar(cuerpo, Math.floor(Date.now() / 1000) - 400))).status, 401);
    const r = await post(firmar(cuerpo));
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).id, 'recado.nuevo:H1');
    assert.deepStrictEqual(await (await post(firmar(cuerpo))).json(), { ok: true, ya: true });
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(recados, 1);
    assert.strictEqual(db.cols.llamadasVoz[0].estado, 'hecho');
    const prueba = '{"evento":"prueba","empresa":"corp","fecha":"2026-11-03T12:00:00Z"}';
    assert.strictEqual((await post(firmar(prueba), prueba)).status, 200);
  } finally { srv.close(); dbm.getDB = real; PG.deRecado = realRec; process.env.NUVO_VOZ_WEBHOOK_SECRETO = prev; if (prev === undefined) delete process.env.NUVO_VOZ_WEBHOOK_SECRETO; }
});

test('deRecado: petición con el cliente del externalId, incidencia creada y WhatsApp urgente a Álex y oficina', async () => {
  const dbm = require('../src/db'); const real = dbm.getDB; const db = fakeDB(); dbm.getDB = async () => db;
  const PG = require('../src/peticionesGrupo');
  const cat = { clientes: ['555 · Ctat. Bellpuig 41'], incidencias: [], presupuestos: [], nombre: id => (String(id) === '555' ? 'Ctat. Bellpuig 41' : '') };
  let prompt = '';
  const _llamar = async p => { prompt = p; return { peticiones: [{ msgs: [0], tipo: 'trabajo', cliente_id: null, cliente: 'Bellpuig 41', resumen: 'Entra agua en el parking', que_hacer: 'Ir a mirar hoy', urgente: true, situacion: 'nuevo' }] }; };
  const enviados = [];
  const prevO = process.env.OFICINA_TELEFONO, prevW = process.env.WHATSAPP_TO;
  process.env.OFICINA_TELEFONO = '+34600000002'; process.env.WHATSAPP_TO = '+34600000001';
  try {
    const r = await PG.deRecado({ llamada: 'R1', fecha: new Date('2026-11-03T10:00:00Z'), urgente: false, resumen: 'URGENTE · Entra agua en el parking de Bellpuig 41', contacto: { nombre: 'Marta (presidenta)', externalId: '555' }, final: '456', _llamar, _cat: cat, _clientMap: {},
      _auto: async (d, g, nuevas) => Object.fromEntries(nuevas.map(p => [String(p._id), { incidencia: 'INC00901' }])), _enviar: async (to, txt, o) => { enviados.push({ to, txt, o }); return true; } });
    assert.match(prompt, /cliente de StelOrder 555 · Ctat\. Bellpuig 41/);
    assert.match(prompt, /Marta \(presidenta\) \(teléfono acabado en 456\)/);
    assert.strictEqual(r.urgente, true);
    assert.strictEqual(r.nuevas[0].incidencia, 'INC00901');
    const p = db.cols.peticionesGrupo[0];
    assert.strictEqual(p.clienteId, '555', 'el cliente sale del externalId aunque la IA no lo ponga');
    assert.strictEqual(p.canal, 'llamada'); assert.strictEqual(p.jid, 'voz:corp'); assert.deepStrictEqual(p.llamadas, ['R1']);
    assert.deepStrictEqual(enviados.map(e => e.to), ['+34600000001', '+34600000002']);
    assert.ok(enviados.every(e => e.o.importante));
    assert.match(enviados[0].txt, /🚨 \*URGENTE · recado de SecretarIA\*[\s\S]*Entra agua en el parking[\s\S]*Incidencia creada: \*INC00901\*/);
    assert.deepStrictEqual(await PG.deRecado({ llamada: 'R1', resumen: 'x', _llamar, _cat: cat }), { ya: true });
    // No urgente: sin WhatsApp suelto.
    enviados.length = 0;
    await PG.deRecado({ llamada: 'R2', resumen: 'Presupuesto para pintar la escalera', contacto: null, final: '9', _llamar: async () => ({ peticiones: [{ msgs: [0], tipo: 'presupuesto', cliente: '¿?', resumen: 'Pintar escalera', que_hacer: 'Presupuesto', urgente: false, situacion: 'nuevo' }] }), _cat: cat, _clientMap: {}, _auto: async () => ({}), _enviar: async (to, txt) => { enviados.push(txt); return true; } });
    assert.strictEqual(enviados.length, 0);
  } finally { dbm.getDB = real; process.env.OFICINA_TELEFONO = prevO; process.env.WHATSAPP_TO = prevW; if (prevO === undefined) delete process.env.OFICINA_TELEFONO; if (prevW === undefined) delete process.env.WHATSAPP_TO; }
});

test('StelOrder: título corto y descripción ordenada (dónde, contacto y origen) para recados, correos y grupos', () => {
  const PG = require('../src/peticionesGrupo');
  const clientMap = { 555: { name: 'ILLA VERDA', 'legal-name': 'Ctat. Prop. Illa Verda', 'main-address': { 'address-data': 'C/ Bellpuig 41', 'postal-code': '17003', 'city-town': 'Girona' } } };
  const rec = { canal: 'llamada', jid: 'voz:corp', urgente: true, titulo: 'Fuga de agua', clienteId: '555', clienteStel: 'ILLA VERDA', cliente: 'Bellpuig 41', direccion: '3º 1ª', resumen: 'Fuga de agua en Bellpuig 41 (ILLA VERDA). El cliente llama para avisar.', fecha: new Date('2026-11-03T19:39:00Z'),
    recado: { nombre: 'Marta', final: '456', fecha: new Date('2026-11-03T19:39:00Z'), texto: 'URGENTE · Fuga de agua en Bellpuig 41 (ILLA VERDA). El cliente llama para avisar.' } };
  assert.strictEqual(PG.tituloPeticion(rec), 'URGENTE · Fuga de agua · ILLA VERDA');
  assert.strictEqual(PG.tituloPeticion({ ...rec, urgente: false, titulo: null }), 'Fuga de agua en Bellpuig 41 (ILLA VERDA) · ILLA VERDA');
  assert.deepStrictEqual(PG.detalle(rec, { clientMap, incidencia: 'INC00654' }), [
    'Dónde: Ctat. Prop. Illa Verda · C/ Bellpuig 41, 17003 Girona (3º 1ª)',
    'Contacto: Marta · teléfono acabado en 456 (completo en Nuvo Voz)',
    'Llamada del 03/11/2026 a las 20:39 · atendida por SecretarIA (Nuvo Voz) · INC00654']);
  assert.deepStrictEqual(PG.original(rec), ['Recado completo:', rec.recado.texto]);
  const correo = { canal: 'correo', grupo: 'Correo · finquescompany.com', resumen: 'Gotera', contacto: 'Jordi 600 000 000', fecha: new Date('2026-11-02T09:00:00Z'), mensajes: [{ fecha: new Date('2026-11-02T09:00:00Z'), quien: 'Jordi (correo)', texto: 'Hola' }] };
  assert.deepStrictEqual(PG.detalle(correo), ['Contacto: Jordi 600 000 000', 'Correo de finquescompany.com del 02/11/2026 a las 10:00']);
  assert.match(PG.detalle({ grupo: 'CINC', fecha: new Date('2026-11-02T09:00:00Z') })[0], /^Pedido en el grupo «CINC» el 02\/11\/2026 a las 10:00$/);
});

test('trabajos.crear: el pedido lleva título, producto según el tipo, descripción ordenada y el recado en la nota privada', async () => {
  const dbm = require('../src/db'); const real = dbm.getDB;
  const users = require('../src/users'); const realU = users.getUser;
  const asig = require('../src/asignaciones'); const realA = asig.setAssignment;
  const { ObjectId } = require('mongodb'); const id = new ObjectId();
  const p = { _id: id, canal: 'llamada', jid: 'voz:corp', tipo: 'trabajo', urgente: true, titulo: 'Fuga de agua', clienteId: '555', clienteStel: 'ILLA VERDA', cliente: 'Bellpuig 41', resumen: 'Fuga de agua en Bellpuig 41.', fecha: new Date('2026-11-03T19:39:00Z'),
    incidencia: 'INC00654', incidenciaId: '9', incidenciaCreadaAt: new Date(), recado: { nombre: 'Marta', final: '456', fecha: new Date('2026-11-03T19:39:00Z'), texto: 'URGENTE · Fuga de agua en Bellpuig 41.' } };
  const col = { findOne: async () => p, updateOne: async () => ({}), find: () => ({ toArray: async () => [] }) };
  dbm.getDB = async () => ({ collection: n => (n === 'bridgeGrupos' ? { ...col, findOne: async () => null } : col) });
  users.getUser = async () => ({ _id: 'u1', name: 'David' }); asig.setAssignment = async () => ({});
  let pedido = null;
  const _stel = { getClients: async () => ({ clientMap: { 555: { name: 'ILLA VERDA', 'main-address': { 'address-data': 'C/ Bellpuig 41', 'city-town': 'Girona' } } } }),
    generarPedidoDesdeIncidencia: async a => { pedido = a; return { id: '77', ref: 'PDT00560' }; } };
  try {
    await require('../src/trabajos').crear(String(id), { userId: 'u1', nota: 'Llevar escalera' }, 'Álex', { _stel, _enviar: async () => true });
    assert.strictEqual(pedido.titulo, 'URGENTE · Fuga de agua · ILLA VERDA');
    assert.strictEqual(pedido.tipo, 'actuacion');
    assert.strictEqual(pedido.descripcion, ['Fuga de agua en Bellpuig 41.', 'Dónde: ILLA VERDA · C/ Bellpuig 41, Girona', 'Contacto: Marta · teléfono acabado en 456 (completo en Nuvo Voz)', 'Nota de oficina: Llevar escalera', 'Llamada del 03/11/2026 a las 20:39 · atendida por SecretarIA (Nuvo Voz) · INC00654'].join('\n'));
    assert.match(pedido.notaPrivada, /^Recado completo:\nURGENTE · Fuga de agua/);
  } finally { dbm.getDB = real; users.getUser = realU; asig.setAssignment = realA; }
});

test('verificación por número: solo es automático si el recado es del cliente del número o de su familia', async () => {
  const PG = require('../src/peticionesGrupo');
  const cm = { 555: { name: 'ILLA VERDA', family: 'CINC' }, 556: { name: 'Bellpuig 43', family: 'CINC' }, 12043800: { name: 'Alex Castro', family: 'Particulares' }, 9: { name: 'Otro', family: 'Sin familia' }, 10: { name: 'Otro 2', family: 'Sin familia' } };
  assert.deepStrictEqual(PG.verificar('555', '555', cm), { ok: true });
  assert.deepStrictEqual(PG.verificar(null, '555', cm), { ok: true });
  assert.strictEqual(PG.verificar('556', '555', cm).familia, 'CINC');
  assert.strictEqual(PG.verificar('555', '12043800', cm).ok, false);
  assert.strictEqual(PG.verificar('9', '10', cm).ok, false, '«Sin familia» no cuenta como mismo administrador');
  assert.strictEqual(PG.verificar('555', null, cm).motivo, 'número desconocido u oculto');

  // La prueba de Álex: llama desde su móvil (Alex Castro) y dice «Bellpuig 41» → por confirmar, sin incidencia, aviso urgente con la duda.
  const dbm = require('../src/db'); const real = dbm.getDB; const db = fakeDB(); dbm.getDB = async () => db;
  const cat = { clientes: [], incidencias: [], presupuestos: [], nombre: id => (cm[String(id)] || {}).name || '' };
  const enviados = []; let auto = 0;
  const prevW = process.env.WHATSAPP_TO; process.env.WHATSAPP_TO = '+34600000001';
  try {
    const r = await PG.deRecado({ llamada: 'P1', fecha: new Date('2026-11-03T19:39:00Z'), urgente: true, resumen: 'URGENTE · Fuga de agua en Bellpuig 41', contacto: { nombre: 'Alex Castro', externalId: '12043800' }, final: '123', _cat: cat, _clientMap: cm,
      _llamar: async () => ({ peticiones: [{ msgs: [0], tipo: 'trabajo', cliente_id: '555', cliente: 'Bellpuig 41', resumen: 'Fuga de agua', que_hacer: 'Ir', urgente: true, situacion: 'nuevo' }] }),
      _auto: async (d, g, l) => { auto += l.length; return {}; }, _enviar: async (to, txt) => { enviados.push(txt); return true; } });
    assert.strictEqual(auto, 0, 'no se crea incidencia');
    assert.strictEqual(r.nuevas[0].porConfirmar, 'el número es de otro cliente');
    const p = db.cols.peticionesGrupo[0];
    assert.deepStrictEqual(p.porConfirmar.llama, { id: '12043800', nombre: 'Alex Castro' });
    assert.match(enviados[0], /Por confirmar\*: llama \*Alex Castro\* \(por su número\) y dice ser de \*ILLA VERDA\*/);
    await assert.rejects(require('../src/trabajos').crear(String(p._id), { userId: 'x' }), /por confirmar/);
    // La oficina lo confirma: sigue como una petición normal (incidencia y «¿Quién va?»).
    let confirmadas = [];
    const c = await PG.confirmar(String(p._id), {}, 'Álex', { _auto: async (d, g, l) => { confirmadas = l; return { [String(p._id)]: { incidencia: 'INC00700' } }; } });
    assert.deepStrictEqual(c, { ok: true, incidencia: 'INC00700', error: null });
    assert.strictEqual(confirmadas[0].clienteId, '555');
    assert.strictEqual(confirmadas[0].porConfirmar, undefined);
    assert.strictEqual(db.cols.peticionesGrupo[0].porConfirmar, undefined);
    assert.strictEqual(db.cols.peticionesGrupo[0].confirmada.por, 'Álex');
    await assert.rejects(PG.confirmar(String(p._id), {}, 'Álex'), /no está por confirmar/);
  } finally { dbm.getDB = real; process.env.WHATSAPP_TO = prevW; if (prevW === undefined) delete process.env.WHATSAPP_TO; }
});

test('pantalla 📞 Llamadas: perdidas sin recado, recados con su incidencia y «ya la he devuelto» la quita de todo', async () => {
  const db = fakeDB();
  const ahora = new Date('2026-11-03T20:00:00Z');
  await V.recibir({ evento: 'recado.nuevo', empresa: 'corp', llamada: 'R1', fecha: '2026-11-03T10:00:00Z', resumen: 'Goteras en el 3º', contacto: { nombre: 'Ctat. X', externalId: '9' }, final: '333' }, { _db: db });
  db.collection('llamadasVoz')._l[0].resultado = { nuevas: [{ id: 'p1', porConfirmar: null, incidencia: 'INC00100' }] };
  db.collection('llamadasVoz')._l[0].estado = 'hecho';
  await V.recibir({ evento: 'llamada.perdida', empresa: 'corp', llamada: 'R1', fecha: '2026-11-03T09:59:00Z', motivo: 'SecretarIA' }, { _db: db });
  await V.recibir({ evento: 'llamada.perdida', empresa: 'corp', llamada: 'P1', fecha: '2026-11-03T18:00:00Z', motivo: 'Nadie libre', final: '444' }, { _db: db });
  await V.recibir({ evento: 'llamada.perdida', empresa: 'corp', llamada: 'VIEJA', fecha: '2026-10-20T18:00:00Z', final: '555' }, { _db: db });
  let d = await V.panel({ ahora, _db: db });
  assert.deepStrictEqual(d.perdidas.map(p => p.final), ['444']);
  assert.strictEqual(d.recados.length, 1);
  assert.deepStrictEqual(d.recados[0].peticiones, [{ id: 'p1', porConfirmar: null, incidencia: 'INC00100' }]);
  assert.strictEqual(d.recados[0].nombre, 'Ctat. X');
  await V.marcarDevuelta('llamada.perdida:P1', 'Álex', { _db: db });
  d = await V.panel({ ahora, _db: db });
  assert.deepStrictEqual(d.perdidas, []);
  assert.deepStrictEqual(await V.perdidasParaAviso({ ahora, _db: db }), []);
  await assert.rejects(V.marcarDevuelta('recado.nuevo:R1', 'Álex', { _db: db }), /no encontrada/);
});

test('cada llamada es su propia petición: solo se junta con un recado del mismo número de hace pocos minutos', async () => {
  const dbm = require('../src/db'); const real = dbm.getDB; const db = fakeDB(); dbm.getDB = async () => db;
  const PG = require('../src/peticionesGrupo');
  const cm = { 555: { name: 'ILLA VERDA', family: 'CINC' } };
  const cat = { clientes: [], incidencias: [], presupuestos: [], nombre: id => (cm[String(id)] || {}).name || '' };
  const prompts = [];
  const nueva = resumen => async p => { prompts.push(p); return { peticiones: [{ msgs: [0], tipo: 'trabajo', cliente: '¿?', resumen, que_hacer: 'Ir', urgente: false, situacion: 'nuevo' }] }; };
  const base = { _cat: cat, _clientMap: cm, _auto: async () => ({}), _enviar: async () => true };
  try {
    // Lo de la prueba del 3/11: 20:38 ILLA VERDA (…489) y 21:17 otra persona (…108) → dos peticiones.
    await PG.deRecado({ ...base, llamada: 'A', fecha: new Date('2026-11-03T19:38:00Z'), resumen: 'Fuga en Bellpuig 41', contacto: { nombre: 'Alex', externalId: '555' }, final: '489', _llamar: nueva('Fuga en Bellpuig 41') });
    const r2 = await PG.deRecado({ ...base, llamada: 'B', fecha: new Date('2026-11-03T20:17:00Z'), resumen: 'Fuga en Ronda Pellús', contacto: { nombre: 'Caterin Cardona' }, final: '108', _llamar: nueva('Fuga en Ronda Pellús') });
    assert.match(prompts[1], /PETICIONES ABIERTAS[^\n]*\n\(ninguna\)/, 'la IA no ve la petición de otra llamada');
    assert.strictEqual(db.cols.peticionesGrupo.length, 2);
    assert.strictEqual(r2.nuevas.length, 1);
    // El mismo número vuelve a llamar a los 5 minutos: la IA sí ve su petición y puede juntarlas.
    await PG.deRecado({ ...base, llamada: 'C', fecha: new Date('2026-11-03T20:22:00Z'), resumen: 'Sigue saliendo agua', contacto: { nombre: 'Caterin Cardona' }, final: '108',
      _llamar: async p => { prompts.push(p); return { peticiones: [{ msgs: [0], actualiza: String(db.cols.peticionesGrupo[1]._id), tipo: 'trabajo', cliente: '¿?', resumen: 'Sigue saliendo agua', situacion: 'seguimiento' }] }; } });
    assert.match(prompts[2], /Fuga en Ronda Pellús/);
    assert.doesNotMatch(prompts[2], /Fuga en Bellpuig 41/);
    assert.deepStrictEqual(db.cols.peticionesGrupo[1].llamadas, ['B', 'C']);
    // Una hora después, aunque sea el mismo número, ya es otra petición.
    await PG.deRecado({ ...base, llamada: 'D', fecha: new Date('2026-11-03T21:30:00Z'), resumen: 'Otra cosa', contacto: { nombre: 'Caterin Cardona' }, final: '108', _llamar: nueva('Otra cosa') });
    assert.match(prompts[3], /PETICIONES ABIERTAS[^\n]*\n\(ninguna\)/);
    assert.strictEqual(db.cols.peticionesGrupo.length, 3);
  } finally { dbm.getDB = real; }
});

test('nombre de oído: «Caterin Cardona» propone a Katerin Cardona cuando el número no es de nadie', async () => {
  const PG = require('../src/peticionesGrupo');
  const cm = { 1: { name: 'KATERIN CARDONA', phone: '' }, 2: { name: 'Carmen Cardona Ruiz', phone: '' }, 3: { name: 'Ctat. Bellpuig 41', phone: '' } };
  assert.deepStrictEqual(PG.porNombre('Caterin Cardona', cm), { id: '1', nombre: 'KATERIN CARDONA' });
  assert.deepStrictEqual(PG.porNombre('Katherine Cardona', cm), { id: '1', nombre: 'KATERIN CARDONA' }, 'h muda y una letra de más');
  assert.deepStrictEqual(PG.porNombre('Caterín Cardona (vecina)', cm), { id: '1', nombre: 'KATERIN CARDONA' }, 'acentos y paréntesis');
  assert.strictEqual(PG.porNombre('Cardona', cm), null, 'una sola palabra no basta');
  assert.strictEqual(PG.porNombre('Pedro Cardona', cm), null);
  // Dos que casan: desempata el teléfono de la ficha con las 3 últimas cifras.
  const dos = { 1: { name: 'Katerin Cardona', phone: '+34 600 111 108' }, 4: { name: 'Katerin Cardona Pons', phone: '600222333' } };
  assert.strictEqual(PG.porNombre('Caterin Cardona', dos), null);
  assert.deepStrictEqual(PG.porNombre('Caterin Cardona', dos, '108'), { id: '1', nombre: 'Katerin Cardona' });

  const dbm = require('../src/db'); const real = dbm.getDB; const db = fakeDB(); dbm.getDB = async () => db;
  const cat = { clientes: [], incidencias: [], presupuestos: [], nombre: id => (cm[String(id)] || {}).name || '' };
  let prompt = ''; const enviados = [];
  const prevW = process.env.WHATSAPP_TO; process.env.WHATSAPP_TO = '+34600000001';
  try {
    const r = await PG.deRecado({ llamada: 'K1', fecha: new Date('2026-11-03T20:17:00Z'), urgente: true, resumen: 'URGENTE · Fuga de agua en casa', contacto: { nombre: 'Caterin Cardona' }, final: '108', _cat: cat, _clientMap: cm,
      _llamar: async p => { prompt = p; return { peticiones: [{ msgs: [0], tipo: 'trabajo', cliente: 'Caterin Cardona', resumen: 'Fuga de agua', que_hacer: 'Ir', urgente: true, situacion: 'nuevo' }] }; },
      _auto: async () => ({}), _enviar: async (to, txt) => { enviados.push(txt); return true; } });
    assert.match(prompt, /puede ser el cliente 1 · KATERIN CARDONA/);
    const p = db.cols.peticionesGrupo[0];
    assert.strictEqual(r.nuevas[0].porConfirmar, 'número desconocido u oculto', 'el nombre no basta: sigue por confirmar');
    assert.strictEqual(p.clienteId, '1');
    assert.deepStrictEqual(p.porConfirmar.propuesto, { id: '1', nombre: 'KATERIN CARDONA' });
    assert.match(enviados[0], /un número desconocido \(por el nombre parece \*KATERIN CARDONA\*\)/);
  } finally { dbm.getDB = real; process.env.WHATSAPP_TO = prevW; if (prevW === undefined) delete process.env.WHATSAPP_TO; }
});

test('«¿Quién va?»: «lo hace Álex» o «voy yo» asigna a Álex; lo que no se entiende se vuelve a preguntar, nunca al propuesto', async () => {
  const { ObjectId } = require('mongodb');
  const dbm = require('../src/db'); const real = dbm.getDB; const db = fakeDB(); dbm.getDB = async () => db;
  const W = require('../src/waLog'), U = require('../src/users'), T = require('../src/trabajos');
  const realHilo = W.hilo, realUsers = U.getUsers, realCrear = T.crear;
  const pid = new ObjectId();
  await db.collection('peticionesGrupo').insertOne({ _id: pid, cliente: 'ILLA VERDA', tipo: 'trabajo', propuestaQuien: { userId: 'd1', nombre: 'David Taladros' } });
  const users = [{ _id: 'a1', name: 'Álex', nombreCompleto: 'Alex Castro', role: 'owner', whatsapp: '+34600000001' }, { _id: 'd1', name: 'David Taladros', nombreCompleto: 'David Valencia Roca', role: 'tecnico' }, { _id: 's1', name: 'Diego', role: 'tecnico' }];
  let ultimoIn = '';
  W.hilo = async () => ({ mensajes: [{ dir: 'out', texto: `🔧 *Trabajo: ¿quién va?* ILLA VERDA\n\n(ref. trabajo ${pid})` }, { dir: 'in', texto: ultimoIn }] });
  U.getUsers = async () => users;
  const asignados = []; T.crear = async (id, o) => { asignados.push(o.userId); return { pedido: 'PDT1', incidencia: 'INC1', operario: users.find(u => u._id === o.userId).name, equipo: [], avisado: true }; };
  const TS = require('../src/trabajosSeguimiento');
  try {
    assert.match(await TS.respuestaQuien('lo hace Álex', '+34600000001'), /para \*Álex\*/);
    assert.match(await TS.respuestaQuien('voy yo', '+34600000001'), /para \*Álex\*/);
    assert.match(await TS.respuestaQuien('que vaya Diego', '+34600000001'), /para \*Diego\*/);
    assert.deepStrictEqual(asignados, ['a1', 'a1', 's1']);
    asignados.length = 0;
    const r = await TS.respuestaQuien('lo hace Pepito', '+34600000001');
    assert.match(r, /No sé quién es «pepito»[\s\S]*¿Quién va a \*ILLA VERDA\*[\s\S]*ref\. trabajo/);
    assert.deepStrictEqual(asignados, [], 'no asigna a nadie, y menos al propuesto');
    assert.match(await TS.respuestaQuien('vale', '+34600000001'), /para \*David Taladros\*/, '«vale» sí es el propuesto');
    assert.strictEqual(await TS.respuestaQuien('gracias', '+34600000001'), null, 'lo que no es de asignar sigue al agente');
    // El agente (IA) no puede poner al propuesto si Álex no lo ha nombrado.
    const p = await db.collection('peticionesGrupo').findOne({ _id: pid });
    ultimoIn = 'lo hace Álex';
    assert.strictEqual(await TS.nombrado(users[1], p, '+34600000001', { users }), false);
    assert.strictEqual(await TS.nombrado(users[0], p, '+34600000001', { users }), true);
    ultimoIn = 'voy yo mañana';
    assert.strictEqual(await TS.nombrado(users[0], p, '+34600000001', { users }), true);
    ultimoIn = 'vale, el jueves';
    assert.strictEqual(await TS.nombrado(users[1], p, '+34600000001', { users }), true);
    ultimoIn = 'que vaya David Valencia el jueves';
    assert.strictEqual(await TS.nombrado(users[1], p, '+34600000001', { users }), true, 'por el nombre completo');
  } finally { dbm.getDB = real; W.hilo = realHilo; U.getUsers = realUsers; T.crear = realCrear; }
});

test('recado urgente nuevo de «seguimiento» sin incidencia: crea la suya y pregunta quién va', async () => {
  const dbm = require('../src/db'); const real = dbm.getDB; const db = fakeDB(); dbm.getDB = async () => db;
  const PG = require('../src/peticionesGrupo');
  const cm = { 1: { name: 'KATERIN CARDONA', family: 'Particulares' } };
  const cat = { clientes: [], incidencias: [], presupuestos: [], nombre: id => (cm[String(id)] || {}).name || '' };
  let paraAuto = [];
  try {
    await PG.deRecado({ llamada: 'K2', fecha: new Date('2026-11-03T20:17:00Z'), urgente: true, resumen: 'URGENTE · Ya llamé antes: sigue la fuga', contacto: { nombre: 'Katerin Cardona', externalId: '1' }, final: '108', _cat: cat, _clientMap: cm,
      _llamar: async () => ({ peticiones: [{ msgs: [0], tipo: 'trabajo', cliente_id: '1', cliente: 'Katerin Cardona', resumen: 'Fuga', que_hacer: 'Ir', urgente: true, situacion: 'seguimiento' }] }),
      _auto: async (d, g, l) => { paraAuto = l; return {}; }, _enviar: async () => true });
    assert.strictEqual(paraAuto.length, 1);
    assert.strictEqual(paraAuto[0].situacion, 'nuevo', '_autoIncidencias solo actúa sobre «nuevo»: crea INC y pregunta quién va');
    // Con incidencia ya enlazada no se toca.
    await PG.deRecado({ llamada: 'K3', fecha: new Date('2026-11-03T22:00:00Z'), resumen: 'Sigue la fuga', contacto: { nombre: 'Katerin Cardona', externalId: '1' }, final: '108', _cat: cat, _clientMap: cm,
      _llamar: async () => ({ peticiones: [{ msgs: [0], tipo: 'trabajo', cliente_id: '1', cliente: 'Katerin Cardona', resumen: 'Fuga', que_hacer: 'Ir', urgente: false, situacion: 'seguimiento', incidencia: 'INC00660' }] }),
      _auto: async (d, g, l) => { paraAuto = l; return {}; }, _enviar: async () => true });
    assert.strictEqual(paraAuto[0].situacion, 'seguimiento');
  } finally { dbm.getDB = real; }
});
