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
    return Array.isArray(x) ? x.includes(v) : (v instanceof Date ? +x === +v : x === v);
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
      insertOne: async d => { if (d._id == null) d._id = String(l.length + 1) + 'x'.repeat(23); if (l.some(x => x._id === d._id)) { const e = new Error('dup'); e.code = 11000; throw e; } l.push(d); return { insertedId: d._id }; },
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
    const r = await PG.deRecado({ llamada: 'R1', fecha: new Date('2026-11-03T10:00:00Z'), urgente: false, resumen: 'URGENTE · Entra agua en el parking de Bellpuig 41', contacto: { nombre: 'Marta (presidenta)', externalId: '555' }, final: '456', _llamar, _cat: cat,
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
    await PG.deRecado({ llamada: 'R2', resumen: 'Presupuesto para pintar la escalera', contacto: null, final: '9', _llamar: async () => ({ peticiones: [{ msgs: [0], tipo: 'presupuesto', cliente: '¿?', resumen: 'Pintar escalera', que_hacer: 'Presupuesto', urgente: false, situacion: 'nuevo' }] }), _cat: cat, _auto: async () => ({}), _enviar: async (to, txt) => { enviados.push(txt); return true; } });
    assert.strictEqual(enviados.length, 0);
  } finally { dbm.getDB = real; process.env.OFICINA_TELEFONO = prevO; process.env.WHATSAPP_TO = prevW; if (prevO === undefined) delete process.env.OFICINA_TELEFONO; if (prevW === undefined) delete process.env.WHATSAPP_TO; }
});
