// test/fase1-agente.test.js — Fase 1 (MVP del agente): plomería de calendario,
// resolverConConfianza (anti-misroute), dispatch del agente con modelo mockeado,
// continuidad tras reinicio, y el caso canónico del calendario por el gate.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const root = path.join(__dirname, '..');

// ── Mock de 'googleapis' (captura el body del evento) ──
let calInsertBody = null;
const fakeCal = { events: { insert: async ({ requestBody }) => { calInsertBody = requestBody; return { data: { id: 'evt_1' } }; } } };
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'googleapis') return { google: { auth: { OAuth2: function () { return { setCredentials() {} }; } }, calendar: () => fakeCal } };
  return origLoad.apply(this, arguments);
};

// ── Mock de ./db ──
const cols = {};
function col(name) {
  if (!cols[name]) cols[name] = { rows: [], async findOne(q) { return this.rows.find(r => Object.entries(q).every(([k, v]) => r[k] === v)) || null; },
    async updateOne(q, u, o) { let r = this.rows.find(x => Object.entries(q).every(([k, v]) => x[k] === v)); if (!r && (o && o.upsert)) { r = { ...q }; this.rows.push(r); } if (r) { if (u.$set) Object.assign(r, u.$set); if (u.$inc) for (const k in u.$inc) r[k] = (r[k] || 0) + u.$inc[k]; } return {}; },
    async insertOne(d) { this.rows.push(d); return { insertedId: 'x' }; }, async deleteOne(q) { this.rows = this.rows.filter(r => !Object.entries(q).every(([k, v]) => r[k] === v)); return {}; } };
  return cols[name];
}
const dbPath = require.resolve(path.join(root, 'src/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDB: async () => ({ collection: col }), getDBLegacy: async () => ({ db: { collection: col }, client: { async close() {} } }) } };

process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.OWNER_NUMBERS = '+34611223344';
process.env.GMAIL_CLIENT_ID = 'x'; process.env.GMAIL_REFRESH_TOKEN = 'y';

const calendar = require(path.join(root, 'src/calendar.js'));
const asistente = require(path.join(root, 'src/asistente.js'));
const agente = require(path.join(root, 'src/agente.js'));
const stel = require(path.join(root, 'src/stelorder.js'));
const com = require(path.join(root, 'src/comunidades.js'));
const estado = require(path.join(root, 'src/estadoConversacion.js'));

// Datos de clientes para listas()/resolverConConfianza
stel.getClients = async () => ({ clientMap: { 1: { name: 'Illa Verda' }, 2: { name: 'Bellpuig' }, 3: { name: 'Travessia de la Creu 15 17 19' } }, families: [{ name: 'Cinc' }] });
// Spy en addNota
let notasEscritas = [];
com.addNota = async (target, scope, texto) => { notasEscritas.push({ target, texto }); return { ok: true, cat: 'otros' }; };

const OWNER = 'whatsapp:+34611223344';
const tick = () => new Promise(r => setImmediate(r));

// ── A) calendar.crearEventoPersonal ──
test('crearEventoPersonal con hora → evento con dateTime + cpSource:agenda', async () => {
  calInsertBody = null;
  const id = await calendar.crearEventoPersonal({ date: '2026-08-01', hora: '19:00', titulo: 'Santi dentista' });
  assert.equal(id, 'evt_1');
  assert.match(calInsertBody.summary, /^🗓️ Santi dentista/);
  assert.equal(calInsertBody.start.dateTime, '2026-08-01T19:00:00');
  assert.equal(calInsertBody.extendedProperties.private.cpSource, 'agenda');
});
test('crearEventoPersonal sin hora → evento de día completo', async () => {
  calInsertBody = null;
  await calendar.crearEventoPersonal({ date: '2026-08-01', hora: null, titulo: 'Revisión' });
  assert.equal(calInsertBody.start.date, '2026-08-01');
  assert.equal(calInsertBody.start.dateTime, undefined);
});

// ── B) resolverConConfianza (anti-misroute) ──
test('resolverConConfianza: match claro → alta; frase de agenda → baja (no adivina)', async () => {
  const clara = await asistente.resolverConConfianza('Illa Verda', 'Illa Verda');
  assert.equal(clara.confianza, 'alta'); assert.equal(clara.target, 'Illa Verda');
  const agenda = await asistente.resolverConConfianza('el calendario a las 19 santi dentista', 'el calendario a las 19 santi dentista');
  assert.equal(agenda.confianza, 'baja'); assert.equal(agenda.target, null);
});

// ── C) Dispatch del agente (modelo mockeado) ──
test('agente: tool_use crear_evento_agenda → crea evento, NO nota de comunidad', async () => {
  calInsertBody = null; notasEscritas = []; estado._cache.clear();
  agente._impl.llamarModelo = async () => ({ tipo: 'tool', name: 'crear_evento_agenda', input: { fecha: '2026-08-02', hora: '19:00', titulo: 'Santi dentista' } });
  const r = await agente.intentar({ texto: 'apunta mañana en el calendario a las 19 Santi dentista', from: OWNER, puerta: 'B' });
  assert.equal(r.handled, true);
  assert.match(r.reply, /agenda/i);
  assert.equal(notasEscritas.length, 0, 'no debe tocar comunidadNotas');
  assert.ok(calInsertBody, 'creó el evento');
});
test('agente: texto (aclaración) → guarda agente_aclara y devuelve la pregunta', async () => {
  estado._cache.clear();
  agente._impl.llamarModelo = async () => ({ tipo: 'texto', texto: '¿En qué comunidad?' });
  const r = await agente.intentar({ texto: 'apunta que la caldera es Roca', from: OWNER, puerta: 'B' });
  await tick();
  assert.equal(r.handled, true); assert.match(r.reply, /comunidad/i);
  assert.equal(estado.get(OWNER).accion, 'agente_aclara');
});
test('agente: nada útil → handled:false (cae al fallback)', async () => {
  estado._cache.clear();
  agente._impl.llamarModelo = async () => ({ tipo: 'nada' });
  const r = await agente.intentar({ texto: 'blablabla', from: OWNER, puerta: 'A' });
  assert.equal(r.handled, false);
});

// ── D) Continuidad tras reinicio simulado ──
test('continuidad: agente pregunta → [reinicio] → la respuesta continúa y ejecuta', async () => {
  estado._cache.clear();
  agente._impl.llamarModelo = async () => ({ tipo: 'texto', texto: '¿En qué comunidad?' });
  await agente.intentar({ texto: 'apunta que la caldera es Roca', from: OWNER, puerta: 'B' });
  await tick();
  estado._cache.clear();                       // *** reinicio de Railway ***
  await estado.hydrate(OWNER);                  // recarga desde Mongo
  assert.equal(estado.get(OWNER).accion, 'agente_aclara');
  let vistos = null;
  agente._impl.llamarModelo = async (messages) => { vistos = messages; return { tipo: 'tool', name: 'anadir_nota_comunidad', input: { comunidad: 'Illa Verda', nota: 'la caldera es Roca' } }; };
  notasEscritas = [];
  const r = await agente.intentar({ texto: 'en Illa Verda', from: OWNER });
  assert.equal(r.handled, true);
  assert.equal(vistos.length, 3, 'reconstruye el historial original + pregunta + respuesta');
  assert.equal(notasEscritas[0].target, 'Illa Verda');
});

// ── E) Caso canónico por el GATE (Puerta B) ──
test('GATE: "apunta mañana en el calendario a las 19 Santi dentista" → evento, NO comunidad', async () => {
  calInsertBody = null; notasEscritas = []; estado._cache.clear();
  agente._impl.llamarModelo = async () => ({ tipo: 'tool', name: 'crear_evento_agenda', input: { fecha: '2026-08-02', hora: '19:00', titulo: 'Santi dentista' } });
  const reply = await asistente.responderConsulta('apunta mañana en el calendario a las 19 Santi dentista', OWNER);
  assert.match(reply, /agenda/i);
  assert.equal(notasEscritas.length, 0, 'NO se archiva en ninguna comunidad (fin del bug)');
  assert.ok(calInsertBody);
});
test('GATE: "apunta en Illa Verda que la caldera es Roca" → nota de comunidad (sin regresión)', async () => {
  notasEscritas = []; estado._cache.clear();
  agente._impl.llamarModelo = async () => ({ tipo: 'nada' }); // no debería ni llamarse
  const reply = await asistente.responderConsulta('apunta en Illa Verda que la caldera es Roca', OWNER);
  assert.equal(notasEscritas.length, 1);
  assert.equal(notasEscritas[0].target, 'Illa Verda');
  assert.match(reply, /Illa Verda/);
});

test.after(() => { Module._load = origLoad; });
