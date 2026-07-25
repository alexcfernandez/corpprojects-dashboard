// test/fase4b-buenosdias.test.js — fusión de las 08:00: composición del "buenos
// días" a partir de secciones (colectores). Un solo mensaje, sin duplicados.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { componerBuenosDias } = require('../src/scheduler');

test('une SOLO las secciones con contenido, en UN mensaje con una sola cabecera', () => {
  const msg = componerBuenosDias(['📌 *Pendientes* (1):\n1. algo', null, '📅 *Hoy en el calendario:*\n• reunión', '', undefined]);
  assert.match(msg, /^☀️ \*Buenos días\./);
  assert.match(msg, /Pendientes/);
  assert.match(msg, /Hoy en el calendario/);
  assert.equal((msg.match(/Buenos días/g) || []).length, 1); // no duplica cabecera
});

test('sin ninguna sección con contenido → null (no se manda nada)', () => {
  assert.equal(componerBuenosDias([null, '', undefined]), null);
  assert.equal(componerBuenosDias([]), null);
  assert.equal(componerBuenosDias(undefined), null);
});

test('separador \\n\\n entre secciones (sin duplicar)', () => {
  assert.match(componerBuenosDias(['A', 'B']), /A\n\nB/);
});
