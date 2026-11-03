// Correos sin contestar (3/11/2026: Jordi Garrido escribió el 19/10 por Bellpuig 41 y nadie le contestó).
const test = require('node:test');
const assert = require('node:assert');
const SC = require('../src/sinContestar');

const AHORA = new Date('2026-11-03T10:00:00Z');   // martes
const hace = h => new Date(AHORA.getTime() - h * 3600000);

function fakeDb(emails, peticiones = []) {
  const coincide = (d, q) => Object.entries(q).every(([k, v]) => {
    if (v === null) return d[k] == null;
    if (v && v.$gte) return d[k] >= v.$gte;
    if (v && v.$ne !== undefined) return d[k] !== v.$ne;
    if (k === 'gmailIds') return (d.gmailIds || []).includes(v);
    return d[k] === v;
  });
  return { emails, collection: n => ({
    find: q => ({ project: () => ({ sort: () => ({ toArray: async () => emails.filter(e => coincide(e, q)).sort((a, b) => a.fecha - b.fecha) }) }) }),
    findOne: async q => (n === 'peticionesGrupo' ? peticiones : emails).find(d => coincide(d, q)) || null,
    updateOne: async (q, u) => {
      const e = emails.find(x => String(x._id) === String(q._id)); if (!e) return { matchedCount: 0 };
      Object.assign(e, u.$set || {}); for (const [k, v] of Object.entries(u.$inc || {})) e[k] = (e[k] || 0) + v;
      return { matchedCount: 1 };
    },
  }) };
}
// Gmail falso: hilos por id de correo; `enviados` = direcciones a las que mandamos algo después.
function fakeGmail(hilos, enviados = []) {
  let llamadas = 0;
  return { get llamadas() { return llamadas; }, users: {
    messages: {
      get: async ({ id }) => { llamadas++; return { data: { threadId: 't-' + id } }; },
      list: async ({ q }) => { llamadas++; return { data: { messages: enviados.some(a => q.includes(a)) ? [{ id: 'x' }] : [] } }; },
    },
    threads: { get: async ({ id }) => { llamadas++; return { data: { messages: hilos[id.slice(2)] || [] } }; } },
  } };
}
const correo = (id, extra) => ({ _id: id, gmailId: 'g' + id, estado: 'PENDIENTE', categoria: 'INCIDENCIA', fecha: hace(72), de: 'Jordi Garrido <jordi-garrido@finquescompany.com>', asunto: 'Goteres Bellpuig 41 3-1', resumen: 'Pide que vayamos a ver la gotera', urgencia: 'ALTA', accionSugerida: 'Contactar urgente y coordinar visita', ...extra });

test('avisa de lo que nadie ha contestado y no de lo contestado, automático, publicidad o reciente', async () => {
  const emails = [
    correo('1'),
    correo('2', { de: 'Eduard <eduard@somassessors.com>', categoria: 'GESTORIA', asunto: 'Liquidació Judit' }),        // contestado en el hilo
    correo('3', { de: 'Revolut Business <no-reply@revolut.com>', categoria: 'COMUNICACION' }),                        // automático
    correo('4', { categoria: 'PUBLICIDAD' }),
    correo('5', { fecha: hace(3), asunto: 'Nueva gotera' }),                                                                                   // reciente
    correo('6', { de: 'Pablo <pmadera@seranco.es>', categoria: 'COMUNICACION' }),                                      // le escribimos después
    correo('7', { sinRespuesta: { at: AHORA, por: 'Álex' } }),
    correo('8', { de: 'Som Assessors <info@somassessors.com>', categoria: 'GESTORIA', asunto: 'Festivitat', urgencia: 'BAJA', accionSugerida: 'Tener en cuenta que cierran el 29' }),
    correo('9', { asunto: 'RE: Goteres Bellpuig 41 3-1', fecha: hace(150) }),                                         // mismo hilo, más antiguo: cuenta desde aquí
  ];
  const db = fakeDb(emails);
  const gmail = fakeGmail({ g2: [{ labelIds: ['INBOX'], internalDate: String(hace(72).getTime()) }, { labelIds: ['SENT'], internalDate: String(hace(50).getTime()) }] }, ['pmadera@seranco.es']);
  const avisos = [], pushes = [];
  const r = await SC.aviso({ _db: db, _gmail: gmail, _enviar: async t => avisos.push(t), _push: async p => pushes.push(p), ahora: AHORA });
  assert.strictEqual(r.n, 1);
  assert.match(avisos[0], /Correos sin contestar\* \(1\)[\s\S]*\*Jordi Garrido\* — «Goteres Bellpuig 41 3-1» · hace 6 días\n  Pide que vayamos/);
  assert.strictEqual(pushes[0].title, '1 correo sin contestar');
  assert.strictEqual(emails[0].avisosSinContestar, 1);
  assert.strictEqual(emails[1].contestado.por, 'gmail (en el hilo)');
  assert.strictEqual(emails[5].contestado.por, 'gmail (enviado a ese remitente)');
  // Lo ya averiguado no se vuelve a preguntar a Gmail.
  const antes = gmail.llamadas;
  await SC.aviso({ _db: db, _gmail: gmail, _enviar: async t => avisos.push(t), _push: async () => {}, ahora: AHORA });
  assert.strictEqual(gmail.llamadas - antes, 3);                                                                       // solo el de Jordi
});

test('como mucho 3 avisos por correo; contestado en el grupo cuenta; SIN_CONTESTAR=off lo apaga', async () => {
  const emails = [correo('1'), correo('2', { asunto: 'Otra cosa' })];
  const db = fakeDb(emails, [{ gmailIds: ['g2'], respondimos: true, canal: 'grupo' }]);
  const gmail = fakeGmail({});
  const avisos = [];
  for (let i = 0; i < 5; i++) await SC.aviso({ _db: db, _gmail: gmail, _enviar: async t => avisos.push(t), _push: async () => {}, ahora: AHORA });
  assert.strictEqual(avisos.length, 3);
  assert.strictEqual(emails[1].contestado.por, 'grupo de WhatsApp');
  process.env.SIN_CONTESTAR = 'off';
  try { assert.deepStrictEqual(await SC.aviso({ _db: fakeDb([correo('9')]), _gmail: gmail, ahora: AHORA }), { enviado: false, motivo: 'apagado' }); }
  finally { delete process.env.SIN_CONTESTAR; }
});

test('las 24 h son laborables: el viernes por la tarde no avisa el lunes a primera hora', () => {
  const vie = new Date('2026-10-30T16:00:00Z'), lun = new Date('2026-11-02T08:15:00Z');
  assert.ok(SC.horasLaborables(vie, lun) < 24);
  assert.ok(SC.horasLaborables(vie, new Date('2026-11-03T08:15:00Z')) >= 24);
});
