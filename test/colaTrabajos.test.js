// colaTrabajos.js — cola de trabajos aceptados: pasos, grúa sin reservar, juntar grúas, Corpy y aviso diario (4/11/2026). Todo simulado.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ObjectId } = require('mongodb');
const Q = require('../src/colaTrabajos');

const val = (d, k) => k.split('.').reduce((o, p) => (o == null ? o : o[p]), d);
const igual = (a, b) => String(a) === String(b);
function cumple(d, q) {
  return Object.entries(q || {}).every(([k, v]) => {
    if (k === '$or') return v.some(x => cumple(d, x));
    const x = val(d, k);
    if (v && typeof v === 'object' && !(v instanceof ObjectId) && !(v instanceof Date)) {
      if ('$ne' in v) return !igual(x, v.$ne) || (x === undefined && v.$ne !== undefined && false);
      if ('$in' in v) return v.$in.some(y => igual(x, y));
      if ('$gte' in v) return x != null && x >= v.$gte;
    }
    return igual(x, v);
  });
}
function dbFalsa(cols) {
  return { cols, collection: n => ({
    findOne: async q => (cols[n] || []).find(d => cumple(d, q)) || null,
    find: q => ({ toArray: async () => (cols[n] || []).filter(d => cumple(d, q)), sort() { return this; } }),
    updateOne: async (q, u) => { const d = (cols[n] || []).find(x => cumple(x, q)); if (d && u.$set) for (const [k, v] of Object.entries(u.$set)) { const ps = k.split('.'); let o = d; ps.slice(0, -1).forEach(p => { o = o[p] = o[p] || {}; }); o[ps[ps.length - 1]] = v; } return { matchedCount: d ? 1 : 0 }; },
  }) };
}
const lista = (x = {}) => ({ _id: new ObjectId(), obraId: 'o1', obraRef: 'Cartagena 2-4-6', direccion: 'Cartagena 2, Girona', estado: 'comprando', creado: new Date('2026-11-04T10:00:00Z'),
  prt: { id: '1', numero: 'PRT00876', titulo: 'Pinchos', total: 3000 }, resumen: 'Pinchos antipalomas en cornisa', nota: 'Con camión grúa y escalera desde los balcones',
  medios: ['Camión grúa (pluma)'], items: [{ id: 'm1', material: 'Varillas', cantidad: 6, tenemos: 2 }, { id: 'm2', material: 'Adhesivo', cantidad: 36, tenemos: 0 }], ...x });

test('medio: lo que diga Álex manda; si no, sale de la nota y de los medios', () => {
  assert.strictEqual(Q.medioDe(lista()), 'grua');
  assert.strictEqual(Q.medioDe(lista({ nota: '', medios: ['Andamio en la fachada de la farmacia'] })), 'andamio');
  assert.strictEqual(Q.medioDe(lista({ cola: { medio: 'plataforma' } })), 'plataforma');
  assert.strictEqual(Q.medioDe(lista({ nota: '', medios: [] })), null);
});

test('pasos: comprando → por programar → programado → hecho, y el día pasado sin parte se pone rojo', () => {
  const hoy = '2026-11-05';
  assert.strictEqual(Q.tarjeta(lista(), { hoy }).paso, 'materiales');
  const completa = lista({ estado: 'completa', completaAt: new Date('2026-11-01T10:00:00Z'), items: [] });
  const t = Q.tarjeta(completa, { hoy });
  assert.strictEqual(t.paso, 'programar'); assert.strictEqual(t.semaforo, 'ambar');
  const pet = { asignado: { nombre: 'David', fecha: '2026-11-10', hora: '08:00', equipo: ['Diego'] }, pedido: { id: '9', ref: 'PDT00100' } };
  const p = Q.tarjeta({ ...completa, cola: { reservado: true } }, { pet, hoy });
  assert.strictEqual(p.paso, 'programado'); assert.strictEqual(p.operario, 'David'); assert.strictEqual(p.semaforo, 'verde');
  const pasado = Q.tarjeta({ ...completa, cola: { reservado: true } }, { pet, hoy: '2026-11-13' });
  assert.strictEqual(pasado.semaforo, 'rojo'); assert.match(pasado.alertas.join(' '), /¿Se hizo\?/);
  assert.strictEqual(Q.tarjeta(completa, { pet, acabado: true, hoy }).paso, 'hecho');
});

test('grúa con día y sin reservar: ámbar a 5 días, rojo a 2, y aviso para reservarla aunque falte material', () => {
  const l = lista({ cola: { fecha: '2026-11-09' } });
  const a = Q.tarjeta(l, { hoy: '2026-11-05' });
  assert.strictEqual(a.semaforo, 'ambar'); assert.match(a.alertas[0], /Reservar la grúa/);
  assert.strictEqual(Q.tarjeta(l, { hoy: '2026-11-07' }).semaforo, 'rojo');
  assert.strictEqual(Q.tarjeta({ ...l, cola: { fecha: '2026-11-09', reservado: true } }, { hoy: '2026-11-08' }).alertas.some(x => /Reservar/.test(x)), false);
  assert.strictEqual(Q.tarjeta(l, { hoy: '2026-10-30' }).alertas.length, 0);
});

test('dos trabajos con grúa sin reservar → sugiere juntarlos el mismo día', () => {
  const ts = [Q.tarjeta(lista(), { hoy: '2026-11-05' }), Q.tarjeta(lista({ obraRef: 'Creu 2', prt: { numero: 'PRT00881' } }), { hoy: '2026-11-05' }), Q.tarjeta(lista({ obraRef: 'Creu 42', nota: '', medios: ['andamio'] }), { hoy: '2026-11-05' })];
  const s = Q.sugerencias(ts, '2026-11-05');
  assert.strictEqual(s.length, 1); assert.match(s[0], /2 trabajos con camión grúa/); assert.match(s[0], /Cartagena/); assert.doesNotMatch(s[0], /Creu 42/);
});

test('Corpy: «Cartagena el lunes 9 con grúa» → día al calendario (sin trabajo mandado) y aviso de reservar; «reservada» lo quita', async () => {
  const l = lista();
  const db = dbFalsa({ listasMateriales: [l, lista({ obraRef: 'Creu 42 · PRT00726', prt: { numero: 'PRT00726' } })], peticionesGrupo: [] });
  const eventos = [];
  const deps = { _db: db, _cal: { crearEventoPersonal: async e => { eventos.push(e); return 'ev1'; }, deleteEvent: async id => eventos.push({ borrado: id }) }, _fijar: async () => { throw new Error('no debe llamarse'); } };
  const r = await Q.corpy({ trabajo: 'Cartagena', fecha: '2099-11-09', medio: 'grua' }, 'Álex (Corpy)', deps);
  assert.match(r, /Falta reservar la grúa/);
  assert.strictEqual(eventos.length, 1); assert.match(eventos[0].titulo, /Cartagena 2-4-6 · PRT00876 \(camión grúa\)/);
  assert.strictEqual(l.cola.eventoId, 'ev1');
  const r2 = await Q.corpy({ trabajo: '876', reservado: true, proveedorMedio: 'Grualpa' }, 'Álex (Corpy)', deps);
  assert.match(r2, /reservada/); assert.doesNotMatch(r2, /Falta reservar/);
  assert.strictEqual(eventos.length, 1, 'el mismo día no vuelve a tocar el calendario');
  const amb = await Q.corpy({ trabajo: 'xyz inexistente' }, 'Álex', deps);
  assert.strictEqual(amb.aclara, true);
});

test('con el trabajo ya mandado, el día cambia la cita del operario (no el calendario)', async () => {
  const pid = new ObjectId();
  const l = lista({ estado: 'completa', peticionId: String(pid) });
  const db = dbFalsa({ listasMateriales: [l], peticionesGrupo: [{ _id: pid, pedido: { id: '77', ref: 'PDT00077' }, asignado: { nombre: 'David', fecha: '2099-11-09', hora: '08:00' } }] });
  const citas = [];
  const deps = { _db: db, _cal: { crearEventoPersonal: async () => { throw new Error('no'); }, deleteEvent: async () => {} }, _fijar: async (wo, x) => { citas.push([wo, x]); } };
  await Q.actualizar(String(l._id), { fecha: '2099-11-09', hora: '08:00' }, 'Panel', deps);
  assert.strictEqual(citas.length, 0, 'mismo día y hora: nada');
  await Q.actualizar(String(l._id), { fecha: '2099-11-12', hora: '08:00' }, 'Panel', deps);
  assert.deepStrictEqual(citas, [['77', { fecha: '2099-11-12', hora: '08:00' }]]);
});

test('aviso diario: solo si algo pide acción; el lunes, la cola entera', async () => {
  const enviados = [];
  const _enviar = async t => enviados.push(t);
  const nada = dbFalsa({ listasMateriales: [lista({ creado: new Date(), nota: '', medios: [] })], peticionesGrupo: [], workOrderAssignments: [], partes: [] });
  assert.strictEqual(await Q.avisoDiario({ _db: nada, _enviar, lunes: false }), null);
  const lun = await Q.avisoDiario({ _db: nada, _enviar, lunes: true });
  assert.match(lun, /Cola de trabajos aceptados/);
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
  const urg = dbFalsa({ listasMateriales: [lista({ creado: new Date(), cola: { fecha: hoy } })], peticionesGrupo: [], workOrderAssignments: [], partes: [] });
  const t = await Q.avisoDiario({ _db: urg, _enviar, lunes: false });
  assert.match(t, /Reservar la grúa para hoy/);
  assert.strictEqual(enviados.length, 2);
});
