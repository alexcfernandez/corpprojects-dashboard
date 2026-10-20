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
