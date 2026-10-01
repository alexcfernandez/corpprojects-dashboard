// scripts/recuperar-facturas-correo.js — Mete en Compras («archivo») las facturas de proveedor que llegaron
// al correo antes del 23/9/2026, para que el cierre del trimestre las cruce con el banco.
//   railway run node scripts/recuperar-facturas-correo.js 2026-07-01 2026-09-23            → simulación
//   railway run node scripts/recuperar-facturas-correo.js 2026-07-01 2026-09-23 --aplicar  → lo hace
const [desde, hasta] = process.argv.slice(2).filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
(async () => {
  const r = await require('../src/email-intelligence').recuperarFacturasCorreo({ desde, hasta, dryRun: !process.argv.includes('--aplicar') });
  for (const h of r.hechos) console.log(new Date(h.fecha).toISOString().slice(0, 10), '|', String(h.asunto).slice(0, 60), '|', h.nada || h.error || (r.dryRun ? `${h.documentos} documento(s)` : `${h.compras} compra(s)`));
  console.log(`${r.total} correos${r.dryRun ? ' (simulación: añade --aplicar)' : ''}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
