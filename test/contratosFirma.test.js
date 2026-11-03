// test/contratosFirma.test.js — contratos de la gestoría: firma Alfonso → trabajador; al acabar, borrador a Eduard (4/11/2026).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ObjectId } = require('mongodb');
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const UR = new ObjectId();
const users = [{ _id: UR, name: 'Ramon Dominguez', nombreCompleto: 'José Ramón Domínguez Sauceda', whatsapp: '+34600111222', docs: { dni: 'Y3496546P' } }];
let lotes = [];
stub('src/db.js', { getDB: async () => ({ collection: n => ({
  findOne: async q => n === 'users' ? users.find(u => String(u._id) === String(q._id)) || null : (lotes.find(l => l.items.some(i => i.docId === q['items.docId'])) || null),
}) }) });
stub('src/personalDocs.js', { archivo: async id => ({ nombre: 'Contrato Ramon (firmado por José).pdf', data: Buffer.from('%PDF-1.4 x'), mime: 'application/pdf' }) });
const CF = require(path.join(root, 'src/contratosFirma.js'));

test('pide la firma: Alfonso primero (importante, con sello) y luego el trabajador; no duplica', async () => {
  const llamadas = [];
  const r = await CF.pedirFirma({ userId: String(UR), docId: 'a'.repeat(24) }, { _crear: async o => { llamadas.push(o); return { ok: true, id: 'L1' }; } });
  assert.equal(r.id, 'L1');
  const o = llamadas[0];
  assert.equal(o.nombre, 'Alfonso Gálvez Cámara'); assert.equal(o.importante, true); assert.equal(o.sello, true);
  assert.equal(o.docs[0].tipoDestino, 'contrato');
  assert.equal(o.luego.nombre, 'José Ramón Domínguez Sauceda'); assert.equal(o.luego.telefono, '+34600111222');
  assert.equal(o.alFinal.tipo, 'contrato_gestoria');
  lotes = [{ _id: new ObjectId(), items: [{ docId: 'a'.repeat(24) }] }];
  assert.equal((await CF.pedirFirma({ userId: String(UR), docId: 'a'.repeat(24) }, { _crear: async () => { throw new Error('no debería'); } })).yaPedido, true);
});

test('al acabar: borrador a Eduard en catalán con el contrato firmado y aviso a Álex (sin enviar)', async () => {
  const borr = [], avisos = [];
  await CF.alFirmar({ nombre: 'José Ramón Domínguez Sauceda', dni: 'Y3496546P', items: [{ firmadoId: 'b'.repeat(24) }], alFinal: { tipo: 'contrato_gestoria', userId: String(UR), nombre: 'José Ramón Domínguez Sauceda' } },
    { _borrador: async o => { borr.push(o); return { id: 'D1' }; }, _avisar: async t => { avisos.push(t); return true; } });
  assert.equal(borr[0].to, 'eduard@somassessors.com'); assert.equal(borr[0].bcc, 'hola@corpprojects.es');
  assert.match(borr[0].text, /Us adjuntem el contracte signat/); assert.match(borr[0].attachments[0].filename, /\(signat\)/);
  assert.match(avisos[0], /borradores/);
});

test('correo de la gestoría: PDF de contrato → pide firma; Word → aviso para pasarlo a PDF; de otros, nada', async () => {
  const pedidos = [], avisos = [];
  const deps = { _pedir: async o => { pedidos.push(o); return { ok: true }; }, _avisar: async t => { avisos.push(t); return true; } };
  assert.equal((await CF.desdeCorreo({ de: 'x@otro.com', guardados: [{ tipo: 'contrato', userId: String(UR), id: 'c'.repeat(24) }] }, deps)).nada, true);
  const r = await CF.desdeCorreo({ de: 'Eduard <eduard@somassessors.com>', asunto: 'Contractes', adjuntos: [{ filename: 'Contracte Melvin.doc' }], guardados: [{ tipo: 'contrato', userId: String(UR), id: 'c'.repeat(24), nombre: 'Ramon' }, { tipo: 'nomina', userId: String(UR), id: 'd'.repeat(24) }] }, deps);
  assert.deepEqual(r, { pedidos: 1, word: 1 });
  assert.match(avisos[0], /Alfonso/); assert.match(avisos[0], /Word/);
});
