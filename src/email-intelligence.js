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
  oauth2Client.setCredentials({
    refresh_token: process.env.GMAIL_REFRESH_TOKEN
  });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// ── MongoDB ───────────────────────────────────────────────────────
async function getDB() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  return { db: client.db('corpprojects'), client };
}

// ── Decodificar base64 de Gmail ───────────────────────────────────
function decodeBase64(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

// ── Extraer texto del mensaje ─────────────────────────────────────
function extractBody(payload) {
  if (!payload) return '';
  if (payload.body?.data) return decodeBase64(payload.body.data);
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) return decodeBase64(part.body.data);
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return decodeBase64(part.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
    }
  }
  return '';
}

// ── Clasificar con Claude API ─────────────────────────────────────
async function clasificarEmail(de, asunto, cuerpo) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `Eres el asistente de Corp Projects, empresa de administración de fincas y mantenimiento. 
Analiza este email y responde SOLO con JSON válido, sin texto adicional.

Email de: ${de}
Asunto: ${asunto}
Cuerpo: ${cuerpo.slice(0, 1500)}

Responde con este JSON exacto:
{
  "categoria": "INCIDENCIA|PRESUPUESTO|FACTURA_PROVEEDOR|PAGO_RECIBIDO|COMUNICACION|PEDIDO_ALBARAN|OTRO",
  "urgencia": "ALTA|MEDIA|BAJA",
  "resumen": "máximo 100 caracteres explicando qué pide",
  "clienteDetectado": "nombre del cliente/empresa si se menciona, o null",
  "accionSugerida": "qué debería hacer el admin en máximo 80 caracteres",
  "confianza": 0.0
}`
        }]
      })
    });
    const data = await response.json();
    const texto = data.content?.[0]?.text || '{}';
    return JSON.parse(texto.replace(/```json|```/g, '').trim());
  } catch (err) {
    console.error('[Email] Error clasificando:', err.message);
    return {
      categoria: 'OTRO',
      urgencia: 'BAJA',
      resumen: 'No se pudo clasificar automáticamente',
      clienteDetectado: null,
      accionSugerida: 'Revisar manualmente',
      confianza: 0
    };
  }
}

// ── Buscar remitente en StelOrder ─────────────────────────────────
async function buscarRemitenteEnStelOrder(emailDe) {
  try {
    const emailLimpio = emailDe.match(/<(.+)>/)?.[1] || emailDe.trim();
    const base = 'https://app.stelorder.com/app';
    const key = process.env.STELORDER_API_KEY;
    const headers = { 'APIKEY': key };

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
        familia: c['account-category-id'],
        emailActual: c.email,
        emailRemitente: emailLimpio
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
        familia: null,
        emailActual: c.email,
        emailRemitente: emailLimpio
      };
    }

    return { encontrado: false, emailRemitente: emailLimpio };
  } catch (err) {
    console.error('[Email] Error buscando remitente:', err.message);
    return { encontrado: false, emailRemitente: emailDe };
  }
}

// ── Verificar permisos del remitente ──────────────────────────────
function verificarPermisos(remitente, clasificacion) {
  if (!remitente.encontrado) {
    return { permitido: false, razon: 'Remitente desconocido en StelOrder' };
  }

  // Acciones siempre bloqueadas
  const bloqueadas = ['listar clientes', 'exportar', 'todos los clientes', 'listado'];
  const resumenLower = (clasificacion.resumen || '').toLowerCase();
  if (bloqueadas.some(b => resumenLower.includes(b))) {
    return { permitido: false, razon: 'Solicitud de datos globales bloqueada por seguridad' };
  }

  return { permitido: true, razon: 'Remitente verificado' };
}

// ── Procesar un email ─────────────────────────────────────────────
async function procesarEmail(gmail, messageId) {
  const { db, client } = await getDB();
  try {
    // Evitar duplicados
    const existe = await db.collection('emails').findOne({ gmailId: messageId });
    if (existe) return;

    const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
    const headers = msg.data.payload.headers;
    const de      = headers.find(h => h.name === 'From')?.value || '';
    const asunto  = headers.find(h => h.name === 'Subject')?.value || '(sin asunto)';
    const fecha   = new Date(parseInt(msg.data.internalDate));
    const cuerpo  = extractBody(msg.data.payload);

    console.log(`[Email] Procesando: ${asunto} de ${de}`);

    // Clasificar con Claude
    const clasificacion = await clasificarEmail(de, asunto, cuerpo);

    // Buscar remitente en StelOrder
    const remitente = await buscarRemitenteEnStelOrder(de);

    // Verificar permisos
    const permisos = verificarPermisos(remitente, clasificacion);

    // Guardar en MongoDB
    await db.collection('emails').insertOne({
      gmailId: messageId,
      fecha,
      de,
      asunto,
      cuerpo: cuerpo.slice(0, 3000),
      categoria: clasificacion.categoria || 'OTRO',
      urgencia: clasificacion.urgencia || 'BAJA',
      resumen: clasificacion.resumen || '',
      accionSugerida: clasificacion.accionSugerida || '',
      clienteDetectado: clasificacion.clienteDetectado || null,
      confianza: clasificacion.confianza || 0,
      remitente,
      permisos,
      estado: 'PENDIENTE',
      accionRealizada: null,
      stelOrderRef: null,
      notas: '',
      leido: false,
      procesadoEn: new Date()
    });

    console.log(`[Email] Guardado: ${clasificacion.categoria} — ${clasificacion.resumen}`);

    // Marcar como leído en Gmail
    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { removeLabelIds: ['UNREAD'] }
    });

  } finally {
    await client.close();
  }
}

// ── Poll principal — llamado cada 15 min por scheduler ────────────
async function pollEmails() {
  console.log('[Email] Iniciando poll de emails...');
  try {
    const gmail = getGmailClient();

    // Buscar emails no leídos de los últimos 2 días
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread newer_than:2d -from:me',
      maxResults: 20
    });

    const mensajes = res.data.messages || [];
    console.log(`[Email] Encontrados ${mensajes.length} emails nuevos`);

    for (const msg of mensajes) {
      await procesarEmail(gmail, msg.id);
    }

    console.log('[Email] Poll completado');
  } catch (err) {
    console.error('[Email] Error en poll:', err.message);
  }
}

// ── Enviar respuesta automática al remitente ──────────────────────
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

module.exports = { pollEmails, enviarRespuesta, getGmailClient };
