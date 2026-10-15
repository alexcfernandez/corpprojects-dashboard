// test/deuda-por-familia.test.js — "lo que nos deben por familias": total + bloques
// por familia (mayor deuda primero, "Sin familia" al final), sin pasar por la IA.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');

const generic = { async findOne() { return null; }, async updateOne() { return {}; }, async insertOne() { return { insertedId: 'x' }; }, async deleteOne() { return {}; }, find() { return { sort() { return { async toArray() { return []; } }; } }; } };
const dbPath = require.resolve(path.join(root, 'src/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDB: async () => ({ collection: () => generic }), getDBLegacy: async () => ({ db: { collection: () => generic }, client: { async close() {} } }) } };

process.env.OWNER_NUMBERS = '+34611223344';
delete process.env.ANTHROPIC_API_KEY; // enrutado determinista: no debe hacer falta la IA
process.env.JWT_SECRET = 'test-secret';
process.env.DASHBOARD_URL = 'https://dash.test';

const asistente = require(path.join(root, 'src/asistente.js'));
const stel = require(path.join(root, 'src/stelorder.js'));

stel.getClients = async () => ({ clientMap: {}, families: [] });
stel.getPendingInvoices = async () => [
  { number: 'FAC00001', client: 'RUTLLA 70-72',              family: 'FINQUES ROCA', pending: 100 },
  { number: 'FAC00002', client: 'RUTLLA 70-72',              family: 'FINQUES ROCA', pending: 50 },
  { number: 'FAC00003', client: 'CTAT PROP RUTLLA, 200-202', family: 'FINQUES ROCA', pending: 300 },
  { number: 'FAC00004', client: 'ILLA VERDA',                family: 'BELLPUIG',     pending: 1000 },
  { number: 'FAC00005', client: 'Particular Pérez',          family: '',             pending: 2000 },
];

const OWNER = 'whatsapp:+34611223344';
const norm = s => s.replace(/\s/g, ' ');

for (const frase of ['lo que nos deben por familias', '¿Qué nos deben por bloques de familia?', 'deuda agrupada por familia', 'listado de facturas pendientes por familia'])
  test(`«${frase}» → listado por familia`, async () => {
    const r = norm(await asistente.responderConsulta(frase, OWNER));
    assert.match(r, /Total pendiente: 3\.?450,00 €/);
    assert.match(r, /5 facturas · 2 familias \+ sin familia/);
  });

test('bloques: mayor deuda primero, clientes con subtotal, "Sin familia" al final', async () => {
  const r = norm(await asistente.responderConsulta('lo que nos deben por familias', OWNER));
  assert.match(r, /\*BELLPUIG\* — \*1\.?000,00 €\* · 1 fact\./);
  assert.match(r, /\*FINQUES ROCA\* — \*450,00 €\* · 3 fact\./);
  assert.match(r, /• CTAT PROP RUTLLA, 200-202 — 300,00 €/);
  assert.match(r, /• RUTLLA 70-72 — 150,00 € \(2\)/);
  assert.ok(r.indexOf('BELLPUIG') < r.indexOf('FINQUES ROCA'));
  assert.ok(r.indexOf('FINQUES ROCA') < r.indexOf('Sin familia')); // aunque deba más, va al final
  assert.ok(r.indexOf('CTAT PROP') < r.indexOf('RUTLLA 70-72'));
});

test('«qué debe la familia Bellpuig» NO es el listado por familias', async () => {
  const r = await asistente.responderConsulta('qué debe la familia Bellpuig', OWNER);
  assert.doesNotMatch(r, /Total pendiente: 3\.?450/);
});

// ── PDF para imprimir (pendientesFamiliaPdf) ──
const PF = require(path.join(root, 'src/pendientesFamiliaPdf.js'));

test('Corpy manda el enlace firmado al PDF y el enlace es válido', async () => {
  const r = await asistente.responderConsulta('mándame el pdf de lo que nos deben', OWNER);
  const m = r.match(/https:\/\/dash\.test\/informe\/pendientes\/(\S+)/);
  assert.ok(m, r);
  assert.equal(PF.verificarEnlace(m[1]), true);
  assert.equal(PF.verificarEnlace(m[1].slice(0, -2) + 'xx'), false);                 // manipulado
  const E = require(path.join(root, 'src/enlaceDoc.js'));
  assert.equal(PF.verificarEnlace(E.crear('0'.repeat(24))), false);                // un /d/ de documento no sirve aquí
});

test('PDF: A4 válido, varias páginas si hace falta, con filtros de la pestaña', async () => {
  const { PDFDocument } = require('pdf-lib');
  const muchas = Array.from({ length: 120 }, (_, k) => ({ number: 'FAC' + k, client: 'Comunitat Prop. Carrer Àngel Guimerà ' + k + ' — L·lobet', family: k % 2 ? 'FINQUES ROCA' : '', pending: 10 + k, daysOverdue: k, alertLevel: k >= 60 ? 'critical' : 'ok' }));
  const buf = await PF.generar(muchas);
  assert.equal(buf.slice(0, 4).toString(), '%PDF');
  const doc = await PDFDocument.load(buf);
  assert.ok(doc.getPageCount() >= 3);
  assert.deepEqual(doc.getPage(0).getSize(), { width: 595.28, height: 841.89 });
  assert.equal(PF.filtrar(muchas, { nivel: 'critical' }).length, 60);
  assert.equal(PF.filtrar(muchas, { familia: 'Sin familia' }).length, 60);
  assert.equal(PF.filtrar(muchas, { q: 'Guimerà 7' }).length, 11); // 7 y 70-79
  assert.equal((await PDFDocument.load(await PF.generar([]))).getPageCount(), 1); // sin datos: no rompe
});

test('agrupar/eur: orden por deuda, "Sin familia" al final, miles con punto', () => {
  const g = PF.agrupar([{ client: 'A', family: 'X', pending: 1 }, { client: 'B', family: '', pending: 9000 }, { client: 'C', family: 'Y', pending: 5 }]);
  assert.deepEqual(g.bloques.map(b => b.nombre), ['Y', 'X', 'Sin familia']);
  assert.equal(PF.eur(1234567.5), '1.234.567,50 €');
});

// ── Aviso de los viernes: resumen + PDF a Álex, Alfonso y la oficina ──
test('viernes: destinatarios por defecto (dueño + Alfonso + oficina), sin duplicados', () => {
  process.env.WHATSAPP_TO = '+34611223344';
  delete process.env.PENDIENTES_FAMILIA_TO; delete process.env.ADMIN_TELEFONO; delete process.env.OFICINA_TELEFONO;
  assert.deepEqual(PF.destinatariosViernes(), ['+34611223344', '+34692270438', '+34674013723']);
  process.env.PENDIENTES_FAMILIA_TO = '+34611223344, 611223344,whatsapp:+34600111222';
  assert.deepEqual(PF.destinatariosViernes(), ['+34611223344', '+34600111222']);
  delete process.env.PENDIENTES_FAMILIA_TO;
});

test('viernes: manda a los 3 el total, las familias y el enlace al PDF', async () => {
  const N = require(path.join(root, 'src/notifications.js'));
  const enviados = [];
  const orig = N.sendWhatsAppTo;
  N.sendWhatsAppTo = async (to, txt) => { enviados.push({ to, txt }); return true; };
  try {
    const r = await PF.avisoViernes({ hoy: '2026-10-16' });
    assert.equal(r.enviado, true);
    assert.deepEqual(enviados.map(e => e.to), ['+34611223344', '+34692270438', '+34674013723']);
    const t = enviados[0].txt;
    assert.match(t, /Total: 3\.450,00 €/);
    assert.ok(t.indexOf('BELLPUIG') < t.indexOf('FINQUES ROCA') && t.indexOf('FINQUES ROCA') < t.indexOf('Sin familia'));
    const m = t.match(/\/informe\/pendientes\/(\S+)/);
    assert.ok(m && PF.verificarEnlace(m[1]));
  } finally { N.sendWhatsAppTo = orig; }
});
