// test/festivos.test.js — Festivos de serie (el Pilar, Sant Narcís…) y los que añade o quita la oficina.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');
let doc = null;
const p = require.resolve(path.join(root, 'src/db.js'));
require.cache[p] = { id: p, filename: p, loaded: true, exports: { getDB: async () => ({ collection: () => ({
  findOne: async () => doc,
  updateOne: async (q, u) => { doc = doc || { key: 'festivos', anadidos: {}, quitados: [] };
    for (const [k, v] of Object.entries(u.$set || {})) { if (k.startsWith('anadidos.')) doc.anadidos[k.slice(9)] = v; else doc[k] = v; }
    for (const k of Object.keys(u.$unset || {})) delete doc.anadidos[k.slice(9)];
    if (u.$pull) doc.quitados = doc.quitados.filter(f => f !== u.$pull.quitados);
    if (u.$addToSet && !doc.quitados.includes(u.$addToSet.quitados)) doc.quitados.push(u.$addToSet.quitados); },
}) }) } };
const F = require(path.join(root, 'src/festivos.js'));

test('el 12 de octubre es festivo de serie; un día normal no', async () => {
  assert.equal(await F.esFestivo('2026-10-12'), true);
  assert.equal(await F.esFestivo('2026-10-13'), false);
  assert.match((await F.lista(2026))['2026-10-29'], /Sant Narcís/);
});

test('la oficina añade un festivo local y quita uno de serie', async () => {
  await F.poner('2026-11-02', 'Puente', 'Oficina');
  await F.quitar('2026-10-29', 'Oficina');
  const l = await F.lista(2026);
  assert.equal(l['2026-11-02'], 'Puente'); assert.equal(l['2026-10-29'], undefined);
  await F.poner('2026-10-29', 'Sant Narcís', 'Oficina');            // se puede volver a poner
  assert.equal((await F.lista(2026))['2026-10-29'], 'Sant Narcís');
  await assert.rejects(F.poner('12/10/2026'), /no válida/);
});
