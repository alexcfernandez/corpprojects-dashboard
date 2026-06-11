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

  // 3. text/html como fallback
  const html = buscarTexto(payload.parts, 'text/html');
  if (html) return limpiarCuerpo(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));

  return '';
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

// ── Clasificar con Claude API ─────────────────────────────────────
async function clasificarEmail(de, asunto, cuerpo) {
  try {
    const cuerpoLimpio = cuerpo.slice(0, 2000);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: `Eres el asistente de Corp Projects, empresa de administración de fincas y mantenimiento en España.
Analiza este email y responde ÚNICAMENTE con un objeto JSON válido, sin texto antes ni después, sin markdown.

De: ${de}
Asunto: ${asunto}
Cuerpo: ${cuerpoLimpio}

CATEGORÍAS disponibles:
- INCIDENCIA: avería, reparación, urgencia, problema técnico
- PRESUPUESTO: solicitud de presupuesto o precio
- FACTURA_PROVEEDOR: factura de un proveedor o suministrador
- PAGO_RECIBIDO: confirmación de pago o transferencia
- COMUNICACION: comunicación de comunidad de vecinos, administración
- PEDIDO_ALBARAN: pedido de material o albarán de entrega
- PUBLICIDAD: email comercial, newsletter, oferta, promoción, infojobs, marketing
- SPAM: spam, phishing, no solicitado
- OTRO: no encaja en ninguna categoría anterior

URGENCIA:
- ALTA: avería grave, urgencia, agua, gas, seguridad, plazo inminente
- MEDIA: solicitud normal con cierta prioridad
- BAJA: informativo, publicidad, newsletters, sin acción requerida

JSON a devolver (todos los campos obligatorios):
{
  "categoria": "una de las categorías de arriba",
  "urgencia": "ALTA|MEDIA|BAJA",
  "resumen": "frase corta en español explicando de qué trata el email (máx 100 chars)",
  "clienteDetectado": "nombre de empresa o persona mencionada, o null",
  "accionSugerida": "qué debe hacer el admin con este email (máx 80 chars)",
  "confianza": 0.85
}`
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
  const r = await clasificarEmail(
    'pruebas@ejemplo.com',
    'Oferta especial: 50% de descuento en herramientas',
    'Aproveche nuestra promoción de verano en taladros y amoladoras. Compre ahora.'
  );
  if (r.iaError) return { hasKey, ok: false, error: r.iaError };
  return { hasKey, ok: true, resultado: r };
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

module.exports = { pollEmails, enviarRespuesta, getGmailClient, diagnosticoIA, reclasificarPendientes };
