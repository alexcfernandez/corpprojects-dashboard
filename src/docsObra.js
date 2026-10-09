// src/docsObra.js — «Documentación para entrar» en una obra de contratista (9/10/2026).
//
// Cada contratista pide su lista (Seranco: documento W + V + formularios F, G y K). Aquí la lista va como plantilla,
// la obra dice qué plantilla usa, quién va a ir y el día de entrada, y se cruza con lo que hay en Personal
// (docsPersonal: empresa, cada trabajador y los papeles de esa obra). Para cada cosa que falta se dice QUIÉN la da
// —el trabajador (Corpy se lo pide), la gestoría, el servicio de prevención, la aseguradora, nosotros o firmarla—
// y desde la página se prepara el correo o se pide con un clic. En Inicio sale «Obra X: faltan N para el martes».
'use strict';
const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }

const QUIEN = {
  trabajador: 'El trabajador (Corpy se lo pide por WhatsApp)',
  gestoria: 'La gestoría (Som Assessors)',
  prevencion: 'El servicio de prevención (SPASS)',
  aseguradora: 'La aseguradora',
  nosotros: 'Nosotros',
  firmar: 'Firmar y sellar (formulario del contratista)',
};

// de: empresa | trabajador | obra · tipo: el de Personal · si: solo cuando aplica (maquinaria)
const PLANTILLAS = {
  seranco: {
    nombre: 'Seranco (documentos W, V, F, G y K)',
    destino: ['documentacion@seranco.es'],
    items: [
      { de: 'obra', tipo: 'contrato_obra', quien: 'firmar', nota: 'Firmado antes de empezar' },
      { de: 'obra', tipo: 'recibi_doc', quien: 'firmar', nota: 'Hoja final del documento W, firmada y sellada' },
      { de: 'obra', tipo: 'adhesion_pss', quien: 'firmar', nota: 'Documento F (leer antes el Plan de Seguridad y Salud)' },
      { de: 'obra', tipo: 'trab_designado', quien: 'firmar', nota: 'Documento G' },
      { de: 'obra', tipo: 'aut_libro', quien: 'firmar', nota: 'Documento K, si procede', opcional: true },
      { de: 'obra', tipo: 'cert_hacienda_contratista', quien: 'gestoria', nota: 'ORIGINAL y específico para Seranco, S.A.U. (CIF A-79189940)' },
      { de: 'empresa', tipo: 'cert_ss', quien: 'gestoria', nota: 'ORIGINAL, del mes' },
      { de: 'empresa', tipo: 'ita', quien: 'gestoria', nota: 'Actualizado' },
      { de: 'empresa', tipo: 'mutua', quien: 'gestoria', nota: 'Con el centro asistencial más cercano a la obra' },
      { de: 'empresa', tipo: 'ta7', quien: 'gestoria', nota: 'Para el contrato' },
      { de: 'empresa', tipo: 'iae', quien: 'gestoria', nota: 'Para el contrato' },
      { de: 'empresa', tipo: 'rea', quien: 'nosotros', nota: 'Inscripción o última renovación' },
      { de: 'empresa', tipo: 'cert_spa', quien: 'prevencion', nota: 'Especialidades técnicas y vigilancia de la salud, al corriente de pago' },
      { de: 'empresa', tipo: 'prl_empresa', quien: 'prevencion', nota: 'Evaluación de riesgos' },
      { de: 'empresa', tipo: 'seguro_rc', quien: 'aseguradora', nota: 'Póliza entera y justificante bancario del pago' },
      { de: 'empresa', tipo: 'seguro_acc', quien: 'aseguradora', nota: 'Póliza entera y justificante bancario del pago' },
      { de: 'trabajador', tipo: 'dni', quien: 'trabajador' },
      { de: 'trabajador', tipo: 'contrato', quien: 'gestoria' },
      { de: 'trabajador', tipo: 'alta_ss', quien: 'gestoria' },
      { de: 'trabajador', tipo: 'reconocimiento', quien: 'prevencion', nota: 'Con la calificación de APTO (no valen citaciones)' },
      { de: 'trabajador', tipo: 'formacion_prl', quien: 'prevencion', nota: 'Formación e información PRL de su puesto (art. 18 y 19)' },
      { de: 'trabajador', tipo: 'formacion_oficio', quien: 'prevencion', nota: 'Curso de 20 h del convenio' },
      { de: 'trabajador', tipo: 'epis', quien: 'nosotros', nota: 'Fechado y firmado por el trabajador y por quien entrega' },
      { de: 'trabajador', tipo: 'carnet', quien: 'trabajador', si: 'maquinaria', nota: 'Carnet de conducir si maneja maquinaria' },
      { de: 'trabajador', tipo: 'maquinaria_aut', quien: 'nosotros', si: 'maquinaria' },
      { de: 'trabajador', tipo: 'maquinaria_form', quien: 'prevencion', si: 'maquinaria' },
    ],
  },
  basica: {
    nombre: 'Básica (lo habitual de cualquier obra)',
    destino: [],
    items: [
      { de: 'empresa', tipo: 'cert_ss', quien: 'gestoria' }, { de: 'empresa', tipo: 'cert_hacienda', quien: 'gestoria' }, { de: 'empresa', tipo: 'rnt_rlc', quien: 'gestoria' },
      { de: 'empresa', tipo: 'seguro_rc', quien: 'aseguradora' }, { de: 'empresa', tipo: 'rea', quien: 'nosotros' }, { de: 'empresa', tipo: 'prl_empresa', quien: 'prevencion' },
      { de: 'trabajador', tipo: 'dni', quien: 'trabajador' }, { de: 'trabajador', tipo: 'alta_ss', quien: 'gestoria' }, { de: 'trabajador', tipo: 'reconocimiento', quien: 'prevencion' },
      { de: 'trabajador', tipo: 'formacion_prl', quien: 'prevencion' }, { de: 'trabajador', tipo: 'epis', quien: 'nosotros' },
    ],
  },
};

const hoyIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
const oid = id => { if (!/^[a-f0-9]{24}$/.test(String(id || ''))) throw new Error('Obra no válida'); return new ObjectId(String(id)); };

async function configurar(obraId, { plantilla, userIds, maquinaria, fechaEntrada, destino } = {}, por) {
  const db = await getDB();
  if (plantilla && !PLANTILLAS[plantilla]) throw new Error('Plantilla no válida');
  const o = await db.collection('obras').findOne({ _id: oid(obraId) }, { projection: { docsEntrada: 1 } });
  if (!o) throw new Error('No encuentro la obra');
  const prev = o.docsEntrada || {};
  const set = { ...prev, plantilla: plantilla || prev.plantilla || 'basica', actualizado: new Date(), por: por || '' };
  if (Array.isArray(userIds)) set.userIds = userIds.map(String).filter(x => /^[a-f0-9]{24}$/.test(x)).slice(0, 40);
  if (maquinaria !== undefined) set.maquinaria = !!maquinaria;
  if (fechaEntrada !== undefined) set.fechaEntrada = /^\d{4}-\d{2}-\d{2}$/.test(String(fechaEntrada || '')) ? fechaEntrada : null;
  if (Array.isArray(destino)) set.destino = destino.map(s => String(s).trim().toLowerCase()).filter(s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)).slice(0, 6);
  await db.collection('obras').updateOne({ _id: o._id }, { $set: { docsEntrada: set } });
  return { ok: true, docsEntrada: set };
}

// Cruza la lista con Personal. Devuelve las filas de empresa/obra y, por trabajador, las suyas; con qué hay.
async function estado(obraId) {
  const db = await getDB();
  const P = require('./personalDocs');
  const o = await db.collection('obras').findOne({ _id: oid(obraId) }, { projection: { reference: 1, clientName: 1, address: 1, docsEntrada: 1 } });
  if (!o) throw new Error('No encuentro la obra');
  const cfg = o.docsEntrada || { plantilla: 'basica', userIds: [] };
  const pl = PLANTILLAS[cfg.plantilla] || PLANTILLAS.basica;
  const items = pl.items.filter(i => !i.si || (i.si === 'maquinaria' && cfg.maquinaria));
  const userIds = cfg.userIds || [];
  const [docs, users] = await Promise.all([
    db.collection('docsPersonal').find({ estado: 'ok', $or: [{ ambito: 'empresa' }, { ambito: 'obra', obraId: String(o._id) }, { ambito: 'trabajador', userId: { $in: userIds } }] }, { projection: { data: 0 } }).toArray(),
    userIds.length ? db.collection('users').find({ _id: { $in: userIds.map(x => new ObjectId(x)) } }, { projection: { name: 1, whatsapp: 1, telefono: 1 } }).toArray() : [],
  ]);
  const nombreTipo = (de, t) => ((de === 'empresa' ? P.TIPOS_EMPRESA : de === 'obra' ? P.TIPOS_OBRA : P.TIPOS)[t] || {}).nombre || t;
  const ultimo = (f) => docs.filter(f).sort((a, b) => String(b.caduca || b.mes || b.fecha || '').localeCompare(String(a.caduca || a.mes || a.fecha || '')) || new Date(b.subido) - new Date(a.subido))[0] || null;
  const entrada = cfg.fechaEntrada || null;
  const fila = (i, d) => {
    let est = 'falta';
    if (d) { const ref = entrada && entrada > hoyIso() ? entrada : hoyIso(); est = d.caduca && d.caduca < ref ? 'caducado' : 'ok'; }
    return { de: i.de, tipo: i.tipo, nombre: nombreTipo(i.de, i.tipo), quien: i.quien, quienTxt: QUIEN[i.quien], nota: i.nota || '', opcional: !!i.opcional, estado: est, docId: d ? String(d._id) : null, caduca: d ? d.caduca : null, archivo: d ? d.nombre : null };
  };
  const general = items.filter(i => i.de !== 'trabajador').map(i => fila(i, ultimo(d => d.ambito === i.de && d.tipo === i.tipo && (i.de !== 'obra' || d.obraId === String(o._id)))));
  const trabajadores = userIds.map(uid => {
    const u = users.find(x => String(x._id) === uid) || {};
    return { userId: uid, nombre: u.name || '¿?', movil: !!(u.whatsapp || u.telefono), filas: items.filter(i => i.de === 'trabajador').map(i => fila(i, ultimo(d => d.ambito === 'trabajador' && d.userId === uid && d.tipo === i.tipo))) };
  });
  const todas = [...general, ...trabajadores.flatMap(t => t.filas)].filter(f => !f.opcional);
  const faltan = todas.filter(f => f.estado !== 'ok').length;
  const porQuien = {};
  for (const f of [...general.map(x => ({ ...x, quienEs: 'Empresa / obra' })), ...trabajadores.flatMap(t => t.filas.map(x => ({ ...x, quienEs: t.nombre })))]) {
    if (f.estado === 'ok' || f.opcional) continue;
    (porQuien[f.quien] ||= []).push(`${f.quienEs}: ${f.nombre}${f.estado === 'caducado' ? ' (caducado)' : ''}`);
  }
  const dias = entrada ? Math.round((new Date(entrada + 'T12:00:00Z') - new Date(hoyIso() + 'T12:00:00Z')) / 86400000) : null;
  return { obra: { id: String(o._id), ref: o.reference, cliente: o.clientName, direccion: o.address }, config: { ...cfg, plantillaNombre: pl.nombre, destino: cfg.destino || pl.destino },
    plantillas: Object.entries(PLANTILLAS).map(([k, p]) => ({ id: k, nombre: p.nombre })), papeles: docs.filter(d => d.ambito === 'obra').map(d => ({ id: String(d._id), nombre: d.nombre, tipo: d.tipo })), general, trabajadores, total: todas.length, faltan, dias, porQuien, quienes: QUIEN, enviado: cfg.enviado || null };
}

// Para Inicio: obras con lista configurada, aún sin enviar, con algo pendiente (las que entran antes primero).
async function pendientes() {
  const db = await getDB();
  const os = await db.collection('obras').find({ 'docsEntrada.plantilla': { $exists: true }, 'docsEntrada.enviado': { $exists: false }, status: { $nin: ['terminada', 'facturada', 'archivada', 'descartada'] } }, { projection: { _id: 1 } }).toArray();
  const out = [];
  for (const o of os) { try { const e = await estado(String(o._id)); if (e.faltan) out.push({ obraId: e.obra.id, ref: e.obra.ref, faltan: e.faltan, total: e.total, dias: e.dias, fechaEntrada: e.config.fechaEntrada || null }); } catch (e) {} }
  return out.sort((a, b) => (a.dias ?? 999) - (b.dias ?? 999));
}

// Texto del correo para pedir lo que falta a la gestoría o al servicio de prevención.
function textoPeticion(e, quien) {
  const l = e.porQuien[quien] || [];
  if (!l.length) return null;
  const obra = `${e.obra.ref}${e.obra.cliente ? ' (' + e.obra.cliente + ')' : ''}`;
  const cuando = e.config.fechaEntrada ? ` Entramos el ${e.config.fechaEntrada.split('-').reverse().join('/')}.` : '';
  if (quien === 'gestoria') return { para: ['eduard@somassessors.com'], asunto: `Documentació per entrar a l'obra ${e.obra.ref}`, texto: `Bon dia, Eduard\n\nPer entrar a l'obra ${obra} el contractista ens demana aquesta documentació que heu de preparar vosaltres:${cuando}\n\n${l.map(x => '- ' + x).join('\n')}\n\nEl certificat d'Hisenda ha de ser l'específic per al contractista (art. 43.1.f de la Llei 58/2003) i el de la Seguretat Social, l'original del mes.\n\nGràcies,\n\nCorp Projects\n674 013 723` };
  if (quien === 'prevencion') return { para: ['tecgirona2@spass.es'], asunto: `Documentación PRL para la obra ${e.obra.ref}`, texto: `Buenos días:\n\nPara entrar en la obra ${obra} el contratista nos pide esta documentación de prevención:${cuando}\n\n${l.map(x => '- ' + x).join('\n')}\n\n¿Nos la podéis enviar o decirnos qué falta por hacer (reconocimientos, cursos)?\n\nGracias,\n\nCorp Projects\n674 013 723` };
  return { para: [], asunto: `Documentación para la obra ${e.obra.ref}`, texto: `Falta:\n\n${l.map(x => '- ' + x).join('\n')}` };
}

// Todo lo que hay (empresa, obra y cada trabajador) en un ZIP con un ÍNDICE de lo que va y lo que falta.
async function paquete(obraId) {
  const db = await getDB();
  const { crearZip } = require('./zip');
  const e = await estado(obraId);
  const limpio = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 ._-]/g, '').trim().replace(/\s+/g, '_').slice(0, 80);
  const ext = m => (/pdf/i.test(m) ? 'pdf' : /png/i.test(m) ? 'png' : 'jpg');
  const archivos = [], indice = [`Documentación para la obra ${e.obra.ref} — Corp Projects Holding, S.L. (CIF B09899253)`, `Fecha: ${hoyIso().split('-').reverse().join('/')}`, ''];
  const meter = async (carpeta, filas) => {
    indice.push(carpeta.toUpperCase());
    for (const f of filas) {
      if (!f.docId) { if (!f.opcional) indice.push(`  ✗ FALTA: ${f.nombre}`); continue; }
      const d = await db.collection('docsPersonal').findOne({ _id: new ObjectId(f.docId) });
      const buf = d ? await require('./personalDocs').datos(d) : null;
      if (!buf) continue;
      archivos.push({ nombre: `${limpio(carpeta)}/${limpio(f.nombre)}.${ext(d.mime)}`, datos: buf });
      indice.push(`  ${f.estado === 'caducado' ? '⚠ CADUCADO' : '✓'} ${f.nombre}${f.caduca ? ' · válido hasta ' + f.caduca.split('-').reverse().join('/') : ''}`);
    }
    indice.push('');
  };
  await meter('Empresa', e.general.filter(f => f.de === 'empresa'));
  await meter('Obra', e.general.filter(f => f.de === 'obra'));
  for (const t of e.trabajadores) await meter(t.nombre, t.filas);
  archivos.unshift({ nombre: 'INDICE.txt', datos: Buffer.from(indice.join('\r\n'), 'utf8') });
  return { zip: crearZip(archivos), nombre: `Documentacion_${limpio(e.obra.ref)}_${hoyIso()}.zip`, faltan: e.faltan, estado: e, indice: indice.join('\n') };
}

async function marcarEnviado(obraId, por) {
  const db = await getDB();
  await db.collection('obras').updateOne({ _id: oid(obraId) }, { $set: { 'docsEntrada.enviado': { at: new Date(), por: por || '' } } });
  return { ok: true };
}

module.exports = { PLANTILLAS, QUIEN, configurar, estado, pendientes, textoPeticion, paquete, marcarEnviado };
