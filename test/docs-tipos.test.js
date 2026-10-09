// test/docs-tipos.test.js — Lo que guarda Corpy (documentos del alta) tiene que existir en la carpeta de Personal.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');
const P = require(path.join(root, 'src/personalDocs.js'));
const A = require(path.join(root, 'src/docsAlta.js'));

test('cada pieza del alta va a un tipo que existe en Personal', () => {
  for (const [pieza, tipo] of Object.entries(A.TIPO_PERSONAL)) assert.ok(P.TIPOS[tipo], `${pieza} → ${tipo} no existe`);
});
test('tipos de obra y de empresa para los contratistas (Seranco)', () => {
  for (const k of ['adhesion_pss', 'trab_designado', 'aut_libro', 'recibi_doc', 'contrato_obra']) assert.ok(P.TIPOS_OBRA[k]);
  for (const k of ['ita', 'cert_spa', 'mutua', 'seguro_acc', 'ta7', 'iae', 'cert_ss', 'rea', 'seguro_rc']) assert.ok(P.TIPOS_EMPRESA[k]);
});
