const { MongoClient } = require('mongodb');
async function main() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db('corpprojects');

  const fumon = await db.collection('colaboradores').insertOne({
    nombre: 'David fumón', alias: 'David fumón', oficio: 'Operario',
    tipoTarifa: 'hora', tarifaHora: 15, tarifaDia: 120, tarifaSemana: 600,
    diasSemanales: 5, horasDia: 8, activo: false, fechaAlta: '2025-07-01',
    notas: 'Ya no trabaja', createdAt: new Date(), updatedAt: new Date(),
  });
  const fumonId = String(fumon.insertedId);

  const david = await db.collection('colaboradores').findOne({ nombre: 'David Taladros' });
  const davidId = String(david._id);

  const fechas = ['2025-07-01','2025-07-01','2025-07-19','2025-07-23','2025-07-26','2025-08-07','2025-08-11'];
  const importes = [500, 50, 50, 500, 450, 160, 500];

  for (let i = 0; i < fechas.length; i++) {
    const mov = await db.collection('colaborador_movimientos').findOne({ colaboradorId: davidId, fecha: fechas[i], importe: importes[i] });
    if (mov) {
      await db.collection('colaborador_movimientos').updateOne({ _id: mov._id }, { $set: { colaboradorId: fumonId, colaboradorNombre: 'David fumón' } });
    }
  }
  console.log('Listo');
  await client.close();
}
main().catch(console.error);
