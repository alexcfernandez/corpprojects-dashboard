'use strict';
const test = require('node:test');
const assert = require('node:assert');
const D = require('../src/datosCliente');

function fakeDb() {
  const cols = {}; let n = 0;
  const ok = (d, q) => Object.entries(q).every(([k, v]) => String(d[k]) === String(v));
  const col = name => {
    const l = cols[name] = cols[name] || [];
    return {
      l,
      findOne: async (q) => l.filter(d => ok(d, q)).slice(-1)[0] || null,
      insertOne: async d => { d._id = d._id || ('c'.repeat(23) + (++n)).slice(-24); l.push(d); return { insertedId: d._id }; },
      updateOne: async (q, u) => { const d = l.find(x => ok(x, q)); if (d) { Object.assign(d, u.$set || {}); for (const [k, v] of Object.entries(u.$inc || {})) d[k] = (d[k] || 0) + v; } return { matchedCount: d ? 1 : 0 }; },
      find: q => ({ toArray: async () => l.filter(d => ok(d, q)) }),
    };
  };
  const cache = {};
  return { cols, collection: name => (cache[name] = cache[name] || col(name)) };
}

test('validarNif: DNI, NIE y CIF con su letra o dígito de control; nifDeTexto lo saca de un mensaje', () => {
  assert.deepStrictEqual([D.validarNif('41580660H').ok, D.validarNif('41580660H').tipo], [true, 'DNI']);
  assert.strictEqual(D.validarNif('41580660J').ok, false);
  assert.strictEqual(D.validarNif('Z5544266Y').ok, true);           // NIE de Javier (empieza por Z)
  assert.strictEqual(D.validarNif('X4871583E').ok, true);
  assert.strictEqual(D.validarNif('B67781773').ok, true);           // Gest Art
  assert.strictEqual(D.validarNif('B09899253').ok, true);           // Corp
  assert.strictEqual(D.validarNif('B09899254').ok, false);
  assert.strictEqual(D.nifDeTexto('mi dni es 41.580.660-h gracias'), '41580660H');
  assert.strictEqual(D.nifDeTexto('vale, mañana te lo paso'), null);
});

test('pedir: guarda el teléfono si la ficha no lo tenía, manda el WhatsApp y deja la petición abierta', async () => {
  const db = fakeDb(); const enviados = [], guardados = [];
  const r = await D.pedir({ clienteId: '15316567', telefono: '687 05 88 12', que: 'dni', por: 'Álex' }, {
    _db: db, _cliente: async () => ({ id: 15316567, 'legal-name': 'Aura Marquès i Lluis Van Eeckhout', phone: '' }),
    _guardar: async (id, cambios) => { guardados.push([id, cambios]); return {}; },
    _enviar: async (to, txt) => { enviados.push([to, txt]); return true; },
  });
  assert.strictEqual(r.a, '+34687058812');
  assert.deepStrictEqual(guardados, [['15316567', { phone: '687058812' }]]);
  assert.match(enviados[0][1], /^Hola Aura, soy Corpy, de la oficina de Corp Projects/);
  assert.match(enviados[0][1], /DNI/);
  assert.strictEqual(db.cols.peticionesCliente[0].estado, 'abierta');
  await assert.rejects(D.pedir({ clienteId: '1', telefono: null }, { _db: db, _cliente: async () => ({ id: 1, name: 'Sin móvil' }) }), /teléfono/);
});

test('respuesta: foto del DNI → se valida, va a StelOrder si estaba vacío, se guarda y se avisa a Álex; si había otro, no se pisa', async () => {
  const db = fakeDb();
  db.collection('peticionesCliente').l.push({ _id: 'p1', clienteId: '15316567', nombre: 'Aura Marquès', movil: '+34687058812', que: 'dni', estado: 'abierta', at: new Date() });
  const avisos = [], guardados = [], mem = [];
  const opts = { _db: db, _bajar: async () => Buffer.from('jpg'), _mirar: async () => ({ tipo: 'dni', legible: true, numero: '41580660H' }),
    _cliente: async () => ({ 'tax-identification-number': '' }), _guardar: async (id, c) => { guardados.push(c); }, _avisar: async (t, a) => avisos.push([t, !!a]), _memoria: { apuntar: async h => mem.push(h) } };
  // Un número sin petición: no es cosa nuestra.
  assert.strictEqual(await D.respuesta('+34600000000', 'hola', {}, opts), null);
  const r = await D.respuesta('whatsapp:+34687058812', '', { fotos: [{ url: 'bridge-media:1', type: 'image/jpeg' }] }, opts);
  assert.match(r, /Recibido/);
  assert.deepStrictEqual(guardados, [{ 'tax-identification-number': '41580660H' }]);
  assert.match(avisos[0][0], /Aura Marquès.*DNI: \*41580660H\*.*ficha de StelOrder/);
  assert.strictEqual(avisos[0][1], true);                       // se le reenvía la foto
  assert.strictEqual(db.cols.docsClientes.length, 1);
  assert.strictEqual(db.cols.peticionesCliente[0].estado, 'recibida');
  assert.strictEqual(mem[0].ambito, 'interno');

  // Otro cliente con NIF distinto en la ficha: no se toca.
  db.collection('peticionesCliente').l.push({ _id: 'p2', clienteId: '2', nombre: 'Otro', movil: '+34611111111', que: 'dni', estado: 'abierta', at: new Date() });
  guardados.length = 0; avisos.length = 0;
  await D.respuesta('+34611111111', 'Mi DNI: 41580660-H', {}, { ...opts, _cliente: async () => ({ 'tax-identification-number': 'X4871583E' }) });
  assert.strictEqual(guardados.length, 0);
  assert.match(avisos[0][0], /tenía otro \(X4871583E\).*NO lo he cambiado/);
});

test('respuesta: número mal o texto sin número; recordar manda uno a los 2 días y luego avisa a Álex', async () => {
  const db = fakeDb();
  db.collection('peticionesCliente').l.push({ _id: 'p1', clienteId: '1', nombre: 'Aura', movil: '+34687058812', que: 'dni', estado: 'abierta', at: new Date('2026-11-02T10:00:00Z'), recordatorios: 0 });
  const avisos = [];
  const base = { _db: db, _avisar: async t => avisos.push(t), _cliente: async () => ({}), _guardar: async () => {} };
  assert.match(await D.respuesta('+34687058812', '41580660J', {}, base), /no me cuadra/);
  assert.match(await D.respuesta('+34687058812', 'mañana te lo mando', {}, base), /se lo paso a Álex/);
  assert.match(avisos[1], /mañana te lo mando/);
  const env = [];
  const enviar = async (to, t) => { env.push(t); return true; };
  assert.strictEqual((await D.recordar({ hoy: new Date('2026-11-03T09:40:00Z'), _db: db, _enviar: enviar })).recordados, 0);   // aún no
  assert.strictEqual((await D.recordar({ hoy: new Date('2026-11-04T09:40:00Z'), _db: db, _enviar: enviar })).recordados, 1);
  assert.match(env[0], /te lo recuerdo/);
  const jefe = [];
  await D.recordar({ hoy: new Date('2026-11-05T09:40:00Z'), _db: db, _enviar: enviar, _avisarJefe: async t => jefe.push(t) });
  assert.strictEqual(jefe.length, 0);
  await D.recordar({ hoy: new Date('2026-11-06T09:40:00Z'), _db: db, _enviar: enviar, _avisarJefe: async t => jefe.push(t) });
  assert.match(jefe[0], /¿Le llamas\?/);
  assert.strictEqual(env.length, 1);
});
