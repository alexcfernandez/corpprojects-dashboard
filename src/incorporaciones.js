// src/incorporaciones.js — Alta de una persona nueva, paso a paso (15/10/2026).
//
// Desde el 05/10/2026 (RD 723/2026) hay que darle por escrito, ANTES de empezar, los «elementos esenciales» de la
// relación laboral; Som Assessors (Eduard) no tramita el alta sin ese papel firmado por la empresa y el trabajador.
// Aquí la oficina pone «empieza X el día Y» con las condiciones (categoría, jornada, sueldo…) y se va preparando solo:
//   1. ficha del trabajador (users) con su WhatsApp            → se crea si no existe
//   2. DNI/NIE y nº de la Seguridad Social                      → Corpy se los pide (docsAlta)
//   3. formulario de elementos esenciales                       → se rellena la plantilla de Som Assessors (pdf-lib)
//   4. firma de Alfonso con sello y luego del trabajador        → firma con el dedo por enlace (firmaExterna, en cadena)
//   5. envío a la gestoría (formulario firmado + DNI + SS)      → botón (o solo, si se activa `autoGestoria`)
//   6. alta confirmada, tallas/EPIs, reconocimiento médico, PRL → se marcan solos al llegar a su carpeta de Personal
// Cada mañana, si algo va tarde respecto al día de inicio, aviso a Álex.
//
//   incorporaciones { nombre, dni, telefono, fechaInicio, condiciones:{…}, userId, formularioId, loteFirmaId,
//                     gestoria:{at, a, por}, estado:'abierta'|'hecha'|'anulada', creadoPor, at }
'use strict';
const path = require('path');
const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const COL = 'incorporaciones';
const PLANTILLA = path.join(__dirname, 'plantillas', 'elementos_esenciales_construccion_girona_2026.pdf');
const GESTORIA = process.env.GESTORIA_ALTAS_EMAIL || 'eduard@somassessors.com';
// Quién firma por la empresa (el mismo que en los papeles de las obras).
const ADMIN = { nombre: process.env.ADMIN_NOMBRE || 'Alfonso Gálvez Cámara', telefono: process.env.ADMIN_TELEFONO || '+34692270438', dni: process.env.ADMIN_DNI || '40347979E', cargo: 'Administrador único' };
const EMPRESA = { nombre: 'CORP. PROJECTS HOLDING, S.L.', nif: 'B09899253' };

// El formulario de Som Assessors solo trae peón, oficial 3ª y oficial 1ª; oficial 2ª (nivel IX) hay que consultarlo con ellos.
const CATEGORIAS = { peo: 'Peón (nivel XII)', oficial_3: 'Oficial 3ª (ayudante oficial, nivel X)', oficial_2: 'Oficial 2ª (nivel IX)', oficial_1: 'Oficial 1ª (nivel VIII)' };
const TIPOS = { indefinida: 'Indefinida', fixa_discontinua: 'Fija discontinua', temporal: 'Temporal', substitucio: 'Sustitución' };
// Lo que se pone si no se dice otra cosa (lo habitual en Corp). `horario` y `centro` se revisan en cada alta; van en
// catalán porque el formulario de Som Assessors es en catalán.
const POR_DEFECTO = {
  tipo: 'indefinida', categoria: 'peo', salario: 'conveni', salarioImporte: null, salarioNota: '', incentivos: false, jornada: 'completa', horasSemana: null,
  horario: 'De dilluns a divendres, de 8:00 a 17:00 (1 hora per dinar)', nocturno: false, turnos: false, centroHabitual: true,
  formacionExtra: false, sistemaAutomatico: false, extranjero: false, prueba15: true,
  centro: "Obres de l'empresa a la província de Girona", domicilioSocial: process.env.EMPRESA_DOMICILIO_SOCIAL || 'C/ Nou, 12, 2º 2B, 17001 Girona',
};
// Si la respuesta es esta, Som Assessors pide que se le consulte ANTES de hacer la oferta.
const CONSULTAR = c => [c.categoria === 'oficial_2' && 'oficial 2ª no está en el formulario (solo peón, oficial 3ª y 1ª)', c.salario === 'superior' && !c.salarioImporte && `falta el sueldo bruto anual${c.salarioNota ? ` (pactado: ${c.salarioNota})` : ''}`, c.tipo !== 'indefinida' && 'el contrato no es indefinido', c.incentivos && 'hay primas o incentivos fuera de convenio', !c.centroHabitual && 'no trabajará solo en el centro indicado',
  c.formacionExtra && 'hay formación adicional impuesta por la empresa', c.sistemaAutomatico && 'se usa un sistema automático', c.extranjero && 'trabajará en el extranjero más de 4 semanas'].filter(Boolean);

const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
const dias = f => Math.round((new Date(f + 'T00:00:00Z') - new Date(hoy() + 'T00:00:00Z')) / 86400000);
const fmt = f => String(f || '').slice(0, 10).split('-').reverse().join('/');
const _oid = id => { try { return new ObjectId(String(id)); } catch (e) { throw new Error('Incorporación no válida'); } };
const limpiaDni = s => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 12);

function condiciones(entrada = {}, previas = {}) {
  const c = { ...POR_DEFECTO, ...previas };
  for (const k of Object.keys(POR_DEFECTO)) if (entrada[k] !== undefined && entrada[k] !== '') c[k] = entrada[k];
  for (const k of ['incentivos', 'nocturno', 'turnos', 'centroHabitual', 'formacionExtra', 'sistemaAutomatico', 'extranjero', 'prueba15']) c[k] = c[k] === true || c[k] === 'true' || c[k] === 'si' || c[k] === 1;
  if (!TIPOS[c.tipo]) c.tipo = 'indefinida';
  if (!CATEGORIAS[c.categoria]) c.categoria = 'peo';
  c.salario = c.salario === 'superior' ? 'superior' : 'conveni';
  c.salarioImporte = c.salario === 'superior' ? (Number(String(c.salarioImporte || '').replace(/\./g, '').replace(',', '.')) || null) : null;
  c.jornada = c.jornada === 'parcial' ? 'parcial' : 'completa';
  c.horasSemana = c.jornada === 'parcial' ? (Number(c.horasSemana) || null) : null;
  for (const k of ['horario', 'centro', 'domicilioSocial', 'salarioNota']) c[k] = String(c[k] || '').trim().slice(0, 200);
  return c;
}

// ── Ficha del trabajador: la que ya hay (por teléfono o DNI) o una nueva con un PIN libre ──
async function _usuario(db, { nombre, telefono, dni, fechaInicio }) {
  const d9 = String(telefono || '').replace(/\D/g, '').slice(-9);
  const us = await db.collection('users').find({}, { projection: { name: 1, whatsapp: 1, telefono: 1, 'docs.dni': 1, active: 1, nombreCompleto: 1 } }).toArray();
  const ya = us.find(u => (d9.length === 9 && [u.whatsapp, u.telefono].some(t => String(t || '').replace(/\D/g, '').slice(-9) === d9)) || (dni && limpiaDni(u.docs && u.docs.dni) === limpiaDni(dni)));
  if (ya) {
    const set = {}; if (ya.active === false) set.active = true; if (nombre && !ya.nombreCompleto) set.nombreCompleto = nombre; if (d9 && !ya.whatsapp) set.whatsapp = '+34' + d9; if (dni && !(ya.docs && ya.docs.dni)) set['docs.dni'] = limpiaDni(dni);
    if (Object.keys(set).length) await db.collection('users').updateOne({ _id: ya._id }, { $set: set });
    return String(ya._id);
  }
  const usados = new Set((await db.collection('users').find({ active: true }, { projection: { pin: 1 } }).toArray()).map(u => String(u.pin || '')));
  let pin; do { pin = String(1000 + Math.floor(Math.random() * 9000)); } while (usados.has(pin));
  const U = require('./users');
  // Coste/hora de arranque (el de la mayoría de la plantilla); se ajusta en Usuarios.
  const u = await U.createUser({ name: nombre, nombreCompleto: nombre, fechaInicio: fechaInicio || '', role: 'tecnico', pin, costeHora: Number(process.env.COSTE_HORA_NUEVO) || 15, telefono: d9 ? '+34' + d9 : '', docs: { dni: limpiaDni(dni) } });
  const id = String(u.id || u._id);
  if (d9) await db.collection('users').updateOne({ _id: new ObjectId(id) }, { $set: { whatsapp: '+34' + d9 } });
  return id;
}

// ── El formulario de Som Assessors, relleno (página 1) ──
async function rellenarFormulario(inc) {
  const { PDFDocument } = require('pdf-lib');
  const pdf = await PDFDocument.load(require('fs').readFileSync(PLANTILLA));
  const form = pdf.getForm(), c = inc.condiciones;
  const txt = (n, v) => { try { form.getTextField(n).setText(String(v == null ? '' : v)); } catch (e) {} };
  const chk = (n, on) => { try { const f = form.getCheckBox(n); on ? f.check() : f.uncheck(); } catch (e) {} };
  const [ai, mi, di] = String(inc.fechaInicio).split('-'), [ad, md, dd] = hoy().split('-');
  txt('empresa', EMPRESA.nombre); txt('nif_empresa', EMPRESA.nif); txt('domicili_social', c.domicilioSocial);
  txt('persona_treballadora', inc.nombre); txt('dni_nie', inc.dni); txt('centre_treball', c.centro);
  txt('data_inici_dia', di); txt('data_inici_mes', mi); txt('data_inici_any', ai);
  for (const [k, n] of [['indefinida', 'relacio_indefinida'], ['fixa_discontinua', 'relacio_fixa_discontinua'], ['temporal', 'relacio_temporal'], ['substitucio', 'relacio_substitucio']]) chk(n, c.tipo === k);
  for (const k of ['peo', 'oficial_3', 'oficial_1']) chk('categoria_' + k, c.categoria === k);
  chk('salari_conveni', c.salario === 'conveni'); chk('salari_superior', c.salario === 'superior');
  txt('salari_superior_import', c.salario === 'superior' && c.salarioImporte ? c.salarioImporte.toLocaleString('es-ES', { minimumFractionDigits: 2 }) : '');
  chk('incentius_no', !c.incentivos); chk('incentius_si', c.incentivos);
  chk('jornada_completa', c.jornada === 'completa'); chk('jornada_parcial', c.jornada === 'parcial'); txt('hores_setmana', c.horasSemana || '');
  txt('horari_previst', c.horario);
  chk('nocturn_no', !c.nocturno); chk('nocturn_si', c.nocturno); chk('torns_no', !c.turnos); chk('torns_si', c.turnos);
  chk('centre_habitual_si', c.centroHabitual); chk('centre_habitual_no', !c.centroHabitual);
  chk('formacio_no', !c.formacionExtra); chk('formacio_si', c.formacionExtra);
  chk('sistema_automatic_no', !c.sistemaAutomatico); chk('sistema_automatic_si', c.sistemaAutomatico);
  chk('estranger_no', !c.extranjero); chk('estranger_si', c.extranjero);
  chk('prova_15_dies', c.prueba15); chk('prova_sense', !c.prueba15);
  txt('nom_i_carrec', `${ADMIN.nombre}, administrador únic`); try { form.getTextField('nom_i_carrec').setFontSize(5.6); } catch (e) {} txt('data_decl_dia', dd); txt('data_decl_mes', md); txt('data_decl_any', ad);
  form.flatten();   // que nadie lo cambie después de firmado
  return Buffer.from(await pdf.save());
}

// Dónde va cada firma (puntos PDF, origen abajo a la izquierda): la del final de la página 3 y una rúbrica pequeña en
// las páginas 1 y 2 (Som Assessors recomienda firmar todas las páginas).
const FIRMA_EMPRESA = [{ pag: 3, x: 42, y: 172, w: 190, h: 62, sello: 'mini' }, { pag: 1, x: 445, y: 38, w: 60, h: 24, sello: false }, { pag: 2, x: 445, y: 38, w: 60, h: 24, sello: false }];
const FIRMA_TRABAJADOR = [{ pag: 3, x: 274, y: 172, w: 190, h: 62, sello: false }, { pag: 1, x: 512, y: 38, w: 60, h: 24, sello: false }, { pag: 2, x: 512, y: 38, w: 60, h: 24, sello: false }];

// Qué piezas del alta ya están en su carpeta de Personal (para no pedírselas otra vez): el DNI cuenta como las dos
// caras salvo que el nombre diga que es solo una («delante»/«detrás»).
function recibidasDe(docs = []) {
  const dni = docs.filter(d => d.tipo === 'dni'), r = {};
  for (const d of dni) {
    const n = String(d.nombre || '') + ' ' + String(d.notas || '');
    if (/delante|anverso|frontal|davant/i.test(n)) r.doc_delante = true;
    else if (/detr[aá]s|reverso|darrere/i.test(n)) r.doc_detras = true;
    else { r.doc_delante = true; r.doc_detras = true; }
  }
  if (docs.some(d => d.tipo === 'tarjeta_ss')) r.seguridad_social = true;
  return r;
}

// ── Estado de cada paso, mirando dónde está cada cosa de verdad ──
async function pasos(inc, db) {
  const P = require('./personalDocs');
  const docs = inc.userId ? await P.carpeta({ userId: inc.userId }) : [];
  const tiene = t => docs.some(d => d.tipo === t), ya = recibidasDe(docs);
  let firmas = { empresa: false, trabajador: false, enviado: false };
  if (inc.loteFirmaId) {
    const l1 = await db.collection('firmasLotes').findOne({ _id: _oid(inc.loteFirmaId) });
    const l2 = l1 && l1.luegoId ? await db.collection('firmasLotes').findOne({ _id: _oid(l1.luegoId) }) : null;
    firmas = { enviado: !!l1, empresa: !!l1 && l1.items.every(i => i.estado === 'firmado'), trabajador: !!l2 && l2.items.every(i => i.estado === 'firmado'), firmadoId: l2 && l2.items[0] && l2.items[0].firmadoId };
  }
  const u = inc.userId ? await db.collection('users').findOne({ _id: _oid(inc.userId) }, { projection: { tallas: 1, whatsapp: 1 } }) : null;
  const t = (u && u.tallas) || {};
  const consultar = CONSULTAR(inc.condiciones || {});
  const l = [
    { k: 'datos', t: 'Condiciones del contrato', ok: !!(inc.nombre && inc.dni && inc.fechaInicio && inc.confirmadas) && !consultar.length, nota: consultar.length ? `Consultar antes con Som Assessors: ${consultar.join(', ')}.` : !inc.confirmadas ? 'Falta confirmar categoría, horario y demás condiciones' : !inc.dni ? 'Falta el DNI/NIE' : null, accion: inc.confirmadas ? null : 'confirmar', antes: true },
    { k: 'ficha', t: 'Ficha del trabajador y su WhatsApp', ok: !!(inc.userId && u && u.whatsapp), antes: true },
    { k: 'papeles', t: 'DNI/NIE y número de la Seguridad Social', ok: !!(ya.doc_delante && ya.doc_detras && ya.seguridad_social), nota: 'Falta ' + [!ya.doc_delante && 'el DNI/NIE por delante', !ya.doc_detras && 'el DNI/NIE por detrás', !ya.seguridad_social && 'el nº de la Seguridad Social'].filter(Boolean).join(', '), accion: 'pedir_papeles', antes: true },
    { k: 'formulario', t: 'Formulario de elementos esenciales', ok: !!inc.formularioId, accion: 'formulario', antes: true },
    { k: 'firma_empresa', t: `Firma de ${ADMIN.nombre.split(' ')[0]} con sello`, ok: firmas.empresa, nota: firmas.enviado && !firmas.empresa ? 'Enlace enviado, falta que firme' : null, accion: 'firmas', antes: true },
    { k: 'firma_trabajador', t: 'Firma del trabajador', ok: firmas.trabajador, nota: firmas.empresa && !firmas.trabajador ? 'Enlace enviado, falta que firme' : null, antes: true },
    { k: 'gestoria', t: 'Enviado a la gestoría para el alta', ok: !!(inc.gestoria && inc.gestoria.at), accion: 'gestoria', antes: true },
    { k: 'alta', t: 'Alta en la Seguridad Social (llega de la gestoría)', ok: tiene('alta_ss'), antes: true },
    { k: 'tallas', t: 'Tallas para la ropa y los EPIs', ok: !!(t.ropa && t.pantalon && t.calzado), accion: 'tallas' },
    { k: 'reconocimiento', t: 'Reconocimiento médico (SPASS)', ok: tiene('reconocimiento') },
    { k: 'prl', t: 'Formación de PRL', ok: tiene('formacion_prl') || tiene('formacion_oficio') },
  ];
  return { lista: l, firmadoId: firmas.firmadoId || null, hechos: l.filter(x => x.ok).length, total: l.length };
}

async function _vista(inc, db) {
  const p = await pasos(inc, db);
  const quedan = inc.fechaInicio ? dias(inc.fechaInicio) : null;
  const siguiente = p.lista.find(x => !x.ok) || null;
  return { id: String(inc._id), nombre: inc.nombre, dni: inc.dni, telefono: inc.telefono, fechaInicio: inc.fechaInicio, diasParaEmpezar: quedan, condiciones: inc.condiciones, userId: inc.userId || null,
    formularioId: inc.formularioId || null, firmadoId: p.firmadoId, gestoria: inc.gestoria || null, estado: inc.estado, pasos: p.lista, hechos: p.hechos, total: p.total,
    siguiente: siguiente && siguiente.t, tarde: quedan != null && quedan <= 1 && p.lista.some(x => x.antes && !x.ok), categorias: CATEGORIAS, tipos: TIPOS };
}

async function lista({ todas = false } = {}) {
  const db = await getDB();
  const l = await db.collection(COL).find(todas ? {} : { estado: 'abierta' }).sort({ fechaInicio: 1 }).limit(100).toArray();
  return Promise.all(l.map(i => _vista(i, db)));
}
async function ver(id) { const db = await getDB(); const i = await db.collection(COL).findOne({ _id: _oid(id) }); if (!i) throw new Error('No encuentro esa incorporación'); return _vista(i, db); }

// Nueva incorporación. Con nombre, DNI, teléfono y fecha ya se pone en marcha todo lo que no depende de nadie.
async function crear(entrada = {}, por = 'Oficina', { arrancar = true } = {}) {
  const db = await getDB();
  const nombre = String(entrada.nombre || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!nombre) throw new Error('¿Cómo se llama?');
  const fechaInicio = /^\d{4}-\d{2}-\d{2}$/.test(String(entrada.fechaInicio || '')) ? entrada.fechaInicio : null;
  if (!fechaInicio) throw new Error('¿Qué día empieza?');
  const inc = { nombre, dni: limpiaDni(entrada.dni), telefono: String(entrada.telefono || '').trim(), fechaInicio, condiciones: condiciones(entrada.condiciones || entrada),
    // Las condiciones van en un papel que firman los dos: no se genera hasta que alguien las confirma (en la pantalla o diciéndolas).
    confirmadas: entrada.confirmadas === true,
    userId: null, formularioId: null, loteFirmaId: null, gestoria: null, estado: 'abierta', creadoPor: por, at: new Date(), historial: [{ at: new Date(), por, que: 'Creada' }] };
  const r = await db.collection(COL).insertOne(inc);
  const id = String(r.insertedId);
  return arrancar && entrada.arrancar !== false ? avanzar(id, por) : ver(id);
}
async function editar(id, entrada = {}, por = 'Oficina') {
  const db = await getDB(); const i = await db.collection(COL).findOne({ _id: _oid(id) }); if (!i) throw new Error('No encuentro esa incorporación');
  const set = { condiciones: condiciones(entrada.condiciones || entrada, i.condiciones) };
  if (entrada.confirmadas === true || entrada.confirmadas === false) set.confirmadas = entrada.confirmadas;
  if (entrada.nombre) set.nombre = String(entrada.nombre).trim().slice(0, 80);
  if (entrada.dni) set.dni = limpiaDni(entrada.dni);
  if (entrada.telefono) set.telefono = String(entrada.telefono).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(entrada.fechaInicio || ''))) set.fechaInicio = entrada.fechaInicio;
  // Si cambian las condiciones después de generar el formulario, hay que rehacerlo (y volver a firmarlo).
  if (i.formularioId && !(i.gestoria && i.gestoria.at)) { set.formularioId = null; set.loteFirmaId = null; }
  await db.collection(COL).updateOne({ _id: i._id }, { $set: set, $push: { historial: { at: new Date(), por, que: 'Datos cambiados' } } });
  return ver(id);
}

// Hace lo siguiente que se pueda hacer sin esperar a nadie. Se llama al crear, al editar y desde la tarea de la mañana.
async function avanzar(id, por = 'Corpy') {
  const db = await getDB(); let i = await db.collection(COL).findOne({ _id: _oid(id) });
  if (!i || i.estado !== 'abierta') return i ? _vista(i, db) : null;
  const log = que => db.collection(COL).updateOne({ _id: i._id }, { $push: { historial: { at: new Date(), por, que } } });
  // 1) ficha
  if (!i.userId && i.telefono) { const userId = await _usuario(db, i); await db.collection(COL).updateOne({ _id: i._id }, { $set: { userId } }); i.userId = userId; await log('Ficha del trabajador lista'); }
  // 2) papeles: Corpy se los pide (una vez)
  if (i.userId && !i.papelesPedidos) {
    const P = require('./personalDocs'); const docs = await P.carpeta({ userId: i.userId });
    const ya = recibidasDe(docs);
    if (!(ya.doc_delante && ya.doc_detras && ya.seguridad_social)) {
      try { await require('./docsAlta').pedir(i.userId, { por, recibidas: ya }); await log('Corpy le ha pedido lo que falta del DNI y la Seguridad Social'); } catch (e) { await log('No se pudieron pedir los papeles: ' + e.message); }
    }
    await db.collection(COL).updateOne({ _id: i._id }, { $set: { papelesPedidos: new Date() } });
    // y de paso, las tallas
    try { await require('./fichaDatos').pedir(i.userId, { por }); } catch (e) {}
  }
  // 3) formulario y 4) firmas: si están los datos y no hay que consultar nada antes con la gestoría
  if (i.userId && i.dni && i.confirmadas && !CONSULTAR(i.condiciones).length) {
    if (!i.formularioId) { await generarFormulario(String(i._id), por); i = await db.collection(COL).findOne({ _id: i._id }); }
    if (i.formularioId && !i.loteFirmaId) { await pedirFirmas(String(i._id), por); i = await db.collection(COL).findOne({ _id: i._id }); }
  }
  // 5) gestoría, solo si está activado el envío automático
  const v = await _vista(i, db);
  const listo = v.pasos.filter(p => ['papeles', 'firma_empresa', 'firma_trabajador'].includes(p.k)).every(p => p.ok);
  if (listo && !(i.gestoria && i.gestoria.at) && (await config()).autoGestoria) { await enviarGestoria(String(i._id), 'Corpy (automático)'); return ver(id); }
  return v;
}

async function generarFormulario(id, por = 'Oficina') {
  const db = await getDB(); const i = await db.collection(COL).findOne({ _id: _oid(id) });
  if (!i) throw new Error('No encuentro esa incorporación');
  if (!i.userId) throw new Error('Falta la ficha del trabajador (pon su teléfono)');
  if (!i.dni) throw new Error('Falta el DNI/NIE');
  const buf = await rellenarFormulario(i);
  const g = await require('./personalDocs').subir({ ambito: 'trabajador', userId: i.userId, tipo: 'elementos_esenciales', archivo: { buffer: buf, mimetype: 'application/pdf', originalname: `Elementos esenciales ${i.nombre} (SIN FIRMAR).pdf` }, fecha: hoy(), notas: `Inicio ${fmt(i.fechaInicio)} · ${CATEGORIAS[i.condiciones.categoria]} · ${TIPOS[i.condiciones.tipo]}`, visibleTrabajador: true }, por);
  await db.collection(COL).updateOne({ _id: i._id }, { $set: { formularioId: g.id, loteFirmaId: null }, $push: { historial: { at: new Date(), por, que: 'Formulario de elementos esenciales generado' } } });
  return g.id;
}

// Firma en cadena: primero Alfonso (empresa, con sello) y, en cuanto firma, al trabajador le llega su enlace.
async function pedirFirmas(id, por = 'Oficina') {
  const db = await getDB(); const i = await db.collection(COL).findOne({ _id: _oid(id) });
  if (!i || !i.formularioId) throw new Error('Primero hay que generar el formulario');
  const u = await db.collection('users').findOne({ _id: _oid(i.userId) }, { projection: { whatsapp: 1, telefono: 1 } });
  const r = await require('./firmaExterna').crear({
    nombre: ADMIN.nombre, telefono: ADMIN.telefono, dni: ADMIN.dni, cargo: ADMIN.cargo, sello: true, clave: 'incorporacion:' + String(i._id),
    docs: [{ docId: i.formularioId, tipoDestino: 'elementos_esenciales', firmaEn: FIRMA_EMPRESA }],
    mensaje: `Es el papel de condiciones de ${i.nombre}, que empieza el ${fmt(i.fechaInicio)}. La gestoría no le da de alta sin él firmado.`,
    luego: { nombre: i.nombre, userId: i.userId, telefono: (u && (u.whatsapp || u.telefono)) || i.telefono, dni: i.dni, cargo: 'Persona trabajadora',
      mensaje: `Son tus condiciones de trabajo en Corp Projects (empiezas el ${fmt(i.fechaInicio)}). Léelas y fírmalas, por favor.`, docs: [{ n: 0, firmaEn: FIRMA_TRABAJADOR }] },
  }, por);
  await db.collection(COL).updateOne({ _id: i._id }, { $set: { loteFirmaId: r.id }, $push: { historial: { at: new Date(), por, que: `Enlace de firma enviado a ${ADMIN.nombre.split(' ')[0]}` } } });
  return r;
}

// A Eduard: formulario firmado por los dos + DNI/NIE + Seguridad Social, pidiendo el alta para el día de inicio.
async function enviarGestoria(id, por = 'Oficina', { _enviar = null } = {}) {
  const db = await getDB(); const i = await db.collection(COL).findOne({ _id: _oid(id) });
  if (!i) throw new Error('No encuentro esa incorporación');
  const v = await _vista(i, db);
  const falta = v.pasos.filter(p => ['papeles', 'formulario', 'firma_empresa', 'firma_trabajador'].includes(p.k) && !p.ok).map(p => p.t);
  if (falta.length) throw new Error('Aún falta: ' + falta.join(', '));
  const P = require('./personalDocs');
  const docs = (await P.carpeta({ userId: i.userId })).filter(d => ['dni', 'tarjeta_ss', 'extranjeria'].includes(d.tipo));
  const adj = [];
  const firmado = await P.archivo(v.firmadoId);
  adj.push({ filename: `Elements essencials ${i.nombre} (signat).pdf`, content: Buffer.from(firmado.data.buffer || firmado.data), contentType: 'application/pdf' });
  for (const d of docs.slice(0, 6)) { const a = await P.archivo(d.id); if (a && a.data) adj.push({ filename: a.nombre || d.nombre, content: Buffer.from(a.data.buffer || a.data), contentType: a.mime || 'application/octet-stream' }); }
  const c = i.condiciones;
  const texto = `Bon dia Eduard,\n\nSol·licitem l'alta de ${i.nombre} (DNI/NIE ${i.dni}) amb data ${fmt(i.fechaInicio)}.\n\nCondicions: ${TIPOS[c.tipo]}, ${CATEGORIAS[c.categoria]}, ${c.jornada === 'completa' ? 'jornada completa' : `jornada parcial de ${c.horasSemana} h/setmana`}, salari ${c.salario === 'conveni' ? 'de conveni' : c.salarioImporte + ' € bruts anuals'}${c.prueba15 ? ', 15 dies de període de prova' : ', sense període de prova'}.\n\nAdjuntem el document d'elements essencials signat per l'empresa i pel treballador, i la seva documentació (DNI/NIE i número de la Seguretat Social).\n\nGràcies,\nCorp Projects Holding, SL`;
  const enviar = _enviar || (o => require('./notifications').sendEmail(o));
  const ok = await enviar({ to: GESTORIA, bcc: 'hola@corpprojects.es', subject: `Alta nou treballador ${fmt(i.fechaInicio)} — ${i.nombre}`, text: texto, attachments: adj });
  if (ok === false) throw new Error('No se pudo enviar el correo a la gestoría');
  await db.collection(COL).updateOne({ _id: i._id }, { $set: { gestoria: { at: new Date(), a: GESTORIA, por, adjuntos: adj.map(a => a.filename) } }, $push: { historial: { at: new Date(), por, que: `Enviado a la gestoría (${GESTORIA})` } } });
  return ver(id);
}

async function accion(id, que, por) {
  if (que === 'avanzar') return avanzar(id, por);
  if (que === 'pedir_papeles') { const i = await ver(id); if (!i.userId) throw new Error('Falta la ficha (pon su teléfono)'); await require('./docsAlta').pedir(i.userId, { por, recibidas: recibidasDe(await require('./personalDocs').carpeta({ userId: i.userId })) }); return ver(id); }
  if (que === 'ficha') { const db = await getDB(); const i = await db.collection(COL).findOne({ _id: _oid(id) }); if (!i.userId) { const userId = await _usuario(db, i); await db.collection(COL).updateOne({ _id: i._id }, { $set: { userId } }); } return ver(id); }
  if (que === 'confirmar') { const db = await getDB(); await db.collection(COL).updateOne({ _id: _oid(id) }, { $set: { confirmadas: true }, $push: { historial: { at: new Date(), por, que: 'Condiciones confirmadas' } } }); return avanzar(id, por); }
  if (que === 'formulario') { await generarFormulario(id, por); return ver(id); }
  if (que === 'firmas') { await pedirFirmas(id, por); return ver(id); }
  if (que === 'gestoria') return enviarGestoria(id, por);
  if (que === 'tallas') { const i = await ver(id); await require('./fichaDatos').pedir(i.userId, { por }); return ver(id); }
  if (que === 'hecha' || que === 'anular') { const db = await getDB(); await db.collection(COL).updateOne({ _id: _oid(id) }, { $set: { estado: que === 'hecha' ? 'hecha' : 'anulada' }, $push: { historial: { at: new Date(), por, que: que === 'hecha' ? 'Cerrada' : 'Anulada' } } }); return ver(id); }
  throw new Error('Acción no válida');
}

async function config() { const db = await getDB(); const d = await db.collection('appSettings').findOne({ key: 'incorporaciones' }); return { autoGestoria: false, ...((d && d.valor) || {}) }; }
async function setConfig(c = {}) { const db = await getDB(); const v = { autoGestoria: !!c.autoGestoria }; await db.collection('appSettings').updateOne({ key: 'incorporaciones' }, { $set: { key: 'incorporaciones', valor: v } }, { upsert: true }); return v; }

// Cada mañana: avanzar lo que se pueda y avisar a Álex de lo que va tarde (empieza en ≤ 3 días y falta algo de antes).
async function revisarManana({ _avisar = null } = {}) {
  const l = await lista(); const avisos = [];
  for (const v0 of l) {
    let v = v0; try { v = (await avanzar(v0.id, 'Corpy (mañana)')) || v0; } catch (e) { console.warn('[Incorporaciones]', e.message); }
    const pend = v.pasos.filter(p => p.antes && !p.ok);
    if (v.diasParaEmpezar != null && v.diasParaEmpezar <= 3 && pend.length) avisos.push(`• *${v.nombre}* empieza ${v.diasParaEmpezar <= 0 ? '*ya*' : v.diasParaEmpezar === 1 ? '*mañana*' : `en ${v.diasParaEmpezar} días`} (${fmt(v.fechaInicio)}). Falta: ${pend.map(p => p.t.toLowerCase()).join(', ')}.`);
  }
  if (avisos.length) await (_avisar || (t => require('./notifications').sendWhatsApp(t)))(`🧑‍🔧 *Altas de gente nueva*\n${avisos.join('\n')}\n\nhttps://dashboard.corpprojects.es/incorporaciones`);
  return { revisadas: l.length, avisos: avisos.length };
}

module.exports = { recibidasDe, lista, ver, crear, editar, avanzar, accion, generarFormulario, pedirFirmas, enviarGestoria, config, setConfig, revisarManana, rellenarFormulario, condiciones, CATEGORIAS, TIPOS, POR_DEFECTO, _consultar: CONSULTAR };
