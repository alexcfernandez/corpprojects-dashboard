// Visitas contadas a Corpy (audio, texto o notas) con sus fotos → la ficha que toca (3/11/2026).
const test = require('node:test');
const assert = require('node:assert');
const { ObjectId } = require('mongodb');
const V = require('../src/visitas');

const id = () => new ObjectId();
function fakeDb({ obras = [], peticiones = [] } = {}) {
  const cols = { obras, peticionesGrupo: peticiones, visitas: [], visitaFotos: [] };
  const lista = n => (cols[n] = cols[n] || []);
  const casa = (d, q = {}) => Object.entries(q).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof ObjectId) && !(v instanceof Date)) {
      if (v.$nin) return !v.$nin.includes(d[k]);
      if (v.$gte) return d[k] >= v.$gte;
      return true;
    }
    return String(d[k]) === String(v);
  });
  return { cols, collection: n => ({
    find: q => { const r = () => lista(n).filter(d => casa(d, q)); const c = { project: () => c, sort: () => c, limit: () => c, toArray: async () => r() }; return c; },
    findOne: async q => lista(n).find(d => casa(d, q)) || null,
    insertOne: async d => { d._id = d._id || id(); lista(n).push(d); return { insertedId: d._id }; },
    updateOne: async (q, u) => { const d = lista(n).find(x => casa(x, q)); if (!d) return; Object.assign(d, u.$set || {}); for (const [k, v] of Object.entries(u.$push || {})) (d[k] = d[k] || []).push(v); },
  }) };
}
const deps = (extra = {}) => {
  const llamadas = { tiempo: [], fotos: [], eventos: [], contactos: [], notas: [] };
  return { llamadas, opts: {
    _apuntarTiempo: async d => { llamadas.tiempo.push(d); return { _id: id(), minutos: d.minutos || 30, km: 32 }; },
    _subirFoto: async d => { llamadas.fotos.push(d); return { id: String(id()) }; },
    _evento: async e => { llamadas.eventos.push(e); return 'ev'; },
    _contacto: async c => { llamadas.contactos.push(c); return { id: 'c1' }; },
    _notaComunidad: async (c, n) => { llamadas.notas.push([c, n]); return { ok: true, target: c }; },
    ...extra } };
};

test('reconoce un relato de visita y no una orden ni una pregunta', () => {
  assert.ok(V.esRelato('He ido a Bellpuig 41 a ver a Marta, hay goteras en el 3r 1a'));
  assert.ok(V.esRelato('Estoy en Can Bells 30 con Alfonso haciendo presupuesto de la fuga'));
  assert.ok(V.esRelato('Visita hecha a Remences 9'));
  assert.ok(V.esRelato('Notas Bellpuig\nGoteras en el baño del 3r 1a\nFiltración en la escalera arriba\nCapuchas de chimenea no lo han resuelto del todo, habrá que abrir el cel ras y probar cuando llueva para ver por dónde entra el agua exactamente'));
  assert.ok(!V.esRelato('Hazme un presupuesto para Illa Verda'));
  assert.ok(!V.esRelato('¿Qué debe Illa Verda?'));
});

test('«Can Bells 30» no se mete en la obra «can bells 20»: pregunta, y sin obra se apunta en el cliente', async () => {
  const db = fakeDb({ obras: [{ _id: id(), reference: "can bells 20 vilobi d'onyar", status: 'activa' }] });
  const { llamadas, opts } = deps();
  const r = await V.registrar({ sitio: 'Can Bells 30', quienes: ['yo', 'Alfonso'], minutos: 60, que_se_vio: 'Fuga entre contador y llave general' }, 'Álex', { _db: db, ...opts });
  assert.ok(r.aclara);
  assert.match(r.reply, /No tengo una obra que sea exactamente «Can Bells 30»[\s\S]*can bells 20/);
  assert.strictEqual(llamadas.tiempo.length, 0);
  const r2 = await V.registrar({ sitio: 'Can Bells 30', cliente: 'Madrenas', sin_obra: true, quienes: ['yo', 'Alfonso'], minutos: 60, que_se_vio: 'Fuga entre contador y llave general' }, 'Álex', { _db: db, ...opts });
  assert.ok(r2.ok);
  assert.deepStrictEqual([llamadas.tiempo[0].quienes, llamadas.tiempo[0].sinObra, llamadas.tiempo[0].obraId], [['Álex', 'Alfonso'], true, null]);
  assert.deepStrictEqual(llamadas.notas[0][0], 'Madrenas');
});

test('visita con obra: rato, fotos en la obra, incidencia abierta, contacto y recordatorio', async () => {
  const obraId = id();
  const pet = { _id: id(), estado: 'pendiente', direccion: '3r 1a, Bellpuig 41', cliente: 'Illa Verda', clienteId: '123', incidencia: 'INC00644', creado: new Date() };
  const db = fakeDb({ obras: [{ _id: obraId, reference: 'Bellpuig 41 goteras', status: 'activa' }, { _id: id(), reference: 'Claudia', status: 'activa' }], peticiones: [pet] });
  const { llamadas, opts } = deps();
  V.guardarFotosPendientes('+34600', [{ data: Buffer.from('a').toString('base64'), media_type: 'image/jpeg' }, { data: Buffer.from('b').toString('base64'), media_type: 'image/jpeg' }]);
  const r = await V.registrar({ sitio: 'Bellpuig 41', quienes: ['yo'], minutos: 30, que_se_vio: 'Goteras en el 3r 1a y filtración en la escalera', siguientes_pasos: [{ que: 'Abrir el cel ras', fecha: '2026-11-05', hora: '9:00' }, 'Probar con lluvia'],
    contacto: { nombre: 'Marta', telefono: '653 56 85 39', piso: '3r 1a' } }, 'Álex', { from: '+34600', _db: db, ...opts });
  assert.ok(r.ok, r.reply);
  assert.strictEqual(String(llamadas.tiempo[0].obraId), String(obraId));
  assert.strictEqual(llamadas.fotos.length, 2);
  assert.deepStrictEqual([llamadas.fotos[0].ambito, llamadas.fotos[0].tipo, String(llamadas.fotos[0].obraId)], ['obra', 'fotos_obra', String(obraId)]);
  assert.strictEqual(pet.visitaHecha.por, 'Álex'); assert.strictEqual(pet.visitas.length, 1);
  assert.deepStrictEqual([llamadas.eventos.length, llamadas.eventos[0].date, llamadas.eventos[0].hora], [1, '2026-11-05', '09:00']);
  assert.deepStrictEqual([llamadas.contactos[0].nombre, llamadas.contactos[0].clienteId], ['Marta', '123']);
  assert.match(r.reply, /Visita apuntada[\s\S]*INC00644[\s\S]*Contacto guardado: Marta[\s\S]*2 fotos guardadas en la obra/);
  // Fotos sueltas justo después: van a la misma visita; a la 2ª tanda (en 1 min) no se contesta.
  const m1 = await V.anadirFotos('+34600', [{ data: 'Yw==', media_type: 'image/jpeg' }], { _db: db, _subirFoto: opts._subirFoto });
  const m2 = await V.anadirFotos('+34600', [{ data: 'ZA==', media_type: 'image/jpeg' }], { _db: db, _subirFoto: opts._subirFoto });
  assert.match(m1, /Guardada en la visita de \*Bellpuig 41 goteras\*/); assert.strictEqual(m2, '');
  assert.strictEqual(db.cols.visitas[0].fotos.length, 4);
});

test('sin rato pregunta cuánto fue; «Claudia» con dos obras pregunta cuál', async () => {
  const db = fakeDb({ obras: [{ _id: id(), reference: 'Claudia', status: 'activa' }, { _id: id(), reference: 'Bar Claudia · Sant Pere Pescador', status: 'activa' }] });
  const { opts } = deps();
  const r1 = await V.registrar({ sitio: 'bar de Claudia', que_se_vio: 'Revisión' }, 'Álex', { _db: db, ...opts });
  assert.match(r1.reply, /Cuánto rato fue la visita a Bar Claudia/);
  const r2 = await V.registrar({ sitio: 'Claudia', minutos: 20, que_se_vio: 'Revisión' }, 'Álex', { _db: db, ...opts });
  assert.ok(r2.aclara); assert.match(r2.reply, /puede ser varias obras/);
});
