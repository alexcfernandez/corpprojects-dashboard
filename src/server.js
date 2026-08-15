// src/server.js v3
require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt       = require('jsonwebtoken');
const axios     = require('axios');
const path      = require('path');
const multer    = require('multer');
const fs        = require('fs');
const { google } = require('googleapis');
const { MongoClient, ObjectId } = require('mongodb');

const {
  getSummary, getPendingInvoices, getInvoices, getClients,
  getEstimatesSummary, getFamiliesSummary, getAccountCategories, clearCache,
  sendInvoiceByEmail, findInvoiceIdByNumber, getInvoiceRaw, getEntityRawByRef,
  getWorkOrdersLive, diagProveedores, diagEscritura, diagCrearEnlace, diagLineaLibre, diagCaminoA, diagLineaImpuesto, diagImpuestos
} = require('./stelorder');
const { sendWhatsApp, sendEmail } = require('./notifications');
const { startScheduler, checkPendingInvoices, runDailySummary, sendReminders, sendManual, previewToEmail, sendWorkOrdersAlert } = require('./scheduler');
const calendarSync = require('./calendar');
const activity = require('./activity');
const { canonicalHostRedirect } = require('./canonical');

const app  = express();
const PORT = process.env.PORT || 3000;

// Seguridad: sin JWT_SECRET no arrancamos. Antes se firmaba con la palabra
// 'fallback' (pública), lo que permitiría falsificar tokens de admin.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[FATAL] Falta JWT_SECRET en las variables de entorno. Configúrala en Railway antes de arrancar.');
  process.exit(1);
}

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: ['https://dashboard.corpprojects.es','http://localhost:3000',
           'https://corpprojects-dashboard-production.up.railway.app']
}));
// Fuerza el dominio propio (solo si CANONICAL_HOST está definido). No toca
// /health, /api, /auth ni peticiones que no sean GET. Ver src/canonical.js.
app.use(canonicalHostRedirect);
app.use(express.json({ limit: '5mb' }));

const UPLOADS_DIR = path.join(__dirname, '../uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => cb(null, `bank_${Date.now()}.xlsx`)
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 15 }
});

// PDFs de amidaments (más grandes; en memoria)
const uploadPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 }
});

// Facturas subidas desde la app de oficina: fotos y/o PDFs (Obramat vienen grandes).
// En memoria (como partes/amidaments); varios archivos por envío.
const uploadFactura = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 15 }
});

// El service worker y los HTML NUNCA se cachean en el navegador: así las
// actualizaciones llegan siempre y un móvil no se queda pegado a una versión
// vieja (que era lo que servía nombres/datos en blanco).
app.use((req, res, next) => {
  if (req.path === '/sw.js' || req.path === '/' || req.path.endsWith('.html')) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});
app.use(express.static(path.join(__dirname, '../public')));

const limiter = rateLimit({ windowMs: 15*60*1000, max: 300, message: { error: 'Rate limit.' } });
app.use('/api/', limiter);
const loginLimiter = rateLimit({ windowMs: 15*60*1000, max: 60, message: { error: 'Demasiados intentos de acceso. Espera unos minutos y vuelve a probar.' } });

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Token inválido' }); }
}

// Acceso ligero para la oficina (subir-factura.html): acepta el token de
// trabajador (w_..., mismo login por PIN que parte.html) O el JWT de admin.
// Así la persona de oficina entra con su PIN sin darle un panel de admin.
async function requireAuthOficina(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  if (token.startsWith('w_')) {
    try {
      const w = await require('./partes').verifyWorkerToken(token);
      if (!w) return res.status(401).json({ error: 'Token expirado' });
      req.oficina = { workerId: w.workerId, workerName: w.workerName, role: w.workerRole || 'worker' };
      return next();
    } catch { return res.status(401).json({ error: 'Token inválido' }); }
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    const role = req.user.role || 'owner';           // JWT antiguo sin rol = Dueño
    req.oficina = { admin: role === 'owner' || role === 'oficina', role,
                    name: req.user.name || 'Dueño', uid: req.user.uid || null };
    return next();
  }
  catch { return res.status(401).json({ error: 'Token inválido' }); }
}

// ── Candado de DINERO para técnicos ─────────────────────────────────
// Presupuestos, catálogo (partidas) y facturas son SOLO oficina/admin.
// Los técnicos (rol 'tech') conservan partes, presencia, mediciones y
// activos, pero aquí quedan bloqueados. Admin (JWT) y oficina pasan; el
// auth final (requireAuthOficina) lo hace cada endpoint. Se registra
// ANTES que esas rutas para interceptarlas por prefijo de URL.
app.use(['/api/presupuestos', '/api/partidas', '/api/materiales', '/api/facturas'], async (req, res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (token.startsWith('w_')) {
    try {
      const w = await require('./partes').verifyWorkerToken(token);
      if (w && w.workerRole === 'tech') {
        return res.status(403).json({ error: 'Solo oficina: los técnicos no acceden a presupuestos, catálogo ni facturas' });
      }
    } catch { /* si falla la verificación, que decida el auth del endpoint */ }
    return next();
  }
  // JWT por cuenta: el Encargado hace presupuestos/catálogo pero NO facturas.
  try {
    const u = jwt.verify(token, JWT_SECRET);
    const role = u.role || 'owner';
    if ((req.originalUrl || '').startsWith('/api/facturas') && !users.can(role, 'facturas')) {
      return res.status(403).json({ error: 'Tu rol no tiene acceso a facturas' });
    }
  } catch { /* sin token/ inválido → lo resuelve el auth del endpoint */ }
  next();
});

// Identidad del que hace la petición, para el registro de actividad.
function actorDe(req) {
  if (req.oficina) return { name: req.oficina.name || req.oficina.workerName || 'Oficina', role: req.oficina.role || '' };
  if (req.user)    return { name: req.user.name || 'Dueño', role: req.user.role || 'owner' };
  return { name: 'Sistema', role: '' };
}

// ── BLINDAJE DE DATOS ECONÓMICOS ────────────────────────────────────
// Bloquea (403) todo lo que muestre dinero del negocio (facturación, cobros,
// tesorería, obras, importes) a quien no sea Dueño/Oficina. A nivel de
// SERVIDOR y por prefijo de URL: aunque el menú lo oculte, no se puede colar
// por la API. El Encargado y el Técnico caen aquí.
async function roleDeToken(token) {
  if (!token) return null;
  if (token.startsWith('w_')) {
    try { const w = await require('./partes').verifyWorkerToken(token); return w ? users.normalizeRole(w.workerRole || 'tecnico') : null; }
    catch { return null; }
  }
  try { const u = jwt.verify(token, JWT_SECRET); return users.normalizeRole(u.role || 'owner'); }
  catch { return null; }
}
// Oculta coste/margen (no el precio de venta) a quien no ve dinero: el
// Encargado hace presupuestos y ve el PRECIO que cobra, pero no lo que cuesta
// ni lo que se gana. Se quita en el SERVIDOR: no llega ni a su navegador.
function sinCosteLista(items) { return (items || []).map(p => { const { totalCoste, coste, margen, ...r } = p; return r; }); }
function sinCostePres(p) {
  const out = { ...p };
  if (Array.isArray(out.lineas)) out.lineas = out.lineas.map(l => { const { coste, ...r } = l; return r; });
  if (out.totales) { const { coste, margen, ...t } = out.totales; out.totales = t; }
  return out;
}
function sinCostePartidas(items) { return (items || []).map(p => { const { coste, costeManual, receta, ...r } = p; return r; }); }
const MONEY_PREFIXES = ['/api/summary','/api/inicio','/api/invoices','/api/estimates','/api/cobros','/api/pagos','/api/families','/api/comunidades','/api/obras'];
app.use(MONEY_PREFIXES, async (req, res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return next(); // sin token → que responda el auth del endpoint (401)
  const role = await roleDeToken(token);
  if (role && !users.canSeeMoney(role)) return res.status(403).json({ error: 'Tu rol no tiene acceso a datos económicos' });
  next();
});

// ─────────────────────────────────────────────────────────────
// WhatsApp (Twilio) — asistente personal. Ruta PÚBLICA (Twilio no envía token).
// Responde de forma ASÍNCRONA por la API de Twilio para no agotar el tiempo
// de espera del webhook (StelOrder + IA pueden tardar unos segundos).
// ─────────────────────────────────────────────────────────────
const asistente = require('./asistente');

// Fase 0 — Validación de firma de Twilio. Modo por env TWILIO_VALIDATE:
//   'off'     → no valida.
//   'log'     → valida y AVISA en logs si no cuadra, pero procesa igual (default; rollout seguro).
//   'enforce' → rechaza (403) las peticiones sin firma válida.
// La URL debe ser la pública que Twilio llamó: TWILIO_WEBHOOK_URL o reconstruida.
// URL PÚBLICA real que Twilio firmó (detrás del proxy SiteGround→Railway, http/https
// y el host pueden diferir). Orden: PUBLIC_WEBHOOK_URL > TWILIO_WEBHOOK_URL >
// reconstrucción con X-Forwarded-Proto/Host (fallback al host directo).
function urlWebhookTwilio(req) {
  if (process.env.PUBLIC_WEBHOOK_URL) return process.env.PUBLIC_WEBHOOK_URL;
  if (process.env.TWILIO_WEBHOOK_URL) return process.env.TWILIO_WEBHOOK_URL;
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const host  = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  return `${proto}://${host}${req.originalUrl}`;
}

let _firmaTwilioOkLogged = false; // para loguear el primer ✅ sin spamear
function validarFirmaTwilio(req) {
  const mode = String(process.env.TWILIO_VALIDATE || 'log').toLowerCase();
  if (mode === 'off' || !process.env.TWILIO_AUTH_TOKEN) return 'skip';
  try {
    const sig = req.get('X-Twilio-Signature') || '';
    const url = urlWebhookTwilio(req);
    const ok = require('twilio').validateRequest(process.env.TWILIO_AUTH_TOKEN, sig, url, req.body || {});
    if (ok) {
      if (!_firmaTwilioOkLogged) {
        console.log(`[WhatsApp] Firma Twilio ✅ válida (modo ${mode}). Ya se puede pasar a TWILIO_VALIDATE=enforce. url=${url}`);
        _firmaTwilioOkLogged = true;
      }
      return 'ok';
    }
    console.warn(`[WhatsApp] Firma Twilio NO válida (modo ${mode}). url=${url} sig=${sig ? 'presente' : 'ausente'}`);
    return mode === 'enforce' ? 'invalid-enforce' : 'invalid-log';
  } catch (e) { console.error('[WhatsApp] validarFirma:', e.message); return 'skip'; }
}

// Fase 0 — Dedup de reintentos de Twilio por MessageSid (índice único en webhookSeen).
async function webhookYaVisto(sid) {
  if (!sid) return false;
  try {
    const db = await require('./db').getDB();
    await db.collection('webhookSeen').insertOne({ sid, ts: new Date() });
    return false;
  } catch (e) {
    if (e && e.code === 11000) return true;          // ya procesado → duplicado
    console.error('[WhatsApp] dedup:', e.message); return false; // ante otro error, no bloquear
  }
}

app.post('/api/whatsapp', express.urlencoded({ extended: false }), async (req, res) => {
  // 0) Firma de Twilio. En 'enforce', rechaza lo no firmado; en 'log' solo avisa.
  if (validarFirmaTwilio(req) === 'invalid-enforce') return res.sendStatus(403);
  // 1) Acuse inmediato a Twilio (sin respuesta síncrona)
  res.type('text/xml').send('<Response></Response>');
  // 1.b) Dedup: si es un reintento del mismo mensaje, no lo procesamos dos veces.
  const sid = req.body.MessageSid || req.body.SmsMessageSid || req.body.SmsSid || '';
  if (await webhookYaVisto(sid)) { console.log('[WhatsApp] Reintento duplicado omitido:', sid); return; }
  // 2) Procesa en segundo plano y responde por la API de Twilio
  const from = req.body.From || '';
  const body = (req.body.Body || '').trim();
  const numMedia = parseInt(req.body.NumMedia || '0', 10) || 0;
  // Recoger TODOS los medios (audio + fotos): MediaUrl0..N / MediaContentType0..N
  const medios = [];
  for (let i = 0; i < numMedia; i++) {
    const url = req.body[`MediaUrl${i}`]; const type = req.body[`MediaContentType${i}`] || '';
    if (url) medios.push({ url, type });
  }
  const audioM = medios.find(m => /audio/i.test(m.type));
  const pdfM = medios.find(m => /pdf/i.test(m.type));
  const fotos = medios.filter(m => /image/i.test(m.type));
  console.log(`[WhatsApp] De ${from}: "${body}"${numMedia ? ` (+${numMedia} media: ${medios.map(m => m.type).join(',')})` : ''}`);
  procesarWhatsApp(from, body, { numMedia, mediaUrl: audioM ? audioM.url : (medios[0] && medios[0].url), mediaType: audioM ? audioM.type : (medios[0] && medios[0].type), fotos, pdf: pdfM })
    .catch(err => console.error('[WhatsApp] Error:', err.message));
});

// ─────────────────────────────────────────────────────────────
// Puente WhatsApp (Fase 8) — entrada normalizada desde el servicio Baileys.
// SEGURIDAD: autenticado SOLO por el secreto compartido BRIDGE_TOKEN (header
// X-Bridge-Token; comparación en tiempo constante; NUNCA se loguea el token).
// El campo `from` del payload decide la IDENTIDAD (owner/trabajador/cliente/…):
// es de confianza ÚNICAMENTE porque la petición está autenticada por el token.
// Quien tenga el token puede suplantar `from` → el TOKEN es la frontera de
// seguridad. Sin BRIDGE_TOKEN configurado, el endpoint responde 401 siempre.
// ─────────────────────────────────────────────────────────────
app.post('/api/bridge/inbound', express.json({ limit: '256kb' }), (req, res) => {
  if (!require('./canalWhatsapp').tokenBridgeValido(req.get('X-Bridge-Token'))) return res.sendStatus(401);
  res.sendStatus(200); // acuse inmediato; se procesa en segundo plano
  const p = req.body || {};
  const from = String(p.from || '').trim();  // SENSIBLE: decide identidad (ver nota de seguridad arriba).
  const body = String(p.body != null ? p.body : (p.text || '')).trim();
  if (!from) return;
  // Incremento 1: SOLO texto (media por el puente = incremento 2). canal:'bridge'
  // hace que la RESPUESTA salga por el puente (mismo canal de entrada).
  procesarWhatsApp(from, body, { numMedia: 0, canal: 'bridge', chatId: p.chatId, isGroup: !!p.isGroup })
    .catch(err => console.error('[Bridge] inbound:', err.message));
});

// SALIDA del puente (pull): el servicio Baileys sondea aquí y recibe un lote de
// mensajes pendientes, ya marcados 'sent' de forma atómica. Misma barrera: el
// token (X-Bridge-Token) es la ÚNICA autenticación; sin BRIDGE_TOKEN → 401.
app.get('/api/bridge/outbox', async (req, res) => {
  const canalWa = require('./canalWhatsapp');
  if (!canalWa.tokenBridgeValido(req.get('X-Bridge-Token'))) return res.sendStatus(401);
  try {
    res.json({ messages: await canalWa.reclamarLoteOutbox(Number(req.query.limit) || 10) });
  } catch (e) { console.error('[Bridge] outbox:', e.message); res.status(500).json({ error: e.message }); }
});

// Descarga una imagen de Twilio y la devuelve como {media_type, data(base64)}
async function descargarFoto(url, type) {
  try {
    const r = await axios.get(url, {
      responseType: 'arraybuffer',
      auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN },
      timeout: 20000
    });
    let mt = (type || 'image/jpeg').split(';')[0].trim();
    if (!/^image\/(jpeg|png|gif|webp)$/.test(mt)) mt = 'image/jpeg';
    return { media_type: mt, data: Buffer.from(r.data).toString('base64') };
  } catch (e) { console.error('[WhatsApp] descargarFoto:', e.message); return null; }
}

// Descarga genérica (p. ej. PDF) de Twilio y la devuelve como base64.
async function descargarArchivo(url) {
  try {
    const r = await axios.get(url, {
      responseType: 'arraybuffer',
      auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN },
      timeout: 30000
    });
    return Buffer.from(r.data).toString('base64');
  } catch (e) { console.error('[WhatsApp] descargarArchivo:', e.message); return null; }
}

// ── BUFFER DE FOTOS por usuario ──────────────────────────────────────────
// WhatsApp manda cada foto en un mensaje aparte, y la instrucción (texto/voz)
// llega en otro. Guardamos las fotos sueltas en una cola ligera (solo URL/tipo,
// no la imagen) y, cuando llega la instrucción, las recogemos como contexto.
const bufferFotos = new Map();           // from -> { fotos:[{url,type}], ts }
const FOTO_BUFFER_TTL = 15 * 60 * 1000;  // 15 min
const FOTO_BUFFER_MAX = 12;              // cuántas guardamos como máximo
const FOTO_IA_MAX = 12;                  // cuántas pasamos a la IA

function bufferGuardarFotos(from, fotos) {
  const ahora = Date.now();
  let entry = bufferFotos.get(from);
  const vacioAntes = !entry || (ahora - entry.ts) > FOTO_BUFFER_TTL || !entry.fotos.length;
  if (vacioAntes) entry = { fotos: [], ts: ahora };
  for (const f of fotos) if (f && f.url) entry.fotos.push({ url: f.url, type: f.type });
  if (entry.fotos.length > FOTO_BUFFER_MAX) entry.fotos = entry.fotos.slice(-FOTO_BUFFER_MAX);
  entry.ts = ahora;
  bufferFotos.set(from, entry);
  return vacioAntes; // true si era la primera (para el único acuse)
}

function bufferRecogerFotos(from) {
  const entry = bufferFotos.get(from);
  bufferFotos.delete(from);
  if (!entry || (Date.now() - entry.ts) > FOTO_BUFFER_TTL) return [];
  return entry.fotos || [];
}

async function procesarWhatsApp(from, body, media = {}) {
  // Canal por el que ENTRÓ el mensaje → se responde por el mismo (undefined = default env).
  const canal = media.canal;
  const responder = (msg) => enviarWhatsApp(from, msg, canal);

  // Webhook abierto SOLO al owner y a los 5 trabajadores autorizados (por número).
  // La capa de acceso decide luego el rol; aquí solo filtramos quién puede entrar.
  const acceso = require('./acceso');
  if (!(acceso.esOwner(from) || acceso.esTrabajador(from))) {
    return responder('🔒 Este asistente es privado.');
  }

  let texto = (body || '').trim();
  let prefijo = '';

  // ¿Nota de voz? (Twilio manda NumMedia + MediaUrl0 + MediaContentType0)
  if (!texto && (media.numMedia || 0) > 0 && /audio/i.test(media.mediaType || '')) {
    try {
      const hint = await asistente.vocabularioVoz().catch(() => '');
      const t = await transcribirAudio(media.mediaUrl, media.mediaType, hint);
      if (!t) return responder('🎙️ He recibido tu nota de voz, pero la transcripción aún no está configurada. Escríbeme el texto y te respondo igual.');
      texto = t;
      prefijo = `🎙️ _He entendido:_ “${t}”\n\n`;
    } catch (e) {
      console.error('[WhatsApp] STT error:', e.message);
      return responder('🎙️ No he conseguido entender el audio esta vez. ¿Me lo escribes o lo repites?');
    }
  }

  const fotosMsg = Array.isArray(media.fotos) ? media.fotos : [];

  // FACTURA por WhatsApp (Parte 2): "factura" + hay adjunto REAL (PDF/foto de este
  // mensaje o fotos mandadas antes) → reenviar al buzón que vigila n8n (→ StelOrder).
  // Va ANTES de los flujos de imagen. Exige adjunto para no pisar "dame la factura 309".
  {
    const facturaWA = require('./facturaWhatsApp');
    const bufEntry = bufferFotos.get(from);
    const hayBuffer = !!(bufEntry && (Date.now() - bufEntry.ts) <= FOTO_BUFFER_TTL && bufEntry.fotos.length);
    if (facturaWA.esReenvioFactura(texto) && (media.pdf || fotosMsg.length || hayBuffer)) {
      const fotosFactura = [...bufferRecogerFotos(from), ...fotosMsg];
      const r = await facturaWA.reenviarFactura({ from, pdf: media.pdf, fotos: fotosFactura, descargarArchivo, descargarFoto });
      return responder(prefijo + r.reply);
    }
  }

  // CASO PDF: llega un PDF -> importador de presupuesto (amidament del arquitecto)
  if (media.pdf && media.pdf.url) {
    const b64 = await descargarArchivo(media.pdf.url);
    if (!b64) return responder('📄 He recibido el PDF pero no he podido descargarlo. Inténtalo de nuevo.');
    await responder('📄 Leyendo el PDF, dame unos segundos…');
    const reply = await asistente.importarDocumento(from, b64, media.pdf.type || 'application/pdf', texto);
    return responder(prefijo + reply);
  }

  // CASO A: llegan SOLO fotos (sin instrucción) -> al buffer, sin procesar.
  // Acuse solo en la primera para no gastar mensajes ni spamear.
  if (!texto && fotosMsg.length) {
    const primera = bufferGuardarFotos(from, fotosMsg);
    if (primera) return responder('📸 Foto(s) recibida(s). Dime qué hago: *"factura"* (la subo a StelOrder) o *"hazme un presupuesto de esto para Illa Verda"*.');
    return; // siguientes fotos: silencio
  }

  // CASO B: hay instrucción -> juntar fotos del buffer + las de este mensaje
  let imagenes = [];
  const fotosTotales = [...bufferRecogerFotos(from), ...fotosMsg].slice(0, FOTO_IA_MAX);
  if (fotosTotales.length) {
    const descargas = await Promise.all(fotosTotales.map(f => descargarFoto(f.url, f.type)));
    imagenes = descargas.filter(Boolean);
  }

  if (!texto && !imagenes.length) return responder('Dime qué cliente o familia quieres consultar 🙂 (p. ej.: "¿qué debe Illa Verda?")');
  if (!texto && imagenes.length) texto = '(foto adjunta)';

  const reply = await asistente.responderConsulta(texto, from, imagenes);
  return responder(prefijo + reply);
}

// Transcribe una nota de voz de WhatsApp (descarga de Twilio + STT compatible OpenAI).
// Configurable por entorno: STT_API_KEY (obligatoria), STT_BASE_URL, STT_MODEL.
async function transcribirAudio(mediaUrl, contentType, hint) {
  const key = process.env.STT_API_KEY;
  if (!key || !mediaUrl) return null;
  const FormData = require('form-data');

  // 1) Descargar el audio de Twilio (autenticación básica SID:token)
  const audio = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN },
    timeout: 20000
  });
  const buf = Buffer.from(audio.data);

  // 2) Enviar a la API de transcripción (formato OpenAI: /audio/transcriptions)
  const base  = (process.env.STT_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = process.env.STT_MODEL || 'whisper-1';
  const ct = contentType || 'audio/ogg';
  const ext = /mpeg|mp3/.test(ct) ? 'mp3' : /wav/.test(ct) ? 'wav' : /mp4|m4a/.test(ct) ? 'm4a' : /webm/.test(ct) ? 'webm' : 'ogg';
  const form = new FormData();
  form.append('file', buf, { filename: `audio.${ext}`, contentType: ct });
  form.append('model', model);
  form.append('language', 'es');
  if (hint) form.append('prompt', String(hint).slice(0, 1200)); // pista de nombres propios reales

  const r = await axios.post(`${base}/audio/transcriptions`, form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${key}` },
    maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 30000
  });
  return ((r.data && r.data.text) || '').trim();
}

// Trocea un texto largo en partes <= max. Corta preferentemente por BLOQUES
// (párrafos separados por línea en blanco), de modo que una partida no se separe
// de su descripción. Si un bloque solo ya supera el máximo, lo trocea por líneas;
// y si una línea sola lo supera, la corta en duro. WhatsApp/Twilio limita a ~1600.
function trocearMensaje(texto, max = 1450) {
  const t = String(texto || '');
  if (t.length <= max) return [t];
  const partes = [];
  let buf = '';
  const empuja = () => { if (buf) { partes.push(buf); buf = ''; } };
  for (const bloque of t.split('\n\n')) {
    if (bloque.length > max) {
      // Bloque demasiado largo: vaciar buffer y trocear por líneas
      empuja();
      let sub = '';
      for (const linea of bloque.split('\n')) {
        if (linea.length > max) {
          if (sub) { partes.push(sub); sub = ''; }
          for (let i = 0; i < linea.length; i += max) partes.push(linea.slice(i, i + max));
        } else if (sub && (sub.length + 1 + linea.length) > max) { partes.push(sub); sub = linea; }
        else sub = sub ? sub + '\n' + linea : linea;
      }
      if (sub) partes.push(sub);
      continue;
    }
    if (buf && (buf.length + 2 + bloque.length) > max) { empuja(); buf = bloque; }
    else buf = buf ? buf + '\n\n' + bloque : bloque;
  }
  empuja();
  return partes;
}

// Envía por WhatsApp. Si el mensaje supera el límite de Twilio, lo trocea y
// manda las partes en orden (en vez de cortarlo a 1500 como antes).
// Trocea el mensaje largo y envía cada parte por el CANAL elegido (twilio|bridge).
// `canal` opcional: si no se pasa, usa CANAL_WHATSAPP (default 'twilio' → igual que hoy).
async function enviarWhatsApp(to, body, canal) {
  const canalWa = require('./canalWhatsapp');
  const partes = trocearMensaje(body, 1450);
  for (let i = 0; i < partes.length; i++) {
    const prefijo = partes.length > 1 ? `(${i + 1}/${partes.length}) ` : '';
    await canalWa.enviarUno(to, prefijo + partes[i], { canal });
  }
}

// Usa la conexión única compartida (src/db.js). Mantiene el contrato
// { db, client } para no romper las rutas existentes; client.close() es
// un no-op porque la conexión con pool se reutiliza, no se cierra.
const sharedDb = require('./db');
async function getDB() {
  return sharedDb.getDBLegacy();
}

// ===== OAUTH GMAIL =====
const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  process.env.GMAIL_REDIRECT_URI
);

app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify'
    ]
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    res.json(tokens);
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ── Públicas ──────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status:'ok', service:'Corp Projects Dashboard',
  timestamp: new Date().toISOString(), uptime: Math.round(process.uptime())+'s'
}));

app.post('/api/login', loginLimiter, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Contraseña requerida' });
  if (password !== process.env.DASHBOARD_PASSWORD)
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  // Contraseña compartida = acceso de Dueño (retrocompatible; convive con las
  // cuentas por persona hasta que se retire).
  const token = jwt.sign({ user:'admin', role:'owner', name:'Dueño' }, JWT_SECRET, { expiresIn:'24h' });
  res.json({ token, expiresIn:'24h', role:'owner', name:'Dueño' });
});

// Login por cuenta personal (email/usuario + contraseña) — Dueño/Oficina/
// Encargado. Los técnicos entran por PIN/enlace mágico (no por aquí).
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { login, password } = req.body || {};
    const id = await users.loginWithPassword(login, password);
    const token = jwt.sign({ uid: id.uid, name: id.name, role: id.role }, JWT_SECRET, { expiresIn:'24h' });
    activity.registrar({ actor: id.name, actorRole: id.role, kind: 'acceso', entidad: 'Acceso', detalle: 'Entró con su cuenta' });
    res.json({ token, expiresIn:'24h', name: id.name, role: id.role });
  } catch (err) { res.status(401).json({ error: err.message }); }
});

// ── StelOrder ─────────────────────────────────────────────────────
app.get('/api/summary',            requireAuth, async (req,res) => res.json(await getSummary()));

// INICIO: resumen visual del negocio (cifras + gráficas + qué requiere atención).
// Cada bloque va en su try/catch: si una fuente falla, las demás se muestran igual.
app.get('/api/inicio', requireAuth, async (req, res) => {
  const out = { lastUpdated: new Date().toISOString() };

  // 1) Facturación (mes, total, pendientes) — reutiliza getSummary
  try {
    const s = await getSummary();
    out.facturacion = {
      mes: s.totalBilledMonth, mesCount: s.totalInvoicesMonth,
      pendiente: s.totalPending, pendienteCount: s.pendingInvoices,
      criticas: s.criticalCount, avisos: s.overdueCount + s.warningCount,
      topPendientes: (s.pendingList || []).slice(0, 5).map(p => ({
        number: p.number, client: p.client, pending: p.pending, days: p.daysOverdue, alert: p.alertLevel
      }))
    };
  } catch (e) { out.facturacion = { error: e.message }; }

  // 2) Serie mensual (6 meses) para la gráfica de barras
  try {
    out.serieMensual = await require('./stelorder').getMonthlyBilling(6);
  } catch (e) {
    out.serieMensual = [];
    out.serieMensualError = e.message;
  }

  // 3) Pedidos de trabajo vivos por nivel de alerta
  try {
    const list = await getWorkOrdersLive();
    let rojo = 0, ambar = 0;
    for (const p of list) {
      const lvl = p.alertLevel || (require('./stelorder').getWorkOrderAlertLevel
        ? require('./stelorder').getWorkOrderAlertLevel(p) : null);
      if (lvl === 'red' || lvl === 'rojo') rojo++;
      else if (lvl === 'amber' || lvl === 'ambar') ambar++;
    }
    out.pedidos = { total: list.length, rojo, ambar };
  } catch (e) { out.pedidos = { total: 0, rojo: 0, ambar: 0, error: e.message }; }

  // 4) Partes por estado (pendientes de revisar / de facturar)
  try {
    const { db } = await getDB();
    const porRevisar = await db.collection('partes').countDocuments({ status: 'pendiente' });
    const porFacturar = await db.collection('partes').countDocuments({ status: 'verificado' });
    out.partes = { porRevisar, porFacturar };
  } catch (e) { out.partes = { porRevisar: 0, porFacturar: 0, error: e.message }; }

  // 5) Emails urgentes sin gestionar (excluye publicidad/spam)
  try {
    const { db } = await getDB();
    const urgentes = await db.collection('emails').countDocuments({
      estado: 'PENDIENTE', urgencia: 'ALTA', categoria: { $nin: ['PUBLICIDAD', 'SPAM'] }
    });
    const sinLeer = await db.collection('emails').countDocuments({
      leido: false, categoria: { $nin: ['PUBLICIDAD', 'SPAM'] }
    });
    out.emails = { urgentes, sinLeer };
  } catch (e) { out.emails = { urgentes: 0, sinLeer: 0, error: e.message }; }

  // 6) Presencia de hoy (quién ha fichado)
  try {
    const { db } = await getDB();
    const hoy = new Date().toISOString().slice(0, 10);
    const presentes = await db.collection('attendance').countDocuments({ date: hoy });
    out.presencia = { hoy: presentes };
  } catch (e) { out.presencia = { hoy: null }; }

  // 7) Planificación: lo de hoy y el conteo de esta semana
  try {
    const { getPlanning } = require('./planning');
    const now = new Date();
    const hoy = now.toISOString().slice(0, 10);
    // lunes..domingo de la semana actual
    const dow = (now.getDay() + 6) % 7;
    const lunes = new Date(now); lunes.setDate(now.getDate() - dow);
    const domingo = new Date(lunes); domingo.setDate(lunes.getDate() + 6);
    const fmt = d => d.toISOString().slice(0, 10);
    const semana = await getPlanning(fmt(lunes), fmt(domingo));
    out.planning = {
      hoy: semana.filter(p => p.date === hoy).map(p => ({
        workerName: p.workerName, color: p.color, client: p.client,
        tipo: p.tipo, horaInicio: p.horaInicio, workOrderNumber: p.workOrderNumber
      })),
      semanaTotal: semana.length
    };
  } catch (e) { out.planning = { hoy: [], semanaTotal: 0 }; }

  res.json(out);
});
app.get('/api/invoices/pending',   requireAuth, async (req,res) => res.json(await getPendingInvoices()));
app.get('/api/invoices',           requireAuth, async (req,res) => res.json(await getInvoices()));
app.get('/api/clients',            requireAuth, async (req,res) => { const {clients} = await getClients(); res.json(clients); });
app.get('/api/estimates',          requireAuth, async (req,res) => res.json(await getEstimatesSummary()));

// Presencia (Fase 3): lanzar el aviso a mano para probar sin esperar a las 17:30.
//   GET  /api/presencia/aviso?dry=1  → previsualiza a QUIÉN se avisaría (NO envía)
//   POST /api/presencia/aviso        → envía de verdad
app.all('/api/presencia/aviso', requireAuth, async (req, res) => {
  const dryRun = req.method === 'GET' || req.query.dry === '1' || req.query.dry === 'true';
  try { res.json(await require('./avisoPresencia').enviarAvisoPresencia({ dryRun })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/presupuesto/iva', requireAuth, async (req,res) => {
  try {
    const { id, iva } = req.body || {};
    if (!id || iva == null) return res.status(400).json({ error: 'Faltan id o iva' });
    const r = await require('./stelorder').cambiarIvaPresupuesto({ id, iva: Number(iva), requestedBy: (req.user && req.user.email) || 'dashboard' });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Fichas técnicas de comunidad ──
const _com = require('./comunidades');
app.get('/api/comunidades', requireAuth, async (req, res) => {
  try {
    const [todas, conFicha] = await Promise.all([_com.listComunidades(), _com.comunidadesConFicha()]);
    res.json({ todas, conFicha });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/comunidades/ficha', requireAuth, async (req, res) => {
  try {
    const target = req.query.comunidad; const scope = req.query.scope || 'cliente';
    if (!target) return res.status(400).json({ error: 'falta comunidad' });
    const notas = await _com.getNotas(target, scope);
    res.json({ comunidad: target, cats: _com.CAT_COM, orden: _com.CAT_ORDER, notas });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/comunidades/nota', requireAuth, async (req, res) => {
  try {
    const { comunidad, scope, texto } = req.body || {};
    if (!comunidad || !texto) return res.status(400).json({ error: 'faltan datos' });
    const r = await _com.addNota(comunidad, scope || 'cliente', texto);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/comunidades/nota/borrar', requireAuth, async (req, res) => {
  try {
    const { comunidad, scope, idx } = req.body || {};
    if (!comunidad || !idx) return res.status(400).json({ error: 'faltan datos' });
    const r = await _com.borrarNota(comunidad, scope || 'cliente', parseInt(idx, 10));
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
const _cobros = require('./avisos-proactivo');
app.get('/api/cobros', requireAuth, async (req, res) => {
  try {
    const data = await _cobros.construirCobros();
    const gestion = await _cobros.getGestion();
    res.json({ rojo: data.rojo, naranja: data.naranja, amarillo: data.amarillo, totalTodo: data.totalTodo, gestion });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/cobros/gestion', requireAuth, async (req, res) => {
  try {
    const { tipo, valor, clave, motivo, activar } = req.body || {};
    if (!tipo || (!valor && !clave)) return res.status(400).json({ error: 'faltan datos' });
    let ok;
    if (activar) ok = await _cobros.marcarGestion(tipo, valor, clave, motivo);
    else         ok = await _cobros.desmarcarGestion(tipo, clave || _cobros.normTxt(valor));
    res.json({ ok: !!ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/families',           requireAuth, async (req,res) => res.json(await getFamiliesSummary()));
app.get('/api/families/list',      requireAuth, async (req,res) => { const {list} = await getAccountCategories(); res.json(list); });

// Vaciar la caché de StelOrder bajo demanda (botón "Actualizar" del dashboard)
app.post('/api/stelorder/refresh', requireAuth, (req,res) => { clearCache(); res.json({ ok:true, message:'Datos actualizados desde StelOrder' }); });
app.get('/api/diag-proveedores',   requireAuth, async (req,res) => res.json(await diagProveedores()));
app.get('/api/diag/stel-write',     requireAuth, async (req,res) => {
  try { res.json(await diagEscritura({ probePost: req.query.probe === '1' || req.query.probe === 'true' })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/diag/stel-enlace',    requireAuth, async (req,res) => {
  try { res.json(await diagCrearEnlace({ accId: req.query.acc || null, go: req.query.go === '1' || req.query.go === 'true' })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/diag/stel-linea',     requireAuth, async (req,res) => {
  try { res.json(await diagLineaLibre({ accId: req.query.acc || null, go: req.query.go === '1' || req.query.go === 'true' })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/diag/stel-caminoa',   requireAuth, async (req,res) => {
  try { res.json(await diagCaminoA({ accId: req.query.acc || null, go: req.query.go === '1' || req.query.go === 'true' })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/diag/stel-iva',       requireAuth, async (req,res) => {
  try { res.json(await diagLineaImpuesto()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/diag/stel-impuestos', requireAuth, async (req,res) => {
  try { res.json(await diagImpuestos()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/diag/stel-cliente-campos', requireAuth, async (req,res) => {
  try { res.json(await require('./stelorder').diagClienteCampos()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/diag/stel-crear-cliente', requireAuth, async (req,res) => {
  try { res.json(await require('./stelorder').diagCrearCliente({ categoria: req.query.categoria, crear: req.query.crear })); }
  catch (e) { res.status(500).json({ error: e.message, data: e.response && e.response.data }); }
});
app.get('/api/diag/stel-multiseccion', requireAuth, async (req,res) => {
  let accId = req.query.accId;
  try {
    const stel = require('./stelorder');
    if (!accId && req.query.cliente) accId = await stel.accountIdByName(req.query.cliente);
    if (!accId) return res.status(400).json({ error: 'Pasa ?accId=NNN (de un CLIENTE, no de una familia) o ?cliente=Nombre' });
    res.json(await stel.crearPresupuestoMultiSeccionPrueba(accId));
  } catch (e) { res.status(500).json({ error: e.message, accIdUsado: accId || null, stelOrder: e.response?.data || null }); }
});
app.get('/api/diag/stel-presu-lineas', requireAuth, async (req,res) => {
  try { res.json(await require('./stelorder').diagPresupuestoConLineas({ ref: req.query.ref || null, id: req.query.id || null })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/diag/stel-cambiar-iva', requireAuth, async (req,res) => {
  try { res.json(await require('./stelorder').diagCambiarIvaPrueba({ id: req.query.id || null, iva: req.query.iva || 21, go: req.query.go === '1' || req.query.go === 'true' })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Importador de amidaments (PDF del arquitecto -> presupuesto en StelOrder) ──
// 1) Analizar el PDF y devolver la estructura (capítulos/subcapítulos/partidas)
app.post('/api/amidaments/preview', requireAuth, uploadPdf.single('pdf'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'Falta el archivo (campo "pdf").' });
    const nombre = (req.file.originalname || '').toLowerCase();
    const esExcel = /\.(xlsx|xls)$/.test(nombre) || /spreadsheet|ms-excel/.test(req.file.mimetype || '');
    let est;
    if (esExcel) {
      const XLSX = require('xlsx');
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      let texto = '';
      wb.SheetNames.forEach(sn => {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, blankrows: false, defval: '' });
        if (!rows.length) return;
        texto += `\n### ${sn}\n` + rows.map(r => r.map(c => (c == null ? '' : String(c))).join(' | ')).join('\n');
      });
      est = await asistente.estructurarAmidamentTexto(texto);
    } else {
      const base64 = req.file.buffer.toString('base64');
      est = await asistente.estructurarAmidamentPdf(base64, req.file.mimetype);
    }
    if (!est || !Array.isArray(est.capitulos) || !est.capitulos.length) {
      return res.status(422).json({ error: 'No pude extraer partidas. ¿Es un estado de mediciones con tablas (PDF o Excel)?' });
    }
    // Conteo para el resumen
    let nPart = 0, nSub = 0;
    for (const c of est.capitulos) {
      nPart += (c.partidas || []).length;
      for (const s of (c.subcapitulos || [])) { nSub++; nPart += (s.partidas || []).length; }
    }
    res.json({ ok: true, estructura: est, resumen: { capitulos: est.capitulos.length, subcapitulos: nSub, partidas: nPart } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2) Crear el presupuesto en StelOrder a partir de la estructura confirmada
app.post('/api/amidaments/crear', requireAuth, async (req, res) => {
  try {
    const stel = require('./stelorder');
    const { estructura, titulo, cliente, accId: accIdRaw, iva, observaciones } = req.body || {};
    if (!estructura || !Array.isArray(estructura.capitulos) || !estructura.capitulos.length) {
      return res.status(400).json({ error: 'Falta la estructura (capítulos).' });
    }
    let accId = accIdRaw;
    const nombreCli = cliente || estructura.cliente;
    if (!accId && nombreCli) accId = await stel.accountIdByName(nombreCli);
    if (!accId) return res.status(400).json({ error: `No encuentro el cliente "${nombreCli || ''}" en StelOrder. Revísalo.` });
    const r = await stel.crearPresupuestoStel({
      accId,
      titulo: titulo || estructura.titulo || 'Presupuesto importado',
      observaciones: observaciones || null,
      estructura: estructura.capitulos,
      iva: iva != null ? Number(iva) : 21,
      requestedBy: 'amidaments-import'
    });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Familias (categorías de cliente) para el selector del alta
app.get('/api/familias', requireAuth, async (req, res) => {
  try { const { list } = await require('./stelorder').getAccountCategories(); res.json((list || []).map(c => ({ id: c.id, name: c.name }))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Alta de cliente nuevo en StelOrder
app.post('/api/clientes/crear', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.nombre || !String(b.nombre).trim()) return res.status(400).json({ error: 'Falta el nombre del cliente.' });
    res.json(await require('./stelorder').crearClienteStel(b));
  } catch (e) { res.status(500).json({ error: e.message, data: e.response && e.response.data }); }
});

// ── Presupuesto de competencia (PDF/foto CON precio -> presupuesto con tu precio) ──
// 1) Analizar y devolver partidas con precio e IVA
app.post('/api/presupuesto/preview', requireAuth, uploadPdf.single('pdf'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'Falta el archivo (campo "pdf").' });
    const base64 = req.file.buffer.toString('base64');
    const datos = await asistente.estructurarPresupuestoPdf(base64, req.file.mimetype);
    if (!datos || !Array.isArray(datos.partidas) || !datos.partidas.length) {
      return res.status(422).json({ error: 'No pude extraer partidas con precio. ¿Es un presupuesto con importes?' });
    }
    const baseTotal = datos.partidas.reduce((s, p) => s + (Number(p.precio) || 0) * (Number(p.cantidad) || 1), 0);
    res.json({ ok: true, datos, baseTotal });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2b) Reescribir las descripciones en estilo propio (idioma elegible)
app.post('/api/presupuesto/reescribir', requireAuth, async (req, res) => {
  try {
    const { partidas, idioma } = req.body || {};
    if (!Array.isArray(partidas) || !partidas.length) return res.status(400).json({ error: 'Faltan partidas.' });
    const out = await asistente.reescribirPartidas(partidas, idioma === 'ca' ? 'ca' : 'es');
    if (!out || !out.length) return res.status(422).json({ error: 'No pude reescribir el texto. Inténtalo otra vez.' });
    res.json({ ok: true, partidas: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2) Crear en StelOrder (partidas planas, con el precio ya ajustado por el usuario)
app.post('/api/presupuesto/crear', requireAuth, async (req, res) => {
  try {
    const stel = require('./stelorder');
    const { partidas, titulo, cliente, accId: accIdRaw, iva, observaciones } = req.body || {};
    if (!Array.isArray(partidas) || !partidas.length) return res.status(400).json({ error: 'Faltan las partidas.' });
    let accId = accIdRaw;
    if (!accId && cliente) accId = await stel.accountIdByName(cliente);
    if (!accId) return res.status(400).json({ error: `No encuentro el cliente "${cliente || ''}" en StelOrder. Revísalo.` });
    const r = await stel.crearPresupuestoStel({
      accId,
      titulo: titulo || 'Presupuesto',
      observaciones: observaciones || null,
      partidas,
      iva: iva != null ? Number(iva) : 21,
      requestedBy: 'presupuesto-competencia'
    });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Responsables por familia (a quién van los avisos de cada familia) ──
const avisos = require('./avisos');

app.get('/api/family-contacts', requireAuth, async (req, res) => {
  try {
    const { list } = await getAccountCategories();
    const map = await avisos.getFamilyContactMap();
    const names = (list || []).map(f => f.name).filter(Boolean);
    if (!names.includes('Sin familia')) names.push('Sin familia');
    res.json(names.map(name => {
      const c = map[name] || {};
      return {
        family: name,
        email:  c.email || '',
        paused: !!c.paused,
        freq:   c.freq   || 'manual',
        format: c.format || 'grouped'
      };
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/family-contacts', requireAuth, async (req, res) => {
  try {
    const { family, email, paused, freq, format, modo } = req.body;
    if (!family) return res.status(400).json({ error: 'Falta la familia' });
    const saved = await avisos.setFamilyContact(family, { email, paused, freq, format, modo });
    res.json(saved);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Pausa global de avisos (interruptor de emergencia)
app.get('/api/avisos-status', requireAuth, async (req, res) => {
  try { res.json({ globalPaused: await avisos.isGlobalPaused() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/avisos-status', requireAuth, async (req, res) => {
  try { res.json({ globalPaused: await avisos.setGlobalPaused(!!req.body.paused) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Enviar la factura OFICIAL por StelOrder (sendDocument). Prueba controlada.
// Acepta { number, email } o { invoiceId, email }.
app.post('/api/invoice/send-official', requireAuth, async (req, res) => {
  try {
    const { number, invoiceId, email } = req.body;
    if (!email) return res.status(400).json({ error: 'Falta el email de destino' });
    let id = invoiceId;
    if (!id && number) id = await findInvoiceIdByNumber(number);
    if (!id) return res.status(404).json({ error: `No se encontró la factura ${number || ''}`.trim() });
    const r = await sendInvoiceByEmail(id, email);
    res.json({ message: `✓ StelOrder envió la factura (ID ${id}) a ${email}`, ...r });
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    res.status(500).json({ error: `StelOrder respondió ${status || ''}: ${detail}`.trim() });
  }
});

// DEBUG genérico: vuelca factura/incidencia/pedido por su referencia (FAC/INC/PDT).
app.post('/api/debug/raw', requireAuth, async (req, res) => {
  try {
    const { ref } = req.body;
    if (!ref) return res.status(400).json({ error: 'Falta la referencia (FAC.../INC.../PDT...)' });
    const data = await getEntityRawByRef(ref);
    res.json({ ref, data });
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    res.status(500).json({ error: `${err.message || ''} ${status ? '(StelOrder '+status+')' : ''}`.trim() });
  }
});

// PEDIDOS DE TRABAJO vivos (Pendiente / En curso) con días y nivel de alerta.
app.get('/api/workorders/live', requireAuth, async (req, res) => {
  try {
    const list = await getWorkOrdersLive();
    await require('./asignaciones').attachAssignments(list);
    res.json({ list, count: list.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Usuarios asignables (activos) para el desplegable de asignación.
app.get('/api/workorders/assignable-users', requireAuth, async (req, res) => {
  try {
    const { getUsers } = require('./users');
    const all = await getUsers(false); // solo activos
    res.json({ users: all.map(u => ({ id: String(u._id), name: u.name, role: u.role, color: u.color || '#6b7280' })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Asignar / desasignar un pedido a un trabajador (userId vacío = desasignar).
app.put('/api/workorders/assign', requireAuth, async (req, res) => {
  try {
    const { workOrderId, userId, priority } = req.body;
    const r = await require('./asignaciones').setAssignment(workOrderId, userId || null, req.user?.username || null, priority);
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Validar sesión de trabajador guardada (para no pedir PIN cada vez).
app.get('/api/partes/worker-session', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Sin sesión' });
    const { verifyWorkerToken } = require('./partes');
    const w = await verifyWorkerToken(token);
    if (!w) return res.status(401).json({ error: 'Sesión caducada' });
    res.json({ workerId: w.workerId, workerName: w.workerName });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Interruptor de escritura en StelOrder (Fase 4).
app.get('/api/workorders/stelwrite', requireAuth, async (req, res) => {
  try { res.json({ enabled: await avisos.isStelWriteEnabled() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/workorders/stelwrite', requireAuth, async (req, res) => {
  try { res.json({ enabled: await avisos.setStelWriteEnabled(!!req.body.enabled) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// FASE 4 (prueba controlada): cambiar el estado de UN pedido en StelOrder.
// Lee→backup→escribe→relee→compara. Devuelve el informe de verificación.
app.post('/api/workorders/:id/stel-state', requireAuth, async (req, res) => {
  try {
    const { stateId } = req.body;
    if (!stateId) return res.status(400).json({ error: 'Falta stateId' });
    const { setWorkOrderState } = require('./stelorder');
    const r = await setWorkOrderState(req.params.id, stateId, req.user?.username || 'admin');
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// MIS PEDIDOS (para el trabajador en parte.html, con su token w_).
app.get('/api/workorders/mine', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No autorizado' });
    const { verifyWorkerToken } = require('./partes');
    const workerDoc = await verifyWorkerToken(token);
    if (!workerDoc) return res.status(401).json({ error: 'Token expirado' });

    const asig = require('./asignaciones');
    const list = await getWorkOrdersLive();
    await asig.attachAssignments(list);
    const mine = list.filter(p => String(p.assignedUserId || '') === String(workerDoc.workerId) && p.workStatus !== 'done' && p.workStatus !== 'invoiced');
    // Adjuntar la sesión abierta (cronómetro) de cada pedido, si la hay
    const open = await asig.getOpenTimers(workerDoc.workerId);
    mine.forEach(p => { p.activeStartedAt = open[String(p.id)] || null; });
    res.json({ list: mine, count: mine.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// INICIAR trabajo en un pedido (trabajador). Guarda hora de inicio en servidor.
app.post('/api/workorders/:id/start', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No autorizado' });
    const { verifyWorkerToken } = require('./partes');
    const workerDoc = await verifyWorkerToken(token);
    if (!workerDoc) return res.status(401).json({ error: 'Token expirado' });
    const r = await require('./asignaciones').startWork(req.params.id, workerDoc.workerId, workerDoc.workerName);

    // Fase 4: reflejar "En curso" en StelOrder (si el interruptor está activo y es un inicio nuevo)
    if (!r.alreadyRunning) {
      try {
        if (await require('./avisos').isStelWriteEnabled()) {
          await require('./stelorder').setWorkOrderStateLight(req.params.id, 1120645, `start:${workerDoc.workerName || workerDoc.workerId}`);
        }
      } catch (e) { console.warn('[Fase4] start→En curso:', e.message); }
    }
    res.json(r);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// FINALIZAR trabajo en un pedido (trabajador). Devuelve la duración real.
app.post('/api/workorders/:id/finish', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No autorizado' });
    const { verifyWorkerToken } = require('./partes');
    const workerDoc = await verifyWorkerToken(token);
    if (!workerDoc) return res.status(401).json({ error: 'Token expirado' });
    const r = await require('./asignaciones').finishWork(req.params.id, workerDoc.workerId);
    res.json(r);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Normaliza un teléfono a E.164 (+34 si es un móvil español de 9 dígitos).
function normalizarTelE164(t) {
  let s = String(t || '').replace(/[\s().-]/g, '');
  if (!s) return s;
  if (s.startsWith('+')) return s;
  if (s.startsWith('00')) return '+' + s.slice(2);
  if (/^\d{9}$/.test(s)) return '+34' + s;
  return s;
}

// ── FICHAJE (registro de jornada del trabajador) ──
async function _worker(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) { res.status(401).json({ error: 'No autorizado' }); return null; }
  const w = await require('./partes').verifyWorkerToken(token);
  if (!w) { res.status(401).json({ error: 'Token expirado' }); return null; }
  return w;
}
app.get('/api/fichaje/estado', async (req, res) => {
  try { const w = await _worker(req, res); if (!w) return;
    res.json(await require('./fichajes').estadoActual(w.workerId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/fichaje/fichar', async (req, res) => {
  try { const w = await _worker(req, res); if (!w) return;
    // Sin consentimiento GPS firmado NO se guarda la ubicación (RGPD).
    const consentido = await users.userHasGpsConsent(w.workerId);
    const loc = consentido ? (req.body || {}).loc : null;
    res.json(await require('./fichajes').fichar(w.workerId, w.workerName, loc)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Consentimiento GPS del trabajador (leer estado / firmar).
app.get('/api/fichaje/consent', async (req, res) => {
  try { const w = await _worker(req, res); if (!w) return;
    res.json({ consentido: await users.userHasGpsConsent(w.workerId), version: users.GPS_CONSENT_VERSION }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/fichaje/consent', async (req, res) => {
  try { const w = await _worker(req, res); if (!w) return;
    await users.setGpsConsent(w.workerId, { signature: (req.body || {}).signature });
    res.json({ ok: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Obras ACTIVAS para el operario (elegir en el parte). Mínimo: sin importes.
app.get('/api/campo/obras', async (req, res) => {
  try { const w = await _worker(req, res); if (!w) return;
    const obras = await require('./obras').getObras({ status: 'activa' });
    res.json(obras.map(o => ({ id: String(o._id), reference: o.reference, clientName: o.clientName, address: o.address || '' })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/fichaje/mios', async (req, res) => {
  try { const w = await _worker(req, res); if (!w) return;
    res.json(await require('./fichajes').getFichajesTrabajador(w.workerId, req.query.from, req.query.to)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/fichaje/dia', requireAuth, async (req, res) => {
  try { res.json(await require('./fichajes').getFichajesDia(req.query.fecha)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── MAPA GPS ── puntos del día = sellos de los partes + entradas/salidas de
// fichaje que tengan ubicación. Datos sensibles (control de personal): solo
// Dueño/Oficina.
app.get('/api/gps/dia', requireAuth, async (req, res) => {
  const role = users.normalizeRole(req.user?.role || 'owner');
  if (role !== 'owner' && role !== 'oficina') return res.status(403).json({ error: 'Sin acceso al mapa GPS' });
  try {
    const fecha = req.query.fecha || new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
    const puntos = [];
    const workers = {};
    const addW = (id, name) => { if (id) workers[String(id)] = name || workers[String(id)] || ''; };

    // Partes con GPS de ese día
    const { partes } = await require('./partes').getPartes({ from: fecha, to: fecha, limit: 500 });
    for (const p of (partes || [])) {
      if (Number.isFinite(Number(p.gpsLat)) && Number.isFinite(Number(p.gpsLng))) {
        addW(p.workerId, p.workerName);
        puntos.push({ tipo: 'parte', lat: Number(p.gpsLat), lng: Number(p.gpsLng), acc: p.gpsAccuracy || null,
          hora: (p._meta && p._meta.submittedAt) || p.updatedAt || null,
          quienId: String(p.workerId || ''), quien: p.workerName || '', etiqueta: p.clientName || (p.description || '').slice(0, 40) });
      }
    }
    // Fichajes con GPS de ese día (entrada/salida de cada tramo)
    const fichs = await require('./fichajes').getFichajesDia(fecha);
    for (const f of (fichs || [])) {
      addW(f.userId, f.userName);
      for (const t of (f.tramos || [])) {
        if (t.entradaLoc) puntos.push({ tipo: 'entrada', lat: t.entradaLoc.lat, lng: t.entradaLoc.lng, acc: t.entradaLoc.acc || null,
          hora: t.entrada || null, quienId: String(f.userId || ''), quien: f.userName || '', etiqueta: 'Fichó entrada' });
        if (t.salidaLoc)  puntos.push({ tipo: 'salida',  lat: t.salidaLoc.lat,  lng: t.salidaLoc.lng,  acc: t.salidaLoc.acc || null,
          hora: t.salida || null,  quienId: String(f.userId || ''), quien: f.userName || '', etiqueta: 'Fichó salida' });
      }
    }
    res.json({ fecha, puntos, workers: Object.entries(workers).map(([id, name]) => ({ id, name })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// Enlace mágico: canjea el token del trabajador por una sesión (sin PIN).
app.post('/api/fichaje/magic-login', async (req, res) => {
  try {
    const u = await users.getUserByMagicToken((req.body || {}).token);
    if (!u) return res.status(401).json({ error: 'Enlace no válido o caducado' });
    const crypto = require('crypto');
    const wtoken = 'w_' + crypto.randomBytes(16).toString('hex');
    const db = await require('./db').getDB();
    await db.collection('worker_tokens').insertOne({
      token: wtoken, workerId: String(u._id), workerName: u.name, workerRole: u.role,
      createdAt: new Date(), expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
    });
    const primeraVez = !u.lastLogin;
    await db.collection('users').updateOne({ _id: u._id }, { $set: { lastLogin: new Date() } });
    res.json({ token: wtoken, workerId: String(u._id), workerName: u.name, role: u.role, primeraVez });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Estado de pausa de los avisos de pedidos.
app.get('/api/workorders/alert-status', requireAuth, async (req, res) => {
  try { res.json({ paused: await avisos.isPedidosPaused() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Cambiar pausa de los avisos de pedidos.
app.put('/api/workorders/alert-status', requireAuth, async (req, res) => {
  try { res.json({ paused: await avisos.setPedidosPaused(!!req.body.paused) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Enviar AHORA el resumen de pedidos (ignora la pausa). Opcional { email }.
app.post('/api/workorders/send-now', requireAuth, async (req, res) => {
  try {
    const r = await sendWorkOrdersAlert({ force: true, to: req.body.email || null });
    if (r.error) throw new Error(r.error);
    if (!r.count) return res.json({ message: 'No hay pedidos en rojo/ámbar ahora mismo.' });
    res.json({ message: `✓ Aviso enviado a ${r.to} (${r.count} pedidos)`, ...r });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// DEBUG: volcar el objeto crudo de una factura por su número.
app.post('/api/invoice/raw', requireAuth, async (req, res) => {
  try {
    const { number, invoiceId } = req.body;
    let id = invoiceId;
    if (!id && number) id = await findInvoiceIdByNumber(number);
    if (!id) return res.status(404).json({ error: `No se encontró la factura ${number || ''}`.trim() });
    const data = await getInvoiceRaw(id);
    res.json({ id, data });
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    res.status(500).json({ error: `StelOrder respondió ${status || ''}: ${detail}`.trim() });
  }
});

// Enviar AHORA un resumen agrupado a cada familia con responsable
app.post('/api/send-family-summaries', requireAuth, async (req, res) => {
  try {
    const r = await sendManual('grouped');
    const message = r.paused
      ? '⏸ Envíos en pausa global — no se ha enviado nada.'
      : `Resúmenes enviados: ${r.sent} · omitidos: ${r.skipped}`;
    res.json({ message, ...r });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Enviar AHORA las facturas una a una (individual) a cada familia con responsable
app.post('/api/send-family-individual', requireAuth, async (req, res) => {
  try {
    const r = await sendManual('individual');
    const message = r.paused
      ? '⏸ Envíos en pausa global — no se ha enviado nada.'
      : `Familias avisadas (individual): ${r.sent} · omitidas: ${r.skipped}`;
    res.json({ message, ...r });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Previsualizar el resumen agrupado: se envía SOLO al email indicado, ignora pausa.
app.post('/api/avisos/preview', requireAuth, async (req, res) => {
  try {
    const { email, family } = req.body;
    if (!email) return res.status(400).json({ error: 'Falta el email' });
    const r = await previewToEmail(email, family);
    res.json({ message: `✓ Previsualización (${r.family}, ${r.count} fra.) enviada a ${r.to}`, ...r });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/invoices/by-family/:family', requireAuth, async (req, res) => {
  const pending = await getPendingInvoices();
  const all     = await getInvoices();
  const fam     = decodeURIComponent(req.params.family);
  res.json({
    pending: pending.filter(i => i.family === fam),
    all:     all.filter(i => i.family === fam)
  });
});

// ── Banco ─────────────────────────────────────────────────────────
// Sube el Excel descargado del Santander (.xls/.xlsx): lo parsea, categoriza
// e ingiere en `bancoMovimientos` con clave anti-duplicado (resubir rangos
// solapados no duplica).
app.post('/api/bank/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
    const buf = fs.readFileSync(req.file.path);
    const r = await require('./banco').ingestExcelBuffer(buf, { originalname: req.file.originalname });
    if (!r.ok) return res.status(422).json(r);
    // compat: mantenemos latest.json por si la UI antigua lo consulta
    try {
      fs.writeFileSync(path.join(UPLOADS_DIR, 'latest.json'), JSON.stringify({
        filename: req.file.filename, originalname: req.file.originalname,
        uploadedAt: new Date().toISOString(), size: req.file.size,
        periodo: r.periodo, total: r.total, nuevos: r.nuevos, repetidos: r.repetidos,
      }));
    } catch (e) {}
    res.json({ message: `Importados ${r.nuevos} movimientos nuevos (${r.repetidos} ya existían).`, ...r });
  } catch (err) {
    console.error('[Banco] upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bank/info', requireAuth, async (req, res) => {
  try {
    const last = await require('./banco').getUltimoImport();
    if (!last) return res.json({ uploaded: false });
    res.json({
      uploaded: true,
      originalname: last.archivo,
      uploadedAt: last.fecha,
      periodo: last.periodo,
      total: last.total, nuevos: last.nuevos, repetidos: last.repetidos,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/bank/movimientos', requireAuth, async (req, res) => {
  try {
    const { from, to, categoria, flujo, q, limit } = req.query;
    res.json({ movimientos: await require('./banco').getMovimientos({ from, to, categoria, flujo, q, limit: limit ? Number(limit) : undefined }) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/bank/resumen', requireAuth, async (req, res) => {
  try { res.json(await require('./banco').getResumen({ from: req.query.from, to: req.query.to })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/bank/recurrentes', requireAuth, async (req, res) => {
  try { res.json({ recurrentes: await require('./banco').getRecurrentesMensuales() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/bank/dashboard', requireAuth, async (req, res) => {
  try { res.json(await require('./banco').getDashboardData()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Notificaciones ────────────────────────────────────────────────
app.post('/api/check-alerts',      requireAuth, (req,res) => { checkPendingInvoices().catch(console.error); res.json({message:'Revisión iniciada.'}); });
app.post('/api/send-summary',      requireAuth, (req,res) => { runDailySummary().catch(console.error); res.json({message:'Resumen enviado.'}); });
app.post('/api/test-notification', requireAuth, async (req,res) => {
  const { type } = req.body;
  const msg = `✅ *Test Corp Projects*\nSistema OK.\n📅 ${new Date().toLocaleString('es-ES')}`;
  if (type==='whatsapp'||!type) await sendWhatsApp(msg);
  if (type==='email'||!type) await sendEmail({ to:process.env.EMAIL_ADMIN, subject:'✅ Test', html:`<p>${msg}</p>`, text:msg });
  res.json({ message:'Notificación enviada.' });
});

// ── PRESENCIA ─────────────────────────────────────────────────────
const attendance = require('./attendance');

// PLANIFICACIÓN (agenda de lo previsto) ──────────────────────────
app.get('/api/planning', requireAuth, async (req, res) => {
  try {
    const { getPlanning } = require('./planning');
    res.json({ items: await getPlanning(req.query.from, req.query.to) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/planning', requireAuth, async (req, res) => {
  try {
    const { createPlanning } = require('./planning');
    res.json(await createPlanning(req.body || {}));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.put('/api/planning/:id', requireAuth, async (req, res) => {
  try {
    const { updatePlanning } = require('./planning');
    res.json(await updatePlanning(req.params.id, req.body || {}));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/planning/:id', requireAuth, async (req, res) => {
  try {
    const { deletePlanning } = require('./planning');
    res.json(await deletePlanning(req.params.id));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── GOOGLE CALENDAR (diagnóstico) ─────────────────────────────────
// Solo lectura: confirma el permiso del token y lista los calendarios + sus IDs.
app.get('/api/calendar/diag', requireAuth, async (req, res) => {
  try {
    res.json(await calendarSync.diagnose());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Sondeo manual ("sincronizar ahora"): trae de Google los cambios.
app.post('/api/calendar/pull', requireAuth, async (req, res) => {
  try {
    res.json(await calendarSync.pullChanges());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── LOG DE ACTIVIDAD DE STELORDER ─────────────────────────────────
app.get('/api/activity', requireAuth, async (req, res) => {
  try {
    res.json({ items: await activity.getLog({ type: req.query.type || null, limit: parseInt(req.query.limit || '200', 10) }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/activity/scan', requireAuth, async (req, res) => {
  try {
    res.json(await activity.scan());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/activity/reset', requireAuth, async (req, res) => {
  try {
    res.json(await activity.reset());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/estados',  requireAuth, (req, res) => res.json(attendance.ESTADOS));

app.post('/api/attendance', requireAuth, async (req, res) => {
  try {
    const result = await attendance.saveAttendance(req.body);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/attendance/:workerId/:date', requireAuth, async (req, res) => {
  try {
    await attendance.deleteAttendance(req.params.workerId, req.params.date);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/attendance', requireAuth, async (req, res) => {
  try {
    const { workerId, from, to, clientName } = req.query;
    const data = await attendance.getAttendance({ workerId, from, to, clientName });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/attendance/summary/:year/:month', requireAuth, async (req, res) => {
  try {
    const { getMonthlySummary, buildClientSummary } = require('./attendance');
    const summary = await getMonthlySummary(
      parseInt(req.params.year),
      parseInt(req.params.month)
    );
    summary.clientSummary = buildClientSummary(summary.byWorker);
    res.json(summary);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/attendance/client', requireAuth, async (req, res) => {
  try {
    const { clientName, from, to } = req.query;
    const data = await attendance.getClientExtract(clientName, from, to);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── USUARIOS ──────────────────────────────────────────────────────
const users = require('./users');

users.initDefaultUsers().catch(err => console.error('[Users] Error init:', err.message));

app.post('/api/users/login', async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin) return res.status(400).json({ error: 'PIN requerido' });
    const result = await users.loginWithPin(pin);
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post('/api/users/logout', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) await users.logout(token).catch(() => {});
  res.json({ ok: true });
});

app.get('/api/users/me', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    if (!token.startsWith('u_')) {
      const jwt = require('jsonwebtoken');
      jwt.verify(token, JWT_SECRET);
      return res.json({ role: 'admin', userName: 'Admin' });
    }
    const session = await users.verifyUserToken(token);
    if (!session) return res.status(401).json({ error: 'Sesión expirada' });
    res.json({ role: session.userRole, userName: session.userName, userId: session.userId });
  } catch (err) {
    res.status(401).json({ error: 'Token inválido' });
  }
});

app.get('/api/users', requireAuth, async (req, res) => {
  try {
    const list = await users.getUsers(true);
    res.json(list.map(u => { const { passwordHash, gpsConsent, ...rest } = u; return { ...rest, pin: '••••', hasPassword: !!passwordHash, gpsConsentAt: (gpsConsent && gpsConsent.acceptedAt) || null }; }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/:id', requireAuth, async (req, res) => {
  try {
    const u = await users.getUser(req.params.id);
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    const { passwordHash, ...rest } = u;
    res.json({ ...rest, hasPassword: !!passwordHash });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', requireAuth, async (req, res) => {
  try {
    const user = await users.createUser(req.body);
    const a = actorDe(req);
    activity.registrar({ actor: a.name, actorRole: a.role, kind: 'creado', entidad: 'Usuario', ref: req.body?.name || '', detalle: 'Rol: ' + (users.ROLE_LABEL[users.normalizeRole(req.body?.role)] || '') });
    res.json({ ok: true, user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/users/:id', requireAuth, async (req, res) => {
  try {
    await users.updateUser(req.params.id, req.body);
    const a = actorDe(req);
    const det = req.body?.password ? 'Cambió la contraseña' : (req.body?.active === true ? 'Reactivado' : 'Datos actualizados');
    activity.registrar({ actor: a.name, actorRole: a.role, kind: 'modificado', entidad: 'Usuario', ref: req.body?.name || req.params.id, detalle: det });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/users/:id', requireAuth, async (req, res) => {
  try {
    await users.deactivateUser(req.params.id);
    const a = actorDe(req);
    activity.registrar({ actor: a.name, actorRole: a.role, kind: 'borrado', entidad: 'Usuario', ref: req.params.id, detalle: 'Desactivado' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Genera (y opcionalmente envía) el ENLACE MÁGICO de acceso del trabajador.
app.post('/api/users/:id/magic-link', requireAuth, async (req, res) => {
  try {
    const { user } = await users.ensureMagicToken(req.params.id, req.body && req.body.regen);
    const base = (req.headers['x-forwarded-proto'] || req.protocol || 'https') + '://' + req.get('host');
    const url = `${base}/fichar?t=${user.magicToken}`;
    const nombre = String(user.name || '').split(' ')[0];
    const msg = `Hola ${nombre}, este es tu acceso a la app de Corp Projects para FICHAR tu jornada y mandar partes. Ábrelo en el móvil y añádelo a la pantalla de inicio:\n${url}`;
    let sent = null;
    const enviar = req.body && req.body.enviar;
    if (enviar === 'whatsapp') {
      if (!user.telefono) return res.status(400).json({ error: 'Este trabajador no tiene teléfono en su ficha', url });
      const tel = normalizarTelE164(user.telefono);
      const ok = await require('./notifications').sendWhatsAppTo(tel, msg);
      if (!ok) return res.status(502).json({ error: 'WhatsApp no disponible (canal sin conectar, o Meta exige plantilla para mensajes en frío). Usa el email o copia el enlace.', url });
      sent = 'whatsapp';
    } else if (enviar === 'email') {
      if (!user.email) return res.status(400).json({ error: 'Este trabajador no tiene email en su ficha', url });
      await require('./notifications').sendEmail({ to: user.email, subject: 'Tu acceso a la app de Corp Projects', text: msg, html: `<p>Hola ${nombre},</p><p>Este es tu acceso a la app de Corp Projects para <b>fichar</b> tu jornada y mandar partes. Ábrelo en el móvil y añádelo a la pantalla de inicio:</p><p><a href="${url}">${url}</a></p>` }); sent = 'email';
    }
    res.json({ ok: true, url, sent });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/roles', requireAuth, (req, res) => res.json(users.ROLES));

// ── OBRAS ─────────────────────────────────────────────────────────
const obras = require('./obras');
const activos = require('./activos');
const mediciones = require('./mediciones');
const presupuestos = require('./presupuestos');

app.get('/api/obras', requireAuth, async (req, res) => {
  try {
    const { clientName, status, search } = req.query;
    res.json(await obras.getObras({ clientName, status, search }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/obras/resumen', requireAuth, async (req, res) => {
  try { res.json(await obras.getResumenGeneral()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/obras/:id', requireAuth, async (req, res) => {
  try { res.json(await obras.getObra(req.params.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/obras/:id/rentabilidad', requireAuth, async (req, res) => {
  try { res.json(await obras.getRentabilidad(req.params.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/obras', requireAuth, async (req, res) => {
  try {
    const obra = await obras.createObra(req.body);
    res.json({ ok: true, obra });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/obras/:id', requireAuth, async (req, res) => {
  try {
    await obras.updateObra(req.params.id, req.body);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/obras/:id', requireAuth, async (req, res) => {
  try { res.json(await obras.deleteObra(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/obras/:id/material', requireAuth, async (req, res) => {
  try { res.json(await obras.addMaterial(req.params.id, req.body)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/obras/:id/material/:matId', requireAuth, async (req, res) => {
  try { await obras.deleteMaterial(req.params.id, req.params.matId); res.json({ ok: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/obras/sugerir-ref', requireAuth, async (req, res) => {
  try { res.json({ nombre: await asistente.sugerirNombreObra(req.body || {}) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Subida de facturas por obra (app de oficina, subir-factura.html) ──────────
// Lista de obras para el desplegable. Auth de oficina (token trabajador o admin).
app.get('/api/facturas/obras', requireAuthOficina, async (req, res) => {
  try {
    const lista = await obras.getObras({});
    res.json(lista
      .filter(o => o.status !== 'archivada')
      .map(o => ({ id: String(o._id), reference: o.reference || '', clientName: o.clientName || '', status: o.status || 'activa' })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Subida de foto(s)/PDF de factura, etiquetada por obra. Reenvía al buzón de n8n
// por el mismo camino que WhatsApp (→ StelOrder) y registra en `facturasObra`.
app.post('/api/facturas/subir', requireAuthOficina, uploadFactura.any(), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ ok: false, error: 'No has adjuntado ningún archivo.' });

    const facturaWA = require('./facturaWhatsApp');
    const attachments = [];

    // PDFs: se reenvían tal cual. Imágenes: se embeben en UN solo PDF (una por página).
    const pdfs  = files.filter(f => /pdf/i.test(f.mimetype || '') || /\.pdf$/i.test(f.originalname || ''));
    const imgs  = files.filter(f => /^image\//i.test(f.mimetype || ''));
    const otros = files.filter(f => !pdfs.includes(f) && !imgs.includes(f));

    for (const f of pdfs) {
      attachments.push({ filename: f.originalname || 'factura.pdf', content: f.buffer, contentType: 'application/pdf' });
    }
    if (imgs.length) {
      const pdfBuf = await facturaWA.fotosAPdf(imgs.map(f => ({ data: f.buffer.toString('base64'), media_type: f.mimetype })));
      if (pdfBuf && pdfBuf.length) {
        const nombre = attachments.some(a => a.filename === 'factura.pdf') ? 'factura-fotos.pdf' : 'factura.pdf';
        attachments.push({ filename: nombre, content: pdfBuf, contentType: 'application/pdf' });
      } else {
        // Fallback: adjuntar las imágenes crudas si no se pudo generar el PDF.
        let i = 0;
        for (const f of imgs) {
          const ext = (String(f.mimetype || 'image/jpeg').split('/')[1] || 'jpg');
          attachments.push({ filename: f.originalname || `factura-${++i}.${ext}`, content: f.buffer, contentType: f.mimetype });
        }
      }
    }
    // Cualquier otro tipo con nombre de archivo → adjuntar tal cual (no perder la factura).
    for (const f of otros) {
      attachments.push({ filename: f.originalname || 'factura', content: f.buffer, contentType: f.mimetype || 'application/octet-stream' });
    }

    const obraRef = String(req.body.obraRef || '').trim() || null;
    const obraId  = String(req.body.obraId || '').trim() || null;
    const nota    = String(req.body.nota || '').trim() || null;
    const quien   = req.oficina?.workerName || (req.oficina?.admin ? 'admin' : 'oficina');

    const r = await facturaWA.reenviarFacturaMail({
      attachments, obraRef, obraId, origen: 'app-oficina', from: quien, nota,
    });
    if (!r.ok) return res.status(502).json(r);
    res.json(r);
  } catch (err) {
    console.error('[Factura subir]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Clasificar facturas de proveedor: obra / gasto general / sin clasificar ──
// Estado por factura (prioridad manual > regla-proveedor > marcador n8n).
app.get('/api/facturas/proveedor', requireAuthOficina, async (req, res) => {
  try {
    const filtro = String(req.query.filtro || '').toLowerCase(); // '', 'sin', 'obra', 'general'
    const [facturas, asignMap, reglaMap] = await Promise.all([
      require('./stelorder').getPurchaseInvoices(),
      obras.getAsignacionesFacturaMap(),
      obras.getReglasMap(),
    ]);
    const out = (facturas || []).map(f => ({
      id: f.id, number: f.number, supplier: f.supplier, supplierId: f.supplierId,
      total: f.total, date: f.date,
      clasif: obras.resolverFacturaObra(f, asignMap, reglaMap),
    })).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const filtrada =
      filtro === 'sin'     ? out.filter(f => !f.clasif) :
      filtro === 'obra'    ? out.filter(f => f.clasif && f.clasif.tipo === 'obra') :
      filtro === 'general' ? out.filter(f => f.clasif && f.clasif.tipo === 'general') :
      out;
    res.json({ categorias: obras.CATEGORIAS_GASTO, facturas: filtrada });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Identidad de oficina (para SSO de las herramientas): acepta JWT de admin del
// dashboard (localStorage cp_token) o token de trabajador. Devuelve quién eres.
app.get('/api/oficina/whoami', requireAuthOficina, (req, res) => {
  res.json({
    admin: !!req.oficina?.admin,
    name:  req.oficina?.admin ? 'Administración' : (req.oficina?.workerName || 'Oficina'),
    workerName: req.oficina?.workerName || null,
    role: req.oficina?.role || (req.oficina?.admin ? 'admin' : 'worker'),
  });
});

// Detalle de una factura de proveedor: sus líneas (para saber qué es).
app.get('/api/facturas/proveedor/:id/detalle', requireAuthOficina, async (req, res) => {
  try {
    const d = await require('./stelorder').getPurchaseInvoiceDetalle(req.params.id);
    if (!d) return res.status(404).json({ error: 'Factura no encontrada' });
    res.json(d);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Clasificar una factura: obra (opcional) + categoría (opcional). Al menos una.
app.post('/api/facturas/proveedor/:id/clasificar', requireAuthOficina, async (req, res) => {
  try {
    const { obraId, obraRef, categoria } = req.body || {};
    const by = req.oficina?.workerName || (req.oficina?.admin ? 'admin' : 'oficina');
    res.json(await obras.clasificarFactura(req.params.id, { obraId, obraRef, categoria, by }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Repartir una factura entre obras por importe (facturas de varias obras / excluir regalos).
app.post('/api/facturas/proveedor/:id/repartir', requireAuthOficina, async (req, res) => {
  try {
    const { obraId, obraRef, importe } = req.body || {};
    const by = req.oficina?.workerName || (req.oficina?.admin ? 'admin' : 'oficina');
    res.json(await obras.repartirFactura(req.params.id, { obraId, obraRef, importe, by }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/facturas/proveedor/:id/quitar-reparto', requireAuthOficina, async (req, res) => {
  try { res.json(await obras.quitarReparto(req.params.id, (req.body || {}).obraId)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Quitar la clasificación explícita de una factura (vuelve a regla/marcador/sin clasificar).
app.delete('/api/facturas/proveedor/:id', requireAuthOficina, async (req, res) => {
  try { res.json(await obras.desclasificarFactura(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Crear una obra al vuelo desde la oficina (referencia + cliente) para poder asignar.
app.post('/api/facturas/obra-nueva', requireAuthOficina, async (req, res) => {
  try {
    const { reference, clientName } = req.body || {};
    const obra = await obras.createObra({ reference, clientName });
    res.json({ ok: true, id: String(obra.id), reference: obra.reference, clientName: obra.clientName });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Reglas por proveedor (autoclasifican todas las facturas de ese proveedor).
app.get('/api/facturas/reglas', requireAuthOficina, async (req, res) => {
  try { res.json(await obras.getReglas()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/facturas/reglas', requireAuthOficina, async (req, res) => {
  try {
    const { supplierId, supplier, obraId, obraRef, categoria } = req.body || {};
    const by = req.oficina?.workerName || (req.oficina?.admin ? 'admin' : 'oficina');
    res.json(await obras.setReglaProveedor(supplierId, { supplier, obraId, obraRef, categoria, by }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/facturas/reglas/:supplierId', requireAuthOficina, async (req, res) => {
  try { res.json(await obras.deleteReglaProveedor(req.params.supplierId)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── CUSTODIA DE ACTIVOS (llaves / herramientas) ───────────────────
app.get('/api/activos', requireAuthOficina, async (req, res) => {
  try {
    const { tipo, estado, holderId, search } = req.query;
    res.json(await activos.getActivos({ tipo, estado, holderId, search }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/activos/siguiente-codigo', requireAuthOficina, async (req, res) => {
  try {
    const db = await require('./db').getDB();
    res.json({ codigo: await activos.siguienteCodigo(db, req.query.tipo) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.get('/api/activos/:id', requireAuthOficina, async (req, res) => {
  try { res.json(await activos.getActivo(req.params.id)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});
app.post('/api/activos', requireAuthOficina, async (req, res) => {
  try {
    const by = req.oficina?.workerName || (req.oficina?.admin ? 'admin' : 'oficina');
    res.json(await activos.crearActivo(req.body || {}, by));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.put('/api/activos/:id', requireAuthOficina, async (req, res) => {
  try {
    const by = req.oficina?.workerName || (req.oficina?.admin ? 'admin' : 'oficina');
    res.json(await activos.editarActivo(req.params.id, req.body || {}, by));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/activos/:id/dar', requireAuthOficina, async (req, res) => {
  try {
    const by = req.oficina?.workerName || (req.oficina?.admin ? 'admin' : 'oficina');
    res.json(await activos.darActivo(req.params.id, req.body || {}, by));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/activos/:id/devolver', requireAuthOficina, async (req, res) => {
  try {
    const by = req.oficina?.workerName || (req.oficina?.admin ? 'admin' : 'oficina');
    res.json(await activos.devolverActivo(req.params.id, req.body || {}, by));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/activos/:id/perdida', requireAuthOficina, async (req, res) => {
  try {
    const by = req.oficina?.workerName || (req.oficina?.admin ? 'admin' : 'oficina');
    res.json(await activos.marcarPerdida(req.params.id, req.body || {}, by));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/activos/:id', requireAuthOficina, async (req, res) => {
  try { res.json(await activos.eliminarActivo(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── CATÁLOGO DE PARTIDAS (base de precios · motor de presupuestos) ──
app.get('/api/partidas', requireAuthOficina, async (req, res) => {
  try {
    let partidas = await presupuestos.getPartidas({ search: req.query.search });
    if (!users.canSeeMoney(req.oficina?.role)) partidas = sinCostePartidas(partidas); // Encargado: sin coste ni receta
    res.json({ unidades: presupuestos.UNIDADES, partidas });
  }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/partidas', requireAuthOficina, async (req, res) => {
  try {
    const by = req.oficina?.workerName || (req.oficina?.admin ? 'admin' : 'oficina');
    res.json(await presupuestos.crearPartida(req.body || {}, by));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.put('/api/partidas/:id', requireAuthOficina, async (req, res) => {
  try { res.json(await presupuestos.editarPartida(req.params.id, req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/partidas/:id', requireAuthOficina, async (req, res) => {
  try { res.json(await presupuestos.eliminarPartida(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── MATERIALES (base de precios de compra · descompuesto) ──
app.get('/api/materiales', requireAuthOficina, async (req, res) => {
  // El catálogo de materiales es puro precio de compra → solo Dueño/Oficina.
  if (!users.canSeeMoney(req.oficina?.role)) return res.status(403).json({ error: 'Tu rol no tiene acceso al catálogo de precios' });
  try { res.json({ unidades: presupuestos.MAT_UNIDADES, materiales: await presupuestos.getMateriales({ search: req.query.search }) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/materiales', requireAuthOficina, async (req, res) => {
  try {
    const by = req.oficina?.workerName || (req.oficina?.admin ? 'admin' : 'oficina');
    res.json(await presupuestos.crearMaterial(req.body || {}, by));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.put('/api/materiales/:id', requireAuthOficina, async (req, res) => {
  try { res.json(await presupuestos.editarMaterial(req.params.id, req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/materiales/:id', requireAuthOficina, async (req, res) => {
  try { res.json(await presupuestos.eliminarMaterial(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── PRESUPUESTOS (medición × partidas) ──
app.get('/api/presupuestos', requireAuthOficina, async (req, res) => {
  try {
    const list = await presupuestos.getPresupuestos();
    res.json(users.canSeeMoney(req.oficina?.role) ? list : sinCosteLista(list));
  }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/presupuestos/:id', requireAuthOficina, async (req, res) => {
  try {
    const p = await presupuestos.getPresupuesto(req.params.id);
    res.json(users.canSeeMoney(req.oficina?.role) ? p : sinCostePres(p));
  }
  catch (err) { res.status(404).json({ error: err.message }); }
});
app.get('/api/presupuestos/:id/materiales', requireAuthOficina, async (req, res) => {
  // La lista de la compra es coste puro → solo Dueño/Oficina.
  if (!users.canSeeMoney(req.oficina?.role)) return res.status(403).json({ error: 'Tu rol no tiene acceso a la lista de la compra' });
  try { res.json(await presupuestos.listaMateriales(req.params.id)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});
app.put('/api/presupuestos/:id/estado', requireAuthOficina, async (req, res) => {
  try {
    const estado = (req.body || {}).estado;
    const a = actorDe(req);
    const r = await presupuestos.setEstado(req.params.id, estado);
    activity.registrar({ actor: a.name, actorRole: a.role, kind: 'modificado', entidad: 'Presupuesto', ref: req.params.id, detalle: 'Estado → ' + estado });
    // Presupuesto ACEPTADO → crea la OBRA (una sola vez) y la enlaza.
    let obra = null;
    if (estado === 'aceptado') {
      try {
        obra = await presupuestos.crearObraDesdePresupuesto(req.params.id);
        if (obra && obra.creada) activity.registrar({ actor: a.name, actorRole: a.role, kind: 'creado', entidad: 'Obra', ref: obra.reference, detalle: 'Desde presupuesto aceptado' });
      } catch (e) { console.warn('[Presupuesto→Obra]', e.message); }
    }
    res.json({ ...r, obra });
  }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.get('/api/empresa', requireAuthOficina, (req, res) => res.json(presupuestos.getEmpresa()));
app.post('/api/presupuestos', requireAuthOficina, async (req, res) => {
  try {
    const by = req.oficina?.name || req.oficina?.workerName || 'Oficina';
    const nuevo = await presupuestos.crearPresupuesto(req.body || {}, by);
    activity.registrar({ actor: by, actorRole: req.oficina?.role, kind: 'creado', entidad: 'Presupuesto', ref: (req.body && req.body.nombre) || nuevo.numero || '' });
    res.json(nuevo);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.put('/api/presupuestos/:id', requireAuthOficina, async (req, res) => {
  try { res.json(await presupuestos.guardarPresupuesto(req.params.id, req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/presupuestos/:id', requireAuthOficina, async (req, res) => {
  try {
    const r = await presupuestos.eliminarPresupuesto(req.params.id);
    const a = actorDe(req);
    activity.registrar({ actor: a.name, actorRole: a.role, kind: 'borrado', entidad: 'Presupuesto', ref: req.params.id });
    res.json(r);
  }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── MEDICIONES (medidor por estancias · motor de presupuestos F1) ──
app.get('/api/mediciones', requireAuthOficina, async (req, res) => {
  try { res.json(await mediciones.getMediciones()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/mediciones/:id', requireAuthOficina, async (req, res) => {
  try { res.json(await mediciones.getMedicion(req.params.id)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});
app.post('/api/mediciones', requireAuthOficina, async (req, res) => {
  try {
    const by = req.oficina?.workerName || (req.oficina?.admin ? 'admin' : 'oficina');
    res.json(await mediciones.crearMedicion(req.body || {}, by));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.put('/api/mediciones/:id', requireAuthOficina, async (req, res) => {
  try {
    const by = req.oficina?.workerName || (req.oficina?.admin ? 'admin' : 'oficina');
    res.json(await mediciones.editarMedicion(req.params.id, req.body || {}, by));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/mediciones/:id', requireAuthOficina, async (req, res) => {
  try { res.json(await mediciones.eliminarMedicion(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── PARTES DE TRABAJO ─────────────────────────────────────────────
const partes = require('./partes');

app.post('/api/partes/worker-login', async (req, res) => {
  try {
    const { workerId, pin } = req.body;
    const { getUsers } = require('./users');
    const allUsers = await getUsers(false);
    const user = allUsers.find(u => String(u._id) === workerId || u.id === workerId);
    if (user && user.pin === pin) {
      const crypto = require('crypto');
      const token = `w_${crypto.randomBytes(16).toString('hex')}`;
      const { db, client } = await getDB();
      await db.collection('worker_tokens').insertOne({
        token,
        workerId: String(user._id),
        workerName: user.name,
        workerRole: user.role,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000)
      });
      await client.close();
      return res.json({ token, workerId: String(user._id), workerName: user.name, role: user.role });
    }
    const result = await partes.workerLogin(workerId, pin);
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: 'PIN incorrecto' });
  }
});

app.get('/api/partes/workers', async (req, res) => {
  try {
    const { getUsers, normalizeRole } = require('./users');
    const allUsers = await getUsers(false);
    // Cualquiera que va a la app de campo: técnico, encargado, oficina o dueño.
    // Se normaliza el rol para entender tanto los antiguos (tech/office/admin)
    // como los nuevos (tecnico/encargado/oficina/owner).
    const CAMPO = ['owner', 'oficina', 'encargado', 'tecnico'];
    const techs = allUsers.filter(u => u.role !== 'client' && CAMPO.includes(normalizeRole(u.role)));
    if (techs.length > 0) {
      res.json(techs.map(u => ({ id: String(u._id), name: u.name, color: u.color || '#4d9cf8', role: u.role, costeHora: u.costeHora || 15 })));
    } else {
      res.json(partes.WORKERS.map(w => ({ id: w.id, name: w.name, color: '#4d9cf8', costeHora: w.costeHora || 15 })));
    }
  } catch(err) {
    res.json(partes.WORKERS.map(w => ({ id: w.id, name: w.name, color: '#4d9cf8', costeHora: w.costeHora || 15 })));
  }
});

app.post('/api/partes', uploadMemory.any(), async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    let workerInfo;

    if (authHeader.startsWith('Bearer w_')) {
      const token = authHeader.replace('Bearer ', '');
      const workerDoc = await partes.verifyWorkerToken(token);
      if (!workerDoc) return res.status(401).json({ error: 'Token expirado' });
      workerInfo = { workerId: workerDoc.workerId, workerName: workerDoc.workerName, role: 'worker', ip: req.ip, userAgent: req.headers['user-agent'] };
    } else {
      const token = authHeader.replace('Bearer ', '');
      jwt.verify(token, JWT_SECRET);
      const bodyData = req.body.data ? JSON.parse(req.body.data) : req.body;
      const worker = partes.WORKERS.find(w => w.id === bodyData.workerId);
      workerInfo = { workerId: bodyData.workerId || 'admin', workerName: bodyData.workerName || worker?.name || 'Admin', role: 'admin', ip: req.ip, userAgent: req.headers['user-agent'] };
    }

    const bodyData = req.body.data ? JSON.parse(req.body.data) : req.body;
    const fotosTrabajo = [];
    const fotosAlbaran = [];
    if (req.files && req.files.length > 0) {
      req.files.forEach(f => {
        const b64 = `data:${f.mimetype};base64,${f.buffer.toString('base64')}`;
        if (f.fieldname.startsWith('foto_trabajo')) fotosTrabajo.push(b64);
        if (f.fieldname.startsWith('foto_albaran')) fotosAlbaran.push(b64);
      });
    }
    bodyData.fotosTrabajo = fotosTrabajo;
    bodyData.fotosAlbaran = fotosAlbaran;

    // RGPD: sin consentimiento GPS firmado, no se guarda la ubicación del parte.
    try {
      if (/^[a-f0-9]{24}$/i.test(String(workerInfo.workerId)) && !(await users.userHasGpsConsent(workerInfo.workerId))) {
        bodyData.gpsLat = null; bodyData.gpsLng = null; bodyData.gpsAccuracy = null;
      }
    } catch (e) { /* ante duda, no bloquear el parte */ }

    const parte = await partes.createParte(bodyData, workerInfo);

    // Cierre del ciclo pedido→parte (3C)
    if (bodyData.workOrderId) {
      try {
        await require('./asignaciones').recordParteResult(bodyData.workOrderId, {
          workerId: workerInfo.workerId, parteId: String(parte._id || parte.id),
          estadoTrabajo: bodyData.estadoTrabajo || 'completado'
        });
      } catch (e) { console.warn('[Partes] recordParteResult:', e.message); }
    }

    // Reflejar la presencia del trabajador ese día a partir del parte
    // (no rompe el envío del parte si algo falla).
    try { await attendance.syncPresenceFromParte(parte); }
    catch (e) { console.warn('[Partes] syncPresenceFromParte:', e.message); }

    res.json({ ok: true, id: parte.id });
  } catch (err) {
    console.error('[Partes] Error create:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/partes', requireAuth, async (req, res) => {
  try {
    const { workerId, clientName, status, from, to, limit, skip } = req.query;
    const data = await partes.getPartes({ workerId, clientName, status, from, to, limit: parseInt(limit||50), skip: parseInt(skip||0) });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/partes/:id', requireAuth, async (req, res) => {
  try { res.json(await partes.getParte(req.params.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/partes/:id', requireAuth, async (req, res) => {
  try {
    await partes.updateParte(req.params.id, req.body, 'admin');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/partes/:id', requireAuth, async (req, res) => {
  try {
    const { db, client } = await getDB();
    await db.collection('partes').deleteOne({ _id: new ObjectId(req.params.id) });
    await client.close();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/partes/resumen/facturacion', requireAuth, async (req, res) => {
  try {
    const { from, to, clientName } = req.query;
    res.json(await partes.getResumenFacturacion({ from, to, clientName }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/clients/list', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    let valid = false;
    if (token.startsWith('w_') || token.startsWith('u_')) {
      const { verifyWorkerToken } = require('./partes');
      const { verifyUserToken } = require('./users');
      const w = token.startsWith('w_') ? await verifyWorkerToken(token) : await verifyUserToken(token);
      valid = !!w;
    } else {
      try { jwt.verify(token, JWT_SECRET); valid = true; } catch(e) {}
    }
    if (!valid) return res.status(401).json({ error: 'No autorizado' });
    const { clients } = await getClients();
    const names = [...new Set(clients.map(c => c['legal-name']||c['fiscal-name']||'').filter(n=>n))].sort();
    res.json(names);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clientes con su FAMILIA de StelOrder (para las llaves: saber el gremio/quién).
app.get('/api/oficina/clientes', requireAuthOficina, async (req, res) => {
  try {
    const { clientMap } = await getClients();
    const seen = new Set(); const out = [];
    Object.values(clientMap || {}).forEach(c => {
      const name = c.name || '';
      if (!name || seen.has(name)) return;
      seen.add(name);
      out.push({ name, family: c.family && c.family !== 'Sin familia' ? c.family : '' });
    });
    out.sort((a, b) => a.name.localeCompare(b.name));
    res.json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ASIGNACIONES, EXTERNOS Y EXPEDIENTES ─────────────────────────
const expedientes = require('./expedientes');

app.get('/api/externos', async (req, res) => {
  try {
    // Lectura permitida a admin (JWT) o trabajador (token de parte)
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No autorizado' });
    let ok = false;
    try { jwt.verify(token, JWT_SECRET); ok = true; } catch {}
    if (!ok) { const w = await partes.verifyWorkerToken(token); ok = !!w; }
    if (!ok) return res.status(401).json({ error: 'No autorizado' });
    res.json(await expedientes.getExternos());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/externos', requireAuth, async (req, res) => {
  try { res.json(await expedientes.createExterno(req.body)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/externos/:id', requireAuth, async (req, res) => {
  try { await expedientes.updateExterno(req.params.id, req.body); res.json({ ok: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/externos/:id', requireAuth, async (req, res) => {
  try { await expedientes.deleteExterno(req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/asignaciones', requireAuth, async (req, res) => {
  try {
    const { fecha, workerId } = req.query;
    res.json(await expedientes.getAsignaciones({ fecha, workerId }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/asignaciones/dia/:fecha', requireAuth, async (req, res) => {
  try { res.json(await expedientes.getAsignacionesDelDia(req.params.fecha)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/asignaciones/worker/:workerId', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No autorizado' });
    const { verifyWorkerToken } = require('./partes');
    const { verifyUserToken } = require('./users');
    let valid = false;
    if (token.startsWith('w_')) { valid = !!(await verifyWorkerToken(token)); }
    else if (token.startsWith('u_')) { valid = !!(await verifyUserToken(token)); }
    else { try { jwt.verify(token, JWT_SECRET); valid = true; } catch(e){} }
    if (!valid) return res.status(401).json({ error: 'No autorizado' });
    const fecha = req.query.fecha || new Date().toISOString().slice(0, 10);
    res.json(await expedientes.getAsignacionesWorker(req.params.workerId, fecha));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/asignaciones', requireAuth, async (req, res) => {
  try { res.json(await expedientes.createAsignacion(req.body)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/asignaciones/:id', requireAuth, async (req, res) => {
  try { await expedientes.updateAsignacion(req.params.id, req.body); res.json({ ok: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/asignaciones/:id', requireAuth, async (req, res) => {
  try { await expedientes.deleteAsignacion(req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/expedientes', requireAuth, async (req, res) => {
  try {
    const { estado, clientName } = req.query;
    res.json(await expedientes.getExpedientes({ estado, clientName }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/expedientes/:id', requireAuth, async (req, res) => {
  try { res.json(await expedientes.getExpediente(req.params.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/expedientes', requireAuth, async (req, res) => {
  try { res.json(await expedientes.createExpediente(req.body)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/expedientes/:id', requireAuth, async (req, res) => {
  try { await expedientes.updateExpediente(req.params.id, req.body); res.json({ ok: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/expedientes/:id/cerrar', requireAuth, async (req, res) => {
  try {
    await expedientes.updateExpediente(req.params.id, { estado: 'COMPLETADO' });
    const exp = await expedientes.getExpediente(req.params.id);
    const totalHoras = await expedientes.recalcularHorasExpediente(req.params.id);
    res.json({ ok: true, totalHoras, partes: exp.partes.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/partes/confirmar', uploadMemory.any(), async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No autorizado' });
    const workerDoc = await partes.verifyWorkerToken(token);
    if (!workerDoc) return res.status(401).json({ error: 'Token expirado' });

    const workerInfo = {
      workerId: workerDoc.workerId,
      workerName: workerDoc.workerName,
      role: 'worker',
      ip: req.ip,
      userAgent: req.headers['user-agent']
    };

    // El formulario envía multipart/form-data: los datos del parte van en el
    // campo 'data' (JSON) y las fotos como ficheros. Antes se leía req.body
    // directamente (sin multer) y llegaba VACÍO, por eso el parte salía sin
    // cliente, con 8 h por defecto y sin descripción, fotos ni GPS.
    const bodyData = req.body.data ? JSON.parse(req.body.data) : req.body;
    const fotosTrabajo = [];
    const fotosAlbaran = [];
    if (req.files && req.files.length > 0) {
      req.files.forEach(f => {
        const b64 = `data:${f.mimetype};base64,${f.buffer.toString('base64')}`;
        if (f.fieldname.startsWith('foto_trabajo')) fotosTrabajo.push(b64);
        if (f.fieldname.startsWith('foto_albaran')) fotosAlbaran.push(b64);
      });
    }
    bodyData.fotosTrabajo = fotosTrabajo;
    bodyData.fotosAlbaran = fotosAlbaran;

    // RGPD: sin consentimiento GPS firmado, no se guarda la ubicación del parte.
    try {
      if (/^[a-f0-9]{24}$/i.test(String(workerInfo.workerId)) && !(await users.userHasGpsConsent(workerInfo.workerId))) {
        bodyData.gpsLat = null; bodyData.gpsLng = null; bodyData.gpsAccuracy = null;
      }
    } catch (e) { /* ante duda, no bloquear el parte */ }

    const parte = await partes.createParte(bodyData, workerInfo);

    // Cierre del ciclo pedido→parte (3C)
    if (bodyData.workOrderId) {
      try {
        await require('./asignaciones').recordParteResult(bodyData.workOrderId, {
          workerId: workerInfo.workerId, parteId: String(parte._id || parte.id),
          estadoTrabajo: bodyData.estadoTrabajo || 'completado'
        });
      } catch (e) { console.warn('[Partes] recordParteResult:', e.message); }
    }

    // Reflejar la presencia del trabajador ese día (multi-obra). Lo hace el
    // servidor para que se acumulen varias obras; el formulario ya no sincroniza.
    try { await attendance.syncPresenceFromParte(parte); }
    catch (e) { console.warn('[Partes] syncPresenceFromParte:', e.message); }

    const equipo = bodyData.equipo || [];
    let partesGenerados = [];
    if (equipo.length > 1) {
      partesGenerados = await expedientes.generarPartesEquipo(parte, equipo);
    }

    let expedienteId = null;
    if (bodyData.estadoTrabajo === 'continua' || bodyData.estadoTrabajo === 'parcial' || bodyData.expedienteId) {
      expedienteId = await expedientes.vincularOCrearExpediente(
        String(parte._id),
        parte.clientName,
        parte.description,
        bodyData.expedienteId || null
      );
      if (expedienteId && partesGenerados.length > 0) {
        const { db, client } = await sharedDb.getDBLegacy();
        for (const pg of partesGenerados) {
          await db.collection('partes').updateOne(
            { _id: pg.id },
            { $set: { expedienteId } }
          );
        }
        await client.close();
      }
    }

    res.json({
      ok: true,
      parteId: String(parte._id),
      partesGenerados: partesGenerados.length,
      expedienteId
    });
  } catch (err) {
    console.error('[Partes] Error confirmar:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── EMAILS INTELIGENTES ───────────────────────────────────────────
const { pollEmails, enviarRespuesta } = require('./email-intelligence');

// Mapa comunidad → gestor (aprendido pasivamente de las respuestas a avisos).
app.get('/api/managers', requireAuth, async (req, res) => {
  try { res.json({ managers: await require('./gestores').getManagers() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/managers/:id', requireAuth, async (req, res) => {
  try { res.json(await require('./gestores').setConfirmed(req.params.id, !!req.body.confirmed)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/managers/:id', requireAuth, async (req, res) => {
  try { res.json(await require('./gestores').removeManager(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Adjuntos de un email: listar (en vivo desde Gmail, vale para emails antiguos).
app.get('/api/emails/:id/attachments', requireAuth, async (req, res) => {
  try {
    const { db } = await require('./db').getDBLegacy();
    const { ObjectId } = require('mongodb');
    const doc = await db.collection('emails').findOne({ _id: new ObjectId(req.params.id) });
    if (!doc) return res.status(404).json({ error: 'Email no encontrado' });
    const { listAttachments } = require('./email-intelligence');
    res.json({ attachments: await listAttachments(doc.gmailId) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Descargar un adjunto concreto (por posición + nombre: los attachmentId de Gmail rotan).
app.get('/api/emails/:id/attachments/:idx/download', requireAuth, async (req, res) => {
  try {
    const { db } = await require('./db').getDBLegacy();
    const { ObjectId } = require('mongodb');
    const doc = await db.collection('emails').findOne({ _id: new ObjectId(req.params.id) });
    if (!doc) return res.status(404).json({ error: 'Email no encontrado' });
    const { listAttachments, getAttachment } = require('./email-intelligence');
    const atts = await listAttachments(doc.gmailId);
    const idx = parseInt(req.params.idx);
    let att = atts[idx];
    // Verificación por nombre: si la posición no coincide, buscar por filename
    if (req.query.fn && (!att || att.filename !== req.query.fn)) {
      att = atts.find(a => a.filename === req.query.fn) || att;
    }
    if (!att) return res.status(404).json({ error: 'Adjunto no encontrado' });
    const buf = await getAttachment(doc.gmailId, att.attachmentId);
    res.set('Content-Type', att.mimeType);
    res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(att.filename)}"`);
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Reenviar un adjunto al OCR de StelOrder (manual: consume tokens de OCR).
app.post('/api/emails/:id/attachments/:idx/ocr', requireAuth, async (req, res) => {
  try {
    const { db } = await require('./db').getDBLegacy();
    const { ObjectId } = require('mongodb');
    const doc = await db.collection('emails').findOne({ _id: new ObjectId(req.params.id) });
    if (!doc) return res.status(404).json({ error: 'Email no encontrado' });
    const { listAttachments, reenviarAdjuntoOCR } = require('./email-intelligence');
    const atts = await listAttachments(doc.gmailId);
    const idx = parseInt(req.params.idx);
    let att = atts[idx];
    if (req.body.fn && (!att || att.filename !== req.body.fn)) {
      att = atts.find(a => a.filename === req.body.fn) || att;
    }
    if (!att) return res.status(404).json({ error: 'Adjunto no encontrado' });
    const r = await reenviarAdjuntoOCR(doc.gmailId, att.attachmentId, att.filename, att.mimeType, doc.asunto);
    await db.collection('emails').updateOne(
      { _id: doc._id },
      { $addToSet: { ocrEnviados: att.filename }, $set: { ocrUltimoEnvio: new Date() } }
    );
    res.json({ ok: true, destino: r.destino, filename: att.filename });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Diagnóstico de la clasificación IA de emails.
app.get('/api/emails/diag', requireAuth, async (req, res) => {
  try {
    const { diagnosticoIA } = require('./email-intelligence');
    res.json(await diagnosticoIA());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Reclasificar los emails que quedaron sin clasificar (fallback).
app.post('/api/emails/reclassify', requireAuth, async (req, res) => {
  try {
    const { reclasificarPendientes } = require('./email-intelligence');
    res.json(await reclasificarPendientes(parseInt(req.body.limit) || 150));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/emails', requireAuth, async (req, res) => {
  try {
    const { db, client } = await getDB();
    const { categoria, estado, urgencia, limit = 50, skip = 0 } = req.query;
    const filtro = {};
    if (categoria && categoria !== 'TODOS') filtro.categoria = categoria;
    if (estado && estado !== 'TODOS') filtro.estado = estado;
    if (urgencia && urgencia !== 'TODOS') filtro.urgencia = urgencia;
    // La publicidad/spam no estorba en la bandeja: solo aparece si se filtra su categoría
    if ((!categoria || categoria === 'TODOS') && estado === 'PENDIENTE') {
      filtro.categoria = { $nin: ['PUBLICIDAD', 'SPAM'] };
    }
    const emails = await db.collection('emails')
      .find(filtro).sort({ fecha: -1 }).skip(parseInt(skip)).limit(parseInt(limit)).toArray();
    const total      = await db.collection('emails').countDocuments(filtro);
    const pendientes = await db.collection('emails').countDocuments({ estado: 'PENDIENTE', categoria: { $nin: ['PUBLICIDAD', 'SPAM'] } });
    const publicidad = await db.collection('emails').countDocuments({ estado: 'PENDIENTE', categoria: { $in: ['PUBLICIDAD', 'SPAM'] } });
    const noLeidos   = await db.collection('emails').countDocuments({ leido: false, categoria: { $nin: ['PUBLICIDAD', 'SPAM'] } });
    await client.close();
    res.json({ emails, total, pendientes, noLeidos, publicidad });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/emails/:id/read', requireAuth, async (req, res) => {
  try {
    const { db, client } = await getDB();
    await db.collection('emails').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { leido: true } }
    );
    await client.close();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/emails/:id/archive', requireAuth, async (req, res) => {
  try {
    const { db, client } = await getDB();
    await db.collection('emails').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { estado: 'ARCHIVADO', leido: true } }
    );
    await client.close();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/emails/:id/nota', requireAuth, async (req, res) => {
  try {
    const { db, client } = await getDB();
    await db.collection('emails').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { notas: req.body.notas } }
    );
    await client.close();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/emails/:id/importante', requireAuth, async (req, res) => {
  try {
    const { db, client } = await getDB();
    await db.collection('emails').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { importante: req.body.importante } }
    );
    await client.close();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/emails/:id', requireAuth, async (req, res) => {
  try {
    const { db, client } = await getDB();
    await db.collection('emails').deleteOne({ _id: new ObjectId(req.params.id) });
    await client.close();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/emails/:id/reenviar', requireAuth, async (req, res) => {
  try {
    const { db, client } = await getDB();
    const email = await db.collection('emails').findOne({ _id: new ObjectId(req.params.id) });
    await client.close();
    if (!email) return res.status(404).json({ error: 'No encontrado' });
    const ok = await enviarRespuesta(
      req.body.destino,
      email.asunto,
      `--- Email reenviado ---\n\nDe: ${email.de}\nAsunto: ${email.asunto}\n\n${email.cuerpo}`
    );
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/emails/:id/action', requireAuth, async (req, res) => {
  try {
    const { db, client } = await getDB();
    const email = await db.collection('emails').findOne({ _id: new ObjectId(req.params.id) });
    if (!email) { await client.close(); return res.status(404).json({ error: 'Email no encontrado' }); }

    const { accion, datos } = req.body;
    let stelOrderRef = null;
    let mensajeRespuesta = null;

    if (accion === 'CREAR_INCIDENCIA') {
      const body = {
        description: datos?.descripcion || email.resumen,
        priority: email.urgencia === 'ALTA' ? 'HIGH' : email.urgencia === 'MEDIA' ? 'NORMAL' : 'LOW'
      };
      if (email.remitente?.id) body['account-id'] = email.remitente.id;
      const r = await fetch('https://app.stelorder.com/app/incidents', {
        method: 'POST',
        headers: { 'APIKEY': process.env.STELORDER_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const inc = await r.json();
      stelOrderRef = `INC — ID: ${inc.id || 'creada'}`;
      mensajeRespuesta = `Hola,\n\nHemos recibido tu solicitud y hemos abierto una incidencia en nuestro sistema.\n\nReferencia: ${inc['full-reference'] || stelOrderRef}\n\nUno de nuestros operarios se encargará en breve.\n\nCorp Projects`;
    }

    if (accion === 'CREAR_PRESUPUESTO') {
      const body = { title: datos?.titulo || email.asunto, comments: datos?.comentarios || email.resumen };
      if (email.remitente?.id) body['account-id'] = email.remitente.id;
      if (body['account-id']) {
        const r = await fetch('https://app.stelorder.com/app/workEstimates', {
          method: 'POST',
          headers: { 'APIKEY': process.env.STELORDER_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const est = await r.json();
        stelOrderRef = `Presupuesto — ID: ${est.id || 'creado'}`;
      } else {
        stelOrderRef = 'Presupuesto pendiente — sin cliente vinculado';
      }
      mensajeRespuesta = `Hola,\n\nHemos recibido tu solicitud de presupuesto.\n\nEstamos preparando una propuesta y nos pondremos en contacto contigo en breve.\n\nCorp Projects`;
    }

    if (accion === 'MARCAR_PAGADO') {
      stelOrderRef = 'Pago registrado manualmente';
    }

    if (mensajeRespuesta && datos?.enviarRespuesta !== false) {
      const emailDe = email.de.match(/<(.+)>/)?.[1] || email.de;
      await enviarRespuesta(emailDe, email.asunto, mensajeRespuesta);
    }

    await db.collection('emails').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { estado: 'GESTIONADO', leido: true, accionRealizada: accion, stelOrderRef, gestionadoEn: new Date() } }
    );
    await client.close();
    res.json({ ok: true, stelOrderRef, mensajeRespuesta });
  } catch (err) {
    console.error('[Emails] Error acción:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/emails/poll', requireAuth, async (req, res) => {
  try {
    pollEmails().catch(err => console.error('[Emails] Error poll manual:', err.message));
    res.json({ message: 'Poll iniciado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/emails/stats', requireAuth, async (req, res) => {
  try {
    const { db, client } = await getDB();
    const pendientes = await db.collection('emails').countDocuments({ estado: 'PENDIENTE' });
    const noLeidos   = await db.collection('emails').countDocuments({ leido: false });
    const urgentes   = await db.collection('emails').countDocuments({ estado: 'PENDIENTE', urgencia: 'ALTA' });
    await client.close();
    res.json({ pendientes, noLeidos, urgentes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ── COLABORADORES EXTERNOS ────────────────────────────────────────
const colaboradores = require('./colaboradores');

// ── PLANTILLA ÚNICA DE TRABAJADORES ───────────────────────────────
const trabajadores = require('./trabajadores');
app.get('/api/trabajadores', requireAuth, async (req, res) => {
  try { res.json({ trabajadores: await trabajadores.getTrabajadores(req.query.activos === '1') }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/trabajadores/diag', requireAuth, async (req, res) => {
  try { res.json(await trabajadores.diag()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/trabajadores/seed', requireAuth, async (req, res) => {
  try { res.json(await trabajadores.seedDesdeConfig()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/trabajadores/reconciliar', requireAuth, async (req, res) => {
  try { res.json(await trabajadores.aplicarReconciliacion()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/trabajadores/:id', requireAuth, async (req, res) => {
  try { const t = await trabajadores.getTrabajador(req.params.id); if (!t) return res.status(404).json({ error: 'No encontrado' }); res.json(t); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/trabajadores', requireAuth, async (req, res) => {
  try { res.json(await trabajadores.createTrabajador(req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.put('/api/trabajadores/:id', requireAuth, async (req, res) => {
  try { res.json(await trabajadores.updateTrabajador(req.params.id, req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/trabajadores/:id/baja', requireAuth, async (req, res) => {
  try { res.json(await trabajadores.bajaTrabajador(req.params.id, req.body && req.body.fecha)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.get('/api/trabajadores/:id/saldo', requireAuth, async (req, res) => {
  try { res.json(await trabajadores.getSaldoTrab(req.params.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/trabajadores/:id/movimientos', requireAuth, async (req, res) => {
  try { res.json({ movimientos: await trabajadores.getMovimientosTrab(req.params.id) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/trabajadores/:id/movimientos', requireAuth, async (req, res) => {
  try { res.json(await trabajadores.addMovimientoTrab(req.params.id, req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/trabajadores/movimientos/:movId', requireAuth, async (req, res) => {
  try { await trabajadores.deleteMovimientoTrab(req.params.movId); res.json({ ok: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/colaboradores', requireAuth, async (req, res) => {
  try { res.json(await colaboradores.getColaboradores()); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/colaboradores/resumen', requireAuth, async (req, res) => {
  try { res.json(await colaboradores.getResumenTodosColaboradores()); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/colaboradores/:id', requireAuth, async (req, res) => {
  try { res.json(await colaboradores.getSaldoColaborador(req.params.id)); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/colaboradores', requireAuth, async (req, res) => {
  try { res.json(await colaboradores.createColaborador(req.body)); }
  catch(err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/colaboradores/:id', requireAuth, async (req, res) => {
  try { await colaboradores.updateColaborador(req.params.id, req.body); res.json({ ok: true }); }
  catch(err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/colaboradores/:id/movimientos', requireAuth, async (req, res) => {
  try {
    const { from, to, limit } = req.query;
    res.json(await colaboradores.getMovimientos(req.params.id, { from, to, limit: limit ? Number(limit) : undefined }));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/colaboradores/:id/movimientos', requireAuth, async (req, res) => {
  try { res.json(await colaboradores.createMovimiento(req.params.id, req.body)); }
  catch(err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/colaboradores/movimientos/:id', requireAuth, async (req, res) => {
  try { await colaboradores.deleteMovimiento(req.params.id); res.json({ ok: true }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/colaboradores/:id', requireAuth, async (req, res) => {
  try {
    const { db, client } = await getDB();
    await db.collection('colaborador_movimientos').deleteMany({ colaboradorId: req.params.id });
    await db.collection('colaboradores').deleteOne({ _id: new ObjectId(req.params.id) });
    await client.close();
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── PROYECTOS DE INVERSIÓN ────────────────────────────────────────
app.get('/api/proyectos', requireAuth, async (req, res) => {
  try { res.json(await colaboradores.getProyectos()); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/proyectos/:id', requireAuth, async (req, res) => {
  try { res.json(await colaboradores.getProyecto(req.params.id)); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/proyectos', requireAuth, async (req, res) => {
  try { res.json(await colaboradores.createProyecto(req.body)); }
  catch(err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/proyectos/:id', requireAuth, async (req, res) => {
  try { await colaboradores.updateProyecto(req.params.id, req.body); res.json({ ok: true }); }
  catch(err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/proyectos/:id/movimientos', requireAuth, async (req, res) => {
  try { res.json(await colaboradores.addMovimientoProyecto(req.params.id, req.body)); }
  catch(err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/proyectos/movimientos/:id', requireAuth, async (req, res) => {
  try { await colaboradores.deleteMovimientoProyecto(req.params.id); res.json({ ok: true }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});
// ── PAGOS EN EFECTIVO ─────────────────────────────────────────────
const pagos = require('./pagos');

app.get('/api/pagos/resumen', requireAuth, async (req, res) => {
  try {
    const { from, to } = req.query;
    res.json(await pagos.getResumenPagos({ from, to }));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/pagos', requireAuth, async (req, res) => {
  try {
    const { persona, tipo, from, to, limit, skip } = req.query;
    res.json(await pagos.getPagos({ persona, tipo, from, to, limit: parseInt(limit||100), skip: parseInt(skip||0) }));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/pagos/:id', requireAuth, async (req, res) => {
  try { res.json(await pagos.getPago(req.params.id)); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/pagos', requireAuth, async (req, res) => {
  try { res.json(await pagos.createPago({ ...req.body, registradoPor: 'admin' })); }
  catch(err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/pagos/:id', requireAuth, async (req, res) => {
  try { await pagos.updatePago(req.params.id, req.body); res.json({ ok: true }); }
  catch(err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/pagos/:id', requireAuth, async (req, res) => {
  try { await pagos.deletePago(req.params.id); res.json({ ok: true }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Rutas HTML ────────────────────────────────────────────────────
app.get('/informe-presencia', (req, res) => res.sendFile(path.join(__dirname, '../public/informe-presencia.html')));
app.get('/parte', (req, res) => res.sendFile(path.join(__dirname, '../public/parte.html')));
app.get('/fichar', (req, res) => res.sendFile(path.join(__dirname, '../public/fichar.html')));
app.get('/fichajes', (req, res) => res.sendFile(path.join(__dirname, '../public/fichajes.html')));
app.get('/gps', (req, res) => res.sendFile(path.join(__dirname, '../public/gps.html')));
app.get('/subir-factura', (req, res) => res.sendFile(path.join(__dirname, '../public/subir-factura.html')));
app.get('/asignar-facturas', (req, res) => res.sendFile(path.join(__dirname, '../public/asignar-facturas.html')));
app.get('/activos', (req, res) => res.sendFile(path.join(__dirname, '../public/activos.html')));
app.get('/medir', (req, res) => res.sendFile(path.join(__dirname, '../public/medir.html')));
app.get('/catalogo', (req, res) => res.sendFile(path.join(__dirname, '../public/catalogo.html')));
app.get('/presupuestos', (req, res) => res.sendFile(path.join(__dirname, '../public/presupuestos.html')));
app.get('/amidaments', (req, res) => res.sendFile(path.join(__dirname, '../public/amidaments.html')));
app.get('/competencia', (req, res) => res.sendFile(path.join(__dirname, '../public/competencia.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

app.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════════╗`);
  console.log(`║   Corp Projects Dashboard v3           ║`);
  console.log(`╚════════════════════════════════════════╝`);
  console.log(`🚀 Puerto: ${PORT}`);
  console.log(`📊 StelOrder: ${process.env.STELORDER_API_KEY ? '✅' : '❌'}`);
  console.log(`🎙️ Transcripción de voz (STT): ${process.env.STT_API_KEY ? '✅' : '❌ (define STT_API_KEY)'}`);
  console.log(`📧 Email: ${process.env.EMAIL_USER ? '✅' : '⚠️'}`);
  console.log(`💬 WhatsApp: ${process.env.TWILIO_ACCOUNT_SID ? '✅' : '⚠️ Pendiente'}\n`);
  startScheduler();

  // Health-check de los modelos IA (§1): un ping mínimo a cada modelo configurado.
  // Un modelo caducado/no disponible se ve AQUÍ en el deploy, no cuando escribe un cliente.
  (async () => {
    const CONFIG = require('./config');
    const { pingIA } = require('./asistente');
    for (const [label, model] of [['clasificador', CONFIG.ia.clasificador], ['agente', CONFIG.ia.agente]]) {
      let ok = false;
      try { ok = await pingIA(model); } catch (e) { ok = false; }
      console.log(`🤖 IA ${label}: ${ok ? '✅' : '❌ MODELO NO DISPONIBLE'} (modelo=${model})`);
      if (!ok) console.error(`⚠️⚠️⚠️ IA ${label} NO RESPONDE (modelo=${model}). Revisa el ID del modelo / plan Anthropic: el bot no clasificará bien hasta arreglarlo.`);
    }
  })().catch(e => console.error('[IA health]', e.message));
});

module.exports = app;
