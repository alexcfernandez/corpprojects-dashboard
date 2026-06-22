// src/comunidades.js — Fichas técnicas de comunidad (notas de mantenimiento).
// Fuente única de verdad para WhatsApp y dashboard: misma colección, misma clave.
const { getDB } = require('./db');
const stel = require('./stelorder');

function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }

const CAT_COM = {
  iluminacion:  '💡 Iluminación',
  electricidad: '🔌 Electricidad',
  fontaneria:   '💧 Fontanería',
  calefaccion:  '🔥 Calefacción/ACS',
  accesos:      '🚪 Accesos y portería',
  otros:        '📝 Otros'
};
const CAT_ORDER = Object.keys(CAT_COM);

function claveComunidad(target, scope, clientMap) {
  const tnorm = norm(target);
  let accId = null;
  if (scope !== 'familia') for (const [id, ci] of Object.entries(clientMap || {})) { if (norm(ci.name) === tnorm) { accId = id; break; } }
  return accId ? `id:${accId}` : (scope === 'familia' ? `fam:${tnorm}` : `nombre:${tnorm}`);
}
async function claveDe(target, scope) {
  const { clientMap } = await stel.getClients().catch(() => ({ clientMap: {} }));
  return claveComunidad(target, scope, clientMap);
}

// Clasificación por reglas (gratis). Devuelve categoría o null si no es evidente.
function clasificarReglas(nota) {
  const n = norm(nota);
  if (/downlight|luminaria|bombilla|led|fluorescent|tubo|lampar|foco|3000k|4000k|6000k|kelvin|\bluz\b|luces/.test(n)) return 'iluminacion';
  if (/portero|fermax|telefonill|codigo (de )?(portal|acceso)|llave|cerradura|puerta|garaje|mando/.test(n)) return 'accesos';
  if (/caldera|termo|acs|agua caliente|radiador|calefacc|\bgas\b/.test(n)) return 'calefaccion';
  if (/fontaner|grifo|tuberia|bajante|deposito|bomba|valvula|fuga|desague/.test(n)) return 'fontaneria';
  if (/cuadro electric|diferencial|magnetotermic|contador|fase|enchufe|cableado/.test(n)) return 'electricidad';
  return null;
}

async function getNotas(target, scope) {
  const clave = await claveDe(target, scope);
  try { const db = await getDB(); const doc = await db.collection('comunidadNotas').findOne({ clave }); return (doc && Array.isArray(doc.notas)) ? doc.notas : []; }
  catch (e) { return []; }
}

// iaClasificar(texto, cats) opcional: solo se usa si las reglas no aciertan.
async function addNota(target, scope, texto, iaClasificar) {
  texto = String(texto || '').trim();
  if (!texto) return { ok: false };
  let cat = clasificarReglas(texto);
  if (!cat && typeof iaClasificar === 'function') { try { cat = await iaClasificar(texto, CAT_ORDER); } catch (e) {} }
  if (!CAT_COM[cat]) cat = 'otros';
  const clave = await claveDe(target, scope);
  try {
    const db = await getDB();
    await db.collection('comunidadNotas').updateOne(
      { clave },
      { $setOnInsert: { clave, comunidad: target, scope: scope || 'cliente' }, $push: { notas: { texto, cat, ts: new Date() } } },
      { upsert: true }
    );
    return { ok: true, cat };
  } catch (e) { return { ok: false }; }
}

async function borrarNota(target, scope, idx) {
  const clave = await claveDe(target, scope);
  let notas = [];
  try { const db = await getDB(); const doc = await db.collection('comunidadNotas').findOne({ clave }); notas = (doc && doc.notas) || []; } catch (e) { return { ok: false }; }
  if (!notas.length || idx < 1 || idx > notas.length) return { ok: false, total: notas.length };
  const borrada = notas[idx - 1];
  notas.splice(idx - 1, 1);
  try { const db = await getDB(); await db.collection('comunidadNotas').updateOne({ clave }, { $set: { notas } }); return { ok: true, borrada }; }
  catch (e) { return { ok: false }; }
}

// Lista de comunidades (clientes) para el buscador del dashboard.
async function listComunidades() {
  const { clientMap } = await stel.getClients().catch(() => ({ clientMap: {} }));
  return [...new Set(Object.values(clientMap || {}).map(c => c && c.name).filter(Boolean))].sort();
}

// Comunidades que YA tienen ficha (para destacarlas en el dashboard).
async function comunidadesConFicha() {
  try {
    const db = await getDB();
    const docs = await db.collection('comunidadNotas').find({}).toArray();
    return docs.filter(d => Array.isArray(d.notas) && d.notas.length).map(d => ({ comunidad: d.comunidad, n: d.notas.length }));
  } catch (e) { return []; }
}

module.exports = { CAT_COM, CAT_ORDER, norm, getNotas, addNota, borrarNota, listComunidades, comunidadesConFicha };
