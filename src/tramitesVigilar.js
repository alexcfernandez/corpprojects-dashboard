// src/tramitesVigilar.js — Vigilar la respuesta de un trámite presentado (6/11/2026, Álex con los permisos de la grúa:
// «tenemos que revisar si nos autorizan, para estar pendientes de todo y poder hacer lo necesario»).
// Cada trámite vigilado (colección `tramitesVigilados`) tiene su nº de registro y palabras que lo identifican. Cada 20
// minutos (8-21 h) se busca en el Gmail de Corp lo que haya llegado de la administración (sede, e-NOTUM, Ajuntament)
// que lo mencione, y se avisa por WhatsApp a Álex y a la oficina, una vez por correo, diciendo si parece concedido
// o denegado. e-NOTUM ya avisa aparte (notifOficiales.js); esto es para no perder la respuesta concreta.
// Se apaga con VIGILAR_TRAMITES=off.
'use strict';
const COL = 'tramitesVigilados';
async function getDB() { return require('./db').getDB(); }
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const REMITENTES = ['girona.cat', 'seu-e.cat', 'aoc.cat', 'enotum.cat', 'etram'];

// ¿Qué dice el correo? Mira primero la denegación (un «no s'autoritza» también contiene «autoritza»).
function sentido(texto) {
  const n = norm(texto);
  if (/deneg|desestim|no s.?autoritz|no se autoriz|requeriment|requerimiento|esmen|subsana|manca|falta document/.test(n)) return /requeriment|requerimiento|esmen|subsana|manca|falta document/.test(n) ? 'requerimiento' : 'denegado';
  if (/s.?autoritza|se autoriza|autoritzar l|autorizar l|autoritzacio concedida|autorizacion concedida|concedir|concede|es concedeix|resolucio favorable|resolucion favorable|atorgar|otorgar/.test(n)) return 'concedido';
  return 'sin saber';
}

// ¿Es de este trámite? Por nº de registro o por sus palabras (todas).
function esDe(t, texto) {
  const n = norm(texto);
  if ((t.registros || []).some(r => n.includes(String(r)))) return true;
  return (t.palabras || []).length > 0 && t.palabras.every(p => n.includes(norm(p)));
}

function textoAviso(t, { asunto, de, fecha, resumen, s }) {
  const cab = { concedido: '✅ *Parece CONCEDIDO*', denegado: '⛔ *Parece DENEGADO*', requerimiento: '⚠️ *Piden algo más (requerimiento)*', 'sin saber': '📬 *Ha llegado algo*' }[s];
  return `${cab} — ${t.titulo}\n\n` +
    `De: ${de}\nAsunto: ${asunto}\n${fecha ? `Fecha: ${fecha}\n` : ''}${resumen ? `\n«${resumen}»\n` : ''}` +
    `\nMíralo en el correo de Corp (hola@) o en El meu espai: https://elmeuespai.aoc.cat/1707920002` +
    (s === 'concedido' ? `\n\nSi está concedido: ${t.siConcedido || 'preparar todo lo necesario.'}` : '') +
    (s === 'denegado' || s === 'requerimiento' ? `\n\nHay que actuar rápido: llamar al ${t.telefono || '972 419 010'}.` : '');
}

async function vigilar({ dias = 3, _gmail = null, _enviar = null, _db = null, seco = false } = {}) {
  if (process.env.VIGILAR_TRAMITES === 'off') return { apagado: true };
  const db = _db || await getDB();
  const activos = await db.collection(COL).find({ estado: 'esperando' }).toArray();
  if (!activos.length) return { activos: 0 };
  const gmail = _gmail || require('./email-intelligence').getGmailClient();
  const q = `newer_than:${dias}d (${REMITENTES.map(r => 'from:' + r).join(' OR ')} OR ${activos.flatMap(t => t.registros || []).map(r => `"${r}"`).join(' OR ') || '"reserva d\'espai"'})`;
  const r = await gmail.users.messages.list({ userId: 'me', q, maxResults: 30 });
  const res = { activos: activos.length, mirados: 0, avisos: [] };
  for (const m of r.data.messages || []) {
    if (activos.some(t => (t.avisados || []).includes(m.id))) continue;
    const full = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
    res.mirados++;
    const h = full.data.payload.headers; const hv = n => (h.find(x => x.name === n) || {}).value || '';
    let cuerpo = '';
    try { cuerpo = require('./notifOficiales').crudo(full.data.payload); } catch (e) { cuerpo = full.data.snippet || ''; }
    cuerpo = String(cuerpo).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
    const texto = `${hv('Subject')}\n${cuerpo}`;
    // El acuse de recibo de la sede («Sol·licitud enregistrada») no es la respuesta: se apunta sin avisar.
    const acuse = /enregistrada|registrada|confirmaci/i.test(hv('Subject'));
    for (const t of activos) {
      if ((t.avisados || []).includes(m.id) || !esDe(t, texto)) continue;
      if (acuse) { if (!seco) await db.collection(COL).updateOne({ _id: t._id }, { $push: { avisados: m.id } }); (t.avisados = t.avisados || []).push(m.id); continue; }
      const s = sentido(texto);
      const txt = textoAviso(t, { asunto: hv('Subject'), de: hv('From'), fecha: new Date(Number(full.data.internalDate)).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' }), resumen: String(full.data.snippet || '').slice(0, 300), s });
      res.avisos.push({ tramite: t.titulo, sentido: s, asunto: hv('Subject') });
      if (seco) continue;
      const N = require('./notifications'); const enviar = _enviar || N.sendWhatsAppTo;
      for (const to of [...new Set([N.destinoDueno(), process.env.OFICINA_TELEFONO || '+34674013723'].filter(Boolean))]) {
        try { await enviar(to, txt, { sinTraducir: true }); } catch (e) { console.warn('[Trámites] envío:', e.message); }
      }
      const set = s === 'concedido' || s === 'denegado' ? { estado: s, resueltoAt: new Date() } : {};
      await db.collection(COL).updateOne({ _id: t._id }, { $push: { avisados: m.id, respuestas: { gmailId: m.id, asunto: hv('Subject'), sentido: s, at: new Date() } }, ...(Object.keys(set).length ? { $set: set } : {}) });
      (t.avisados = t.avisados || []).push(m.id);
    }
  }
  return res;
}

async function nuevo({ titulo, registros = [], palabras = [], siConcedido = '', telefono = '' }) {
  const db = await getDB();
  const doc = { titulo, registros: registros.map(String), palabras, siConcedido, telefono, estado: 'esperando', creado: new Date(), avisados: [], respuestas: [] };
  const ya = await db.collection(COL).findOne({ titulo, estado: 'esperando' });
  if (ya) return ya;
  await db.collection(COL).insertOne(doc);
  return doc;
}

module.exports = { vigilar, nuevo, sentido, esDe, textoAviso };
