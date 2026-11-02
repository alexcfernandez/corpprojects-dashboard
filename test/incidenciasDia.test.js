// Aviso diario de incidencias abiertas y correos de administradores que entran como peticiones (2/11/2026).
const test = require('node:test');
const assert = require('node:assert');
const ID = require('../src/incidenciasDia');
const PG = require('../src/peticionesGrupo');

test('separa presupuestos por hacer y trabajos, cuenta los viejos y dice cómo cerrarlas', () => {
  const hace = d => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
  const t = ID.texto({
    presupuestos: [{ ref: 'INC00700', fecha: hace(2), dias: 2, estado: 'Pendiente', tipo: 'Presupuesto', cliente: 'Ctat. Bellpuig 41', que: 'Malla antipalomas' }],
    trabajos: [{ ref: 'INC00432', fecha: hace(40), dias: 40, estado: 'Programado ', tipo: 'Actuación', cliente: 'Solterra 14', que: 'Mirar extractores' }],
    sinInc: [{ cliente: 'Illa Verda', resumen: 'Gotera en el 3-1', grupo: 'Correo · finquescompany.com', urgente: true }],
  });
  assert.match(t, /Presupuestos por hacer\* \(1\)[\s\S]*INC00700/);
  assert.match(t, /Trabajos: hay que ir\* \(1\)[\s\S]*INC00432.*40 días ⏰ \(programado\)/);
  assert.match(t, /🚨 Illa Verda/);
  assert.match(t, /INC00432 cerrada/);
  assert.match(t, /1 con más de un mes/);
});

test('sin nada abierto no se manda nada', () => {
  assert.strictEqual(ID.texto({ presupuestos: [], trabajos: [], sinInc: [] }), null);
});

test('cada administrador por correo es su propio «grupo» y el correo se limpia del aviso legal y las citas', () => {
  assert.deepStrictEqual(PG._jidCorreo('Jordi Garrido <jordi-garrido@finquescompany.com>').jid, 'correo:finquescompany.com');
  assert.strictEqual(PG._jidCorreo('"Marta" <marta.g@gmail.com>').jid, 'correo:marta.g@gmail.com');
  const l = PG._limpiaCorreo('Bona tarda,\n> Marta m’informa\n\nEste e-mail puede contener información confidencial…');
  assert.match(l, /Marta m’informa/);
  assert.doesNotMatch(l, /confidencial|^>/m);
});
