// src/incidenciasDia.js — Aviso diario de INCIDENCIAS ABIERTAS (2/11/2026, Álex: «que cada día nos avise de las
// incidencias, de qué tipo: crear un presupuesto, qué es, o si es ir a trabajar; que sea insistente»).
// Cada mañana (L-S) a Álex y a la oficina: presupuestos por hacer y trabajos a los que hay que ir, con cliente, qué es y
// cuántos días lleva. Vuelve a salir cada día hasta que la incidencia cambia de estado en StelOrder («INC00432 cerrada»
// por WhatsApp a Corpy, o en StelOrder). También las peticiones de grupos y correos que aún no tienen incidencia.
// También las llamadas perdidas de la centralita (Nuvo Voz) que no dejaron recado a SecretarIA, para devolverlas.
// «Presupuesto hecho» no sale: eso ya espera al cliente (lo sigue el correo de los lunes / la página /pr).

const ABIERTA = /pendiente|en proceso|programado|parte de trabajo/i;
const corto = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const diasDesde = f => Math.max(0, Math.floor((Date.now() - new Date(f).getTime()) / 86400000));
const MAX = 10;   // por sección; el resto se cuenta

async function datos({ _S = null, _db = null } = {}) {
  const S = _S || require('./stelorder');
  const [inc, st, tm, { clientMap }] = await Promise.all([S.getAllIncidents(), S.getIncidentStateMap(), S.getIncidentTypeMaps(), S.getClients()]);
  const tipos = (tm && tm.typeName) || {};
  const nombre = id => { const c = clientMap[String(id)]; return c ? (c['legal-name'] || c.name || '') : ''; };
  const abiertas = (inc || []).filter(i => !i.deleted && ABIERTA.test(st[i['incident-state-id']] || '')).map(i => ({
    ref: i['full-reference'], fecha: String(i.date || '').slice(0, 10), dias: diasDesde(i.date), estado: String(st[i['incident-state-id']] || '').trim(),
    tipo: String(tipos[i['incident-type-id']] || '').trim(), cliente: nombre(i['account-id']), que: i.description || '' }))
    .sort((a, b) => b.fecha.localeCompare(a.fecha));
  const presupuestos = abiertas.filter(i => /presupuesto/i.test(i.tipo));
  const trabajos = abiertas.filter(i => !/presupuesto/i.test(i.tipo));
  const db = _db || await require('./db').getDB();
  const sinInc = await db.collection('peticionesGrupo').find({ estado: 'pendiente', incidencia: null, tipo: { $in: ['trabajo', 'queja', 'presupuesto'] } }).sort({ urgente: -1, fecha: -1 }).limit(30).toArray();
  // Llamadas perdidas sin recado desde el aviso anterior (Nuvo Voz, 3/11/2026): hay que devolverlas.
  const perdidas = await require('./nuvoVoz').perdidasParaAviso({ _db: db }).catch(() => []);
  return { presupuestos, trabajos, sinInc, perdidas };
}

function texto({ presupuestos, trabajos, sinInc, perdidas = [] }) {
  if (!presupuestos.length && !trabajos.length && !sinInc.length && !perdidas.length) return null;
  const linea = i => `• *${i.ref}* · ${corto(i.cliente || '¿cliente?', 32)} · ${corto(i.que, 70)} · ${i.dias === 0 ? 'hoy' : i.dias === 1 ? 'ayer' : `${i.dias} días`}${i.dias >= 30 ? ' ⏰' : ''}${/programado|en proceso/i.test(i.estado) ? ` (${String(i.estado).trim().toLowerCase()})` : ''}`;
  const seccion = (tit, l) => {
    if (!l.length) return '';
    const resto = l.slice(MAX);
    return `${tit} (${l.length})\n${l.slice(0, MAX).map(linea).join('\n')}${resto.length ? `\n…y ${resto.length} más, la más antigua de hace ${Math.max(...resto.map(x => x.dias))} días` : ''}`;
  };
  const viejas = [...presupuestos, ...trabajos].filter(i => i.dias >= 30).length;
  const partes = [
    `🔧 *Incidencias abiertas* · ${presupuestos.length + trabajos.length}`,
    seccion('📝 *Presupuestos por hacer*', presupuestos),
    seccion('🔨 *Trabajos: hay que ir*', trabajos),
    sinInc.length ? `📬 *Pedidos por grupo o correo sin incidencia todavía* (${sinInc.length})\n${sinInc.slice(0, 6).map(p => `• ${p.urgente ? '🚨 ' : ''}${p.porConfirmar ? '❓ por confirmar · ' : ''}${corto(p.cliente, 32)}${p.direccion ? ' ' + corto(p.direccion, 25) : ''} · ${corto(p.resumen, 70)} · ${p.grupo ? corto(p.grupo, 28) : ''}`).join('\n')}` : '',
    perdidas.length ? `📞 *Llamadas perdidas sin recado: devolverlas* (${perdidas.length})\n${perdidas.slice(0, 8).map(p => `• ${p.quien} · ${p.cuando}${p.motivo ? ` · ${p.motivo.toLowerCase()}` : ''}`).join('\n')}${perdidas.length > 8 ? `\n…y ${perdidas.length - 8} más (en Nuvo Voz)` : ''}` : '',
    `Cuando esté hecha, dime «INC00432 cerrada» (o «hecha», «presupuesto hecho», «programada») y deja de salir.${viejas ? ` Hay ${viejas} con más de un mes (⏰): si ya no van, ciérralas y limpiamos la lista.` : ''}`,
  ];
  return partes.filter(Boolean).join('\n\n');
}

async function avisar({ enviar = true, _S = null, _db = null, _enviar = null } = {}) {
  const t = texto(await datos({ _S, _db }));
  if (!t || !enviar) return { enviado: false, texto: t };
  const N = require('./notifications');
  const destinos = [...new Set([N.destinoDueno(), process.env.OFICINA_TELEFONO || '+34674013723'].filter(Boolean))];
  let ok = 0;
  for (const to of destinos) { try { if (await (_enviar || N.sendWhatsAppTo)(to, t) !== false) ok++; } catch (e) { console.warn('[IncidenciasDia] envío:', e.message); } }
  return { enviado: ok > 0, destinos: ok, texto: t };
}

module.exports = { datos, texto, avisar, ABIERTA };
