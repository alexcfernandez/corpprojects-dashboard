// test/tickets-aviso.test.js — Pago con tarjeta sin ticket → WhatsApp al momento a quien lleva la tarjeta, con su
// enlace; no se pide lo que ya tiene factura, el parking por app ni lo de tarjetas sin persona; no se repite.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');

const HOY = new Date('2026-10-07T10:00:00Z');
const DAVID = 'd'.repeat(24);
const cols = {
  tarjetaMovimientos: [
    { _id: 'm1', fecha: '2026-10-07', importe: -116.01, tipo: 'CARD_PAYMENT', concepto: 'Obramat Girona', tarjeta: '6439' },
    { _id: 'm2', fecha: '2026-10-06', importe: -54.98, tipo: 'CARD_PAYMENT', concepto: 'Itv Girona', tarjeta: '6439' },          // ya punteado
    { _id: 'm3', fecha: '2026-10-06', importe: -2.1, tipo: 'CARD_PAYMENT', concepto: 'App Estacioname', tarjeta: '6439' },        // parking: no
    { _id: 'm4', fecha: '2026-10-06', importe: -20, tipo: 'CARD_PAYMENT', concepto: 'La Roca Store', tarjeta: '4522' },          // tarjeta sin persona
    { _id: 'm5', fecha: '2026-10-06', importe: 175, tipo: 'TRANSFER', concepto: 'To EUR David Taladros', tarjeta: null, interno: true },
  ],
  bancoMovimientos: [], ticketAvisos: [],
  tarjetas: [{ _id: '6439', persona: 'David Taladros', userId: DAVID }, { _id: '4522', persona: 'Alfonso' }],
};
const filtra = (arr, q) => arr.filter(d => Object.entries(q).every(([k, c]) => {
  const v = d[k];
  if (c && typeof c === 'object') { if ('$gte' in c && !(v >= c.$gte)) return false; if ('$lt' in c && !(v < c.$lt)) return false; if ('$ne' in c && v === c.$ne) return false; if ('$regex' in c && !new RegExp(c.$regex, c.$options).test(v || '')) return false; return true; }
  return v === c;
}));
const db = { collection: n => ({
  find: q => ({ toArray: async () => filtra(cols[n] || [], q || {}) }),
  updateOne: async (q, u, o) => { let d = (cols[n] = cols[n] || []).find(x => x._id === q._id); if (!d && o && o.upsert) { d = { _id: q._id, ...(u.$setOnInsert || {}) }; cols[n].push(d); } if (d) Object.assign(d, u.$set || {}); },
}) };
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('src/db.js', { getDB: async () => db });
stub('src/users.js', { getUsers: async () => [{ _id: DAVID, name: 'David Valencia', telefono: '600111222' }], ensureMagicToken: async () => ({ token: 'm_abc' }) });
stub('src/trimestre.js', { mapaPagos: async () => ({ porMov: new Map([['m2', { estado: 'punteado' }]]) }), comercio: c => c.replace(/\s+girona$/i, ''), enlazarCompra: async () => ({ ok: true }) });
const T = require(path.join(root, 'src/ticketsAviso.js'));

test('aviso al momento a quien lleva la tarjeta, con su enlace directo a ese pago', async () => {
  const enviados = [];
  const r = await T.avisar({ modo: 'nuevos', hoy: HOY, _enviar: async (to, txt) => { enviados.push({ to, txt }); return true; } });
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].to, '+34600111222');
  assert.match(enviados[0].txt, /Hola David, hemos visto un pago con tu tarjeta …6439: \*Obramat\* · 116,01 € \(hoy\)/);
  assert.match(enviados[0].txt, /\/compra\?t=m_abc&mov=m1#tickets/);
  assert.deepEqual(r.tarjetasSinPersona, ['4522']);                       // la de Alfonso: elegir «Avisar a»
  // No se repite en la siguiente lectura del banco…
  const otra = []; await T.avisar({ modo: 'nuevos', hoy: HOY, _enviar: async (to, txt) => { otra.push(txt); return true; } });
  assert.equal(otra.length, 0);
  // …pero a la mañana siguiente sí se le recuerda.
  const rec = []; await T.avisar({ modo: 'recordatorio', hoy: new Date('2026-10-08T07:30:00Z'), _enviar: async (to, txt) => { rec.push(txt); return true; } });
  assert.equal(rec.length, 1); assert.match(rec[0], /aún nos falta 1 pago/);
});

test('al subir el ticket desde el enlace deja de pedirse', async () => {
  await T.alSubir('m1', 'c'.repeat(24), 'David Valencia');
  const l = await T.pendientes({ hoy: HOY, userId: DAVID });
  assert.equal(l.length, 0);
});

test('límite del mes: avisa al pasar de 520 € y al llegar a 580 €, una vez cada uno', async () => {
  cols.tarjetas[0].limiteMes = 580; cols.tarjetas[0].avisoMes = 520;
  cols.tarjetaMovimientos.push({ _id: 'g1', fecha: '2026-10-03', importe: -400, tipo: 'CARD_PAYMENT', concepto: 'Obramat', tarjeta: '6439' });
  db.collection = (orig => n => { const c = orig(n); if (n === 'tarjetas') { c.find = q => ({ toArray: async () => cols.tarjetas.filter(t => !q.limiteMes || t.limiteMes > 0) }); c.updateOne = async (q, u) => { const t = cols.tarjetas.find(x => x._id === q._id); for (const [k, v] of Object.entries(u.$addToSet || {})) { const [a, b] = k.split('.'); t[a] = t[a] || {}; (t[a][b] = t[a][b] || []).push(v); } }; } return c; })(db.collection);
  const env = []; const send = async (to, txt) => { env.push(txt); return true; };
  await T.revisarLimites({ hoy: HOY, _enviar: send });                      // 116,01 + 54,98 + 2,10 + 400 = 573,09 → aviso
  assert.equal(env.length, 1); assert.match(env[0], /llevas \*573,09 €\* con la tarjeta …6439 \(el límite es 580,00 €\)/);
  await T.revisarLimites({ hoy: HOY, _enviar: send });
  assert.equal(env.length, 1);                                               // no se repite
  cols.tarjetaMovimientos.push({ _id: 'g2', fecha: '2026-10-07', importe: -10, tipo: 'CARD_PAYMENT', concepto: 'Leroy', tarjeta: '6439' });
  await T.revisarLimites({ hoy: HOY, _enviar: send });
  assert.equal(env.length, 2); assert.match(env[1], /has llegado al límite/);
});
