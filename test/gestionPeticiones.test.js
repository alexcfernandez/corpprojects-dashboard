// Recados que no son de clientes («Otros / no es cliente») y gestionar recados y peticiones hablando con Corpy (4/11/2026).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ObjectId } = require('mongodb');

// Mongo de mentira: lo justo para estas consultas (igualdad, $in, $lt/$gte, $or, $ne, $exists).
function fakeDB() {
  const cols = {};
  const ok = (d, q) => Object.entries(q || {}).every(([k, v]) => {
    if (k === '$or') return v.some(x => ok(d, x));
    const x = k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), d);
    if (v && typeof v === 'object' && !(v instanceof Date) && Object.keys(v).some(c => c[0] === '$')) {
      return Object.entries(v).every(([op, w]) => op === '$in' ? (Array.isArray(x) ? x.some(y => w.some(z => String(z) === String(y))) : w.some(z => String(z) === String(x))) : op === '$lt' ? x < w : op === '$gte' ? x >= w : op === '$ne' ? x !== w : op === '$exists' ? (x !== undefined) === w : true);
    }
    if (v === null) return x == null;
    return Array.isArray(x) ? x.includes(v) : (v instanceof Date ? +x === +v : (v && v._bsontype === 'ObjectId') ? String(x) === String(v) : x === v);
  });
  const upd = (d, u) => {
    for (const [k, v] of Object.entries(u.$set || {})) d[k] = v;
    for (const k of Object.keys(u.$unset || {})) delete d[k];
    for (const [k, v] of Object.entries(u.$addToSet || {})) { d[k] = d[k] || []; for (const y of (v && v.$each) || [v]) if (!d[k].includes(y)) d[k].push(y); }
    for (const [k, v] of Object.entries(u.$push || {})) { d[k] = d[k] || []; d[k].push(...((v && v.$each) || [v])); }
  };
  const cursor = l => { const c = { sort: () => c, limit: n => { l = l.slice(0, n); return c; }, project: () => c, toArray: async () => l }; return c; };
  const collection = n => {
    const l = cols[n] = cols[n] || [];
    return {
      insertOne: async d => { if (d._id == null) d._id = new ObjectId(); l.push(d); return { insertedId: d._id }; },
      findOne: async q => l.find(d => ok(d, q)) || null,
      find: q => cursor(l.filter(d => ok(d, q))),
      updateOne: async (q, u, o = {}) => { let d = l.find(x => ok(x, q)); if (!d && o.upsert) { d = { _id: q._id }; l.push(d); } if (d) upd(d, u); return { matchedCount: d ? 1 : 0 }; },
      replaceOne: async (q, doc) => { const i = l.findIndex(x => ok(x, q)); if (i >= 0) l[i] = doc; else l.push(doc); return {}; },
      deleteOne: async q => { const i = l.findIndex(x => ok(x, q)); if (i >= 0) l.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; },
      countDocuments: async q => l.filter(d => ok(d, q)).length,
    };
  };
  return { collection, cols };
}
function conDB() { const dbm = require('../src/db'); const real = dbm.getDB; const db = fakeDB(); dbm.getDB = async () => db; return { db, fin: () => { dbm.getDB = real; } }; }

const cm = { 555: { name: 'CTAT PROP ILLA VERDA', family: 'CINC' }, 1: { name: 'KATERIN CARDONA', family: 'Particulares' } };
const cat = { clientes: [], incidencias: [], presupuestos: [], nombre: id => (cm[String(id)] || {}).name || '' };
const ALEX = '+34600000001';

test('recado de un proveedor (Exolution, Kit Digital): «Otros / no es cliente», sin comunidad, sin incidencia ni «¿Quién va?»', async () => {
  const { db, fin } = conDB();
  const PG = require('../src/peticionesGrupo');
  let auto = 0; const enviados = [];
  const prevW = process.env.WHATSAPP_TO; process.env.WHATSAPP_TO = ALEX;
  try {
    // El caso del 4/11 12:31: número desconocido acabado en 169, dice «Belpuig 41». La IA lo marca como no cliente.
    const r = await PG.deRecado({ llamada: 'E1', fecha: new Date('2026-11-04T11:31:00Z'), urgente: true, resumen: 'URGENTE · Fulgencio de Exolution llama por el Kit Digital, en Belpuig 41', contacto: { nombre: 'Fulgencio' }, final: '169', _cat: cat, _clientMap: cm,
      _llamar: async () => ({ peticiones: [{ msgs: [0], tipo: 'consulta', cliente_id: '555', cliente: 'Belpuig 41', resumen: 'Llama por el Kit Digital', que_hacer: 'Llamarle', urgente: true, situacion: 'nuevo', no_es_cliente: 'Fulgencio de Exolution, por el Kit Digital' }] }),
      _auto: async (d, g, l) => { auto += l.length; return {}; }, _enviar: async (to, txt) => { enviados.push(txt); return true; } });
    const p = db.cols.peticionesGrupo[0];
    assert.strictEqual(auto, 0, 'no crea incidencia ni pregunta quién va');
    assert.strictEqual(p.clienteId, null);
    assert.strictEqual(p.clienteStel, null);
    assert.strictEqual(p.porConfirmar, undefined, 'no sale el «Confirmar · ILLA VERDA»');
    assert.strictEqual(p.noCliente.que, 'Fulgencio de Exolution, por el Kit Digital');
    assert.strictEqual(p.cliente, 'Fulgencio');
    assert.strictEqual(r.nuevas[0].noCliente, 'Fulgencio de Exolution, por el Kit Digital');
    assert.match(enviados[0], /No es cliente\*: Fulgencio de Exolution, por el Kit Digital/);
    assert.doesNotMatch(enviados[0], /Por confirmar|ILLA VERDA/);
    await assert.rejects(require('../src/trabajos').crear(String(p._id), { userId: 'x' }), /no es de un cliente/);

    // Aunque la IA no lo marque, el Kit Digital nunca es una comunidad.
    await PG.deRecado({ llamada: 'E2', fecha: new Date('2026-11-04T12:00:00Z'), resumen: 'Llaman del Kit Digital por la justificación', contacto: { nombre: 'Marta' }, final: '170', _cat: cat, _clientMap: cm,
      _llamar: async () => ({ peticiones: [{ msgs: [0], tipo: 'consulta', cliente_id: null, cliente: '¿?', resumen: 'Justificación del Kit Digital', que_hacer: 'Llamar', urgente: false, situacion: 'nuevo' }] }),
      _auto: async (d, g, l) => { auto += l.length; return {}; }, _enviar: async () => true });
    assert.ok(db.cols.peticionesGrupo[1].noCliente);
    assert.strictEqual(auto, 0);

    // Un cliente conocido por su número sigue siendo cliente.
    await PG.deRecado({ llamada: 'K1', fecha: new Date('2026-11-04T13:00:00Z'), resumen: 'Gotera en el baño', contacto: { nombre: 'Katerin', externalId: '1' }, final: '108', _cat: cat, _clientMap: cm,
      _llamar: async () => ({ peticiones: [{ msgs: [0], tipo: 'trabajo', cliente_id: '1', cliente: 'Katerin', resumen: 'Gotera', que_hacer: 'Ir', urgente: false, situacion: 'nuevo' }] }),
      _auto: async (d, g, l) => { auto += l.length; return {}; }, _enviar: async () => true });
    assert.strictEqual(db.cols.peticionesGrupo[2].noCliente, undefined);
    assert.strictEqual(auto, 1);
  } finally { fin(); process.env.WHATSAPP_TO = prevW; if (prevW === undefined) delete process.env.WHATSAPP_TO; }
});

test('Corpy: «descarta el de Exolution» repite qué va a hacer y solo lo hace con el «sí»; nada se borra', async () => {
  const { db, fin } = conDB();
  const G = require('../src/gestionPeticiones');
  const id = new ObjectId();
  await db.collection('peticionesGrupo').insertOne({ _id: id, jid: 'voz:corp', canal: 'llamada', cliente: 'Fulgencio', noCliente: { que: 'Fulgencio de Exolution, por el Kit Digital' }, resumen: 'Llama por el Kit Digital', tipo: 'consulta', estado: 'pendiente', fecha: new Date(Date.now() - 3600e3) });
  await db.collection('peticionesGrupo').insertOne({ jid: 'g1', cliente: 'Cartagena 2', resumen: 'Pintar escalera', tipo: 'presupuesto', estado: 'pendiente', fecha: new Date() });
  try {
    const q = await G.proponer({ accion: 'descartar', peticion: 'el de Exolution' }, ALEX);
    assert.match(q, /^¿Hago esto\? Descartar \*Fulgencio de Exolution, por el Kit Digital\* .*recado hoy \d\d:\d\d · ref\. [0-9a-f]{5}\.\nContesta «sí» o «no»\.$/);
    assert.strictEqual(db.cols.peticionesGrupo[0].estado, 'pendiente', 'preguntar no cambia nada');
    assert.match(await G.respuesta('Sí.', ALEX), /Descartada/);
    const p = db.cols.peticionesGrupo[0];
    assert.strictEqual(p.estado, 'descartado');
    assert.deepStrictEqual([p.cambios[0].que, p.cambios[0].por, p.cambios[0].antes], ['descartado', 'Álex (Corpy)', 'pendiente']);
    assert.strictEqual(await G.respuesta('sí', ALEX), null, 'un segundo «sí» no hace nada más');

    // Si el mensaje siguiente es otra cosa, la pregunta se anula: un «sí» de después no toca nada.
    await G.proponer({ accion: 'hecho', peticion: 'Cartagena' }, ALEX);
    assert.strictEqual(await G.respuesta('¿cuántas horas lleva David?', ALEX), null);
    assert.strictEqual(await G.respuesta('sí', ALEX), null);
    assert.strictEqual(db.cols.peticionesGrupo[1].estado, 'pendiente');
    await G.proponer({ accion: 'hecho', peticion: 'Cartagena' }, ALEX);
    assert.match(await G.respuesta('no', ALEX), /no toco nada/);
    assert.strictEqual(db.cols.peticionesGrupo[1].estado, 'pendiente');
    assert.match(await G.proponer({ accion: 'descartar', peticion: 'Rahola' }, ALEX), /No encuentro ninguna petición abierta/);
  } finally { fin(); }
});

test('Corpy: si encajan varias, lista corta numerada; el número elige y aún pide el «sí»', async () => {
  const { db, fin } = conDB();
  const G = require('../src/gestionPeticiones'), PG = require('../src/peticionesGrupo');
  const realConf = PG.confirmar; const confirmadas = [];
  PG.confirmar = async (id, o, por) => { confirmadas.push({ id, ...o, por }); return { ok: true, incidencia: 'INC00701' }; };
  const a = new ObjectId(), b = new ObjectId();
  await db.collection('peticionesGrupo').insertOne({ _id: a, jid: 'voz:corp', canal: 'llamada', cliente: 'Katerin Cardona', titulo: 'Fuga en el baño', porConfirmar: { motivo: 'número desconocido u oculto' }, estado: 'pendiente', fecha: new Date(Date.now() - 7200e3) });
  await db.collection('peticionesGrupo').insertOne({ _id: b, jid: 'voz:corp', canal: 'llamada', cliente: 'Katerin Cardona', titulo: 'Persiana rota', porConfirmar: { motivo: 'número desconocido u oculto' }, estado: 'pendiente', fecha: new Date(Date.now() - 3600e3) });
  try {
    const l = await G.proponer({ accion: 'confirmar', peticion: 'el de Katerin' }, ALEX);
    assert.match(l, /Hay 2 que encajan\. ¿Cuál\?\n1\. \*Katerin Cardona\* \(Fuga en el baño\)[^\n]*\n2\. \*Katerin Cardona\* \(Persiana rota\)[^\n]*\nContesta con el número\./);
    assert.match(await G.respuesta('7', ALEX), /del 1 al 2/);
    assert.match(await G.respuesta('el 2', ALEX), /^¿Hago esto\? Confirmar \*Katerin Cardona\* \(Persiana rota\)/);
    assert.strictEqual(confirmadas.length, 0);
    assert.match(await G.respuesta('vale', ALEX), /Confirmada.*Incidencia INC00701/);
    assert.deepStrictEqual(confirmadas, [{ id: String(b), clienteId: null, por: 'Álex (Corpy)' }]);
  } finally { fin(); PG.confirmar = realConf; }
});

test('Corpy: «el de Belpuig no es de ILLA VERDA, es un proveedor», «ya he devuelto la llamada» y «lo de la bañera lo hace Álex»', async () => {
  const { db, fin } = conDB();
  const G = require('../src/gestionPeticiones'), U = require('../src/users'), T = require('../src/trabajos');
  const realUsers = U.getUsers, realCrear = T.crear;
  const users = [{ _id: 'a1', name: 'Álex', role: 'owner', whatsapp: ALEX }, { _id: 'd1', name: 'David', role: 'tecnico' }];
  U.getUsers = async () => users;
  const creados = []; T.crear = async (id, o) => { creados.push({ id, userId: o.userId }); return { pedido: 'PDT00600', incidencia: 'INC00702', operario: 'Álex', equipo: [], avisado: true }; };
  const bel = new ObjectId(), ban = new ObjectId();
  await db.collection('peticionesGrupo').insertOne({ _id: bel, jid: 'voz:corp', canal: 'llamada', cliente: 'Belpuig 41', clienteId: '555', clienteStel: 'CTAT PROP ILLA VERDA', recado: { nombre: 'Fulgencio', final: '169' }, resumen: 'Llama por algo de Belpuig 41', porConfirmar: { motivo: 'número desconocido u oculto' }, tipo: 'consulta', estado: 'pendiente', fecha: new Date() });
  await db.collection('peticionesGrupo').insertOne({ _id: ban, jid: 'voz:corp', canal: 'llamada', cliente: 'Katerin Cardona', clienteId: '1', clienteStel: 'KATERIN CARDONA', titulo: 'Bañera atascada', resumen: 'La bañera no traga', tipo: 'trabajo', incidencia: 'INC00660', estado: 'pendiente', fecha: new Date() });
  await db.collection('llamadasVoz').insertOne({ _id: 'llamada.perdida:X1', evento: 'llamada.perdida', llamada: 'X1', fecha: new Date(Date.now() - 600e3), contacto: { nombre: 'CTAT Barcelona 51' }, final: '051' });
  try {
    assert.match(await G.proponer({ accion: 'no_es_cliente', peticion: 'el de Belpuig', quien: 'Proveedor (Fulgencio)' }, ALEX), /^¿Hago esto\? Pasar a «Otros \/ no es cliente» \*CTAT PROP ILLA VERDA\*/);
    assert.match(await G.respuesta('si', ALEX), /Pasada a «Otros \/ no es cliente»/);
    let p = db.cols.peticionesGrupo[0];
    assert.strictEqual(p.noCliente.que, 'Proveedor (Fulgencio)');
    assert.strictEqual(p.clienteId, null);
    assert.strictEqual(p.porConfirmar, undefined);
    assert.strictEqual(p.cambios[0].antes.clienteStel, 'CTAT PROP ILLA VERDA', 'queda apuntado de dónde venía');

    assert.match(await G.proponer({ accion: 'devuelta', peticion: 'CTAT Barcelona 51' }, ALEX), /^¿Hago esto\? Apuntar que has devuelto la llamada perdida de \*CTAT Barcelona 51\*/);
    assert.match(await G.respuesta('sí', ALEX), /Ya no sale en perdidas/);
    assert.strictEqual(db.cols.llamadasVoz[0].devuelta, true);

    assert.match(await G.proponer({ accion: 'devuelta', peticion: 'Fulgencio' }, ALEX), /¿Hago esto\?/);
    assert.match(await G.respuesta('sí', ALEX), /la doy por hecha/);
    p = db.cols.peticionesGrupo[0];
    assert.strictEqual(p.estado, 'hecho');
    assert.ok(p.llamadaDevuelta);

    assert.match(await G.proponer({ accion: 'asignar', peticion: 'lo de la bañera', operario: 'Álex' }, ALEX), /^¿Hago esto\? Mandar a \*Álex\* a \*KATERIN CARDONA\* \(Bañera atascada\) · recado hoy \d\d:\d\d · INC00660\./);
    assert.strictEqual(creados.length, 0);
    assert.match(await G.respuesta('sí', ALEX), /PDT00600/);
    assert.deepStrictEqual(creados, [{ id: String(ban), userId: 'a1' }]);
    assert.match(await G.proponer({ accion: 'asignar', peticion: 'bañera', operario: 'Pepito' }, ALEX), /No sé quién es «Pepito»/);
  } finally { fin(); U.getUsers = realUsers; T.crear = realCrear; }
});

test('Corpy: un recado que le llega a Álex por fuera se apunta como los de SecretarIA, solo con el «sí»', async () => {
  const { db, fin } = conDB();
  const G = require('../src/gestionPeticiones'), PG = require('../src/peticionesGrupo'), S = require('../src/stelorder');
  const realRec = PG.deRecado, realCl = S.getClients;
  S.getClients = async () => ({ clientMap: { 556: { name: 'CTAT PROP BELLPUIG 41', family: 'CINC', phone: '972 11 22 33' }, 1: { name: 'KATERIN CARDONA', family: 'Particulares', phone: '' } } });
  const llamadas = [];
  PG.deRecado = async o => { llamadas.push(o); return { nuevas: [{ id: 'x', cliente: 'CTAT PROP BELLPUIG 41', resumen: 'Gotera en el 3º 1ª', incidencia: 'INC00710' }], actualizadas: [] }; };
  try {
    const q = await G.proponerRecado({ texto: 'Marta dice que hay una gotera en el 3º 1ª', quien: 'Marta', telefono: '+34 972 112 233', urgente: true }, ALEX);
    assert.match(q, /^¿Hago esto\? Apuntar recado 🚨 urgente de \*Marta\* \(tel\. …233\) · cliente \*CTAT PROP BELLPUIG 41\* \(por su teléfono\): «Marta dice que hay una gotera en el 3º 1ª»\./);
    assert.strictEqual(llamadas.length, 0, 'preguntar no apunta nada');
    assert.match(await G.respuesta('sí', ALEX), /Incidencia INC00710; ahora te pregunto quién va/);
    assert.strictEqual(llamadas.length, 1);
    assert.deepStrictEqual([llamadas[0].contacto, llamadas[0].final, llamadas[0].origen, llamadas[0].avisar, llamadas[0].urgente], [{ nombre: 'Marta', externalId: '556' }, '233', 'Álex', false, true]);
    // Con el cliente dicho por Álex y sin teléfono.
    await G.proponerRecado({ texto: 'Quiere presupuesto del baño', quien: 'Katerin', cliente: 'Katerin Cardona' }, ALEX);
    assert.match(await G.respuesta('no', ALEX), /no toco nada/);
    assert.strictEqual(llamadas.length, 1);
    assert.match(await G.proponerRecado({ texto: '' }, ALEX), /¿Qué recado apunto\?/);
  } finally { fin(); PG.deRecado = realRec; S.getClients = realCl; }
});

test('deRecado con origen Álex: no le avisa por WhatsApp de lo que acaba de contar y queda apuntado de dónde vino', async () => {
  const { db, fin } = conDB();
  const PG = require('../src/peticionesGrupo');
  const enviados = []; let prompt = '';
  try {
    await PG.deRecado({ llamada: 'corpy:1', urgente: true, resumen: 'Gotera en el 3º 1ª', contacto: { nombre: 'Marta', externalId: '555' }, final: '233', origen: 'Álex', avisar: false, _cat: cat, _clientMap: cm,
      _llamar: async p => { prompt = p; return { peticiones: [{ msgs: [0], tipo: 'trabajo', cliente_id: '555', cliente: 'Illa Verda', resumen: 'Gotera', que_hacer: 'Ir', urgente: true, situacion: 'nuevo' }] }; },
      _auto: async () => ({}), _enviar: async (to, t) => { enviados.push(t); return true; } });
    assert.deepStrictEqual(enviados, []);
    assert.match(prompt, /NO viene de SecretarIA: se lo ha contado Álex/);
    assert.match(prompt, /Según Álex, quien llama es el cliente de StelOrder 555/);
    assert.strictEqual(db.cols.peticionesGrupo[0].recado.origen, 'Álex');
    assert.strictEqual(db.cols.peticionesGrupo[0].porConfirmar, undefined, 'el cliente lo dice Álex: no queda por confirmar');
  } finally { fin(); }
});

test('Corpy: «qué recados tengo» da lista numerada y «descarta el 2» usa esa lista', async () => {
  const { db, fin } = conDB();
  const G = require('../src/gestionPeticiones');
  const a = new ObjectId(), b = new ObjectId();
  await db.collection('peticionesGrupo').insertOne({ _id: a, jid: 'voz:corp', canal: 'llamada', cliente: 'Katerin Cardona', titulo: 'Fuga', urgente: true, incidencia: 'INC00660', estado: 'pendiente', fecha: new Date(Date.now() - 7200e3) });
  await db.collection('peticionesGrupo').insertOne({ _id: b, jid: 'voz:corp', canal: 'llamada', cliente: 'Fulgencio', noCliente: { que: 'Fulgencio de Exolution' }, estado: 'pendiente', fecha: new Date(Date.now() - 3600e3) });
  await db.collection('llamadasVoz').insertOne({ _id: 'llamada.perdida:Y', evento: 'llamada.perdida', llamada: 'Y', fecha: new Date(Date.now() - 600e3), contacto: { nombre: 'Pere' }, final: '777' });
  try {
    const l = await G.verRecados(ALEX);
    assert.match(l, /Recados abiertos\* \(2 · 1 perdida sin devolver\)\n1\. 🚨 \*Katerin Cardona\* \(Fuga\)[^\n]*— falta quién va\n2\. \*Fulgencio de Exolution\*[^\n]*— 📇 no es cliente\n3\. llamada perdida de \*Pere\*[^\n]*— sin recado/);
    assert.match(await G.proponer({ accion: 'descartar', peticion: 'el 2' }, ALEX), /^¿Hago esto\? Descartar \*Fulgencio de Exolution\*/);
    assert.match(await G.respuesta('sí', ALEX), /Descartada/);
    assert.strictEqual(db.cols.peticionesGrupo[1].estado, 'descartado');
    assert.strictEqual(db.cols.peticionesGrupo[0].estado, 'pendiente');
    assert.match(await G.proponer({ accion: 'devuelta', peticion: '3' }, ALEX), /devuelto la llamada perdida de \*Pere\*/);
    assert.match(await G.proponer({ accion: 'descartar', peticion: '9' }, ALEX), /No tengo a mano una lista con el 9/);
  } finally { fin(); }
});
