// src/adelantos.js — REGISTRO DE ADELANTOS Y PAGOS A TRABAJADORES (31/10/2026, Álex: «cada vez que le diga a Corpy o
// Alfonso diga por el grupo adelantos a alguien se apunta… el máximo de datos, quién lo hizo, dónde se puso la nota,
// a qué cuenta se envió; y cuando lo detecte en el banco que nos pregunte y nos haga las preguntas necesarias»).
//
// Entra de tres sitios:
//   · BANCO (bancoSync → desdeBanco): cada transferencia que sale a un trabajador, a la cuenta de otra persona con el
//     nombre de un trabajador en el concepto («Melvin adelanto» a María Dolores) o con «nómina/adelanto/dietas…».
//     Lo claro («Adelanto nómina» a la cuenta del propio trabajador) queda confirmado solo; lo demás → pregunta a Álex.
//   · CORPY (herramienta apuntar_adelanto): «le he dado 20 € a Diego en efectivo».
//   · GRUPO de WhatsApp (grupoWhatsapp): alguien de Corp escribe «adelanto de 50 a Diego» → por confirmar hasta que
//     el banco lo enseñe (mismo trabajador, mismo importe, ±4 días) o Álex lo confirme.
// Las preguntas van de UNA en UNA al WhatsApp de Álex; contesta «1», «2 Diego», «1 noviembre» o «luego» (responder).
//
// Colección `adelantos`: { fecha, mes (nómina a la que cuenta, AAAA-MM), userId, nombre, importe, tipo, medio
// banco|efectivo|bizum, cuentaDe (titular de la cuenta a la que fue), concepto (el del banco), movId, quien (quién lo
// dio o lo ordenó), donde (banco | corpy | grupo:<nombre> | manual), textoOriginal, nota, estado por_confirmar|
// confirmado|descartado, sugerido {userId,nombre,tipo,mes}, preguntadoAt, aplazadoHasta, confirmadoPor, confirmadoAt,
// creado }.
'use strict';
async function getDB() { return require('./db').getDB(); }
const COL = 'adelantos';
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();
const hoyISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
const eur = n => r2(n).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const mesMas = (mes, n) => { const [y, m] = mes.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };
const nombreMes = mes => MESES[Number(mes.slice(5, 7)) - 1];
const TIPOS = {
  adelanto: 'Adelanto de nómina', nomina: 'Pago de nómina', sabado: 'Sábado o día extra',
  gasto: 'Comida, dietas o material (no cuenta para la nómina)', ajeno: 'No es de ningún trabajador', socio: 'Socio (fuera de nómina)',
};
const CUENTAN = ['adelanto', 'nomina', 'sabado'];     // lo que se resta de lo que cobra el trabajador

// Partes de una transferencia del Santander: «TRANSFERENCIA [INMEDIATA] A FAVOR DE <titular> [CONCEPTO[:] <concepto>]».
function partes(concepto) {
  const s = String(concepto || '');
  const m = s.match(/A FAVOR DE\s+(.+?)(?:\s+CONCEPTO:?\s*(.*))?$/i);
  return m ? { titular: m[1].trim(), texto: (m[2] || '').trim() } : { titular: '', texto: s.trim() };
}
// Mes nombrado en un texto («Nómina septiembre») → AAAA-MM cercano a la fecha.
function mesNombrado(texto, fecha) {
  const n = norm(texto); const i = MESES.findIndex(m => new RegExp(`\\b${m}\\b`).test(n) || (m === 'septiembre' && /\bsetiembre\b/.test(n)));
  if (i < 0) return null;
  const y = Number(fecha.slice(0, 4)), mf = Number(fecha.slice(5, 7)) - 1;
  const año = i - mf > 6 ? y - 1 : mf - i > 6 ? y + 1 : y;
  return `${año}-${String(i + 1).padStart(2, '0')}`;
}
function tipoDeTexto(t) {
  const n = norm(t);
  if (/\b(dieta|dietas|comida|comidas|menu|material|compra|gasolina|parking|peaje|herramienta)/.test(n)) return 'gasto';
  if (/\b(sabado|sabados|dia extra|festivo)\b/.test(n)) return 'sabado';
  if (/\b(adelanto|anticipo|a cuenta)\b/.test(n)) return 'adelanto';
  if (/\b(nomina|sueldo|paga)\b/.test(n)) return 'nomina';
  return null;
}
// Lo que nunca es un pago a un trabajador aunque lleve su nombre (formación de SPASS, facturas, la tarjeta de Corp…).
const NO_ES = /corp projects|spass|tesoreria|servei comu|agencia tributaria|hacienda|seguridad social/;
const NO_ES_TEXTO = /\b(factura|pagament|proforma|formacio|formacion)\b/;

// ¿De qué trabajador es este texto? (todas las palabras del nombre o un alias del banco; ver nominasPagos.esDe)
function trabajadorDe(texto, users) {
  if (!norm(texto)) return null;
  const NP = require('./nominasPagos');
  const c = users.filter(u => NP.esDe(texto, u));
  return c.length === 1 ? c[0] : null;
}

// Un movimiento del banco → propuesta (o null si no tiene que ver con trabajadores). PURO: se prueba sin Mongo.
//   seguro = se confirma solo; si no, se le pregunta a Álex.
function clasificar(mov, users) {
  if (!(Number(mov.importe) < 0) || !/transfer|bizum/i.test(mov.concepto || '')) return null;
  const { titular, texto } = partes(mov.concepto);
  if (NO_ES.test(norm(titular)) || NO_ES_TEXTO.test(norm(texto))) return null;
  const fecha = String(mov.fechaOperacion || mov.fecha || '').slice(0, 10);
  const uT = trabajadorDe(titular, users), uC = trabajadorDe(texto, users);
  const tipoT = tipoDeTexto(texto);
  if (!uT && !uC && (!tipoT || tipoT === 'gasto')) return null;       // «Compra furgoneta» a Jamal: no es de trabajadores
  const u = uC || uT;                                           // el nombre del concepto manda («Melvin» a la cuenta de Ramón)
  const esSocio = !!u && /^(alfonso|alex)\b/.test(norm(u.name));
  let tipo = esSocio ? 'socio' : tipoT || (u ? 'adelanto' : null);
  const dia = Number(fecha.slice(8, 10));
  const nombrado = mesNombrado(texto, fecha);
  let mes = nombrado || fecha.slice(0, 7);
  if (!nombrado && tipo === 'nomina' && dia <= 10) mes = mesMas(mes, -1);       // «nómina» a primeros = la del mes pasado
  // Un adelanto de los últimos días puede ser ya del mes siguiente (David, 30/10): se pregunta.
  const n = norm(texto);
  const claro = !!uT && (!uC || String(uC._id) === String(uT._id)) && (
    tipo === 'socio' || tipo === 'gasto' ||
    tipo === 'nomina' && !!nombrado ||
    tipo === 'adelanto' && /\b(adelanto|anticipo) (de )?nomina\b/.test(n) && dia < 28);
  return {
    fecha, mes, importe: r2(-mov.importe), tipo, userId: u ? String(u._id) : null, nombre: u ? u.name : null,
    cuentaDe: titular || null, concepto: texto || null, movId: mov._id != null ? String(mov._id) : null,
    cuentaAjena: !!(u && !uT && titular),                     // fue a la cuenta de otra persona
    seguro: claro,
  };
}

async function _col(_db) { const db = _db || await getDB(); return db.collection(COL); }

// Apunta un adelanto (Corpy, grupo o a mano). Si ya hay uno igual del banco sin origen, se juntan.
async function registrar({ userId, nombre = '', importe, fecha = null, mes = null, tipo = 'adelanto', medio = 'banco', cuentaDe = null,
  quien = '', donde = 'manual', textoOriginal = '', nota = '', estado = 'confirmado' } = {}, por = '', { _db = null } = {}) {
  const imp = r2(Math.abs(Number(String(importe).replace(',', '.'))));
  if (!(imp > 0) || imp > 20000) throw new Error('Falta el importe');
  if (!TIPOS[tipo]) throw new Error('Tipo no válido');
  if (tipo !== 'ajeno' && !/^[a-f0-9]{24}$/.test(String(userId || ''))) throw new Error('¿De quién es?');
  const f = /^\d{4}-\d{2}-\d{2}$/.test(String(fecha || '')) ? fecha : hoyISO();
  const col = await _col(_db);
  const base = { quien: String(quien || por || '').slice(0, 80), donde: String(donde).slice(0, 120), textoOriginal: String(textoOriginal || '').slice(0, 500), nota: String(nota || '').slice(0, 300) };
  // ¿Ya salió en el banco? (mismo trabajador e importe, ±4 días, sin origen de WhatsApp) → se completa ese.
  if (medio !== 'efectivo') {
    const ya = (await col.find({ importe: imp, donde: 'banco' }).toArray())
      .find(d => [d.userId, d.sugerido && d.sugerido.userId].includes(String(userId)) && d.estado !== 'descartado' && Math.abs(new Date(d.fecha) - new Date(f)) <= 4 * 864e5);
    if (ya) {
      const set = { ...base, donde: `banco + ${base.donde}`, userId: String(userId), nombre: String(nombre || ya.nombre || '').slice(0, 80), tipo, mes: mes || ya.mes,
        estado: 'confirmado', confirmadoPor: por || base.quien, confirmadoAt: new Date() };
      await col.updateOne({ _id: ya._id }, { $set: set });
      return { ...ya, ...set, juntado: true };
    }
  }
  const doc = { fecha: f, mes: /^\d{4}-\d{2}$/.test(String(mes || '')) ? mes : f.slice(0, 7), userId: userId ? String(userId) : null, nombre: String(nombre || '').slice(0, 80),
    importe: imp, tipo, medio, cuentaDe, concepto: null, movId: null, ...base, estado,
    ...(estado === 'confirmado' ? { confirmadoPor: por || base.quien, confirmadoAt: new Date() } : {}), creado: new Date() };
  const r = await col.insertOne(doc); doc._id = r.insertedId;
  return doc;
}

// Movimientos nuevos del banco → registro. `nuevos` = [{ col, id }] (como avisoPagos) o los movimientos ya leídos.
async function desdeBanco(nuevos, { _db = null, _users = null, movs = null } = {}) {
  const db = _db || await getDB();
  const col = db.collection(COL);
  if (!movs) {
    const { ObjectId } = require('mongodb');
    const ids = (nuevos || []).filter(n => n.col === 'bancoMovimientos').map(n => { try { return new ObjectId(String(n.id)); } catch (e) { return null; } }).filter(Boolean);
    if (!ids.length) return { nuevos: 0 };
    movs = await db.collection('bancoMovimientos').find({ _id: { $in: ids } }).toArray();
  }
  const users = _users || (await require('./users').getUsers(false)).filter(u => u.active !== false);
  let n = 0, preguntar = 0, juntados = 0;
  for (const m of movs) {
    const p = clasificar(m, users); if (!p) continue;
    if (p.movId && await col.findOne({ movId: p.movId })) continue;
    // Lo que alguien ya apuntó por WhatsApp (grupo o Corpy) y ahora sale en el banco: se completa, sin preguntar.
    if (p.userId) {
      const prev = (await col.find({ userId: p.userId, importe: p.importe, movId: null }).toArray())
        .find(d => d.medio !== 'efectivo' && d.estado !== 'descartado' && Math.abs(new Date(d.fecha) - new Date(p.fecha)) <= 4 * 864e5);
      if (prev) {
        await col.updateOne({ _id: prev._id }, { $set: { movId: p.movId, cuentaDe: p.cuentaDe, concepto: p.concepto, fecha: p.fecha, medio: 'banco', donde: `${prev.donde} + banco`,
          estado: 'confirmado', confirmadoPor: prev.confirmadoPor || 'banco', confirmadoAt: prev.confirmadoAt || new Date() } });
        juntados++; continue;
      }
    }
    const doc = { fecha: p.fecha, mes: p.mes, userId: p.seguro ? p.userId : null, nombre: p.seguro ? p.nombre : null, importe: p.importe, tipo: p.seguro ? p.tipo : null,
      medio: 'banco', cuentaDe: p.cuentaDe, concepto: p.concepto, movId: p.movId, quien: '', donde: 'banco', textoOriginal: '', nota: '',
      estado: p.seguro ? 'confirmado' : 'por_confirmar', sugerido: { userId: p.userId, nombre: p.nombre, tipo: p.tipo, mes: p.mes, cuentaAjena: p.cuentaAjena },
      ...(p.seguro ? { confirmadoPor: 'banco (concepto claro)', confirmadoAt: new Date() } : {}), creado: new Date() };
    await col.insertOne(doc); n++; if (!p.seguro) preguntar++;
  }
  return { nuevos: n, preguntar, juntados };
}

// ── Preguntas a Álex, de una en una ───────────────────────────────────────────────────────
const VIGENTE = 6 * 3600 * 1000;           // una pregunta se contesta en este rato; después se vuelve a hacer
function _pregunta(d, quedan) {
  const s = d.sugerido || {};
  const pn = s.nombre ? s.nombre.split(' ')[0] : null;
  const mes = nombreMes(d.mes || s.mes || d.fecha.slice(0, 7));
  const l = [
    `💸 *Pago del banco por aclarar*${quedan > 1 ? ` (quedan ${quedan})` : ''}`,
    `${d.fecha.slice(8, 10)}/${d.fecha.slice(5, 7)} · *${eur(d.importe)}* a *${d.cuentaDe || '¿?'}*${d.concepto ? ` · concepto «${d.concepto}»` : ' · sin concepto'}`,
    s.cuentaAjena && pn ? `Ojo: la cuenta no es de ${pn}, pero el concepto le nombra.` : null,
    d.nota ? `Nota: ${d.nota}` : null,
    '', '¿Qué es?',
    `1) ${pn ? `Adelanto de ${pn}` : 'Adelanto (dime de quién: «1 Diego»)'}`,
    '2) De otro trabajador → «2 Diego»',
    '3) Comida, dietas o material de obra',
    `4) Sábado o día extra${pn ? ` de ${pn}` : ''}`,
    `5) Pago de nómina${pn ? ` de ${pn}` : ''}`,
    '6) No es de ningún trabajador',
    `Cuenta para *${mes}*; si es de otro mes, añádelo: «1 noviembre». «luego» para dejarlo.`,
  ];
  return l.filter(x => x != null).join('\n');
}
async function siguientePregunta({ _db = null, _enviar = null, ahora = new Date() } = {}) {
  // De noche no se pregunta: queda para la siguiente vuelta del banco (a partir de las 8).
  const h = Number(ahora.toLocaleString('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hour12: false }));
  if (h < 8 || h >= 22) return { enviado: false, deNoche: true };
  const col = await _col(_db);
  // Solo lo que ha salido en el banco: lo apuntado por WhatsApp sin banco espera a que aparezca (o es efectivo).
  const pend = (await col.find({ estado: 'por_confirmar', donde: 'banco' }).toArray()).sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
  if (!pend.length) return { enviado: false, quedan: 0 };
  if (pend.some(d => d.preguntadoAt && ahora - new Date(d.preguntadoAt) < VIGENTE)) return { enviado: false, quedan: pend.length, esperando: true };
  const d = pend.find(x => !x.aplazadoHasta || new Date(x.aplazadoHasta) <= ahora);
  if (!d) return { enviado: false, quedan: pend.length, aplazados: true };
  const txt = _pregunta(d, pend.length);
  const enviar = _enviar || (async t => { const N = require('./notifications'); const to = N.destinoDueno(); return to ? require('./canalWhatsapp').enviarUno(to, t, { importante: true, permitirRepetido: true }) : false; });
  const ok = await enviar(txt);
  if (ok === false) return { enviado: false, quedan: pend.length };
  await col.updateOne({ _id: d._id }, { $set: { preguntadoAt: ahora } });
  return { enviado: true, id: String(d._id), quedan: pend.length, texto: txt };
}

// Respuesta de Álex. Devuelve el texto para contestarle, o null si no es una respuesta a esto.
async function responder(texto, { por = 'Álex', _db = null, _users = null, ahora = new Date() } = {}) {
  const nn = norm(texto);
  if (!nn || nn.length > 60) return null;
  const luego = /^(luego|despues|mas tarde|manana|ahora no)\b/.test(nn);
  const m = nn.match(/^([1-6])(?:\s+(.*))?$/);
  if (!m && !luego) return null;
  const col = await _col(_db);
  const d = (await col.find({ estado: 'por_confirmar', donde: 'banco' }).toArray())
    .filter(x => x.preguntadoAt && ahora - new Date(x.preguntadoAt) < VIGENTE).sort((a, b) => new Date(b.preguntadoAt) - new Date(a.preguntadoAt))[0];
  if (!d) return null;
  if (luego) {
    await col.updateOne({ _id: d._id }, { $set: { preguntadoAt: null, aplazadoHasta: new Date(ahora.getTime() + 20 * 3600 * 1000) } });
    return '👍 Vale, te lo vuelvo a preguntar mañana.';
  }
  const op = Number(m[1]); let resto = m[2] || '';
  let mes = null;
  const im = MESES.findIndex(x => new RegExp(`\\b${x}\\b`).test(resto));
  if (im >= 0) { mes = mesNombrado(MESES[im], d.fecha); resto = resto.replace(new RegExp(`\\b(de |del |para )?${MESES[im]}\\b`), ' '); }
  if (/\b(mes que viene|siguiente)\b/.test(resto)) { mes = mesMas(d.fecha.slice(0, 7), 1); resto = resto.replace(/\b(del |el )?(mes que viene|siguiente)\b/, ' '); }
  resto = resto.replace(/\b(es|de|del|el|la|para|a|adelanto|nomina|sabado)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const s = d.sugerido || {};
  const users = _users || (await require('./users').getUsers(false)).filter(u => u.active !== false);
  let u = null;
  if (resto) {
    const P = w => users.map(x => ({ x, p: norm(x.name).split(' ').filter(p => p.length >= 3 && w.split(' ').some(q => q.length >= 3 && (p.startsWith(q) || q.startsWith(p)))).length })).filter(y => y.p > 0).sort((a, b) => b.p - a.p);
    const c = P(resto);
    if (!c.length) return `No encuentro a «${resto}». Contesta con el número y el nombre como sale en el dashboard («${op} Diego»).`;
    if (c[1] && c[1].p === c[0].p) return `¿A cuál? ${c.filter(y => y.p === c[0].p).map(y => y.x.name).join(' · ')} — contesta «${op} <nombre completo>».`;
    u = c[0].x;
  } else if (s.userId && op !== 2 && op !== 6) u = users.find(x => String(x._id) === String(s.userId)) || { _id: s.userId, name: s.nombre };
  const tipo = { 1: 'adelanto', 2: s.tipo && CUENTAN.includes(s.tipo) ? s.tipo : 'adelanto', 3: 'gasto', 4: 'sabado', 5: 'nomina', 6: 'ajeno' }[op];
  if (tipo === 'ajeno') u = null;
  if (!u && tipo !== 'ajeno' && tipo !== 'gasto') return `¿De quién es? Contesta «${op} Nombre» (p. ej. «${op} Diego»).`;
  let mesF = mes || d.mes || s.mes;
  if (!mes && tipo === 'nomina' && !mesNombrado(d.concepto || '', d.fecha) && Number(d.fecha.slice(8, 10)) <= 10) mesF = mesMas(d.fecha.slice(0, 7), -1);
  const set = { tipo, userId: u ? String(u._id) : null, nombre: u ? u.name : null, mes: mesF, estado: 'confirmado', confirmadoPor: por, confirmadoAt: ahora, respuesta: String(texto).slice(0, 80) };
  await col.updateOne({ _id: d._id }, { $set: set });
  let txt = `✅ Apuntado: ${eur(d.importe)} del ${d.fecha.slice(8, 10)}/${d.fecha.slice(5, 7)} → *${TIPOS[tipo]}*${u ? ` de *${u.name}*` : ''}${CUENTAN.includes(tipo) ? ` (${nombreMes(mesF)})` : ''}.`;
  if (u && CUENTAN.includes(tipo)) {
    const lleva = (await col.find({ userId: String(u._id), mes: mesF, estado: 'confirmado' }).toArray()).filter(x => CUENTAN.includes(x.tipo)).reduce((a, x) => a + x.importe, 0);
    txt += ` En ${nombreMes(mesF)} lleva cobrado *${eur(lleva)}*.`;
  }
  const sig = await siguientePregunta({ _db, _enviar: async () => true, ahora: new Date(ahora.getTime() + 1) }).catch(() => null);
  // La siguiente va en la misma respuesta (y queda marcada como preguntada).
  if (sig && sig.enviado) return `${txt}\n\n${sig.texto}`;
  return txt + (sig && sig.quedan ? '' : '\n\nNo queda ningún pago por aclarar 👌');
}

// Resumen de un mes, por trabajador: lo que lleva cobrado (adelantos + nómina + sábados) y lo que no cuenta.
async function resumenMes(mes, { _db = null } = {}) {
  const col = await _col(_db);
  const l = await col.find({ mes }).toArray();
  const por = {};
  for (const d of l.filter(x => x.estado === 'confirmado' && x.userId)) {
    const p = por[d.userId] = por[d.userId] || { userId: d.userId, nombre: d.nombre, adelanto: 0, nomina: 0, sabado: 0, gasto: 0, cobrado: 0, lineas: [] };
    if (p[d.tipo] != null) p[d.tipo] = r2(p[d.tipo] + d.importe);
    if (CUENTAN.includes(d.tipo)) p.cobrado = r2(p.cobrado + d.importe);
    p.lineas.push(d);
  }
  Object.values(por).forEach(p => p.lineas.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha))));
  return { mes, trabajadores: Object.values(por).sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es')),
    porConfirmar: l.filter(x => x.estado === 'por_confirmar').sort((a, b) => String(a.fecha).localeCompare(String(b.fecha))) };
}

// CSV del mes para la hoja de Drive «2. Adelantos y pagos fuera de nómina».
async function csvMes(mes, { _db = null } = {}) {
  const col = await _col(_db);
  const l = (await col.find({ mes }).toArray()).sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es') || String(a.fecha).localeCompare(String(b.fecha)));
  const q = v => { const s = v == null ? '' : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const filas = [['Mes', 'Fecha', 'Trabajador', 'Importe', 'Tipo', 'Medio', 'Cuenta a la que fue', 'Concepto del banco', 'Quién lo dio', 'Dónde se apuntó', 'Texto original', 'Nota', 'Estado', 'Confirmado por']];
  for (const d of l) filas.push([d.mes, d.fecha, d.nombre || '', String(d.importe).replace('.', ','), d.tipo ? TIPOS[d.tipo] : 'Por aclarar', d.medio, d.cuentaDe || '', d.concepto || '', d.quien || '', d.donde || '', d.textoOriginal || '', d.nota || '', d.estado, d.confirmadoPor || '']);
  return filas.map(f => f.map(q).join(';')).join('\n');
}

// Texto de un grupo o de Corpy que habla de un adelanto: «adelanto de 50 a Diego», «le he pasado 100 € a David».
function deTexto(texto, users) {
  const n = norm(texto);
  if (!/\b(adelanto|anticipo|le he (dado|pasado|hecho|enviado|mandado)|le (doy|paso|envio)|a cuenta)\b/.test(n)) return null;
  const mi = String(texto).match(/(\d{1,5}(?:[.,]\d{1,2})?)\s*(?:€|eur|euros?\b|e\b)/i) || String(texto).match(/\b(?:adelanto|anticipo)\s+(?:de\s+)?(\d{1,5}(?:[.,]\d{1,2})?)\b/i);
  if (!mi) return null;
  const importe = r2(Number(mi[1].replace(',', '.')));
  if (!(importe > 0)) return null;
  const c = users.filter(u => { const ws = norm(u.name).split(' ').filter(w => w.length >= 3); return ws.length && new RegExp(`\\b${ws[0]}\\b`).test(n); });
  if (c.length !== 1) return null;
  const medio = /\befectivo\b|\ben mano\b/.test(n) ? 'efectivo' : /\bbizum\b/.test(n) ? 'bizum' : 'banco';
  return { userId: String(c[0]._id), nombre: c[0].name, importe, medio };
}

async function desdeGrupo({ texto, quien, grupo }, { _db = null, _users = null } = {}) {
  const users = _users || (await require('./users').getUsers(false)).filter(u => u.active !== false);
  const p = deTexto(texto, users); if (!p) return null;
  return registrar({ ...p, tipo: 'adelanto', quien, donde: `grupo:${grupo || 'WhatsApp'}`, textoOriginal: texto, estado: p.medio === 'efectivo' ? 'confirmado' : 'por_confirmar' }, quien, { _db });
}

module.exports = { clasificar, partes, mesNombrado, tipoDeTexto, registrar, desdeBanco, siguientePregunta, responder, resumenMes, csvMes, deTexto, desdeGrupo, TIPOS, CUENTAN };
