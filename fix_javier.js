// Pega esto en Railway Console: node fix_javier.js

const { MongoClient } = require('mongodb');
const MONGODB_URI = process.env.MONGODB_URI;

async function main() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db('corpprojects');

  // Encontrar ID de Javier
  const javier = await db.collection('colaboradores').findOne({ nombre: 'Javier' });
  if (!javier) { console.log('❌ Javier no encontrado'); process.exit(1); }
  const javierId = String(javier._id);
  console.log('✅ Javier encontrado:', javierId);

  // Borrar todos los movimientos actuales de Javier
  await db.collection('colaborador_movimientos').deleteMany({ colaboradorId: javierId });
  console.log('🗑️ Movimientos anteriores borrados');

  // Convertir fechas Excel (número de serie) a fecha ISO
  function excelDate(serial) {
    const d = new Date((serial - 25569) * 86400 * 1000);
    return d.toISOString().slice(0, 10);
  }

  // ── HORAS TRABAJADAS (devengado) ─────────────────────────────
  const semanas = [
    { desde:'2025-06-11', hasta:'2025-08-08', concepto:'Inicio — ~8 semanas',          horas:320,  importe:2400 },
    { desde:'2025-08-11', hasta:'2025-08-14', concepto:'Semana 11-14 ago',              horas:31,   importe:232.5 },
    { desde:'2025-08-18', hasta:'2025-08-22', concepto:'Semana 18-22 ago',              horas:27,   importe:202.5 },
    { desde:'2025-08-25', hasta:'2025-08-28', concepto:'Semana 25-28 ago',              horas:39,   importe:292.5 },
    { desde:'2025-09-01', hasta:'2025-09-05', concepto:'Semana 1-5 sep',                horas:35,   importe:262.5 },
    { desde:'2025-09-08', hasta:'2025-09-12', concepto:'Semana 8-12 sep (festivo)',     horas:32,   importe:240 },
    { desde:'2025-09-15', hasta:'2025-09-19', concepto:'Semana 15-19 sep',              horas:35,   importe:262.5 },
    { desde:'2025-09-22', hasta:'2025-09-27', concepto:'Semana 22-27 sep',              horas:40,   importe:300 },
    { desde:'2025-09-29', hasta:'2025-10-03', concepto:'Semana 29 sep - 3 oct',         horas:40,   importe:300 },
    { desde:'2025-10-06', hasta:'2025-10-10', concepto:'Semana 6-10 oct',               horas:40,   importe:300 },
    { desde:'2025-10-13', hasta:'2025-10-19', concepto:'Semana 13-17 oct + dom flyers', horas:43,   importe:322.5 },
    { desde:'2025-10-20', hasta:'2025-10-26', concepto:'Semana 20-24 oct + dom flyers', horas:43,   importe:322.5 },
    { desde:'2025-10-27', hasta:'2025-10-31', concepto:'Semana 27-31 oct (3 días)',      horas:24,   importe:180 },
    { desde:'2025-11-03', hasta:'2025-11-07', concepto:'Semana 3-7 nov',                horas:40,   importe:300 },
    { desde:'2025-11-10', hasta:'2025-11-14', concepto:'Semana 10-14 nov',              horas:40,   importe:300 },
    { desde:'2025-11-17', hasta:'2025-11-21', concepto:'Semana 17-21 nov',              horas:40,   importe:300 },
    { desde:'2025-11-24', hasta:'2025-11-28', concepto:'Semana 24-28 nov (falta lunes)',horas:32,   importe:240 },
    { desde:'2025-12-01', hasta:'2025-12-05', concepto:'Semana 1-5 dic (falta lunes)',  horas:32,   importe:240 },
    { desde:'2025-12-08', hasta:'2025-12-12', concepto:'Semana 8-12 dic',               horas:40,   importe:300 },
    { desde:'2025-12-15', hasta:'2025-12-19', concepto:'Semana 15-19 dic',              horas:40,   importe:300 },
    { desde:'2026-01-08', hasta:'2026-01-09', concepto:'8-9 ene (2 días vuelta vacaciones)', horas:16, importe:120 },
    { desde:'2026-01-12', hasta:'2026-01-16', concepto:'Semana 12-16 ene',              horas:40,   importe:300 },
    { desde:'2026-01-18', hasta:'2026-01-18', concepto:'Domingo 18 ene (extra)',        horas:8,    importe:60 },
    { desde:'2026-01-19', hasta:'2026-01-23', concepto:'Semana 19-23 ene',              horas:40,   importe:300 },
    { desde:'2026-01-26', hasta:'2026-01-30', concepto:'Semana 26-30 ene',              horas:40,   importe:300 },
    { desde:'2026-02-02', hasta:'2026-02-06', concepto:'Semana 2-6 feb',                horas:40,   importe:300 },
    { desde:'2026-02-09', hasta:'2026-02-13', concepto:'Semana 9-13 feb',               horas:40,   importe:300 },
    { desde:'2026-02-16', hasta:'2026-02-20', concepto:'Semana 16-20 feb',              horas:40,   importe:300 },
    { desde:'2026-02-23', hasta:'2026-02-27', concepto:'Semana 23-27 feb',              horas:40,   importe:300 },
    { desde:'2026-03-02', hasta:'2026-03-06', concepto:'Semana 2-6 mar',                horas:40,   importe:300 },
    { desde:'2026-03-09', hasta:'2026-03-13', concepto:'Semana 9-13 mar (falta 11)',    horas:32,   importe:240 },
    { desde:'2026-03-16', hasta:'2026-03-20', concepto:'Semana 16-20 mar',              horas:40,   importe:300 },
    { desde:'2026-03-23', hasta:'2026-03-27', concepto:'Semana 23-27 mar + extra Creu', horas:40,   importe:300 },
    { desde:'2026-03-30', hasta:'2026-04-03', concepto:'Semana 30 mar - 3 abr',         horas:40,   importe:300 },
    { desde:'2026-04-06', hasta:'2026-04-10', concepto:'Semana 6-10 abr',               horas:40,   importe:300 },
    { desde:'2026-04-13', hasta:'2026-04-17', concepto:'Semana 13-17 abr',              horas:40,   importe:300 },
    { desde:'2026-04-04', hasta:'2026-04-25', concepto:'Sábados extra (4, 18, 25 abr)', horas:24,   importe:180 },
    { desde:'2026-04-20', hasta:'2026-04-24', concepto:'Semana 20-24 abr',              horas:40,   importe:300 },
    { desde:'2026-04-27', hasta:'2026-05-01', concepto:'Semana 27 abr - 1 may',         horas:40,   importe:300 },
    { desde:'2026-05-04', hasta:'2026-05-08', concepto:'Semana 4-8 may',                horas:40,   importe:300 },
    { desde:'2026-05-11', hasta:'2026-05-15', concepto:'Semana 11-15 may',              horas:40,   importe:300 },
    { desde:'2026-05-18', hasta:'2026-05-22', concepto:'Semana 18-22 may',              horas:40,   importe:300 },
    { desde:'2026-05-25', hasta:'2026-05-29', concepto:'Semana 25-29 may',              horas:40,   importe:300 },
    { desde:'2026-06-01', hasta:'2026-06-05', concepto:'Semana 1-5 jun',                horas:40,   importe:300 },
  ];

  const movsSemanas = semanas.map(s => ({
    colaboradorId: javierId,
    colaboradorNombre: 'Javier',
    fecha: s.hasta,
    tipo: 'pago_semana',
    importe: s.importe,
    concepto: s.concepto,
    semanaDesde: s.desde,
    semanaHasta: s.hasta,
    diasTrabajados: parseFloat((s.horas / 8).toFixed(1)),
    horasExtra: 0,
    clienteObra: '',
    notas: `${s.horas}h × 7,50€/h`,
    esDescuento: false,
    esDevolucion: false,
    createdAt: new Date(),
  }));

  // ── DINERO ENTREGADO (del Excel, fechas convertidas) ──────────
  const entregado = [
    { serial:45835, tipo:'pago_semana', concepto:'Pago',                    importe:50 },
    { serial:45837, tipo:'pago_semana', concepto:'Pago',                    importe:150 },
    { serial:45842, tipo:'pago_semana', concepto:'Pago',                    importe:50 },
    { serial:45843, tipo:'pago_semana', concepto:'Pago',                    importe:300 },
    { serial:45845, tipo:'adelanto',    concepto:'Préstamo',                importe:450 },
    { serial:45849, tipo:'adelanto',    concepto:'Adelanto',                importe:50 },
    { serial:45852, tipo:'adelanto',    concepto:'Adelanto',                importe:100 },
    { serial:45854, tipo:'adelanto',    concepto:'Adelanto',                importe:20 },
    { serial:45856, tipo:'adelanto',    concepto:'Adelanto',                importe:150 },
    { serial:45860, tipo:'adelanto',    concepto:'Adelanto',                importe:170 },
    { serial:45867, tipo:'adelanto',    concepto:'Adelanto',                importe:200 },
    { serial:45870, tipo:'adelanto',    concepto:'Adelanto',                importe:200 },
    { serial:45875, tipo:'adelanto',    concepto:'Adelanto',                importe:550 },
    { serial:45879, tipo:'adelanto',    concepto:'Adelanto',                importe:50 },
    { serial:45880, tipo:'adelanto',    concepto:'Adelanto',                importe:50 },
    { serial:45881, tipo:'adelanto',    concepto:'Adelanto',                importe:100 },
    { serial:45889, tipo:'adelanto',    concepto:'Adelanto',                importe:250 },
    { serial:45891, tipo:'adelanto',    concepto:'Adelanto',                importe:150 },
    { serial:45898, tipo:'adelanto',    concepto:'Adelanto',                importe:450 },
    { serial:45905, tipo:'adelanto',    concepto:'Adelanto',                importe:150 },
    { serial:45910, tipo:'adelanto',    concepto:'Adelanto',                importe:100 },
    { serial:45911, tipo:'adelanto',    concepto:'Adelanto',                importe:200 },
    { serial:45916, tipo:'adelanto',    concepto:'Adelanto',                importe:50 },
    { serial:45919, tipo:'adelanto',    concepto:'Adelanto',                importe:200 },
    { serial:45923, tipo:'adelanto',    concepto:'Adelanto',                importe:100 },
    { serial:45926, tipo:'adelanto',    concepto:'Adelanto',                importe:150 },
    { serial:45931, tipo:'adelanto',    concepto:'Adelanto',                importe:30 },
    { serial:45934, tipo:'adelanto',    concepto:'Adelanto',                importe:200 },
    { serial:45937, tipo:'adelanto',    concepto:'Adelanto',                importe:30 },
    { serial:45939, tipo:'adelanto',    concepto:'Adelanto',                importe:20 },
    { serial:45940, tipo:'adelanto',    concepto:'Adelanto',                importe:300 },
    { serial:45944, tipo:'adelanto',    concepto:'Adelanto',                importe:100 },
    { serial:45947, tipo:'adelanto',    concepto:'Adelanto',                importe:150 },
    { serial:45949, tipo:'adelanto',    concepto:'Adelanto',                importe:20 },
    { serial:45951, tipo:'adelanto',    concepto:'Adelanto',                importe:130 },
    { serial:45953, tipo:'adelanto',    concepto:'Adelanto',                importe:50 },
    { serial:45954, tipo:'adelanto',    concepto:'Adelanto',                importe:20 },
    { serial:45957, tipo:'adelanto',    concepto:'Adelanto',                importe:50 },
    { serial:45959, tipo:'adelanto',    concepto:'Adelanto',                importe:50 },
    { serial:45961, tipo:'adelanto',    concepto:'Adelanto',                importe:100 },
    { serial:45962, tipo:'adelanto',    concepto:'Adelanto',                importe:100 },
    { serial:45967, tipo:'adelanto',    concepto:'Adelanto',                importe:100 },
    { serial:45972, tipo:'adelanto',    concepto:'Adelanto',                importe:100 },
    { serial:45972, tipo:'descuento',   concepto:'Estufa',                  importe:80 },
    { serial:45972, tipo:'descuento',   concepto:'Gas butano',              importe:25 },
    { serial:45975, tipo:'adelanto',    concepto:'Adelanto',                importe:240 },
    { serial:45977, tipo:'adelanto',    concepto:'Adelanto',                importe:40 },
    { serial:45978, tipo:'descuento',   concepto:'Menú mujer',              importe:15 },
    { serial:45980, tipo:'adelanto',    concepto:'Adelanto',                importe:50 },
    { serial:45982, tipo:'pago_semana', concepto:'Pago semana 14-21',       importe:150 },
    { serial:45982, tipo:'descuento',   concepto:'Estufa nueva',            importe:100 },
    { serial:45987, tipo:'adelanto',    concepto:'Adelanto',                importe:40 },
    { serial:45988, tipo:'adelanto',    concepto:'Adelanto',                importe:40 },
    { serial:45988, tipo:'descuento',   concepto:'2 bombonas butano',       importe:40 },
    { serial:45988, tipo:'adelanto',    concepto:'Adelanto',                importe:100 },
    { serial:45989, tipo:'adelanto',    concepto:'Adelanto',                importe:50 },
    { serial:45992, tipo:'adelanto',    concepto:'Adelanto',                importe:250 },
    { serial:45994, tipo:'descuento',   concepto:'Bombona butano',          importe:15 },
    { serial:45995, tipo:'adelanto',    concepto:'Adelanto',                importe:50 },
    { serial:45996, tipo:'pago_semana', concepto:'Pago semana 1-5 dic',     importe:100 },
    { serial:45998, tipo:'adelanto',    concepto:'Adelanto',                importe:30 },
    { serial:46001, tipo:'adelanto',    concepto:'Adelanto',                importe:50 },
    { serial:46003, tipo:'pago_semana', concepto:'Pago semana 8-12 dic',    importe:200 },
    { serial:46005, tipo:'adelanto',    concepto:'Adelanto',                importe:50 },
    { serial:46009, tipo:'adelanto',    concepto:'Adelanto',                importe:50 },
    { serial:46009, tipo:'descuento',   concepto:'Bombonas butano',         importe:32 },
    { serial:46009, tipo:'pago_semana', concepto:'Pago semana 15-19 dic',   importe:180 },
    { serial:46011, tipo:'adelanto',    concepto:'Adelanto Alicante',       importe:100 },
    { serial:46029, tipo:'adelanto',    concepto:'Adelanto',                importe:45 },
    { serial:46032, tipo:'pago_semana', concepto:'Pago',                    importe:50 },
    { serial:46034, tipo:'adelanto',    concepto:'Adelanto',                importe:158 },
    { serial:46038, tipo:'pago_semana', concepto:'Pago semana 12-16 ene',   importe:150 },
    { serial:46043, tipo:'descuento',   concepto:'2 bombonas butano',       importe:35 },
    { serial:46044, tipo:'pago_semana', concepto:'Domingo extra',           importe:60 },
    { serial:46045, tipo:'pago_semana', concepto:'Pago semana 19-23 ene',   importe:250 },
    { serial:46049, tipo:'adelanto',    concepto:'Adelanto',                importe:50 },
    { serial:46052, tipo:'pago_semana', concepto:'Pago',                    importe:150 },
    { serial:46055, tipo:'adelanto',    concepto:'Adelanto',                importe:50 },
    { serial:46059, tipo:'pago_semana', concepto:'Pago semana',             importe:150 },
    { serial:46062, tipo:'adelanto',    concepto:'Adelanto',                importe:20 },
    { serial:46064, tipo:'adelanto',    concepto:'Adelanto',                importe:50 },
    { serial:46066, tipo:'pago_semana', concepto:'Pago',                    importe:180 },
    { serial:46070, tipo:'adelanto',    concepto:'Adelanto',                importe:70 },
    { serial:46071, tipo:'adelanto',    concepto:'Adelanto',                importe:30 },
    { serial:46073, tipo:'adelanto',    concepto:'Adelanto',                importe:10 },
    { serial:46073, tipo:'adelanto',    concepto:'Adelanto',                importe:20 },
    { serial:46073, tipo:'pago_semana', concepto:'Pago',                    importe:100 },
    { serial:46073, tipo:'descuento',   concepto:'Apostillar documentos',   importe:20 },
    { serial:46075, tipo:'adelanto',    concepto:'Adelanto',                importe:50 },
    { serial:46077, tipo:'adelanto',    concepto:'Adelanto',                importe:50 },
    { serial:46080, tipo:'pago_semana', concepto:'Pago',                    importe:150 },
    { serial:46080, tipo:'adelanto',    concepto:'Adelanto',                importe:50 },
    { serial:46082, tipo:'adelanto',    concepto:'Adelanto',                importe:50 },
    { serial:46084, tipo:'adelanto',    concepto:'Adelanto',                importe:30 },
    { serial:46087, tipo:'pago_semana', concepto:'Pago',                    importe:120 },
    { serial:46088, tipo:'adelanto',    concepto:'Adelanto',                importe:50 },
    { serial:46088, tipo:'adelanto',    concepto:'Adelanto',                importe:20 },
    { serial:46090, tipo:'adelanto',    concepto:'Adelanto',                importe:100 },
    { serial:46092, tipo:'adelanto',    concepto:'Adelanto',                importe:300 },
    { serial:46093, tipo:'adelanto',    concepto:'Adelanto',                importe:20 },
    { serial:46094, tipo:'adelanto',    concepto:'Adelanto',                importe:10 },
    { serial:46094, tipo:'pago_semana', concepto:'Pago',                    importe:90 },
    { serial:46095, tipo:'pago_semana', concepto:'Pago',                    importe:70 },
    { serial:46097, tipo:'adelanto',    concepto:'Adelanto',                importe:100 },
    { serial:46099, tipo:'adelanto',    concepto:'Adelanto',                importe:50 },
    { serial:46101, tipo:'pago_semana', concepto:'Pago',                    importe:150 },
    { serial:46104, tipo:'adelanto',    concepto:'Adelanto',                importe:100 },
    { serial:46106, tipo:'adelanto',    concepto:'Adelanto',                importe:50 },
    { serial:46108, tipo:'pago_semana', concepto:'Pago',                    importe:100 },
    { serial:46108, tipo:'pago_semana', concepto:'Horas extra c/ la Creu',  importe:80 },
    { serial:46109, tipo:'adelanto',    concepto:'Adelanto',                importe:100 },
    { serial:46112, tipo:'adelanto',    concepto:'Adelanto',                importe:110 },
    { serial:46114, tipo:'pago_semana', concepto:'Pago',                    importe:50 },
    { serial:46116, tipo:'adelanto',    concepto:'Adelanto',                importe:50 },
    { serial:46116, tipo:'pago_semana', concepto:'Sábado trabajado',        importe:60 },
    { serial:46117, tipo:'adelanto',    concepto:'Adelanto',                importe:30 },
    { serial:46119, tipo:'adelanto',    concepto:'Adelanto',                importe:100 },
    { serial:46121, tipo:'adelanto',    concepto:'Adelanto',                importe:50 },
    { serial:46122, tipo:'adelanto',    concepto:'Adelanto',                importe:150 },
    { serial:46124, tipo:'adelanto',    concepto:'Adelanto',                importe:60 },
    { serial:46126, tipo:'adelanto',    concepto:'Adelanto',                importe:100 },
    { serial:46128, tipo:'adelanto',    concepto:'Adelanto',                importe:25 },
    { serial:46128, tipo:'adelanto',    concepto:'Adelanto',                importe:50 },
    { serial:46129, tipo:'adelanto',    concepto:'Adelanto',                importe:300 },
    { serial:46130, tipo:'pago_semana', concepto:'Sábado trabajado',        importe:50 },
    { serial:46133, tipo:'adelanto',    concepto:'Adelanto',                importe:150 },
    { serial:46137, tipo:'pago_semana', concepto:'Sábado trabajado',        importe:40 },
    { serial:46143, tipo:'adelanto',    concepto:'Adelanto semana 27-1',    importe:150 },
    { serial:46143, tipo:'pago_semana', concepto:'Restante semana',         importe:50 },
    { serial:46146, tipo:'adelanto',    concepto:'Adelanto',                importe:10 },
    { serial:46147, tipo:'adelanto',    concepto:'Adelanto semana 4-8',     importe:50 },
    { serial:46149, tipo:'adelanto',    concepto:'Adelanto semana 4-8',     importe:100 },
    { serial:46150, tipo:'pago_semana', concepto:'Faltante semana',         importe:90 },
    { serial:46150, tipo:'adelanto',    concepto:'Adelanto semana 11-15',   importe:60 },
    { serial:46153, tipo:'adelanto',    concepto:'Adelanto semana 11-15',   importe:50 },
    { serial:46154, tipo:'adelanto',    concepto:'Adelanto',                importe:50 },
    { serial:46157, tipo:'pago_semana', concepto:'Faltante semana',         importe:100 },
    { serial:46158, tipo:'adelanto',    concepto:'Adelanto semana 18-22',   importe:50 },
    { serial:46160, tipo:'adelanto',    concepto:'Adelanto semana 18-22',   importe:50 },
    { serial:46162, tipo:'adelanto',    concepto:'Adelanto',                importe:20 },
    { serial:46163, tipo:'adelanto',    concepto:'Adelanto',                importe:20 },
    { serial:46164, tipo:'adelanto',    concepto:'Adelanto',                importe:15 },
    { serial:46164, tipo:'pago_semana', concepto:'Faltante semana',         importe:95 },
    { serial:46168, tipo:'adelanto',    concepto:'Adelanto semana 25-29',   importe:100 },
    { serial:46170, tipo:'adelanto',    concepto:'Adelanto semana 25-29',   importe:53.15 },
    { serial:46176, tipo:'adelanto',    concepto:'Adelanto semana 1-5 jun', importe:100 },
    { serial:46178, tipo:'pago_semana', concepto:'Pago faltante semana 1-5 jun', importe:150 },
  ];

  const movsEntregado = entregado.map(e => ({
    colaboradorId: javierId,
    colaboradorNombre: 'Javier',
    fecha: excelDate(e.serial),
    tipo: e.tipo,
    importe: e.importe,
    concepto: e.concepto,
    semanaDesde: '',
    semanaHasta: '',
    diasTrabajados: 0,
    horasExtra: 0,
    clienteObra: '',
    notas: '',
    esDescuento: e.tipo === 'descuento',
    esDevolucion: false,
    createdAt: new Date(),
  }));

  // Insertar todo
  const todosMovs = [...movsSemanas, ...movsEntregado];
  await db.collection('colaborador_movimientos').insertMany(todosMovs);
  console.log(`✅ ${movsSemanas.length} semanas de trabajo cargadas`);
  console.log(`✅ ${movsEntregado.length} movimientos de dinero entregado cargados`);
  console.log(`✅ Total: ${todosMovs.length} movimientos`);

  // Verificar saldo
  const movs = await db.collection('colaborador_movimientos').find({ colaboradorId: javierId }).toArray();
  let devengado = 0, pagado = 0, descuentos = 0;
  movs.forEach(m => {
    if (m.tipo === 'pago_semana') { devengado += m.importe; pagado += m.importe; }
    else if (m.tipo === 'pago_dias') { devengado += m.importe; pagado += m.importe; }
    else if (m.tipo === 'adelanto') { pagado += m.importe; }
    else if (m.tipo === 'descuento') { descuentos += m.importe; }
  });

  // El saldo real: devengado del trabajo (semanas) menos todo lo entregado
  const totalTrabajo = movsSemanas.reduce((s, m) => s + m.importe, 0);
  const totalEntregado = movsEntregado.reduce((s, m) => s + m.importe, 0);
  const neto = totalTrabajo - totalEntregado;

  console.log(`\n📊 RESUMEN JAVIER:`);
  console.log(`   Ganado trabajando: ${totalTrabajo.toFixed(2)}€`);
  console.log(`   Total entregado:   ${totalEntregado.toFixed(2)}€`);
  console.log(`   Neto:              ${neto.toFixed(2)}€ ${neto < 0 ? '(ha cobrado de más)' : '(le debemos)'}`);
  console.log(`   Préstamo pendiente: 450€`);

  await client.close();
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
