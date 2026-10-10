// src/absentismes.js — ABSENTISMES PARA LA GESTORÍA (10/10/2026). Cada mes, hacia el 23-25, Eduard (Som Assessors)
// escribe «necessito saber els dies d'absentisme dels treballadors» para hacer las nóminas, y la oficina contestaba
// a mano mirando la presencia. Ahora, al llegar ese correo:
//   1. se sacan de presencia las faltas (justificadas o no), bajas y vacaciones del mes de cada trabajador, con fechas;
//   2. se deja la respuesta en catalán como BORRADOR en el mismo hilo de Gmail (no se envía sola);
//   3. se avisa a Álex por WhatsApp con el resumen y los días laborables SIN NADA APUNTADO, para que los arregle en
//      presencia antes de enviarla («prepara los absentismes» lo vuelve a hacer).
'use strict';
const MESOS = ['gener', 'febrer', 'març', 'abril', 'maig', 'juny', 'juliol', 'agost', 'setembre', 'octubre', 'novembre', 'desembre'];
const hoyISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
const deMes = nom => (/^[aeiouà]/i.test(nom) ? `d'${nom}` : `de ${nom}`);   // «d'octubre», «de setembre»
const dm = f => `${Number(f.slice(8, 10))}/${Number(f.slice(5, 7))}`;

const esPeticion = ({ de = '', asunto = '', cuerpo = '' } = {}) =>
  // La petición (no las respuestas del hilo): de la gestoría, que hable de absentismos y no empiece por «RE:».
  /somassessors/i.test(de) && /absentism|absènci|absenci|dies d.?absent/i.test(`${asunto}\n${String(cuerpo).slice(0, 1500)}`) && !/^\s*re\s*:/i.test(asunto);

// El mes de las nóminas que se preparan: pasado el 15, el mes en curso; antes, el anterior.
function mesDe(fecha = new Date()) {
  const d = new Date(fecha); const dia = Number(d.toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' }).slice(8, 10));
  const base = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (dia < 15 ? 1 : 0), 1));
  return base.toISOString().slice(0, 7);
}

// Días seguidos como «del 5 al 7/8»; sueltos, «3/8 i 12/8».
function tramos(fechas) {
  const l = [...new Set(fechas)].sort(); const out = [];
  for (let i = 0; i < l.length; i++) {
    let j = i; while (j + 1 < l.length && (new Date(l[j + 1]) - new Date(l[j])) / 86400000 <= 3 && seguidos(l[j], l[j + 1])) j++;
    out.push(i === j ? dm(l[i]) : `del ${dm(l[i])} al ${dm(l[j])}`); i = j;
  }
  return out.length > 1 ? out.slice(0, -1).join(', ') + ' i ' + out[out.length - 1] : out[0] || '';
}
// Seguidos aunque haya fin de semana en medio (viernes → lunes).
function seguidos(a, b) { const d = (new Date(b) - new Date(a)) / 86400000; if (d === 1) return true; const w = new Date(a + 'T12:00:00Z').getUTCDay(); return w === 5 && d === 3; }

async function resumen(mes) {
  const [y, m] = mes.split('-').map(Number);
  const fin = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const hasta = [fin, hoyISO()].sort()[0];
  const r = await require('./agente')._consultarPresencia({ desde: `${mes}-01`, hasta });
  // Solo asalariados: los autónomos facturan, no van en nómina.
  return { mes, desde: `${mes}-01`, hasta, personas: (r.resumenPorPersona || []).filter(p => !p.autonomo && (p.laborables || p.trabajados)) };
}

function texto(res) {
  const nom = MESOS[Number(res.mes.slice(5, 7)) - 1];
  const lin = [];
  for (const p of res.personas) {
    const parts = [];
    if (p.fechasFaltas.length) parts.push(`${p.fechasFaltas.length} ${p.fechasFaltas.length === 1 ? 'dia' : 'dies'} de falta (${tramos(p.fechasFaltas)})`);
    if (p.fechasBaja.length) parts.push(`baixa ${tramos(p.fechasBaja)}`);
    if (p.fechasVacaciones.length) parts.push(`vacances ${tramos(p.fechasVacaciones)}`);
    if (parts.length) lin.push(`- ${p.nombre}: ${parts.join('; ')}`);
  }
  return `Bon dia Eduard,\n\n${lin.length ? `Els absentismes del mes ${deMes(nom)} són:\n\n${lin.join('\n')}` : `Aquest mes ${deMes(nom)} no hi ha cap absentisme.`}\n\nLa resta de treballadors, sense absentismes.\n\nSalutacions,\n\nCorp Projects Holding, S.L.\nhola@corpprojects.es`;
}

// Prepara el borrador (como respuesta al correo de Eduard si se sabe cuál) y avisa a Álex.
async function preparar({ mes = null, gmailId = null, threadId = null, messageId = null, asunto = null, para = 'eduard@somassessors.com', avisar = true } = {}) {
  mes = /^\d{4}-\d{2}$/.test(String(mes || '')) ? mes : mesDe();
  const res = await resumen(mes);
  const cuerpo = texto(res);
  const b = await require('./gmailBorrador').crear({ para: [para], asunto: asunto ? (/^re:/i.test(asunto) ? asunto : `Re: ${asunto}`) : `Absentismes ${MESOS[Number(mes.slice(5, 7)) - 1]} — Corp Projects`, texto: cuerpo, threadId, inReplyTo: messageId });
  const sinApuntar = res.personas.filter(p => p.sinApuntar);
  let wa = `📋 *Absentismes de ${MESOS[Number(mes.slice(5, 7)) - 1]}* para la gestoría: te he dejado la respuesta preparada en Gmail (no se ha enviado).\n${b.url}\n\n`;
  const con = res.personas.filter(p => p.fechasFaltas.length || p.fechasBaja.length || p.fechasVacaciones.length);
  wa += con.length ? con.map(p => `• *${p.nombre}*: ${[p.fechasFaltas.length ? `${p.fechasFaltas.length} falta(s) ${tramos(p.fechasFaltas)}` : '', p.fechasBaja.length ? `baja ${tramos(p.fechasBaja)}` : '', p.fechasVacaciones.length ? `vacaciones ${tramos(p.fechasVacaciones)}` : ''].filter(Boolean).join('; ')}`).join('\n') : 'Sin faltas, bajas ni vacaciones apuntadas.';
  if (sinApuntar.length) wa += `\n\n⚠️ *Días laborables sin nada apuntado* (¿faltó o falta poner la presencia?):\n${sinApuntar.map(p => `• ${p.nombre}: ${tramos(p.fechasSinApuntar)}`).join('\n')}\n\nArréglalos en Presencia y dime *«prepara los absentismes»* para rehacer el correo.`;
  if (avisar) { try { await require('./notifications').sendWhatsApp(wa); } catch (e) { console.warn('[Absentismes] WhatsApp:', e.message); } }
  return { ok: true, mes, borrador: b.url, texto: cuerpo, aviso: wa, sinApuntar: sinApuntar.map(p => ({ nombre: p.nombre, fechas: p.fechasSinApuntar })) };
}

// Al llegar el correo de la gestoría.
async function desdeCorreo({ de, asunto, cuerpo, fecha, threadId, messageIdHeader }) {
  if (!esPeticion({ de, asunto, cuerpo })) return null;
  return preparar({ mes: mesDe(fecha || new Date()), threadId, messageId: messageIdHeader, asunto, para: (String(de).match(/[\w.+-]+@[\w.-]+/) || ['eduard@somassessors.com'])[0] });
}

module.exports = { esPeticion, mesDe, tramos, resumen, texto, preparar, desdeCorreo };
