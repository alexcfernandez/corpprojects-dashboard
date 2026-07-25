// test/fase4b-fechas.test.js — recordatorios con fecha: parser (hoy inyectado),
// conservación del texto, formato del resumen y enlace con Google Calendar (mock).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');

// ── Mocks de ./calendar y ./db (antes de requerir pendientes) ──
let upsertCalls = [], deleteCalls = [], upsertShouldThrow = false;
const calPath = require.resolve(path.join(root, 'src/calendar.js'));
require.cache[calPath] = { id: calPath, filename: calPath, loaded: true, exports: {
  async upsertEvent(plan) { upsertCalls.push(plan); if (upsertShouldThrow) throw new Error('gcal caído'); return 'evt_' + upsertCalls.length; },
  async deleteEvent(id) { deleteCalls.push(id); },
  targetCalendarId() { return 'primary'; },
} };

let rows = [], seq = 0;
const col = {
  async insertOne(d) { const _id = 'p' + (seq++); rows.push({ _id, ...d }); return { insertedId: _id }; },
  find(q) { const f = rows.filter(r => (q && q.estado) ? r.estado === q.estado : true); return { sort() { return { async toArray() { return f.slice(); } }; } }; },
  async updateOne(q, u) { const r = rows.find(x => x._id === q._id); if (r && u.$set) Object.assign(r, u.$set); return {}; },
  async findOne(q) { return rows.find(x => x._id === q._id) || null; },
};
const dbPath = require.resolve(path.join(root, 'src/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDB: async () => ({ collection: () => col }) } };

const P = require(path.join(root, 'src/pendientes.js'));
const HOY = '2026-07-25';
const weekdayOf = (iso) => new Date(iso + 'T00:00:00Z').getUTCDay();

// ── Parser de fecha ──
test('mañana / pasado / hoy', () => {
  assert.equal(P.parseFecha('mañana llamar', HOY).iso, '2026-07-26');
  assert.equal(P.parseFecha('pasado mañana', HOY).iso, '2026-07-27');
  assert.equal(P.parseFecha('hoy', HOY).iso, '2026-07-25');
});
test('en N días / en una semana / la semana que viene', () => {
  assert.equal(P.parseFecha('en 3 días', HOY).iso, '2026-07-28');
  assert.equal(P.parseFecha('en una semana', HOY).iso, '2026-08-01');
  assert.equal(P.parseFecha('la semana que viene', HOY).iso, '2026-08-01');
  assert.equal(P.parseFecha('en dos semanas', HOY).iso, '2026-08-08');
});
test('nombre de día → próxima ocurrencia (1..7 días, weekday correcto)', () => {
  const r = P.parseFecha('el martes llamar a la gestoría', HOY);
  assert.equal(weekdayOf(r.iso), 2); // martes
  const delta = (new Date(r.iso + 'T00:00:00Z') - new Date(HOY + 'T00:00:00Z')) / 86400000;
  assert.ok(delta >= 1 && delta <= 7);
});
test('"el 28" (aún no pasó) → este mes; "el 13" (ya pasó) → ambiguo', () => {
  assert.equal(P.parseFecha('el 28', HOY).iso, '2026-07-28');
  assert.deepEqual(P.parseFecha('el 13', HOY), { ambiguo: true });
});
test('día imposible (31 de un mes de 30) → ambiguo', () => {
  assert.deepEqual(P.parseFecha('el 31', '2026-06-10'), { ambiguo: true });
});
test('sin mención de fecha → null', () => {
  assert.equal(P.parseFecha('hacer la factura de la EICA', HOY), null);
});
test('quitar borra solo la muletilla de fecha (conserva el resto)', () => {
  const r = P.parseFecha('el martes llamar a la gestoría', HOY);
  assert.equal('el martes llamar a la gestoría'.replace(r.quitar, ' ').replace(/\s{2,}/g, ' ').trim(), 'llamar a la gestoría');
});

// ── Conservación del texto (bug 4a) ──
test('detectarIntent conserva el texto tal cual ("de la EICA")', () => {
  assert.equal(P.detectarIntent('recuérdame hacer la factura de la EICA').texto, 'hacer la factura de la EICA');
  assert.equal(P.limpiarVerbo('recuérdame llamar a Pedro'), 'llamar a Pedro');
});

// ── Formato del resumen: vencido / hoy / futuro / sin fecha ──
test('seccionResumen marca vencido/hoy/futuro/sin fecha', async () => {
  rows = [
    { _id: 'a', estado: 'abierto', texto: 'vencido', paraISO: '2026-07-20', createdAt: new Date(1) },
    { _id: 'b', estado: 'abierto', texto: 'hoy', paraISO: '2026-07-25', createdAt: new Date(2) },
    { _id: 'c', estado: 'abierto', texto: 'futuro', paraISO: '2026-07-28', createdAt: new Date(3) },
    { _id: 'd', estado: 'abierto', texto: 'sin fecha', paraISO: null, createdAt: new Date(4) },
  ];
  const sec = await P.seccionResumen(HOY);
  assert.match(sec, /vencido — ⚠️ vencido/);
  assert.match(sec, /hoy — 📌 vence hoy/);
  assert.match(sec, /futuro — 📅/);
  assert.match(sec, /\d+\. sin fecha(?!.*—)/); // la línea "sin fecha" no lleva marca
});

// ── Google Calendar (mock) ──
test('pendiente CON fecha → upsertEvent + guarda gcalEventId', async () => {
  rows = []; seq = 0; upsertCalls = []; deleteCalls = []; upsertShouldThrow = false;
  const p = await P.addPendiente('llamar a la gestoría', '+34x', { para: '2026-07-28' });
  assert.equal(upsertCalls.length, 1);
  assert.equal(upsertCalls[0].tipo, 'pendiente');
  assert.equal(upsertCalls[0].date, '2026-07-28');
  assert.equal(p.gcalEventId, 'evt_1');
});
test('pendiente SIN fecha → NO llama a upsertEvent', async () => {
  rows = []; seq = 0; upsertCalls = [];
  const p = await P.addPendiente('cosa sin fecha', '+34x', { para: null });
  assert.equal(upsertCalls.length, 0);
  assert.equal(p.gcalEventId, null);
});
test('si upsertEvent lanza, el pendiente se guarda igual', async () => {
  rows = []; seq = 0; upsertCalls = []; upsertShouldThrow = true;
  const p = await P.addPendiente('con fecha pero gcal roto', '+34x', { para: '2026-07-28' });
  assert.ok(p && p.id);            // guardado
  assert.equal(p.gcalEventId, null);
  assert.equal(rows.length, 1);
  upsertShouldThrow = false;
});
test('cerrar un pendiente con evento → deleteEvent', async () => {
  rows = []; seq = 0; upsertCalls = []; deleteCalls = [];
  await P.addPendiente('con fecha', '+34x', { para: '2026-07-28' }); // crea evt_1
  const done = await P.cerrarPendiente({ idx: 1 });
  assert.equal(done.texto, 'con fecha');
  assert.deepEqual(deleteCalls, ['evt_1']);
});
