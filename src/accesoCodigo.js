// src/accesoCodigo.js — ENTRAR A FICHAR SIN LA LISTA DE NOMBRES (4/11/2026, Álex: «que a cada uno solo le salga lo suyo;
// que pongan su móvil o su email y les llegue el PIN, o que se hagan el suyo, sin que tengamos que pasárselo»).
//  1. En /fichar escribe su móvil o su email → le llega un código de 6 cifras por WhatsApp (móvil) o por correo.
//  2. Con el código entra y ese móvil queda recordado (sesión de 60 días; «Salir» la cierra).
//  3. Si quiere, se pone su propio PIN: la próxima vez sale «Hola, David · tu PIN» (el móvil recuerda quién es).
// Seguridad: el código caduca a los 10 min y vale 5 intentos; máximo 3 códigos cada 15 min por móvil/email; se guarda
// solo su huella (sha256); la respuesta es la misma exista o no la persona (no sirve para averiguar quién trabaja aquí).
//
//   accesoCodigos { _id: '<móvil 9 cifras | email>', userId, hash, expira, intentos, envios: [Date] }
'use strict';
const crypto = require('crypto');
const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const COL = 'accesoCodigos';
const CADUCA_MS = 10 * 60 * 1000, MAX_INTENTOS = 5, MAX_ENVIOS = 3, VENTANA_ENVIOS_MS = 15 * 60 * 1000;
const SESION_DIAS = 60;

// «648 53 64 89», «+34648536489», «Alex@Gmail.com » → clave única
function normContacto(s) {
  const t = String(s || '').trim().toLowerCase();
  if (!t) return null;
  if (t.includes('@')) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t : null;
  const d = t.replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : null;
}
const ultimos9 = s => String(s || '').replace(/\D/g, '').slice(-9);
const huella = (codigo, userId) => crypto.createHash('sha256').update(`${codigo}:${userId}`).digest('hex');

// Trabajador activo con ese móvil o email (si hay más de uno con el mismo, ninguno: que lo arregle la oficina).
function buscar(usuarios, clave) {
  const l = (usuarios || []).filter(u => u.active !== false && (clave.includes('@')
    ? String(u.email || '').trim().toLowerCase() === clave
    : [u.telefono, u.whatsapp].some(t => t && ultimos9(t) === clave)));
  return l.length === 1 ? l[0] : null;
}

async function pedir(contacto, { _db = null, _usuarios = null, _whatsapp = null, _email = null, ahora = Date.now() } = {}) {
  const clave = normContacto(contacto);
  if (!clave) throw new Error(String(contacto || '').includes('@') ? 'Ese email no parece bien escrito' : 'Escribe tu móvil (9 cifras) o tu email');
  const via = clave.includes('@') ? 'email' : 'whatsapp';
  const db = _db || await getDB();
  const prev = await db.collection(COL).findOne({ _id: clave });
  const envios = ((prev && prev.envios) || []).filter(f => ahora - new Date(f).getTime() < VENTANA_ENVIOS_MS);
  if (envios.length >= MAX_ENVIOS) throw new Error('Ya te hemos mandado varios códigos. Espera unos minutos y vuelve a probar');
  const u = buscar(_usuarios || await require('./users').getUsers(false), clave);
  // Exista o no, la respuesta es la misma; solo se guarda y se manda si existe.
  if (!u) { console.log('[Acceso] código pedido para un contacto que no está dado de alta:', via); return { ok: true, via }; }
  const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await db.collection(COL).updateOne({ _id: clave }, { $set: { userId: String(u._id), hash: huella(codigo, String(u._id)), expira: new Date(ahora + CADUCA_MS), intentos: 0, envios: [...envios, new Date(ahora)] } }, { upsert: true });
  const nombre = String(u.name || '').split(/\s+/)[0];
  const texto = `🔐 ${nombre}, tu código para entrar en la app de Corp es *${codigo}*.\nCaduca en 10 minutos. Si no lo has pedido tú, no hagas nada.`;
  if (via === 'whatsapp') {
    const tel = u.whatsapp || u.telefono;
    await (_whatsapp || ((to, t) => require('./notifications').sendWhatsAppTo(to, t, { siempre: true, permitirRepetido: true, sinTraducir: false })))(tel, texto);
  } else {
    await (_email || (o => require('./notifications').sendEmail(o)))({ to: u.email, subject: `Tu código para entrar: ${codigo}`,
      text: texto.replace(/\*/g, ''), html: `<p>Hola ${nombre},</p><p>Tu código para entrar en la app de Corp Projects es:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${codigo}</p><p>Caduca en 10 minutos. Si no lo has pedido tú, no hagas nada.</p>` });
  }
  return { ok: true, via };
}

// Comprueba el código y abre una sesión de trabajador recordada en ese móvil.
async function verificar(contacto, codigo, { _db = null, _usuarios = null, ahora = Date.now() } = {}) {
  const clave = normContacto(contacto);
  const c = String(codigo || '').replace(/\D/g, '');
  if (!clave || c.length !== 6) throw new Error('Escribe las 6 cifras del código');
  const db = _db || await getDB();
  const d = await db.collection(COL).findOne({ _id: clave });
  const mal = new Error('Código incorrecto o caducado. Pide uno nuevo');
  if (!d || !d.hash || new Date(d.expira).getTime() < ahora) throw mal;
  if ((d.intentos || 0) >= MAX_INTENTOS) throw new Error('Demasiados intentos. Pide un código nuevo');
  const ok = crypto.timingSafeEqual(Buffer.from(huella(c, d.userId), 'hex'), Buffer.from(d.hash, 'hex'));
  if (!ok) { await db.collection(COL).updateOne({ _id: clave }, { $set: { intentos: (d.intentos || 0) + 1 } }); throw mal; }
  await db.collection(COL).updateOne({ _id: clave }, { $set: { hash: null, intentos: 0 } });   // el código ya no vale otra vez
  const u = (_usuarios || await require('./users').getUsers(false)).find(x => String(x._id) === d.userId && x.active !== false);
  if (!u) throw mal;
  const token = 'w_' + crypto.randomBytes(16).toString('hex');
  await db.collection('worker_tokens').insertOne({ token, workerId: String(u._id), workerName: u.name, workerRole: u.role, origen: 'codigo',
    createdAt: new Date(ahora), expiresAt: new Date(ahora + SESION_DIAS * 24 * 3600 * 1000) });
  if (ObjectId.isValid(String(u._id))) await db.collection('users').updateOne({ _id: new ObjectId(String(u._id)) }, { $set: { lastLogin: new Date(ahora) } }).catch(() => {});
  // Los PIN de antes los ponía la oficina: hasta que se ponga uno suyo (pinPropio), se le propone.
  return { token, workerId: String(u._id), workerName: u.name, role: u.role, tienePin: !!(u.pin && u.pinPropio) };
}

// Su propio PIN (4 a 6 cifras). Nada de 1234, 0000 ni el mismo que otro compañero.
function pinValido(pin) {
  const p = String(pin || '');
  if (!/^\d{4,6}$/.test(p)) return 'El PIN son 4 cifras (o hasta 6)';
  if (/^(\d)\1+$/.test(p) || '0123456789'.includes(p) || '9876543210'.includes(p)) return 'Ese PIN es muy fácil de adivinar. Elige otro';
  return null;
}
async function ponerPin(workerId, pin, { _db = null, _actualizar = null } = {}) {
  const err = pinValido(pin);
  if (err) throw new Error(err);
  try { await (_actualizar || require('./users').updateUser)(String(workerId), { pin: String(pin) }); }
  catch (e) { if (/ya está en uso/.test(e.message)) throw new Error('Ese PIN no vale. Elige otro'); throw e; }   // no decir de quién es
  const db = _db || await getDB();
  if (ObjectId.isValid(String(workerId))) await db.collection('users').updateOne({ _id: new ObjectId(String(workerId)) }, { $set: { pinPropio: true, pinPropioAt: new Date() } });
  return { ok: true };
}

module.exports = { normContacto, buscar, pedir, verificar, pinValido, ponerPin, COL, SESION_DIAS };
