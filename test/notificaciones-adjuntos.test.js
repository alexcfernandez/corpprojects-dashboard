// test/notificaciones-adjuntos.test.js — sendEmail reenvía `attachments` al transporte.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const root = path.join(__dirname, '..');

// Mock de 'nodemailer' (captura lo que se envía por SMTP)
let captured = null;
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'nodemailer') return { createTransport: () => ({ sendMail: async (opts) => { captured = opts; return {}; } }) };
  return origLoad.apply(this, arguments);
};

// Forzamos la vía SMTP (sin OAuth de Gmail) para probar el passthrough de adjuntos.
delete process.env.GMAIL_REFRESH_TOKEN;
delete process.env.GMAIL_CLIENT_ID;

const notif = require(path.join(root, 'src/notifications.js'));

test('sendEmail pasa attachments (filename/content/contentType) al transporte', async () => {
  const attachments = [{ filename: 'factura.pdf', content: Buffer.from('PDF'), contentType: 'application/pdf' }];
  const ok = await notif.sendEmail({ to: 'buzon@corp.com', subject: 'Factura (WhatsApp)', text: 'hola', attachments });
  assert.equal(ok, true);
  assert.ok(captured, 'se llamó a sendMail');
  assert.equal(captured.to, 'buzon@corp.com');
  assert.equal(captured.attachments.length, 1);
  assert.equal(captured.attachments[0].filename, 'factura.pdf');
  assert.equal(captured.attachments[0].contentType, 'application/pdf');
});

test('sendEmail sin attachments no rompe (retrocompatible)', async () => {
  captured = null;
  await notif.sendEmail({ to: 'x@y.com', subject: 'S', text: 't' });
  assert.ok(captured);
  assert.equal(captured.attachments, undefined);
});

test.after(() => { Module._load = origLoad; });
