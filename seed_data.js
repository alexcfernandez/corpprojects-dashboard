// Script de carga de datos históricos para Corp Projects
// Ejecutar desde Railway Console con: node seed_data.js
// O localmente con MONGODB_URI en .env

const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) { console.error('❌ Falta MONGODB_URI'); process.exit(1); }

async function main() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db('corpprojects');
  console.log('✅ Conectado a MongoDB');

  // ── 1. COLABORADORES ─────────────────────────────────────────
  console.log('\n📋 Creando colaboradores...');
  await db.collection('colaboradores').deleteMany({});

  const colaboradoresData = [
    { nombre:'David Taladros', alias:'David',         oficio:'Operario construcción', tipoTarifa:'semana', tarifaSemana:300,  tarifaDia:60,   tarifaHora:7.5,  diasSemanales:5, horasDia:8, activo:true,  fechaAlta:'2025-06-01', notas:'Pendiente dar de alta en empresa' },
    { nombre:'Javier',         alias:'Javier',        oficio:'Operario',              tipoTarifa:'semana', tarifaSemana:300,  tarifaDia:60,   tarifaHora:7.5,  diasSemanales:5, horasDia:8, activo:true,  fechaAlta:'2025-06-11', notas:'Empezó con Corp Projects el 11/06/2025' },
    { nombre:'Alfonso',        alias:'Alfonso',       oficio:'Operario / Colaborador',tipoTarifa:'dia',    tarifaSemana:250,  tarifaDia:50,   tarifaHora:6.25, diasSemanales:5, horasDia:8, activo:true,  fechaAlta:'2025-09-01', notas:'' },
    { nombre:'Nabil',          alias:'Nabil',         oficio:'Pladur / Obra',         tipoTarifa:'dia',    tarifaSemana:350,  tarifaDia:70,   tarifaHora:8.75, diasSemanales:5, horasDia:8, activo:true,  fechaAlta:'2026-01-01', notas:'' },
    { nombre:'Manuel padre',   alias:'Padre Manuel',  oficio:'Pladur',                tipoTarifa:'semana', tarifaSemana:650,  tarifaDia:130,  tarifaHora:16.25,diasSemanales:5, horasDia:8, activo:false, fechaAlta:'2025-09-01', notas:'Trabajo en piso F Santa Eugenia' },
  ];

  const colResult = await db.collection('colaboradores').insertMany(
    colaboradoresData.map(c => ({ ...c, createdAt:new Date(), updatedAt:new Date() }))
  );
  const davidId  = String(colResult.insertedIds[0]);
  const javierId = String(colResult.insertedIds[1]);
  console.log(`✅ ${Object.keys(colResult.insertedIds).length} colaboradores creados`);

  // ── 2. MOVIMIENTOS DAVID ──────────────────────────────────────
  console.log('\n💰 Cargando movimientos David Taladros...');
  await db.collection('colaborador_movimientos').deleteMany({ colaboradorId: davidId });

  const movsDavid = [
    { fecha:'2025-07-01', tipo:'adelanto',    importe:500,   concepto:'Adelanto julio' },
    { fecha:'2025-07-01', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2025-07-19', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2025-07-23', tipo:'pago_dias',   importe:500,   concepto:'Pago días' },
    { fecha:'2025-07-26', tipo:'pago_semana', importe:450,   concepto:'Pago semana 26 jul' },
    { fecha:'2025-07-31', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2025-08-04', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2025-08-07', tipo:'pago_dias',   importe:160,   concepto:'Pago días semana 7 ago' },
    { fecha:'2025-08-08', tipo:'pago_dias',   importe:200,   concepto:'Pago días 8 ago' },
    { fecha:'2025-08-11', tipo:'pago_semana', importe:500,   concepto:'Pago semana 11 ago' },
    { fecha:'2025-08-14', tipo:'pago_dias',   importe:200,   concepto:'Pago días 14 ago' },
    { fecha:'2025-08-15', tipo:'pago_semana', importe:500,   concepto:'Pago semana 15 ago' },
    { fecha:'2025-08-20', tipo:'pago_dias',   importe:100,   concepto:'Pago días 20 ago' },
    { fecha:'2025-08-22', tipo:'pago_dias',   importe:210,   concepto:'Pago días 22 ago' },
    { fecha:'2025-08-23', tipo:'pago_dias',   importe:300,   concepto:'Pago días 23 ago' },
    { fecha:'2025-09-10', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2025-09-15', tipo:'pago_dias',   importe:20,    concepto:'Pago días' },
    { fecha:'2025-09-18', tipo:'pago_dias',   importe:25,    concepto:'Pago días' },
    { fecha:'2025-09-19', tipo:'pago_semana', importe:500,   concepto:'Pago semana 19 sep' },
    { fecha:'2025-09-22', tipo:'pago_dias',   importe:150,   concepto:'Pago días 22 sep' },
    { fecha:'2025-09-23', tipo:'pago_dias',   importe:100,   concepto:'Pago días 23 sep' },
    { fecha:'2025-09-26', tipo:'pago_semana', importe:420,   concepto:'Pago semana 26 sep' },
    { fecha:'2025-10-02', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2025-10-06', tipo:'pago_semana', importe:390,   concepto:'Pago semana 6-10 oct' },
    { fecha:'2025-10-14', tipo:'adelanto',    importe:150,   concepto:'Adelanto semana' },
    { fecha:'2025-10-17', tipo:'pago_semana', importe:250,   concepto:'Pago semana 13-17 oct' },
    { fecha:'2025-10-21', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2025-10-31', tipo:'pago_semana', importe:250,   concepto:'Pago semana' },
    { fecha:'2025-10-31', tipo:'pago_semana', importe:200,   concepto:'Pago semana (50 descontado nevera)', notas:'50 no entregados' },
    { fecha:'2025-10-31', tipo:'descuento',   importe:50,    concepto:'Descuento nevera' },
    { fecha:'2025-11-06', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2025-11-07', tipo:'pago_semana', importe:450,   concepto:'Pago semana 3-7 nov (Valencia)', clienteObra:'Valencia' },
    { fecha:'2025-11-07', tipo:'adelanto',    importe:65,    concepto:'Adelanto' },
    { fecha:'2025-11-10', tipo:'pago_dias',   importe:40,    concepto:'Gasoil' },
    { fecha:'2025-11-14', tipo:'pago_semana', importe:235,   concepto:'Pago semana 10-14 nov' },
    { fecha:'2025-11-18', tipo:'adelanto',    importe:35,    concepto:'Adelanto' },
    { fecha:'2025-11-21', tipo:'pago_semana', importe:450,   concepto:'Pago semana 17-21 nov' },
    { fecha:'2025-11-21', tipo:'descuento',   importe:50,    concepto:'Herramientas pagadas por Corp' },
    { fecha:'2025-11-21', tipo:'pago_semana', importe:310,   concepto:'Pago semana 17-21 nov (complemento)' },
    { fecha:'2025-11-26', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2025-11-28', tipo:'pago_semana', importe:350,   concepto:'Pago semana 25-29 nov' },
    { fecha:'2025-11-28', tipo:'descuento',   importe:50,    concepto:'Herramientas pagadas por Corp' },
    { fecha:'2025-11-28', tipo:'pago_semana', importe:210,   concepto:'Pago semana 25-29 nov (complemento)' },
    { fecha:'2025-12-10', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2025-12-12', tipo:'pago_semana', importe:340,   concepto:'Pago semana David Taladros' },
    { fecha:'2025-12-12', tipo:'pago_semana', importe:287.5, concepto:'Pago semana' },
    { fecha:'2025-12-18', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2025-12-19', tipo:'pago_semana', importe:300,   concepto:'Pago semana' },
    { fecha:'2025-12-20', tipo:'pago_semana', importe:150,   concepto:'Pago semana 15-19 dic David Taladros' },
    { fecha:'2025-12-23', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2025-12-24', tipo:'pago_semana', importe:160,   concepto:'Pago semana' },
    { fecha:'2025-12-24', tipo:'adelanto',    importe:40,    concepto:'Adelanto' },
    { fecha:'2025-12-29', tipo:'adelanto',    importe:20,    concepto:'Adelanto' },
    { fecha:'2025-12-31', tipo:'pago_semana', importe:240,   concepto:'Pago semana David Taladros' },
    { fecha:'2025-12-31', tipo:'pago_semana', importe:100,   concepto:'Pago semana' },
    { fecha:'2025-12-31', tipo:'adelanto',    importe:100,   concepto:'Adelanto David Taladros' },
    { fecha:'2026-01-14', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2026-01-16', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2026-01-17', tipo:'adelanto',    importe:12.30, concepto:'Adelanto' },
    { fecha:'2026-01-17', tipo:'adelanto',    importe:40,    concepto:'Adelanto (2 pollitos)' },
    { fecha:'2026-01-17', tipo:'adelanto',    importe:110,   concepto:'Adelanto' },
    { fecha:'2026-01-23', tipo:'pago_semana', importe:350,   concepto:'Pago semana 19-23 ene David Taladros' },
    { fecha:'2026-01-23', tipo:'pago_semana', importe:500,   concepto:'Pago semana 19-23 ene incl. sáb 17 y dom 18' },
    { fecha:'2026-01-30', tipo:'pago_semana', importe:260,   concepto:'Pago semana parcial David Valencia' },
    { fecha:'2026-01-31', tipo:'pago_semana', importe:180,   concepto:'Pago semana David Taladros' },
    { fecha:'2026-02-05', tipo:'pago_dias',   importe:60,    concepto:'Gasolina furgoneta David' },
    { fecha:'2026-02-06', tipo:'pago_semana', importe:320,   concepto:'Pago semana David Taladros' },
    { fecha:'2026-04-02', tipo:'pago_dias',   importe:250,   concepto:'Pago suelo pisos' },
    { fecha:'2026-04-14', tipo:'pago_dias',   importe:260,   concepto:'Pago días 14 abr', clienteObra:'Santa Eugenia' },
    { fecha:'2026-05-02', tipo:'pago_dias',   importe:80,    concepto:'Gasolina furgoneta David' },
  ];

  await db.collection('colaborador_movimientos').insertMany(
    movsDavid.map(m => ({
      ...m, colaboradorId:davidId, colaboradorNombre:'David Taladros',
      clienteObra:m.clienteObra||'', notas:m.notas||'',
      semanaDesde:'', semanaHasta:'', diasTrabajados:0, horasExtra:0,
      esDescuento:m.tipo==='descuento', esDevolucion:m.tipo==='devolucion',
      createdAt:new Date()
    }))
  );
  console.log(`✅ ${movsDavid.length} movimientos David`);

  // ── 3. MOVIMIENTOS JAVIER ─────────────────────────────────────
  console.log('\n💰 Cargando movimientos Javier...');
  await db.collection('colaborador_movimientos').deleteMany({ colaboradorId: javierId });

  const movsJavier = [
    { fecha:'2025-06-27', tipo:'pago_dias',   importe:50,    concepto:'Pago día 27' },
    { fecha:'2025-06-29', tipo:'pago_dias',   importe:150,   concepto:'Pago días' },
    { fecha:'2025-07-04', tipo:'pago_dias',   importe:50,    concepto:'Pago día 4' },
    { fecha:'2025-07-05', tipo:'pago_dias',   importe:300,   concepto:'Pago semana' },
    { fecha:'2025-07-07', tipo:'adelanto',    importe:450,   concepto:'Prestado' },
    { fecha:'2025-07-11', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2025-07-14', tipo:'adelanto',    importe:100,   concepto:'Adelanto' },
    { fecha:'2025-07-16', tipo:'adelanto',    importe:20,    concepto:'Adelanto' },
    { fecha:'2025-07-18', tipo:'adelanto',    importe:150,   concepto:'Adelanto' },
    { fecha:'2025-07-22', tipo:'adelanto',    importe:170,   concepto:'Adelanto' },
    { fecha:'2025-07-29', tipo:'adelanto',    importe:200,   concepto:'Adelanto' },
    { fecha:'2025-08-01', tipo:'adelanto',    importe:200,   concepto:'Adelanto' },
    { fecha:'2025-08-06', tipo:'adelanto',    importe:550,   concepto:'Adelanto' },
    { fecha:'2025-08-10', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2025-08-11', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2025-08-12', tipo:'adelanto',    importe:100,   concepto:'Adelanto' },
    { fecha:'2025-08-20', tipo:'adelanto',    importe:250,   concepto:'Adelanto' },
    { fecha:'2025-08-22', tipo:'adelanto',    importe:150,   concepto:'Adelanto' },
    { fecha:'2025-08-29', tipo:'adelanto',    importe:450,   concepto:'Adelanto' },
    { fecha:'2025-09-05', tipo:'adelanto',    importe:150,   concepto:'Adelanto' },
    { fecha:'2025-09-10', tipo:'adelanto',    importe:100,   concepto:'Adelanto' },
    { fecha:'2025-09-11', tipo:'adelanto',    importe:200,   concepto:'Adelanto' },
    { fecha:'2025-09-16', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2025-09-19', tipo:'adelanto',    importe:200,   concepto:'Adelanto' },
    { fecha:'2025-09-23', tipo:'adelanto',    importe:100,   concepto:'Adelanto' },
    { fecha:'2025-09-26', tipo:'adelanto',    importe:150,   concepto:'Adelanto' },
    { fecha:'2025-10-01', tipo:'adelanto',    importe:30,    concepto:'Adelanto' },
    { fecha:'2025-10-04', tipo:'adelanto',    importe:200,   concepto:'Adelanto' },
    { fecha:'2025-10-07', tipo:'adelanto',    importe:30,    concepto:'Adelanto' },
    { fecha:'2025-10-09', tipo:'adelanto',    importe:20,    concepto:'Adelanto' },
    { fecha:'2025-10-10', tipo:'adelanto',    importe:300,   concepto:'Adelanto' },
    { fecha:'2025-10-14', tipo:'adelanto',    importe:100,   concepto:'Adelanto' },
    { fecha:'2025-10-17', tipo:'adelanto',    importe:150,   concepto:'Adelanto' },
    { fecha:'2025-10-19', tipo:'adelanto',    importe:20,    concepto:'Adelanto' },
    { fecha:'2025-10-21', tipo:'adelanto',    importe:130,   concepto:'Adelanto' },
    { fecha:'2025-10-23', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2025-10-24', tipo:'adelanto',    importe:20,    concepto:'Adelanto' },
    { fecha:'2025-10-27', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2025-10-29', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2025-10-31', tipo:'adelanto',    importe:100,   concepto:'Adelanto' },
    { fecha:'2025-11-01', tipo:'adelanto',    importe:100,   concepto:'Adelanto' },
    { fecha:'2025-11-06', tipo:'adelanto',    importe:100,   concepto:'Adelanto' },
    { fecha:'2025-11-11', tipo:'adelanto',    importe:100,   concepto:'Adelanto' },
    { fecha:'2025-11-11', tipo:'adelanto',    importe:80,    concepto:'Estufa' },
    { fecha:'2025-11-11', tipo:'adelanto',    importe:25,    concepto:'Gas butano' },
    { fecha:'2025-11-14', tipo:'pago_semana', importe:150,   concepto:'Pago semana 14-21 nov' },
    { fecha:'2025-11-14', tipo:'adelanto',    importe:240,   concepto:'Adelanto' },
    { fecha:'2025-11-16', tipo:'adelanto',    importe:40,    concepto:'Adelanto' },
    { fecha:'2025-11-17', tipo:'adelanto',    importe:15,    concepto:'Menú mujer' },
    { fecha:'2025-11-19', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2025-11-19', tipo:'adelanto',    importe:100,   concepto:'Estufa nueva' },
    { fecha:'2025-11-26', tipo:'adelanto',    importe:40,    concepto:'Adelanto' },
    { fecha:'2025-11-27', tipo:'adelanto',    importe:40,    concepto:'Adelanto' },
    { fecha:'2025-11-27', tipo:'adelanto',    importe:40,    concepto:'2 bombonas butano' },
    { fecha:'2025-11-27', tipo:'adelanto',    importe:100,   concepto:'Adelanto' },
    { fecha:'2025-11-28', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2025-12-01', tipo:'adelanto',    importe:250,   concepto:'Adelanto' },
    { fecha:'2025-12-03', tipo:'adelanto',    importe:15,    concepto:'Bombona butano' },
    { fecha:'2025-12-04', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2025-12-05', tipo:'pago_semana', importe:100,   concepto:'Pago semana 1-5 dic' },
    { fecha:'2025-12-07', tipo:'adelanto',    importe:30,    concepto:'Adelanto' },
    { fecha:'2025-12-10', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2025-12-12', tipo:'pago_semana', importe:200,   concepto:'Pago semana 8-12 dic' },
    { fecha:'2025-12-14', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2025-12-18', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2025-12-18', tipo:'adelanto',    importe:32,    concepto:'Bombonas butano' },
    { fecha:'2025-12-18', tipo:'pago_semana', importe:180,   concepto:'Pago semana 15-19 dic' },
    { fecha:'2025-12-20', tipo:'adelanto',    importe:100,   concepto:'Adelanto para ir a Alicante' },
    { fecha:'2026-01-07', tipo:'adelanto',    importe:45,    concepto:'Adelanto' },
    { fecha:'2026-01-10', tipo:'pago_semana', importe:50,    concepto:'Pago semana 8-9 ene' },
    { fecha:'2026-01-12', tipo:'adelanto',    importe:158,   concepto:'Adelanto' },
    { fecha:'2026-01-12', tipo:'pago_semana', importe:150,   concepto:'Pago semana 12-16 ene' },
    { fecha:'2026-01-21', tipo:'pago_dias',   importe:35,    concepto:'2 bombonas butano' },
    { fecha:'2026-01-22', tipo:'pago_dias',   importe:60,    concepto:'Domingo trabajo extra' },
    { fecha:'2026-01-23', tipo:'pago_semana', importe:250,   concepto:'Pago semana 19-23 ene' },
    { fecha:'2026-01-27', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2026-01-30', tipo:'pago_semana', importe:150,   concepto:'Pago semana 26-30 ene' },
    { fecha:'2026-02-02', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2026-02-06', tipo:'pago_semana', importe:150,   concepto:'Pago semana 2-6 feb' },
    { fecha:'2026-02-09', tipo:'adelanto',    importe:20,    concepto:'Adelanto' },
    { fecha:'2026-02-11', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2026-02-13', tipo:'pago_semana', importe:180,   concepto:'Pago semana 9-13 feb' },
    { fecha:'2026-02-17', tipo:'adelanto',    importe:70,    concepto:'Adelanto' },
    { fecha:'2026-02-18', tipo:'adelanto',    importe:30,    concepto:'Adelanto' },
    { fecha:'2026-02-20', tipo:'adelanto',    importe:10,    concepto:'Adelanto' },
    { fecha:'2026-02-20', tipo:'adelanto',    importe:20,    concepto:'Adelanto' },
    { fecha:'2026-02-20', tipo:'pago_semana', importe:100,   concepto:'Pago semana 16-20 feb' },
    { fecha:'2026-02-20', tipo:'pago_dias',   importe:20,    concepto:'Apostillar documentos' },
    { fecha:'2026-02-22', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2026-02-24', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2026-02-27', tipo:'pago_semana', importe:150,   concepto:'Pago semana 23-27 feb' },
    { fecha:'2026-02-27', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2026-03-01', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2026-03-03', tipo:'adelanto',    importe:30,    concepto:'Adelanto' },
    { fecha:'2026-03-06', tipo:'pago_semana', importe:120,   concepto:'Pago semana 2-6 mar' },
    { fecha:'2026-03-07', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2026-03-07', tipo:'adelanto',    importe:20,    concepto:'Adelanto' },
    { fecha:'2026-03-09', tipo:'adelanto',    importe:100,   concepto:'Adelanto' },
    { fecha:'2026-03-11', tipo:'adelanto',    importe:300,   concepto:'Adelanto (faltó trabajo)' },
    { fecha:'2026-03-12', tipo:'adelanto',    importe:20,    concepto:'Adelanto' },
    { fecha:'2026-03-13', tipo:'adelanto',    importe:10,    concepto:'Adelanto' },
    { fecha:'2026-03-13', tipo:'pago_semana', importe:90,    concepto:'Pago semana 9-13 mar' },
    { fecha:'2026-03-14', tipo:'pago_dias',   importe:70,    concepto:'Pago días' },
    { fecha:'2026-03-16', tipo:'adelanto',    importe:100,   concepto:'Adelanto' },
    { fecha:'2026-03-18', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2026-03-20', tipo:'pago_semana', importe:150,   concepto:'Pago semana 16-20 mar' },
    { fecha:'2026-03-23', tipo:'adelanto',    importe:100,   concepto:'Adelanto' },
    { fecha:'2026-03-25', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2026-03-27', tipo:'pago_semana', importe:100,   concepto:'Pago semana 23-27 mar' },
    { fecha:'2026-03-27', tipo:'pago_dias',   importe:80,    concepto:'Horas extras calle Creu 24' },
    { fecha:'2026-03-28', tipo:'adelanto',    importe:100,   concepto:'Adelanto' },
    { fecha:'2026-03-31', tipo:'adelanto',    importe:110,   concepto:'Adelanto' },
    { fecha:'2026-04-02', tipo:'pago_dias',   importe:50,    concepto:'Pago días' },
    { fecha:'2026-04-04', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2026-04-04', tipo:'pago_dias',   importe:60,    concepto:'Sábado 4 abril' },
    { fecha:'2026-04-05', tipo:'adelanto',    importe:30,    concepto:'Adelanto' },
    { fecha:'2026-04-07', tipo:'adelanto',    importe:100,   concepto:'Adelanto' },
    { fecha:'2026-04-09', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2026-04-10', tipo:'adelanto',    importe:150,   concepto:'Adelanto' },
    { fecha:'2026-04-12', tipo:'adelanto',    importe:60,    concepto:'Adelanto' },
    { fecha:'2026-04-14', tipo:'adelanto',    importe:100,   concepto:'Adelanto' },
    { fecha:'2026-04-16', tipo:'adelanto',    importe:25,    concepto:'Adelanto' },
    { fecha:'2026-04-16', tipo:'adelanto',    importe:50,    concepto:'Adelanto' },
    { fecha:'2026-04-17', tipo:'adelanto',    importe:300,   concepto:'Adelanto' },
    { fecha:'2026-04-18', tipo:'pago_dias',   importe:50,    concepto:'Sábado 18 abril' },
    { fecha:'2026-04-21', tipo:'adelanto',    importe:150,   concepto:'Adelanto' },
    { fecha:'2026-04-25', tipo:'pago_dias',   importe:40,    concepto:'Sábado 25 abril' },
    { fecha:'2026-04-27', tipo:'adelanto',    importe:150,   concepto:'Adelanto semana 27-1' },
    { fecha:'2026-04-30', tipo:'pago_dias',   importe:50,    concepto:'Pago restante semana' },
    { fecha:'2026-05-04', tipo:'adelanto',    importe:10,    concepto:'Adelanto' },
    { fecha:'2026-05-04', tipo:'adelanto',    importe:50,    concepto:'Adelanto semana 4-8' },
    { fecha:'2026-05-07', tipo:'adelanto',    importe:100,   concepto:'Adelanto semana 4-8' },
    { fecha:'2026-05-08', tipo:'pago_semana', importe:90,    concepto:'Pago faltante semana 4-8 may' },
    { fecha:'2026-05-08', tipo:'adelanto',    importe:60,    concepto:'Adelanto semana 11-15' },
    { fecha:'2026-05-11', tipo:'adelanto',    importe:50,    concepto:'Adelanto semana 11-15' },
    { fecha:'2026-05-12', tipo:'adelanto',    importe:50,    concepto:'Adelanto semana' },
    { fecha:'2026-05-15', tipo:'pago_semana', importe:100,   concepto:'Pago faltante semana 11-15 may' },
    { fecha:'2026-05-16', tipo:'adelanto',    importe:50,    concepto:'Adelanto semana 18-22' },
    { fecha:'2026-05-18', tipo:'adelanto',    importe:50,    concepto:'Adelanto semana 18-22' },
    { fecha:'2026-05-20', tipo:'adelanto',    importe:20,    concepto:'Adelanto' },
    { fecha:'2026-05-21', tipo:'adelanto',    importe:20,    concepto:'Adelanto' },
    { fecha:'2026-05-22', tipo:'adelanto',    importe:15,    concepto:'Adelanto' },
    { fecha:'2026-05-22', tipo:'pago_semana', importe:95,    concepto:'Pago faltante semana 18-22 may' },
    { fecha:'2026-05-26', tipo:'adelanto',    importe:100,   concepto:'Adelanto semana 25-29' },
    { fecha:'2026-05-28', tipo:'adelanto',    importe:53.15, concepto:'Adelanto semana 25-29' },
    { fecha:'2026-06-03', tipo:'adelanto',    importe:100,   concepto:'Adelanto semana 1-5 jun' },
  ];

  await db.collection('colaborador_movimientos').insertMany(
    movsJavier.map(m => ({
      ...m, colaboradorId:javierId, colaboradorNombre:'Javier',
      clienteObra:m.clienteObra||'', notas:m.notas||'',
      semanaDesde:'', semanaHasta:'', diasTrabajados:0, horasExtra:0,
      esDescuento:m.tipo==='descuento', esDevolucion:m.tipo==='devolucion',
      createdAt:new Date()
    }))
  );
  console.log(`✅ ${movsJavier.length} movimientos Javier`);

  // ── 4. PAGOS GENERALES ─────────────────────────────────────────
  console.log('\n💵 Cargando pagos generales...');
  await db.collection('pagos').deleteMany({});

  const pagosData = [
    { fecha:'2025-07-01', persona:'Luis Verticales',   tipo:'efectivo',  importe:1200,   concepto:'Trabajo verticales' },
    { fecha:'2025-07-16', persona:'Diego Campillo',    tipo:'adelanto',  importe:100,    concepto:'Adelanto descontado' },
    { fecha:'2025-07-26', persona:'Diego Campillo',    tipo:'descuento', importe:50,     concepto:'Descuento' },
    { fecha:'2025-07-26', persona:'Junior',            tipo:'efectivo',  importe:100,    concepto:'Trabajo día 26' },
    { fecha:'2025-09-02', persona:'Gastos obra',       tipo:'material',  importe:150,    concepto:'Martillo pulir suelo',              clienteObra:'Santa Eugenia' },
    { fecha:'2025-09-10', persona:'Gastos obra',       tipo:'material',  importe:30,     concepto:'Martillo' },
    { fecha:'2025-09-16', persona:'Limpieza',          tipo:'material',  importe:15,     concepto:'Fregona y material limpieza foso',  clienteObra:'Habitat Migdia' },
    { fecha:'2025-09-27', persona:'Manuel y padre',    tipo:'efectivo',  importe:350,    concepto:'Pladur Santa Eugenia sábado',       clienteObra:'Santa Eugenia' },
    { fecha:'2025-10-03', persona:'Jose Beliard',      tipo:'adelanto',  importe:600,    concepto:'Adelanto septiembre' },
    { fecha:'2025-10-07', persona:'Paco pladur',       tipo:'adelanto',  importe:70,     concepto:'Adelanto Paco pladur',              clienteObra:'Santa Eugenia' },
    { fecha:'2025-10-07', persona:'Materiales',        tipo:'material',  importe:28.80,  concepto:'Luces Illa Verda',                  clienteObra:'Illa Verda' },
    { fecha:'2025-10-10', persona:'Manuel padre',      tipo:'efectivo',  importe:670,    concepto:'Pladur piso F semana 6-10 oct',     clienteObra:'Santa Eugenia' },
    { fecha:'2025-10-21', persona:'Jose Beliard',      tipo:'adelanto',  importe:400,    concepto:'Parte sueldo octubre' },
    { fecha:'2025-10-30', persona:'Alfonso',           tipo:'efectivo',  importe:45,     concepto:'Gasóleo Alfonso' },
    { fecha:'2025-10-29', persona:'Manuel padre',      tipo:'efectivo',  importe:600,    concepto:'Pladur piso F semana 29 sep-3 oct', clienteObra:'Santa Eugenia' },
    { fecha:'2025-11-06', persona:'Jose Beliard',      tipo:'adelanto',  importe:30,     concepto:'Adelanto José' },
    { fecha:'2025-11-14', persona:'Patrocinio',        tipo:'efectivo',  importe:100,    concepto:'Patrocinio Caixa de trons' },
    { fecha:'2025-11-17', persona:'Limpieza',          tipo:'material',  importe:10,     concepto:'Productos limpieza local Manel Bonmatí 11' },
    { fecha:'2025-11-19', persona:'Conductos',         tipo:'efectivo',  importe:900,    concepto:'Conductos pisos Santa Eugenia',     clienteObra:'Santa Eugenia' },
    { fecha:'2025-11-20', persona:'Jose Beliard',      tipo:'adelanto',  importe:550,    concepto:'Parte mes noviembre' },
    { fecha:'2025-11-21', persona:'Alfonso',           tipo:'efectivo',  importe:150,    concepto:'Dinero Alfonso' },
    { fecha:'2025-11-28', persona:'Alfonso',           tipo:'efectivo',  importe:200,    concepto:'Dinero Alfonso' },
    { fecha:'2025-11-04', persona:'Transporte',        tipo:'efectivo',  importe:120,    concepto:'Transporte materiales Obramat al piso', clienteObra:'Santa Eugenia' },
    { fecha:'2025-12-04', persona:'Obramat',           tipo:'material',  importe:1000,   concepto:'Materiales baño piso Santa Eugenia', clienteObra:'Santa Eugenia' },
    { fecha:'2025-12-05', persona:'Diego Campillo',    tipo:'adelanto',  importe:300,    concepto:'Adelanto Diego' },
    { fecha:'2025-12-05', persona:'Jose Beliard',      tipo:'adelanto',  importe:600,    concepto:'Pago José cash' },
    { fecha:'2025-12-05', persona:'Bauhaus',           tipo:'material',  importe:100,    concepto:'Material Bauhaus',    referencia:'1/804/1/1222507' },
    { fecha:'2025-12-05', persona:'Leroy',             tipo:'material',  importe:50,     concepto:'Material Leroy',      referencia:'116-0012-521330' },
    { fecha:'2025-12-15', persona:'Diego Campillo',    tipo:'adelanto',  importe:50,     concepto:'Tarjeta bus Diego' },
    { fecha:'2025-12-18', persona:'Bauhaus',           tipo:'material',  importe:50,     concepto:'Factura Bauhaus',     referencia:'1/804/10/14358' },
    { fecha:'2025-12-18', persona:'Transporte',        tipo:'efectivo',  importe:70,     concepto:'Recoger bigbag Bonmati' },
    { fecha:'2025-12-18', persona:'Diego Campillo',    tipo:'adelanto',  importe:300,    concepto:'Dinero pendiente nóminas' },
    { fecha:'2025-12-19', persona:'Conductos',         tipo:'efectivo',  importe:950,    concepto:'Conductos piso Santa Eugenia',      clienteObra:'Santa Eugenia' },
    { fecha:'2025-12-22', persona:'Materiales',        tipo:'material',  importe:20,     concepto:'Materiales piso Betlem',            clienteObra:'Betlem' },
    { fecha:'2025-12-27', persona:'Obramat',           tipo:'material',  importe:359.17, concepto:'Material Obramat',    referencia:'028-0012-165236' },
    { fecha:'2025-12-29', persona:'Diego Campillo',    tipo:'efectivo',  importe:20,     concepto:'Kit destornilladores y herramientas' },
    { fecha:'2025-12-30', persona:'Diego Campillo',    tipo:'efectivo',  importe:10,     concepto:'Llave inglesa' },
    { fecha:'2025-12-30', persona:'Bauhaus',           tipo:'material',  importe:253.63, concepto:'Factura Bauhaus',     referencia:'1/804/10/14801' },
    { fecha:'2025-12-30', persona:'Leroy',             tipo:'material',  importe:8.40,   concepto:'Factura Leroy',       referencia:'116-0012-528558' },
    { fecha:'2025-12-30', persona:'Bauhaus',           tipo:'material',  importe:152,    concepto:'Factura Bauhaus',     referencia:'1/804/10/14813' },
    { fecha:'2025-12-31', persona:'Bauhaus',           tipo:'material',  importe:5.97,   concepto:'Factura Bauhaus',     referencia:'1/804/10/14861' },
    { fecha:'2025-12-31', persona:'Bauhaus',           tipo:'material',  importe:54.22,  concepto:'Factura Bauhaus',     referencia:'1/804/43/82344' },
    { fecha:'2026-01-03', persona:'Bauhaus',           tipo:'material',  importe:174.62, concepto:'Factura Bauhaus',     referencia:'1/804/10/14990' },
    { fecha:'2026-01-03', persona:'Alfonso',           tipo:'efectivo',  importe:250,    concepto:'Pago Alfonso' },
    { fecha:'2026-01-03', persona:'Nabil',             tipo:'efectivo',  importe:100,    concepto:'Pago Nabil pladur' },
    { fecha:'2026-01-05', persona:'Bauhaus',           tipo:'material',  importe:26.70,  concepto:'Factura Bauhaus',     referencia:'1/804/10/15110' },
    { fecha:'2026-01-07', persona:'Bauhaus',           tipo:'material',  importe:553.45, concepto:'Factura Bauhaus',     referencia:'1/804/9/17587' },
    { fecha:'2026-01-09', persona:'Bauhaus',           tipo:'material',  importe:593.50, concepto:'Factura Bauhaus',     referencia:'1/804/9/17655' },
    { fecha:'2026-01-09', persona:'Nabil',             tipo:'efectivo',  importe:350,    concepto:'Pago Nabil pladur' },
    { fecha:'2026-01-22', persona:'Alfonso',           tipo:'adelanto',  importe:360,    concepto:'Adelanto Alfonso' },
    { fecha:'2026-02-02', persona:'Gasolina',          tipo:'efectivo',  importe:50,     concepto:'Gasolina furgoneta' },
    { fecha:'2026-02-02', persona:'Nabil',             tipo:'adelanto',  importe:50,     concepto:'Adelanto Nabil' },
    { fecha:'2026-02-02', persona:'Jose Beliard',      tipo:'efectivo',  importe:70,     concepto:'Gasoil furgoneta Jose' },
    { fecha:'2026-02-05', persona:'Toni primo Alfonso',tipo:'efectivo',  importe:180,    concepto:'Días trabajo Toni' },
    { fecha:'2026-02-06', persona:'Nabil',             tipo:'efectivo',  importe:220,    concepto:'Pago Nabil días trabajo semana' },
    { fecha:'2026-02-06', persona:'Paula Morales',     tipo:'adelanto',  importe:500,    concepto:'Adelanto Paula' },
    { fecha:'2026-02-06', persona:'Alfonso',           tipo:'efectivo',  importe:50,     concepto:'Alfonso' },
    { fecha:'2026-02-07', persona:'Herramientas',      tipo:'material',  importe:650,    concepto:'Metabo pack 3 + robot piscina + bomba cloro + nivel láser Bultmeier' },
    { fecha:'2026-02-09', persona:'Gasolina',          tipo:'efectivo',  importe:90,     concepto:'Gasolina furgoneta Jose y Abdellah' },
    { fecha:'2026-02-12', persona:'Bauhaus',           tipo:'material',  importe:496.79, concepto:'Materiales piso 2',                 clienteObra:'Santa Eugenia' },
    { fecha:'2026-02-13', persona:'Nabil',             tipo:'efectivo',  importe:180,    concepto:'Pago Nabil horas' },
    { fecha:'2026-02-13', persona:'Ayudante Nabil',    tipo:'efectivo',  importe:100,    concepto:'Pago ayudante Nabil' },
    { fecha:'2026-02-15', persona:'Andrés pintor',     tipo:'efectivo',  importe:200,    concepto:'Pintar piso Santa Eugenia',         clienteObra:'Santa Eugenia' },
    { fecha:'2026-02-16', persona:'Nabil',             tipo:'efectivo',  importe:80,     concepto:'1 día trabajo Nabil' },
    { fecha:'2026-02-19', persona:'Materiales',        tipo:'material',  importe:20,     concepto:'2 llaves portal Santa Eugenia 94',  clienteObra:'Santa Eugenia' },
    { fecha:'2026-02-19', persona:'Jose Beliard',      tipo:'efectivo',  importe:300,    concepto:'Dinero Jose Beliard' },
    { fecha:'2026-02-20', persona:'Nabil',             tipo:'efectivo',  importe:300,    concepto:'Pago Nabil' },
    { fecha:'2026-02-20', persona:'Ayudante Nabil',    tipo:'efectivo',  importe:150,    concepto:'Ayudante Nabil' },
    { fecha:'2026-02-25', persona:'Bauhaus',           tipo:'material',  importe:25,     concepto:'Masilla pisos Girona' },
    { fecha:'2026-02-25', persona:'Materiales',        tipo:'material',  importe:20,     concepto:'Borada piso Madrenas',              clienteObra:'Madrenas' },
    { fecha:'2026-03-25', persona:'Diego Campillo',    tipo:'adelanto',  importe:20,     concepto:'Adelanto Diego' },
    { fecha:'2026-03-26', persona:'Diego Campillo',    tipo:'adelanto',  importe:20,     concepto:'Adelanto Diego' },
    { fecha:'2026-04-04', persona:'Andrés pintor',     tipo:'efectivo',  importe:220,    concepto:'3 días piso Santa Eugenia',         clienteObra:'Santa Eugenia' },
    { fecha:'2026-04-13', persona:'Materiales',        tipo:'material',  importe:150,    concepto:'Tubo Joan Bosh inox gárgolas' },
    { fecha:'2026-04-16', persona:'Diego Campillo',    tipo:'adelanto',  importe:50,     concepto:'Adelanto Diego' },
    { fecha:'2026-04-20', persona:'Reparación',        tipo:'efectivo',  importe:350,    concepto:'Reparación Fiat Doblò y copias llave' },
    { fecha:'2026-05-11', persona:'Carlos pintor',     tipo:'efectivo',  importe:420,    concepto:'Horas abril Carlos pintor' },
    { fecha:'2026-05-13', persona:'Leo',               tipo:'efectivo',  importe:150,    concepto:'Vaciado piso y runas 3 días' },
    { fecha:'2026-05-13', persona:'Luis Verticales',   tipo:'efectivo',  importe:400,    concepto:'Trabajo Trav la Creu' },
    { fecha:'2026-05-16', persona:'Carlos pintor',     tipo:'efectivo',  importe:135,    concepto:'Dinero hermano Carlos pintor' },
    // Ingresos cash
    { fecha:'2025-07-14', persona:'Devolución',        tipo:'ingreso',   importe:600,    concepto:'Devolución' },
    { fecha:'2025-07-01', persona:'Devolución',        tipo:'ingreso',   importe:500,    concepto:'Devolución' },
    { fecha:'2025-07-01', persona:'Devolución',        tipo:'ingreso',   importe:660,    concepto:'Devolución' },
    { fecha:'2025-07-01', persona:'Juan AC',           tipo:'ingreso',   importe:3630,   concepto:'Dinero aire acondicionado Juan' },
    { fecha:'2026-01-03', persona:'Betlem',            tipo:'ingreso',   importe:1410,   concepto:'Pago demolición paredes',           clienteObra:'Betlem' },
    { fecha:'2026-02-15', persona:'Aura',              tipo:'ingreso',   importe:2700,   concepto:'Pago provisional obra Aura',        clienteObra:'Aura' },
    { fecha:'2026-02-20', persona:'Juanma Madrenas',   tipo:'ingreso',   importe:500,    concepto:'Pago herramientas Juanma' },
    { fecha:'2026-02-25', persona:'Betlem',            tipo:'ingreso',   importe:1085,   concepto:'Pago mecanismos',                   clienteObra:'Betlem' },
    { fecha:'2026-02-26', persona:'Betlem',            tipo:'ingreso',   importe:2360,   concepto:'Pago cash',                         clienteObra:'Betlem' },
    { fecha:'2026-02-06', persona:'Paula Morales',     tipo:'devolucion',importe:500,    concepto:'Paula devuelve adelanto' },
    { fecha:'2026-02-20', persona:'Alex',              tipo:'ingreso',   importe:250,    concepto:'Reparto Juanma' },
    { fecha:'2026-02-20', persona:'Alfonso',           tipo:'ingreso',   importe:250,    concepto:'Reparto Juanma' },
    { fecha:'2026-02-26', persona:'Alex',              tipo:'ingreso',   importe:540,    concepto:'Reparto Betlem',                    clienteObra:'Betlem' },
    { fecha:'2026-02-26', persona:'Alfonso',           tipo:'ingreso',   importe:545,    concepto:'Reparto Betlem',                    clienteObra:'Betlem' },
    { fecha:'2026-05-15', persona:'Alfonso',           tipo:'ingreso',   importe:1350,   concepto:'Dinero Aura',                       clienteObra:'Aura' },
    { fecha:'2026-05-15', persona:'Alex',              tipo:'ingreso',   importe:1350,   concepto:'Dinero Aura',                       clienteObra:'Aura' },
  ];

  await db.collection('pagos').insertMany(
    pagosData.map(p => ({
      ...p,
      referencia: p.referencia||'',
      clienteObra: p.clienteObra||'',
      notas: '', diasTrabajados:0, costeHoraReal:0,
      registradoPor:'admin', createdAt:new Date(), updatedAt:new Date()
    }))
  );
  console.log(`✅ ${pagosData.length} pagos generales + ingresos`);

  // ── 5. PROYECTO SANTA EUGENIA ─────────────────────────────────
  console.log('\n🏠 Creando proyecto Santa Eugenia...');
  await db.collection('proyectos_inversion').deleteMany({});
  await db.collection('proyecto_movimientos').deleteMany({});

  const proyResult = await db.collection('proyectos_inversion').insertOne({
    nombre:'Piso Santa Eugenia', tipo:'inmobiliario', estado:'en_curso',
    descripcion:'Local 480m² convertido en 4 pisos. Corp Projects se queda 1 piso a cambio de reforma.',
    fechaInicio:'2025-01-01', precioVentaPactado:368000,
    notas:'Venta casi pactada a 368.000€. Pendiente cierre definitivo.',
    createdAt:new Date(), updatedAt:new Date()
  });
  const proyId = String(proyResult.insertedId);

  const movsProyecto = [
    { fecha:'2025-02-18', tipo:'gasto',   concepto:'Montse arquitecta — pago inicial',       importe:15000,  formaPago:'efectivo', importeCash:15000,  importeBanco:0 },
    { fecha:'2026-05-13', tipo:'gasto',   concepto:'Montse arquitecta — pago final',          importe:13000,  formaPago:'efectivo', importeCash:13000,  importeBanco:0 },
    { fecha:'2025-01-01', tipo:'gasto',   concepto:'Manel — intermediación operativa',        importe:4000,   formaPago:'efectivo', importeCash:4000,   importeBanco:0 },
    { fecha:'2025-02-18', tipo:'ingreso', concepto:'Promoservice — dinero prestado',          importe:12000,  formaPago:'banco',    importeCash:0,      importeBanco:12000 },
    { fecha:'2025-11-19', tipo:'gasto',   concepto:'Conductos Santa Eugenia (1ª parte)',      importe:900,    formaPago:'efectivo', importeCash:900,    importeBanco:0 },
    { fecha:'2025-12-19', tipo:'gasto',   concepto:'Conductos piso Santa Eugenia (2ª parte)', importe:950,    formaPago:'efectivo', importeCash:950,    importeBanco:0 },
    { fecha:'2025-10-10', tipo:'gasto',   concepto:'Manuel padre — pladur piso F sem 6-10 oct', importe:670,  formaPago:'efectivo', importeCash:670,    importeBanco:0 },
    { fecha:'2025-10-29', tipo:'gasto',   concepto:'Manuel padre — pladur piso F sem 29sep-3oct', importe:600, formaPago:'efectivo', importeCash:600,   importeBanco:0 },
    { fecha:'2025-12-04', tipo:'gasto',   concepto:'Obramat — materiales baño',               importe:1000,   formaPago:'efectivo', importeCash:1000,   importeBanco:0, referencia:'028-0012-165236' },
    { fecha:'2026-02-12', tipo:'gasto',   concepto:'Bauhaus — materiales piso 2',             importe:496.79, formaPago:'efectivo', importeCash:496.79, importeBanco:0 },
  ];

  await db.collection('proyecto_movimientos').insertMany(
    movsProyecto.map(m => ({ ...m, proyectoId:proyId, notas:'', referencia:m.referencia||'', createdAt:new Date() }))
  );

  const totalInv = movsProyecto.filter(m=>m.tipo==='gasto').reduce((s,m)=>s+m.importe,0);
  console.log(`✅ Proyecto Santa Eugenia — invertido: ${totalInv.toLocaleString('es-ES')}€ | precio venta: 368.000€ | beneficio est: ${(368000-totalInv).toLocaleString('es-ES')}€`);

  // ── RESUMEN ───────────────────────────────────────────────────
  const totalMovCol = await db.collection('colaborador_movimientos').countDocuments();
  const totalPagos  = await db.collection('pagos').countDocuments();
  console.log('\n═══════════════════════════════════════');
  console.log('✅ CARGA COMPLETADA');
  console.log(`👷 Colaboradores: ${colaboradoresData.length}`);
  console.log(`💰 Movimientos colaboradores: ${totalMovCol}`);
  console.log(`💵 Pagos generales + ingresos: ${totalPagos}`);
  console.log(`🏠 Proyecto Santa Eugenia creado`);
  console.log('═══════════════════════════════════════');

  await client.close();
}

main().catch(err => { console.error('❌ Error:', err.message); process.exit(1); });
