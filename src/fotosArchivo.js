// src/fotosArchivo.js — Lo que Álex manda en FOTOS a Corpy se archiva donde toca (4/11/2026). Álex: «le he mandado el recibo
// y todo y no se entera»; «tubo bajante de Santa Eugenia 57 pendiente para cambiar… y la foto también que la archive para
// esa comunidad». Antes el agente no veía las fotos (solo texto) y una foto suelta siempre recibía «Dime qué hago».
//   · Las fotos del mensaje (o del buffer de server.js) esperan aquí 15 min: guardarPendientes() / tomar().
//   · archivar(): a un SITIO (obra → «Fotos de la obra»; sin obra → `sitioFotos`, con su cliente) o al TICKET de un pago con
//     tarjeta que se le pidió (ticketsAviso: crea la compra y la une al pago).
//   · Tras apuntar algo con sitio (un pendiente), las fotos que llegan en los 3 min siguientes van a ese sitio: reciente().
//   · ticketDe(from): el pago con tarjeta de Álex sin ticket de estos 2 días, para preguntar «¿es el ticket de…?».
'use strict';
const TTL = 15 * 60 * 1000;
const VENTANA = 3 * 60 * 1000;
const COL = 'sitioFotos';
const corto = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const eur = n => Math.abs(Number(n) || 0).toFixed(2).replace('.', ',') + ' €';
const ult9 = t => String(t || '').replace(/\D/g, '').slice(-9);
async function getDB() { return require('./db').getDB(); }

const pendientes = new Map();   // from → { imagenes: [{data(base64), media_type}], ts }
const ultimo = new Map();       // from → { sitio, que, ts }
function guardarPendientes(from, imagenes = []) {
  if (!imagenes.length) return;
  const p = pendientes.get(from);
  const prev = p && (Date.now() - p.ts) < TTL ? p.imagenes : [];
  pendientes.set(from, { imagenes: [...prev, ...imagenes].slice(-12), ts: Date.now() });
}
function hay(from) { const p = pendientes.get(from); return p && (Date.now() - p.ts) < TTL ? p.imagenes.length : 0; }
function tomar(from) { const p = pendientes.get(from); pendientes.delete(from); return p && (Date.now() - p.ts) < TTL ? p.imagenes : []; }
function recordar(from, sitio, que) { if (!from || !sitio) return; const u = ultimo.get(from); ultimo.set(from, { sitio, que, ts: Date.now(), acuse: u && u.sitio === sitio ? u.acuse : null }); }
function reciente(from) { const u = ultimo.get(from); return u && (Date.now() - u.ts) < VENTANA ? u : null; }

// A un sitio: la obra si la hay; si no, `sitioFotos` con el cliente (lo encuentra pasar_fotos).
async function aSitio(sitio, imagenes, { nota = '', por = 'Álex (Corpy)', _db = null, _subir = null, _cliente = null } = {}) {
  const db = _db || await getDB();
  const r = await require('./visitas').resolverObra(sitio, db);
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
  const ids = [];
  if (r.obra) {
    for (const [i, img] of imagenes.entries()) {
      try {
        const d = await (_subir || require('./personalDocs').subir)({ ambito: 'obra', obraId: String(r.obra._id), tipo: 'fotos_obra', archivo: { buffer: Buffer.from(img.data, 'base64'), mimetype: img.media_type || 'image/jpeg', originalname: `${corto(nota || 'Foto', 60)} ${hoy} (${i + 1}).jpg` }, fecha: hoy, notas: corto(nota, 280) }, por);
        if (d) ids.push(String(d.id || d._id));
      } catch (e) { console.warn('[FotosArchivo] obra:', e.message); }
    }
    return { donde: `la obra *${r.obra.reference}*`, sitio: r.obra.reference, ids };
  }
  let cli = null;
  try { cli = await (_cliente || _clientePorNombre)(sitio); } catch (e) {}
  for (const img of imagenes) {
    const x = await db.collection(COL).insertOne({ sitio: corto(sitio, 140), cliente: cli ? cli.name : null, clienteId: cli ? cli.id : null, texto: corto(nota, 500) || null, data: Buffer.from(img.data, 'base64'), mimetype: img.media_type || 'image/jpeg', por, ts: new Date() });
    ids.push(String(x.insertedId));
  }
  return { donde: cli ? `*${cli.name}*` : `*${corto(sitio, 60)}*`, sitio: cli ? cli.name : sitio, ids };
}
async function _clientePorNombre(q) {
  const { casa } = require('./fotosPedir');
  const { clientMap } = await require('./stelorder').getClients();
  const l = Object.entries(clientMap || {}).map(([id, c]) => ({ id, name: c.name || c.legalName || '', dir: c.address || '' })).filter(c => casa(q, `${c.name} ${c.dir}`));
  return l.length === 1 ? l[0] : null;
}

// El pago con tarjeta de quien escribe (Álex) que espera ticket, de hoy o ayer.
async function ticketsDe(from, { _pendientes = null } = {}) {
  const l = await (_pendientes || require('./ticketsAviso').pendientes)({ dias: 2 });
  return l.filter(p => p.tel && ult9(p.tel) === ult9(from));
}
const textoTicket = p => `*${p.comercio}* · ${eur(p.importe)}`;

async function aTicket(from, imagenes, { comercio = '', importe = null, por = 'Álex (Corpy)', _pendientes = null, _crear = null, _alSubir = null } = {}) {
  let l = await ticketsDe(from, { _pendientes });
  if (importe != null) l = l.filter(p => Math.abs(Math.abs(p.importe) - Math.abs(Number(importe))) < 0.5);
  if (comercio) { const w = String(comercio).toLowerCase().split(/\W+/).filter(x => x.length > 2); const c = l.filter(p => w.some(x => String(p.comercio || p.concepto || '').toLowerCase().includes(x))); if (c.length) l = c; }
  if (!l.length) return { aclara: true, reply: 'No tengo ningún pago con tu tarjeta de hoy o ayer esperando ticket. Si es de otro día, súbelo en Compras: https://dashboard.corpprojects.es/compras' };
  if (l.length > 1) return { aclara: true, reply: `¿De cuál es el ticket?\n${l.slice(0, 5).map((p, i) => `${i + 1}. ${textoTicket(p)} (${p.fecha.split('-').reverse().slice(0, 2).join('/')})`).join('\n')}` };
  const p = l[0];
  const c = await (_crear || require('./compras').crear)({ fotos: imagenes.map(i => ({ data: Buffer.from(i.data, 'base64'), mimetype: i.media_type || 'image/jpeg' })), destino: 'general', origen: 'whatsapp-alex', nota: `Ticket del pago con tarjeta: ${p.comercio} · ${eur(p.importe)}`, subidaPor: { kind: 'admin', userId: p.userId || 'alex', name: 'Álex' } });
  if (!c || !c.id) return { reply: 'No he podido guardar el ticket. Súbelo en Compras: https://dashboard.corpprojects.es/compras' };
  await (_alSubir || require('./ticketsAviso').alSubir)(p.id, c.id, por);
  return { ok: true, reply: `🧾 Guardado el ticket de ${textoTicket(p)} y unido a ese pago. Ya no te lo pido más.` };
}

// Herramienta del agente: archivar las fotos que acaba de mandar Álex.
async function archivar(input = {}, from, opts = {}) {
  const imgs = tomar(from);
  if (!imgs.length) return { aclara: true, reply: 'No tengo fotos tuyas de estos últimos minutos. Mándamelas otra vez y dime dónde las guardo.' };
  if (input.destino === 'ticket') {
    const r = await aTicket(from, imgs, { comercio: input.comercio, importe: input.importe, ...opts });
    if (r.aclara) guardarPendientes(from, imgs);   // siguen esperando a que diga cuál
    return r;
  }
  const sitio = String(input.sitio || '').trim();
  if (!sitio) { guardarPendientes(from, imgs); return { aclara: true, reply: '¿De qué obra o comunidad son las fotos?' }; }
  const r = await aSitio(sitio, imgs, { nota: input.nota, ...opts });
  recordar(from, sitio, input.nota);
  return { ok: true, reply: `📸 ${r.ids.length} foto${r.ids.length !== 1 ? 's' : ''} guardada${r.ids.length !== 1 ? 's' : ''} en ${r.donde}${input.nota ? ` («${corto(input.nota, 60)}»)` : ''}. Pídemelas cuando quieras: «mándame las fotos de ${r.sitio}».` };
}

const TOOL = { name: 'archivar_fotos', description: 'GUARDA las FOTOS que Álex acaba de mandar: en un sitio (obra, comunidad o dirección: «esta foto es del bajante de Santa Eugenia 57», «guárdalas en Bellpuig 41») o como TICKET de un pago con su tarjeta («es el recibo de lo que hemos comido», «el ticket de TQ Mate», o «sí» cuando Corpy preguntó «¿es el ticket de…?»). Solo si el mensaje dice que hay fotos.', input_schema: { type: 'object', properties: {
  destino: { type: 'string', enum: ['sitio', 'ticket'] },
  sitio: { type: ['string', 'null'], description: 'Obra, comunidad o dirección, si destino = sitio.' },
  nota: { type: ['string', 'null'], description: 'Qué se ve o para qué es («bajante para cambiar»).' },
  comercio: { type: ['string', 'null'], description: 'Si es un ticket: dónde se pagó, si lo dice.' },
  importe: { type: ['number', 'null'], description: 'Si es un ticket: importe, si lo dice.' },
}, required: ['destino'] } };

module.exports = { TOOL, COL, guardarPendientes, hay, tomar, recordar, reciente, aSitio, aTicket, ticketsDe, textoTicket, archivar, _pendientes: pendientes, _ultimo: ultimo };
