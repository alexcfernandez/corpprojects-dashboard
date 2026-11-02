// Tablero del ciclo de un trabajo: cada pedido/incidencia en su columna y con su color (2/11/2026).
const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/ciclo');

const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
const hace = d => new Date(Date.parse(hoy) - d * 86400000).toISOString().slice(0, 10);
const stel = d => hace(d) + 'T00:00:00+0000';

function fakeDb(cols) {
  return { collection: n => ({ find: () => { const l = cols[n] || []; const c = { sort: () => c, limit: () => c, toArray: async () => l }; return c; } }) };
}

const S = {
  getAllIncidents: async () => [
    { id: 1, 'full-reference': 'INC00001', date: stel(10), 'incident-state-id': 1, 'incident-type-id': 10, 'account-id': 7, description: 'Gotera' },
    { id: 2, 'full-reference': 'INC00002', date: stel(1), 'incident-state-id': 1, 'incident-type-id': 11, 'account-id': 7, description: 'Malla' },
    { id: 3, 'full-reference': 'INC00003', date: stel(5), 'incident-state-id': 1, 'incident-type-id': 10, 'account-id': 7, description: 'Bajante' },
    { id: 4, 'full-reference': 'INC00004', date: stel(6), 'incident-state-id': 1, 'incident-type-id': 10, 'account-id': 7, description: 'Luz escalera' },
    { id: 5, 'full-reference': 'INC00005', date: stel(9), 'incident-state-id': 3, 'incident-type-id': 10, 'account-id': 7, description: 'Grifo' },
    { id: 6, 'full-reference': 'INC00006', date: stel(30), 'incident-state-id': 1, 'incident-type-id': 10, 'account-id': 7, description: 'Persiana' },
    { id: 8, 'full-reference': 'INC00008', date: stel(40), 'incident-state-id': 2, 'incident-type-id': 10, 'account-id': 7, description: 'Facturada aparte' },
    { id: 9, 'full-reference': 'INC00009', date: stel(2), 'incident-state-id': 1, 'incident-type-id': 11, 'account-id': 7, description: 'Presupuesto fachada' },
  ],
  getIncidentStateMap: async () => ({ 1: 'Pendiente', 2: 'Facturado', 3: 'Cerrada' }),
  getIncidentTypeMaps: async () => ({ typeName: { 10: 'Actuación', 11: 'Presupuesto' } }),
  getClients: async () => ({ clientMap: { 7: { name: 'Ctat. Bellpuig 41' } } }),
  getAllWorkOrders: async () => [
    { id: 103, 'full-reference': 'PDT00103', date: stel(5), 'document-state-id': 100, 'parent-incident-id': 3, 'account-id': 7 },
    { id: 104, 'full-reference': 'PDT00104', date: stel(6), 'document-state-id': 100, 'parent-incident-id': 4, 'account-id': 7 },
    { id: 105, 'full-reference': 'PDT00105', date: stel(9), 'document-state-id': 100, 'parent-incident-id': 5, 'account-id': 7 },
    { id: 106, 'full-reference': 'PDT00106', date: stel(30), 'document-state-id': 101, 'parent-incident-id': 6, 'account-id': 7 },
    { id: 107, 'full-reference': 'PDT00107', date: stel(30), 'document-state-id': 101, 'parent-incident-id': 6, 'account-id': 7 },
    { id: 108, 'full-reference': 'PDT00108', date: stel(40), 'document-state-id': 101, 'parent-incident-id': 8, 'account-id': 7 },
    { id: 109, 'full-reference': 'PDT00109', date: stel(2), 'document-state-id': 100, 'parent-incident-id': 9, 'account-id': 7 },
  ],
  getWorkOrderStateMap: async () => ({ 100: 'Pendiente', 101: 'Cerrado' }),
  getAllOrdinaryInvoices: async () => ({
    901: { number: 'FAC00901', date: stel(40), total: 300, pendiente: 120, parentId: '106', lineParents: [] },
    902: { number: 'FAC00902', date: stel(20), total: 500, pendiente: 0, parentId: '107', lineParents: [], modificada: stel(2) },
  }),
  getWorkEstimates: async () => [
    { id: 50, 'full-reference': 'PRT00050', date: stel(20), 'document-state-id': 1120641, 'account-id': 7, title: 'Tejado', 'total-amount': 2500 },
    { id: 51, 'full-reference': 'PRT00051', date: stel(20), 'document-state-id': 1120640, 'account-id': 7, title: 'Aceptado' },
  ],
};
const db = fakeDb({
  workOrderAssignments: [
    { workOrderId: '103', userId: 'u1', userName: 'David', assignedAt: new Date(Date.parse(hoy) - 3 * 86400000) },
    { workOrderId: '104', userId: 'u1', userName: 'David', fecha: hace(3), hora: '10:00' },
    { workOrderId: '105', userId: 'u1', userName: 'David', fecha: hace(2), status: 'done', doneAt: new Date(Date.parse(hoy) - 86400000) },
  ],
  workOrderTimers: [], cicloIgnorar: [],
  partes: [{ workOrderId: '105', workerName: 'David', date: hace(1), horas: 3, materiales: [{ n: 'grifo' }], estadoTrabajo: 'completado', description: 'Cambio de grifo' }],
  peticionesGrupo: [{ _id: 'p1', estado: 'pendiente', tipo: 'trabajo', cliente: 'Illa Verda', resumen: 'Humedad en el 3-1', fecha: new Date(Date.parse(hoy) - 2 * 86400000), grupo: 'Correo · finquescompany.com', urgente: true }],
});

test('cada trabajo cae en su paso del ciclo con el color de los días que lleva parado', async () => {
  const d = await C.datos({ _S: S, _db: db });
  const col = k => [...d.columnas, ...d.presupuestos].find(c => c.k === k).tarjetas.map(t => `${t.ref}:${t.semaforo}`);
  assert.deepStrictEqual(col('asignar').sort(), ['INC00001:rojo', 'sin INC:rojo'].sort());   // 10 días; urgente de 2 días
  assert.deepStrictEqual(col('cita'), ['PDT00103:ambar']);
  assert.deepStrictEqual(col('programado'), ['PDT00104:rojo']);                         // la cita fue hace 3 días y no hay parte
  assert.deepStrictEqual(col('facturar'), ['PDT00105:verde']);
  assert.deepStrictEqual(col('cobrar'), ['PDT00106:ambar']);                            // 40 días facturada
  assert.deepStrictEqual(col('cobrado'), ['PDT00107:verde']);
  assert.deepStrictEqual(col('porHacer').sort(), ['INC00002:verde', 'PDT00109:verde']);
  assert.deepStrictEqual(col('enviado'), ['PRT00050:ambar']);
  const cobrar = d.columnas.find(c => c.k === 'cobrar');
  assert.strictEqual(cobrar.importe, 120);
  assert.match(d.columnas.find(c => c.k === 'programado').tarjetas[0].etiqueta, /falta el parte/);
  // La incidencia facturada aparte (PDT00108, INC Facturado) no sale; la INC00006 sigue abierta con todo facturado → limpieza
  assert.ok(!JSON.stringify(d.columnas).includes('PDT00108'));
  assert.deepStrictEqual(d.limpieza.map(x => x.ref), ['INC00006']);
});

test('el recorrido de una tarjeta marca lo hecho y dónde está parada', async () => {
  const d = await C.datos({ _S: S, _db: db });
  const t = d.columnas.find(c => c.k === 'facturar').tarjetas[0];
  const p = Object.fromEntries(t.pasos.map(x => [x.titulo, x.estado]));
  assert.deepStrictEqual(p, { 'Petición': 'hecho', 'Incidencia': 'hecho', 'Pedido y técnico': 'hecho', 'Cita': 'hecho', 'Parte de trabajo': 'hecho', 'Factura': 'actual', 'Cobro': 'pendiente' });
  assert.match(t.pasos.find(x => x.titulo === 'Parte de trabajo').detalle, /3 h · 1 material\(es\) · acabado — Cambio de grifo/);
});

test('ignorar solo acepta tarjetas de pedido o incidencia', async () => {
  await assert.rejects(() => C.ignorar('prt:1', '', 'x'), /no válida/);
});
