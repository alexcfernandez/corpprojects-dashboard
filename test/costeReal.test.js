'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/costeReal');

const J = 'a'.repeat(24), P = 'b'.repeat(24);
const nom = (userId, mes, bruto, ssT, notas, subido = mes + '-28') => ({ _id: userId + mes + bruto, tipo: 'nomina', userId, mes, notas, nombre: 'n.pdf', subido, importes: { bruto, liquido: bruto * 0.8, ssTrabajador: ssT } });
function fakeDb({ noms, tgss, att }) {
  return { collection: n => ({
    find: () => ({ project: () => ({ toArray: async () => (n === 'docsPersonal' ? noms : tgss) }) }),
    aggregate: () => ({ toArray: async () => att }),
  }) };
}

test('coste real: bruto + paga extra repartida + SS de la empresa, entre las horas', async () => {
  const noms = [
    nom(J, '2026-06', 2000, 150, 'Nómina junio 2026'), nom(J, '2026-06', 1800, 0, 'Nómina verano (ESTIU) 2026'),
    nom(J, '2026-07', 2000, 150, 'Nómina julio 2026'), nom(J, '2026-07', 2000, 150, 'Nómina julio 2026', '2026-08-02'),   // repetida
    nom(J, '2026-08', 2000, 150, 'Nómina agosto 2026'), nom(J, '2026-09', 2000, 150, 'Nómina septiembre 2026'),
    nom(P, '2026-09', 900, 60, 'Nómina septiembre 2026 (IT)'),                                                              // de baja
    { ...nom(P, '2026-06', 3500, 0, 'Resumen de nómina junio-septiembre 2026') },                                         // no cuenta
  ];
  // SS de la empresa = TGSS − lo del trabajador: 950 − 150 = 800 sobre 2000 = 40 % (sep. sin recibo → media)
  const tgss = ['06', '07', '08'].map(m => ({ concepto: `Recibo Tgss. Cotizacion 001 Regimen General, Periodo: ${m}/2026-${m}`, importe: -950 }));
  const att = [['2026-07', 160], ['2026-08', 160], ['2026-09', 160]].map(([m, h]) => ({ _id: { w: J, m }, h }))
    .concat([{ _id: { w: P, m: '2026-09' }, h: 176 }]);
  const l = await C.calcular({ hoy: new Date('2026-10-21T10:00:00Z'), _db: fakeDb({ noms, tgss, att }) });
  const j = l.find(x => x.userId === J);
  assert.deepStrictEqual(j.meses, ['2026-07', '2026-08', '2026-09']);
  assert.strictEqual(j.bruto, 6000);                         // la de julio repetida cuenta una vez
  assert.strictEqual(j.extras, 900);                         // 2 × 0,9 / 12 × 6000
  assert.strictEqual(j.ssEmpresa, 2400);
  assert.strictEqual(j.costeHora, Math.round((6000 + 900 + 2400) / 480 * 100) / 100);
  assert.ok(!l.find(x => x.userId === P), 'un mes con 5 € brutos/hora no cuenta (presencia puesta estando de baja)');
});

test('nóminas del mismo mes: dos parciales se suman; una entera sustituye a la anterior', () => {
  const a = nom(J, '2026-07', 230, 10, 'Nómina julio 2026 (4 días)'), b = nom(J, '2026-07', 636, 30, 'Nómina julio 2026 (20-31 julio)');
  assert.strictEqual(C._delMes([a, b]).length, 2);
  const v = nom(J, '2026-08', 662, 40, 'Nómina agosto 2026', '2026-09-01'), w = nom(J, '2026-08', 750, 45, 'Nómina agosto 2026', '2026-09-10');
  assert.deepStrictEqual(C._delMes([v, w]).map(n => n.importes.bruto), [750]);
  assert.ok(C._esExtra({ notas: 'Nómina verano (ESTIU) 2026' }) && !C._esExtra({ notas: 'Nómina julio 2026' }));
});
