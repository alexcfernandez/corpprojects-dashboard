const test = require('node:test');
const assert = require('node:assert');
const R = require('../src/revision');

test('revisión: solo acciones de la lista cerrada y enlaces internos', () => {
  const i = R.limpiarItem({ tipo: 'decidir', titulo: 'Papel de Javier en Compras', acciones: [
    { label: 'A Personal', accion: 'a_personal', params: { compraId: 'x', tipo: 'extranjeria' } },
    { label: 'Borrar todo', accion: 'drop_database' },
    { label: 'Ver', accion: 'enlace', url: '/compras' },
    { label: 'Fuera', accion: 'enlace', url: 'https://malo.com' },
  ] }, 0);
  assert.deepStrictEqual(i.acciones.map(a => a.label), ['A Personal', 'Ver']);
  assert.strictEqual(i.estado, 'pendiente');
  assert.strictEqual(R.limpiarItem({ tipo: 'arreglado', titulo: 'x' }, 1).estado, 'hecho');
  assert.strictEqual(R.limpiarItem({ tipo: 'raro', titulo: 'x' }, 2).tipo, 'aviso');
});

test('revisión: el día de Madrid empieza a las 22:00 UTC en verano y a las 23:00 en invierno', () => {
  assert.strictEqual(R.limites('2026-10-15').ini.toISOString(), '2026-10-14T22:00:00.000Z');
  assert.strictEqual(R.limites('2026-12-15').ini.toISOString(), '2026-12-14T23:00:00.000Z');
});
