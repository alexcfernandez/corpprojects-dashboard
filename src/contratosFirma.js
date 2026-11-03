// src/contratosFirma.js — CONTRATOS DE TRABAJO A FIRMAR (4/11/2026). Álex: «cuando recibimos el contrato, lo tiene que
// recibir el trabajador en el WhatsApp y decir: firma esto».
//   · pedirFirma: el contrato (PDF en Personal del trabajador) → firma por enlace en cadena (firmaExterna): primero la
//     empresa (Alfonso, con sello) y, en cuanto firma, al trabajador le llega su enlace por WhatsApp.
//   · alFirmar: cuando han firmado los dos, la copia firmada queda en Personal (tipo contrato) y se deja un BORRADOR a la
//     gestoría en Gmail (nunca se envía solo) y se avisa a Álex.
//   · desdeCorreo: contratos que manda la gestoría (somassessors) por correo → pedirFirma. Los de Word no se pueden firmar
//     con el dedo: se avisa a Álex para que los pase a PDF.
// Se apaga con CONTRATOS_FIRMA=off (la parte automática del correo).
'use strict';
const { ObjectId } = require('mongodb');
async function getDB() { return require('./db').getDB(); }
const ADMIN = { nombre: process.env.ADMIN_NOMBRE || 'Alfonso Gálvez Cámara', telefono: process.env.ADMIN_TELEFONO || '+34692270438', dni: process.env.ADMIN_DNI || '40347979E', cargo: 'Administrador único' };
const GESTORIA = process.env.GESTORIA_ALTAS_EMAIL || 'eduard@somassessors.com';
const RE_CONTRATO = /contract|contrat/i;

async function pedirFirma({ userId, docId, por = 'Oficina', at = null }, { _crear = null } = {}) {
  const db = await getDB();
  const u = await db.collection('users').findOne({ _id: new ObjectId(String(userId)) }, { projection: { name: 1, nombreCompleto: 1, whatsapp: 1, telefono: 1, docs: 1 } });
  if (!u) throw new Error('No encuentro al trabajador');
  const tel = u.whatsapp || u.telefono;
  if (!tel) throw new Error(`${u.name} no tiene móvil en su ficha`);
  const ya = await db.collection('firmasLotes').findOne({ 'items.docId': String(docId), estado: { $in: ['pendiente', 'firmado'] } }, { projection: { _id: 1 } });
  if (ya) return { yaPedido: true, id: String(ya._id) };
  const nombre = u.nombreCompleto || u.name, primero = String(nombre).split(/\s+/)[0];
  return (_crear || ((o, p, d) => require('./firmaExterna').crear(o, p, d)))({
    nombre: ADMIN.nombre, telefono: ADMIN.telefono, dni: ADMIN.dni, cargo: ADMIN.cargo, sello: true, importante: true, clave: 'contrato:' + String(userId),
    docs: [{ docId: String(docId), tipoDestino: 'contrato' }],
    mensaje: `Es el contrato de trabajo de ${nombre}. Fírmalo y después le llega a ${primero} para que lo firme.`,
    luego: { nombre, userId: String(userId), telefono: tel, dni: (u.docs || {}).dni || '', cargo: 'Persona trabajadora', mensaje: `Hola ${primero}, es tu contrato de trabajo con Corp Projects. Léelo y fírmalo, por favor.`, docs: [{ n: 0 }] },
    alFinal: { tipo: 'contrato_gestoria', userId: String(userId), nombre },
  }, por, at ? { _enviar: async () => true } : {});
}

// La cadena ha terminado (lote del trabajador firmado entero): borrador a la gestoría + aviso a Álex.
async function alFirmar(lote, { _borrador = null, _avisar = null } = {}) {
  const f = lote.alFinal || {}; const P = require('./personalDocs');
  const adj = [];
  for (const it of lote.items || []) {
    if (!it.firmadoId) continue;
    const a = await P.archivo(it.firmadoId);
    if (a && a.data) adj.push({ filename: String(a.nombre || 'contracte.pdf').replace(/\s*\(firmado por[^)]*\)/i, ' (signat)'), content: Buffer.from(a.data.buffer || a.data), contentType: 'application/pdf' });
  }
  const db = await getDB();
  const u = f.userId ? await db.collection('users').findOne({ _id: new ObjectId(f.userId) }, { projection: { docs: 1 } }) : null;
  const dni = (u && u.docs && u.docs.dni) || lote.dni || '';
  const texto = `Bon dia Eduard,\n\nUs adjuntem el contracte signat per l'empresa i per ${f.nombre || lote.nombre}${dni ? ` (DNI/NIE ${dni})` : ''} perquè el tramiteu.\n\nGràcies,\n\nCorp Projects Holding, S.L.\nhola@corpprojects.es`;
  const r = await (_borrador || _borradorGmail)({ to: GESTORIA, bcc: 'hola@corpprojects.es', subject: `Contracte signat — ${f.nombre || lote.nombre}`, text: texto, attachments: adj });
  try { await (_avisar || require('./notifications').sendWhatsApp)(`📝 *Contrato de ${f.nombre || lote.nombre}* firmado por Alfonso y por el trabajador. Está en Personal y el correo a Eduard está en *borradores* de Gmail, listo para enviar${r && r.url ? `:\n${r.url}` : '.'}`); } catch (e) {}
  return r;
}

async function _borradorGmail({ to, bcc, subject, text, attachments }) {
  const MailComposer = require('nodemailer/lib/mail-composer');
  const raw = await new Promise((ok, ko) => new MailComposer({ from: 'Corp Projects <hola@corpprojects.es>', to, bcc, subject, text, attachments }).compile().build((e, m) => e ? ko(e) : ok(m)));
  const g = require('./email-intelligence').getGmailClient();
  const d = await g.users.drafts.create({ userId: 'me', requestBody: { message: { raw: raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') } } });
  return { id: d.data.id, url: `https://mail.google.com/mail/?authuser=corpprojectsholding@gmail.com#drafts` };
}

// Correo de la gestoría con contratos: los PDF ya los guarda docsCorreo como «contrato» del trabajador; aquí se pide la
// firma de cada uno. Los Word se avisan (no se pueden firmar con el dedo).
const esGestoria = de => /somassessors/i.test(String(de || ''));
function contratosWord(adjuntos) { return (adjuntos || []).filter(a => /\.docx?$/i.test(a.filename || '') && RE_CONTRATO.test(a.filename || '')); }
async function desdeCorreo({ de, asunto, adjuntos, guardados = [] }, { _pedir = null, _avisar = null } = {}) {
  if (process.env.CONTRATOS_FIRMA === 'off' || !esGestoria(de)) return { nada: true };
  const pedidos = [];
  for (const g of guardados) {
    if (g.tipo !== 'contrato' || !g.userId || !g.id) continue;
    try { const r = await (_pedir || pedirFirma)({ userId: g.userId, docId: g.id, por: 'Correo de la gestoría' }); pedidos.push({ ...g, r }); }
    catch (e) { console.warn('[Contratos] pedir firma:', e.message); }
  }
  const word = contratosWord(adjuntos);
  const t = [];
  if (pedidos.length) t.push(`📝 Ha llegado de la gestoría ${pedidos.length === 1 ? 'un contrato' : pedidos.length + ' contratos'} (${pedidos.map(p => p.nombre || '').filter(Boolean).join(', ')}): le he mandado a Alfonso el enlace para firmar; luego le llega al trabajador.`);
  if (word.length) t.push(`📄 La gestoría ha mandado ${word.map(w => '«' + w.filename + '»').join(', ')} en Word («${String(asunto || '').slice(0, 60)}»). Para firmarlo con el dedo hace falta en PDF: ábrelo, guárdalo como PDF y súbelo en Personal del trabajador como «Contrato».`);
  if (t.length) { try { await (_avisar || require('./notifications').sendWhatsApp)(t.join('\n\n')); } catch (e) {} }
  return { pedidos: pedidos.length, word: word.length };
}

module.exports = { pedirFirma, alFirmar, desdeCorreo, contratosWord, ADMIN };
