// test/alias-obras.test.js — Reparto por albaranes: si la factura dice «CARRER OVIEDO 39» y se elige la obra
// Oviedo 16, se apunta como alias de esa obra y la próxima vez se reconoce sola.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');

const O16 = 'a'.repeat(24), RAH = 'b'.repeat(24);
const obras = [
  { id: O16, reference: 'Oviedo 16', clientName: 'CP Oviedo 16', address: 'Carrer Oviedo 16', aliases: [] },
  { id: RAH, reference: 'Carles Rahola 13 Àtic', clientName: 'Particular', address: 'C/ Carles Rahola 13', aliases: [] },
];
const updates = [];
const db = { collection: () => ({ updateOne: async (q, u) => { updates.push({ id: String(q._id), u }); const o = obras.find(x => x.id === String(q._id)); if (o && u.$addToSet) o.aliases.push(u.$addToSet.aliases); } }) };
const dbPath = require.resolve(path.join(root, 'src/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDB: async () => db } };
const obPath = require.resolve(path.join(root, 'src/obras.js'));
require.cache[obPath] = { id: obPath, filename: obPath, loaded: true, exports: { getSelector: async () => obras } };
const C = require(path.join(root, 'src/compras.js'));

test('aprende «Oviedo 39» como alias de Oviedo 16 (sin el nombre de quien compró)', async () => {
  const ignorar = new Set(['alex', 'rincon']);
  assert.equal(C.obraDeTexto(obras, 'CARRER OVIEDO 39 ALEX RINCON', ignorar).id, O16);   // ya casa por «oviedo»…
  // …pero si hubiera otra obra en Oviedo no sabría cuál: lo que cuenta es lo que eligió oficina.
  obras.push({ id: 'c'.repeat(24), reference: 'Oviedo 2', clientName: 'X', address: 'Carrer Oviedo 2', aliases: [] });
  assert.equal(C.obraDeTexto(obras, 'CARRER OVIEDO 39 ALEX RINCON', ignorar), null);
  await C._aprenderAliasObras([
    { obraId: RAH, importe: 17.26, texto: 'OBRA CARLES RAHOLA, 13 ATIC (ALEX RINCON)' },
    { obraId: O16, importe: 10.35, texto: 'CARRER OVIEDO 39 ALEX RINCON' },
    { obraId: O16, importe: 50, texto: 'OVIEDO ALEX RINCON' },
  ]);
  assert.ok(obras[0].aliases.includes('oviedo 39'));
  assert.ok(!updates.some(x => x.id === RAH));                                           // Rahola ya se reconocía
  assert.equal(C.obraDeTexto(obras, 'CARRER OVIEDO 39 ALEX RINCON', ignorar).id, O16);   // y ahora sale sola
});
