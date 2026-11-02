'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/peticionesGrupo');

test('parsearChat: formato Android y iPhone, líneas seguidas y fotos', () => {
  const android = `20/10/26, 9:15 - Los mensajes y las llamadas están cifrados de extremo a extremo.
20/10/26, 9:16 - Anna SYNC: Bon dia, de Bellpuig 41 3r 1a torna a entrar aigua
pel sostre del menjador
20/10/26, 9:17 - Anna SYNC: <Multimedia omitido>
20/10/26, 21:05 - Álex: Ok, mañana vamos`;
  const a = P.parsearChat(android);
  assert.strictEqual(a.length, 3);
  assert.strictEqual(a[0].quien, 'Anna SYNC');
  assert.match(a[0].texto, /pel sostre del menjador/);
  assert.strictEqual(a[1].media, true);
  // 9:16 en Madrid (verano, UTC+2) = 7:16 UTC
  assert.strictEqual(a[0].fecha.toISOString(), '2026-10-20T07:16:00.000Z');
  const ios = `[3/2/26, 18:40:12] Jordi Finques: Necessitem pressupost per pintar l'escala de Carme 60
[3/2/26, 18:41:00] Jordi Finques: ‎image omitted`;
  const b = P.parsearChat(ios);
  assert.strictEqual(b.length, 2);
  assert.strictEqual(b[0].fecha.toISOString(), '2026-02-03T17:40:12.000Z');   // invierno, UTC+1
  assert.strictEqual(b[1].media, true);
});

test('_tanda: guarda peticiones nuevas y une la misma cosa a una abierta', async () => {
  const guardadas = [];
  const db = { collection: () => ({
    find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [{ _id: { toString: () => '6ad000000000000000000001' }, cliente: 'Montjovi 20', resumen: 'Filtraciones 3º 1ª' }] }) }) }),
    insertOne: async d => { guardadas.push(d); return { insertedId: 'x' }; },
    updateOne: async (q, u) => { guardadas.push({ actualiza: true, ...u.$set }); },
  }) };
  const msgs = [
    { fecha: new Date(), quien: 'Anna', texto: 'Pressupost per canviar el canal de Sant Narcís 98', fotoIds: ['f1'] },
    { fecha: new Date(), quien: 'Anna', texto: 'Montjovi 20 continua entrant aigua, quan hi aneu?' },
    { fecha: new Date(), quien: 'Álex', texto: 'ok' },
  ];
  const cat = { clientes: ['15538798 · CASTELL SOLTERRA, 16'], incidencias: [], presupuestos: [], nombre: id => (id === '15538798' ? 'CASTELL SOLTERRA, 16' : '') };
  const r = await P._tanda(db, { jid: 'g@g.us', grupo: 'Projects Holding', msgs, fuente: 'whatsapp', cat, _llamar: async prompt => {
    assert.match(prompt, /\[0\] .*Anna: Pressupost/);
    assert.match(prompt, /6ad000000000000000000001 · Montjovi 20/);
    return { peticiones: [
      { msgs: [0], tipo: 'presupuesto', cliente_id: null, cliente: 'Sant Narcís 98', resumen: 'Cambiar el canalón', que_hacer: 'Ir a mirar y hacer presupuesto', urgente: false, situacion: 'nuevo' },
      { msgs: [1], tipo: 'queja', cliente: 'Montjovi 20', resumen: 'Sigue entrando agua', que_hacer: 'Dar fecha', urgente: true, situacion: 'seguimiento', actualiza: '6ad000000000000000000001' },
      { msgs: [9], tipo: 'consulta', cliente: '?', resumen: '?', que_hacer: '?', urgente: false, situacion: 'nuevo' },
    ] };
  } });
  assert.strictEqual(r.nuevas.length, 1);
  assert.strictEqual(r.actualizadas.length, 1);
  assert.deepStrictEqual(guardadas[0].fotoIds, ['f1']);
  assert.strictEqual(guardadas[0].estado, 'pendiente');
  const txt = P._textoAviso('Projects Holding', r.nuevas, r.actualizadas);
  assert.match(txt, /💶 Presupuesto · \*Sant Narcís 98\*/);
  assert.match(txt, /🚨 ⚠️ Queja · \*Montjovi 20\*.*\(insisten\)/);
});

test('resumenDiario: correo con lo nuevo y lo abierto', async () => {
  const P2 = require('../src/peticionesGrupo');
  const db = require('../src/db');
  const real = db.getDB;
  const hoy = new Date();
  const docs = { bridgeGrupos: [{ _id: 'g@g.us', activo: true, peticiones: true }], grupoMensajes: 3,
    peticionesGrupo: [{ _id: 'a', tipo: 'presupuesto', cliente: 'Pare Coll 13', resumen: 'Terraza', queHacer: 'Ir a medir', situacion: 'nuevo', fecha: new Date(hoy - 9 * 864e5), urgente: false, creado: new Date(hoy - 9 * 864e5) }] };
  db.getDB = async () => ({ collection: n => ({
    find: () => ({ toArray: async () => docs[n], sort: () => ({ toArray: async () => docs[n] }) }),
    countDocuments: async () => docs[n],
  }) });
  try {
    let enviado = null;
    const r = await P2.resumenDiario({ hoy, _enviar: async m => { enviado = m; return true; } });
    assert.strictEqual(r.enviado, true);
    assert.match(enviado.subject, /abierta/);
    assert.match(enviado.html, /Pare Coll 13/);
    assert.match(enviado.html, /9 días/);
  } finally { db.getDB = real; }
});

test('consultas que no piden nada no avisan', () => {
  assert.strictEqual(P._sinAccion({ tipo: 'consulta', queHacer: 'Nada, no hay acción requerida.' }), true);
  assert.strictEqual(P._sinAccion({ tipo: 'consulta', queHacer: 'Contestar cuándo vamos' }), false);
  assert.strictEqual(P._sinAccion({ tipo: 'trabajo', queHacer: 'Nada' }), false);
});

test('_autoIncidencias: trabajo nuevo crea incidencia, propone operario y pide el contacto en el grupo', async () => {
  const set = [], enviados = [];
  const db = { collection: () => ({ updateOne: async (q, u) => set.push(u.$set) }) };
  const g = { _id: 'g@g.us', autoIncidencia: true, corpyResponde: true };
  const nuevas = [
    { _id: 'p1', tipo: 'trabajo', situacion: 'nuevo', clienteId: '15538798', cliente: 'Castell Solterra 16', direccion: 'parking', contacto: null, pedirContacto: true },
    { _id: 'p2', tipo: 'presupuesto', situacion: 'nuevo', clienteId: '1', cliente: 'Otra', contacto: null },
    { _id: 'p3', tipo: 'queja', situacion: 'nuevo', clienteId: null, cliente: 'Sin cliente', contacto: 'Marta 600000000' },
  ];
  const auto = await P._autoIncidencias(db, g, nuevas, {
    _crear: async id => ({ ref: 'INC00999', id: '1' }),
    _propuesta: async id => ({ propuesta: { nombre: 'David Taladros', fechaTxt: 'lunes 02/11', hora: '09:00', motivo: 'ese día lo tiene libre' } }),
    _enviar: async (to, txt) => { enviados.push({ to, txt }); return true; },
  });
  assert.strictEqual(auto.p1.incidencia, 'INC00999');
  assert.strictEqual(auto.p1.pedidoContacto, true);
  assert.strictEqual(auto.p2, undefined);
  assert.match(auto.p3.error, /comunidad/);
  assert.strictEqual(enviados.length, 1);
  assert.strictEqual(enviados[0].to, 'g@g.us');
  const txt = P._textoAviso('Projects Holding', nuevas.slice(0, 1), [], auto);
  assert.match(txt, /INC00999/);
  assert.match(txt, /Propongo a \*David Taladros\*/);
  assert.match(txt, /He pedido en el grupo/);
  assert.deepStrictEqual(await P._autoIncidencias(db, { _id: 'x@g.us' }, nuevas), {});
});

test('presupuestoEnviado: un PRT mandado al grupo marca la petición y deja la nota en StelOrder', async () => {
  assert.strictEqual(P.refDePdf('PRT00853.pdf'), 'PRT00853');
  assert.strictEqual(P.refDePdf('PRESUPUESTODETRABAJO-00754-JOAN_MARAGALL__34.pdf'), 'PRT00754');
  assert.strictEqual(P.refDePdf('FACTURA-00998.pdf'), null);
  const path = require('path'); const dbPath = require.resolve(path.join(__dirname, '..', 'src', 'db.js'));
  const previo = require.cache[dbPath];
  const pets = [{ _id: 'a', jid: 'g@g.us', tipo: 'presupuesto', estado: 'pendiente', clienteId: '15325413', presupuesto: null }];
  const set = [];
  const col = { find: q => ({ toArray: async () => pets.filter(p => Object.entries(q).every(([k, v]) => p[k] === v)) }), updateOne: async (q, u) => set.push(u.$set) };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDB: async () => ({ collection: () => col }) } };
  const notas = [];
  try {
    const r = await P.presupuestoEnviado({ jid: 'g@g.us', grupo: 'Projects Holding', nombres: ['PRT00853.pdf', 'foto.pdf'], por: 'Alex', ts: new Date('2026-10-23T08:50:00Z') },
      { _presupuestos: async () => [{ id: 61, 'full-reference': 'PRT00853', 'account-id': 15325413 }], _nota: async (id, t) => { notas.push({ id, t }); return true; } });
    assert.deepStrictEqual(r.refs, [{ ref: 'PRT00853', peticiones: 1, nota: true }]);
    assert.strictEqual(set[0].presupuesto, 'PRT00853');
    assert.strictEqual(set[0].estado, 'hecho');
    assert.match(set[0].queHacer, /PRT00853 enviado al grupo el 23\/10\/26/);
    assert.strictEqual(notas[0].id, 61);
    assert.match(notas[0].t, /Enviado por WhatsApp al grupo «Projects Holding»/);
  } finally { if (previo) require.cache[dbPath] = previo; else delete require.cache[dbPath]; }
});

test('_autoIncidencias: si alguien de Corp ya contestó o no hace falta contacto, Corpy no pregunta en el grupo', async () => {
  const enviados = [], propuestas = [];
  const db = { collection: () => ({ updateOne: async () => {} }) };
  const g = { _id: 'g@g.us', autoIncidencia: true, corpyResponde: true };
  const nuevas = [
    // Joan Maragall 5º 3ª (2/11/2026): «ya que estáis colgados» y Alfonso contestó «Si miramos».
    { _id: 'jm', tipo: 'trabajo', situacion: 'nuevo', clienteId: '1', cliente: 'Joan Maragall 44-46', direccion: '5º 3ª', contacto: null, respondimos: true, pedirContacto: false },
    { _id: 'zc', tipo: 'trabajo', situacion: 'nuevo', clienteId: '2', cliente: 'Creu 2', direccion: 'cubierta', contacto: null, respondimos: false, pedirContacto: false },
  ];
  const auto = await P._autoIncidencias(db, g, nuevas, {
    _crear: async () => ({ ref: 'INC00653' }), _propuesta: async id => { propuestas.push(id); return { propuesta: null }; },
    _enviar: async (to, txt) => { enviados.push(txt); return true; },
  });
  assert.strictEqual(enviados.length, 0);
  assert.strictEqual(auto.jm.incidencia, 'INC00653');
  assert.strictEqual(auto.jm.yaContestado, true);
  assert.deepStrictEqual(propuestas, ['zc']);
  assert.match(P._textoAviso('Projects Holding', nuevas.slice(0, 1), [], auto), /Ya contestó alguien de Corp/);
});

test('_tanda: lleva la conversación anterior, reabre una queja archivada y el aviso la incluye', async () => {
  const sets = [];
  const abierta = { _id: { toString: () => '6ad7a435a3989bc018e3be2b' }, cliente: 'Cartagena 2-4-6', resumen: 'Malla antipalomas', estado: 'archivo', contacto: 'Presidente 600000000', fecha: new Date('2026-10-08T13:40:00Z') };
  const db = { collection: () => ({
    find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [abierta] }) }) }),
    updateOne: async (q, u) => { sets.push(u.$set); },
  }) };
  const msgs = [{ fecha: new Date(), quien: 'CINC Gestió Inmobiliària', texto: 'osea el precio de los pinchos sube el doble?' }];
  const r = await P._tanda(db, { jid: 'g@g.us', grupo: 'Projects Holding', msgs, fuente: 'whatsapp', cat: { clientes: [], incidencias: [], presupuestos: [], nombre: () => '' },
    contexto: ['02/11/26, 11:30 Corpy (oficina Corp): ¿nos pasáis un nombre y teléfono de contacto?'],
    _llamar: async prompt => {
      assert.match(prompt, /CONVERSACIÓN ANTERIOR[\s\S]*Corpy \(oficina Corp\): ¿nos pasáis/);
      assert.match(prompt, /6ad7a435a3989bc018e3be2b · Cartagena 2-4-6 · Malla antipalomas · 08\/10\/26/);
      return { peticiones: [{ msgs: [0], tipo: 'queja', cliente: 'Cartagena 2-4-6', resumen: 'El precio de los pinchos dobla', que_hacer: 'Llamar al presidente', urgente: false, situacion: 'ya_hay_presupuesto', respondimos: false, actualiza: '6ad7a435a3989bc018e3be2b' }] };
    } });
  assert.strictEqual(sets[0].estado, 'pendiente');
  assert.strictEqual('contacto' in sets[0], false);   // el contacto que ya teníamos no se pisa con null
  assert.ok(sets[0].reabiertaAt);
  assert.match(P._textoAviso('Projects Holding', [], r.actualizadas), /Queja · \*Cartagena 2-4-6\*/);
  // Si Corp ya contestó la queja, no se avisa otra vez.
  assert.doesNotMatch(P._textoAviso('Projects Holding', [], [{ ...r.actualizadas[0], respondimos: true }]), /Cartagena/);
});

test('presupuestoDevuelto: un PRT nuestro con sello o firma avisa y marca la petición; sin firma no hace nada', async () => {
  const db = require('../src/db'); const real = db.getDB;
  const ops = [];
  db.getDB = async () => ({ collection: n => ({
    insertOne: async d => { ops.push([n, 'insert', d.texto]); return { insertedId: 'f1' }; },
    find: () => ({ toArray: async () => [{ _id: 'p1' }] }),
    updateOne: async (q, u) => { ops.push([n, 'update', u.$set.queHacer]); },
  }) });
  try {
    const avisos = [];
    const sin = await P.presupuestoDevuelto({ jid: 'g@g.us', ref: 'PRT00876', firmado: false, quien: 'CINC' }, { _avisar: async t => avisos.push(t) });
    assert.deepStrictEqual([sin.firmado, avisos.length, ops.length], [false, 0, 0]);
    const r = await P.presupuestoDevuelto({ jid: 'g@g.us', grupo: 'Projects Holding', ref: 'PRT00876', firmado: true, quien: 'CINC Gestió Inmobiliària', data: Buffer.from('x'), mimetype: 'application/pdf' }, { _avisar: async t => avisos.push(t) });
    assert.deepStrictEqual([r.ref, r.peticiones], ['PRT00876', 1]);
    assert.match(avisos[0], /CINC Gestió Inmobiliària.*PRT00876.*sello o firma/);
    assert.ok(ops.some(o => o[0] === 'grupoFotos'));
    assert.ok(ops.some(o => o[0] === 'peticionesGrupo' && /parece aceptado/.test(o[2])));
  } finally { db.getDB = real; }
});
