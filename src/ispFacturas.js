// Facturas emitidas SIN IVA: tienen que llevar escrita la inversión del sujeto pasivo (lo pidió Rubén, de Som Assessors,
// el 15/10/2026 al cerrar el 3T). Cada mañana se miran las facturas nuevas del trimestre en curso:
//   · al 0 % a una sociedad (CIF A/B…) y sin la frase → se le añade en Observaciones (StelOrder deja tocar los
//     comentarios aunque esté cobrada) y se avisa;
//   · al 0 % a una comunidad (NIF H), a un particular o sin NIF → NO se toca: o le falta el IVA o hay algo raro
//     (pasó con la FAC00934, que acabó en rectificativa). Se avisa para que alguien la mire.
// Solo desde DESDE: los trimestres ya presentados no se tocan. Cada factura se mira una sola vez (colección `ispFacturas`).

const DESDE = '2026-10-01';
const MENCION = 'Operación con inversión del sujeto pasivo (art. 84.Uno.2º.f de la Ley 37/1992 del IVA).';
const TIENE = /sujeto pasivo|subjecte passiu|84\.?\s*uno/i;
const SOCIEDAD = /^[ABCDEFGJNPQRSUVW]\d/i; // CIF de persona jurídica (no H = comunidad, no DNI/NIE)

const eur = n => (Math.round(n * 100) / 100).toLocaleString('es-ES', { minimumFractionDigits: 2 }) + ' €';
const dm = f => String(f || '').slice(0, 10).split('-').reverse().join('/');
const limpiaNif = s => String(s || '').replace(/[\s.\-]/g, '').toUpperCase();

// Qué hacer con una factura (puro, para los tests).
function decidir(f, nif, comentarios) {
  if (TIENE.test(comentarios || '')) return 'ya_lleva';
  const n = limpiaNif(nif);
  if (SOCIEDAD.test(n)) return 'anadir';
  return 'revisar';
}

async function revisar({ dryRun = false, _d = {} } = {}) {
  const S = _d.stel || require('./stelorder');
  if (!_d.stel && (S.enPausa() || S.cupoAgotado())) return { saltado: 'StelOrder en pausa' };
  const db = _d.db || await require('./db').getDB();
  const col = db.collection('ispFacturas');
  const mapa = await S.getAllOrdinaryInvoices();
  const cands = Object.entries(mapa).map(([id, f]) => ({ id, ...f }))
    .filter(f => String(f.date || '').slice(0, 10) >= DESDE && Number(f.total) > 0 && Math.abs(Number(f.iva) || 0) < 0.01);
  if (!cands.length) return { revisadas: 0, anadidas: [], revisar: [] };
  const vistas = new Set((await col.find({ id: { $in: cands.map(f => f.id) } }).project({ id: 1 }).toArray()).map(x => x.id));
  const nuevas = cands.filter(f => !vistas.has(f.id));
  if (!nuevas.length) return { revisadas: 0, anadidas: [], revisar: [] };
  const { clients } = await S.getClients();
  const cli = Object.fromEntries((clients || []).map(c => [String(c.id), c]));
  const anadidas = [], revisar = [];
  for (const f of nuevas) {
    const c = cli[f.accountId] || {};
    const nombre = c['legal-name'] || c.name || '¿?';
    let raw = (await S._client.get(`/ordinaryInvoices/${f.id}`, { timeout: 25000 })).data;
    raw = Array.isArray(raw) ? raw[0] : raw;
    const que = decidir(f, c['tax-identification-number'], raw && raw.comments);
    const fila = { id: f.id, numero: f.number, fecha: String(f.date).slice(0, 10), cliente: nombre, nif: c['tax-identification-number'] || null, total: f.total, que, at: new Date() };
    if (que === 'anadir' && !dryRun) {
      const comments = (raw.comments ? String(raw.comments).trim() + '\n\n' : '') + MENCION;
      try { await S._client.put(`/ordinaryInvoices/${f.id}`, { ...raw, comments }, { timeout: 25000 }); }
      catch (e) {
        // Cobrada: StelOrder solo deja cambiar comentarios, título y anexo → se manda solo el comentario.
        if (!/E000143/.test(JSON.stringify((e.response && e.response.data) || ''))) throw e;
        await S._client.put(`/ordinaryInvoices/${f.id}`, { comments }, { timeout: 25000 });
      }
      try { S.invalidate('ordinaryInvoices'); } catch (e) {}
    }
    if (que === 'anadir') anadidas.push(fila); else if (que === 'revisar') revisar.push(fila);
    if (!dryRun) await col.updateOne({ id: f.id }, { $set: fila }, { upsert: true });
  }
  const lineas = [];
  if (anadidas.length) lineas.push(`Facturas sin IVA a empresas: les he puesto la inversión del sujeto pasivo en Observaciones:\n` + anadidas.map(x => `• ${x.numero} (${dm(x.fecha)}) · ${x.cliente} · ${eur(x.total)}`).join('\n'));
  if (revisar.length) lineas.push(`*Revisa estas facturas sin IVA*: el cliente no es una empresa (comunidad, particular o sin NIF), así que no puede ir con inversión del sujeto pasivo. O les falta el IVA o hay que rectificarlas:\n` + revisar.map(x => `• ${x.numero} (${dm(x.fecha)}) · ${x.cliente}${x.nif ? ` (${x.nif})` : ' (sin NIF)'} · ${eur(x.total)}`).join('\n'));
  if (lineas.length && !dryRun) {
    const enviar = _d.enviar || (async (to, t) => require('./notifications').sendWhatsAppTo(to, t));
    const dest = String(process.env.BANCO_AVISOS_TO || process.env.FICHAJE_AVISOS_TO || process.env.WHATSAPP_TO || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const to of dest) { try { await enviar(to, lineas.join('\n\n')); } catch (e) { console.warn('[ISP]', e.message); } }
  }
  return { revisadas: nuevas.length, anadidas, revisar, texto: lineas.join('\n\n') };
}

module.exports = { revisar, decidir, MENCION, DESDE };
