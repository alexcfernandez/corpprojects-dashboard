// Cierre del MES para la gestoría (3/11/2026): periodo por mes en trimestre.js, pasos marcables y aviso del día 5.
const test = require('node:test');
const assert = require('node:assert');

// DB falsa: colecciones en memoria con lo justo (findOne, updateOne con upsert y $set con «a.b», find().project().toArray()).
function fakeDB(datos = {}) {
  const cols = {};
  const col = n => (cols[n] = cols[n] || {
    docs: datos[n] || [],
    async findOne(q) { return this.docs.find(d => d._id === q._id) || null; },
    async updateOne(q, u, o = {}) {
      let d = this.docs.find(x => x._id === q._id);
      if (!d) { if (!o.upsert) return; d = { _id: q._id }; this.docs.push(d); }
      for (const [k, v] of Object.entries(u.$set || {})) {
        const ps = k.split('.'); let t = d;
        while (ps.length > 1) { const p = ps.shift(); t = t[p] = t[p] || {}; }
        t[ps[0]] = v;
      }
    },
    find(q = {}) {
      const docs = this.docs.filter(d => !q.estado || d.estado === q.estado).filter(d => !q.fecha || (d.fecha >= q.fecha.$gte && d.fecha <= q.fecha.$lte));
      const r = { project: () => r, sort: () => r, limit: () => r, toArray: async () => docs.slice() };
      return r;
    },
  });
  return { collection: col, _cols: cols };
}

const T = require('../src/trimestre');
const C = require('../src/cierreMes');

test('rango() acepta meses además de trimestres; mes y trimestre por defecto', () => {
  const m = T.rango('2026-10');
  assert.strictEqual(m.tipo, 'mes'); assert.strictEqual(m.from, '2026-10-01'); assert.strictEqual(m.to, '2026-10-31');
  assert.strictEqual(m.n, 4); assert.strictEqual(m.tag, '10_Octubre'); assert.strictEqual(m.label, 'Octubre 2026');
  assert.strictEqual(T.rango('2026-02').to, '2026-02-28');
  const q = T.rango('2026-T3');
  assert.strictEqual(q.tipo, 'trimestre'); assert.strictEqual(q.tag, 'Q3'); assert.strictEqual(q.to, '2026-09-30');
  assert.throws(() => T.rango('2026-13'));
  assert.strictEqual(T.mesPorDefecto(new Date(2026, 10, 3)), '2026-10');    // hasta el día 10, el anterior
  assert.strictEqual(T.mesPorDefecto(new Date(2026, 10, 11)), '2026-11');
  assert.strictEqual(T.mesPorDefecto(new Date(2027, 0, 5)), '2026-12');
  assert.deepStrictEqual(T.mesesDe('2026-T4'), ['2026-10', '2026-11', '2026-12']);
});

test('pasos: marcar con quién, no cerrar con pasos pendientes, cerrar y reabrir', async () => {
  const db = fakeDB();
  let c = await C.get('2026-10', { conAuto: false, _db: db });
  assert.strictEqual(c.hechos, 0); assert.strictEqual(c.total, C.PASOS.length); assert.strictEqual(c.cerrado, false);
  c = await C.marcar('2026-10', 'compras', true, 'María', { _db: db });
  const p = c.pasos.find(x => x.k === 'compras');
  assert.strictEqual(p.hecho, true); assert.strictEqual(p.por, 'María');
  await assert.rejects(() => C.cerrar('2026-10', 'María', { _db: db }), /Faltan 6 paso/);
  await assert.rejects(() => C.marcar('2026-10', 'inventado', true, 'María', { _db: db }), /Paso no válido/);
  for (const x of C.PASOS) await C.marcar('2026-10', x.k, true, 'María', { _db: db });
  c = await C.cerrar('2026-10', 'María', { _db: db });
  assert.strictEqual(c.cerrado, true); assert.strictEqual(c.cerradoPor, 'María');
  await assert.rejects(() => C.marcar('2026-10', 'punteo', false, 'María', { _db: db }), /cerrado/);
  c = await C.reabrir('2026-10', 'Álex', { _db: db });
  assert.strictEqual(c.cerrado, false);
  const t = await C.delTrimestre('2026-T4', { _db: db });
  assert.deepStrictEqual(t.meses.map(m => m.mes), ['2026-10', '2026-11', '2026-12']);
  assert.strictEqual(t.meses[0].hechos, C.PASOS.length);
});

test('lo que dice el sistema: compras del mes por revisar y sin obra', async () => {
  const db = fakeDB({ compras: [
    { _id: 'a', estado: 'por_revisar', fecha: '2026-10-03', obraId: null, destino: 'obra' },
    { _id: 'b', estado: 'por_revisar', fecha: '2026-10-20', obraId: 'x', destino: 'obra' },
    { _id: 'c', estado: 'por_revisar', fecha: '2026-11-02', obraId: null },
  ] });
  const estado = async () => ({ pendientes: { gestoria: [{}], correosSinAdjunto: [], correosSinRevisar: [{}], banco: { cubre: true, hasta: '2026-10-31' } } });
  const a = await C.auto('2026-10', { _db: db, _estado: estado });
  assert.strictEqual(a.compras.n, 2); assert.match(a.compras.txt, /1 sin obra/);
  assert.strictEqual(a.emitidas.n, 1); assert.strictEqual(a.recibidas.n, 1);
  assert.strictEqual(a.extractos.n, 1);   // Santander al día, pero tarjetas/Revolut sin subir
});

test('aviso del día 5: solo laborable (o el lunes si cae en finde), del mes anterior y si no está cerrado', async () => {
  assert.strictEqual(C.tocaAviso(new Date(2026, 10, 5)), true);    // jueves 5/11/2026
  assert.strictEqual(C.tocaAviso(new Date(2026, 10, 4)), false);
  assert.strictEqual(C.tocaAviso(new Date(2026, 11, 7)), true);    // 5/12/2026 es sábado → lunes 7
  assert.strictEqual(C.tocaAviso(new Date(2026, 11, 5)), false);   // el sábado no
  const prev = process.env.FICHAJE_AVISOS_TO; process.env.FICHAJE_AVISOS_TO = '+34600000001,+34600000002';
  try {
    const db = fakeDB(); const env = [];
    const r = await C.avisoDia5({ hoy: new Date(2026, 10, 5), _db: db, _estado: async () => null, _enviar: async (to, t) => env.push([to, t]) });
    assert.strictEqual(r.enviado, true); assert.strictEqual(r.mes, '2026-10'); assert.strictEqual(env.length, 2);
    assert.match(env[0][1], /Cierre de Octubre 2026/); assert.match(env[0][1], /faltan 7 de 7/);
    for (const x of C.PASOS) await C.marcar('2026-10', x.k, true, 'María', { _db: db });
    await C.cerrar('2026-10', 'María', { _db: db });
    const r2 = await C.avisoDia5({ hoy: new Date(2026, 10, 5), _db: db, _estado: async () => null, _enviar: async () => { throw new Error('no debería'); } });
    assert.strictEqual(r2.enviado, false); assert.strictEqual(r2.motivo, 'cerrado');
    process.env.CIERRE_MES = 'off';
    assert.strictEqual((await C.avisoDia5({ hoy: new Date(2026, 10, 5), forzar: true, _db: db })).motivo, 'apagado');
  } finally { delete process.env.CIERRE_MES; if (prev == null) delete process.env.FICHAJE_AVISOS_TO; else process.env.FICHAJE_AVISOS_TO = prev; }
});
