// Entrar a fichar con el móvil o el email (4/11/2026): código de 6 cifras, caducidad, intentos, límites y PIN propio.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ObjectId } = require('mongodb');
const A = require('../src/accesoCodigo');

function fakeDB() {
  const cols = {};
  const ok = (d, q) => Object.entries(q || {}).every(([k, v]) => (v instanceof ObjectId ? String(d[k]) === String(v) : d[k] === v));
  const collection = n => {
    const l = cols[n] = cols[n] || [];
    return {
      _l: l,
      insertOne: async d => { l.push(d); return {}; },
      findOne: async q => l.find(d => ok(d, q)) || null,
      updateOne: async (q, u, o = {}) => { let d = l.find(x => ok(x, q)); if (!d && o.upsert) { d = { _id: q._id }; l.push(d); } if (d) Object.assign(d, u.$set || {}); return { matchedCount: d ? 1 : 0 }; },
    };
  };
  return { collection, cols };
}
const david = { _id: new ObjectId(), name: 'David Taladros', role: 'tech', telefono: '648 11 22 33', email: 'david@ejemplo.com', pin: '7311', active: true };
const baja = { _id: new ObjectId(), name: 'Judit', telefono: '600000000', active: false };
const usuarios = [david, baja];

test('contacto: móvil con espacios o prefijo y email en mayúsculas dan la misma clave', () => {
  assert.strictEqual(A.normContacto('+34 648 11 22 33'), '648112233');
  assert.strictEqual(A.normContacto('648112233'), '648112233');
  assert.strictEqual(A.normContacto(' David@Ejemplo.com '), 'david@ejemplo.com');
  assert.strictEqual(A.normContacto('12345'), null);
  assert.strictEqual(A.normContacto('david@'), null);
  assert.strictEqual(A.buscar(usuarios, '600000000'), null);   // dado de baja: no
});

test('código por WhatsApp: entra con él una sola vez, sesión de 60 días; el mal código cuenta intentos', async () => {
  const db = fakeDB(); const enviados = [];
  const wa = async (to, t) => enviados.push([to, t]);
  const r = await A.pedir('648 11 22 33', { _db: db, _usuarios: usuarios, _whatsapp: wa, ahora: 1e12 });
  assert.deepStrictEqual(r, { ok: true, via: 'whatsapp' });
  assert.strictEqual(enviados.length, 1);
  const codigo = enviados[0][1].match(/\*(\d{6})\*/)[1];
  assert.match(enviados[0][1], /^🔐 David, tu código/);
  assert.ok(!JSON.stringify(db.cols.accesoCodigos).includes(codigo));   // solo la huella
  await assert.rejects(A.verificar('648112233', '000000' === codigo ? '111111' : '000000', { _db: db, _usuarios: usuarios, ahora: 1e12 }), /incorrecto/);
  const v = await A.verificar('+34648112233', codigo, { _db: db, _usuarios: usuarios, ahora: 1e12 + 1000 });
  assert.strictEqual(v.workerName, 'David Taladros');
  assert.strictEqual(v.tienePin, false);   // tiene PIN de la oficina, pero no uno suyo
  const tok = db.cols.worker_tokens[0];
  assert.strictEqual(tok.token, v.token);
  assert.strictEqual(+tok.expiresAt - 1e12 - 1000, 60 * 24 * 3600 * 1000);
  await assert.rejects(A.verificar('648112233', codigo, { _db: db, _usuarios: usuarios, ahora: 1e12 + 2000 }), /incorrecto o caducado/);   // no vale dos veces
});

test('caduca a los 10 min, 5 intentos como mucho y 3 códigos cada 15 min; el que no existe recibe la misma respuesta', async () => {
  const db = fakeDB(); const enviados = [];
  const wa = async (to, t) => enviados.push(t);
  await A.pedir('648112233', { _db: db, _usuarios: usuarios, _whatsapp: wa, ahora: 0 });
  const c = enviados[0].match(/\*(\d{6})\*/)[1];
  await assert.rejects(A.verificar('648112233', c, { _db: db, _usuarios: usuarios, ahora: 10 * 60 * 1000 + 1 }), /caducado/);
  await A.pedir('648112233', { _db: db, _usuarios: usuarios, _whatsapp: wa, ahora: 1000 });
  const c2 = enviados[1].match(/\*(\d{6})\*/)[1], malo = c2 === '123456' ? '654321' : '123456';
  for (let i = 0; i < 5; i++) await assert.rejects(A.verificar('648112233', malo, { _db: db, _usuarios: usuarios, ahora: 2000 }), /incorrecto/);
  await assert.rejects(A.verificar('648112233', c2, { _db: db, _usuarios: usuarios, ahora: 2000 }), /Demasiados intentos/);
  await A.pedir('648112233', { _db: db, _usuarios: usuarios, _whatsapp: wa, ahora: 3000 });
  await assert.rejects(A.pedir('648112233', { _db: db, _usuarios: usuarios, _whatsapp: wa, ahora: 4000 }), /varios códigos/);
  assert.deepStrictEqual(await A.pedir('699999999', { _db: db, _usuarios: usuarios, _whatsapp: wa }), { ok: true, via: 'whatsapp' });
  assert.strictEqual(enviados.length, 3);   // al que no existe no se le manda nada
  await assert.rejects(A.pedir('hola', { _db: db, _usuarios: usuarios }), /móvil \(9 cifras\) o tu email/);
});

test('por email va al correo de su ficha', async () => {
  const db = fakeDB(); const mails = [];
  const r = await A.pedir('DAVID@ejemplo.com', { _db: db, _usuarios: usuarios, _email: async o => mails.push(o) });
  assert.strictEqual(r.via, 'email');
  assert.strictEqual(mails[0].to, 'david@ejemplo.com');
  assert.match(mails[0].subject, /^Tu código para entrar: \d{6}$/);
});

test('PIN propio: 4-6 cifras y nada de 1234, 0000 o 9876', () => {
  assert.strictEqual(A.pinValido('4827'), null);
  assert.strictEqual(A.pinValido('482719'), null);
  assert.match(A.pinValido('1234'), /fácil/);
  assert.match(A.pinValido('0000'), /fácil/);
  assert.match(A.pinValido('9876'), /fácil/);
  assert.match(A.pinValido('12a4'), /4 cifras/);
  assert.match(A.pinValido('123'), /4 cifras/);
});

test('ponerPin: guarda y marca que es suyo; si otro lo tiene, no dice de quién', async () => {
  const db = fakeDB(); db.collection('users')._l.push({ ...david });
  await A.ponerPin(String(david._id), '4827', { _db: db, _actualizar: async () => {} });
  assert.strictEqual(db.cols.users[0].pinPropio, true);
  await assert.rejects(A.ponerPin(String(david._id), '5839', { _db: db, _actualizar: async () => { throw new Error('El PIN 5839 ya está en uso por Jose'); } }), e => e.message === 'Ese PIN no vale. Elige otro');
  await assert.rejects(A.ponerPin(String(david._id), '1111', { _db: db }), /fácil/);
});
