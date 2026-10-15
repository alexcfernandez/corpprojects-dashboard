// test/incorporaciones.test.js — Formulario de elementos esenciales (Som Assessors) relleno y reglas del alta.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('src/db.js', { getDB: async () => ({}) });
const I = require(path.join(root, 'src/incorporaciones.js'));

test('condiciones por defecto: indefinida, peón, convenio, jornada completa y 15 días de prueba', () => {
  const c = I.condiciones({});
  assert.equal(c.tipo, 'indefinida'); assert.equal(c.categoria, 'peo'); assert.equal(c.salario, 'conveni'); assert.equal(c.jornada, 'completa'); assert.equal(c.prueba15, true);
  assert.deepEqual(I._consultar(c), []);
});
test('lo que Som Assessors pide consultar antes bloquea el formulario', () => {
  assert.match(I._consultar(I.condiciones({ tipo: 'temporal' })).join(), /no es indefinido/);
  assert.match(I._consultar(I.condiciones({ incentivos: true })).join(), /incentivos/);
  const c = I.condiciones({ salario: 'superior', salarioImporte: '26.500,50', jornada: 'parcial', horasSemana: '20' });
  assert.equal(c.salarioImporte, 26500.5); assert.equal(c.horasSemana, 20);
});
test('rellena la plantilla real: datos, casillas y fecha, y queda aplanada', async () => {
  const buf = await I.rellenarFormulario({ nombre: 'Norman Samael Martínez Martínez', dni: '07190669H', fechaInicio: '2026-10-19', condiciones: I.condiciones({ categoria: 'oficial_1' }) });
  const { PDFDocument } = require('pdf-lib');
  const pdf = await PDFDocument.load(buf);
  assert.equal(pdf.getPageCount(), 3);
  assert.equal(pdf.getForm().getFields().length, 0);   // aplanado: ya no se puede editar
  assert.ok(buf.length > 50000);
});
