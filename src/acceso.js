// src/acceso.js — Control de acceso del asistente de WhatsApp.
//
// PRINCIPIO IRRENUNCIABLE: la identidad se decide SIEMPRE por el NÚMERO (el
// canal), JAMÁS por lo que diga el texto del mensaje.
//
//   • OWNER (tú)      → todo. Las acciones que tocan DINERO piden PIN + confirmación.
//   • client/office   → según su número (contacto guardado o teléfono de StelOrder).
//   • desconocido     → no da datos; avisa al owner.
//
// El OWNER se resuelve SOLO con la variable de entorno OWNER_NUMBERS, con una
// comparación puramente síncrona y sin tocar la base de datos, para que sea
// IMPOSIBLE que un fallo de BD/StelOrder deje al owner fuera.

// ── Colección de estado del gate de dinero (PIN + confirmación) ──
const COL = 'accesoAsistente';           // { from, stage, comando, pinOkUntil, ts }
const VENTANA_PIN = 10 * 60 * 1000;      // 10 min: no vuelve a pedir PIN dentro de la ventana
const TTL_PENDIENTE = 15 * 60 * 1000;    // un comando pendiente caduca a los 15 min

async function getDB() { return require('./db').getDB(); }

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

// +34XXXXXXXXX sin prefijo whatsapp: ni separadores
function normalizarNumero(from) {
  return String(from || '').replace(/^whatsapp:/i, '').replace(/[\s\-()]/g, '').trim();
}
// Últimos 9 dígitos (número nacional), robusto a prefijos/formatos
function ultimos9(num) {
  const d = String(num || '').replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : d;
}

// ── OWNER: SOLO por env, síncrono, nunca lanza. Imposible dejarlo fuera. ──
// Se consideran owner los números de OWNER_NUMBERS y, como RED DE SEGURIDAD
// para que el dueño no quede JAMÁS fuera aunque olvide configurar OWNER_NUMBERS,
// también MI_WHATSAPP y WHATSAPP_TO (que ya identifican al dueño del bot).
function ownersConfigurados() {
  const fuentes = [
    process.env.OWNER_NUMBERS || '',
    process.env.MI_WHATSAPP || '',
    process.env.WHATSAPP_TO || '',
  ];
  return fuentes.join(',').split(',').map(s => s.trim()).filter(Boolean);
}

function esOwner(from) {
  try {
    const num = normalizarNumero(from);
    if (!num) return false;
    const dig = ultimos9(num);
    const owners = ownersConfigurados();
    for (const o of owners) {
      const on = normalizarNumero(o);
      if (on && on === num) return true;                 // coincidencia exacta
      const od = ultimos9(on);
      if (od && dig && od === dig) return true;           // coincidencia por últimos 9 dígitos
    }
    return false;
  } catch (e) { return false; }
}

// ── Identidad completa (para NO-owner): número → contacto/StelOrder → desconocido ──
async function resolverIdentidad(from) {
  const num = normalizarNumero(from);

  // a) OWNER (se comprueba también aquí por completitud)
  if (esOwner(from)) return { rol: 'owner', numero: num, nombre: 'Owner' };

  // b) Mapa manual de contactos (colección 'contactos')
  try {
    const db = await getDB();
    const c = await db.collection('contactos').findOne({ numero: num });
    if (c) return {
      rol: c.rol || 'client', numero: num,
      familia: c.familia || null, clienteId: c.clienteId || null, nombre: c.nombre || ''
    };
  } catch (e) { /* si falla la BD, seguimos intentando por StelOrder */ }

  // c) Casar el número con el teléfono de un cliente de StelOrder → su familia
  try {
    const { clientMap } = await require('./stelorder').getClients();
    const dig = ultimos9(num);
    if (dig) {
      for (const [id, ci] of Object.entries(clientMap || {})) {
        const tel = ultimos9(String(ci.phone || ci.telefono || ''));
        if (tel && tel === dig) {
          return { rol: 'client', numero: num, familia: ci.family || null, clienteId: id, nombre: ci.name || '' };
        }
      }
    }
  } catch (e) { /* StelOrder puede fallar: caemos a desconocido */ }

  // d) Desconocido
  return { rol: 'desconocido', numero: num };
}

// ── Clasifica la acción pedida: 'lectura' | 'escritura' | 'dinero' ──
// CRITERIO (aclarado por el dueño):
//   • "paga a X 100€" NO es un pago real → es un APUNTE interno → escritura, sin PIN.
//   • Crear un presupuesto/pedido/incidencia NUEVO es un ALTA → escritura, sin PIN.
//   • DINERO (PIN + confirmación) = SOLO modificar el importe de un presupuesto/
//     factura que YA existe: subir/bajar %, abaratar, cambiar precio/importe/total,
//     añadir partida a un presupuesto existente.
function clasificarAccion(texto) {
  const n = norm(texto);

  // Verbos de MODIFICAR el importe de un documento que YA existe.
  const modificaImporte =
    /\b(baja|bajar|bajad\w*|rebaj\w*|sube|subir|subid\w*|descuent\w*|abarat\w*)\b/.test(n) ||
    /\bmas barat\w*/.test(n) ||
    /\b(modifica|corrige|recalcula|cambia|rehaz|rehaga)\b[\s\S]*\b(precio|importe|total|presup\w*|factura|partida)\b/.test(n) ||
    /\b(anade|añade|agrega|mete)\b[\s\S]*\bpartida\b/.test(n);

  const objetoDoc  = /\b(presup\w*|factura)\b/.test(n);
  const importePct = /€|\beur\w*\b|\b\d+\s*%/.test(n);

  // Crear un presupuesto/pedido/incidencia NUEVO o apuntar un pago a trabajador
  // NO es 'dinero' aunque lleve importe: es alta/apunte (solo owner, sin PIN).
  const esCreacion = /\b(crea\w*|nuev[oa]\w*|genera\w*|prepara\w*)\b/.test(n) || /\bhaz\w*\s+(un|una)\b/.test(n);

  // El IVA es un flujo de escritura EXISTENTE (handlerCambioIva): NUNCA es 'dinero'.
  const esIva = /\biva\b/.test(n);

  // Las FACTURAS emitidas NO se editan por API (Fase 2): no es 'dinero'. Se responde
  // con la verdad (rectificativa a mano) en el router, no se arranca el flujo de PIN.
  const esFacturaSolo = /\bfactura/.test(n) && !/\bpresup/.test(n);

  // DINERO = modificar el importe de un PRESUPUESTO EXISTENTE (owner + PIN).
  if (modificaImporte && (objetoDoc || importePct) && !esCreacion && !esIva && !esFacturaSolo) return 'dinero';

  // Cambio de IVA sobre un documento → escritura (owner, sin PIN).
  if (esIva && /\b(cambia\w*|modifica\w*|pon|ponle|sube\w*|subir|baja\w*|bajar|actualiza\w*|corrige)\b/.test(n))
    return 'escritura';

  // ESCRITURA (solo owner, sin PIN): altas, apuntes, notas, presencia.
  if (/\b(crea\w*|nueva incidencia|nuevo aviso|genera\w*|nuevo presup\w*|haz\w*\s+presup\w*|prepara\w*\s+presup\w*|paga|pagar|pagale|pagales|abona|abonar|adelanta|adelantale|apunta|anota|recuerda|guarda|borra|elimina|quita|olvida)\b/.test(n))
    return 'escritura';

  return 'lectura';
}

// ── Segundo factor (PIN) + confirmación para DINERO ──────────────
function resumenConfirm(comando) {
  return `📝 Voy a ejecutar esta acción sobre *dinero*:\n\n“${String(comando || '').slice(0, 220)}”\n\n¿Confirmo? Responde *sí* o *no*.`;
}

// ¿Hay algún PIN configurado (env OWNER_PIN o un admin con PIN en users)?
async function pinConfigurado() {
  if (process.env.OWNER_PIN && String(process.env.OWNER_PIN).trim().length >= 4) return true;
  try {
    const db = await getDB();
    const u = await db.collection('users').findOne({ role: 'admin', active: true, pin: { $exists: true, $ne: null } });
    return !!u;
  } catch (e) { return false; }
}

// Valida un PIN contra env OWNER_PIN o contra un usuario admin activo.
async function validarPin(pin) {
  pin = String(pin || '').trim();
  if (!pin) return false;
  if (process.env.OWNER_PIN && pin === String(process.env.OWNER_PIN).trim()) return true;
  try {
    const db = await getDB();
    const u = await db.collection('users').findOne({ pin, active: true });
    return !!(u && u.role === 'admin');
  } catch (e) { return false; }
}

async function pinValidadoReciente(from) {
  try {
    const db = await getDB();
    const doc = await db.collection(COL).findOne({ from: normalizarNumero(from) });
    return !!(doc && doc.pinOkUntil && new Date(doc.pinOkUntil).getTime() > Date.now());
  } catch (e) { return false; }
}

async function limpiar(from) {
  try {
    const db = await getDB();
    await db.collection(COL).updateOne(
      { from: normalizarNumero(from) },
      { $set: { stage: null, comando: null, ts: new Date() } }
    );
  } catch (e) { /* no romper por el estado */ }
}

// Arranca el flujo de dinero: guarda el comando y pide PIN (o directamente
// confirmación si el PIN es reciente o si NO hay ningún PIN configurado —
// en ese caso NO bloqueamos al owner, solo pedimos confirmación explícita).
async function iniciarDinero(from, texto, resumen = null) {
  const f = normalizarNumero(from);
  const reciente = await pinValidadoReciente(from);
  const hayPin = await pinConfigurado();
  const stage = (!reciente && hayPin) ? 'await_pin' : 'await_confirm';
  const confirmMsg = resumen || resumenConfirm(texto); // resumen precomputado (dry-run) o eco genérico
  try {
    const db = await getDB();
    await db.collection(COL).updateOne(
      { from: f },
      { $set: { from: f, stage, comando: String(texto || ''), resumen: resumen || null, ts: new Date() } },
      { upsert: true }
    );
  } catch (e) {
    // Si no podemos ni guardar el estado, seguimos pidiendo confirmación en línea
    // (mejor pedir confirmación que ejecutar dinero sin control).
    return { mensaje: confirmMsg };
  }
  if (stage === 'await_pin') return { mensaje: '🔐 Esta acción toca *dinero*. Para continuar, envíame tu *PIN* (solo los dígitos), o escribe *no* para cancelar.' };
  return { mensaje: confirmMsg };
}

// Procesa la respuesta del owner cuando hay un comando de dinero pendiente.
// Devuelve:
//   { tipo:'mensaje', mensaje }   → responder eso y esperar
//   { tipo:'ejecutar', comando }  → confirmado: ejecutar el comando guardado
//   null                          → no había nada pendiente (flujo normal)
async function respuestaPendiente(from, texto) {
  let db, doc;
  try {
    db = await getDB();
    doc = await db.collection(COL).findOne({ from: normalizarNumero(from) });
  } catch (e) { return null; }
  if (!doc || !doc.stage) return null;

  // Caducidad del comando pendiente
  if (doc.ts && (Date.now() - new Date(doc.ts).getTime()) > TTL_PENDIENTE) {
    await limpiar(from);
    return null;
  }

  const n = norm(texto);

  // Cancelar en cualquier etapa
  if (/^(no|cancela|anula|dejalo|dejadlo|para|mejor no|ahora no|olvida(lo)?)\b/.test(n)) {
    await limpiar(from);
    return { tipo: 'mensaje', mensaje: '👍 Cancelado. No he tocado nada.' };
  }

  if (doc.stage === 'await_pin') {
    const posiblePin = (String(texto).match(/\b(\d{4,8})\b/) || [])[1];
    if (!posiblePin) return { tipo: 'mensaje', mensaje: 'Para confirmar esta acción envíame tu *PIN* (4–8 dígitos), o escribe *no* para cancelar.' };
    const ok = await validarPin(posiblePin);
    if (!ok) return { tipo: 'mensaje', mensaje: '❌ PIN incorrecto. Inténtalo de nuevo o escribe *no* para cancelar.' };
    try {
      await db.collection(COL).updateOne(
        { _id: doc._id },
        { $set: { stage: 'await_confirm', pinOkUntil: new Date(Date.now() + VENTANA_PIN), ts: new Date() } }
      );
    } catch (e) { /* si no persiste, igualmente pedimos confirmación */ }
    return { tipo: 'mensaje', mensaje: doc.resumen || resumenConfirm(doc.comando) };
  }

  if (doc.stage === 'await_confirm') {
    if (/^(s[ií]|si|vale|ok|dale|confirmo|adelante|correcto|hazlo|hazla|apruebo)\b/.test(n)) {
      const comando = doc.comando;
      try {
        await db.collection(COL).updateOne(
          { _id: doc._id },
          { $set: { stage: null, comando: null, ts: new Date() } }   // conserva pinOkUntil (ventana)
        );
      } catch (e) { /* seguimos y ejecutamos */ }
      return { tipo: 'ejecutar', comando };
    }
    return { tipo: 'mensaje', mensaje: 'Responde *sí* para ejecutar o *no* para cancelar.\n\n' + (doc.resumen || resumenConfirm(doc.comando)) };
  }

  return null;
}

// Compat con la nomenclatura del spec
async function pedirPin(from, texto) {
  const g = await iniciarDinero(from, texto);
  return g && g.mensaje ? g.mensaje : '🔐 Para confirmar esta acción, envíame tu PIN.';
}

module.exports = {
  // identidad
  esOwner, resolverIdentidad, normalizarNumero, ultimos9,
  // clasificación
  clasificarAccion,
  // PIN + confirmación de dinero
  iniciarDinero, respuestaPendiente, pinValidadoReciente, pinConfigurado, validarPin, pedirPin,
};
