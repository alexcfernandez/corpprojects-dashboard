// test/agente-documentos-puente.test.js — Por el puente, Corpy manda el documento dentro del chat.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const enviados = [];
stub('src/acceso.js', { esOwner: f => f === 'whatsapp:+34600000000' });
stub('src/enlaceDoc.js', { url: () => 'https://x/d/tok' });
stub('src/users.js', { getUsers: async () => [] });
stub('src/canalWhatsapp.js', { canalActivo: () => 'bridge', enviarArchivo: async (to, pie, a) => { enviados.push({ to, pie, a }); return true; } });
stub('src/personalDocs.js', { TIPOS: {}, TIPOS_EMPRESA: { escrituras: { nombre: 'Escrituras / CIF' } },
  carpeta: async () => [{ id: 'e1', tipo: 'escrituras', nombre: 'CIF Corp Projects.pdf' }],
  archivo: async () => ({ data: Buffer.from('%PDF-1.4'), mime: 'application/pdf' }) });
const A = require(path.join(root, 'src/agente.js'));

test('el CIF va como documento por el puente, con el enlace de pie', async () => {
  const r = await A._pasarDocumento({ de: 'empresa', que: 'CIF' }, 'whatsapp:+34600000000');
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].a.mime, 'application/pdf'); assert.equal(enviados[0].a.nombre, 'CIF Corp Projects.pdf');
  assert.match(enviados[0].pie, /Si no se abre: https:\/\/x\/d\/tok/);
  assert.match(r.reply, /Te lo mando aquí mismo/); assert.match(r.reply, /B09899253/);
});
