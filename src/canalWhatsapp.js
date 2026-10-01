// src/canalWhatsapp.js — Selector de transporte de salida de WhatsApp.
//
// Elige entre Twilio (actual) y el puente Baileys (Fase 8), por mensaje o por
// la variable CANAL_WHATSAPP=bridge|twilio (default 'twilio' → igual que hoy).
//
// Arquitectura del puente = PULL / solo-salida: el dashboard NO llama al puente.
// La rama 'bridge' encola en la colección Mongo `whatsappOutbox`; el puente
// (en el VPS) sondea GET /api/bridge/outbox y envía. Así el puente no expone
// ningún puerto público: solo hace llamadas salientes.
//
// El troceo de mensajes largos se mantiene en quien llama (server.enviarWhatsApp).

const OUTBOX = 'whatsappOutbox';
// Aviso en memoria de «hay mensaje nuevo en el buzón»: el long-poll del puente espera a este evento
// en vez de consultar Mongo cada 2 s por petición (con varios bucles del puente abiertos a la vez,
// eso saturaba el pool de conexiones y todo el dashboard iba lento).
const _aviso = new (require('events'))(); _aviso.setMaxListeners(500);
function esperarNuevo(ms) { return new Promise(res => { const t = setTimeout(() => { _aviso.off('nuevo', f); res(false); }, ms); const f = () => { clearTimeout(t); res(true); }; _aviso.once('nuevo', f); }); }
// Métricas del puente en memoria (para /diag): sondeos del último minuto y peticiones abiertas ahora.
const _sondeos = []; let _abiertos = 0;
function registrarSondeo(delta) { if (delta > 0) { const now = Date.now(); _sondeos.push(now); while (_sondeos.length && now - _sondeos[0] > 60000) _sondeos.shift(); } _abiertos = Math.max(0, _abiertos + delta); }
function metricasPuente() { const now = Date.now(); while (_sondeos.length && now - _sondeos[0] > 60000) _sondeos.shift(); return { sondeosUltimoMinuto: _sondeos.length, peticionesAbiertas: _abiertos }; }
let _ultimoLatido = 0;

function canalActivo(override) {
  const c = String(override || process.env.CANAL_WHATSAPP || 'twilio').toLowerCase();
  return c === 'bridge' ? 'bridge' : 'twilio';
}

async function _twilioUno(to, body) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    console.log('[Canal] Twilio no configurado. Para', to, ':', String(body).slice(0, 80));
    return false;
  }
  const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const dest = /^whatsapp:/i.test(to) ? to : `whatsapp:${to}`;
  await client.messages.create({ from: process.env.TWILIO_WHATSAPP_FROM, to: dest, body: String(body || '') });
  return true;
}

// Salida por el puente = ENCOLAR en Mongo. El puente lo recogerá por pull.
async function encolarSalida(to, body) {
  const db = await require('./db').getDB();
  const dest = String(to || '').replace(/^whatsapp:/i, ''); // el puente usa el número tal cual (+34…)
  await db.collection(OUTBOX).insertOne({ to: dest, body: String(body || ''), ts: new Date(), status: 'pending' });
  _aviso.emit('nuevo');
  console.log(`[Canal] respuesta encolada para el puente → to=${dest} | "${String(body || '').slice(0, 40)}"`);
  return true;
}

// Reclama atómicamente hasta `limit` mensajes pendientes (findOneAndUpdate marca
// cada uno 'sent' en la misma operación → sin doble entrega aunque haya varios
// sondeos). Actualiza bridgeStatus.lastSeen como heartbeat del puente.
async function reclamarLoteOutbox(limit = 10) {
  const db = await require('./db').getDB();
  // Latido como mucho cada 15 s (antes, en cada consulta de cada sondeo).
  if (Date.now() - _ultimoLatido > 15000) {
    _ultimoLatido = Date.now();
    try { await db.collection('bridgeStatus').updateOne({ _id: 'bridge' }, { $set: { lastSeen: new Date() } }, { upsert: true }); }
    catch (e) { /* el heartbeat no debe tumbar la respuesta */ }
  }

  const max = Math.max(1, Math.min(Number(limit) || 10, 50));
  const lote = [];
  for (let i = 0; i < max; i++) {
    const r = await db.collection(OUTBOX).findOneAndUpdate(
      { status: 'pending' },
      { $set: { status: 'sent', sentAt: new Date() } },
      { sort: { ts: 1 }, returnDocument: 'after' }
    );
    const doc = r ? (r.value !== undefined ? r.value : r) : null; // driver v6 devuelve el doc; compat con {value}
    if (!doc) break;
    lote.push({ id: String(doc._id), to: doc.to, body: doc.body });
  }
  return lote;
}

// Trocea un mensaje largo por debajo del límite de Twilio (1600). Corta preferentemente
// por saltos de línea; si no hay uno cerca, corta en duro. Red de seguridad para los
// caminos que no pasan por enviarWhatsApp (p.ej. notifications.js).
function _trocear(body, max = 1500) {
  const s = String(body || '');
  if (s.length <= max) return [s];
  const partes = [];
  let resto = s;
  while (resto.length > max) {
    let corte = resto.lastIndexOf('\n', max);
    if (corte < max * 0.5) corte = max; // sin salto de línea cerca → corte en duro
    partes.push(resto.slice(0, corte));
    resto = resto.slice(corte).replace(/^\n/, '');
  }
  if (resto) partes.push(resto);
  return partes;
}

// ¿Es un destinatario plausible? Evita el spam de "whatsapp:undefined".
function _destinoValido(to) {
  const s = String(to || '').trim();
  if (!s || /(^|:)(undefined|null)$/i.test(s)) return false;
  return /\d{6,}/.test(s); // un teléfono real tiene al menos varios dígitos
}

// Despacha UN trozo por el canal elegido (con respaldo Twilio si el puente falla).
async function _dispatch(to, body, { canal, fallbackTwilio = true } = {}) {
  const usar = canalActivo(canal);
  try {
    return usar === 'bridge' ? await encolarSalida(to, body) : await _twilioUno(to, body);
  } catch (err) {
    console.error(`[Canal] Error enviando por ${usar}:`, err.message);
    if (usar === 'bridge' && fallbackTwilio) {
      console.warn('[Canal] No pude encolar para el puente; reintento por Twilio (respaldo)…');
      try { return await _twilioUno(to, body); } catch (e2) { console.error('[Canal] Twilio respaldo falló:', e2.message); }
    }
    return false;
  }
}

// Envía UN mensaje por el canal elegido. Choke point de TODOS los envíos:
//  (1) descarta destinatarios inválidos (no más 'whatsapp:undefined'),
//  (2) trocea si supera el límite de Twilio (cubre a quien no pasa por enviarWhatsApp).
async function enviarUno(to, body, opts = {}) {
  if (!_destinoValido(to)) {
    console.warn('[Canal] destinatario inválido, no se envía:', JSON.stringify(to));
    return false;
  }
  const partes = _trocear(body, 1500);
  let ok = true;
  for (let i = 0; i < partes.length; i++) {
    const prefijo = partes.length > 1 ? `(${i + 1}/${partes.length}) ` : '';
    const r = await _dispatch(to, prefijo + partes[i], opts);
    ok = ok && r;
  }
  // Registro de conversaciones (Dashboard → Conversaciones). Nunca rompe el envío.
  require('./waLog').registrar({ dir: 'out', canal: canalActivo(opts.canal), numero: to, texto: body, ok }).catch(() => {});
  return ok;
}

// Valida el secreto del puente en tiempo constante y sin fuga de longitud.
// Sin BRIDGE_TOKEN configurado → false SIEMPRE (endpoints cerrados). El token
// NUNCA se loguea. Es la única barrera de /api/bridge/inbound y /outbox.
function tokenBridgeValido(provided) {
  const crypto = require('crypto');
  const expected = process.env.BRIDGE_TOKEN;
  if (!expected) return false;
  const a = crypto.createHash('sha256').update(String(provided || '')).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// Estado de la sesión de WhatsApp informado por el puente en cada sondeo.
async function guardarEstadoPuente(estado) {
  const db = await require('./db').getDB();
  await db.collection('bridgeStatus').updateOne({ _id: 'bridge' }, { $set: { lastSeen: new Date(), estado: String(estado).slice(0, 20), estadoAt: new Date() } }, { upsert: true });
}
// Confirmaciones de entrega del puente → delivered | failed (+ error).
async function confirmarEntregas(acks) {
  const db = await require('./db').getDB(); const { ObjectId } = require('mongodb'); let n = 0;
  for (const a of (acks || []).slice(0, 100)) {
    if (!a || !a.id) continue;
    let _id; try { _id = new ObjectId(String(a.id)); } catch (e) { continue; }
    const set = a.ok ? { status: 'delivered', deliveredAt: new Date() } : { status: 'failed', failedAt: new Date(), error: String(a.error || 'error').slice(0, 300) };
    const r = await db.collection(OUTBOX).updateOne({ _id }, { $set: set }); n += r.modifiedCount || 0;
  }
  return n;
}

// ── DIAGNÓSTICO (pantalla /diag, solo Dueño) ─────────────────────
// Estado de los dos canales sin enseñar secretos: si hay credenciales, cuándo sondeó el puente
// por última vez, qué hay en su buzón, y los últimos mensajes de Twilio con su código de error.
const _mask = t => { const s = String(t || ''); return s.length > 6 ? s.slice(0, 4) + '…' + s.slice(-3) : s; };
async function diagnostico() {
  const db = await require('./db').getDB();
  const out = { canalActivo: canalActivo(), config: {
    TWILIO_ACCOUNT_SID: !!process.env.TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN: !!process.env.TWILIO_AUTH_TOKEN,
    TWILIO_WHATSAPP_FROM: process.env.TWILIO_WHATSAPP_FROM || null, BRIDGE_TOKEN: !!process.env.BRIDGE_TOKEN,
    CANAL_WHATSAPP: process.env.CANAL_WHATSAPP || '(sin definir → twilio)', TWILIO_VALIDATE: process.env.TWILIO_VALIDATE || 'log' } };
  // Puente
  try {
    const st = await db.collection('bridgeStatus').findOne({ _id: 'bridge' });
    const lastSeen = st && st.lastSeen ? new Date(st.lastSeen) : null;
    const pend = await db.collection(OUTBOX).find({ status: 'pending' }).sort({ ts: 1 }).limit(50).toArray();
    const ult = await db.collection(OUTBOX).find({}).sort({ ts: -1 }).limit(10).toArray();
    const sondea = !!(lastSeen && Date.now() - lastSeen < 90000);
    const confirmados = await db.collection(OUTBOX).countDocuments({ status: { $in: ['delivered', 'failed'] } });
    out.puente = { ultimoSondeo: lastSeen, segundosDesdeSondeo: lastSeen ? Math.round((Date.now() - lastSeen) / 1000) : null,
      sondea, estadoSesion: (st && st.estado) || null, estadoAt: (st && st.estadoAt) || null, informaEstado: !!(st && st.estado), confirmaEntregas: confirmados > 0,
      conectado: sondea && (!(st && st.estado) || st.estado === 'open'), ...metricasPuente(), pendientes: pend.length, pendienteMasAntiguo: pend[0] ? pend[0].ts : null,
      ultimos: ult.map(m => ({ to: _mask(m.to), status: m.status, ts: m.ts, sentAt: m.sentAt || null, error: m.error || null, texto: String(m.body || '').slice(0, 50) })) };
  } catch (e) { out.puente = { error: e.message }; }
  // Entradas recientes (webhook de Twilio y puente)
  try { const w = await db.collection('webhookSeen').find({}).sort({ ts: -1 }).limit(1).toArray(); out.ultimaEntradaTwilio = w[0] ? w[0].ts : null; } catch (e) {}
  // Twilio: cuenta + últimos mensajes con su error
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    try {
      const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const acc = await client.api.v2010.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
      out.twilio = { cuenta: { estado: acc.status, tipo: acc.type } };
      const msgs = await client.messages.list({ limit: 15 });
      out.twilio.ultimos = msgs.map(m => ({ fecha: m.dateCreated, direccion: m.direction, to: _mask(m.to), from: _mask(m.from), estado: m.status, errorCode: m.errorCode || null, errorMessage: m.errorMessage || null, texto: String(m.body || '').slice(0, 50) }));
    } catch (e) { out.twilio = { error: e.message, code: e.code || null, status: e.status || null }; }
  } else out.twilio = { error: 'Faltan TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN' };
  return out;
}
// Envío de prueba por un canal concreto, devolviendo el ERROR real (no solo true/false).
async function probar(to, canal) {
  if (!_destinoValido(to)) return { ok: false, error: 'Número no válido' };
  const texto = 'Prueba de Corp Projects (' + canal + ') · ' + new Date().toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid' });
  try {
    if (canal === 'bridge') { await encolarSalida(to, texto); return { ok: true, nota: 'Encolado: el puente debe recogerlo en menos de 30 s. Mira el buzón en 1 minuto.' }; }
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return { ok: false, error: 'Twilio no configurado' };
    const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const dest = /^whatsapp:/i.test(to) ? to : `whatsapp:${to}`;
    const m = await client.messages.create({ from: process.env.TWILIO_WHATSAPP_FROM, to: dest, body: texto });
    await new Promise(r => setTimeout(r, 4000));
    const f = await client.messages(m.sid).fetch();
    return { ok: !f.errorCode, estado: f.status, errorCode: f.errorCode || null, errorMessage: f.errorMessage || null };
  } catch (e) { return { ok: false, error: e.message, code: e.code || null }; }
}

module.exports = { enviarUno, canalActivo, tokenBridgeValido, encolarSalida, reclamarLoteOutbox, diagnostico, probar, guardarEstadoPuente, confirmarEntregas, esperarNuevo, registrarSondeo, metricasPuente };
