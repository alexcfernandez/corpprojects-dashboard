// bridge/index.js — Puente WhatsApp (Baileys) PULL / solo-salida.
//
// NO expone ningún puerto: solo hace llamadas SALIENTES al dashboard.
//   · Salida:  sondea GET  DASHBOARD_URL/api/bridge/outbox  y envía por Baileys.
//   · Entrada: cada mensaje 1-a-1 → POST DASHBOARD_URL/api/bridge/inbound.
// Autenticación con el dashboard: header X-Bridge-Token = BRIDGE_TOKEN.
// Sesión persistida en AUTH_DIR (volumen) → QR solo la primera vez.
//
// Incremento 2: fotos, PDF y notas de voz (1-a-1 y grupos AUTORIZADOS). De un grupo NO
// autorizado solo se avisa de que existe (nombre + id), sin leer ni reenviar su contenido.
// La lista de grupos autorizados la da el dashboard (GET /api/bridge/config), así que
// activar un grupo no obliga a reconstruir el contenedor.

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage, extractMessageContent } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const pino = require('pino');

const DASHBOARD_URL = (process.env.DASHBOARD_URL || '').replace(/\/+$/, '');
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';
const AUTH_DIR = process.env.AUTH_DIR || '/data/auth';
const POLL_MS = Number(process.env.POLL_MS || 2000);
const MEDIA_MAX_MB = Number(process.env.MEDIA_MAX_MB || 16);   // más grande no se descarga (se avisa)

if (!DASHBOARD_URL || !BRIDGE_TOKEN) {
  console.error('[Bridge] Faltan DASHBOARD_URL y/o BRIDGE_TOKEN. Revisa la configuración.');
  process.exit(1);
}

// timeout 40 s: holgado frente a la espera del dashboard (10 s), para no colgar nunca antes que él.
const api = axios.create({ baseURL: DASHBOARD_URL, timeout: 40000, headers: { 'X-Bridge-Token': BRIDGE_TOKEN } });

// Estado compartido. Antes cada reconexión arrancaba OTRO bucle de salida y el viejo seguía vivo
// con el socket muerto: recogía mensajes del buzón y los perdía. Ahora hay UN solo bucle que usa
// siempre el socket actual y solo recoge mensajes cuando WhatsApp está conectado ('open').
let sockActual = null;
let estado = 'connecting'; // connecting | open | close | loggedOut
let bucleArrancado = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// REENVÍO cuando el móvil que recibe no pudo descifrar el mensaje (le sale «Esperando el mensaje»; pasa sobre todo con
// contactos nuevos): WhatsApp pide un reintento y Baileys necesita el mensaje original (getMessage) y un contador de
// reintentos. Se guardan en memoria los últimos 500 enviados (los reintentos llegan en segundos o minutos).
const enviados = new Map();
function guardarEnviado(msg) {
  if (!msg || !msg.key || !msg.key.id || !msg.message) return;
  enviados.set(msg.key.id, msg.message);
  if (enviados.size > 500) enviados.delete(enviados.keys().next().value);
}
const contadorReintentos = (() => {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => { m.set(k, v); if (m.size > 2000) m.delete(m.keys().next().value); }, del: (k) => { m.delete(k); }, flushAll: () => m.clear() };
})();

// +34XXXXXXXXX  ↔  34XXXXXXXXX@s.whatsapp.net
function jidToPhone(jid) {
  const n = String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  return n ? '+' + n : null;
}
function phoneToJid(to) {
  const n = String(to || '').replace(/\D/g, '');
  return `${n}@s.whatsapp.net`;
}
// --- LID: WhatsApp puede entregar un JID @lid en vez del telefono real ---
const chatPorTelefono = new Map(); // digitos del telefono -> JID original del chat
function soloDigitos(x) { return String(x || '').replace(/\D/g, ''); }
async function jidRealDelMensaje(sock, m) {
  const k = (m && m.key) || {};
  for (const c of [k.remoteJid, k.remoteJidAlt, k.senderPn, k.participantAlt]) {
    if (c && String(c).endsWith('@s.whatsapp.net')) return c;
  }
  try {
    const lm = sock && sock.signalRepository && sock.signalRepository.lidMapping;
    if (lm && typeof lm.getPNForLID === 'function' && k.remoteJid) {
      const pn = await lm.getPNForLID(k.remoteJid);
      if (pn && String(pn).endsWith('@s.whatsapp.net')) return pn;
    }
  } catch (e) {}
  return k.remoteJid || null; // si nada resuelve, dejamos el LID (no rompemos)
}

function extractText(message) {
  const c = message ? (extractMessageContent(message) || message) : null;
  if (!c) return '';
  return c.conversation
    || (c.extendedTextMessage && c.extendedTextMessage.text)
    || (c.imageMessage && c.imageMessage.caption)
    || (c.videoMessage && c.videoMessage.caption)
    || (c.documentMessage && c.documentMessage.caption)
    || '';
}

// ¿Trae foto, documento (PDF/imagen) o nota de voz? → { kind, mimetype, fileName, bytes }
function infoMedia(message) {
  const c = message ? (extractMessageContent(message) || message) : null;
  if (!c) return null;
  if (c.imageMessage) return { kind: 'image', mimetype: c.imageMessage.mimetype || 'image/jpeg', fileName: null, bytes: Number(c.imageMessage.fileLength || 0) };
  if (c.documentMessage) return { kind: 'document', mimetype: c.documentMessage.mimetype || 'application/octet-stream', fileName: c.documentMessage.fileName || null, bytes: Number(c.documentMessage.fileLength || 0) };
  if (c.audioMessage) return { kind: 'audio', mimetype: c.audioMessage.mimetype || 'audio/ogg', fileName: null, bytes: Number(c.audioMessage.fileLength || 0) };
  return null;
}
async function descargarMedia(sock, m, info) {
  if (info.bytes && info.bytes > MEDIA_MAX_MB * 1024 * 1024) return { ...info, demasiadoGrande: true };
  try {
    const buf = await downloadMediaMessage(m, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
    if (!buf || !buf.length) return { ...info, error: 'vacío' };
    if (buf.length > MEDIA_MAX_MB * 1024 * 1024) return { ...info, demasiadoGrande: true };
    return { ...info, bytes: buf.length, data: buf.toString('base64') };
  } catch (e) {
    console.error('[Bridge] descarga de media:', e.message);
    return { ...info, error: e.message };
  }
}

// Grupos autorizados (los decide el dashboard). Se refresca cada 5 min.
let gruposPermitidos = new Set();
const gruposAvisados = new Map(); // jid -> ts del último aviso de "grupo visto" (1 cada 6 h)
async function cargarConfig() {
  try {
    const { data } = await api.get('/api/bridge/config');
    gruposPermitidos = new Set(((data && data.grupos) || []).map(String));
  } catch (e) { console.error('[Bridge] config:', e.message); }
}
const nombresGrupo = new Map();
async function nombreGrupo(sock, jid) {
  if (nombresGrupo.has(jid)) return nombresGrupo.get(jid);
  let n = null;
  try { const md = await sock.groupMetadata(jid); n = (md && md.subject) || null; } catch (e) {}
  nombresGrupo.set(jid, n);
  return n;
}
async function participanteReal(sock, m) {
  const k = (m && m.key) || {};
  for (const c of [k.participantPn, k.participantAlt, k.participant]) {
    if (c && String(c).endsWith('@s.whatsapp.net')) return c;
  }
  try {
    const lm = sock && sock.signalRepository && sock.signalRepository.lidMapping;
    if (lm && typeof lm.getPNForLID === 'function' && k.participant) {
      const pn = await lm.getPNForLID(k.participant);
      if (pn && String(pn).endsWith('@s.whatsapp.net')) return pn;
    }
  } catch (e) {}
  return k.participant || null;
}

async function reenviarEntrante(from, body, extra) {
  try {
    await api.post('/api/bridge/inbound', { from, body, ...extra }, { maxBodyLength: Infinity, maxContentLength: Infinity });
  } catch (e) {
    if (e.response && e.response.status === 401) console.error('[Bridge] inbound 401: BRIDGE_TOKEN no coincide con el dashboard');
    else console.error('[Bridge] inbound error:', e.message);
  }
}

async function confirmar(acks) {
  if (!acks.length) return;
  try { await api.post('/api/bridge/ack', { acks }); }
  catch (e) { console.error('[Bridge] ack error:', e.message); }
}

async function bucleSalida() {
  for (;;) {
    try {
      // Se informa el estado en cada sondeo: si no es 'open', el dashboard no entrega mensajes
      // (se quedan pendientes) y en /diag se ve «sesión desconectada».
      const { data } = await api.get('/api/bridge/outbox', { params: { limit: 10, estado } });
      const mensajes = (data && data.messages) || [];
      const acks = [];
      for (const m of mensajes) {
        try {
          if (!sockActual || estado !== 'open') throw new Error('WhatsApp no conectado (' + estado + ')');
          // Un grupo se escribe tal cual (…@g.us); un número, por su chat conocido o su JID.
          const destino = String(m.to || '').endsWith('@g.us') ? String(m.to) : (chatPorTelefono.get(soloDigitos(m.to)) || phoneToJid(m.to));
          guardarEnviado(await sockActual.sendMessage(destino, { text: String(m.body || '') }));
          console.log('[Bridge] enviado a', m.to, '->', destino);
          acks.push({ id: m.id, ok: true });
        } catch (e) {
          console.error('[Bridge] fallo enviando a', m.to, ':', e.message);
          acks.push({ id: m.id, ok: false, error: e.message });
        }
      }
      await confirmar(acks);
    } catch (e) {
      if (e.response && e.response.status === 401) console.error('[Bridge] outbox 401: BRIDGE_TOKEN no coincide con el dashboard');
      else console.error('[Bridge] outbox error:', e.message); // dashboard caído / red: se reintenta
    }
    await sleep(POLL_MS);
  }
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger: pino({ level: 'silent' }),
    msgRetryCounterCache: contadorReintentos, getMessage: async (key) => enviados.get(key.id) });
  sockActual = sock;
  estado = 'connecting';

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      console.log('\n[Bridge] Escanea este QR con WhatsApp del número nuevo:');
      console.log('        WhatsApp → Dispositivos vinculados → Vincular un dispositivo\n');
      qrcode.generate(qr, { small: true });
    }
    if (sock !== sockActual) return; // eventos de un socket viejo: se ignoran
    if (connection === 'open') {
      estado = 'open';
      console.log('[Bridge] Conectado a WhatsApp ✅  — sondeando la cola cada', POLL_MS, 'ms');
    } else if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
      if (code === DisconnectReason.loggedOut) {
        estado = 'loggedOut';
        console.error('[Bridge] Sesión cerrada (loggedOut). Borra el volumen de AUTH_DIR y vuelve a vincular con QR.');
      } else {
        estado = 'close';
        console.log('[Bridge] Conexión cerrada (code', code, '). Reconectando…');
        start().catch((e) => console.error('[Bridge] reinicio:', e.message));
      }
    }
  });

  // ENTRADA: 1-a-1 y grupos autorizados, con texto y/o media (foto, documento, audio).
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      try {
        if (!m.message || (m.key && m.key.fromMe)) continue;
        const jid = m.key && m.key.remoteJid;
        if (String(jid || '') === 'status@broadcast') continue;
        const esGrupo = String(jid || '').endsWith('@g.us');
        const body = extractText(m.message).trim();
        const info = infoMedia(m.message);
        if (esGrupo) {
          const groupName = await nombreGrupo(sock, jid);
          if (!gruposPermitidos.has(jid)) {
            // Grupo NO autorizado: solo se avisa de que existe (para poder activarlo), sin contenido.
            const t = gruposAvisados.get(jid) || 0;
            if (Date.now() - t > 6 * 3600 * 1000) { gruposAvisados.set(jid, Date.now()); await reenviarEntrante(null, '', { chatId: jid, isGroup: true, groupName, soloAviso: true }); }
            continue;
          }
          const from = jidToPhone(await participanteReal(sock, m));
          const media = info ? [await descargarMedia(sock, m, info)] : [];
          if (body || media.length) await reenviarEntrante(from, body, { chatId: jid, isGroup: true, groupName, pushName: m.pushName || null, msgId: m.key.id, media });
          continue;
        }
        const jidReal = await jidRealDelMensaje(sock, m);
        const from = jidToPhone(jidReal);
        if (from) chatPorTelefono.set(soloDigitos(from), jid);
        const media = info ? [await descargarMedia(sock, m, info)] : [];
        if (from && (body || media.length)) await reenviarEntrante(from, body, { chatId: jid, isGroup: false, pushName: m.pushName || null, msgId: m.key.id, media });
      } catch (e) { console.error('[Bridge] upsert error:', e.message); }
    }
  });

  // El bucle de salida se arranca UNA sola vez; las reconexiones solo cambian sockActual.
  if (!bucleArrancado) {
    bucleArrancado = true; bucleSalida();
    cargarConfig(); setInterval(cargarConfig, 5 * 60 * 1000);
  }
}

start().catch((e) => { console.error('[Bridge] fatal:', e.message); process.exit(1); });
