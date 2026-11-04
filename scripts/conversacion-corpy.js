// scripts/conversacion-corpy.js — SOLO LEE: la conversación de un número con Corpy (whatsappLog) desde una hora.
// Uso: railway run node scripts/conversacion-corpy.js [+34648536489] [2026-11-04T12:00] > conversacion.txt
'use strict';
const { MongoClient } = require('mongodb');
(async () => {
  const numero = process.argv[2] || '+34648536489';
  const desde = new Date(process.argv[3] || new Date().toISOString().slice(0, 10) + 'T10:00');
  const c = await MongoClient.connect(process.env.MONGODB_URI);
  const db = c.db('corpprojects');
  const l = await db.collection('whatsappLog').find({ numero, ts: { $gte: desde } }).sort({ ts: 1 }).toArray();
  for (const m of l) {
    const h = m.ts.toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const med = (m.media || []).map(x => `[${x.type || 'archivo'}${x.name ? ' ' + x.name : ''}]`).join(' ');
    console.log(`${h} ${m.dir === 'in' ? 'ÁLEX ' : 'CORPY'} ${med} ${String(m.texto || '').replace(/\n/g, '\n               ')}\n`);
  }
  const t = await db.collection('ticketAvisos').find({ primeroAt: { $gte: new Date(Date.now() - 3 * 864e5) } }).project({ persona: 1, comercio: 1, importe: 1, fecha: 1, compraId: 1, respuesta: 1 }).toArray();
  console.log('--- Tickets pedidos (3 días) ---');
  for (const x of t) console.log(`${x.fecha} ${x.persona} · ${x.comercio} · ${x.importe} → ${x.compraId ? 'compra ' + x.compraId : x.respuesta || 'falta'}`);
  await c.close();
})().catch(e => { console.error(e.message); process.exit(1); });
