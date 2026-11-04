// src/iaUso.js — Cuánto gasta cada función en la API de Anthropic (4/11/2026, Álex: tope de 60 $/mes y a día 4 ya
// iban 48 $). Todas las llamadas van por fetch a api.anthropic.com desde ~20 ficheros; en vez de tocar cada una, se
// envuelve fetch UNA vez al arrancar y se apunta el `usage` de cada respuesta con el fichero y la función que llamó
// (sacados de la pila). Nunca rompe la llamada: si el registro falla, se ignora.
//
//   iaUsoLlamadas { ts, fn:'peticionesGrupo.js:_llamarIA', modelo, entrada, salida, cacheEscr, cacheLeida, maxTokens, usd, ok }
//   (35 días, TTL). GET /api/ia-uso?dias=7 → resumen por función y modelo.

const COL = 'iaUsoLlamadas';
// $ por millón de tokens (entrada, salida). Caché: escribir 1,25× entrada, leer 0,1× entrada.
const PRECIOS = {
  'claude-sonnet-4-6': [3, 15], 'claude-sonnet-4-5': [3, 15], 'claude-haiku-4-5': [1, 5],
  'claude-opus-4-6': [5, 25], 'claude-haiku-5-5': [0.1, 0.5], 'claude-sonnet-5-5': [2, 10],
};
function precio(modelo) {
  const m = String(modelo || '');
  return PRECIOS[m] || PRECIOS[Object.keys(PRECIOS).find(k => m.startsWith(k)) || ''] || [3, 15];
}
function coste(modelo, u = {}) {
  const [pe, ps] = precio(modelo);
  return ((u.input_tokens || 0) * pe + (u.cache_creation_input_tokens || 0) * pe * 1.25 + (u.cache_read_input_tokens || 0) * pe * 0.1 + (u.output_tokens || 0) * ps) / 1e6;
}

// Primer marco de la pila que está en src/ y no es este fichero: «fichero.js:función».
function quienLlama(stack) {
  for (const l of String(stack || '').split('\n').slice(1)) {
    const m = l.match(/at (?:async )?(?:([^\s(]+) \()?.*[\\/]src[\\/]([^:()]+?\.js):\d+/);
    if (!m || /iaUso\.js$/.test(m[2])) continue;
    const fn = (m[1] || '').replace(/^Object\./, '').replace(/^_impl\./, '');
    return m[2].replace(/\\/g, '/') + (fn && fn !== '<anonymous>' ? ':' + fn : '');
  }
  return 'desconocido';
}

let _idx = false;
async function guardar(doc) {
  try {
    const db = await require('./db').getDB();
    if (!_idx) { _idx = true; db.collection(COL).createIndex({ ts: 1 }, { expireAfterSeconds: 35 * 24 * 3600 }).catch(() => {}); }
    await db.collection(COL).insertOne(doc);
  } catch (e) { /* el registro nunca rompe nada */ }
}

function instalar() {
  if (global.fetch.__iaUso) return;
  const original = global.fetch;
  const envuelto = async function (url, opts) {
    const res = await original.apply(this, arguments);
    try {
      if (!/api\.anthropic\.com\/v1\/messages(\?|$)/.test(String(url && url.url || url))) return res;
      const quien = quienLlama(new Error().stack);
      let body = {}; try { body = JSON.parse(opts && opts.body || '{}'); } catch (e) {}
      res.clone().json().then(d => {
        const u = d.usage || {};
        const modelo = d.model || body.model;
        guardar({ ts: new Date(), fn: quien, modelo, entrada: u.input_tokens || 0, salida: u.output_tokens || 0,
          cacheEscr: u.cache_creation_input_tokens || 0, cacheLeida: u.cache_read_input_tokens || 0,
          maxTokens: body.max_tokens || null, parada: d.stop_reason || null, ok: res.ok, usd: res.ok ? coste(modelo, u) : 0 });
      }).catch(() => {});
    } catch (e) {}
    return res;
  };
  envuelto.__iaUso = true;
  global.fetch = envuelto;
}

async function resumen({ dias = 7 } = {}) {
  const db = await require('./db').getDB();
  const desde = new Date(Date.now() - dias * 86400000);
  const filas = await db.collection(COL).aggregate([
    { $match: { ts: { $gte: desde } } },
    { $group: { _id: { fn: '$fn', modelo: '$modelo' }, llamadas: { $sum: 1 }, entrada: { $sum: '$entrada' }, salida: { $sum: '$salida' }, cacheLeida: { $sum: '$cacheLeida' }, usd: { $sum: '$usd' }, cortadas: { $sum: { $cond: [{ $eq: ['$parada', 'max_tokens'] }, 1, 0] } } } },
    { $sort: { usd: -1 } },
  ]).toArray();
  const total = filas.reduce((a, f) => a + f.usd, 0);
  const porDia = await db.collection(COL).aggregate([
    { $match: { ts: { $gte: desde } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$ts', timezone: 'Europe/Madrid' } }, usd: { $sum: '$usd' }, llamadas: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]).toArray();
  const r2 = x => Math.round(x * 100) / 100;
  return {
    dias, totalUsd: r2(total), mediaDiaUsd: porDia.length ? r2(total / porDia.length) : 0,
    porDia: porDia.map(d => ({ dia: d._id, usd: r2(d.usd), llamadas: d.llamadas })),
    porFuncion: filas.map(f => ({ fn: f._id.fn, modelo: f._id.modelo, llamadas: f.llamadas, entradaMedia: Math.round(f.entrada / f.llamadas), salidaMedia: Math.round(f.salida / f.llamadas), cacheLeida: f.cacheLeida, cortadas: f.cortadas, usd: r2(f.usd), pct: total ? Math.round(f.usd / total * 100) : 0 })),
  };
}

module.exports = { instalar, resumen, _quienLlama: quienLlama, _coste: coste };
