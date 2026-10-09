// test/recordatorios-cobro.test.js — Recordatorios de cobro con el sí de oficina y promesas de pago.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const HOY = new Date('2026-10-08T08:00:00Z');
const cols = { recordatoriosCobro: [], recordatoriosCobroPausa: [], bancoConexiones: [{ estado: 'activa', banco: 'Banco Santander', cuentas: [{ iban: 'ES1200490001510000000012' }, { iban: 'ES9900490001510000006452' }] }] };
const db = { collection: n => ({
  find: () => ({ toArray: async () => cols[n] || [], project: () => ({ toArray: async () => cols[n] || [] }) }),
  updateOne: async (q, u, o) => {
    let d = (cols[n] = cols[n] || []).find(x => x._id === q._id);
    if (!d && o && o.upsert) { d = { _id: q._id }; cols[n].push(d); }
    if (!d) return;
    Object.assign(d, u.$set || {});
    for (const [k, v] of Object.entries(u.$push || {})) (d[k] = d[k] || []).push(v);
    for (const k of Object.keys(u.$unset || {})) delete d[k];
  },
  deleteOne: async () => {},
}) };
const inv = (id, dias, pend, extra = {}) => ({ id, number: 'FAC' + id, client: 'Cliente ' + id, family: 'Particulares', accountId: 'a' + id, clientEmail: 'c' + id + '@mail.com',
  date: '2026-07-01', dueDate: new Date(HOY - dias * 86400000).toISOString().slice(0, 10), total: pend, paid: 0, pending: pend, ...extra });
let pendientes = [];
stub('src/db.js', { getDB: async () => db });
stub('src/stelorder.js', { getPendingInvoices: async () => pendientes, getClients: async () => ({ clientMap: { a1: { phone: '600 111 222' }, a2: { phone: '972 000 000' } } }) });
stub('src/avisos.js', { getFamilyConfig: async () => ({ paused: false, modo: 'familia', email: '', freq: 'manual' }), wasAlertSentToday: async () => false, markAlertSent: async () => {} });
const R = require(path.join(root, 'src/recordatoriosCobro.js'));

test('escalones y móviles', () => {
  assert.equal(R._pasoDe(5), null); assert.equal(R._pasoDe(7), 7); assert.equal(R._pasoDe(20), 15); assert.equal(R._pasoDe(200), 90);
  assert.equal(R._movil('600 111 222'), '+34600111222'); assert.equal(R._movil('+34 711 22 33 44'), '+34711223344'); assert.equal(R._movil('972 000 000'), null);
});

test('propone a los 7 días con el IBAN de la cuenta principal; una vez por escalón', async () => {
  pendientes = [inv('1', 8, 1250), inv('2', 3, 400)];
  const r = await R.propuestas({ hoy: HOY });
  assert.deepEqual(r.propuestas.map(p => p.id), ['1']);
  const p = r.propuestas[0];
  assert.equal(p.paso, 7); assert.equal(p.whatsapp, '+34600111222');
  assert.match(p.texto, /FAC1 del 01\/07\/2026, de 1\.250,00 €/);
  assert.match(p.texto, /ES12 0049 0001 5100 0000 0012/);   // la principal, no la de reserva
  await R.marcar('1', { paso: 7, canal: 'whatsapp', por: 'Álex' });
  assert.equal((await R.propuestas({ hoy: HOY })).propuestas.length, 0);
});

test('promesa de pago: no se recuerda antes; ese día sale en «hoy pagan»; si pasa, recordatorio con lo que dijo', async () => {
  pendientes = [inv('3', 20, 900)];
  await R.apuntar('3', { texto: 'paga cuando cobre la derrama', fechaPago: '2026-10-15', por: 'Álex', numero: 'FAC3', cliente: 'Cliente 3' });
  let r = await R.propuestas({ hoy: HOY });
  assert.equal(r.propuestas.length, 0); assert.equal(r.promesas.length, 1);
  r = await R.propuestas({ hoy: new Date('2026-10-15T08:00:00Z') });
  assert.equal(r.hoyPagan.length, 1); assert.equal(r.propuestas.length, 0);
  r = await R.propuestas({ hoy: new Date('2026-10-16T08:00:00Z') });
  assert.equal(r.incumplidas.length, 1);
  assert.equal(r.propuestas.length, 1);
  assert.match(r.propuestas[0].texto, /Nos indicó que la abonaría el 15\/10\/2026/);
  const env = []; const a = await R.avisoManana({ hoy: new Date('2026-10-16T08:00:00Z'), _enviar: async t => { env.push(t); return true; } });
  assert.equal(a.enviado, true); assert.match(env[0], /Dijeron que pagaban y no ha llegado/);
});

test('contacto apuntado en el dashboard manda sobre StelOrder; el texto lleva el enlace a la factura y el nombre', async () => {
  const CC = require(path.join(root, 'src/clientesContacto.js'));
  pendientes = [inv('5', 8, 300, { accountId: 'a5', clientEmail: '', pdfPath: 'https://stel/pdf/5' })];
  let r = await R.propuestas({ hoy: HOY });
  assert.equal(r.propuestas[0].whatsapp, null); assert.equal(r.propuestas[0].email, null);
  assert.equal((await CC.conPendientes()).clientes[0].falta, 'todo');
  await assert.rejects(CC.guardar({ accountId: 'a5', cliente: 'Cliente 5', email: 'no-es-email' }), /no parece válido/);
  await CC.guardar({ accountId: 'a5', cliente: 'Cliente 5', telefono: '611 22 33 44', email: 'Admin@Finques.cat', persona: 'Marta Puig' }, 'Oficina');
  r = await R.propuestas({ hoy: HOY });
  const p = r.propuestas[0];
  assert.equal(p.whatsapp, '+34611223344'); assert.equal(p.email, 'admin@finques.cat');
  assert.match(p.texto, /^Buenos días, Marta:/); assert.match(p.texto, /Puede ver la factura aquí: https:\/\/stel\/pdf\/5/);
  assert.equal((await CC.conPendientes()).clientes[0].falta, null);
});

test('WhatsApp desde Corpy y la respuesta del cliente se apunta y se reenvía', async () => {
  const env = [];
  const r = await R.enviarWhatsApp('5', { por: 'Álex', _enviar: async (a, t) => { env.push([a, t]); return true; } });
  assert.equal(r.a, '+34611223344'); assert.equal(env[0][0], '+34611223344');
  assert.equal((await R.propuestas({ hoy: HOY })).propuestas.length, 0);   // ya avisado en este escalón
  const aMi = [];
  const resp = await R.respuestaCliente('whatsapp:+34611223344', 'pago el viernes', { _enviar: async t => { aMi.push(t); return true; } });
  assert.match(resp, /Se lo pasamos a la oficina/);
  assert.match(aMi[0], /Cliente 5.*FAC5/s); assert.match(aMi[0], /pago el viernes/);
  const d = cols.recordatoriosCobro.find(x => x._id === '5');
  assert.match(d.notas.pop().texto, /Contestó por WhatsApp: «pago el viernes»/);
  assert.equal(await R.respuestaCliente('+34699999999', 'hola'), null);   // otro número: no es un cliente avisado
});
