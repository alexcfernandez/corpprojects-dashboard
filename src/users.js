// src/users.js — Gestión de usuarios, roles y accesos
const { MongoClient, ObjectId } = require('mongodb');
const crypto = require('crypto');

let db = null;

async function getDB() {
  return require('./db').getDB();
}

// ── ROLES ────────────────────────────────────────────────────────
// Roles de negocio (4 niveles) + sus capacidades. Un usuario con más
// capacidades manda sobre uno con menos. 'owner' (Dueño) lo puede todo.
//   field      → campo: partes, fichaje, presencia, mediciones, llaves
//   presupuestos, catalogo → hacer presupuestos y ver/gestionar el catálogo
//   facturas, clientes     → facturación y clientes
//   usuarios, ajustes, registro → administración del sistema (solo Dueño)
const ROLE_CAPS = {
  owner:     ['field', 'presupuestos', 'catalogo', 'facturas', 'clientes', 'usuarios', 'ajustes', 'registro'],
  oficina:   ['field', 'presupuestos', 'catalogo', 'facturas', 'clientes'],
  encargado: ['field', 'presupuestos', 'catalogo'],
  tecnico:   ['field'],
};
const ROLE_LABEL = { owner: 'Dueño', oficina: 'Oficina', encargado: 'Encargado', tecnico: 'Técnico' };
// Roles que entran por contraseña (dashboard); el resto entra por PIN/enlace.
const ROLES_PASSWORD = ['owner', 'oficina', 'encargado'];

// Normaliza roles antiguos (admin/office/tech/worker/client) a los 4 nuevos.
function normalizeRole(role) {
  const map = { admin: 'owner', office: 'oficina', tech: 'tecnico', worker: 'tecnico', client: 'tecnico',
                owner: 'owner', oficina: 'oficina', encargado: 'encargado', tecnico: 'tecnico' };
  return map[role] || 'tecnico';
}
function can(role, capability) {
  const caps = ROLE_CAPS[normalizeRole(role)];
  return !!caps && caps.includes(capability);
}
// ¿Este rol puede ver datos económicos del negocio (facturación, tesorería,
// cobros, obras, importes)? Solo Dueño y Oficina. Encargado y Técnico NO.
function canSeeMoney(role) {
  const r = normalizeRole(role);
  return r === 'owner' || r === 'oficina';
}

// Compatibilidad hacia atrás con código que aún lea el objeto ROLES antiguo.
const ROLES = {
  admin:  { label: 'Administrador', color: '#f05252', permissions: ['all'] },
  office: { label: 'Oficina',       color: '#4d9cf8', permissions: ['dashboard', 'partes', 'presencia', 'facturas', 'presupuestos'] },
  tech:   { label: 'Técnico',       color: '#22c487', permissions: ['partes_create'] },
  client: { label: 'Cliente',       color: '#a78bfa', permissions: ['invoices_read'] },
};

// ── CONTRASEÑAS (scrypt, sin dependencias externas) ──────────────
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h    = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `${salt}:${h}`;
}
function verifyPassword(pw, stored) {
  if (!stored || !String(stored).includes(':')) return false;
  const [salt, h] = String(stored).split(':');
  const hh = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  const a = Buffer.from(h, 'hex'), b = Buffer.from(hh, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function setUserPassword(id, password) {
  if (!password || String(password).length < 6) throw new Error('La contraseña debe tener al menos 6 caracteres');
  const db = await getDB();
  await db.collection('users').updateOne(
    { _id: new ObjectId(id) },
    { $set: { passwordHash: hashPassword(password), passwordAt: new Date(), updatedAt: new Date() } }
  );
  return { ok: true };
}
// Login por email/usuario + contraseña. Devuelve la identidad (el servidor
// firma el JWT). No revela si el fallo es de usuario o de contraseña.
async function loginWithPassword(login, password) {
  const db = await getDB();
  const key = String(login || '').trim().toLowerCase();
  if (!key || !password) throw new Error('Credenciales incorrectas');
  const user = await db.collection('users').findOne({
    active: true,
    $or: [{ email: { $regex: `^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } },
          { username: key }],
  });
  if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
    throw new Error('Credenciales incorrectas');
  }
  await db.collection('users').updateOne({ _id: user._id }, { $set: { lastLogin: new Date() } });
  const role = normalizeRole(user.role);
  console.log(`[Users] Login contraseña: ${user.name} (${role})`);
  return { uid: String(user._id), name: user.name, role };
}

// ── INIT — crear usuarios por defecto si no hay ninguno ──────────
async function initDefaultUsers() {
  const db    = await getDB();
  const count = await db.collection('users').countDocuments();
  if (count > 0) return;

  const CONFIG = require('./config');
  const defaultUsers = CONFIG.workersFallback.map(w => ({
    name:      w.name,
    role:      w.name === 'Paula Morales' ? 'office' : 'tech',
    pin:       w.pin,
    color:     w.color,
    costeHora: w.costeHora,
    nota:      w.nota || '',
    active:    true,
    notes:     '',
    docs:      { dni: '', carnet: '', nif: '', emergency: '' },
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLogin: null,
  }));

  for (const u of defaultUsers) {
    await db.collection('users').insertOne(u);
  }
  console.log('[Users] Usuarios iniciales creados desde config');
}

// ── CRUD USUARIOS ────────────────────────────────────────────────
async function getUsers(includeInactive = true) {
  const db    = await getDB();
  const query = includeInactive ? {} : { active: true };
  return db.collection('users').find(query).sort({ role: 1, name: 1 }).toArray();
}

async function getUser(id) {
  const db = await getDB();
  return db.collection('users').findOne({ _id: new ObjectId(id) });
}

async function createUser(data) {
  const db = await getDB();

  // Verificar PIN único
  if (data.pin) {
    const existing = await db.collection('users').findOne({ pin: data.pin, active: true });
    if (existing) throw new Error(`El PIN ${data.pin} ya está en uso por ${existing.name}`);
  }

  const role = normalizeRole(data.role);
  const user = {
    name:      data.name?.trim(),
    role,
    pin:       data.pin,
    color:     data.color    || '#4d9cf8',
    costeHora: parseFloat(data.costeHora || 0),
    nota:      data.nota     || '',
    telefono:  (data.telefono || '').trim(),
    email:     (data.email || '').trim(),
    username:  (data.username || '').trim().toLowerCase(),
    active:    true,
    notes:     data.notes    || '',
    docs: {
      dni:       data.docs?.dni       || '',
      carnet:    data.docs?.carnet    || '',
      nif:       data.docs?.nif       || '',
      emergency: data.docs?.emergency || '',
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLogin: null,
  };

  const isPassword = ROLES_PASSWORD.includes(role);              // owner/oficina/encargado → entran por contraseña
  if (!user.name) throw new Error('El nombre es obligatorio');
  if (role === 'tecnico') {
    if (!user.pin || user.pin.length < 4)       throw new Error('El PIN debe tener al menos 4 dígitos');
    if (!user.costeHora || user.costeHora <= 0) throw new Error('El coste/hora es obligatorio');
  }
  if (isPassword && !user.email && !user.username) {
    throw new Error('Una cuenta de Dueño/Oficina/Encargado necesita un email (es su usuario para entrar)');
  }
  if (data.password) user.passwordHash = hashPassword(data.password);

  const result = await db.collection('users').insertOne(user);
  console.log(`[Users] Nuevo usuario: ${user.name} (${user.role}) — ${user.costeHora}€/h`);

  // Invalidar caché de workers en attendance
  try { require('./attendance')._invalidateWorkersCache?.(); } catch(e) {}

  return { id: result.insertedId, ...user };
}

async function updateUser(id, data) {
  const db      = await getDB();
  const allowed = ['name','role','pin','color','costeHora','nota','active','notes','docs','telefono','email','username'];
  const set     = { updatedAt: new Date() };
  allowed.forEach(k => { if (data[k] !== undefined) set[k] = data[k]; });

  // Parsear costeHora como número
  if (set.costeHora !== undefined) set.costeHora = parseFloat(set.costeHora || 0);
  // Normalizar rol a los 4 nuevos
  if (set.role !== undefined) set.role = normalizeRole(set.role);
  if (set.username !== undefined) set.username = String(set.username || '').trim().toLowerCase();
  // Contraseña (opcional): se guarda cifrada, nunca en claro
  if (data.password) set.passwordHash = hashPassword(data.password);

  // Si cambia PIN, verificar que no esté en uso
  if (data.pin) {
    const existing = await db.collection('users').findOne({
      pin: data.pin, active: true, _id: { $ne: new ObjectId(id) }
    });
    if (existing) throw new Error(`El PIN ${data.pin} ya está en uso por ${existing.name}`);
  }

  const result = await db.collection('users').updateOne({ _id: new ObjectId(id) }, { $set: set });

  // Invalidar caché de workers en attendance para que el nuevo costeHora se aplique
  try { require('./attendance')._invalidateWorkersCache?.(); } catch(e) {}

  return result;
}

async function deactivateUser(id) {
  const db = await getDB();
  await db.collection('user_sessions').deleteMany({ userId: id });
  const result = await db.collection('users').updateOne(
    { _id: new ObjectId(id) },
    { $set: { active: false, updatedAt: new Date() } }
  );

  // Invalidar caché de workers para que Presencia/Partes dejen de mostrarlo
  try { require('./attendance')._invalidateWorkersCache?.(); } catch(e) {}

  return result;
}

// ── AUTENTICACIÓN ─────────────────────────────────────────────────
async function loginWithPin(pin) {
  const db   = await getDB();
  const user = await db.collection('users').findOne({ pin, active: true });
  if (!user) throw new Error('PIN incorrecto o usuario inactivo');

  const token     = `u_${crypto.randomBytes(24).toString('hex')}`;
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await db.collection('user_sessions').insertOne({
    token, userId: String(user._id), userRole: user.role,
    userName: user.name, createdAt: new Date(), expiresAt
  });

  await db.collection('users').updateOne(
    { _id: user._id },
    { $set: { lastLogin: new Date() } }
  );

  console.log(`[Users] Login: ${user.name} (${user.role})`);
  return { token, userId: String(user._id), userName: user.name, role: user.role, color: user.color };
}

async function verifyUserToken(token) {
  if (!token || !token.startsWith('u_')) return null;
  const db      = await getDB();
  const session = await db.collection('user_sessions').findOne({
    token, expiresAt: { $gt: new Date() }
  });
  return session || null;
}

async function logout(token) {
  const db = await getDB();
  return db.collection('user_sessions').deleteOne({ token });
}

// ── PERMISOS ──────────────────────────────────────────────────────
function hasPermission(role, permission) {
  const roleData = ROLES[role];
  if (!roleData) return false;
  if (roleData.permissions.includes('all')) return true;
  return roleData.permissions.includes(permission);
}

// ── Enlace mágico (login sin PIN por token, para onboarding y recordatorios) ──
// Reutiliza el token si ya existe (idempotente: copiar y enviar dan el MISMO
// enlace). Con regen=true fuerza uno nuevo (invalida el anterior).
async function ensureMagicToken(id, regen) {
  const db = await getDB();
  const u0 = await db.collection('users').findOne({ _id: new ObjectId(id) });
  if (u0 && u0.magicToken && !regen) return { token: u0.magicToken, user: u0 };
  const token = 'm_' + crypto.randomBytes(20).toString('hex');
  await db.collection('users').updateOne({ _id: new ObjectId(id) }, { $set: { magicToken: token, magicTokenAt: new Date() } });
  const user = await db.collection('users').findOne({ _id: new ObjectId(id) });
  return { token, user };
}
async function getUserByMagicToken(token) {
  if (!token || !String(token).startsWith('m_')) return null;
  const db = await getDB();
  return db.collection('users').findOne({ magicToken: String(token), active: true });
}

module.exports = {
  ROLES, ROLE_CAPS, ROLE_LABEL, ROLES_PASSWORD, normalizeRole, can, canSeeMoney,
  initDefaultUsers,
  getUsers, getUser, createUser, updateUser, deactivateUser,
  loginWithPin, verifyUserToken, logout, hasPermission,
  ensureMagicToken, getUserByMagicToken,
  setUserPassword, loginWithPassword,
};
