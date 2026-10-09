// test/nominas-pagos.test.js — Nóminas pagadas: copias de la misma nómina y alias de banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const U1 = { _id: 'u1', name: 'Jose Beliard', role: 'tecnico' }, U2 = { _id: 'u2', name: 'Melvin Ramirez', role: 'tecnico' };
const noms = [
  { _id: 'a1', userId: 'u1', tipo: 'nomina', mes: '2026-08', nombre: '342 Agost.pdf (pág. 1)', subido: '2026-10-07T21:01:32Z', importes: { liquido: 1800, bruto: 2425.94 } },
  { _id: 'a2', userId: 'u1', tipo: 'nomina', mes: '2026-08', nombre: '342 Agost J.Beliard 27.08.2026.pdf', subido: '2026-10-07T21:01:47Z', importes: { liquido: 1626.3, bruto: 2425.94 } },
  { _id: 's1', userId: 'u1', tipo: 'nomina', mes: '2026-09', nombre: '342 setembre.pdf', subido: '2026-10-07T21:02:13Z', importes: { liquido: 1626.3, bruto: 2424.92 } },
  { _id: 'm1', userId: 'u2', tipo: 'nomina', mes: '2026-09', nombre: 'nomina melvin', subido: '2026-10-07', importes: { liquido: 793.92, bruto: 900 } },
];
const movs = [
  { fechaOperacion: '2026-08-17', importe: -600, concepto: 'Transferencia A Favor De Jose Antonio Beliard Concepto: Adelanto Nomina' },
  { fechaOperacion: '2026-08-27', importe: -1231.3, concepto: 'Transferencia A Favor De Jose Antonio Beliard Concepto: Nomina' },
  { fechaOperacion: '2026-10-01', importe: -1626.3, concepto: 'TRANSFERENCIA A FAVOR DE JOSE ANTONIO BELIARD CONCEPTO: Nómina septiembre' },
  { fechaOperacion: '2026-10-08', importe: -493, concepto: 'TRANSFERENCIA INMEDIATA A FAVOR DE Melvin CONCEPTO Nómina septiembre' },
];
const cumple = (d, q) => Object.entries(q).every(([k, c]) => c && typeof c === 'object' ? ('$in' in c ? c.$in.includes(d[k]) : (c.$gte == null || d[k] >= c.$gte) && (c.$lte == null || d[k] <= c.$lte) && (c.$lt == null || d[k] < c.$lt)) : d[k] === c);
stub('src/db.js', { getDB: async () => ({ collection: n => ({ find: q => { const L = (n === 'docsPersonal' ? noms : movs).filter(d => cumple(d, q)); return { project: () => ({ toArray: async () => L }), toArray: async () => L }; } }) }) });
stub('src/users.js', { getUsers: async () => [U1, U2], normalizeRole: r => r });
const N = require(path.join(root, 'src/nominasPagos.js'));

test('dos copias de la misma nómina (mismo bruto, líquido corregido) cuentan una vez: la más reciente', async () => {
  const ago = (await N.estado('2026-08')).trabajadores.find(t => t.nombre === 'Jose Beliard');
  assert.equal(ago.nomina.liquido, 1626.3); assert.equal(ago.estado, 'pagada');
  const sep = (await N.estado('2026-09')).trabajadores.find(t => t.nombre === 'Jose Beliard');
  assert.equal(sep.estado, 'pagada');
});
test('Melvin cobra con concepto sin apellido: cuenta para su nómina', async () => {
  const m = (await N.estado('2026-09')).trabajadores.find(t => t.nombre === 'Melvin Ramirez');
  assert.equal(m.nomina.pagado, 493); assert.equal(m.nomina.falta, 300.92);
});
