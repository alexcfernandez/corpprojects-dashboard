// src/citasTrabajador.js — CITAS DE LOS TRABAJADORES al calendario (4/11/2026, Álex: «yo pensaba que si David le dice
// a Corpy "tengo una visita", o por el grupo dice algo de eso, lo agendaba y todo»).
//   · deMensaje(): lo que un trabajador le escribe a Corpy en privado («mañana a las 10 tengo visita en Major 75»,
//     «el jueves paso por Sobrequés a las 9») → evento en el calendario de Corp («David: …»), aviso a Álex, y a él un
//     WhatsApp una hora antes (o a las 7:45 si no dijo hora). Un filtro de palabras evita llamar a la IA por cualquier cosa.
//   · avisarQuienVa(): una cita de un grupo (citasGrupos.js) con «quien_va» que es UN trabajador → ese mismo aviso a él.
//   · Se guarda en `citasGrupo` (con jid «trab:<userId>») para no repetir. Se apaga con CITAS_TRABAJADORES=off.
'use strict';

const hoyISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
const fFecha = f => String(f || '').split('-').reverse().join('/');
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const primer = s => String(s || '').trim().split(/\s+/)[0];

// ¿Puede ser una cita? Un día y algo de quedar/ir. Si no, ni se pregunta a la IA.
const DIA = /\b(hoy|manana|pasado manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|\d{1,2}\s*\/\s*\d{1,2}|dia \d{1,2})\b/;
const QUEDAR = /\b(a las|cita|visita|quedad[oa]s?|quedo|quedamos|he quedado|voy|vamos|ire|iremos|paso|pasare|pasamos|viene|vendra|vienen|vendran|reunion)\b/;
const pareceCita = t => { const n = norm(t); return DIA.test(n) && QUEDAR.test(n); };

function aDate(fecha, hora) { return require('./corpySocio')._aDate(fecha, hora); }

const prompt = (nombre, texto, hoy) => `Eres de la oficina de Corp Projects (reformas y mantenimiento en Girona). Hoy es ${hoy}. ${nombre}, un trabajador, le escribe esto a Corpy por WhatsApp:
«${texto}»
Saca SOLO las CITAS que dice que tiene o ha fijado: un día concreto para ir a un sitio, quedar con alguien o que venga alguien («mañana a las 10 tengo visita en Major 75», «el jueves paso por Sobrequés a las 9», «el lunes viene el del ascensor a Canaders»). En quien_va pon «${nombre}» si va él.
NO son citas: lo que ya pasó, «esta semana», «cuando pueda», pedir, comprar o ir a recoger material (Obramat, Leroy, tiendas, almacén), avisar de que llega tarde, ni preguntas. Si no hay ninguna, devuelve citas vacío.`;

// Avisos por WhatsApp al trabajador (Álex, 4/11/2026: «si es de empezar el jueves a las 9, les tiene que avisar también el
// día antes, de lo que tienen que hacer»): la víspera a las 19:00 y el mismo día 1 h antes (o a las 7:45 si no hay hora).
async function _programarAviso({ userId, nombre, fecha, hora, texto, textoVispera = null }, { _prog = null } = {}) {
  const P = _prog || require('./programados');
  const at = hora ? new Date(aDate(fecha, hora).getTime() - 3600000) : aDate(fecha, '07:45');
  const vispera = new Date(aDate(fecha, '19:00').getTime() - 86400000);
  let primero = null;
  if (textoVispera && vispera.getTime() > Date.now()) {
    await P.crear({ at: vispera, tipo: 'whatsapp', userId: String(userId), nombre, texto: textoVispera, nota: 'Aviso de cita, la víspera (citasTrabajador)', importante: true }, 'Corpy (citas)');
    primero = vispera;
  }
  if (at.getTime() > Date.now()) {
    await P.crear({ at, tipo: 'whatsapp', userId: String(userId), nombre, texto, nota: 'Aviso de cita (citasTrabajador)', importante: true }, 'Corpy (citas)');
    primero = primero || at;
  }
  return primero;
}

const textoVispera = (nombre, c) => `📋 Hola ${primer(nombre)}, para *mañana*: ${c.hora ? '*a las ' + c.hora + '* · ' : ''}${c.que}${c.sitio ? ' · ' + c.sitio : ''}${c.con ? ` (con ${c.con})` : ''}. Si hay algún problema, dímelo por aquí.`;

const textoRecordatorio = (nombre, c) => `🗓️ Hola ${primer(nombre)}, te recuerdo: *${c.hora ? 'hoy a las ' + c.hora : 'hoy'}* · ${c.que}${c.sitio ? ' · ' + c.sitio : ''}${c.con ? ` (con ${c.con})` : ''}.`;

// Mensaje privado de un trabajador. Devuelve el texto para contestarle, o null si no hay cita.
async function deMensaje({ userId, nombre, texto }, { _llamar = null, _crear = null, _prog = null, _enviar = null, _db = null } = {}) {
  if (process.env.CITAS_TRABAJADORES === 'off' || !userId || !pareceCita(texto)) return null;
  const hoy = `${hoyISO()} (${new Date().toLocaleDateString('es-ES', { weekday: 'long', timeZone: 'Europe/Madrid' })})`;
  let out; try { out = await (_llamar || require('./citasGrupos')._llamarIA)(prompt(primer(nombre), String(texto).slice(0, 1500), hoy)); }
  catch (e) { console.warn('[CitasTrab] IA:', e.message); return null; }
  const db = _db || await require('./db').getDB();
  const apuntadas = [];
  for (const c of (out && out.citas) || []) {
    try {
      const d = await require('./citasGrupos').apuntar(db, { ...c, que: `${primer(nombre)}: ${c.que || 'cita'}` }, { jid: `trab:${userId}`, grupo: `WhatsApp de ${primer(nombre)}` }, { _crear });
      if (!d) continue;
      d.avisoAt = await _programarAviso({ userId, nombre, fecha: d.fecha, hora: d.hora, texto: textoRecordatorio(nombre, { ...c, hora: d.hora }), textoVispera: textoVispera(nombre, { ...c, hora: d.hora }) }, { _prog }).catch(() => null);
      apuntadas.push(d);
    } catch (e) { console.warn('[CitasTrab] apuntar:', e.message); }
  }
  if (!apuntadas.length) return null;
  const linea = c => `*${fFecha(c.fecha)}${c.hora ? ' a las ' + c.hora : ''}* · ${c.que.replace(/^[^:]+:\s*/, '')} · ${c.sitio}${c.con ? ` (con ${c.con})` : ''}`;
  try { await (_enviar || require('./notifications').sendWhatsApp)(`📅 *${primer(nombre)}* le ha dicho a Corpy que tiene cita — apuntada en tu calendario:\n${apuntadas.map(c => '• ' + linea(c)).join('\n')}\n\nLo que escribió: «${String(texto).slice(0, 300)}»`); } catch (e) {}
  return `🗓️ Apuntado en el calendario${apuntadas.length > 1 ? ':\n' + apuntadas.map(c => '• ' + linea(c)).join('\n') : ': ' + linea(apuntadas[0])}.${apuntadas.some(c => c.avisoAt) ? '\n⏰ Te lo recuerdo por aquí la víspera y antes de ir.' : ''}`;
}

// Cita de un grupo con quien_va («va David», «David y Diego»): a cada trabajador nombrado (activo, con móvil y sin los
// mensajes apagados) se le avisa. Un nombre de pila que llevan dos personas no se adivina.
async function avisarQuienVa(cita, { _prog = null, _usuarios = null } = {}) {
  if (process.env.CITAS_TRABAJADORES === 'off' || !cita || !cita.quienVa || !cita.fecha) return [];
  const us = (_usuarios || await require('./users').getUsers(false)).filter(u => u.role !== 'client');
  const q = norm(cita.quienVa);
  const porPila = {};
  for (const u of us) { const p = norm(primer(u.name)); if (p.length >= 3) (porPila[p] = porPila[p] || []).push(u); }
  const avisados = [];
  for (const [pila, l] of Object.entries(porPila)) {
    if (!new RegExp(`\\b${pila}\\b`).test(q) || l.length !== 1) continue;
    const u = l[0];
    if (u.avisosWa === 'ninguno' || !(u.telefono || u.whatsapp)) continue;
    const at = await _programarAviso({ userId: String(u._id), nombre: u.name, fecha: cita.fecha, hora: cita.hora, texto: textoRecordatorio(u.name, cita), textoVispera: textoVispera(u.name, cita) }, { _prog }).catch(() => null);
    if (at) avisados.push(primer(u.name));
  }
  return avisados;
}

module.exports = { deMensaje, avisarQuienVa, pareceCita };
