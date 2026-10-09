// test/firmas.test.js — Firma en la app: se estampa en el PDF (hoja de firma + marca en cada página) y se guarda.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ObjectId } = require('mongodb');
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const U = new ObjectId(), DOC = new ObjectId();
const cols = { users: [{ _id: U, name: 'Manolo García', telefono: '+34611223344' }], firmasPedidas: [], docsPersonal: [] };
const igual = (a, b) => String(a) === String(b);
const cumple = (d, q) => Object.entries(q).every(([k, v]) => igual(d[k], v));
stub('src/db.js', { getDB: async () => ({ collection: n => ({
  findOne: async q => (cols[n] || []).find(d => cumple(d, q)) || null,
  find: q => ({ sort: function () { return this; }, limit: function () { return this; }, toArray: async () => (cols[n] || []).filter(d => cumple(d, q || {})) }),
  insertOne: async d => { const _id = new ObjectId(); cols[n].push({ _id, ...d }); return { insertedId: _id }; },
  updateOne: async (q, u) => { const d = (cols[n] || []).find(x => cumple(x, q)); if (d) Object.assign(d, u.$set || {}); },
}) }) });
let pdfOriginal;
const guardados = [];
stub('src/personalDocs.js', { archivo: async () => ({ _id: DOC, nombre: 'Contrato Manolo.pdf', tipo: 'contrato', mime: 'application/pdf', data: pdfOriginal }), subir: async (o) => { guardados.push(o); return { id: 'g' + guardados.length }; } });
stub('src/notifications.js', { sendWhatsApp: async () => true, sendWhatsAppTo: async () => true });
stub('src/fichajeAvisos.js', { enlacePersonal: async () => 'https://x/fichar?t=1' });
const F = require(path.join(root, 'src/firmas.js'));
// PNG de 40x20 con algo dibujado (no vacío)

test('contrato: pedir firma, firmar y queda copia firmada con una página más', async () => {
  const { PDFDocument } = require('pdf-lib');
  const p = await PDFDocument.create(); p.addPage([595, 842]); p.addPage([595, 842]); pdfOriginal = Buffer.from(await p.save());
  cols.docsPersonal.push({ _id: DOC, userId: String(U), nombre: 'Contrato Manolo.pdf', tipo: 'contrato', mime: 'application/pdf' });
  const env = [];
  const r = await F.pedir({ userId: String(U), tipo: 'documento', docId: String(DOC) }, 'Oficina', { _enviar: async (a, t) => { env.push(t); return true; } });
  assert.equal(r.avisado, true); assert.match(env[0], /Contrato Manolo\.pdf/);
  assert.equal((await F.pendientesDe(String(U))).length, 1);
  await assert.rejects(F.firmar(r.id, String(U), { firmaDataUrl: 'data:image/png;base64,AAAA' }), /vacía/);
  const sig = require('fs').readFileSync(path.join(root, 'public/icons/icon-192.png'));
  const ok = await F.firmar(r.id, String(U), { firmaDataUrl: 'data:image/png;base64,' + sig.toString('base64'), ip: '1.2.3.4' });
  assert.ok(ok.docId);
  const g = guardados.pop(); assert.equal(g.tipo, 'contrato'); assert.match(g.archivo.originalname, /\(firmado\)\.pdf$/);
  const firmado = await PDFDocument.load(g.archivo.buffer); assert.equal(firmado.getPageCount(), 3);
  assert.equal((await F.pendientesDe(String(U))).length, 0);
});

test('entrega de EPIs: se genera el PDF y al firmar va a la carpeta como «epis»', async () => {
  const r = await F.pedir({ userId: String(U), tipo: 'epis', items: [{ nombre: 'Botas de seguridad S3', talla: '43' }, { nombre: 'Gafas', cantidad: 1 }] }, 'Álex', { _enviar: async () => true });
  const d = await F.documentoParaFirmar(r.id, String(U)); assert.equal(d.mime, 'application/pdf'); assert.ok(d.buffer.length > 1000);
  const sig = require('fs').readFileSync(path.join(root, 'public/icons/icon-192.png'));
  await F.firmar(r.id, String(U), { firmaDataUrl: 'data:image/png;base64,' + sig.toString('base64') });
  assert.equal(guardados.pop().tipo, 'epis');
});
