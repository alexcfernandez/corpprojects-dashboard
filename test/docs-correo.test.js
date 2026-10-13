// test/docs-correo.test.js — papeles por correo: por contenido, a empresa/trabajador/obra; lo dudoso como propuesta.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ObjectId } = require('mongodb');
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const OB = new ObjectId();
const cols = { docsPersonal: [], obras: [{ _id: OB, clientName: 'SERANCO, S.A.U.', reference: 'INSS Girona (Seranco)', docsEntrada: { plantilla: 'seranco' }, status: 'activa' }] };
const cumple = (d, q) => Object.entries(q).every(([k, v]) => k === 'status' || (k === 'docsEntrada.plantilla' ? !!(d.docsEntrada && d.docsEntrada.plantilla) : k === 'origen.gmailId' ? d.origen && d.origen.gmailId === v : String(d[k]) === String(v)));
stub('src/db.js', { getDB: async () => ({ collection: n => ({
  findOne: async q => cols[n].find(d => cumple(d, q)) || null,
  find: q => ({ toArray: async () => cols[n].filter(d => cumple(d, q)) }),
  updateOne: async (q, u) => { const d = cols[n].find(x => String(x._id) === String(q._id)); if (d) Object.assign(d, u.$set); },
}) }) });
const subidos = [];
stub('src/personalDocs.js', {
  TIPOS: { contrato: { nombre: 'Contrato de trabajo' }, reconocimiento: { nombre: 'Reconocimiento médico' }, otro: { nombre: 'Otro' } },
  TIPOS_EMPRESA: { cert_hacienda: { nombre: 'Hacienda' }, ta7: { nombre: 'TA.7' }, cert_ss: { nombre: 'SS' }, otro_empresa: { nombre: 'Otro' } },
  TIPOS_OBRA: { cert_hacienda_contratista: { nombre: 'Hacienda específico contratista' } },
  _plantilla: async () => [{ id: 'u1', name: 'Jose Beliard', dni: 'X4871583E', alias: [] }],
  _matchTrabajador: (pl, nombre) => /beliard/i.test(nombre || '') ? pl[0] : null,
  _extraerPaginas: async b => b,
  subir: async o => { const _id = new ObjectId(); cols.docsPersonal.push({ _id, ...o }); subidos.push(o); return { id: String(_id) }; },
});
const DC = require(path.join(root, 'src/docsCorreo.js'));

test('qué correos traen papeles', () => {
  const pdf = [{ filename: 'CERTIFICADO I.A.E.pdf', mimeType: 'application/pdf' }];
  assert.equal(DC.esCorreoDocs({ de: 'eduard@somassessors.com', asunto: 'RE: urgent', adjuntos: pdf }), true);
  assert.equal(DC.esCorreoDocs({ de: 'x@weber.es', asunto: 'Factura 123', adjuntos: pdf, clasificacion: { categoria: 'FACTURA_PROVEEDOR' } }), false);
  assert.equal(DC.esCorreoDocs({ de: 'anna@spass.es', asunto: 'cita', adjuntos: [] }), false);
  assert.equal(DC.esCorreoDocs({ de: 'x@aseguradora.es', asunto: 'Su póliza', adjuntos: [{ filename: 'a.pdf', mimeType: 'application/pdf' }] }), true);
});

test('correo de Eduard: Hacienda de contratista → obra Seranco, TA.7 → empresa, contrato → trabajador; desconocido → propuesta', async () => {
  const avisos = [];
  const lee = { 'CERT.pdf': [{ ambito: 'empresa', tipo: 'cert_hacienda', contratista: 'SERANCO SA' }], 'InSeNaCoder.pdf': [{ ambito: 'empresa', tipo: 'ta7' }],
    'CONTRATO.pdf': [{ ambito: 'trabajador', tipo: 'contrato', trabajador: 'José Antonio Beliard' }], 'RECO.pdf': [{ ambito: 'trabajador', tipo: 'reconocimiento', trabajador: 'Pepito Pérez' }] };
  const adj = Object.keys(lee).map((f, i) => ({ filename: f, mimeType: 'application/pdf', attachmentId: 'a' + i }));
  const r = await DC.desdeCorreo('m1', adj, { de: '<eduard@somassessors.com>', asunto: 'RE: documentació', fecha: new Date('2026-10-13') },
    { _bajar: async () => Buffer.from('pdf'), _clasificar: async a => ({ ok: true, documentos: lee[a.originalname] }), _avisar: async t => avisos.push(t) });
  assert.deepEqual(r, { guardados: 3, propuestas: 1, sinLeer: 0 });
  assert.equal(subidos[0].ambito, 'obra'); assert.equal(subidos[0].tipo, 'cert_hacienda_contratista'); assert.equal(subidos[0].obraId, String(OB));
  assert.equal(subidos[1].tipo, 'ta7'); assert.equal(subidos[1].estado, 'ok');
  assert.equal(subidos[2].userId, 'u1');
  assert.equal(subidos[3].estado, 'propuesta'); assert.equal(subidos[3].userId, null);
  assert.match(avisos[0], /para INSS Girona \(Seranco\)/); assert.match(avisos[0], /Para confirmar en Personal/);
  assert.deepEqual(await DC.desdeCorreo('m1', adj, {}, { _avisar: async () => {} }), { yaEstaba: true });
});

test('de un remitente cualquiera todo entra como propuesta', async () => {
  subidos.length = 0;
  await DC.desdeCorreo('m2', [{ filename: 'poliza.pdf', mimeType: 'application/pdf', attachmentId: 'z' }], { de: 'x@occident.es', asunto: 'Su póliza' },
    { _bajar: async () => Buffer.from('pdf'), _clasificar: async () => ({ ok: true, documentos: [{ ambito: 'empresa', tipo: 'cert_ss' }] }), _avisar: async () => {} });
  assert.equal(subidos[0].estado, 'propuesta');
});

test('los avisos del banco o las citas no son publicidad aunque vengan de no-reply', () => {
  const EI = require(path.join(root, 'src/email-intelligence.js'));
  assert.equal(EI._esPublicidadObvia('Revolut Business <no-reply@revolut.com>', 'Card payment declined – Insufficient balance ⚠️', ''), false);
  assert.equal(EI._esPublicidadObvia('OBRAMAT <no-reply@mailing.obramat.es>', '¡UNIDADES LIMITADAS! al mejor precio', ''), true);
});
