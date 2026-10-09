// test/docs-obra.test.js — Documentación para entrar en obra: lo que pide Seranco contra lo que hay en Personal.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ObjectId } = require('mongodb');
const root = path.join(__dirname, '..');
const OB = new ObjectId(), MAN = new ObjectId();
const cols = { obras: [{ _id: OB, reference: 'INSS Girona', clientName: 'Seranco', status: 'activa' }], users: [{ _id: MAN, name: 'Manolo' }], docsPersonal: [] };
const val = (d, k) => k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), d);
const cumple = (d, q) => Object.entries(q).every(([k, c]) => {
  if (k === '$or') return c.some(x => cumple(d, x));
  const v = val(d, k);
  if (c && typeof c === 'object' && !(c instanceof ObjectId)) {
    if ('$in' in c) return c.$in.some(x => String(x) === String(v));
    if ('$nin' in c) return !c.$nin.includes(v);
    if ('$exists' in c) return (v !== undefined) === c.$exists;
  }
  return String(v) === String(c);
});
const p = require.resolve(path.join(root, 'src/db.js'));
require.cache[p] = { id: p, filename: p, loaded: true, exports: { getDB: async () => ({ collection: n => ({
  findOne: async q => (cols[n] || []).find(d => cumple(d, q)) || null,
  find: q => ({ toArray: async () => (cols[n] || []).filter(d => cumple(d, q || {})) }),
  updateOne: async (q, u) => { const d = (cols[n] || []).find(x => cumple(x, q)); if (!d) return; for (const [k, v] of Object.entries(u.$set || {})) { const ps = k.split('.'); let o = d; ps.slice(0, -1).forEach(x => { o = o[x] = o[x] || {}; }); o[ps[ps.length - 1]] = v; } },
}) }) } };
const D = require(path.join(root, 'src/docsObra.js'));
const doc = (o) => cols.docsPersonal.push({ _id: new ObjectId(), estado: 'ok', subido: new Date(), ...o });

test('Seranco con Manolo: cuenta lo que falta, por quién, y avisa en Inicio', async () => {
  await D.configurar(String(OB), { plantilla: 'seranco', userIds: [String(MAN)], fechaEntrada: '2026-10-13' }, 'Álex');
  let e = await D.estado(String(OB));
  const total = e.total;
  assert.ok(total > 20); assert.equal(e.faltan, total);
  assert.ok(!e.trabajadores[0].filas.some(f => f.tipo === 'carnet'));        // sin maquinaria no se pide carnet
  doc({ ambito: 'trabajador', userId: String(MAN), tipo: 'dni', nombre: 'DNI Manolo' });
  doc({ ambito: 'empresa', tipo: 'rea', nombre: 'REA', caduca: '2028-01-01' });
  doc({ ambito: 'empresa', tipo: 'cert_ss', nombre: 'Cert SS', caduca: '2026-09-30' });                 // caducado
  doc({ ambito: 'obra', obraId: String(new ObjectId()), tipo: 'adhesion_pss', nombre: 'de otra obra' });  // no cuenta
  e = await D.estado(String(OB));
  assert.equal(e.faltan, total - 2);
  assert.equal(e.general.find(f => f.tipo === 'cert_ss').estado, 'caducado');
  assert.equal(e.general.find(f => f.tipo === 'adhesion_pss').estado, 'falta');
  const g = D.textoPeticion(e, 'gestoria');
  assert.match(g.texto, /Manolo: Alta en la Seguridad Social/); assert.match(g.texto, /Empresa \/ obra: Certificado de estar al corriente con la Seguridad Social \(caducado\)/);
  assert.deepEqual(g.para, ['eduard@somassessors.com']);
  const p = await D.pendientes();
  assert.equal(p[0].ref, 'INSS Girona'); assert.equal(p[0].faltan, total - 2);
  await D.marcarEnviado(String(OB), 'Álex');
  assert.equal((await D.pendientes()).length, 0);
});
