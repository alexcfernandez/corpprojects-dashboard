'use strict';
const test = require('node:test');
const assert = require('node:assert');
const T = require('../src/tiempoSocios');
function fakeDb() { const l = []; return { l, collection: () => ({ insertOne: async d => { d._id = 'x' + l.length; l.push(d); return { insertedId: d._id }; },
  find: q => ({ sort: () => ({ toArray: async () => l.filter(d => !q.obraId || d.obraId === q.obraId) }), toArray: async () => l.filter(d => !q.fecha || new RegExp(q.fecha.$regex).test(d.fecha)) }) }) }; }

test('«Alfonso y yo, de 10:30 a 11 a ver la obra de Laura (Llagostera)»: 30 min × 2, km de ida y vuelta, cuenta en la obra', async () => {
  const db = fakeDb();
  const d = await T.apuntar({ quienes: ['Alfonso', 'yo'], obra: 'obra de Laura', tipo: 'visita', fecha: '2026-10-27', desde: '10:30', hasta: '11:00' }, 'Álex',
    { _db: db, _obraDeTexto: async () => ({ _id: 'o1', reference: 'Campedretas', address: 'C/ Gerani 24, Llagostera' }) });
  assert.deepStrictEqual(d.quienes, ['Alfonso', 'Álex']);
  assert.strictEqual(d.minutos, 30);
  assert.strictEqual(d.km, 44);
  assert.strictEqual(d.coste, Math.round((0.5 * T.TARIFA() * 2 + 44 * T.EUR_KM()) * 100) / 100);
  const o = await T.deObra('o1', { _db: db });
  assert.strictEqual(o.minutos, 60);
  const m = await T.resumenMes('2026-10', { _db: db });
  assert.strictEqual(m.find(p => p.quien === 'Álex').horas, 0.5);
});

test('sin duración no se apunta; presupuestos en la oficina no llevan km', async () => {
  const db = fakeDb();
  await assert.rejects(T.apuntar({ quienes: ['yo'], tipo: 'visita' }, '', { _db: db, _obraDeTexto: async () => null }), /Cuánto rato/);
  const d = await T.apuntar({ quienes: ['yo'], cliente: 'Sing', tipo: 'presupuesto', minutos: 60 }, '', { _db: db, _obraDeTexto: async () => null });
  assert.strictEqual(d.km, null);
  assert.strictEqual(d.cliente, 'Sing');
});
