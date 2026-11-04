const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const iaUso = require('../src/iaUso');

test('quién llama: primer marco de src/ que no es iaUso.js', () => {
  const pila = `Error
    at envuelto (${path.join('/app', 'src', 'iaUso.js')}:50:20)
    at _llamarIA (${path.join('/app', 'src', 'peticionesGrupo.js')}:87:19)
    at async _tanda (${path.join('/app', 'src', 'peticionesGrupo.js')}:130:3)`;
  assert.strictEqual(iaUso._quienLlama(pila), 'peticionesGrupo.js:_llamarIA');
  assert.strictEqual(iaUso._quienLlama(`Error\n    at ${path.join('/app', 'src', 'agente.js')}:9:1`), 'agente.js');
  assert.strictEqual(iaUso._quienLlama('Error\n    at node:internal/x:1:1'), 'desconocido');
});

test('coste: Sonnet 4.6 frente a Haiku 4.5, con caché', () => {
  const u = { input_tokens: 1e6, output_tokens: 1e5, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 0 };
  assert.strictEqual(Math.round(iaUso._coste('claude-sonnet-4-6', u) * 100) / 100, 3 + 1.5 + 0.3);
  assert.strictEqual(Math.round(iaUso._coste('claude-haiku-4-5', u) * 100) / 100, 1 + 0.5 + 0.1);
});

test('el envoltorio no toca la respuesta ni otras URLs', async () => {
  const antes = global.fetch;
  const vistas = [];
  global.fetch = async (url) => { vistas.push(String(url)); return new Response(JSON.stringify({ model: 'claude-haiku-4-5', usage: { input_tokens: 10, output_tokens: 2 }, content: [{ type: 'text', text: 'hola' }] }), { status: 200 }); };
  try {
    iaUso.instalar();
    iaUso.instalar(); // dos veces no envuelve dos veces
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 50 }) });
    assert.strictEqual((await r.json()).content[0].text, 'hola');
    const o = await fetch('https://example.com/x');
    assert.ok(o.ok);
    assert.deepStrictEqual(vistas, ['https://api.anthropic.com/v1/messages', 'https://example.com/x']);
  } finally { global.fetch = antes; }
});

test('modelos: lo automático va a Haiku 4.5 salvo que IA_AUTO_MODEL diga otra cosa', () => {
  const ia = require('../src/config').ia;
  const antes = process.env.IA_AUTO_MODEL;
  delete process.env.IA_AUTO_MODEL;
  assert.strictEqual(ia.auto, 'claude-haiku-4-5');
  assert.strictEqual(ia.clasificador, ia.auto);
  process.env.IA_AUTO_MODEL = 'claude-sonnet-4-6';
  assert.strictEqual(ia.clasificador, 'claude-sonnet-4-6');
  if (antes === undefined) delete process.env.IA_AUTO_MODEL; else process.env.IA_AUTO_MODEL = antes;
});
