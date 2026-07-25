// bridge/index.js — Puente WhatsApp (Baileys) PULL / solo-salida.
//
// NO expone ningún puerto: solo hace llamadas SALIENTES al dashboard.
//   · Salida:  sondea GET  DASHBOARD_URL/api/bridge/outbox  y envía por Baileys.
//   · Entrada: cada mensaje 1-a-1 → POST DASHBOARD_URL/api/bridge/inbound.
// Autenticación con el dashboard: header X-Bridge-Token = BRIDGE_TOKEN.
// Sesión persistida en AUTH_DIR (volumen) → QR solo la primera vez.
//
// Incremento 1: SOLO texto y SOLO chats 1-a-1 (grupos = incremento 2).

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const pino = require('pino');

const DASHBOARD_URL = (process.env.DASHBOARD_URL || '').replace(/\/+$/, '');
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';
const AUTH_DIR = process.env.AUTH_DIR || '/data/auth';
const POLL_MS = Number(process.env.POLL_MS || 2000);

if (!DASHBOARD_URL || !BRIDGE_TOKEN) {
  console.error('[Bridge] Faltan DASHBOARD_URL y/o BRIDGE_TOKEN. Revisa la configuración.');
  process.exit(1);
}

const api = axios.create({ baseURL: DASHBOARD_URL, timeout: 15000, headers: { 'X-Bridge-Token': BRIDGE_TOKEN } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// +34XXXXXXXXX  ↔  34XXXXXXXXX@s.whatsapp.net
function jidToPhone(jid) {
  const n = String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  return n ? '+' + n : null;
}
function phoneToJid(to) {
  const n = String(to || '').replace(/\D/g, '');
  return `${n}@s.whatsapp.net`;
}
function extractText(message) {
  if (!message) return '';
  return message.conversation
    || (message.extendedTextMessage && message.extendedTextMessage.text)
    || (message.imageMessage && message.imageMessage.caption)
    || (message.videoMessage && message.videoMessage.caption)
    || '';
}

async function reenviarEntrante(from, body, extra) {
  try {
    await api.post('/api/bridge/inbound', { from, body, ...extra });
  } catch (e) {
    if (e.response && e.response.status === 401) console.error('[Bridge] inbound 401: BRIDGE_TOKEN no coincide con el dashboard');
    else console.error('[Bridge] inbound error:', e.message);
  }
}

async function bucleSalida(sock) {
  for (;;) {
    try {
      const { data } = await api.get('/api/bridge/outbox', { params: { limit: 10 } });
      const mensajes = (data && data.messages) || [];
      for (const m of mensajes) {
        try {
          await sock.sendMessage(phoneToJid(m.to), { text: String(m.body || '') });
          console.log('[Bridge] enviado a', m.to);
        } catch (e) { console.error('[Bridge] fallo enviando a', m.to, ':', e.message); }
      }
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
  const sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger: pino({ level: 'silent' }) });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      console.log('\n[Bridge] Escanea este QR con WhatsApp del número nuevo:');
      console.log('        WhatsApp → Dispositivos vinculados → Vincular un dispositivo\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      console.log('[Bridge] Conectado a WhatsApp ✅  — sondeando la cola cada', POLL_MS, 'ms');
    } else if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.error('[Bridge] Sesión cerrada (loggedOut). Borra el volumen de AUTH_DIR y vuelve a vincular con QR.');
      } else {
        console.log('[Bridge] Conexión cerrada (code', code, '). Reconectando…');
        start().catch((e) => console.error('[Bridge] reinicio:', e.message));
      }
    }
  });

  // ENTRADA: solo 1-a-1 y solo texto en el incremento 1.
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      try {
        if (!m.message || (m.key && m.key.fromMe)) continue;
        const jid = m.key && m.key.remoteJid;
        if (String(jid || '').endsWith('@g.us')) continue; // grupos = incremento 2
        const from = jidToPhone(jid);
        const body = extractText(m.message).trim();
        if (from && body) await reenviarEntrante(from, body, { chatId: jid, isGroup: false });
      } catch (e) { console.error('[Bridge] upsert error:', e.message); }
    }
  });

  bucleSalida(sock); // arranca el pull en paralelo
}

start().catch((e) => { console.error('[Bridge] fatal:', e.message); process.exit(1); });
