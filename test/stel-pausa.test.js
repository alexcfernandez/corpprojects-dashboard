// Freno ante el bloqueo de StelOrder: tras un 403 no se le vuelve a llamar hasta que pase la pausa.
const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/stelorder');

test('al arrancar sale una sola llamada de prueba; tras un 403 ya no se llama', async () => {
  let llamadas = 0, respuesta = 403;
  S._client.defaults.adapter = async cfg => {
    llamadas++;
    if (respuesta === 403) { const e = new Error('Request failed with status code 403'); e.config = cfg; e.response = { status: 403, data: {}, config: cfg }; throw e; }
    return { status: 200, data: [], headers: {}, config: cfg, statusText: 'OK' };
  };
  const [a, b] = await Promise.allSettled([S._client.get('/a'), S._client.get('/b')]);
  assert.equal(llamadas, 1, 'solo la de prueba llega a StelOrder');
  assert.equal(a.status, 'rejected'); assert.equal(b.reason.code, 'STEL_PAUSA');
  assert.equal(S.enPausa(), true);
  await assert.rejects(S._client.get('/c'), e => e.code === 'STEL_PAUSA');
  assert.equal(llamadas, 1, 'en pausa no se llama');
  assert.ok(S.estadoPausa().hasta);
  await assert.rejects(S.fetchAllPages('/clients'), /pausa/i);   // no devuelve una lista vacía
});
