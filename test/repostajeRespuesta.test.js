// Contestar a «¿De qué vehículo es?» de un repostaje (2/11/2026: «Coche de Kate» se apuntó en «Coche Alfonso»).
const test = require('node:test');
const assert = require('node:assert');

const ID = 'a'.repeat(24);
const asignados = [];
const vehiculos = [
  { _id: 'v1', nombre: 'Coche Alfonso', marca: 'Volkswagen', modelo: 'Golf', matricula: '3113MMC' },
  { _id: 'v2', nombre: 'Moto Alfonso (Honda SH300)', marca: 'Honda', modelo: 'SH300', matricula: '4594KZY' },
  { _id: 'v3', nombre: 'motoreta', marca: 'Honda', modelo: 'SH', matricula: '7526KZN' },
  { _id: 'v4', nombre: 'Citroen Berlingo', marca: 'Citroën', modelo: 'Berlingo', matricula: '4694DWT' },
];
const stub = (m, exports) => { require.cache[require.resolve('../src/' + m)] = { exports }; };
stub('db', { getDB: async () => ({ collection: () => ({ find: () => ({ project: () => ({ toArray: async () => vehiculos }) }) }) }) });
stub('waLog', { hilo: async () => ({ mensajes: [{ dir: 'out', ts: new Date(), texto: `⛽ Repostaje de 44,95 €. ¿De qué vehículo es?\n\n(ref. repostaje ${ID})` }] }) });
stub('repostajes', { pendientes: async () => [{ id: ID, importe: 44.95, fecha: '2026-11-02' }], asignar: async (id, vid) => { asignados.push(vid); return { vehiculo: vehiculos.find(v => v._id === vid).nombre }; } });
stub('users', { getUsers: async () => [{ name: 'Diego Pérez' }, { name: 'Alfonso Socio' }] });
const AE = require('../src/agenteExtra');

test('«Coche de Kate» no se apunta en el Coche Alfonso: pregunta si lo da de alta', async () => {
  const r = await AE.respuestaRepostaje('Coche de Kate', '+34600000000');
  assert.match(r, /No tengo «Coche de Kate» en Flota\. ¿Lo doy de alta\?[\s\S]*ref\. repostaje a{24}/);
  assert.deepStrictEqual(asignados, []);
});

test('lo que sí casa se apunta: motoreta, la Berlingo, la matrícula', async () => {
  asignados.length = 0;
  assert.match(await AE.respuestaRepostaje('motoreta', 'x'), /\*motoreta\*/);
  assert.match(await AE.respuestaRepostaje('la Berlingo', 'x'), /Citroen Berlingo/);
  assert.match(await AE.respuestaRepostaje('7526', 'x'), /motoreta/);
  assert.deepStrictEqual(asignados, ['v3', 'v4', 'v3']);
});

test('«créalo como…» y lo ambiguo no los coge el atajo (los lleva el agente)', async () => {
  asignados.length = 0;
  assert.strictEqual(await AE.respuestaRepostaje('créalo como Coche de Kate', 'x'), null);
  assert.strictEqual(await AE.respuestaRepostaje('la moto', 'x'), null);          // motoreta o Moto Alfonso: pregunta la IA
  assert.strictEqual(await AE.respuestaRepostaje('1 Diego', 'x'), null);          // es un trabajador
  assert.deepStrictEqual(asignados, []);
});
