'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

test('Alfonso (socio): su confirmación le llega a Álex como acción, con el PRT si lo dice', () => {
  const A = require('../src/acceso');
  assert.match(A.avisoDeSocio('Alfonso', 'Ya está aceptado y programado para el lunes, PRT 874'), /¿Marco el \*PRT00874\* como aceptado\?/);
  assert.match(A.avisoDeSocio('Alfonso Gálvez', 'Han dicho que sí al presupuesto de Joan Maragall'), /^🤝 \*Alfonso\*[\s\S]*qué presupuesto marco/);
  assert.doesNotMatch(A.avisoDeSocio('Alfonso', 'Lo llamamos, nunca lo coge'), /👉/);
});

test('estado_presupuesto: «PRT00874 aceptado» lo cambia en StelOrder; solo Álex', async () => {
  const cambios = [];
  stub('src/acceso.js', { esOwner: f => f === 'whatsapp:+34600000000' });
  stub('src/stelorder.js', { getWorkEstimates: async () => [{ id: 61812345, 'full-reference': 'PRT00874', title: 'Joan Maragall 44', 'account-id': 1 }], setWorkEstimateState: async (id, st) => { cambios.push([id, st]); return { ok: true }; } });
  stub('src/memoria.js', { apuntar: async () => ({}) });
  delete require.cache[require.resolve('../src/agenteExtra')];
  const X = require('../src/agenteExtra');
  const r = await X.ejecutar('estado_presupuesto', { ref: '874', estado: 'aceptado' }, 'whatsapp:+34600000000');
  assert.match(r.reply, /PRT00874.*aceptado/);
  assert.deepStrictEqual(cambios, [[61812345, 1120656]]);
  const r2 = await X.ejecutar('estado_presupuesto', { ref: 'PRT00874', estado: 'aceptado' }, 'whatsapp:+34611111111');
  assert.match(r2.reply, /solo lo cambia Álex/);
  assert.strictEqual(cambios.length, 1);
});
