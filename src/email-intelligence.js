// src/email-intelligence.js
// Sistema de email inteligente — Corp Projects
const { google } = require('googleapis');
const { MongoClient } = require('mongodb');

// ── Gmail OAuth ───────────────────────────────────────────────────
function getGmailClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// ── MongoDB ───────────────────────────────────────────────────────
async function getDB() {
  return require('./db').getDBLegacy();
}

// ── Decodificar base64 de Gmail ───────────────────────────────────
function decodeBase64(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

// ── Limpiar HTML y URLs del cuerpo ────────────────────────────────
function limpiarCuerpo(texto) {
  return texto
    // Quitar URLs largas (tracking, redirects, etc.)
    .replace(/https?:\/\/\S{60,}/g, '[enlace]')
    .replace(/https?:\/\/\S+/g, (url) => {
      // Conservar URLs cortas legibles
      try {
        const u = new URL(url);
        return u.hostname.replace('www.', '');
      } catch { return '[enlace]'; }
    })
    // Quitar HTML residual
    .replace(/<[^>]+>/g, ' ')
    // Quitar caracteres raros de encoding
    .replace(/=\w{2}/g, '')
    .replace(/\r\n/g, '\n')
    // Reducir espacios múltiples
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Extraer texto del mensaje ─────────────────────────────────────
function extractBody(payload) {
  if (!payload) return '';

  // Función recursiva para buscar en partes anidadas
  function buscarTexto(parts, mimeTarget) {
    for (const part of parts || []) {
      if (part.mimeType === mimeTarget && part.body?.data) {
        return decodeBase64(part.body.data);
      }
      if (part.parts) {
        const found = buscarTexto(part.parts, mimeTarget);
        if (found) return found;
      }
    }
    return '';
  }

  // 1. Body directo
  if (payload.body?.data) return limpiarCuerpo(decodeBase64(payload.body.data));

  // 2. text/plain primero (más limpio)
  const plain = buscarTexto(payload.parts, 'text/plain');
  if (plain) return limpiarCuerpo(plain);

  // 3. text/html como fallback (quitando style/script/head ANTES del strip de etiquetas,
  //    si no, el CSS interno del email aparece como si fuera el mensaje)
  const html = buscarTexto(payload.parts, 'text/html');
  if (html) {
    const sinBloques = html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<head[\s\S]*?<\/head>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');
    const sinTags = sinBloques.replace(/<[^>]+>/g, ' ');
    // CSS suelto que sobrevive (selector { props }) — frecuente en emails de marketing
    const sinCss = sinTags
      .replace(/[^{}]{0,80}\{[^{}]*\}/g, ' ')
      .replace(/[^{}]{0,80}\{\s*/g, ' ');
    return limpiarCuerpo(sinCss.replace(/\s+/g, ' '));
  }

  return '';
}

// ── Adjuntos ──────────────────────────────────────────────────────
// Recorre las partes del mensaje y devuelve los adjuntos reales
// (con nombre de archivo y attachmentId para poder descargarlos).
function extractAttachments(payload) {
  const out = [];
  function walk(parts) {
    for (const part of parts || []) {
      if (part.filename && part.body?.attachmentId) {
        out.push({
          filename: part.filename,
          mimeType: part.mimeType || 'application/octet-stream',
          size: part.body.size || 0,
          attachmentId: part.body.attachmentId
        });
      }
      if (part.parts) walk(part.parts);
    }
  }
  walk(payload?.parts);
  return out;
}

// Lista los adjuntos de un mensaje EN VIVO desde Gmail (vale para emails antiguos).
async function listAttachments(gmailId) {
  const gmail = getGmailClient();
  const msg = await gmail.users.messages.get({ userId: 'me', id: gmailId, format: 'full' });
  return extractAttachments(msg.data.payload);
}

// Descarga un adjunto concreto (devuelve Buffer).
async function getAttachment(gmailId, attachmentId) {
  const gmail = getGmailClient();
  const att = await gmail.users.messages.attachments.get({ userId: 'me', messageId: gmailId, id: attachmentId });
  const data = att.data.data || '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// ── Extraer email limpio del campo "De:" ──────────────────────────
function parsearRemitente(de) {
  // Formato: "Nombre Apellido <email@dominio.com>" o solo "email@dominio.com"
  const matchCompleto = de.match(/^"?([^"<]+)"?\s*<([^>]+)>/);
  if (matchCompleto) {
    return {
      nombreMostrado: matchCompleto[1].trim(),
      email: matchCompleto[2].trim().toLowerCase()
    };
  }
  // Solo email
  const emailLimpio = de.trim().toLowerCase();
  return {
    nombreMostrado: emailLimpio.split('@')[0],
    email: emailLimpio
  };
}

// ── Pre-filtro GRATIS (sin IA): publicidad/newsletters obvias ─────
function esPublicidadObvia(de, asunto, cuerpo) {
  const d = String(de || '').toLowerCase();
  const t = (String(asunto || '') + ' ' + String(cuerpo || '').slice(0, 1500)).toLowerCase();
  if (/no-?reply|noreply|newsletter|marketing|promo|mailing|news@|info@b\./.test(d)) return true;
  if (/darse de baja|unsubscribe|cancelar suscripci|ver en el navegador|view in browser/.test(t)) return true;
  return false;
}

// ── Límite diario de llamadas a la IA (techo de gasto) ────────────
async function consumirCupoIA() {
  const limite = parseInt(process.env.EMAIL_IA_DAILY_LIMIT || 150);
  const { db } = await getDB();
  const day = new Date().toISOString().slice(0, 10);
  const r = await db.collection('iaUsage').findOneAndUpdate(
    { day }, { $inc: { count: 1 } }, { upsert: true, returnDocument: 'after' }
  );
  const count = (r && (r.count ?? r.value?.count)) || 1;
  return { permitido: count <= limite, usadas: count, limite };
}

async function usoIAHoy() {
  const { db } = await getDB();
  const day = new Date().toISOString().slice(0, 10);
  const doc = await db.collection('iaUsage').findOne({ day });
  return { day, usadas: doc?.count || 0, limite: parseInt(process.env.EMAIL_IA_DAILY_LIMIT || 150) };
}

// ── Clasificar con Claude API ─────────────────────────────────────
async function clasificarEmail(de, asunto, cuerpo) {
  // 1) Publicidad obvia: gratis, sin IA
  if (esPublicidadObvia(de, asunto, cuerpo)) {
    return {
      categoria: 'PUBLICIDAD', urgencia: 'BAJA',
      resumen: `Publicidad/newsletter: ${String(asunto).slice(0, 70)}`,
      clienteDetectado: null, accionSugerida: 'Archivar — publicidad', confianza: 0.9
    };
  }
  // 2) Techo diario de gasto
  try {
    const cupo = await consumirCupoIA();
    if (!cupo.permitido) {
      return {
        categoria: 'OTRO', urgencia: 'BAJA',
        resumen: `Email sobre: ${String(asunto).slice(0, 80)}`,
        clienteDetectado: null, accionSugerida: 'Revisar manualmente',
        confianza: 0.1, iaError: `Límite diario de IA alcanzado (${cupo.limite})`
      };
    }
  } catch (e) { /* si falla el contador, seguimos */ }

  try {
    const cuerpoLimpio = cuerpo.slice(0, 800);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: process.env.EMAIL_IA_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 250,
        messages: [{
          role: 'user',
          content: `Clasifica este email de una empresa española de mantenimiento de fincas. Responde SOLO un JSON válido, sin markdown.

De: ${de}
Asunto: ${asunto}
Cuerpo: ${cuerpoLimpio}

Categorías: INCIDENCIA (avería/urgencia) | PRESUPUESTO | FACTURA_PROVEEDOR | PAGO_RECIBIDO | COMUNICACION (comunidad/administración) | PEDIDO_ALBARAN | PUBLICIDAD | SPAM | OTRO
Urgencia: ALTA (avería grave, agua, gas, plazo) | MEDIA | BAJA

{"categoria":"...","urgencia":"...","resumen":"frase corta en español (máx 100 chars)","clienteDetectado":"nombre o null","accionSugerida":"máx 80 chars","confianza":0.85}`
        }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`API ${response.status}: ${JSON.stringify(data).slice(0, 200)}`);
    }
    const texto = data.content?.[0]?.text || '{}';
    const limpio = texto.replace(/```json|```/g, '').trim();
    const result = JSON.parse(limpio);
    if (!result.categoria) throw new Error('La IA no devolvió categoría');

    // Validar campos obligatorios
    if (!result.resumen || result.resumen.length < 3) {
      result.resumen = `Email de ${de.split('@')[0]} sobre: ${asunto.slice(0, 60)}`;
    }
    if (!result.accionSugerida) {
      result.accionSugerida = result.categoria === 'PUBLICIDAD' ? 'Archivar — publicidad' : 'Revisar manualmente';
    }

    return result;
  } catch (err) {
    console.error('[Email] Error clasificando:', err.message);
    return {
      categoria: 'OTRO',
      urgencia: 'BAJA',
      resumen: `Email sobre: ${asunto.slice(0, 80)}`,
      clienteDetectado: null,
      accionSugerida: 'Revisar manualmente',
      confianza: 0.1,
      iaError: err.message
    };
  }
}

// ── Buscar remitente en StelOrder ─────────────────────────────────
async function buscarRemitenteEnStelOrder(emailDe) {
  const { email: emailLimpio, nombreMostrado } = parsearRemitente(emailDe);
  try {
    const base = 'https://app.stelorder.com/app';
    const headers = { 'APIKEY': process.env.STELORDER_API_KEY };

    // Buscar en clientes
    const rcli = await fetch(`${base}/clients?email=${encodeURIComponent(emailLimpio)}&limit=5`, { headers });
    const clientes = await rcli.json();
    if (Array.isArray(clientes) && clientes.length > 0) {
      const c = clientes[0];
      return {
        encontrado: true,
        tipo: 'cliente',
        id: c.id,
        nombre: c['legal-name'] || c.name,
        nombreMostrado,
        emailRemitente: emailLimpio,
        familia: c['account-category-id']
      };
    }

    // Buscar en contactos
    const rcon = await fetch(`${base}/contacts?email=${encodeURIComponent(emailLimpio)}&limit=5`, { headers });
    const contactos = await rcon.json();
    if (Array.isArray(contactos) && contactos.length > 0) {
      const c = contactos[0];
      return {
        encontrado: true,
        tipo: 'contacto',
        id: c['account-id'],
        nombre: c.name,
        nombreMostrado,
        emailRemitente: emailLimpio,
        familia: null
      };
    }

    return { encontrado: false, nombreMostrado, emailRemitente: emailLimpio };
  } catch (err) {
    console.error('[Email] Error buscando remitente:', err.message);
    return { encontrado: false, nombreMostrado, emailRemitente: emailLimpio };
  }
}

// ── Verificar permisos ────────────────────────────────────────────
function verificarPermisos(remitente, clasificacion) {
  if (!remitente.encontrado) {
    return { permitido: false, razon: 'Remitente desconocido en StelOrder' };
  }
  const bloqueadas = ['listar clientes', 'exportar', 'todos los clientes', 'listado global'];
  const resumenLower = (clasificacion.resumen || '').toLowerCase();
  if (bloqueadas.some(b => resumenLower.includes(b))) {
    return { permitido: false, razon: 'Solicitud de datos globales bloqueada' };
  }
  return { permitido: true, razon: 'Remitente verificado' };
}

// ── Procesar un email individual ──────────────────────────────────
async function procesarEmail(gmail, messageId) {
  const { db, client } = await getDB();
  try {
    const existe = await db.collection('emails').findOne({ gmailId: messageId });
    if (existe) return;

    const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
    const headers = msg.data.payload.headers;
    const de     = headers.find(h => h.name === 'From')?.value || '';
    const asunto = headers.find(h => h.name === 'Subject')?.value || '(sin asunto)';
    const fecha  = new Date(parseInt(msg.data.internalDate));
    const cuerpo = extractBody(msg.data.payload);
    const adjuntos = extractAttachments(msg.data.payload);

    console.log(`[Email] Procesando: ${asunto} de ${de}`);

    const clasificacion = await clasificarEmail(de, asunto, cuerpo);
    const remitente     = await buscarRemitenteEnStelOrder(de);
    const permisos      = verificarPermisos(remitente, clasificacion);

    await db.collection('emails').insertOne({
      gmailId: messageId,
      fecha,
      de,
      asunto,
      cuerpo: cuerpo.slice(0, 3000),
      adjuntos: adjuntos.map(a => ({ filename: a.filename, mimeType: a.mimeType, size: a.size })),
      tieneAdjuntos: adjuntos.length > 0,
      categoria:        clasificacion.categoria   || 'OTRO',
      urgencia:         clasificacion.urgencia    || 'BAJA',
      resumen:          clasificacion.resumen     || `Email de ${de} — ${asunto}`,
      accionSugerida:   clasificacion.accionSugerida || 'Revisar manualmente',
      clienteDetectado: clasificacion.clienteDetectado || null,
      confianza:        clasificacion.confianza   || 0,
      remitente,
      permisos,
      estado:          'PENDIENTE',
      accionRealizada:  null,
      stelOrderRef:     null,
      notas:           '',
      leido:           false,
      importante:      false,
      procesadoEn:     new Date()
    });

    console.log(`[Email] Guardado: ${clasificacion.categoria} — ${clasificacion.resumen}`);

    // Aprendizaje pasivo: si responde a un aviso (FAC/PDT en el asunto),
    // asociar remitente → comunidad. Nunca afecta al procesado del email.
    try { await require('./gestores').aprenderDeEmail(de, asunto); }
    catch (e) { console.warn('[Gestores] aprender:', e.message); }

    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { removeLabelIds: ['UNREAD'] }
    });

  } finally {
    await client.close();
  }
}

// ── Poll principal ────────────────────────────────────────────────
async function pollEmails() {
  console.log('[Email] Iniciando poll...');
  try {
    const gmail = getGmailClient();
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread newer_than:2d -from:me',
      maxResults: 20
    });
    const mensajes = res.data.messages || [];
    console.log(`[Email] ${mensajes.length} emails nuevos`);
    for (const msg of mensajes) {
      await procesarEmail(gmail, msg.id);
    }
    console.log('[Email] Poll completado');
  } catch (err) {
    console.error('[Email] Error en poll:', err.message);
  }
}

// ── Enviar respuesta por SMTP ─────────────────────────────────────
async function enviarRespuesta(emailDestino, asuntoOriginal, mensaje) {
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: parseInt(process.env.EMAIL_PORT || 587),
      secure: false,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });
    await transporter.sendMail({
      from: `Corp Projects <${process.env.EMAIL_FROM || process.env.EMAIL_USER}>`,
      to: emailDestino,
      subject: `Re: ${asuntoOriginal}`,
      text: mensaje,
      html: `<p style="font-family:sans-serif;color:#333">${mensaje.replace(/\n/g, '<br>')}</p>
             <hr style="border:1px solid #eee;margin:20px 0">
             <p style="font-size:12px;color:#999">Corp Projects Holding SL<br>hola@corpprojects.es</p>`
    });
    console.log(`[Email] Respuesta enviada a ${emailDestino}`);
    return true;
  } catch (err) {
    console.error('[Email] Error enviando respuesta:', err.message);
    return false;
  }
}

// ── Diagnóstico de la IA (para el botón del admin) ────────────────
async function diagnosticoIA() {
  const hasKey = !!process.env.ANTHROPIC_API_KEY;
  if (!hasKey) return { hasKey, ok: false, error: 'ANTHROPIC_API_KEY no está configurada en Railway → Variables' };
  let uso = null;
  try { uso = await usoIAHoy(); } catch (e) {}
  const r = await clasificarEmail(
    'comercial@empresa-prueba.com',
    'Consulta sobre presupuesto de reforma',
    'Buenos días, querría pedir presupuesto para reformar el portal de nuestra comunidad. Gracias.'
  );
  if (r.iaError) return { hasKey, ok: false, error: r.iaError, uso };
  return { hasKey, ok: true, resultado: r, uso, modelo: process.env.EMAIL_IA_MODEL || 'claude-haiku-4-5-20251001' };
}

// ── Reclasificar los emails que cayeron en el fallback (confianza <= 0.1) ──
async function reclasificarPendientes(limit = 150) {
  const { db } = await getDB();
  const malos = await db.collection('emails')
    .find({ confianza: { $lte: 0.1 } })
    .sort({ fecha: -1 }).limit(limit).toArray();
  let ok = 0, fallos = 0, primerError = null;
  for (const e of malos) {
    const c = await clasificarEmail(e.de || '', e.asunto || '', e.cuerpo || '');
    if (c.iaError) { fallos++; if (!primerError) primerError = c.iaError; continue; }
    await db.collection('emails').updateOne({ _id: e._id }, { $set: {
      categoria: c.categoria, urgencia: c.urgencia, resumen: c.resumen,
      accionSugerida: c.accionSugerida, clienteDetectado: c.clienteDetectado || null,
      confianza: c.confianza || 0.5, iaError: null, reclasificadoEn: new Date()
    }});
    ok++;
    await new Promise(r => setTimeout(r, 350));   // ritmo suave para la API
  }
  return { encontrados: malos.length, reclasificados: ok, fallos, primerError };
}

// Reenviar un adjunto al buzón OCR de StelOrder (consume tokens de OCR → solo manual).
// Envío por la API de Gmail (HTTPS): Railway bloquea el SMTP saliente.
async function reenviarAdjuntoOCR(gmailId, attachmentId, filename, mimeType, asuntoOriginal) {
  const destino = process.env.STEL_OCR_EMAIL || 'hola4@in.stelorder.com';
  const buf = await getAttachment(gmailId, attachmentId);
  const gmail = getGmailClient();

  const from = process.env.EMAIL_FROM || `Corp Projects <${process.env.EMAIL_USER || 'hola@corpprojects.es'}>`;
  const subjectEnc = `=?UTF-8?B?${Buffer.from(asuntoOriginal || filename).toString('base64')}?=`;
  const boundary = '=_cp_ocr_' + Date.now();

  // Base64 del adjunto en líneas de 76 caracteres (formato MIME estándar)
  const attB64 = buf.toString('base64').replace(/(.{76})/g, '$1\r\n');

  const mime = [
    `From: ${from}`,
    `To: ${destino}`,
    `Subject: ${subjectEnc}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(`Documento reenviado al OCR desde el dashboard: ${filename}`).toString('base64'),
    `--${boundary}`,
    `Content-Type: ${mimeType || 'application/octet-stream'}; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    attB64,
    `--${boundary}--`
  ].join('\r\n');

  const raw = Buffer.from(mime)
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  console.log(`[Email] Adjunto "${filename}" enviado al OCR (${destino}) vía API Gmail`);
  return { destino };
}

module.exports = { pollEmails, enviarRespuesta, getGmailClient, diagnosticoIA, reclasificarPendientes, usoIAHoy, listAttachments, getAttachment, reenviarAdjuntoOCR };
