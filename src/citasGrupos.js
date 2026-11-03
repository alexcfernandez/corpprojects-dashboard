// src/citasGrupos.js — Citas que se fijan en CUALQUIER grupo de WhatsApp donde está Corpy (3/11/2026, Álex: «en el de
// Projects, en el de admin y David, o en todos los grupos que le vayamos metiendo a Corpy»).
//   · Cada media hora (con peticionesGrupo) lee lo nuevo de los grupos activos SIN peticiones:true (en esos la cita ya va
//     con su petición: peticionesGrupo._citaAlCalendario) y saca las citas con día concreto: «el jueves a las 10 vamos a
//     Sobrequés», «mañana a las 8 quedamos con el presi de Canaders», «el lunes viene el del ascensor».
//   · Cada cita va UNA vez a la agenda de Álex (calendar.crearEventoPersonal) y le llega un WhatsApp.
//   · Colección `citasGrupo` (lo apuntado, para no repetir) y bridgeGrupos.citasHasta (hasta dónde se ha leído).
//   · Se apaga con CITAS_GRUPOS=off.
'use strict';
const COL = 'citasGrupo';
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const corto = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const hoyISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
const fmt = d => new Date(d).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const fFecha = f => f.split('-').reverse().join('/');

const HERRAMIENTA = {
  name: 'guardar_citas',
  description: 'Citas con día concreto que se fijan en los mensajes.',
  input_schema: { type: 'object', properties: { citas: { type: 'array', items: { type: 'object', properties: {
    fecha: { type: 'string', description: 'YYYY-MM-DD (resuelve «mañana», «el jueves»… respecto a la fecha del mensaje)' },
    hora: { type: ['string', 'null'], description: 'HH:MM en 24 h; null si no se dice. «a las 8» de trabajo = 08:00.' },
    sitio: { type: 'string', description: 'Dónde (comunidad, calle, obra, cliente)' },
    con: { type: ['string', 'null'], description: 'Con quién se queda (nombre, teléfono), si se dice' },
    quien_va: { type: ['string', 'null'], description: 'Quién de Corp va, si se dice' },
    que: { type: 'string', description: 'Qué se va a hacer, en pocas palabras' },
  }, required: ['fecha', 'sitio', 'que'] } } }, required: ['citas'] },
};

const prompt = (grupo, contexto, lineas, hoy) => `Eres de la oficina de Corp Projects (reformas y mantenimiento en Girona). Hoy es ${hoy}. Te paso mensajes de un grupo de WhatsApp («${grupo}»).
Saca SOLO las CITAS: cuando queda fijado un día concreto para ir a un sitio, quedar con alguien o que venga alguien («el jueves a las 10 vamos a Sobrequés», «mañana a primera hora pasamos por Canaders, avisad a Juan Carlos», «el lunes viene el técnico del ascensor»).
NO son citas: «ya iremos», «esta semana», «cuando podamos», lo que ya pasó («ayer fuimos»), entregas de material sin quedar con nadie, ni cosas que solo se comentan. Si una cita se cambia de día, devuelve solo la última. Si no hay ninguna, devuelve la lista vacía.
${contexto.length ? `\nANTES (ya leído, solo para entender):\n${contexto.join('\n')}\n` : ''}
MENSAJES NUEVOS:
${lineas.join('\n')}`;

async function _llamarIA(texto) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) throw new Error('Falta ANTHROPIC_API_KEY');
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: AbortSignal.timeout(120000),
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: require('./config').ia.agente, max_tokens: 2000, tools: [HERRAMIENTA], tool_choice: { type: 'tool', name: HERRAMIENTA.name }, messages: [{ role: 'user', content: texto }] }) });
  const d = await r.json(); if (!r.ok) throw new Error(`API ${r.status}: ${d.error?.message || ''}`);
  const tu = (d.content || []).find(b => b.type === 'tool_use');
  return tu ? tu.input : { citas: [] };
}

// Apunta una cita (si es de hoy en adelante y no estaba ya). Devuelve el doc o null.
async function apuntar(db, c, { jid, grupo }, { _crear = null } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.fecha || '') || c.fecha < hoyISO()) return null;
  const hora = /^\d{1,2}:\d{2}$/.test(c.hora || '') ? c.hora.padStart(5, '0') : null;
  const clave = `${jid}|${c.fecha}|${hora || ''}|${norm(c.sitio).split(' ').slice(0, 3).join(' ')}`;
  if (await db.collection(COL).findOne({ _id: clave })) return null;
  const titulo = corto(`${c.que ? c.que + ' · ' : ''}${c.sitio}${c.con ? ' · ' + c.con : ''}`, 140);
  const nota = [c.quien_va ? `Va: ${c.quien_va}` : '', `Grupo «${grupo}»`].filter(Boolean).join('\n');
  const eventoId = await (_crear || require('./calendar').crearEventoPersonal)({ date: c.fecha, hora, titulo, nota });
  const doc = { _id: clave, jid, grupo, fecha: c.fecha, hora, sitio: corto(c.sitio, 120), con: corto(c.con, 80) || null, quienVa: corto(c.quien_va, 60) || null, que: corto(c.que, 120), eventoId, creado: new Date() };
  await db.collection(COL).insertOne(doc);
  return doc;
}

const textoAviso = (grupo, l) => `📅 *Cita${l.length > 1 ? 's' : ''} del grupo «${grupo}»* — apuntada${l.length > 1 ? 's' : ''} en tu calendario:\n` +
  l.map(c => `• *${fFecha(c.fecha)}${c.hora ? ' a las ' + c.hora : ''}* · ${c.que} · ${c.sitio}${c.con ? ` (con ${c.con})` : ''}${c.quienVa ? ` — va ${c.quienVa}` : ''}${c.avisados && c.avisados.length ? ` (le aviso antes a ${c.avisados.join(' y ')})` : ''}`).join('\n') +
  `\n\nSi no es así, bórrala del calendario.`;

async function revisar({ avisar = true, _db = null, _llamar = null, _crear = null, _enviar = null, _prog = null } = {}) {
  if (process.env.CITAS_GRUPOS === 'off') return [];
  const db = _db || await require('./db').getDB();
  const grupos = await db.collection('bridgeGrupos').find({ activo: true, peticiones: { $ne: true } }).toArray();
  const res = [];
  for (const g of grupos) {
    const desde = g.citasHasta ? new Date(g.citasHasta) : new Date(Date.now() - 24 * 3600 * 1000);
    const raw = await db.collection('grupoMensajes').find({ jid: g._id, ts: { $gt: desde } }).sort({ ts: 1 }).limit(150).toArray();
    if (!raw.length) continue;
    const hasta = raw[raw.length - 1].ts;
    if (Date.now() - new Date(hasta).getTime() < 10 * 60 * 1000) continue;     // que acaben de escribir
    const conTexto = raw.filter(m => String(m.texto || '').trim().length > 2);
    let apuntadas = [];
    if (conTexto.length) {
      const ant = await db.collection('grupoMensajes').find({ jid: g._id, ts: { $lte: desde } }).sort({ ts: -1 }).limit(12).toArray();
      const linea = m => `${fmt(m.ts)} ${m.quien || '?'}: ${corto(m.texto, 400) || '(foto)'}`;
      const out = await (_llamar || _llamarIA)(prompt(g.nombre || g._id, ant.reverse().map(linea), raw.map(linea), `${hoyISO()} (${new Date().toLocaleDateString('es-ES', { weekday: 'long', timeZone: 'Europe/Madrid' })})`));
      for (const c of out.citas || []) {
        try {
          const d = await apuntar(db, c, { jid: g._id, grupo: g.nombre || g._id }, { _crear });
          if (!d) continue;
          // Y a quien va, un WhatsApp antes (citasTrabajador.js, 4/11/2026).
          try { d.avisados = await require('./citasTrabajador').avisarQuienVa(d, { _prog: _prog || undefined }); } catch (e) { console.warn('[Citas] aviso a quien va:', e.message); }
          apuntadas.push(d);
        } catch (e) { console.warn('[Citas] apuntar:', e.message); }
      }
    }
    await db.collection('bridgeGrupos').updateOne({ _id: g._id }, { $set: { citasHasta: hasta } });
    if (apuntadas.length && avisar) { try { await (_enviar || require('./notifications').sendWhatsApp)(textoAviso(g.nombre || g._id, apuntadas)); } catch (e) {} }
    if (apuntadas.length) res.push({ grupo: g.nombre, citas: apuntadas.length });
  }
  return res;
}

module.exports = { revisar, apuntar, textoAviso, _llamarIA };
