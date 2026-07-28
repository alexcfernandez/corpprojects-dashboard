// test/fase2-facturas.test.js — Factura por WhatsApp → reenvío al buzón de n8n.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');

// Mock de ./db (log facturasWhatsApp)
let logRows = [];
const dbPath = require.resolve(path.join(root, 'src/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  getDB: async () => ({ collection: () => ({ async insertOne(d) { logRows.push(d); return { insertedId: 'x' }; } }) }),
} };

const facturaWA = require(path.join(root, 'src/facturaWhatsApp.js'));
const notif = require(path.join(root, 'src/notifications.js'));

// Espía de sendEmail
let enviados = [];
notif.sendEmail = async (opts) => { enviados.push(opts); return true; };

process.env.INVOICE_INBOX_EMAIL = 'corpprojectsholding@gmail.com';

// Descargas de Twilio simuladas (inyectadas)
const descargarArchivo = async () => Buffer.from('PDFDATA').toString('base64');
const descargarFoto = async () => ({ media_type: 'image/jpeg', data: Buffer.from('IMG').toString('base64') });

test('esReenvioFactura: detecta la palabra "factura"', () => {
  assert.equal(facturaWA.esReenvioFactura('sube esta factura'), true);
  assert.equal(facturaWA.esReenvioFactura('escanea la factura del gas'), true);
  assert.equal(facturaWA.esReenvioFactura('hazme un presupuesto de esto'), false);
  assert.equal(facturaWA.esReenvioFactura('¿qué debe Illa Verda?'), false);
});

test('reenviarFactura con PDF → sendEmail al buzón con 1 adjunto', async () => {
  enviados = []; logRows = [];
  const r = await facturaWA.reenviarFactura({ from: 'whatsapp:+34x', pdf: { url: 'u', type: 'application/pdf' }, fotos: [], descargarArchivo, descargarFoto });
  assert.equal(r.ok, true);
  assert.match(r.reply, /StelOrder/);
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].to, 'corpprojectsholding@gmail.com');
  assert.equal(enviados[0].subject, 'Factura (WhatsApp)');
  assert.equal(enviados[0].attachments.length, 1);
  assert.equal(enviados[0].attachments[0].contentType, 'application/pdf');
  assert.equal(logRows.length, 1);
  assert.equal(logRows[0].nAdjuntos, 1);
});

test('reenviarFactura con varias fotos → un email con varios adjuntos', async () => {
  enviados = [];
  const r = await facturaWA.reenviarFactura({ from: 'x', pdf: null, fotos: [{ url: 'a', type: 'image/jpeg' }, { url: 'b', type: 'image/jpeg' }], descargarArchivo, descargarFoto });
  assert.equal(r.ok, true);
  assert.equal(enviados[0].attachments.length, 2);
});

test('reenviarFactura sin adjunto descargable → no envía, avisa', async () => {
  enviados = [];
  const r = await facturaWA.reenviarFactura({ from: 'x', pdf: null, fotos: [], descargarArchivo, descargarFoto });
  assert.equal(r.ok, false);
  assert.equal(enviados.length, 0);
  assert.match(r.reply, /adjunto/i);
});

test('si sendEmail falla → ok:false y avisa', async () => {
  notif.sendEmail = async () => { throw new Error('smtp caído'); };
  const r = await facturaWA.reenviarFactura({ from: 'x', pdf: { url: 'u' }, fotos: [], descargarArchivo, descargarFoto });
  assert.equal(r.ok, false);
  assert.match(r.reply, /no he podido/i);
  notif.sendEmail = async (o) => { enviados.push(o); return true; };
});
