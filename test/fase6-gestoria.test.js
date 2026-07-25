// test/fase6-gestoria.test.js — Fase 6: gestoría por remitente (autoritativo),
// detección de la consulta a demanda, y resumen/colector de correo importante.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');

// ── Mock de ./db (getDBLegacy) ANTES de requerir email-intelligence ──
let rows = [];
function mkCol() {
  return {
    find(q) {
      const f = rows.filter(r => {
        if (q.procesadoEn && q.procesadoEn.$gte && !(r.procesadoEn >= q.procesadoEn.$gte)) return false;
        if (q.categoria && q.categoria.$in && !q.categoria.$in.includes(r.categoria)) return false;
        return true;
      });
      return { sort() { return { limit() { return { async toArray() { return f.slice(); } }; } }; } };
    },
  };
}
const dbPath = require.resolve(path.join(root, 'src/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  getDB: async () => ({ collection: () => mkCol() }),
  getDBLegacy: async () => ({ db: { collection: () => mkCol() }, client: { async close() {} } }),
} };

const em = require(path.join(root, 'src/email-intelligence.js'));

// ── esGestoria: AUTORITATIVO por remitente ──
test('esGestoria por DOMINIO (@somassessors.com)', () => {
  process.env.GESTORIA_EMAILS = '@somassessors.com';
  assert.equal(em.esGestoria('Joan <joan@somassessors.com>'), true);
  assert.equal(em.esGestoria('info@somassessors.com'), true);
  assert.equal(em.esGestoria('Otro <x@gmail.com>'), false);
});
test('esGestoria por EMAIL exacto', () => {
  process.env.GESTORIA_EMAILS = 'conta@gestoria.com';
  assert.equal(em.esGestoria('conta@gestoria.com'), true);
  assert.equal(em.esGestoria('otra@gestoria.com'), false);   // exacto, no dominio
});
test('esGestoria sin env configurado → false', () => {
  delete process.env.GESTORIA_EMAILS;
  assert.equal(em.esGestoria('joan@somassessors.com'), false);
});

// ── intentCorreo (a demanda) ──
test('intentCorreo: "¿algo de la gestoría?" → soloGestoria', () => {
  assert.deepEqual(em.intentCorreo('¿algo de la gestoría?'), { soloGestoria: true });
  assert.deepEqual(em.intentCorreo('novedades de la gestoria'), { soloGestoria: true });
});
test('intentCorreo: "resumen del correo" → soloGestoria false', () => {
  assert.deepEqual(em.intentCorreo('resumen del correo'), { soloGestoria: false });
  assert.deepEqual(em.intentCorreo('¿qué hay en el correo?'), { soloGestoria: false });
});
test('intentCorreo: consulta ajena → null', () => {
  assert.equal(em.intentCorreo('¿qué debe Illa Verda?'), null);
});

// ── seccionCorreo / resumenCorreo ──
const ahora = Date.now();
const hace = (h) => new Date(ahora - h * 3600 * 1000);

test('seccionCorreo: incluye gestoría/incidencia/factura recientes; excluye publicidad y lo viejo', async () => {
  rows = [
    { categoria: 'GESTORIA', resumen: 'Nóminas de julio', asunto: 'Nóminas', procesadoEn: hace(2) },
    { categoria: 'INCIDENCIA', resumen: 'Fuga en Illa Verda', asunto: 'Fuga', procesadoEn: hace(5) },
    { categoria: 'FACTURA_PROVEEDOR', resumen: 'Factura Saltoki', asunto: 'FRA', procesadoEn: hace(10) },
    { categoria: 'PUBLICIDAD', resumen: 'Oferta', asunto: 'Promo', procesadoEn: hace(1) },   // excluida por categoría
    { categoria: 'GESTORIA', resumen: 'Cosa vieja', asunto: 'X', procesadoEn: hace(40) },     // excluida por ventana 24h
  ];
  const sec = await em.seccionCorreo(24);
  assert.match(sec, /Correo/);
  assert.match(sec, /Gestoría: Nóminas de julio/);
  assert.match(sec, /Incidencia: Fuga en Illa Verda/);
  assert.match(sec, /Factura: Factura Saltoki/);
  assert.doesNotMatch(sec, /Oferta/);
  assert.doesNotMatch(sec, /Cosa vieja/);
});

test('resumenCorreo soloGestoria filtra a GESTORIA (ventana 48h)', async () => {
  rows = [
    { categoria: 'GESTORIA', resumen: 'Nóminas de julio', asunto: 'Nóminas', procesadoEn: hace(2) },
    { categoria: 'INCIDENCIA', resumen: 'Fuga', asunto: 'Fuga', procesadoEn: hace(2) },
  ];
  const txt = await em.resumenCorreo({ soloGestoria: true });
  assert.match(txt, /Gestoría/);
  assert.match(txt, /Nóminas de julio/);
  assert.doesNotMatch(txt, /Fuga/);
});

test('resumenCorreo vacío → mensaje amable', async () => {
  rows = [];
  assert.match(await em.resumenCorreo({ soloGestoria: true }), /No hay nada nuevo de la gestoría/);
  assert.match(await em.resumenCorreo({}), /No hay correo importante/);
});
