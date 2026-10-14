// test/compras-auto.test.js — revisión automática solo de lo que está claro.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('src/db.js', { getDB: async () => ({}) });
const C = require(path.join(root, 'src/compras.js'));
const db = { collection: n => ({ find: () => ({ toArray: async () => n === 'tarjetaMovimientos' ? [{ fecha: '2026-09-28', importe: -139.48, concepto: 'Transaccion Contactless Werkhaus Sl Scs Girona' }] : [] }) }) };
const base = { estado: 'por_revisar', tipo: 'factura', ia: { ok: true, calidad: 'legible', confianza: 0.97 }, proveedor: 'Bauhaus', numero: '1/804/10/33118', fecha: '2026-09-28', total: 139.48, destino: 'obra', obraId: 'x', obraRef: 'Claudia', aNombreDe: 'CORP. PROJECTS HOLDING S.L' };

test('clara: se puede subir sola (Bauhaus casa con el pago «Werkhaus»)', async () => {
  assert.deepEqual(await C.claridad(base, db), []);
});
test('no claras: a nombre de otro, sin obra, sin pago, nota de oficina', async () => {
  assert.match((await C.claridad({ ...base, aNombreDe: 'MARIA DOLORES RODRIGUEZ TORRES' }, db)).join(), /a nombre de/);
  assert.match((await C.claridad({ ...base, obraId: null }, db)).join(), /sin obra/);
  assert.match((await C.claridad({ ...base, total: 140 }, db)).join(), /no encuentro el pago/);
  assert.match((await C.claridad({ ...base, nota: 'OJO: pedir cambio de nombre' }, db)).join(), /nota de oficina/);
  assert.match((await C.claridad({ ...base, tipo: 'albaran' }, db)).join(), /no es factura ni ticket/);
});
