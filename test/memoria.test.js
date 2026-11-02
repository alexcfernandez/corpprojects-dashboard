// test/memoria.test.js — Memoria de Corpy (2/11/2026): hechos por sitio, el nuevo sustituye al viejo, aislamiento por
// grupo, correcciones que arreglan el origen y «tiene nómina = está de alta».
const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/memoria');

// Mongo de mentira con lo que usa memoria.js: findOne/find/insertOne/updateOne/updateMany/distinct y $ne/$in/$or/$nin/$gte.
function fakeDb(sem = {}) {
  const datos = { memoria: [], ...sem }; let n = 0;
  const get = (d, k) => k.split('.').reduce((o, x) => (o == null ? undefined : o[x]), d);
  const eq = (v, w) => (Array.isArray(v) ? v.some(x => String(x) === String(w)) : String(v) === String(w));
  const ok = (d, q) => Object.entries(q).every(([k, c]) => {
    if (k === '$or') return c.some(s => ok(d, s));
    const v = get(d, k);
    if (c && typeof c === 'object' && !(c instanceof Date) && !Array.isArray(c) && Object.keys(c).some(x => x[0] === '$')) return Object.entries(c).every(([op, w]) =>
      op === '$ne' ? !(v == null ? w == null : eq(v, w)) : op === '$in' ? w.some(x => eq(v, x)) : op === '$nin' ? !w.some(x => (x == null ? v == null : eq(v, x))) : op === '$gte' ? v >= w : op === '$exists' ? (v !== undefined) === w : true);
    return c === null ? v == null : eq(v, c);
  });
  const col = name => { const l = (datos[name] = datos[name] || []); return {
    findOne: async q => l.find(d => ok(d, q)) || null,
    find: q => { let r = l.filter(d => ok(d, q || {})); const cur = { sort: s => { const [k, dir] = Object.entries(s)[0]; r = [...r].sort((a, b) => (get(a, k) > get(b, k) ? dir : -dir)); return cur; }, limit: m => { r = r.slice(0, m); return cur; }, toArray: async () => r }; return cur; },
    insertOne: async d => { d._id = d._id || 'm' + (++n); l.push(d); return { insertedId: d._id }; },
    updateOne: async (q, u) => { const d = l.find(x => ok(x, q)); if (d) Object.assign(d, u.$set || {}); return { matchedCount: d ? 1 : 0 }; },
    updateMany: async (q, u) => { const ds = l.filter(x => ok(x, q)); ds.forEach(d => Object.assign(d, u.$set || {})); return { modifiedCount: ds.length }; },
    distinct: async (k, q) => [...new Set(l.filter(d => ok(d, q || {})).map(d => get(d, k)))],
  }; };
  return { datos, collection: col };
}
const CINC = 'cinc@g.us', OTRO = 'otro@g.us';

test('una petición del grupo deja contacto y línea de tiempo del sitio; el contacto nuevo sustituye al viejo', async () => {
  const db = fakeDb();
  const p = { _id: 'p1', jid: CINC, cliente: 'Ctat. Prop. Joan Maragall 44-46', clienteId: '11111', direccion: '5º 3ª', tipo: 'trabajo', contacto: 'Matilde', resumen: 'Pierde agua del patio de luces', queHacer: 'Ir a mirar', incidencia: 'INC00653', fecha: new Date('2026-11-02T10:00:00Z') };
  await M.dePeticion(p, { _db: db });
  // Misma petición puesta al día (resultado de Alfonso + contacto bueno): una sola línea, contacto cambiado.
  await M.dePeticion({ ...p, contacto: 'Josep Maria', resumen: 'Pierde agua del patio de luces. Alfonso: no hay pérdida, óxido en los montantes' }, { _db: db });
  const vivos = db.datos.memoria.filter(h => h.vigente);
  assert.deepStrictEqual(vivos.filter(h => h.tipo === 'contacto').map(h => h.texto), ['Josep Maria']);
  assert.strictEqual(db.datos.memoria.filter(h => h.tipo === 'aviso').length, 1);
  const r = await M.consultar({ texto: 'joan maragall 44 5º 3ª' }, { _db: db, _presupuestos: async () => [{ 'full-reference': 'PRT00877', 'account-id': 11111, date: new Date().toISOString(), 'document-state-id': 1120656, title: 'Bajantes', 'total-amount': 900 }] });
  const t = M.resumen(r);
  assert.match(t, /Joan Maragall 44-46 · 5º 3ª — contacto: Josep Maria/);
  assert.match(t, /óxido en los montantes.*\(INC00653\)/);
  assert.match(t, /PRT00877 aceptado Bajantes/);
});

test('aislamiento: en un grupo solo sale lo de ese grupo o sus clientes, nunca lo interno', async () => {
  const db = fakeDb({ peticionesGrupo: [{ jid: CINC, clienteId: '11111' }] });
  await M.apuntar({ sujeto: { tipo: 'cliente', id: '11111', nombre: 'Joan Maragall 44-46' }, sitio: 'parking', tipo: 'material', texto: 'Fluorescente de 1,60', ambito: 'cliente' }, { _db: db });
  await M.apuntar({ sujeto: { tipo: 'cliente', id: '22222', nombre: 'Rutlla 202' }, tipo: 'contacto', unico: 'contacto', texto: 'Pep 600000000', ambito: 'cliente', jids: [OTRO] }, { _db: db });
  await M.apuntar({ sujeto: { tipo: 'persona', id: 'u1', nombre: 'Javier Huaca' }, tipo: 'estado', unico: 'alta', texto: 'De alta', ambito: 'interno' }, { _db: db });
  const grupo = await M.consultar({ paraGrupo: CINC }, { _db: db });
  assert.deepStrictEqual(grupo.hechos.map(h => h.texto), ['Fluorescente de 1,60']);
  const trabajador = await M.consultar({ interno: false }, { _db: db });
  assert.ok(!trabajador.hechos.some(h => h.ambito === 'interno'));
  const alex = await M.consultar({ texto: 'Javier' }, { _db: db });
  assert.deepStrictEqual(alex.hechos.map(h => h.texto), ['De alta']);
});

test('quien tiene nómina de la gestoría está de alta: se cierra su ficha y queda en la memoria', async () => {
  const db = fakeDb({ docsPersonal: [{ userId: 'u1', tipo: 'nomina', estado: 'ok' }], incorporaciones: [{ _id: 'i1', userId: 'u1', nombre: 'Javier Orlando Huaca Páez', estado: 'abierta' }, { _id: 'i2', userId: 'u2', nombre: 'Nuevo', estado: 'abierta' }] });
  const cerradas = [];
  const r = await M.cerrarAltasConNomina({ _db: db, _cerrar: async id => cerradas.push(id) });
  assert.deepStrictEqual([r, cerradas], [['Javier Orlando Huaca Páez'], ['i1']]);
  assert.match(db.datos.memoria[0].texto, /nómina/);
});

test('socios fuera de los papeles de trabajador', () => {
  assert.strictEqual(M.esSocio({ name: 'Alfonso' }), true);
  assert.strictEqual(M.esSocio({ name: 'Alex' }), true);
  assert.strictEqual(M.esSocio({ name: 'Javier Huaca' }), false);
});

test('corregir un contacto de comunidad lo guarda y lo pone en su petición abierta', async () => {
  const db = fakeDb({ peticionesGrupo: [{ _id: 'p1', jid: CINC, cliente: 'Ctat. Prop. Joan Maragall 44-46', clienteId: '11111', direccion: '5º 3ª', estado: 'pendiente', resumen: 'Pierde agua', fecha: new Date() }] });
  const r = await M.corregir({ sobre: 'Joan Maragall 44-46', sitio: '5º 3ª', tipo: 'contacto', texto: 'Josep Maria 600111222' }, { _db: db });
  assert.strictEqual(db.datos.peticionesGrupo[0].contacto, 'Josep Maria 600111222');
  assert.strictEqual(r.hechos[0].clienteId, '11111');
  assert.deepStrictEqual(r.hechos[0].jids, [CINC]);
  assert.strictEqual(r.arreglos.length, 1);
});
