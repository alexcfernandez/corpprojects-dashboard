// src/documentos.js — DOCUMENTOS para que firme el cliente (declaraciones de IVA, conformidad de obra…).
//
// Se elige la plantilla y el cliente; sus datos (nombre, NIF, dirección) salen de StelOrder y lo que falte se
// escribe a mano. Se guarda cada documento hecho (colección `documentos`) para verlo, imprimirlo otra vez y
// adjuntar la copia firmada (`documentosArchivos`).
//
// Plantillas (por qué IVA va cada factura):
//   iva10_particular · 10 %: reforma o reparación de la vivienda de un particular (art. 91.Uno.2.10º LIVA)
//   iva10_comunidad  · 10 %: obras en un edificio de viviendas para su comunidad de propietarios (mismo artículo)
//   isp              · sin IVA (inversión del sujeto pasivo): obra para un constructor/empresa (art. 84.Uno.2º.f)
//   conformidad      · acta de recepción y conformidad de los trabajos al acabar la obra
'use strict';
const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EMPRESA = { nombre: 'CORP PROJECTS HOLDING, S.L.', cif: process.env.EMPRESA_CIF || 'B09899253', domicilio: process.env.EMPRESA_DOMICILIO || 'C/ Nou 12, 2B, 17001 Girona' };
const fechaLarga = f => { const d = f ? new Date(f + 'T12:00:00Z') : new Date(); return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Madrid' }); };

const C = (k, label, extra = {}) => ({ k, label, ...extra });
const PLANTILLAS = {
  iva10_particular: {
    titulo: 'Declaración IVA 10 % · reforma de vivienda (particular)',
    h1: 'Declaración del destinatario para la aplicación del tipo reducido del 10 % de IVA',
    cuando: 'Particular que reforma o repara SU vivienda: la factura va al 10 % en vez del 21 %. Requisitos: persona física sin actividad para esa obra, vivienda con más de 2 años y materiales que no pasen del 40 % de la base.',
    campos: [C('nombre', 'Nombre y apellidos', { req: true }), C('nif', 'DNI / NIE (si no lo tienes, queda en blanco para que lo escriba)'), C('domicilio', 'Domicilio del cliente'), C('direccionObra', 'Dirección de la vivienda (obra)', { req: true }), C('refCatastral', 'Referencia catastral (opcional)'), C('referencia', 'Presupuesto / factura', { ph: 'PRT00831 · FAC00988' }), C('lugar', 'Lugar', { def: 'Girona' }), C('fecha', 'Fecha', { tipo: 'date' })],
    cuerpo: d => `
      <p>D./Dña. <b>${esc(d.nombre)}</b>, con DNI/NIE <b>${esc(d.nif || '__________________')}</b>${d.domicilio ? `, con domicilio en ${esc(d.domicilio)}` : ''}, en calidad de destinatario/a de las obras que <b>${EMPRESA.nombre}</b> (CIF ${EMPRESA.cif}) realiza en la vivienda situada en <b>${esc(d.direccionObra)}</b>${d.refCatastral ? ` (referencia catastral ${esc(d.refCatastral)})` : ''}${d.referencia ? `, según ${esc(d.referencia)}` : ''},</p>
      <p><b>DECLARA</b> bajo su responsabilidad:</p>
      <ol>
        <li>Que es persona física y que no actúa como empresario o profesional en relación con estas obras, que se destinan a su <b>uso particular</b>.</li>
        <li>Que el inmueble es una <b>vivienda</b> y que su construcción o última rehabilitación terminó <b>al menos dos años antes</b> del inicio de estas obras.</li>
        <li>Que las obras son de renovación o reparación de la vivienda.</li>
      </ol>
      <p>Y para que conste a los efectos de la aplicación del tipo reducido del <b>10 % del IVA</b> previsto en el artículo 91.Uno.2.10º de la Ley 37/1992, del Impuesto sobre el Valor Añadido, firma la presente.</p>`,
    firmas: d => [`El/la cliente<br><b>${esc(d.nombre)}</b>`],
  },
  iva10_comunidad: {
    titulo: 'Declaración IVA 10 % · comunidad de propietarios',
    h1: 'Declaración de la comunidad de propietarios para la aplicación del tipo reducido del 10 % de IVA',
    cuando: 'Obras de renovación o reparación de un edificio de viviendas pagadas por la comunidad: 10 %. El edificio tiene que ser al menos un 50 % vivienda y tener más de 2 años. Firma el presidente o el administrador.',
    campos: [C('nombre', 'Comunidad de propietarios', { req: true }), C('nif', 'NIF de la comunidad', { req: true }), C('direccionObra', 'Dirección del edificio', { req: true }), C('firmante', 'Quien firma', { req: true }), C('cargo', 'Cargo', { def: 'Presidente/a' }), C('referencia', 'Presupuesto / factura'), C('lugar', 'Lugar', { def: 'Girona' }), C('fecha', 'Fecha', { tipo: 'date' })],
    cuerpo: d => `
      <p>D./Dña. <b>${esc(d.firmante)}</b>, en calidad de <b>${esc(d.cargo || 'Presidente/a')}</b> de la <b>${esc(d.nombre)}</b>, con NIF <b>${esc(d.nif || '__________________')}</b>, destinataria de las obras que <b>${EMPRESA.nombre}</b> (CIF ${EMPRESA.cif}) realiza en el edificio situado en <b>${esc(d.direccionObra)}</b>${d.referencia ? `, según ${esc(d.referencia)}` : ''},</p>
      <p><b>DECLARA</b> bajo su responsabilidad:</p>
      <ol>
        <li>Que el edificio se destina principalmente a <b>viviendas</b> (al menos el 50 % de su superficie construida).</li>
        <li>Que su construcción o última rehabilitación terminó <b>al menos dos años antes</b> del inicio de estas obras.</li>
        <li>Que las obras son de renovación o reparación del edificio y las contrata la comunidad de propietarios.</li>
      </ol>
      <p>Y para que conste a los efectos de la aplicación del tipo reducido del <b>10 % del IVA</b> previsto en el artículo 91.Uno.2.10º de la Ley 37/1992, del Impuesto sobre el Valor Añadido, firma la presente.</p>`,
    firmas: d => [`Por la comunidad<br><b>${esc(d.firmante)}</b><br>${esc(d.cargo || '')}`],
  },
  isp: {
    titulo: 'Declaración inversión del sujeto pasivo · factura sin IVA',
    h1: 'Declaración del destinatario a efectos de la inversión del sujeto pasivo del IVA',
    cuando: 'Trabajo para un constructor o empresa que a su vez hace la obra de construcción o rehabilitación: la factura va SIN IVA («inversión del sujeto pasivo») y el IVA lo declara el cliente.',
    campos: [C('nombre', 'Empresa cliente', { req: true }), C('nif', 'CIF', { req: true }), C('firmante', 'Quien firma', { req: true }), C('cargo', 'Cargo', { def: 'Administrador/a' }), C('direccionObra', 'Dirección de la obra', { req: true }), C('descripcion', 'Trabajos', { ph: 'Pintura y paletería…' }), C('referencia', 'Presupuesto / factura'), C('lugar', 'Lugar', { def: 'Girona' }), C('fecha', 'Fecha', { tipo: 'date' })],
    cuerpo: d => `
      <p>D./Dña. <b>${esc(d.firmante)}</b>, en calidad de <b>${esc(d.cargo || 'Administrador/a')}</b> de <b>${esc(d.nombre)}</b>, con CIF <b>${esc(d.nif || '__________________')}</b>,</p>
      <p><b>DECLARA</b> bajo su responsabilidad:</p>
      <ol>
        <li>Que actúa como <b>empresario o profesional</b> en relación con los trabajos${d.descripcion ? ` de <b>${esc(d.descripcion)}</b>` : ''} que le presta <b>${EMPRESA.nombre}</b> (CIF ${EMPRESA.cif}) en la obra situada en <b>${esc(d.direccionObra)}</b>${d.referencia ? `, según ${esc(d.referencia)}` : ''}.</li>
        <li>Que dichos trabajos se realizan en el marco de una ejecución de obra de <b>urbanización, construcción o rehabilitación de edificaciones</b>, directamente o por subcontratación.</li>
      </ol>
      <p>Por ello, la factura se emitirá <b>sin IVA</b>, por <b>inversión del sujeto pasivo</b>, conforme al artículo 84.Uno.2º.f) de la Ley 37/1992, del Impuesto sobre el Valor Añadido, siendo el destinatario quien deberá liquidarlo.</p>`,
    firmas: d => [`Por ${esc(d.nombre)}<br><b>${esc(d.firmante)}</b>`],
  },
  conformidad: {
    titulo: 'Acta de conformidad y recepción de los trabajos',
    cuando: 'Al acabar la obra: el cliente firma que la recibe a su conformidad (o anota lo que falte). Útil antes de la última factura o si luego hay reclamaciones.',
    campos: [C('nombre', 'Cliente', { req: true }), C('nif', 'DNI / NIF'), C('direccionObra', 'Dirección de la obra', { req: true }), C('descripcion', 'Trabajos realizados', { req: true, area: true }), C('referencia', 'Presupuesto / factura'), C('fechaFin', 'Fecha de final de obra', { tipo: 'date' }), C('observaciones', 'Observaciones / pendientes', { area: true }), C('lugar', 'Lugar', { def: 'Girona' }), C('fecha', 'Fecha', { tipo: 'date' })],
    cuerpo: d => `
      <p>En ${esc(d.lugar || 'Girona')}, reunidos de una parte <b>${EMPRESA.nombre}</b> (CIF ${EMPRESA.cif}) y de otra <b>${esc(d.nombre)}</b>${d.nif ? ` (DNI/NIF ${esc(d.nif)})` : ''}, se hace constar que los trabajos de:</p>
      <p style="white-space:pre-wrap;border-left:3px solid #999;padding-left:10px">${esc(d.descripcion)}</p>
      <p>realizados en <b>${esc(d.direccionObra)}</b>${d.referencia ? `, según ${esc(d.referencia)}` : ''}, han finalizado${d.fechaFin ? ` el <b>${fechaLarga(d.fechaFin)}</b>` : ''} y el cliente los <b>recibe a su conformidad</b>.</p>
      <p><b>Observaciones:</b> ${d.observaciones ? `<span style="white-space:pre-wrap">${esc(d.observaciones)}</span>` : 'ninguna.'}</p>`,
    firmas: d => ['Por Corp Projects Holding, S.L.', `El cliente<br><b>${esc(d.nombre)}</b>`],
  },
};

function html(plantilla, d) {
  const p = PLANTILLAS[plantilla]; if (!p) throw new Error('Plantilla no válida');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(p.titulo)}</title><style>
    @page{size:A4;margin:22mm 20mm}body{font-family:Georgia,'Times New Roman',serif;color:#111;font-size:12.5pt;line-height:1.55;max-width:170mm;margin:0 auto;background:#fff}
    .emp{font-family:Arial,sans-serif;font-size:9pt;color:#555;border-bottom:1px solid #ccc;padding-bottom:6px;margin-bottom:22px}h1{font-size:14pt;text-align:center;margin:0 0 22px;text-transform:uppercase;letter-spacing:.3px}
    ol li{margin-bottom:6px}.fecha{margin-top:26px}.firmas{display:flex;gap:30px;margin-top:40px}.firmas div{flex:1;border-top:1px solid #333;padding-top:6px;font-size:10.5pt;text-align:center;min-height:70px}
  </style></head><body><div class="emp">${EMPRESA.nombre} · CIF ${EMPRESA.cif} · ${esc(EMPRESA.domicilio)}</div><h1>${esc(p.h1 || p.titulo)}</h1>${p.cuerpo(d)}
  <p class="fecha">En ${esc(d.lugar || 'Girona')}, a ${fechaLarga(d.fecha)}.</p><div class="firmas">${p.firmas(d).map(f => `<div>${f}</div>`).join('')}</div></body></html>`;
}

// Clientes de StelOrder (nombre, NIF y dirección) para rellenar solo.
async function buscarClientes(q) {
  const n = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const t = n(q).trim(); if (t.length < 2) return [];
  const { clients } = await require('./stelorder').getClients();
  return (clients || []).filter(c => !c.deleted && t.split(/\s+/).every(w => n(`${c['legal-name']} ${c.name} ${c['tax-identification-number']}`).includes(w))).slice(0, 15).map(c => {
    const a = c['main-address'] || {};
    const dir = [a['address-data'], [a['postal-code'], a['city-town']].filter(Boolean).join(' '), a.province].filter(Boolean).join(', ');
    const nif = String(c['tax-identification-number'] || '').replace(/^X+$/i, '');
    return { id: String(c.id), nombre: c['legal-name'] || c.name, nif, direccion: dir };
  });
}

async function crear({ plantilla, datos, clienteId = null, por = '' }) {
  const p = PLANTILLAS[plantilla]; if (!p) throw new Error('Plantilla no válida');
  const d = {};
  for (const c of p.campos) { const v = String((datos || {})[c.k] ?? c.def ?? '').trim().slice(0, c.area ? 2000 : 300); d[c.k] = v; if (c.req && !v) throw new Error(`Falta: ${c.label}`); }
  if (!d.fecha) d.fecha = new Date().toISOString().slice(0, 10);
  const db = await getDB();
  const doc = { plantilla, titulo: p.titulo, cliente: { id: clienteId, nombre: d.nombre, nif: d.nif || null }, datos: d, estado: 'pendiente_firma', creadoPor: por, createdAt: new Date() };
  const r = await db.collection('documentos').insertOne(doc);
  return { id: String(r.insertedId), html: html(plantilla, d) };
}
async function lista({ q = '' } = {}) {
  const db = await getDB();
  const f = q ? { 'cliente.nombre': { $regex: String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } } : {};
  const l = await db.collection('documentos').find(f).sort({ createdAt: -1 }).limit(100).toArray();
  return l.map(x => ({ id: String(x._id), plantilla: x.plantilla, titulo: x.titulo, cliente: x.cliente, referencia: x.datos && x.datos.referencia, fecha: x.datos && x.datos.fecha, estado: x.estado, firmado: x.firmado || null, creadoPor: x.creadoPor, createdAt: x.createdAt }));
}
async function ver(id) {
  const db = await getDB();
  const x = await db.collection('documentos').findOne({ _id: new ObjectId(String(id)) });
  if (!x) throw new Error('Documento no encontrado');
  return html(x.plantilla, x.datos);
}
async function subirFirmado(id, archivo, por) {
  if (!archivo) throw new Error('Falta el archivo');
  const db = await getDB();
  const r = await db.collection('documentosArchivos').insertOne({ documentoId: String(id), nombre: archivo.originalname, mime: archivo.mimetype, size: archivo.size, data: archivo.buffer, por, createdAt: new Date() });
  await db.collection('documentos').updateOne({ _id: new ObjectId(String(id)) }, { $set: { estado: 'firmado', firmado: { archivoId: String(r.insertedId), nombre: archivo.originalname, at: new Date(), por } } });
  return { ok: true };
}
async function archivoFirmado(id) {
  const db = await getDB();
  const x = await db.collection('documentos').findOne({ _id: new ObjectId(String(id)) });
  if (!x || !x.firmado) throw new Error('Sin copia firmada');
  return db.collection('documentosArchivos').findOne({ _id: new ObjectId(x.firmado.archivoId) });
}
const plantillas = () => Object.entries(PLANTILLAS).map(([k, p]) => ({ k, titulo: p.titulo, cuando: p.cuando, campos: p.campos }));

module.exports = { PLANTILLAS, plantillas, html, buscarClientes, crear, lista, ver, subirFirmado, archivoFirmado };
