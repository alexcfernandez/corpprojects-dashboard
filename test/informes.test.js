// test/informes.test.js — Cuenta de resultados sin IVA: ventas por base, compras de StelOrder + gastos + Compras,
// personal (nóminas, SS, IRPF sin repetir nóminas) y comisiones.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const cur = arr => ({ project: () => ({ toArray: async () => arr }) });
const banco = [{ fechaOperacion: '2026-09-30', importe: -1500, categoria: 'nomina' }, { fechaOperacion: '2026-09-30', importe: -600, categoria: 'seguridad_social' }, { fechaOperacion: '2026-09-02', importe: -12, categoria: 'comision' }];
const noms = [{ mes: '2026-09', userId: 'a', importes: { liquido: 1500, irpf: 150 } }, { mes: '2026-09', userId: 'a', importes: { liquido: 1500, irpf: 150 } }];
stub('src/db.js', { getDB: async () => ({ collection: n => ({ find: () => cur(n === 'bancoMovimientos' ? banco : noms) }) }) });
stub('src/stelorder.js', { getExpenses: async () => [{ date: '2026-05-01', amount: 100 }] });
stub('src/trimestre.js', {
  todasEmitidas: async () => [{ fecha: '2026-09-10', base: 10000, total: 12100 }, { fecha: '2025-12-20', base: 5000, total: 6050 }],
  todasRecibidas: async () => [{ id: 's1', fecha: '2026-09-11', base: 3000, total: 3630 }],
  recibidasPunteo: async r => [...r, { id: 'c:1', fecha: '2026-08-01', base: null, total: 121 }],
});
const I = require(path.join(root, 'src/informes.js'));

test('2026: ventas 10.000 sin IVA; gastos = 3.000 + 100 + 100 (ticket) + 1.500 + 600 + 150 (IRPF una vez) + 12', async () => {
  const d = await I.cuentaResultados({ fresco: true });
  const y = d.anos.find(a => a.year === 2026);
  assert.equal(y.ventas, 10000);
  assert.equal(y.desglose.compras, 3200);
  assert.equal(y.desglose.personal, 2250);
  assert.equal(y.gastos, 5462);
  assert.equal(y.resultado, 4538);
  assert.equal(d.anos.find(a => a.year === 2025).ventas, 5000);   // por fecha de factura, no de vencimiento
});
