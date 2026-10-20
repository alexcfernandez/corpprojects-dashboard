'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const P = require('../src/presupuestosCliente');

test('enlace firmado: vale para su presupuesto y no se puede falsificar', () => {
  const t = P.token('61518851');
  assert.strictEqual(P.verificar(t), '61518851');
  const otro = Buffer.from('61518852').toString('base64url') + '.' + t.split('.')[1];
  assert.strictEqual(P.verificar(otro), null);
  assert.strictEqual(P.verificar('basura'), null);
  assert.match(P.url('61518851'), /\/pr\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test('pendientes: solo Pendiente, entre 3 y 180 días, sin los marcados «No enviar»', async () => {
  const hoy = new Date('2026-10-26T09:15:00Z');
  const est = [
    { id: 1, 'full-reference': 'PRT00800', 'document-state-id': 1120641, date: '2026-07-03', 'account-id': 10, 'total-amount': 1549 },
    { id: 2, 'full-reference': 'PRT00856', 'document-state-id': 1120641, date: '2026-10-20', 'account-id': 10, 'total-amount': 411.4 },   // marcado no enviar
    { id: 3, 'full-reference': 'PRT00870', 'document-state-id': 1120641, date: '2026-10-25', 'account-id': 10, 'total-amount': 100 },     // recién hecho
    { id: 4, 'full-reference': 'PRT00500', 'document-state-id': 1120641, date: '2025-05-01', 'account-id': 10, 'total-amount': 900 },     // muy viejo
    { id: 5, 'full-reference': 'PRT00801', 'document-state-id': 1120656, date: '2026-07-06', 'account-id': 10, 'total-amount': 39050 },   // aceptado
    { id: 6, 'full-reference': 'PRT00802', 'document-state-id': 1120641, date: '2026-07-07', 'account-id': 11, 'total-amount': 545, deleted: true },
  ];
  const _stel = { getWorkEstimates: async () => est, getClients: async () => ({ clientMap: { 10: { name: 'Emili Grahit 73', family: 'Cinc Comunitats', email: 'x@y.es' } } }) };
  const _db = { collection: () => ({ find: () => ({ toArray: async () => [{ _id: '2', noEnviar: true, motivo: 'anulado' }] }) }) };
  const l = await P.pendientes({ hoy, _stel, _db });
  assert.deepStrictEqual(l.map(x => x.ref), ['PRT00800']);
  assert.strictEqual(l[0].family, 'Cinc Comunitats');
  const todos = await P.pendientes({ hoy, _stel, _db, todos: true });
  assert.strictEqual(todos.length, 4);
  assert.match(todos.find(x => x.ref === 'PRT00856').fuera, /anulado/);
});

test('correo: una fila por presupuesto con su enlace y el total', () => {
  const m = P.construirEmail('Cinc Comunitats', [
    { id: '61518851', ref: 'PRT00854', cliente: "Camp d'Or 20", titulo: 'Arqueta', fecha: '2026-10-20', total: 1477.3 },
    { id: '61518852', ref: 'PRT00855', cliente: 'Montbó 2', titulo: '', fecha: '2026-10-20', total: 746.9 },
  ]);
  assert.match(m.subject, /2 presupuestos pendientes/);
  assert.strictEqual((m.html.match(/Ver y responder/g) || []).length, 2);
  assert.match(m.html, /2\.224,20 €/);
  assert.match(m.text, /\/pr\//);
});
