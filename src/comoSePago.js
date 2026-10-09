// src/comoSePago.js — «🔍 ¿Cómo se pagó?» para una factura de proveedor sin pago localizado (9/10/2026).
// Junta en una respuesta lo que hace falta para entender por qué no casa:
//   1. Movimientos de banco y tarjetas de esos días con el mismo importe, y si ya están casados con otra factura.
//   2. Qué tarjetas y cuentas tienen movimientos cargados en esa fecha (si falta un extracto, se dice).
//   3. Lo que pone el propio documento (la IA lo lee al pulsar, solo esa vez, y se guarda): tarjeta …1234, efectivo…
//   4. Una conclusión en una frase y, si hay un pago libre que cuadra, la opción de casarlo.
'use strict';
const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const iso = t => new Date(t).toISOString().slice(0, 10);
const DIA = 86400000;

// La IA lee SOLO la forma de pago del documento (ticket o factura).
async function leerPago(compraId) {
  const db = await getDB();
  const c = await db.collection('compras').findOne({ _id: new ObjectId(String(compraId)) }, { projection: { pagoLeido: 1 } });
  if (c && c.pagoLeido) return c.pagoLeido;
  const compras = require('./compras');
  const fotos = await compras.fotosDe(compraId);
  if (!fotos.length) return null;
  const key = process.env.ANTHROPIC_API_KEY; if (!key) return null;
  const content = fotos.slice(0, 2).map(f => {
    const buf = f.data && f.data.buffer ? Buffer.from(f.data.buffer) : f.data;
    const b64 = Buffer.isBuffer(buf) ? buf.toString('base64') : String(buf);
    return /pdf/i.test(f.mimetype || '') ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } } : { type: 'image', source: { type: 'base64', media_type: f.mimetype || 'image/jpeg', data: b64 } };
  });
  const tool = { name: 'forma_de_pago', description: 'Cómo se pagó este ticket o factura, según lo que pone el documento', input_schema: { type: 'object', properties: {
    forma: { type: 'string', enum: ['tarjeta', 'efectivo', 'transferencia', 'recibo', 'a_cuenta', 'no_lo_pone'] },
    tarjeta: { type: 'string', description: 'Últimos 4 dígitos de la tarjeta si aparecen (p. ej. ************6439 → 6439)' },
    texto: { type: 'string', description: 'El texto literal del documento sobre el pago (máx. 120 caracteres)' },
  }, required: ['forma'] } };
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 45000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: require('./config').ia.vision, max_tokens: 400, tools: [tool], tool_choice: { type: 'tool', name: tool.name },
        messages: [{ role: 'user', content: [...content, { type: 'text', text: 'Mira solo cómo se pagó: forma de pago, y si es con tarjeta sus últimos 4 dígitos (suelen salir como ****1234 o XXXX1234). Si no lo pone, «no_lo_pone».' }] }] }),
    }).finally(() => clearTimeout(t));
    const d = await r.json();
    const tu = (d.content || []).find(b => b.type === 'tool_use');
    if (!tu) return null;
    const out = { forma: tu.input.forma, tarjeta: String(tu.input.tarjeta || '').replace(/\D/g, '').slice(-4) || null, texto: String(tu.input.texto || '').slice(0, 160), at: new Date() };
    await db.collection('compras').updateOne({ _id: new ObjectId(String(compraId)) }, { $set: { pagoLeido: out } });
    return out;
  } catch (e) { console.warn('[ComoSePago] IA:', e.message); return null; }
}

async function investigar({ compraId, numero, proveedor, fecha, total }) {
  const db = await getDB();
  const T = require('./trimestre');
  const imp = Math.abs(Number(total) || 0);
  if (!fecha || !imp) throw new Error('Falta la fecha o el importe de la factura');
  const d0 = iso(new Date(fecha).getTime() - 7 * DIA), d1 = iso(new Date(fecha).getTime() + 10 * DIA);
  const tol = Math.max(0.05, imp * 0.005);
  const [bm, tm, ts, cuentasBanco, mapa, pago] = await Promise.all([
    db.collection('bancoMovimientos').find({ fechaOperacion: { $gte: d0, $lte: d1 }, importe: { $lt: 0 } }).project({ fechaOperacion: 1, importe: 1, concepto: 1, iban: 1 }).toArray(),
    db.collection('tarjetaMovimientos').find({ fecha: { $gte: d0, $lte: d1 }, importe: { $lt: 0 } }).project({ fecha: 1, importe: 1, concepto: 1, tarjeta: 1, fuente: 1, estado: 1 }).toArray(),
    require('./tarjetas').listaTarjetas().catch(() => []),
    db.collection('bancoMovimientos').aggregate([{ $group: { _id: '$iban', desde: { $min: '$fechaOperacion' }, hasta: { $max: '$fechaOperacion' } } }]).toArray(),
    T.mapaPagos().catch(() => null),
    compraId ? leerPago(compraId).catch(() => null) : null,
  ]);
  const usado = id => { const f = mapa && mapa.porMov.get(String(id)); return f && f.estado === 'punteado' ? (f.docs || []).map(x => x.ref).filter(Boolean).join(', ') || 'otra factura' : f && f.estado === 'no_requiere' ? (f.nota || 'marcado sin factura') : null; };
  const persona = Object.fromEntries((ts || []).map(t => [String(t.last4 || t._id), t.persona]));
  const cands = [
    ...bm.map(m => ({ id: String(m._id), fecha: m.fechaOperacion, importe: r2(m.importe), concepto: m.concepto, origen: `Santander …${String(m.iban || '').slice(-4)}` })),
    ...tm.filter(m => !/declined|reverted|failed/i.test(m.estado || '')).map(m => ({ id: String(m._id), fecha: m.fecha, importe: r2(m.importe), concepto: m.concepto, origen: `${m.fuente === 'revolut' ? 'Revolut' : 'Crédito'} …${m.tarjeta || ''}${persona[m.tarjeta] ? ' (' + persona[m.tarjeta] + ')' : ''}`, tarjeta: m.tarjeta || null })),
  ].filter(m => Math.abs(Math.abs(m.importe) - imp) <= tol).map(m => ({ ...m, casadoCon: usado(m.id) }))
    .sort((a, b) => Math.abs(new Date(a.fecha) - new Date(fecha)) - Math.abs(new Date(b.fecha) - new Date(fecha)));
  // Cobertura: qué tarjetas/cuentas tienen movimientos ese día.
  const cubre = (desde, hasta) => !!(desde && hasta && desde <= fecha && hasta >= fecha);
  const tarjetas = (ts || []).filter(t => t.nMovimientos || t.persona).map(t => ({ tarjeta: String(t.last4 || t._id), banco: t.banco, persona: t.persona || null, desde: t.desde, hasta: t.hasta, nMovimientos: t.nMovimientos || 0, cubre: cubre(t.desde, t.hasta) }));
  const cuentas = cuentasBanco.filter(c => c._id).map(c => ({ cuenta: String(c._id).slice(-4), desde: c.desde, hasta: c.hasta, cubre: cubre(c.desde, c.hasta) }));
  // Conclusión
  const libres = cands.filter(c => !c.casadoCon);
  let conclusion;
  const tarjLeida = pago && pago.tarjeta ? tarjetas.find(t => t.tarjeta === pago.tarjeta) : null;
  if (libres.length === 1) conclusion = `Se pagó casi seguro con ${libres[0].origen} el ${libres[0].fecha.split('-').reverse().join('/')} (${Math.abs(libres[0].importe).toFixed(2).replace('.', ',')} €) y no se había casado: puedes casarlo aquí.`;
  else if (libres.length > 1) conclusion = `Hay ${libres.length} pagos libres con ese importe esos días: elige cuál es.`;
  else if (pago && pago.forma === 'efectivo') conclusion = 'El documento dice que se pagó en EFECTIVO: no saldrá en el banco. Márcalo como pagado en efectivo en el cierre del trimestre.';
  else if (pago && pago.tarjeta && (!tarjLeida || !tarjLeida.cubre)) conclusion = `Se pagó con la tarjeta …${pago.tarjeta}${tarjLeida && tarjLeida.persona ? ' (' + tarjLeida.persona + ')' : ''} y ${tarjLeida ? `solo hay movimientos suyos cargados del ${String(tarjLeida.desde).split('-').reverse().join('/')} al ${String(tarjLeida.hasta).split('-').reverse().join('/')}` : 'esa tarjeta no está dada de alta'}: sube su extracto en Cierre del trimestre y se casará sola.`;
  else if (cands.length) conclusion = `El pago con ese importe ya está casado con ${cands[0].casadoCon}. Puede que se pagaran dos compras iguales, o que esté casado con la factura equivocada.`;
  else {
    const sinCubrir = tarjetas.filter(t => !t.cubre && /cr[eé]dito|revolut/i.test(t.banco || '') && !/no se usa|pruebas/i.test(t.persona || '')).map(t => '…' + t.tarjeta + (t.persona ? ' (' + t.persona + ')' : ''));
    conclusion = `No hay ningún pago de ese importe esos días${sinCubrir.length ? `. Faltan movimientos de ${sinCubrir.join(', ')} en esa fecha: puede ser una de esas` : ''}. Puede haberse pagado junto con otra compra (un solo cobro de varias facturas), en efectivo o con una tarjeta personal.`;
  }
  return { factura: { numero, proveedor, fecha, total: r2(total) }, pago, candidatos: cands.slice(0, 8), tarjetas, cuentas, conclusion, puedeCasar: !!compraId };
}

async function casar(movId, compraId, por) {
  return require('./trimestre').enlazarCompra(movId, compraId, por);
}

module.exports = { investigar, casar, leerPago };
