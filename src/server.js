// src/server.js v3
require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt       = require('jsonwebtoken');
const path      = require('path');
const multer    = require('multer');
const fs        = require('fs');
const { google } = require('googleapis');
const { MongoClient, ObjectId } = require('mongodb');

const {
  getSummary, getPendingInvoices, getInvoices, getClients,
  getEstimatesSummary, getFamiliesSummary, getAccountCategories, clearCache,
  sendInvoiceByEmail, findInvoiceIdByNumber
} = require('./stelorder');
const { sendWhatsApp, sendEmail } = require('./notifications');
const { startScheduler, checkPendingInvoices, runDailySummary, sendReminders, sendManual } = require('./scheduler');

const app  = express();
const PORT = process.env.PORT || 3000;

// Seguridad: sin JWT_SECRET no arrancamos. Antes se firmaba con la palabra
// 'fallback' (pública), lo que permitiría falsificar tokens de admin.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[FATAL] Falta JWT_SECRET en las variables de entorno. Configúrala en Railway antes de arrancar.');
  process.exit(1);
}

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: ['https://dashboard.corpprojects.es','http://localhost:3000',
           'https://corpprojects-dashboard-production.up.railway.app']
}));
app.use(express.json());

const UPLOADS_DIR = path.join(__dirname, '../uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => cb(null, `bank_${Date.now()}.xlsx`)
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 15 }
});

app.use(express.static(path.join(__dirname, '../public')));

const limiter = rateLimit({ windowMs: 15*60*1000, max: 300, message: { error: 'Rate limit.' } });
app.use('/api/', limiter);
const loginLimiter = rateLimit({ windowMs: 15*60*1000, max: 20, message: { error: 'Demasiados intentos.' } });

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Token inválido' }); }
}

// Usa la conexión única compartida (src/db.js). Mantiene el contrato
// { db, client } para no romper las rutas existentes; client.close() es
// un no-op porque la conexión con pool se reutiliza, no se cierra.
const sharedDb = require('./db');
async function getDB() {
  return sharedDb.getDBLegacy();
}

// ===== OAUTH GMAIL =====
const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  process.env.GMAIL_REDIRECT_URI
);

app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify'
    ]
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    res.json(tokens);
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ── Públicas ──────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status:'ok', service:'Corp Projects Dashboard',
  timestamp: new Date().toISOString(), uptime: Math.round(process.uptime())+'s'
}));

app.post('/api/login', loginLimiter, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Contraseña requerida' });
  if (password !== process.env.DASHBOARD_PASSWORD)
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  const token = jwt.sign({ user:'admin' }, JWT_SECRET, { expiresIn:'24h' });
  res.json({ token, expiresIn:'24h' });
});

// ── StelOrder ─────────────────────────────────────────────────────
app.get('/api/summary',            requireAuth, async (req,res) => res.json(await getSummary()));
app.get('/api/invoices/pending',   requireAuth, async (req,res) => res.json(await getPendingInvoices()));
app.get('/api/invoices',           requireAuth, async (req,res) => res.json(await getInvoices()));
app.get('/api/clients',            requireAuth, async (req,res) => { const {clients} = await getClients(); res.json(clients); });
app.get('/api/estimates',          requireAuth, async (req,res) => res.json(await getEstimatesSummary()));
app.get('/api/families',           requireAuth, async (req,res) => res.json(await getFamiliesSummary()));
app.get('/api/families/list',      requireAuth, async (req,res) => { const {list} = await getAccountCategories(); res.json(list); });

// Vaciar la caché de StelOrder bajo demanda (botón "Actualizar" del dashboard)
app.post('/api/stelorder/refresh', requireAuth, (req,res) => { clearCache(); res.json({ ok:true, message:'Datos actualizados desde StelOrder' }); });

// ── Responsables por familia (a quién van los avisos de cada familia) ──
const avisos = require('./avisos');

app.get('/api/family-contacts', requireAuth, async (req, res) => {
  try {
    const { list } = await getAccountCategories();
    const map = await avisos.getFamilyContactMap();
    const names = (list || []).map(f => f.name).filter(Boolean);
    if (!names.includes('Sin familia')) names.push('Sin familia');
    res.json(names.map(name => {
      const c = map[name] || {};
      return {
        family: name,
        email:  c.email || '',
        paused: !!c.paused,
        freq:   c.freq   || 'manual',
        format: c.format || 'grouped'
      };
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/family-contacts', requireAuth, async (req, res) => {
  try {
    const { family, email, paused, freq, format } = req.body;
    if (!family) return res.status(400).json({ error: 'Falta la familia' });
    const saved = await avisos.setFamilyContact(family, { email, paused, freq, format });
    res.json(saved);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Pausa global de avisos (interruptor de emergencia)
app.get('/api/avisos-status', requireAuth, async (req, res) => {
  try { res.json({ globalPaused: await avisos.isGlobalPaused() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/avisos-status', requireAuth, async (req, res) => {
  try { res.json({ globalPaused: await avisos.setGlobalPaused(!!req.body.paused) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Enviar la factura OFICIAL por StelOrder (sendDocument). Prueba controlada.
// Acepta { number, email } o { invoiceId, email }.
app.post('/api/invoice/send-official', requireAuth, async (req, res) => {
  try {
    const { number, invoiceId, email } = req.body;
    if (!email) return res.status(400).json({ error: 'Falta el email de destino' });
    let id = invoiceId;
    if (!id && number) id = await findInvoiceIdByNumber(number);
    if (!id) return res.status(404).json({ error: `No se encontró la factura ${number || ''}`.trim() });
    const r = await sendInvoiceByEmail(id, email);
    res.json({ message: `✓ StelOrder envió la factura (ID ${id}) a ${email}`, ...r });
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    res.status(500).json({ error: `StelOrder respondió ${status || ''}: ${detail}`.trim() });
  }
});

// Enviar AHORA un resumen agrupado a cada familia con responsable
app.post('/api/send-family-summaries', requireAuth, async (req, res) => {
  try {
    const r = await sendManual('grouped');
    const message = r.paused
      ? '⏸ Envíos en pausa global — no se ha enviado nada.'
      : `Resúmenes enviados: ${r.sent} · omitidos: ${r.skipped}`;
    res.json({ message, ...r });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Enviar AHORA las facturas una a una (individual) a cada familia con responsable
app.post('/api/send-family-individual', requireAuth, async (req, res) => {
  try {
    const r = await sendManual('individual');
    const message = r.paused
      ? '⏸ Envíos en pausa global — no se ha enviado nada.'
      : `Familias avisadas (individual): ${r.sent} · omitidas: ${r.skipped}`;
    res.json({ message, ...r });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/invoices/by-family/:family', requireAuth, async (req, res) => {
  const pending = await getPendingInvoices();
  const all     = await getInvoices();
  const fam     = decodeURIComponent(req.params.family);
  res.json({
    pending: pending.filter(i => i.family === fam),
    all:     all.filter(i => i.family === fam)
  });
});

// ── Banco ─────────────────────────────────────────────────────────
app.post('/api/bank/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
  const metaPath = path.join(UPLOADS_DIR, 'latest.json');
  fs.writeFileSync(metaPath, JSON.stringify({
    filename: req.file.filename, originalname: req.file.originalname,
    uploadedAt: new Date().toISOString(), size: req.file.size
  }));
  res.json({ message: 'Fichero subido correctamente.', filename: req.file.filename });
});

app.get('/api/bank/info', requireAuth, (req, res) => {
  const metaPath = path.join(UPLOADS_DIR, 'latest.json');
  if (!fs.existsSync(metaPath)) return res.json({ uploaded: false });
  res.json({ uploaded: true, ...JSON.parse(fs.readFileSync(metaPath, 'utf8')) });
});

// ── Notificaciones ────────────────────────────────────────────────
app.post('/api/check-alerts',      requireAuth, (req,res) => { checkPendingInvoices().catch(console.error); res.json({message:'Revisión iniciada.'}); });
app.post('/api/send-summary',      requireAuth, (req,res) => { runDailySummary().catch(console.error); res.json({message:'Resumen enviado.'}); });
app.post('/api/test-notification', requireAuth, async (req,res) => {
  const { type } = req.body;
  const msg = `✅ *Test Corp Projects*\nSistema OK.\n📅 ${new Date().toLocaleString('es-ES')}`;
  if (type==='whatsapp'||!type) await sendWhatsApp(msg);
  if (type==='email'||!type) await sendEmail({ to:process.env.EMAIL_ADMIN, subject:'✅ Test', html:`<p>${msg}</p>`, text:msg });
  res.json({ message:'Notificación enviada.' });
});

// ── PRESENCIA ─────────────────────────────────────────────────────
const attendance = require('./attendance');

app.get('/api/estados',  requireAuth, (req, res) => res.json(attendance.ESTADOS));

app.post('/api/attendance', requireAuth, async (req, res) => {
  try {
    const result = await attendance.saveAttendance(req.body);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/attendance/:workerId/:date', requireAuth, async (req, res) => {
  try {
    await attendance.deleteAttendance(req.params.workerId, req.params.date);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/attendance', requireAuth, async (req, res) => {
  try {
    const { workerId, from, to, clientName } = req.query;
    const data = await attendance.getAttendance({ workerId, from, to, clientName });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/attendance/summary/:year/:month', requireAuth, async (req, res) => {
  try {
    const { getMonthlySummary, buildClientSummary } = require('./attendance');
    const summary = await getMonthlySummary(
      parseInt(req.params.year),
      parseInt(req.params.month)
    );
    summary.clientSummary = buildClientSummary(summary.byWorker);
    res.json(summary);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/attendance/client', requireAuth, async (req, res) => {
  try {
    const { clientName, from, to } = req.query;
    const data = await attendance.getClientExtract(clientName, from, to);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── USUARIOS ──────────────────────────────────────────────────────
const users = require('./users');

users.initDefaultUsers().catch(err => console.error('[Users] Error init:', err.message));

app.post('/api/users/login', async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin) return res.status(400).json({ error: 'PIN requerido' });
    const result = await users.loginWithPin(pin);
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post('/api/users/logout', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) await users.logout(token).catch(() => {});
  res.json({ ok: true });
});

app.get('/api/users/me', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    if (!token.startsWith('u_')) {
      const jwt = require('jsonwebtoken');
      jwt.verify(token, JWT_SECRET);
      return res.json({ role: 'admin', userName: 'Admin' });
    }
    const session = await users.verifyUserToken(token);
    if (!session) return res.status(401).json({ error: 'Sesión expirada' });
    res.json({ role: session.userRole, userName: session.userName, userId: session.userId });
  } catch (err) {
    res.status(401).json({ error: 'Token inválido' });
  }
});

app.get('/api/users', requireAuth, async (req, res) => {
  try {
    const list = await users.getUsers(true);
    res.json(list.map(u => ({ ...u, pin: '••••' })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/:id', requireAuth, async (req, res) => {
  try {
    const u = await users.getUser(req.params.id);
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(u);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', requireAuth, async (req, res) => {
  try {
    const user = await users.createUser(req.body);
    res.json({ ok: true, user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/users/:id', requireAuth, async (req, res) => {
  try {
    await users.updateUser(req.params.id, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/users/:id', requireAuth, async (req, res) => {
  try {
    await users.deactivateUser(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/roles', requireAuth, (req, res) => res.json(users.ROLES));

// ── OBRAS ─────────────────────────────────────────────────────────
const obras = require('./obras');

app.get('/api/obras', requireAuth, async (req, res) => {
  try {
    const { clientName, status, search } = req.query;
    res.json(await obras.getObras({ clientName, status, search }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/obras/resumen', requireAuth, async (req, res) => {
  try { res.json(await obras.getResumenGeneral()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/obras/:id', requireAuth, async (req, res) => {
  try { res.json(await obras.getObra(req.params.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/obras/:id/rentabilidad', requireAuth, async (req, res) => {
  try { res.json(await obras.getRentabilidad(req.params.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/obras', requireAuth, async (req, res) => {
  try {
    const obra = await obras.createObra(req.body);
    res.json({ ok: true, obra });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/obras/:id', requireAuth, async (req, res) => {
  try {
    await obras.updateObra(req.params.id, req.body);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── PARTES DE TRABAJO ─────────────────────────────────────────────
const partes = require('./partes');

app.post('/api/partes/worker-login', async (req, res) => {
  try {
    const { workerId, pin } = req.body;
    const { getUsers } = require('./users');
    const allUsers = await getUsers(false);
    const user = allUsers.find(u => String(u._id) === workerId || u.id === workerId);
    if (user && user.pin === pin) {
      const crypto = require('crypto');
      const token = `w_${crypto.randomBytes(16).toString('hex')}`;
      const { db, client } = await getDB();
      await db.collection('worker_tokens').insertOne({
        token,
        workerId: String(user._id),
        workerName: user.name,
        workerRole: user.role,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000)
      });
      await client.close();
      return res.json({ token, workerId: String(user._id), workerName: user.name });
    }
    const result = await partes.workerLogin(workerId, pin);
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: 'PIN incorrecto' });
  }
});

app.get('/api/partes/workers', async (req, res) => {
  try {
    const { getUsers } = require('./users');
    const allUsers = await getUsers(false);
    const techs = allUsers.filter(u => u.role === 'tech' || u.role === 'office');
    if (techs.length > 0) {
      res.json(techs.map(u => ({ id: String(u._id), name: u.name, color: u.color || '#4d9cf8', role: u.role, costeHora: u.costeHora || 15 })));
    } else {
      res.json(partes.WORKERS.map(w => ({ id: w.id, name: w.name, color: '#4d9cf8', costeHora: w.costeHora || 15 })));
    }
  } catch(err) {
    res.json(partes.WORKERS.map(w => ({ id: w.id, name: w.name, color: '#4d9cf8', costeHora: w.costeHora || 15 })));
  }
});

app.post('/api/partes', uploadMemory.any(), async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    let workerInfo;

    if (authHeader.startsWith('Bearer w_')) {
      const token = authHeader.replace('Bearer ', '');
      const workerDoc = await partes.verifyWorkerToken(token);
      if (!workerDoc) return res.status(401).json({ error: 'Token expirado' });
      workerInfo = { workerId: workerDoc.workerId, workerName: workerDoc.workerName, role: 'worker', ip: req.ip, userAgent: req.headers['user-agent'] };
    } else {
      const token = authHeader.replace('Bearer ', '');
      jwt.verify(token, JWT_SECRET);
      const bodyData = req.body.data ? JSON.parse(req.body.data) : req.body;
      const worker = partes.WORKERS.find(w => w.id === bodyData.workerId);
      workerInfo = { workerId: bodyData.workerId || 'admin', workerName: bodyData.workerName || worker?.name || 'Admin', role: 'admin', ip: req.ip, userAgent: req.headers['user-agent'] };
    }

    const bodyData = req.body.data ? JSON.parse(req.body.data) : req.body;
    const fotosTrabajo = [];
    const fotosAlbaran = [];
    if (req.files && req.files.length > 0) {
      req.files.forEach(f => {
        const b64 = `data:${f.mimetype};base64,${f.buffer.toString('base64')}`;
        if (f.fieldname.startsWith('foto_trabajo')) fotosTrabajo.push(b64);
        if (f.fieldname.startsWith('foto_albaran')) fotosAlbaran.push(b64);
      });
    }
    bodyData.fotosTrabajo = fotosTrabajo;
    bodyData.fotosAlbaran = fotosAlbaran;

    const parte = await partes.createParte(bodyData, workerInfo);

    // Reflejar la presencia del trabajador ese día a partir del parte
    // (no rompe el envío del parte si algo falla).
    try { await attendance.syncPresenceFromParte(parte); }
    catch (e) { console.warn('[Partes] syncPresenceFromParte:', e.message); }

    res.json({ ok: true, id: parte.id });
  } catch (err) {
    console.error('[Partes] Error create:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/partes', requireAuth, async (req, res) => {
  try {
    const { workerId, clientName, status, from, to, limit, skip } = req.query;
    const data = await partes.getPartes({ workerId, clientName, status, from, to, limit: parseInt(limit||50), skip: parseInt(skip||0) });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/partes/:id', requireAuth, async (req, res) => {
  try { res.json(await partes.getParte(req.params.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/partes/:id', requireAuth, async (req, res) => {
  try {
    await partes.updateParte(req.params.id, req.body, 'admin');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/partes/:id', requireAuth, async (req, res) => {
  try {
    const { db, client } = await getDB();
    await db.collection('partes').deleteOne({ _id: new ObjectId(req.params.id) });
    await client.close();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/partes/resumen/facturacion', requireAuth, async (req, res) => {
  try {
    const { from, to, clientName } = req.query;
    res.json(await partes.getResumenFacturacion({ from, to, clientName }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/clients/list', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    let valid = false;
    if (token.startsWith('w_') || token.startsWith('u_')) {
      const { verifyWorkerToken } = require('./partes');
      const { verifyUserToken } = require('./users');
      const w = token.startsWith('w_') ? await verifyWorkerToken(token) : await verifyUserToken(token);
      valid = !!w;
    } else {
      try { jwt.verify(token, JWT_SECRET); valid = true; } catch(e) {}
    }
    if (!valid) return res.status(401).json({ error: 'No autorizado' });
    const { clients } = await getClients();
    const names = [...new Set(clients.map(c => c['legal-name']||c['fiscal-name']||'').filter(n=>n))].sort();
    res.json(names);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ASIGNACIONES, EXTERNOS Y EXPEDIENTES ─────────────────────────
const expedientes = require('./expedientes');

app.get('/api/externos', async (req, res) => {
  try {
    // Lectura permitida a admin (JWT) o trabajador (token de parte)
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No autorizado' });
    let ok = false;
    try { jwt.verify(token, JWT_SECRET); ok = true; } catch {}
    if (!ok) { const w = await partes.verifyWorkerToken(token); ok = !!w; }
    if (!ok) return res.status(401).json({ error: 'No autorizado' });
    res.json(await expedientes.getExternos());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/externos', requireAuth, async (req, res) => {
  try { res.json(await expedientes.createExterno(req.body)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/externos/:id', requireAuth, async (req, res) => {
  try { await expedientes.updateExterno(req.params.id, req.body); res.json({ ok: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/externos/:id', requireAuth, async (req, res) => {
  try { await expedientes.deleteExterno(req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/asignaciones', requireAuth, async (req, res) => {
  try {
    const { fecha, workerId } = req.query;
    res.json(await expedientes.getAsignaciones({ fecha, workerId }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/asignaciones/dia/:fecha', requireAuth, async (req, res) => {
  try { res.json(await expedientes.getAsignacionesDelDia(req.params.fecha)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/asignaciones/worker/:workerId', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No autorizado' });
    const { verifyWorkerToken } = require('./partes');
    const { verifyUserToken } = require('./users');
    let valid = false;
    if (token.startsWith('w_')) { valid = !!(await verifyWorkerToken(token)); }
    else if (token.startsWith('u_')) { valid = !!(await verifyUserToken(token)); }
    else { try { jwt.verify(token, JWT_SECRET); valid = true; } catch(e){} }
    if (!valid) return res.status(401).json({ error: 'No autorizado' });
    const fecha = req.query.fecha || new Date().toISOString().slice(0, 10);
    res.json(await expedientes.getAsignacionesWorker(req.params.workerId, fecha));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/asignaciones', requireAuth, async (req, res) => {
  try { res.json(await expedientes.createAsignacion(req.body)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/asignaciones/:id', requireAuth, async (req, res) => {
  try { await expedientes.updateAsignacion(req.params.id, req.body); res.json({ ok: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/asignaciones/:id', requireAuth, async (req, res) => {
  try { await expedientes.deleteAsignacion(req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/expedientes', requireAuth, async (req, res) => {
  try {
    const { estado, clientName } = req.query;
    res.json(await expedientes.getExpedientes({ estado, clientName }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/expedientes/:id', requireAuth, async (req, res) => {
  try { res.json(await expedientes.getExpediente(req.params.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/expedientes', requireAuth, async (req, res) => {
  try { res.json(await expedientes.createExpediente(req.body)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/expedientes/:id', requireAuth, async (req, res) => {
  try { await expedientes.updateExpediente(req.params.id, req.body); res.json({ ok: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/expedientes/:id/cerrar', requireAuth, async (req, res) => {
  try {
    await expedientes.updateExpediente(req.params.id, { estado: 'COMPLETADO' });
    const exp = await expedientes.getExpediente(req.params.id);
    const totalHoras = await expedientes.recalcularHorasExpediente(req.params.id);
    res.json({ ok: true, totalHoras, partes: exp.partes.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/partes/confirmar', uploadMemory.any(), async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No autorizado' });
    const workerDoc = await partes.verifyWorkerToken(token);
    if (!workerDoc) return res.status(401).json({ error: 'Token expirado' });

    const workerInfo = {
      workerId: workerDoc.workerId,
      workerName: workerDoc.workerName,
      role: 'worker',
      ip: req.ip,
      userAgent: req.headers['user-agent']
    };

    // El formulario envía multipart/form-data: los datos del parte van en el
    // campo 'data' (JSON) y las fotos como ficheros. Antes se leía req.body
    // directamente (sin multer) y llegaba VACÍO, por eso el parte salía sin
    // cliente, con 8 h por defecto y sin descripción, fotos ni GPS.
    const bodyData = req.body.data ? JSON.parse(req.body.data) : req.body;
    const fotosTrabajo = [];
    const fotosAlbaran = [];
    if (req.files && req.files.length > 0) {
      req.files.forEach(f => {
        const b64 = `data:${f.mimetype};base64,${f.buffer.toString('base64')}`;
        if (f.fieldname.startsWith('foto_trabajo')) fotosTrabajo.push(b64);
        if (f.fieldname.startsWith('foto_albaran')) fotosAlbaran.push(b64);
      });
    }
    bodyData.fotosTrabajo = fotosTrabajo;
    bodyData.fotosAlbaran = fotosAlbaran;

    const parte = await partes.createParte(bodyData, workerInfo);

    // Reflejar la presencia del trabajador ese día (multi-obra). Lo hace el
    // servidor para que se acumulen varias obras; el formulario ya no sincroniza.
    try { await attendance.syncPresenceFromParte(parte); }
    catch (e) { console.warn('[Partes] syncPresenceFromParte:', e.message); }

    const equipo = bodyData.equipo || [];
    let partesGenerados = [];
    if (equipo.length > 1) {
      partesGenerados = await expedientes.generarPartesEquipo(parte, equipo);
    }

    let expedienteId = null;
    if (bodyData.estadoTrabajo === 'continua' || bodyData.estadoTrabajo === 'parcial' || bodyData.expedienteId) {
      expedienteId = await expedientes.vincularOCrearExpediente(
        String(parte._id),
        parte.clientName,
        parte.description,
        bodyData.expedienteId || null
      );
      if (expedienteId && partesGenerados.length > 0) {
        const { db, client } = await sharedDb.getDBLegacy();
        for (const pg of partesGenerados) {
          await db.collection('partes').updateOne(
            { _id: pg.id },
            { $set: { expedienteId } }
          );
        }
        await client.close();
      }
    }

    res.json({
      ok: true,
      parteId: String(parte._id),
      partesGenerados: partesGenerados.length,
      expedienteId
    });
  } catch (err) {
    console.error('[Partes] Error confirmar:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── EMAILS INTELIGENTES ───────────────────────────────────────────
const { pollEmails, enviarRespuesta } = require('./email-intelligence');

app.get('/api/emails', requireAuth, async (req, res) => {
  try {
    const { db, client } = await getDB();
    const { categoria, estado, urgencia, limit = 50, skip = 0 } = req.query;
    const filtro = {};
    if (categoria && categoria !== 'TODOS') filtro.categoria = categoria;
    if (estado && estado !== 'TODOS') filtro.estado = estado;
    if (urgencia && urgencia !== 'TODOS') filtro.urgencia = urgencia;
    const emails = await db.collection('emails')
      .find(filtro).sort({ fecha: -1 }).skip(parseInt(skip)).limit(parseInt(limit)).toArray();
    const total      = await db.collection('emails').countDocuments(filtro);
    const pendientes = await db.collection('emails').countDocuments({ estado: 'PENDIENTE' });
    const noLeidos   = await db.collection('emails').countDocuments({ leido: false });
    await client.close();
    res.json({ emails, total, pendientes, noLeidos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/emails/:id/read', requireAuth, async (req, res) => {
  try {
    const { db, client } = await getDB();
    await db.collection('emails').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { leido: true } }
    );
    await client.close();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/emails/:id/archive', requireAuth, async (req, res) => {
  try {
    const { db, client } = await getDB();
    await db.collection('emails').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { estado: 'ARCHIVADO', leido: true } }
    );
    await client.close();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/emails/:id/nota', requireAuth, async (req, res) => {
  try {
    const { db, client } = await getDB();
    await db.collection('emails').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { notas: req.body.notas } }
    );
    await client.close();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/emails/:id/importante', requireAuth, async (req, res) => {
  try {
    const { db, client } = await getDB();
    await db.collection('emails').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { importante: req.body.importante } }
    );
    await client.close();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/emails/:id', requireAuth, async (req, res) => {
  try {
    const { db, client } = await getDB();
    await db.collection('emails').deleteOne({ _id: new ObjectId(req.params.id) });
    await client.close();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/emails/:id/reenviar', requireAuth, async (req, res) => {
  try {
    const { db, client } = await getDB();
    const email = await db.collection('emails').findOne({ _id: new ObjectId(req.params.id) });
    await client.close();
    if (!email) return res.status(404).json({ error: 'No encontrado' });
    const ok = await enviarRespuesta(
      req.body.destino,
      email.asunto,
      `--- Email reenviado ---\n\nDe: ${email.de}\nAsunto: ${email.asunto}\n\n${email.cuerpo}`
    );
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/emails/:id/action', requireAuth, async (req, res) => {
  try {
    const { db, client } = await getDB();
    const email = await db.collection('emails').findOne({ _id: new ObjectId(req.params.id) });
    if (!email) { await client.close(); return res.status(404).json({ error: 'Email no encontrado' }); }

    const { accion, datos } = req.body;
    let stelOrderRef = null;
    let mensajeRespuesta = null;

    if (accion === 'CREAR_INCIDENCIA') {
      const body = {
        description: datos?.descripcion || email.resumen,
        priority: email.urgencia === 'ALTA' ? 'HIGH' : email.urgencia === 'MEDIA' ? 'NORMAL' : 'LOW'
      };
      if (email.remitente?.id) body['account-id'] = email.remitente.id;
      const r = await fetch('https://app.stelorder.com/app/incidents', {
        method: 'POST',
        headers: { 'APIKEY': process.env.STELORDER_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const inc = await r.json();
      stelOrderRef = `INC — ID: ${inc.id || 'creada'}`;
      mensajeRespuesta = `Hola,\n\nHemos recibido tu solicitud y hemos abierto una incidencia en nuestro sistema.\n\nReferencia: ${inc['full-reference'] || stelOrderRef}\n\nUno de nuestros operarios se encargará en breve.\n\nCorp Projects`;
    }

    if (accion === 'CREAR_PRESUPUESTO') {
      const body = { title: datos?.titulo || email.asunto, comments: datos?.comentarios || email.resumen };
      if (email.remitente?.id) body['account-id'] = email.remitente.id;
      if (body['account-id']) {
        const r = await fetch('https://app.stelorder.com/app/workEstimates', {
          method: 'POST',
          headers: { 'APIKEY': process.env.STELORDER_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const est = await r.json();
        stelOrderRef = `Presupuesto — ID: ${est.id || 'creado'}`;
      } else {
        stelOrderRef = 'Presupuesto pendiente — sin cliente vinculado';
      }
      mensajeRespuesta = `Hola,\n\nHemos recibido tu solicitud de presupuesto.\n\nEstamos preparando una propuesta y nos pondremos en contacto contigo en breve.\n\nCorp Projects`;
    }

    if (accion === 'MARCAR_PAGADO') {
      stelOrderRef = 'Pago registrado manualmente';
    }

    if (mensajeRespuesta && datos?.enviarRespuesta !== false) {
      const emailDe = email.de.match(/<(.+)>/)?.[1] || email.de;
      await enviarRespuesta(emailDe, email.asunto, mensajeRespuesta);
    }

    await db.collection('emails').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { estado: 'GESTIONADO', leido: true, accionRealizada: accion, stelOrderRef, gestionadoEn: new Date() } }
    );
    await client.close();
    res.json({ ok: true, stelOrderRef, mensajeRespuesta });
  } catch (err) {
    console.error('[Emails] Error acción:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/emails/poll', requireAuth, async (req, res) => {
  try {
    pollEmails().catch(err => console.error('[Emails] Error poll manual:', err.message));
    res.json({ message: 'Poll iniciado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/emails/stats', requireAuth, async (req, res) => {
  try {
    const { db, client } = await getDB();
    const pendientes = await db.collection('emails').countDocuments({ estado: 'PENDIENTE' });
    const noLeidos   = await db.collection('emails').countDocuments({ leido: false });
    const urgentes   = await db.collection('emails').countDocuments({ estado: 'PENDIENTE', urgencia: 'ALTA' });
    await client.close();
    res.json({ pendientes, noLeidos, urgentes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ── COLABORADORES EXTERNOS ────────────────────────────────────────
const colaboradores = require('./colaboradores');

app.get('/api/colaboradores', requireAuth, async (req, res) => {
  try { res.json(await colaboradores.getColaboradores()); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/colaboradores/resumen', requireAuth, async (req, res) => {
  try { res.json(await colaboradores.getResumenTodosColaboradores()); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/colaboradores/:id', requireAuth, async (req, res) => {
  try { res.json(await colaboradores.getSaldoColaborador(req.params.id)); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/colaboradores', requireAuth, async (req, res) => {
  try { res.json(await colaboradores.createColaborador(req.body)); }
  catch(err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/colaboradores/:id', requireAuth, async (req, res) => {
  try { await colaboradores.updateColaborador(req.params.id, req.body); res.json({ ok: true }); }
  catch(err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/colaboradores/:id/movimientos', requireAuth, async (req, res) => {
  try {
    const { from, to } = req.query;
    res.json(await colaboradores.getMovimientos(req.params.id, { from, to }));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/colaboradores/:id/movimientos', requireAuth, async (req, res) => {
  try { res.json(await colaboradores.createMovimiento(req.params.id, req.body)); }
  catch(err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/colaboradores/movimientos/:id', requireAuth, async (req, res) => {
  try { await colaboradores.deleteMovimiento(req.params.id); res.json({ ok: true }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/colaboradores/:id', requireAuth, async (req, res) => {
  try {
    const { db, client } = await getDB();
    await db.collection('colaborador_movimientos').deleteMany({ colaboradorId: req.params.id });
    await db.collection('colaboradores').deleteOne({ _id: new ObjectId(req.params.id) });
    await client.close();
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── PROYECTOS DE INVERSIÓN ────────────────────────────────────────
app.get('/api/proyectos', requireAuth, async (req, res) => {
  try { res.json(await colaboradores.getProyectos()); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/proyectos/:id', requireAuth, async (req, res) => {
  try { res.json(await colaboradores.getProyecto(req.params.id)); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/proyectos', requireAuth, async (req, res) => {
  try { res.json(await colaboradores.createProyecto(req.body)); }
  catch(err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/proyectos/:id', requireAuth, async (req, res) => {
  try { await colaboradores.updateProyecto(req.params.id, req.body); res.json({ ok: true }); }
  catch(err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/proyectos/:id/movimientos', requireAuth, async (req, res) => {
  try { res.json(await colaboradores.addMovimientoProyecto(req.params.id, req.body)); }
  catch(err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/proyectos/movimientos/:id', requireAuth, async (req, res) => {
  try { await colaboradores.deleteMovimientoProyecto(req.params.id); res.json({ ok: true }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});
// ── PAGOS EN EFECTIVO ─────────────────────────────────────────────
const pagos = require('./pagos');

app.get('/api/pagos/resumen', requireAuth, async (req, res) => {
  try {
    const { from, to } = req.query;
    res.json(await pagos.getResumenPagos({ from, to }));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/pagos', requireAuth, async (req, res) => {
  try {
    const { persona, tipo, from, to, limit, skip } = req.query;
    res.json(await pagos.getPagos({ persona, tipo, from, to, limit: parseInt(limit||100), skip: parseInt(skip||0) }));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/pagos/:id', requireAuth, async (req, res) => {
  try { res.json(await pagos.getPago(req.params.id)); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/pagos', requireAuth, async (req, res) => {
  try { res.json(await pagos.createPago({ ...req.body, registradoPor: 'admin' })); }
  catch(err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/pagos/:id', requireAuth, async (req, res) => {
  try { await pagos.updatePago(req.params.id, req.body); res.json({ ok: true }); }
  catch(err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/pagos/:id', requireAuth, async (req, res) => {
  try { await pagos.deletePago(req.params.id); res.json({ ok: true }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Rutas HTML ────────────────────────────────────────────────────
app.get('/informe-presencia', (req, res) => res.sendFile(path.join(__dirname, '../public/informe-presencia.html')));
app.get('/parte', (req, res) => res.sendFile(path.join(__dirname, '../public/parte.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

app.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════════╗`);
  console.log(`║   Corp Projects Dashboard v3           ║`);
  console.log(`╚════════════════════════════════════════╝`);
  console.log(`🚀 Puerto: ${PORT}`);
  console.log(`📊 StelOrder: ${process.env.STELORDER_API_KEY ? '✅' : '❌'}`);
  console.log(`📧 Email: ${process.env.EMAIL_USER ? '✅' : '⚠️'}`);
  console.log(`💬 WhatsApp: ${process.env.TWILIO_ACCOUNT_SID ? '✅' : '⚠️ Pendiente'}\n`);
  startScheduler();
});

module.exports = app;
