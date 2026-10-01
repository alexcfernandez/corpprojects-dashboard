// scripts/reparar-importes-x100.js — Repara compras cuyo importe se guardó ×10/×100 al editar
// (fallo de n2: «399.78» → 39978, corregido el 1 oct 2026).
// Para cada compra sospechosa busca el divisor (1, 10 o 100) de base, IVA y total que cumple base + IVA = total,
// y el de cada línea para que sumen la base. Guarda los valores anteriores en `reparacionX100`.
//   node scripts/reparar-importes-x100.js          → solo enseña lo que haría
//   node scripts/reparar-importes-x100.js --aplicar → lo guarda
const { getDB } = require('../src/db');
const r2 = n => Math.round(n * 100) / 100;
// El fallo quitaba el punto decimal: un importe afectado queda ENTERO y era el original ×10 o ×100.
// Con decimales no está afectado. Se prueba primero el divisor mayor (el importe más pequeño posible).
const opciones = v => (v == null ? [null] : Number.isInteger(v) && v !== 0 ? [r2(v / 100), r2(v / 10), v] : [v]);

// ¿El IVA es el 21, 10, 4 o 0 % de la base (con redondeo)?
const ivaCuadra = (B, I) => [0.21, 0.10, 0.04, 0].some(t => Math.abs(B * t - I) <= 0.06);   // céntimos de redondeo por línea
const coherente = (T, B, I) => Math.abs(B + I - T) < 0.02 && ivaCuadra(B, I);

function arreglar(c) {
  if (![c.total, c.base, c.iva].some(v => Number.isInteger(v) && Math.abs(v) >= 10)) return null;
  const conDesglose = c.base != null && c.iva != null && !(c.base === 0 && c.iva === 0);
  if (conDesglose) {
    if (coherente(c.total, c.base, c.iva)) return null;             // tal cual ya cuadra: no está afectada
    for (const T of opciones(c.total)) for (const B of opciones(c.base)) for (const I of opciones(c.iva))
      if (coherente(T, B, I)) return { total: T, base: B, iva: I };
    return null;
  }
  // Sin desglose (avisos de cargo): si el documento lista su propio total como línea, todo va ×100.
  if (Number.isInteger(c.total) && Math.abs(c.total) >= 100 && (c.lineas || []).some(l => l.importe === c.total))
    return { total: r2(c.total / 100), base: c.base, iva: c.iva, lineasX100: true };
  return null;
}
// Líneas: el divisor de cada una (mayor primero) para que sumen la base (o el total).
function lineas(ls, base, total) {
  if (!Array.isArray(ls) || !ls.length) return { ls, ok: true };
  const objetivos = [base, total].filter(x => x != null && x !== 0);
  // 1º el mismo divisor para todas (lo normal), contra la base o el total (tickets con IVA incluido)
  for (const d of [100, 10]) for (const obj of objetivos) {
    const u = ls.map(l => (Number.isInteger(l.importe) ? r2(l.importe / d) : l.importe));
    if (Math.abs(u.reduce((a, x) => a + (x || 0), 0) - obj) < 0.03) return { ls: ls.map((l, i) => ({ ...l, importe: u[i] })), ok: true };
  }
  objetivos.splice(1);   // 2º divisores distintos por línea, solo contra la base
  const op = ls.map(l => opciones(l.importe));
  const max = []; const min = [];
  for (let i = op.length - 1; i >= 0; i--) { const vs = op[i].map(x => x || 0); max[i] = (max[i + 1] || 0) + Math.max(...vs); min[i] = (min[i + 1] || 0) + Math.min(...vs); }
  for (const obj of objetivos) {
    let sol = null, pasos = 0;
    (function rec(i, s, acc) {
      if (sol || ++pasos > 2e6) return;
      if (i === op.length) { if (Math.abs(s - obj) < 0.02) sol = acc.slice(); return; }
      if (s + max[i] < obj - 0.02 || s + min[i] > obj + 0.02) return;
      for (const v of op[i]) { acc.push(v); rec(i + 1, s + (v || 0), acc); acc.pop(); }
    })(0, 0, []);
    if (sol) return { ls: ls.map((l, i) => ({ ...l, importe: sol[i] })), ok: true };
  }
  return { ls, ok: false };
}

(async () => {
  const aplicar = process.argv.includes('--aplicar');
  const db = await getDB();
  const cs = await db.collection('compras').find({ estado: { $ne: 'descartada' }, reparacionX100: { $exists: false } }).project({ fotos: 0 }).toArray();
  for (const c of cs) {
    let nuevo = arreglar(c);
    if (!nuevo) continue;
    let L;
    if (nuevo.lineasX100) { L = { ok: true, ls: (c.lineas || []).map(l => ({ ...l, importe: Number.isInteger(l.importe) ? r2(l.importe / 100) : l.importe })) }; delete nuevo.lineasX100; }
    else L = lineas(c.lineas, nuevo.base, nuevo.total);
    const ls = L.ls;
    console.log('✓', c.proveedor, c.numero, `total ${c.total} → ${nuevo.total}`, `base ${c.base} → ${nuevo.base}`, `iva ${c.iva} → ${nuevo.iva}`, '| líneas', (c.lineas || []).map(l => l.importe).join(','), '→', (ls || []).map(l => l.importe).join(','), L.ok ? '' : '(LÍNEAS SIN TOCAR: no suman la base, revisar a mano)');
    if (aplicar) await db.collection('compras').updateOne({ _id: c._id }, { $set: { ...nuevo, lineas: ls, reparacionX100: { at: new Date(), antes: { total: c.total, base: c.base, iva: c.iva, lineas: c.lineas } } } });
  }
  console.log(aplicar ? 'Aplicado.' : 'Simulación: añade --aplicar para guardarlo.');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
