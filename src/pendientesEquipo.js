// src/pendientesEquipo.js — LO QUE FALTA DEL EQUIPO (12/10/2026): para que a Álex se le recuerde todo y no se atasque.
//   · resumen(): por trabajador (papeles del alta, reconocimiento, PRL, curso de oficio, EPIs firmados, contrato, tallas),
//     las obras de contratista con documentación pendiente (Seranco…) y los encargos abiertos. Cada lunes a las 8:30 le
//     llega por WhatsApp y Corpy lo dice cuando se le pregunta «¿qué falta?».
//   · EPIs: compraEpis() = la lista de compra con la talla de cada uno (de las que no tienen la entrega firmada);
//     entregarEpis() = tras repartirlos, pide a cada uno que firme la entrega en su app (con sus tallas).
'use strict';
const NOM = { dni: 'DNI/NIE', alta_ss: 'alta SS', reconocimiento: 'reconocimiento médico', formacion_prl: 'formación PRL', formacion_oficio: 'curso 20 h', epis: 'EPIs firmados', contrato: 'contrato' };

async function resumen() {
  const P = require('./personalDocs');
  const [res, tallas, enc, obras] = await Promise.all([
    P.resumen(), require('./fichaDatos').todas().catch(() => []), require('./encargos').lista().catch(() => []),
    Promise.race([require('./docsObra').pendientes(), new Promise(r => setTimeout(() => r([]), 8000))]).catch(() => []),
  ]);
  const activos = new Set(tallas.map(t => t.id));
  const personas = res.trabajadores.filter(w => activos.has(String(w.id))).map(w => {
    const r = w.requisitos || {};
    const faltan = Object.keys(NOM).filter(k => r[k] && r[k].estado !== 'ok' && r[k].estado !== 'pronto').map(k => NOM[k] + (r[k].estado === 'caducado' ? ' (caducado)' : ''));
    const t = tallas.find(x => x.id === String(w.id));
    if (t && t.faltan.some(k => k !== 'nacimiento')) faltan.push('tallas');
    return { nombre: w.name, faltan };
  }).filter(p => p.faltan.length);
  return { personas, obras, encargos: enc };
}

function texto(r) {
  const l = ['📋 *Lo que falta del equipo*'];
  for (const o of r.obras || []) l.push(`\n🏗️ *${o.ref}*: faltan ${o.faltan} documentos${o.dias != null ? (o.dias <= 0 ? ' · ¡entráis hoy!' : ` · entráis en ${o.dias} días`) : ''}${o.porQuien ? ` (${Object.entries(o.porQuien).filter(([, n]) => n).map(([q, n]) => `${q}: ${n}`).join(', ')})` : ''}`);
  if (r.personas.length) { l.push('\n👷 *Por trabajador:*'); for (const p of r.personas) l.push(`• *${p.nombre}*: ${p.faltan.join(', ')}`); }
  if (r.encargos.length) { l.push(`\n📨 *Encargos esperando* (${r.encargos.length}):`); for (const e of r.encargos.slice(0, 12)) l.push(`• ${e.nombre}: ${e.que}${e.dias ? ` (${e.dias} d)` : ''}`); }
  if (l.length === 1) return '✔ No falta nada del equipo. 🎉';
  l.push('\nPara pedir algo: *«pídele a X…»*, *«pide las tallas a todos»*, *«lista de compra de EPIs»*.');
  return l.join('\n');
}

// Lista de compra de EPIs: los que no tienen la entrega firmada, con sus tallas.
async function compraEpis() {
  const P = require('./personalDocs'); const F = require('./fichaDatos'); const { KIT_EPIS } = require('./firmas');
  const [res, tallas] = await Promise.all([P.resumen(), F.todas()]);
  const sinEpis = tallas.filter(t => { const w = res.trabajadores.find(x => String(x.id) === t.id); return !w || !w.requisitos || !w.requisitos.epis || w.requisitos.epis.estado !== 'ok'; });
  const lineas = {};
  for (const k of KIT_EPIS) for (const t of sinEpis) {
    const talla = k.talla ? (t.tallas[k.talla === 'calzado' ? 'calzado' : k.talla === 'pantalon' ? 'pantalon' : 'ropa'] || '¿?') : '';
    const key = `${k.nombre}|${talla}`; lineas[key] = lineas[key] || { articulo: k.nombre, talla, cantidad: 0, para: [] };
    lineas[key].cantidad += k.cantidad || 1; lineas[key].para.push(t.nombre.split(' ')[0]);
  }
  return { personas: sinEpis.map(t => ({ nombre: t.nombre, tallas: t.tallas, sinTallas: t.faltan.filter(k => k !== 'nacimiento') })), lineas: Object.values(lineas).sort((a, b) => a.articulo.localeCompare(b.articulo) || String(a.talla).localeCompare(String(b.talla))) };
}
function textoCompra(c) {
  if (!c.personas.length) return '✔ Todos tienen la entrega de EPIs firmada.';
  const sin = c.personas.filter(p => p.sinTallas.length);
  return `🦺 *Lista de compra de EPIs* (para ${c.personas.length}: ${c.personas.map(p => p.nombre.split(' ')[0]).join(', ')})\n\n` +
    c.lineas.map(x => `• ${x.cantidad} × ${x.articulo}${x.talla ? ` — talla *${x.talla}*` : ''}${x.talla === '¿?' ? ` (${x.para.join(', ')})` : ''}`).join('\n') +
    (sin.length ? `\n\n⚠️ Faltan tallas de: ${sin.map(p => p.nombre.split(' ')[0]).join(', ')}. Dime *«pide las tallas a todos»* y Corpy se las pide.` : '') +
    '\n\nCuando los repartáis, dime *«entrega de EPIs a todos»* y cada uno lo firma en su app.';
}

// Tras repartir: a cada uno (o a los indicados) se le pide que firme la entrega en su app, con sus tallas.
async function entregarEpis({ userIds = null, por = 'Álex' } = {}) {
  const c = await compraEpis(); const { KIT_EPIS, pedir } = require('./firmas'); const F = require('./fichaDatos');
  const todas = await F.todas(); const out = [];
  for (const p of c.personas) {
    const t = todas.find(x => x.nombre === p.nombre); if (!t || (userIds && !userIds.includes(t.id))) continue;
    const items = KIT_EPIS.map(k => ({ nombre: k.nombre, cantidad: k.cantidad || 1, talla: k.talla ? (t.tallas[k.talla === 'calzado' ? 'calzado' : k.talla === 'pantalon' ? 'pantalon' : 'ropa'] || '') : '' }));
    try { const r = await pedir({ userId: t.id, tipo: 'epis', items }, por); out.push({ nombre: t.nombre, ok: true, avisado: r.avisado }); } catch (e) { out.push({ nombre: t.nombre, error: e.message }); }
  }
  return out;
}

async function avisoSemanal() { try { await require('./notifications').sendWhatsApp(texto(await resumen())); } catch (e) { console.warn('[Pendientes] semanal:', e.message); } }

module.exports = { resumen, texto, compraEpis, textoCompra, entregarEpis, avisoSemanal };
