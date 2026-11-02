// Aviso de cobro del tablero del ciclo: una vez al pasar a ámbar y otra al pasar a rojo (2/11/2026).
const test = require('node:test');
const assert = require('node:assert');
const CC = require('../src/cicloCobro');

function fakeDb() {
  const rows = [];
  return { rows, collection: () => ({
    find: q => ({ toArray: async () => rows.filter(r => q._id.$in.includes(r._id)) }),
    updateOne: async (q, u) => { let r = rows.find(x => x._id === q._id); if (!r) { r = { _id: q._id }; rows.push(r); } Object.assign(r, u.$set); },
  }) };
}
const tarjeta = (id, semaforo, dias) => ({ id, semaforo, dias, cliente: 'Ctat. Riu Onyar 11-13', importe: 242, operario: 'David', que: 'Bajante', facturas: [{ ref: 'FAC00' + id.slice(-3), total: 242, pendiente: 242 }] });
const datos = l => ({ columnas: [{ k: 'cobrar', tarjetas: l }] });

test('avisa una vez en ámbar, otra en rojo, y nada de lo que va en plazo', async () => {
  const db = fakeDb(); const enviados = [];
  const env = async t => { enviados.push(t); return true; };
  let r = await CC.avisar({ _datos: datos([tarjeta('wo:901', 'ambar', 31), tarjeta('wo:902', 'verde', 10)]), _db: db, _enviar: env });
  assert.deepStrictEqual([r.enviado, r.ambar, r.rojo], [true, 1, 0]);
  assert.match(enviados[0], /🟠 \*Cobro: empiezan a tardar\* \(1 · 242,00 €\)[\s\S]*Ctat\. Riu Onyar 11-13\* · FAC00901 · 242,00 € · 31 días \(David\)/);
  assert.match(enviados[0], /\/cobrar/);
  r = await CC.avisar({ _datos: datos([tarjeta('wo:901', 'ambar', 32)]), _db: db, _enviar: env });   // al día siguiente, nada
  assert.strictEqual(r.enviado, false);
  r = await CC.avisar({ _datos: datos([tarjeta('wo:901', 'rojo', 60)]), _db: db, _enviar: env });
  assert.deepStrictEqual([r.enviado, r.ambar, r.rojo], [true, 0, 1]);
  assert.match(enviados[1], /🔴 \*Cobro en rojo\*/);
  assert.strictEqual(enviados.length, 2);
});

test('si el WhatsApp no sale, se vuelve a intentar al día siguiente', async () => {
  const db = fakeDb();
  const r = await CC.avisar({ _datos: datos([tarjeta('wo:903', 'ambar', 30)]), _db: db, _enviar: async () => false });
  assert.strictEqual(r.enviado, false);
  assert.strictEqual(db.rows.length, 0);
});
