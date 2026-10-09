// src/gmailBorrador.js — Deja un correo PREPARADO como borrador en el Gmail de la empresa (no lo envía): para lo
// que alguien tiene que revisar antes de mandar (pedir documentos, el paquete para un contratista…). Devuelve el
// enlace para abrirlo en Gmail.
'use strict';
async function crear({ para = [], cc = [], asunto = '', texto = '', adjuntos = [] }) {
  const { getGmailClient } = require('./email-intelligence');
  const gmail = getGmailClient();
  const MailComposer = require('nodemailer/lib/mail-composer');
  const from = process.env.EMAIL_FROM || 'Corp Projects <hola@corpprojects.es>';
  const raw = await new Promise((ok, ko) => new MailComposer({ from, to: para.join(', ') || undefined, cc: cc.join(', ') || undefined, subject: asunto, text: texto, attachments: adjuntos }).compile().build((e, b) => (e ? ko(e) : ok(b))));
  const r = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw: raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') } } });
  const msgId = r.data.message && r.data.message.id;
  return { ok: true, id: r.data.id, url: `https://mail.google.com/mail/u/0/#drafts?compose=${msgId}` };
}
module.exports = { crear };
