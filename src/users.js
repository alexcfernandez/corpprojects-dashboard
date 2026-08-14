// src/users.js — Gestión de usuarios, roles y accesos
const { MongoClient, ObjectId } = require('mongodb');
const crypto = require('crypto');

let db = null;

async function getDB() {
  return require('./db').getDB();
}

// ── ROLES ────────────────────────────────────────────────────────
const ROLES = {
  admin:  { label: 'Administrador', color: '#f05252', permissions: ['all'] },
  office: { label: 'Oficina',       color: '#4d9cf8', permissions: ['dashboard', 'partes', 'presencia', 'facturas', 'presupuestos'] },
  tech:   { label: 'Técnico',       color: '#22c487', permissions: ['partes_create'] },
  client: { label: 'Cliente',       color: '#a78bfa', permissions: ['invoices_read'] },
};

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

  const user = {
    name:      data.name?.trim(),
    role:      data.role     || 'tech',
    pin:       data.pin,
    color:     data.color    || '#4d9cf8',
    costeHora: parseFloat(data.costeHora || 0),
    nota:      data.nota     || '',
    telefono:  (data.telefono || '').trim(),
    email:     (data.email || '').trim(),
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

  if (!user.name)                        throw new Error('El nombre es obligatorio');
  if (!user.pin || user.pin.length < 4)  throw new Error('El PIN debe tener al menos 4 dígitos');
  if (!user.costeHora || user.costeHora <= 0) throw new Error('El coste/hora es obligatorio');

  const result = await db.collection('users').insertOne(user);
  console.log(`[Users] Nuevo usuario: ${user.name} (${user.role}) — ${user.costeHora}€/h`);

  // Invalidar caché de workers en attendance
  try { require('./attendance')._invalidateWorkersCache?.(); } catch(e) {}

  return { id: result.insertedId, ...user };
}

async function updateUser(id, data) {
  const db      = await getDB();
  const allowed = ['name','role','pin','color','costeHora','nota','active','notes','docs','telefono','email'];
  const set     = { updatedAt: new Date() };
  allowed.forEach(k => { if (data[k] !== undefined) set[k] = data[k]; });

  // Parsear costeHora como número
  if (set.costeHora !== undefined) set.costeHora = parseFloat(set.costeHora || 0);

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
  ROLES, initDefaultUsers,
  getUsers, getUser, createUser, updateUser, deactivateUser,
  loginWithPin, verifyUserToken, logout, hasPermission,
  ensureMagicToken, getUserByMagicToken,
};
