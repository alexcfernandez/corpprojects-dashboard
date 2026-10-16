// src/idiomas.js — Corpy en el idioma de cada trabajador (Álex, 16/10/2026: «al Abdellah le podríamos hablar en su
// idioma porque no se entera mucho de español»).
//
//   · En la ficha (Usuarios) cada trabajador tiene `idioma` (es por defecto).
//   · Lo que Corpy le manda sale traducido y, debajo, el original en español (para que la oficina lo entienda igual).
//   · Lo que él escribe se pasa al español antes de que Corpy lo interprete.
// Las traducciones se guardan (colección `traducciones`): los avisos de cada día son casi iguales y no se repite la llamada.

const crypto = require('crypto');
async function getDB() { return require('./db').getDB(); }

const IDIOMAS = {
  es: 'Español',
  ar: 'Árabe (dariya marroquí)',
  fr: 'Francés',
  ro: 'Rumano',
  pt: 'Portugués',
  en: 'Inglés',
  uk: 'Ucraniano',
  ca: 'Catalán',
};
const COMO = {
  ar: 'árabe marroquí (dariya) escrito en letras árabes, con palabras sencillas de la calle, como se habla en Marruecos',
  fr: 'francés sencillo', ro: 'rumano sencillo', pt: 'portugués sencillo', en: 'inglés sencillo', uk: 'ucraniano sencillo', ca: 'catalán', es: 'español sencillo',
};

const _mem = new Map();
const clave = (t, a, de) => crypto.createHash('sha1').update(`${de}>${a}:${t}`).digest('hex');

async function traducir(texto, a, { de = 'es', _llamar = null } = {}) {
  const t = String(texto || '').trim();
  if (!t || !a || a === de || !COMO[a]) return t;
  const k = clave(t, a, de);
  if (_mem.has(k)) return _mem.get(k);
  let db = null;
  if (!_llamar) { try { db = await getDB(); const c = await db.collection('traducciones').findOne({ _id: k }); if (c) { _mem.set(k, c.t); return c.t; } } catch (e) {} }
  const destino = COMO[a], origen = de === 'es' ? 'español' : (COMO[de] || 'el idioma que sea');
  const prompt = `Traduce este mensaje de WhatsApp de ${origen} a ${destino}. Es para un trabajador de una empresa de reformas (o de él para la oficina).
Reglas: NO toques los enlaces (https://…), los números, las horas, las fechas, los importes, los nombres de personas, obras, calles ni tiendas, ni los emojis. Mantén los *asteriscos* de negrita y los saltos de línea. Los nombres de botones de la app («Empiezo», «Termino la jornada», «Me olvidé de fichar», «Pausa») déjalos en español entre comillas y explica entre paréntesis qué son la primera vez. Devuelve SOLO la traducción, sin comentarios.

${t}`;
  let out = t;
  try {
    if (_llamar) out = await _llamar(prompt);
    else {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) return t;
      const c = new AbortController(); const tm = setTimeout(() => c.abort(), 30000);
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: c.signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: require('./config').ia.clasificador, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
      }).finally(() => clearTimeout(tm));
      const d = await r.json();
      if (!r.ok) throw new Error(`API ${r.status}`);
      out = (d.content || []).map(b => b.text || '').join('').trim() || t;
    }
  } catch (e) { console.warn('[Idiomas] traducir:', e.message); return t; }
  _mem.set(k, out);
  if (db) db.collection('traducciones').updateOne({ _id: k }, { $set: { t: out, a, de, at: new Date() } }, { upsert: true }).catch(() => {});
  return out;
}

// Idioma de quien tiene ese móvil (cache 10 min). null = español / no es un trabajador.
let _cache = null, _cacheAt = 0;
async function idiomaDe(numero) {
  const d = String(numero || '').replace(/\D/g, '').slice(-9);
  if (!d) return null;
  if (!_cache || Date.now() - _cacheAt > 10 * 60 * 1000) {
    try {
      const us = await require('./users').getUsers(false);
      _cache = new Map();
      for (const u of us) if (u.idioma && u.idioma !== 'es' && IDIOMAS[u.idioma]) for (const t of [u.whatsapp, u.telefono]) { const x = String(t || '').replace(/\D/g, '').slice(-9); if (x) _cache.set(x, u.idioma); }
      _cacheAt = Date.now();
    } catch (e) { return null; }
  }
  return _cache.get(d) || null;
}
function olvidar() { _cache = null; }

// Mensaje saliente: traducción arriba y el español debajo.
async function paraEnviar(numero, texto, { _idioma = undefined, _llamar = null } = {}) {
  const id = _idioma !== undefined ? _idioma : await idiomaDe(numero);
  if (!id || id === 'es' || !String(texto || '').trim()) return texto;
  const tr = await traducir(texto, id, { _llamar });
  if (!tr || tr === String(texto).trim()) return texto;
  return `${tr}\n\n— ${IDIOMAS.es} —\n${texto}`;
}

// Muchas frases cortas a la vez (la página de fichar): las que ya están guardadas salen al momento; el resto, en una
// sola llamada que devuelve una lista JSON en el mismo orden.
async function traducirLote(textos, a, { _llamar = null } = {}) {
  const lista = [...new Set((textos || []).map(t => String(t || '').trim()).filter(t => t && t.length <= 400))].slice(0, 150);
  const out = {};
  if (!a || a === 'es' || !COMO[a]) { lista.forEach(t => { out[t] = t; }); return out; }
  let db = null; try { if (!_llamar) db = await getDB(); } catch (e) {}
  const faltan = [];
  const ks = lista.map(t => [t, clave(t, a, 'es')]);
  const enDb = db ? await db.collection('traducciones').find({ _id: { $in: ks.filter(([t, k]) => !_mem.has(k)).map(([, k]) => k) } }).toArray().catch(() => []) : [];
  const porK = new Map(enDb.map(x => [x._id, x.t]));
  for (const [t, k] of ks) { const v = _mem.get(k) || porK.get(k); if (v) { _mem.set(k, v); out[t] = v; } else faltan.push(t); }
  if (!faltan.length) return out;
  const prompt = `Traduce cada frase de la app de fichar de una empresa de reformas, del español a ${COMO[a]}. Son textos de pantalla (botones, avisos, títulos). NO toques números, horas, fechas, nombres propios de personas, obras o calles, ni emojis. Devuelve SOLO una lista JSON de cadenas, en el mismo orden y con el mismo número de elementos (${faltan.length}).

${JSON.stringify(faltan)}`;
  try {
    let txt;
    if (_llamar) txt = await _llamar(prompt);
    else {
      const key = process.env.ANTHROPIC_API_KEY; if (!key) return out;
      const c = new AbortController(); const tm = setTimeout(() => c.abort(), 60000);
      const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: c.signal, headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: require('./config').ia.clasificador, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }) }).finally(() => clearTimeout(tm));
      const d = await r.json(); if (!r.ok) throw new Error(`API ${r.status}`);
      txt = (d.content || []).map(b => b.text || '').join('');
    }
    const m = /\[[\s\S]*\]/.exec(txt || '');
    const arr = m ? JSON.parse(m[0]) : [];
    if (Array.isArray(arr) && arr.length === faltan.length) {
      faltan.forEach((t, i) => { const v = String(arr[i] || '').trim(); if (!v) return; out[t] = v; const k = clave(t, a, 'es'); _mem.set(k, v); if (db) db.collection('traducciones').updateOne({ _id: k }, { $set: { t: v, a, de: 'es', at: new Date() } }, { upsert: true }).catch(() => {}); });
    }
  } catch (e) { console.warn('[Idiomas] lote:', e.message); }
  return out;
}

async function idiomaDeUsuario(userId) {
  try { const u = await require('./users').getUser(String(userId)); return (u && IDIOMAS[u.idioma] && u.idioma) || 'es'; } catch (e) { return 'es'; }
}

module.exports = { IDIOMAS, traducir, traducirLote, idiomaDe, idiomaDeUsuario, paraEnviar, olvidar };
