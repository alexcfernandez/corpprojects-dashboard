// src/obraSugerencias.js — «¿Son de esta obra?»: compras SIN obra que probablemente son de una obra.
//
// Se usan nuestras copias de Compras (no StelOrder), así que funciona aunque StelOrder esté caído.
// Una compra se sugiere si no tiene obra (ni reparto) y:
//   · FUERTE: su texto (pista de obra que leyó la IA, nota, obra que pone cada línea, descripción) nombra
//     esta obra: una palabra distintiva de su nombre, motes, cliente o dirección («eugenia», «figueres»…).
//   · POR FECHAS: es de los días en que se trabajó en la obra (partes y fichajes, de 3 semanas antes a
//     1 semana después) y no nombra ninguna obra. Son solo candidatas: decide oficina.
// «Sí» le pone la obra y la confirma (pasa a StelOrder por el flujo de siempre); «No» la aparta de esta obra.
'use strict';
const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const DIA = 86400000;
// Palabras que salen en muchas obras o direcciones y no sirven para reconocer una.
const GENERICAS = new Set(('calle carrer carre avinguda avenida plaza placa passeig paseo camino cami ronda travessera ' +
  'comunidad comunitat propietaris propietarios obra obras reforma reformas reparacion casa piso pis bajo baixos atic atico ' +
  'girona gerona barcelona maresme salt figueres sarria escala portal puerta porta numero centro edificio local parking ' +
  'cliente senor senora sra para material materiales factura albaran').split(' '));

function palabrasDe(obra) {
  const textos = [obra.reference, obra.clientName, obra.address, ...(obra.aliases || [])];
  const out = new Set();
  for (const t of textos) for (const w of norm(t).match(/[a-z]{4,}/g) || []) if (!GENERICAS.has(w)) out.add(w);
  return [...out];
}
const textoDe = c => norm([c.obraPista, c.nota, c.obraRef, ...(c.lineas || []).flatMap(l => [l.obraTexto, l.descripcion])].filter(Boolean).join(' · '));
const pistaDe = c => norm([c.obraPista, ...(c.lineas || []).map(l => l.obraTexto)].filter(Boolean).join(' '));

// Días trabajados en la obra: partes (por obra elegida o por nombre) y fichajes (por nombre), como la rentabilidad.
async function diasTrabajados(db, obra) {
  const esc = s => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const textos = [obra.reference, obra.clientName, ...(obra.aliases || [])].map(s => String(s || '').trim()).filter(Boolean);
  const porNombre = textos.map(t => ({ clientName: { $regex: esc(t), $options: 'i' } }));
  const [partes, pres] = await Promise.all([
    db.collection('partes').find({ $or: [{ obraId: String(obra._id) }, ...porNombre] }).project({ date: 1 }).toArray(),
    porNombre.length ? db.collection('attendance').find({ $or: [...porNombre, ...textos.map(t => ({ 'obras.clientName': { $regex: esc(t), $options: 'i' } }))] }).project({ date: 1 }).toArray().catch(() => []) : [],
  ]);
  return [...new Set([...partes, ...pres].map(x => String(x.date || '').slice(0, 10)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
}

async function sugerencias(obraId) {
  const db = await getDB();
  const obra = await db.collection('obras').findOne({ _id: new ObjectId(String(obraId)) });
  if (!obra) throw new Error('Obra no encontrada');
  const id = String(obra._id);
  const palabras = palabrasDe(obra);
  const dias = await diasTrabajados(db, obra);
  const iso = t => new Date(t).toISOString().slice(0, 10);
  const desde = dias.length ? iso(Date.parse(dias[0]) - 21 * DIA) : (obra.startDate ? String(obra.startDate).slice(0, 10) : iso((obra.createdAt ? +obra.createdAt : Date.now()) - 21 * DIA));
  const hasta = dias.length ? iso(Date.parse(dias[dias.length - 1]) + 7 * DIA) : iso(Date.now());
  const cs = await db.collection('compras').find({
    estado: { $in: ['por_revisar', 'archivo'] }, duplicadoDe: null, tipo: { $in: ['factura', 'albaran', 'ticket', 'devolucion'] },
    obraId: { $in: [null, ''] }, $or: [{ reparto: { $exists: false } }, { reparto: { $size: 0 } }],
    destino: { $in: [null, 'obra'] }, noEsDe: { $ne: id },
  }).project({ proveedor: 1, tipo: 1, numero: 1, fecha: 1, createdAt: 1, base: 1, total: 1, estado: 1, obraPista: 1, nota: 1, obraRef: 1, 'lineas.obraTexto': 1, 'lineas.descripcion': 1 }).toArray();
  const diasSet = new Set(dias);
  const cerca = f => dias.some(d => Math.abs(Date.parse(d) - Date.parse(f)) <= 3 * DIA);
  const out = [];
  for (const c of cs) {
    const fecha = c.fecha || (c.createdAt && iso(c.createdAt)) || null;
    const t = textoDe(c);
    const coinciden = palabras.filter(w => new RegExp(`\\b${w}`).test(t));
    let fuerza = null, motivo = '';
    if (coinciden.length) { fuerza = 'fuerte'; motivo = `pone «${coinciden.slice(0, 2).join('», «')}»`; }
    else if (fecha && fecha >= desde && fecha <= hasta && !pistaDe(c).trim()) {
      fuerza = 'fechas'; motivo = diasSet.has(fecha) ? 'del mismo día en que se trabajó aquí' : cerca(fecha) ? 'de días en que se trabajaba aquí' : 'de las semanas de esta obra';
    }
    if (!fuerza) continue;
    out.push({ id: String(c._id), proveedor: c.proveedor || null, tipo: c.tipo, numero: c.numero || null, fecha, importe: c.base != null ? c.base : c.total, estado: c.estado, fuerza, motivo,
      orden: (fuerza === 'fuerte' ? 0 : diasSet.has(fecha) ? 1 : cerca(fecha) ? 2 : 3) });
  }
  out.sort((a, b) => a.orden - b.orden || String(b.fecha || '').localeCompare(String(a.fecha || '')));
  const fuertes = out.filter(x => x.fuerza === 'fuerte'), porFechas = out.filter(x => x.fuerza === 'fechas');
  return { obra: { id, reference: obra.reference }, palabras, dias: dias.length, desde, hasta,
    fuertes: fuertes.slice(0, 40), porFechas: porFechas.slice(0, 25), masPorFechas: Math.max(0, porFechas.length - 25) };
}

// es=true: le pone la obra y la confirma; si no se puede confirmar (falta el proveedor…), se queda con la obra
// puesta y se dice qué falta. es=false: no vuelve a salir para esta obra.
async function decidir(obraId, compraId, es, por) {
  const db = await getDB();
  const compras = require('./compras');
  const id = String(obraId);
  if (!es) {
    await db.collection('compras').updateOne({ _id: new ObjectId(String(compraId)) }, { $addToSet: { noEsDe: id } });
    return { ok: true, apartada: true };
  }
  await compras.editar(compraId, { destino: 'obra', obraId: id }, por);
  try { const r = await compras.revisar(compraId, por); return { ok: true, confirmada: true, obraRef: r.obraRef || null }; }
  catch (e) { return { ok: true, confirmada: false, falta: e.message }; }
}

module.exports = { sugerencias, decidir, _palabrasDe: palabrasDe, _textoDe: textoDe };
