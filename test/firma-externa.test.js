// test/firma-externa.test.js — Firma por enlace (administrador): un enlace, una firma, se estampa en todos.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ObjectId } = require('mongodb');
process.env.JWT_SECRET = 'secreto-de-prueba';
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const OB = String(new ObjectId()), D1 = new ObjectId(), D2 = new ObjectId();
const cols = { firmasLotes: [], docsPersonal: [{ _id: D1, ambito: 'obra', obraId: OB, tipo: 'otro_obra', nombre: 'Contrato Seranco INSS (SIN FIRMAR).pdf', mime: 'application/pdf' }, { _id: D2, ambito: 'obra', obraId: OB, tipo: 'otro_obra', nombre: 'F - Adhesión (SIN FIRMAR).pdf', mime: 'application/pdf' }] };
const val = (d, k) => k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), d);
const cumple = (d, q) => Object.entries(q).every(([k, c]) => c && typeof c === 'object' && !(c instanceof ObjectId) && '$in' in c ? c.$in.some(x => String(x) === String(val(d, k))) : String(val(d, k)) === String(c));
stub('src/db.js', { getDB: async () => ({ collection: n => ({
  find: (q) => ({ toArray: async () => (cols[n] || []).filter(d => cumple(d, q)) }),
  findOne: async q => (cols[n] || []).find(d => cumple(d, q)) || null,
  insertOne: async d => { const _id = new ObjectId(); cols[n].push({ _id, ...d }); return { insertedId: _id }; },
  updateMany: async (q, u) => { for (const d of (cols[n] || []).filter(x => Object.entries(q).every(([k, c]) => c && typeof c === 'object' && '$ne' in c ? String(x[k]) !== String(c.$ne) : String(x[k]) === String(c)))) Object.assign(d, u.$set); },
  updateOne: async (q, u) => { const d = cols[n].find(x => cumple(x, q)); if (!d) return; for (const [k, v] of Object.entries(u.$set || {})) { const ps = k.split('.'); let o = d; ps.slice(0, -1).forEach(p => { o = o[p]; }); o[ps[ps.length - 1]] = v; } },
}) }) });
let pdf;
const guardados = [];
const realP = require(path.join(root, 'src/personalDocs.js'));
stub('src/personalDocs.js', { TIPOS_OBRA: realP.TIPOS_OBRA, TIPOS_EMPRESA: realP.TIPOS_EMPRESA, archivo: async id => { const d = cols.docsPersonal.find(x => String(x._id) === String(id)); return d ? { ...d, data: d.data || pdf } : null; },
  subir: async o => { guardados.push(o); const _id = new ObjectId(); cols.docsPersonal.push({ _id, ambito: o.ambito, obraId: o.obraId, tipo: o.tipo, nombre: o.archivo.originalname, mime: 'application/pdf', data: { buffer: Buffer.from(o.archivo.buffer) } }); return { id: String(_id) }; } });
const enviadosWA = [];
stub('src/notifications.js', { sendWhatsApp: async () => true, sendWhatsAppTo: async (a, t) => { enviadosWA.push([a, t]); return true; } });
const F = require(path.join(root, 'src/firmaExterna.js'));

test('Alfonso: un enlace, firma una vez y quedan los dos firmados con su tipo', async () => {
  const { PDFDocument } = require('pdf-lib'); const p = await PDFDocument.create(); p.addPage(); pdf = Buffer.from(await p.save());
  const env = [];
  const r = await F.crear({ nombre: 'Alfonso Gálvez', telefono: '+34692270438', dni: '40347979E', obraId: OB, docs: [{ docId: String(D1), tipoDestino: 'contrato_obra' }, { docId: String(D2), tipoDestino: 'adhesion_pss' }] }, 'Álex', { _enviar: async (a, t) => { env.push(t); return true; } });
  const token = r.url.split('/firmar/')[1];
  assert.match(env[0], /2 documentos/); assert.match(env[0], /\/firmar\//);
  const v = await F.ver(token); assert.equal(v.items.length, 2);
  await assert.rejects(F.ver(token.slice(0, -2) + 'xx'), /caducado o no válido/);
  await assert.rejects(F.firmar(token, { firmaDataUrl: 'data:image/png;base64,AAAA' }), /vacía/);
  const sig = require('fs').readFileSync(path.join(root, 'public/icons/icon-192.png')).toString('base64');
  const f = await F.firmar(token, { firmaDataUrl: 'data:image/png;base64,' + sig, notas: { 1: 'Trabajador designado: Jose Beliard' } });
  assert.equal(f.firmados, 2);
  assert.deepEqual(guardados.map(g => g.tipo), ['contrato_obra', 'adhesion_pss']);
  assert.equal(guardados[0].ambito, 'obra'); assert.match(guardados[0].archivo.originalname, /Contrato Seranco INSS \(firmado por Alfonso\)\.pdf/);
  assert.equal((await PDFDocument.load(guardados[1].archivo.buffer)).getPageCount(), 2);
  assert.ok((await F.ver(token)).items.every(i => i.estado === 'firmado'));
  await assert.rejects(F.firmar(token, { firmaDataUrl: 'data:image/png;base64,' + sig }), /No queda nada/);
});

test('firma en su sitio (todas las hojas y una concreta), enlace nuevo sustituye al viejo y luego firma el trabajador', async () => {
  const { PDFDocument } = require('pdf-lib'); const p = await PDFDocument.create(); p.addPage([595, 842]); p.addPage([595, 842]); pdf = Buffer.from(await p.save());
  guardados.length = 0; const env = [];
  const _enviar = async (a, t) => { env.push([a, t]); return true; };
  const viejo = await F.crear({ nombre: 'Alfonso Gálvez', telefono: '+34692270438', obraId: OB, docs: [{ docId: String(D1) }] }, 'Álex', { _enviar });
  const r = await F.crear({ nombre: 'Alfonso Gálvez', telefono: '+34692270438', dni: '40347979E', obraId: OB,
    docs: [{ docId: String(D1), tipoDestino: 'contrato_obra', firmaEn: [{ pag: 'todas', x: 415, y: 760, w: 100, h: 24, sello: 'mini' }, { pag: 2, x: 138, y: 118, w: 170, h: 48, sello: 'abajo' }] }, { docId: String(D2), tipoDestino: 'trab_designado', firmaEn: [{ pag: 1, x: 60, y: 248, w: 150, h: 44, sello: 'derecha' }] }],
    luego: { nombre: 'José Antonio Beliard', telefono: '+34600000001', dni: 'X4871583E', cargo: 'Trabajador designado', docs: [{ n: 1, firmaEn: [{ pag: 1, x: 345, y: 244, w: 170, h: 52 }] }] } }, 'Álex', { _enviar });
  assert.equal((await F.ver(viejo.url.split('/firmar/')[1])).items.length, 2); // el enlace viejo lleva al lote nuevo
  const sig = require('fs').readFileSync(path.join(root, 'public/icons/icon-192.png')).toString('base64');
  const f = await F.firmar(r.url.split('/firmar/')[1], { firmaDataUrl: 'data:image/png;base64,' + sig });
  assert.equal(f.firmados, 2); assert.equal(f.siguiente, '+34600000001');
  assert.equal((await PDFDocument.load(guardados[0].archivo.buffer)).getPageCount(), 3);
  const aBeliard = enviadosWA[enviadosWA.length - 1]; assert.equal(aBeliard[0], '+34600000001'); assert.match(aBeliard[1], /1 documento de Corp Projects/);
  const lB = cols.firmasLotes[cols.firmasLotes.length - 1];
  assert.equal(lB.sello, false); assert.equal(lB.items[0].tipoDestino, 'trab_designado'); assert.match(lB.items[0].nombre, /firmado por Alfonso/); assert.equal(lB.items[0].firmaEn[0].x, 345);
  const tokB = aBeliard[1].match(/\/firmar\/(\S+)/)[1];
  const fb = await F.firmar(tokB, { firmaDataUrl: 'data:image/png;base64,' + sig });
  assert.equal(fb.firmados, 1); assert.equal(fb.siguiente, null);
  assert.match(guardados[guardados.length - 1].archivo.originalname, /firmado por Alfonso\) \(firmado por José\)\.pdf$/);
});
