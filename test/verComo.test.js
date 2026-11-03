// «Ver como…» (3/11/2026): con un token w_vc_ solo se lee; nada de guardar ni de abrir documentos personales.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const VC = require('../src/verComo');

async function pedir(port, method, ruta, token) {
  return new Promise((ok, ko) => {
    const cuerpo = method === 'GET' ? '' : '{}';
    const r = http.request({ port, method, path: ruta, agent: false, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(cuerpo) } }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => ok({ status: res.statusCode, body: b })); });
    r.on('error', ko); r.end(cuerpo);
  });
}

test('candado: con w_vc_ se lee pero no se guarda; los tokens normales no cambian', async () => {
  const app = express();
  app.use('/api/', VC.soloLectura);
  app.all('/api/*', (req, res) => res.json({ ok: true }));
  const srv = app.listen(0); const port = srv.address().port;
  try {
    const vc = 'w_vc_abc', w = 'w_normal', jwt = 'eyJ.x.y';
    assert.strictEqual((await pedir(port, 'GET', '/api/workorders/mine', vc)).status, 200);
    assert.strictEqual((await pedir(port, 'GET', '/api/fichaje/estado', vc)).status, 200);
    for (const [m, r] of [['POST', '/api/fichaje/fichar'], ['POST', '/api/workorders/1/start'], ['PUT', '/api/partes/1'], ['DELETE', '/api/asignaciones/1'], ['PATCH', '/api/x'], ['POST', '/api/fichaje/traducir']]) {
      const x = await pedir(port, m, r, vc);
      assert.strictEqual(x.status, 403, `${m} ${r}`);
      assert.match(x.body, /solo para mirar/);
    }
    assert.strictEqual((await pedir(port, 'GET', '/api/fichaje/mis-docs/123', vc)).status, 403);
    assert.strictEqual((await pedir(port, 'GET', '/api/fichaje/firmas/9/doc', vc)).status, 403);
    assert.strictEqual((await pedir(port, 'GET', '/api/fichaje/mis-docs', vc)).status, 200);   // la lista sí (sin abrirlos)
    assert.strictEqual((await pedir(port, 'POST', '/api/fichaje/fichar', w)).status, 200);
    assert.strictEqual((await pedir(port, 'POST', '/api/fichaje/fichar', jwt)).status, 200);
  } finally { srv.close(); }
});

test('token: 30 minutos, rol real del trabajador y marcado de solo lectura', () => {
  const t = VC.nuevoToken({ _id: 'u1', name: 'David Taladros', role: 'tech' }, 'Álex', { ahora: 1000 });
  assert.match(t.token, /^w_vc_[0-9a-f]{32}$/);
  assert.strictEqual(t.workerRole, 'tech');
  assert.strictEqual(t.soloLectura, true);
  assert.strictEqual(+t.expiresAt - +t.createdAt, 30 * 60 * 1000);
  assert.strictEqual(t.verComoPor, 'Álex');
});
