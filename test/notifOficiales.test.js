'use strict';
const test = require('node:test');
const assert = require('node:assert');
const N = require('../src/notifOficiales');

// Base de datos de mentira: igualdad, $in, $gte/$lte, $exists, $or y rutas con punto; insertOne, updateOne ($set/$addToSet).
function fakeDb(cols = {}) {
  const val = (d, k) => k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), d);
  const ok = (d, q) => Object.entries(q).every(([k, v]) => {
    if (k === '$or') return v.some(x => ok(d, x));
    const x = val(d, k);
    if (v && typeof v === 'object' && !(v instanceof Date) && !v._bsontype) {
      if ('$exists' in v) return (x !== undefined) === v.$exists;
      if ('$in' in v) return v.$in.includes(x);
      if ('$gte' in v || '$lte' in v) return x != null && (!('$gte' in v) || x >= v.$gte) && (!('$lte' in v) || x <= v.$lte);
    }
    return String(x) === String(v);
  });
  let n = 0;
  return { collection: name => { const l = (cols[name] = cols[name] || []); return {
    find: q => ({ toArray: async () => l.filter(d => ok(d, q)) }),
    findOne: async q => l.find(d => ok(d, q)) || null,
    insertOne: async d => { d._id = d._id || 'id' + (++n); l.push(d); return { insertedId: d._id }; },
    updateOne: async (q, u) => { const d = l.find(x => ok(x, q)); if (!d) return {};
      for (const [k, v] of Object.entries(u.$set || {})) { const ps = k.split('.'); let o = d; ps.slice(0, -1).forEach(p => { o[p] = o[p] || {}; o = o[p]; }); o[ps[ps.length - 1]] = v; }
      for (const [k, v] of Object.entries(u.$addToSet || {})) { d[k] = d[k] || []; if (!d[k].includes(v)) d[k].push(v); }
      return {}; },
  }; }, cols };
}

const DEHU = `<ul><li>CORP.PROJECTS HOLDING SOCIEDAD LIMITADA &nbsp;con NIF/NIE:&nbsp;B09899253 en calidad de Titular</li>
<li>Organismo emisor: Organismo Autónomo de Gestión Tributaria, con DIR3: LA0005454</li><li>Identificador: 304395242</li>
<li>Con vencimiento el d&iacute;a: 27/09/2026</li><li>Concepto: MULTES - TORDERA</li></ul><p>C&oacute;mo puedes acceder:</p>
<p>enlace directo a la notificaci&oacute;n:&nbsp;https://dehu.redsara.es/es/notifications/pending/224d2460e1/aceptar</p>`;
const ENOTUM = `<h1>Ajuntament de Girona</h1><p>Has rebut una notificació electrònica.</p><a href='https://usuari.enotum.cat?id=276589022&o=17&acces=BAIX'>Identifica't</a>
<table><tr><th>Destinatari</th><td>CORP. PROJECTS HOLDING S.L. (******253)</td></tr><tr><th>Emissor</th><td>Ajuntament de Girona</td></tr>
<tr><th>Assumpte</th><td>Denegar el dret a l'exercici de l'activitat urbanística</td></tr><tr><th>Data de lliurament</th><td>08/07/2026 a les 15:06 h</td></tr>
<tr><th>Accés fins</th><td>18/07/2026 a les 23:59 h</td></tr><tr><th>Id. Notificació</th><td>276589022</td></tr></table>`;
const REDES = `<p>Le informamos que dispone de una nueva <span>notificación&nbsp;</span>como TITULAR del organismo RED.ES</p><ul><li>TITULAR: Corp. Projects Holding, SL</li></ul>
<ul><li><span>Concepto</span>: KD/0001063881 - PDCR: Notificación inicio del procedimiento de la pérdida del derecho al cobro o reintegro<br></li></ul><p>Puede acceder a esta notificación en la Sede</p>`;
const MULTIVIA = `<p>Le REQUERIMOS con carácter URGENTE que nos remita los datos del Conductor</p><table><tr><td>DENUNCIADO:</td><td>CORP.PROJECTS HOLDING SOCIEDAD LIMITADA.</td></tr>
<tr><td>Nº EXPEDIENTE:</td><td>1635737</td></tr><tr><td>MATRÍCULA:</td><td>4694DWT</td></tr><tr><td>FECHA INFRACCIÓN:</td><td>25/06/2026</td></tr>
<tr><td>INFRACCIÓN IMPUTADA:</td><td>ESTACIONAMIENTO</td></tr><tr><td>IMPORTE PROPUESTO:</td><td>50.00</td></tr><tr><td>PUNTOS:</td><td>-</td></tr>
<tr><td>ORGANISMO SANCIONADOR:</td><td>AJUNTAMENT DE GIRONA</td></tr></table><p>Para evitar la sanción, introduzca los datos</p>
<a href="https://xvia-serviciosjuridicos.online/datoscliente.php?token=abc">Introducir</a>`;

test('lee DEHú: organismo, número, plazo y concepto; «MULTES» la marca como multa', () => {
  const r = N.leer({ de: 'DEHú <noreply.dehu@correo.gob.es>', asunto: 'Envío: Aviso de cortesía de una nueva notificación electrónica', cuerpo: DEHU, fecha: new Date('2026-09-17T11:08:05Z') });
  assert.strictEqual(r.organismo, 'Organismo Autónomo de Gestión Tributaria');
  assert.strictEqual(r.identificador, '304395242');
  assert.strictEqual(r.vence, '2026-09-27');
  assert.strictEqual(r.concepto, 'MULTES - TORDERA');
  assert.strictEqual(r.tipo, 'multa');
  assert.match(r.enlace, /dehu\.redsara\.es\/es\/notifications\/pending/);
});

test('lee e-NOTUM (Ajuntament) con «Accés fins» y el enlace', () => {
  const r = N.leer({ de: 'norespongueu@enotum.cat', asunto: "IMPORTANT: Avís de notificació de l'ens Ajuntament de Girona", cuerpo: ENOTUM, fecha: new Date('2026-07-08T13:06:05Z') });
  assert.strictEqual(r.organismo, 'Ajuntament de Girona');
  assert.strictEqual(r.identificador, '276589022');
  assert.strictEqual(r.vence, '2026-07-18');
  assert.strictEqual(r.tipo, 'notificacion');
  assert.match(r.enlace, /usuari\.enotum\.cat\?id=276589022/);
});

test('Red.es: 10 días para abrirla desde que llega', () => {
  const r = N.leer({ de: 'avisos-pkd@acelerapyme.gob.es', asunto: 'Notificación nueva', cuerpo: REDES, fecha: new Date('2026-10-16T01:15:44Z') });
  assert.match(r.concepto, /^KD\/0001063881 - PDCR/);
  assert.strictEqual(r.vence, '2026-10-26');
  assert.strictEqual(r.tipo, 'notificacion');
});

test('Multivia: la multa con matrícula, día, importe y sin puntos', () => {
  const r = N.leer({ de: 'datos@xvia-serviciosjuridicos.com', asunto: 'Solicitud Datos Conductor - 44049', cuerpo: MULTIVIA, fecha: new Date('2026-09-02T06:26:12Z') });
  assert.strictEqual(r.tipo, 'multa');
  assert.strictEqual(r.identificador, '1635737');
  assert.deepStrictEqual({ ...r.multa }, { matricula: '4694DWT', fechaInfraccion: '2026-06-25', infraccion: 'ESTACIONAMIENTO', importe: 50, puntos: 0 });
  assert.strictEqual(r.organismo, 'AJUNTAMENT DE GIRONA');
});

test('multa: quién llevaba la furgoneta ese día y aviso con el plazo de 20 días; la repetida no vuelve a avisar', async () => {
  const db = fakeDb({
    vehiculos: [{ _id: 'v1', nombre: 'Transit', matricula: '4694DWT', historialConductor: [{ userId: 'u1', name: 'Diego', desde: '2026-01-01', hasta: '2026-07-31' }, { userId: 'u2', name: 'David', desde: '2026-08-01', hasta: null }] }],
    attendance: [{ workerId: 'u1', date: '2026-06-25', estado: 'trabajo' }],
  });
  const enviados = [];
  const p = N.leer({ de: 'datos@xvia-serviciosjuridicos.com', asunto: 'Solicitud Datos Conductor - 44049', cuerpo: MULTIVIA, fecha: new Date() });
  const d = await N.registrar(p, { gmailId: 'g1', _db: db, _enviar: async t => enviados.push(t) });
  const plazo = new Date(Date.now() + 20 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
  assert.strictEqual(d.conductorPropuesto.conductor.name, 'Diego');
  assert.strictEqual(d.conductorPropuesto.trabajo, true);
  assert.strictEqual(d.plazoIdentificar, plazo);
  assert.strictEqual(enviados.length, 1);
  assert.match(enviados[0], /La llevaba \*Diego\*/);
  assert.ok(enviados[0].includes(plazo.split('-').reverse().join('/')));
  const otra = await N.registrar(p, { gmailId: 'g2', _db: db, _enviar: async t => enviados.push(t) });
  assert.strictEqual(otra.repetida, true);
  assert.strictEqual(enviados.length, 1);
  assert.deepStrictEqual(db.cols.notifOficiales[0].gmailIds, ['g1', 'g2']);
});

test('Red.es llega dos veces (TITULAR y DESTINATARIO): una sola, y recordatorio 2 días antes y el último día', async () => {
  const db = fakeDb(); const enviados = []; const env = async t => enviados.push(t);
  const p = N.leer({ de: 'avisos-pkd@acelerapyme.gob.es', asunto: 'Notificación nueva', cuerpo: REDES, fecha: new Date('2026-10-16T01:15:44Z') });
  await N.registrar(p, { _db: db, _enviar: env, avisar: false });
  await N.registrar({ ...p }, { _db: db, _enviar: env, avisar: false });
  assert.strictEqual(db.cols.notifOficiales.length, 1);
  assert.strictEqual((await N.recordatorios({ hoy: '2026-10-23', _db: db, _enviar: env })).avisos.length, 0);
  assert.deepStrictEqual((await N.recordatorios({ hoy: '2026-10-24', _db: db, _enviar: env })).avisos.map(a => a.clave), ['vence2']);
  assert.deepStrictEqual((await N.recordatorios({ hoy: '2026-10-24', _db: db, _enviar: env })).avisos, []);
  assert.deepStrictEqual((await N.recordatorios({ hoy: '2026-10-26', _db: db, _enviar: env })).avisos.map(a => a.clave), ['vence0']);
  assert.match(enviados[1], /HOY es el último día/);
  await N.recordatorios({ hoy: '2026-10-27', _db: db, _enviar: env });
  assert.strictEqual(db.cols.notifOficiales[0].estado, 'caducada');
});

test('las comunicaciones solo informan y lo ya vencido entra como caducado', async () => {
  const db = fakeDb();
  const com = await N.registrar({ fuente: 'dehu', tipo: 'comunicacion', organismo: 'AEAT', identificador: '1', concepto: 'Comunicación', recibida: '2026-05-25', vence: null }, { _db: db, avisar: false });
  assert.strictEqual(com.estado, 'informativa');
  const vieja = await N.registrar({ fuente: 'dehu', tipo: 'notificacion', organismo: 'TGSS', identificador: '2', concepto: 'Reclamación', recibida: '2020-01-01', vence: '2020-01-11' }, { _db: db, avisar: false });
  assert.strictEqual(vieja.estado, 'caducada');
});

test('la misma de Red.es por DEHú (con número) y por el aviso de Red.es (sin número) es una sola', async () => {
  const db = fakeDb();
  await N.registrar(N.leer({ de: 'avisos-pkd@acelerapyme.gob.es', asunto: 'Notificación nueva', cuerpo: REDES, fecha: new Date('2026-10-16T01:15:44Z') }), { _db: db, avisar: false });
  const d = await N.registrar({ fuente: 'dehu', tipo: 'notificacion', organismo: 'Entidad Pública Empresarial Red.Es', identificador: '99613696', recibida: '2026-10-16', vence: '2026-10-26',
    concepto: 'KD/0001063881 - PDCR: Notificación inicio del procedimiento de la pérdida del derecho al cobro o reintegro' }, { _db: db, avisar: false });
  assert.strictEqual(d.repetida, true);
  assert.strictEqual(db.cols.notifOficiales.length, 1);
});

test('las resoluciones de altas/bajas de Tesorería se guardan sin avisar; multa vieja de Multivia entra caducada', async () => {
  const db = fakeDb(); const enviados = []; const env = async t => enviados.push(t);
  const r = await N.registrar({ fuente: 'dehu', tipo: 'notificacion', organismo: 'Tesoreria General de la Seguridad Social', identificador: '', recibida: '2099-01-01', vence: '2099-01-11',
    concepto: 'REGIMENES SEG. SOCIAL OBLIGADOS A RED / 1790A45 / RESOLUCION ALTAS/BAJAS (RED)' }, { _db: db, _enviar: env });
  assert.strictEqual(r.estado, 'informativa');
  assert.strictEqual(enviados.length, 0);
  const m = await N.registrar(N.leer({ de: 'datos@xvia-serviciosjuridicos.com', asunto: 'Solicitud Datos Conductor', cuerpo: MULTIVIA, fecha: new Date('2026-09-02T06:26:12Z') }), { _db: db, _enviar: env });
  assert.strictEqual(m.estado, 'caducada');
});

test('multa de antes del historial: propone quien la lleva desde que se apuntó, avisando de que es aproximado', async () => {
  const db = fakeDb({ vehiculos: [{ _id: 'v1', nombre: 'Transit', matricula: '4694DWT', historialConductor: [{ userId: 'u2', name: 'David', desde: '2026-10-02', hasta: null }] }] });
  const c = await N.conductorEn('4694 DWT', '2026-06-25', { _db: db });
  assert.strictEqual(c.conductor.name, 'David');
  assert.strictEqual(c.aprox, true);
  assert.match(c.nota, /no hay historial de esa fecha/);
});
