// materialesObra.js — PRT aceptado → lista de materiales → se tacha con las compras → parte (4/11/2026). Todo simulado.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ObjectId } = require('mongodb');
const M = require('../src/materialesObra');

function dbFalsa(compras = []) {
  const cols = { listasMateriales: [], compras };
  const match = (d, q) => Object.entries(q).every(([k, v]) => {
    const val = k.split('.').reduce((o, p) => (o == null ? o : o[p]), d);
    if (v && typeof v === 'object' && !(v instanceof ObjectId) && v.$nin) return !v.$nin.includes(val);
    return String(val) === String(v);
  });
  return { cols, collection: n => ({
    findOne: async q => (cols[n] || []).find(d => match(d, q)) || null,
    find: q => ({ toArray: async () => (cols[n] || []).filter(d => match(d, q || {})), sort() { return this; } }),
    insertOne: async d => { d._id = d._id || new ObjectId(); (cols[n] = cols[n] || []).push(d); return { insertedId: d._id }; },
    updateOne: async (q, u) => { const d = (cols[n] || []).find(x => match(x, q)); if (d && u.$set) Object.assign(d, u.$set); return { matchedCount: d ? 1 : 0 }; },
  }) };
}
const prt = { id: 61912683, 'full-reference': 'PRT00876', title: 'Cartagena · pinchos', 'total-amount': 5451.93, 'account-id': 12043732,
  lines: [{ 'item-name': 'Suministro y colocación de pinchos antipalomas', units: 130, 'item-base-price': 20, 'item-description': 'Pinchos inox fijados con adhesivo, 130 ml' }] };
const obra = { _id: new ObjectId(), reference: 'Cartagena 2-4-6 · pinchos', clientName: 'Cartagena 2-4-6', address: 'C/ Cartagena 2-4-6' };
const iaLista = async () => ({ resumen: 'Poner pinchos bajo el voladizo', materiales: [
  { material: 'Varillas antipalomas inox 50 cm', cantidad: 143, unidad: 'ml', calculo: '130 ml + 10 %', critico: true },
  { material: 'Adhesivo de montaje exterior (cartucho)', cantidad: 48, unidad: 'cartuchos', calculo: '1 cada 3 m' }],
  medios: ['Camión grúa'], instrucciones: ['Limpiar la zona', 'Pegar los pinchos'], avisos: ['Medir antes de comprar todo'], personas: 2, jornadas: 4 });

test('el prompt lleva las partidas con su descripción y pide los consumibles', () => {
  const t = M._promptLista(prt, obra);
  assert.match(t, /130 × Suministro y colocación de pinchos/);
  assert.match(t, /adhesivo de montaje/); assert.match(t, /cantidad TOTAL/);
});

test('generar → lista con materiales; las compras de la obra tachan; completa → pregunta quién va', async () => {
  const db = dbFalsa([{ _id: new ObjectId(), obraId: String(obra._id), estado: 'revisada', proveedor: 'Obramat', fecha: '2026-11-03', lineas: [{ descripcion: '50 VARILLAS ANTIAVES 500MM', cantidad: 2 }] }]);
  const l = await M.generar({ prt: 'PRT00876' }, 'test', { _ia: iaLista, _db: db, _p: prt, _obra: obra });
  assert.strictEqual(l.items.length, 2);
  assert.strictEqual(l.estado, 'comprando');
  const c = await M.cruzar(String(l._id), { _db: db, avisar: false, _ia: async () => ({ cubre: [{ item: 'm1', cantidad: 50, linea: '2 × 50 varillas de 50 cm' }] }) });
  assert.strictEqual(c.items[0].tenemos, 50);
  assert.strictEqual(c.estado, 'comprando');
  // otra vez: la compra ya está vista, no suma dos veces
  const c2 = await M.cruzar(String(l._id), { _db: db, avisar: false, _ia: async () => { throw new Error('no debería llamar'); } });
  assert.strictEqual(c2.items[0].tenemos, 50);
  await M.marcar(String(l._id), 'm1', { ok: true }, 'test', { _db: db, avisar: false });
  const fin = await M.marcar(String(l._id), 'm2', { ok: true }, 'test', { _db: db, avisar: false });
  assert.strictEqual(fin.estado, 'completa');
});

test('el texto del trabajo lleva medios, pasos y avisos; el PDF sale', async () => {
  const db = dbFalsa();
  const l = await M.generar({ prt: 'PRT00876' }, 'test', { _ia: iaLista, _db: db, _p: prt, _obra: obra });
  const t = M.textoTrabajo(l);
  assert.match(t, /Medios: Camión grúa/); assert.match(t, /1\) Limpiar la zona 2\) Pegar los pinchos/); assert.match(t, /Ojo: Medir/);
  const pdf = await M.pdf(l, { parte: true });
  assert.ok(pdf.length > 1000 && pdf.slice(0, 4).toString() === '%PDF');
  assert.match(M.resumenTexto(l), /Falta comprar \(2 de 2\)/);
});

test('se apaga con MATERIALES_OBRA=off', async () => {
  process.env.MATERIALES_OBRA = 'off';
  try { assert.strictEqual(await M.alAceptar('PRT00876', 'x'), null); assert.deepStrictEqual(await M.revisar({ _db: dbFalsa() }), { nuevas: 0, cruzadas: 0 }); }
  finally { delete process.env.MATERIALES_OBRA; }
});
