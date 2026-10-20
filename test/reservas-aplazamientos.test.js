const test = require('node:test');
const assert = require('node:assert');
const R = require('../src/reservas');

test('fechas de cargo: el 20 o el siguiente laborable, y fin de mes el último laborable', () => {
  assert.strictEqual(R._siguienteFecha(20, '2026-10-21'), '2026-11-20');
  assert.strictEqual(R._siguienteFecha(20, '2026-12-01'), '2026-12-21');   // 20/12/2026 es domingo
  assert.strictEqual(R._siguienteFecha('fin', '2026-10-21'), '2026-10-30'); // 31/10/2026 es sábado
});
