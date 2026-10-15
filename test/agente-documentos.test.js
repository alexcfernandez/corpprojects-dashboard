// test/agente-documentos.test.js — Corpy pasa documentos de Personal solo al dueño, con enlace que caduca.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const creados = [];
stub('src/acceso.js', { esOwner: f => f === 'whatsapp:+34600000000' });
stub('src/enlaceDoc.js', { url: (id, o) => { creados.push({ id, ...o }); return `https://x/d/tok${creados.length}`; } });
stub('src/users.js', { getUsers: async () => [{ _id: 'u1', name: 'Javier Huaca' }, { _id: 'u2', name: 'Manolo Pérez' }] });
const EMP = [{ id: 'e1', tipo: 'escrituras', nombre: 'CIF CORP PROJECTS.pdf', fecha: '2025-03-01' }, { id: 'e2', tipo: 'cert_hacienda', nombre: 'hacienda.pdf', fecha: '2026-09-01', caduca: '2027-09-01' }];
const JAVI = [{ id: 'j1', tipo: 'dni', nombre: 'pasaporte.jpg', fecha: '2026-10-13' }, { id: 'j2', tipo: 'tarjeta_ss', nombre: 'nuss.jpg' }];
stub('src/personalDocs.js', { TIPOS: { dni: { nombre: 'DNI / NIE' }, tarjeta_ss: { nombre: 'Nº de la Seguridad Social' } }, TIPOS_EMPRESA: { escrituras: { nombre: 'Escrituras / CIF' }, cert_hacienda: { nombre: 'Certificado de estar al corriente con Hacienda' } },
  carpeta: async ({ userId, ambito }) => ambito === 'empresa' ? EMP : userId === 'u1' ? JAVI : [] });
const A = require(path.join(root, 'src/agente.js'));
const DUENO = 'whatsapp:+34600000000';

test('el CIF de la empresa: enlace al documento y el CIF en texto', async () => {
  const r = await A._pasarDocumento({ de: 'empresa', que: 'CIF' }, DUENO);
  assert.match(r.reply, /Escrituras \/ CIF/); assert.match(r.reply, /B09899253/); assert.match(r.reply, /https:\/\/x\/d\/tok/);
  assert.equal(creados.at(-1).id, 'e1');
});
test('el DNI de un trabajador', async () => {
  const r = await A._pasarDocumento({ de: 'Javi', que: 'DNI' }, DUENO);
  assert.match(r.reply, /DNI \/ NIE/); assert.equal(creados.at(-1).id, 'j1');
});
test('a alguien que no es el dueño no se le pasa nada', async () => {
  const n = creados.length;
  const r = await A._pasarDocumento({ de: 'empresa', que: 'CIF' }, 'whatsapp:+34611111111');
  assert.match(r.reply, /solo se los paso a Álex/); assert.equal(creados.length, n);
});
test('si no está, lo dice y da el CIF igualmente', async () => {
  const r = await A._pasarDocumento({ de: 'empresa', que: 'seguro de accidentes' }, DUENO);
  assert.match(r.reply, /No tengo/);
});

test('con «CIF» manda solo el del CIF, no todas las escrituras', async () => {
  EMP.push({ id: 'e3', tipo: 'escrituras', nombre: 'Tarjeta de identificación fiscal Corp Projects.pdf' }, { id: 'e4', tipo: 'escrituras', nombre: 'Escritura cese y nombramiento de cargos.pdf', fecha: '2025-12-23' });
  const n = creados.length;
  const r = await A._pasarDocumento({ de: 'empresa', que: 'el CIF' }, DUENO);
  assert.equal(creados.length - n, 1); assert.equal(creados.at(-1).id, 'e1');
  assert.equal((r.reply.match(/📎/g) || []).length, 1);
});
