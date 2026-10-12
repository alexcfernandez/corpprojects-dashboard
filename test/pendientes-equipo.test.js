// test/pendientes-equipo.test.js — «Lo que falta» y la lista de compra de EPIs con tallas.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const PE = require('../src/pendientesEquipo.js');

test('texto de lo que falta: obra, trabajadores y encargos', () => {
  const t = PE.texto({ obras: [{ ref: 'INSS Girona (Seranco)', faltan: 52, dias: 1 }], personas: [{ nombre: 'Diego Campillo', faltan: ['reconocimiento médico (caducado)'] }], encargos: [{ nombre: 'Javier Huaca', que: 'talla de botas', dias: 2 }] });
  assert.match(t, /INSS Girona \(Seranco\)\*: faltan 52 documentos · entráis en 1 días/); assert.match(t, /Diego Campillo\*: reconocimiento médico \(caducado\)/); assert.match(t, /Javier Huaca: talla de botas \(2 d\)/);
  assert.match(PE.texto({ obras: [], personas: [], encargos: [] }), /No falta nada/);
});
test('lista de compra agrupa por artículo y talla; avisa de quién no tiene tallas', () => {
  const t = PE.textoCompra({ personas: [{ nombre: 'Javier Huaca', sinTallas: [] }, { nombre: 'Manolo X', sinTallas: ['calzado'] }], lineas: [{ articulo: 'Botas de seguridad S3', talla: '43', cantidad: 1, para: ['Javier'] }, { articulo: 'Botas de seguridad S3', talla: '¿?', cantidad: 1, para: ['Manolo'] }] });
  assert.match(t, /1 × Botas de seguridad S3 — talla \*43\*/); assert.match(t, /talla \*¿\?\* \(Manolo\)/); assert.match(t, /Faltan tallas de: Manolo/);
});
