// src/notifications.js
// Módulo de notificaciones: Email + WhatsApp
const nodemailer = require('nodemailer');

// ─── Email transporter ───────────────────────────────────────────
function getTransporter() {
  const port = parseInt(process.env.EMAIL_PORT || 587);
  return nodemailer.createTransport({
    host:   process.env.EMAIL_HOST || 'smtp.gmail.com',
    port,
    secure: port === 465,            // 465 = SSL directo, 587 = STARTTLS
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    },
    // Timeouts para no quedarnos colgados si el host bloquea el SMTP saliente
    connectionTimeout: 10000,
    greetingTimeout:   10000,
    socketTimeout:     15000
  });
}

// ─── WhatsApp via Twilio ──────────────────────────────────────────
function getTwilioClient() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return null;
  try {
    const twilio = require('twilio');
    return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  } catch { return null; }
}

// ─── Emojis y textos por nivel ───────────────────────────────────
const LEVEL_INFO = {
  warning1:  { emoji: '⚠️',    label: 'Primer aviso',    color: '#f59e0b', days: process.env.ALERT_WARNING_DAYS  || 15 },
  warning2:  { emoji: '⚠️⚠️', label: 'Segundo aviso',   color: '#f97316', days: process.env.ALERT_SECOND_DAYS   || 30 },
  urgent:    { emoji: '🔴',    label: 'URGENTE',         color: '#ef4444', days: process.env.ALERT_URGENT_DAYS   || 45 },
  critical:  { emoji: '🚨',    label: 'CRÍTICO',         color: '#991b1b', days: process.env.ALERT_CRITICAL_DAYS || 60 }
};

// ─── Formatear dinero ────────────────────────────────────────────
function fmtEur(amount) {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(amount);
}

// ─── Enviar WhatsApp ─────────────────────────────────────────────
async function sendWhatsApp(message) {
  const client = getTwilioClient();
  if (!client) {
    console.log('[WhatsApp] Twilio no configurado, omitiendo. Mensaje:', message);
    return false;
  }
  try {
    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to:   process.env.WHATSAPP_TO,
      body: message
    });
    console.log('[WhatsApp] Enviado OK');
    return true;
  } catch (err) {
    console.error('[WhatsApp] Error:', err.message);
    return false;
  }
}

// ─── Enviar WhatsApp a UN destinatario concreto (no al owner fijo) ──
// `destinatario` en formato +34XXXXXXXXX (se le antepone whatsapp: si falta).
async function sendWhatsAppTo(destinatario, message) {
  const client = getTwilioClient();
  if (!client) {
    console.log('[WhatsApp] Twilio no configurado. Para', destinatario, ':', message);
    return false;
  }
  const to = /^whatsapp:/i.test(destinatario) ? destinatario : `whatsapp:${destinatario}`;
  try {
    await client.messages.create({ from: process.env.TWILIO_WHATSAPP_FROM, to, body: message });
    console.log('[WhatsApp] Enviado OK a', to);
    return true;
  } catch (err) {
    console.error('[WhatsApp] Error a', to, ':', err.message);
    return false;
  }
}

// ─── Enviar Email por la API de Gmail (HTTPS, no lo bloquea el host) ──
// Reutiliza las mismas credenciales OAuth que ya funcionan para LEER correo.
async function sendViaGmail({ from, to, bcc, subject, html, text }) {
  const { getGmailClient } = require('./email-intelligence');
  const gmail = getGmailClient();
  const boundary = '=_cp_' + Date.now();
  const subjectEnc = `=?UTF-8?B?${Buffer.from(subject || '').toString('base64')}?=`;
  const headerLines = [
    `From: ${from}`,
    `To: ${to}`
  ];
  if (bcc) headerLines.push(`Bcc: ${bcc}`);
  headerLines.push(
    `Subject: ${subjectEnc}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`
  );
  const headers = headerLines.join('\r\n');
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text || '').toString('base64'),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html || '').toString('base64'),
    `--${boundary}--`
  ].join('\r\n');
  const raw = Buffer.from(headers + '\r\n\r\n' + body)
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
}

// ─── Enviar Email ─────────────────────────────────────────────────
async function sendEmail({ to, bcc, subject, html, text }) {
  if (!to) { console.warn('[Email] Sin destinatario, omitiendo'); return false; }
  const from = process.env.EMAIL_FROM || `Corp Projects <${process.env.EMAIL_USER || ''}>`;

  // 1) Preferimos la API de Gmail si hay OAuth configurado (mismo canal que leer).
  if (process.env.GMAIL_REFRESH_TOKEN && process.env.GMAIL_CLIENT_ID) {
    try {
      await sendViaGmail({ from, to, bcc, subject, html, text });
      console.log(`[Email] Enviado (API Gmail) a ${to}${bcc ? ' (bcc '+bcc+')' : ''}: ${subject}`);
      return true;
    } catch (err) {
      // Si falla por permisos del token (falta scope de envío), lo veremos aquí.
      console.error('[Email] API Gmail falló, intento SMTP:', err.message);
    }
  }

  // 2) Plan B: SMTP (con timeouts; puede fallar si el host bloquea el puerto).
  try {
    const transporter = getTransporter();
    await transporter.sendMail({ from, to, bcc, subject, html, text });
    console.log(`[Email] Enviado (SMTP) a ${to}${bcc ? ' (bcc '+bcc+')' : ''}: ${subject}`);
    return true;
  } catch (err) {
    console.error('[Email] Error:', err.message);
    return false;
  }
}

// ─── Alerta de factura pendiente ──────────────────────────────────
async function sendInvoiceAlert(invoice) {
  const info = LEVEL_INFO[invoice.alertLevel];
  if (!info) return; // nivel 'ok', no alertar

  const subject = `${info.emoji} Factura ${invoice.number} — ${invoice.daysOverdue} días sin cobrar`;

  // Enlace al PDF oficial de la factura (cacheado; estable).
  let pdfPath = null;
  try { pdfPath = await require('./stelorder').getInvoicePdfPath(invoice.id); } catch { pdfPath = null; }
  const verFacturaBtn = pdfPath ? `
    <a href="${pdfPath}"
       style="display:block;background:#1f2937;color:#fff;text-align:center;padding:14px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;margin-bottom:10px">
      📄 Ver factura
    </a>` : '';

  // WhatsApp (mensaje corto)
  const waMsg = [
    `${info.emoji} *Corp Projects — ${info.label}*`,
    ``,
    `📄 Factura: *${invoice.number}*`,
    `👤 Cliente: ${invoice.client}`,
    `📅 Emitida: ${new Date(invoice.date).toLocaleDateString('es-ES')}`,
    `💰 Pendiente: *${fmtEur(invoice.pending)}*`,
    `⏱ Días sin cobrar: *${invoice.daysOverdue} días*`,
    ``,
    `👉 Ver en dashboard: https://dashboard.corpprojects.es`
  ].join('\n');

  // Email (HTML completo)
  const emailHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Inter,Arial,sans-serif;background:#f4f4f5;padding:20px;margin:0">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1)">
  
  <div style="background:${info.color};padding:24px 28px">
    <div style="font-size:28px;margin-bottom:6px">${info.emoji}</div>
    <div style="color:#fff;font-size:18px;font-weight:700">${info.label} — Factura pendiente</div>
    <div style="color:rgba(255,255,255,0.85);font-size:13px;margin-top:4px">Corp Projects Holding SL</div>
  </div>

  <div style="padding:24px 28px">
    <table style="width:100%;border-collapse:collapse">
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#6b7280;font-size:13px">Factura</td>
          <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:600;text-align:right">${invoice.number}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#6b7280;font-size:13px">Cliente</td>
          <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:600;text-align:right">${invoice.client}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#6b7280;font-size:13px">Fecha emisión</td>
          <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;text-align:right">${new Date(invoice.date).toLocaleDateString('es-ES')}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#6b7280;font-size:13px">Importe total</td>
          <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;text-align:right">${fmtEur(invoice.total)}</td></tr>
      <tr><td style="padding:10px 0;color:#6b7280;font-size:13px">Pendiente de cobro</td>
          <td style="padding:10px 0;font-weight:700;color:${info.color};font-size:18px;text-align:right">${fmtEur(invoice.pending)}</td></tr>
    </table>

    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px;margin:18px 0;text-align:center">
      <div style="font-size:28px;font-weight:700;color:${info.color}">${invoice.daysOverdue} días</div>
      <div style="font-size:13px;color:#6b7280;margin-top:2px">sin cobrar desde la fecha de emisión</div>
    </div>

    ${verFacturaBtn}
  </div>

  <div style="background:#f9fafb;padding:14px 28px;border-top:1px solid #f0f0f0;text-align:center;font-size:11px;color:#9ca3af">
    Corp Projects Holding SL · dashboard.corpprojects.es · ${new Date().toLocaleDateString('es-ES')}
  </div>
</div>
</body>
</html>`;

  // Destinatario: responsable de la familia; si no hay, el buzón de avisos.
  // Copia oculta (BCC) siempre al buzón de avisos para tener constancia.
  const avisos = require('./avisos');
  const avisosBox  = process.env.EMAIL_AVISOS || process.env.EMAIL_ADMIN;
  const familyMail = await avisos.getFamilyEmail(invoice.family);
  const to  = familyMail || avisosBox;
  const bcc = (avisosBox && avisosBox !== to) ? avisosBox : undefined;

  // Enviar ambos en paralelo
  await Promise.all([
    sendWhatsApp(waMsg),
    sendEmail({
      to,
      bcc,
      subject,
      html:    emailHtml,
      text:    waMsg
    })
  ]);
}

// ─── Resumen diario ───────────────────────────────────────────────
async function sendDailySummary(summary) {
  if (!summary) return;

  const waMsg = [
    `📊 *Resumen diario Corp Projects*`,
    `📅 ${new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })}`,
    ``,
    `💰 Facturado este mes: *${fmtEur(summary.totalBilledMonth)}*`,
    `📄 Facturas pendientes: *${summary.pendingInvoices}* (${fmtEur(summary.totalPending)})`,
    `⚠️ Con más de 30 días: *${summary.overdueCount}*`,
    `🚨 Críticas (+60 días): *${summary.criticalCount}*`,
    ``,
    `👉 https://dashboard.corpprojects.es`
  ].join('\n');

  await Promise.all([
    sendWhatsApp(waMsg),
    sendEmail({
      to:      process.env.EMAIL_ADMIN,
      subject: `📊 Resumen diario Corp Projects — ${new Date().toLocaleDateString('es-ES')}`,
      html:    `<pre style="font-family:sans-serif;white-space:pre-wrap">${waMsg}</pre>`,
      text:    waMsg
    })
  ]);
}

// ─── Resumen agrupado por familia (un correo con todas sus pendientes) ──
// Construye el correo de resumen agrupado (subject + html + texto WhatsApp).
// Lo usan tanto el envío real como la previsualización.
async function buildFamilySummaryEmail(family, invoices) {
  const list = [...invoices].sort((a,b) => (b.daysOverdue||0) - (a.daysOverdue||0));
  const totalPend = list.reduce((s,i) => s + (i.pending||0), 0);
  // Color por la factura más vencida
  const worst = list[0];
  const info  = LEVEL_INFO[worst.alertLevel] || { color:'#4d9cf8', emoji:'📋', label:'Resumen' };

  const subject = `📋 Corp Projects — ${list.length} factura(s) pendiente(s) · ${fmtEur(totalPend)}`;

  const waMsg = [
    `📋 *Corp Projects — Facturas pendientes (${family})*`,
    ``,
    ...list.map(i => `• ${i.number} — ${i.client} — ${fmtEur(i.pending)} (${i.daysOverdue}d)`),
    ``,
    `💰 *Total pendiente: ${fmtEur(totalPend)}*`,
    `👉 https://dashboard.corpprojects.es`
  ].join('\n');

  // Adjuntar el enlace al PDF oficial de cada factura (cacheado; estable).
  const stel = require('./stelorder');
  for (const i of list) {
    try { i.pdfPath = await stel.getInvoicePdfPath(i.id); }
    catch { i.pdfPath = null; }
  }

  const filas = list.map(i => `
    <tr>
      <td style="padding:9px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${i.number}</td>
      <td style="padding:9px 0;border-bottom:1px solid #f0f0f0;color:#374151">${i.client || ''}</td>
      <td style="padding:9px 0;border-bottom:1px solid #f0f0f0;text-align:center;color:${(i.daysOverdue||0)>=60?'#991b1b':(i.daysOverdue||0)>=30?'#f97316':'#6b7280'}">${i.daysOverdue}d</td>
      <td style="padding:9px 0;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600">${fmtEur(i.pending)}</td>
      <td style="padding:9px 0;border-bottom:1px solid #f0f0f0;text-align:center">${i.pdfPath ? `<a href="${i.pdfPath}" style="color:#2563eb;text-decoration:none;font-weight:600">Ver&nbsp;factura</a>` : '—'}</td>
    </tr>`).join('');

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Inter,Arial,sans-serif;background:#f4f4f5;padding:20px;margin:0">
<div style="max-width:620px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1)">
  <div style="background:${info.color};padding:24px 28px">
    <div style="color:#fff;font-size:18px;font-weight:700">Resumen de facturas pendientes</div>
    <div style="color:rgba(255,255,255,0.85);font-size:13px;margin-top:4px">${family} · Corp Projects Holding SL</div>
  </div>
  <div style="padding:24px 28px">
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr>
        <th style="text-align:left;padding:8px 0;border-bottom:2px solid #e5e7eb;color:#6b7280;font-size:12px">Factura</th>
        <th style="text-align:left;padding:8px 0;border-bottom:2px solid #e5e7eb;color:#6b7280;font-size:12px">Obra / Comunidad</th>
        <th style="text-align:center;padding:8px 0;border-bottom:2px solid #e5e7eb;color:#6b7280;font-size:12px">Días</th>
        <th style="text-align:right;padding:8px 0;border-bottom:2px solid #e5e7eb;color:#6b7280;font-size:12px">Pendiente</th>
        <th style="text-align:center;padding:8px 0;border-bottom:2px solid #e5e7eb;color:#6b7280;font-size:12px">Documento</th>
      </tr></thead>
      <tbody>${filas}</tbody>
      <tfoot><tr>
        <td colspan="3" style="padding:12px 0;font-weight:700">Total pendiente</td>
        <td style="padding:12px 0;text-align:right;font-weight:700;color:${info.color};font-size:16px">${fmtEur(totalPend)}</td>
        <td></td>
      </tr></tfoot>
    </table>
  </div>
  <div style="background:#f9fafb;padding:14px 28px;border-top:1px solid #f0f0f0;text-align:center;font-size:11px;color:#9ca3af">
    Corp Projects Holding SL · dashboard.corpprojects.es · ${new Date().toLocaleDateString('es-ES')}
  </div>
</div>
</body>
</html>`;

  return { subject, html, waMsg };
}

async function sendFamilySummary(family, invoices) {
  if (!family || !invoices || !invoices.length) return false;
  const { subject, html, waMsg } = await buildFamilySummaryEmail(family, invoices);

  const avisos = require('./avisos');
  const avisosBox  = process.env.EMAIL_AVISOS || process.env.EMAIL_ADMIN;
  const familyMail = await avisos.getFamilyEmail(family);
  const to  = familyMail || avisosBox;
  const bcc = (avisosBox && avisosBox !== to) ? avisosBox : undefined;

  await Promise.all([
    sendWhatsApp(waMsg),
    sendEmail({ to, bcc, subject, html, text: waMsg })
  ]);
  return true;
}

// ── AVISO DIARIO DE PEDIDOS DE TRABAJO (rojos + ámbar) ───────────────────
function buildWorkOrdersEmail(orders) {
  const list = [...orders].sort((a, b) => (b.days || 0) - (a.days || 0));
  const rojos  = list.filter(o => o.alertLevel === 'red').length;
  const ambar  = list.filter(o => o.alertLevel === 'amber').length;
  const headColor = rojos > 0 ? '#dc2626' : '#f97316';

  const subject = `🔧 Pedidos de trabajo a revisar — ${rojos} críticos, ${ambar} en atención`;

  const waMsg = [
    `🔧 *Pedidos de trabajo a revisar*`,
    ``,
    ...list.map(o => `• ${o.number} — ${o.client} — ${o.type} — ${o.days}d (${o.alertLabel})`),
    ``,
    `🔴 ${rojos} críticos · 🟠 ${ambar} en atención`
  ].join('\n');

  const filas = list.map(o => `
    <tr>
      <td style="padding:9px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${o.number}</td>
      <td style="padding:9px 0;border-bottom:1px solid #f0f0f0;color:#374151">${o.client || ''}</td>
      <td style="padding:9px 0;border-bottom:1px solid #f0f0f0;color:#6b7280">${o.type || ''}</td>
      <td style="padding:9px 0;border-bottom:1px solid #f0f0f0;color:#374151">${o.assignedUserName || '<span style="color:#dc2626">Sin asignar</span>'}</td>
      <td style="padding:9px 0;border-bottom:1px solid #f0f0f0;text-align:center;font-weight:700;color:${o.alertColor}">${o.days}d</td>
      <td style="padding:9px 0;border-bottom:1px solid #f0f0f0;text-align:center">${o.pdfPath ? `<a href="${o.pdfPath}" style="color:#2563eb;text-decoration:none;font-weight:600">Ver</a>` : '—'}</td>
    </tr>`).join('');

  const html = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family:Inter,Arial,sans-serif;background:#f4f4f5;padding:20px;margin:0">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1)">
  <div style="background:${headColor};padding:22px 28px">
    <div style="color:#fff;font-size:18px;font-weight:700">Pedidos de trabajo a revisar</div>
    <div style="color:rgba(255,255,255,0.85);font-size:13px;margin-top:4px">${rojos} críticos · ${ambar} en atención · Corp Projects Holding SL</div>
  </div>
  <div style="padding:24px 28px">
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr>
        <th style="text-align:left;padding:8px 0;border-bottom:2px solid #e5e7eb;color:#6b7280;font-size:12px">Pedido</th>
        <th style="text-align:left;padding:8px 0;border-bottom:2px solid #e5e7eb;color:#6b7280;font-size:12px">Cliente / Comunidad</th>
        <th style="text-align:left;padding:8px 0;border-bottom:2px solid #e5e7eb;color:#6b7280;font-size:12px">Tipo</th>
        <th style="text-align:left;padding:8px 0;border-bottom:2px solid #e5e7eb;color:#6b7280;font-size:12px">Asignado</th>
        <th style="text-align:center;padding:8px 0;border-bottom:2px solid #e5e7eb;color:#6b7280;font-size:12px">Días</th>
        <th style="text-align:center;padding:8px 0;border-bottom:2px solid #e5e7eb;color:#6b7280;font-size:12px">Doc</th>
      </tr></thead>
      <tbody>${filas}</tbody>
    </table>
  </div>
  <div style="background:#f9fafb;padding:14px 28px;border-top:1px solid #f0f0f0;text-align:center;font-size:11px;color:#9ca3af">
    Corp Projects Holding SL · ${new Date().toLocaleDateString('es-ES')}
  </div>
</div>
</body></html>`;

  return { subject, html, waMsg };
}

// Envía el resumen de pedidos a revisar al email indicado (solo email).
async function sendWorkOrdersSummary(orders, to) {
  if (!orders || !orders.length) return { sent: false, reason: 'sin pedidos' };
  const dest = to || process.env.EMAIL_PEDIDOS || process.env.EMAIL_AVISOS || 'hola@corpprojects.es';
  const { subject, html, waMsg } = buildWorkOrdersEmail(orders);
  await sendEmail({ to: dest, subject, html, text: waMsg });
  return { sent: true, to: dest, count: orders.length };
}

module.exports = { sendInvoiceAlert, sendDailySummary, sendFamilySummary, buildFamilySummaryEmail, buildWorkOrdersEmail, sendWorkOrdersSummary, sendWhatsApp, sendWhatsAppTo, sendEmail };
