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

const {
  getSummary, getPendingInvoices, getInvoices, getClients,
  getEstimatesSummary, getFamiliesSummary, getAccountCategories
} = require('./stelorder');
const { sendWhatsApp, sendEmail } = require('./notifications');
const { startScheduler, checkPendingInvoices, runDailySummary } = require('./scheduler');

// ===== OAUTH GMAIL - TEMPORAL PARA OBTENER REFRESH TOKEN =====
const { google } = require('googleapis');
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
// ===== FIN TEMPORAL =====

const app  = express();
const PORT = process.env.PORT || 3000;

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

// Memoria para fotos de partes → base64 → MongoDB
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
  try { req.user = jwt.verify(token, process.env.JWT_SECRET || 'fallback'); next(); }
  catch { return res.status(401).json({ error: 'Token inválido' }); }
}

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
  const token = jwt.sign({ user:'admin' }, process.env.JWT_SECRET||'fallback', { expiresIn:'24h' });
  res.json({ token, expiresIn:'24h' });
});

// ── Protegidas ────────────────────────────────────────────────────
app.get('/api/summary',            requireAuth, async (req,res) => res.json(await getSummary()));
app.get('/api/invoices/pending',   requireAuth, async (req,res) => res.json(await getPendingInvoices()));
app.get('/api/invoices',           requireAuth, async (req,res) => res.json(await getInvoices()));
app.get('/api/clients',            requireAuth, async (req,res) => { const {clients} = await getClients(); res.json(clients); });
app.get('/api/estimates',          requireAuth, async (req,res) => res.json(await getEstimatesSummary()));
app.get('/api/families',           requireAuth, async (req,res) => res.json(await getFamiliesSummary()));
app.get('/api/families/list',      requireAuth, async (req,res) => { const {list} = await getAccountCategories(); res.json(list); });

// Facturas filtradas por familia
app.get('/api/invoices/by-family/:family', requireAuth, async (req, res) => {
  const pending = await getPendingInvoices();
  const all     = await getInvoices();
  const fam     = decodeURIComponent(req.params.family);
  res.json({
    pending: pending.filter(i => i.family === fam),
    all:     all.filter(i => i.family === fam)
  });
});

// Upload Excel banco
app.post('/api/bank/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
  const metaPath = path.join(UPLOADS_DIR, 'latest.json');
  fs.writeFileSync(metaPath, JSON.stringify({
    filename: req.file.filename, originalname: req.file.originalname,
    uploadedAt: new Date().toISOString(), size: req.file.size
  }));
  console.log(`[Upload] Nuevo extracto bancario: ${req.file.originalname}`);
  res.json({ message: 'Fichero subido correctamente.', filename: req.file.filename });
});

app.get('/api/bank/info', requireAuth, (req, res) => {
  const metaPath = path.join(UPLOADS_DIR, 'latest.json');
  if (!fs.existsSync(metaPath)) return res.json({ uploaded: false });
  res.json({ uploaded: true, ...JSON.parse(fs.readFileSync(metaPath, 'utf8')) });
});

app.post('/api/check-alerts',       requireAuth, (req,res) => { checkPendingInvoices().catch(console.error); res.json({message:'Revisión iniciada.'}); });
app.post('/api/send-summary',       requireAuth, (req,res) => { runDailySummary().catch(console.error); res.json({message:'Resumen enviado.'}); });
app.post('/api/test-notification',  requireAuth, async (req,res) => {
  const { type } = req.body;
  const msg = `✅ *Test Corp Projects*\nSistema OK.\n📅 ${new Date().toLocaleString('es-ES')}`;
  if (type==='whatsapp'||!type) await sendWhatsApp(msg);
  if (type==='email'||!type) await sendEmail({ to:process.env.EMAIL_ADMIN, subject:'✅ Test', html:`<p>${msg}</p>`, text:msg });
  res.json({ message:'Notificación enviada.' });
});


// ── PRESENCIA Y PARTES DE HORAS ───────────────────────────────────
const attendance = require('./attendance');

app.get('/api/workers', requireAuth, (req, res) => {
  res.json(attendance.WORKERS);
});

app.get('/api/estados', requireAuth, (req, res) => {
  res.json(attendance.ESTADOS);
});

// Guardar entrada de presencia
app.post('/api/attendance', requireAuth, async (req, res) => {
  try {
    const result = await attendance.saveAttendance(req.body);
    res.json({ ok: true, result });
  } catch (err) {
    console.error('[Attendance] Error save:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Borrar entrada
app.delete('/api/attendance/:workerId/:date', requireAuth, async (req, res) => {
  try {
    await attendance.deleteAttendance(req.params.workerId, req.params.date);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Listar entradas con filtros
app.get('/api/attendance', requireAuth, async (req, res) => {
  try {
    const { workerId, from, to, clientName } = req.query;
    const data = await attendance.getAttendance({ workerId, from, to, clientName });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resumen mensual
app.get('/api/attendance/summary/:year/:month', requireAuth, async (req, res) => {
  try {
    const data = await attendance.getMonthlySummary(
      parseInt(req.params.year), parseInt(req.params.month)
    );
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Extracto por cliente
app.get('/api/attendance/client', requireAuth, async (req, res) => {
  try {
    const { clientName, from, to } = req.query;
    const data = await attendance.getClientExtract(clientName, from, to);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// ── GESTIÓN DE USUARIOS ───────────────────────────────────────────
const users = require('./users');

// Inicializar usuarios por defecto al arrancar
users.initDefaultUsers().catch(err => console.error('[Users] Error init:', err.message));

// Login con PIN (público)
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

// Logout
app.post('/api/users/logout', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) await users.logout(token).catch(() => {});
  res.json({ ok: true });
});

// Verificar token de usuario (para el dashboard de oficina)
app.get('/api/users/me', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    // Token de admin (JWT)
    if (!token.startsWith('u_')) {
      const jwt = require('jsonwebtoken');
      jwt.verify(token, process.env.JWT_SECRET || 'fallback');
      return res.json({ role: 'admin', userName: 'Admin' });
    }
    // Token de usuario (PIN)
    const session = await users.verifyUserToken(token);
    if (!session) return res.status(401).json({ error: 'Sesión expirada' });
    res.json({ role: session.userRole, userName: session.userName, userId: session.userId });
  } catch (err) {
    res.status(401).json({ error: 'Token inválido' });
  }
});

// CRUD usuarios (solo admin)
app.get('/api/users', requireAuth, async (req, res) => {
  try {
    const list = await users.getUsers(true);
    // No devolver PINs en la lista general
    res.json(list.map(u => ({ ...u, pin: '••••' })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/:id', requireAuth, async (req, res) => {
  try {
    const u = await users.getUser(req.params.id);
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(u); // Admin ve el PIN
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

app.get('/api/roles', requireAuth, (req, res) => {
  res.json(users.ROLES);
});


// ── OBRAS Y RENTABILIDAD ──────────────────────────────────────────
const obras = require('./obras');

app.get('/api/obras', requireAuth, async (req, res) => {
  try {
    const { clientName, status, search } = req.query;
    const data = await obras.getObras({ clientName, status, search });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/obras/resumen', requireAuth, async (req, res) => {
  try {
    const data = await obras.getResumenGeneral();
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/obras/:id', requireAuth, async (req, res) => {
  try {
    const data = await obras.getObra(req.params.id);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/obras/:id/rentabilidad', requireAuth, async (req, res) => {
  try {
    const data = await obras.getRentabilidad(req.params.id);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
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

// Login trabajador — busca por ID de MongoDB o ID legacy
app.post('/api/partes/worker-login', async (req, res) => {
  try {
    const { workerId, pin } = req.body;
    
    // Intentar login por MongoDB primero
    const { getUsers } = require('./users');
    const allUsers = await getUsers(false);
    
    // Buscar por _id de MongoDB o por id legacy
    const user = allUsers.find(u => 
      String(u._id) === workerId || u.id === workerId
    );
    
    if (user && user.pin === pin) {
      // Usuario encontrado en MongoDB
      const { MongoClient } = require('mongodb');
      const crypto = require('crypto');
      const token = `w_${crypto.randomBytes(16).toString('hex')}`;
      const { MongoClient: MC } = require('mongodb');
      
      // Guardar token en worker_tokens
      const client = new MC(process.env.MONGODB_URI);
      await client.connect();
      const db = client.db('corpprojects');
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
    
    // Fallback a login legacy (PINs hardcodeados)
    const result = await partes.workerLogin(workerId, pin);
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: 'PIN incorrecto' });
  }
});

// Lista de workers para el formulario de login — desde MongoDB
app.get('/api/partes/workers', async (req, res) => {
  try {
    const { getUsers } = require('./users');
    const allUsers = await getUsers(false); // solo activos
    const techs = allUsers.filter(u => u.role === 'tech' || u.role === 'office');
    if (techs.length > 0) {
      res.json(techs.map(u => ({
        id: String(u._id),
        name: u.name,
        color: u.color || '#4d9cf8',
        role: u.role
      })));
    } else {
      // Fallback a lista hardcodeada si MongoDB no tiene usuarios aún
      res.json(partes.WORKERS.map(w => ({ id: w.id, name: w.name, color: '#4d9cf8' })));
    }
  } catch(err) {
    res.json(partes.WORKERS.map(w => ({ id: w.id, name: w.name, color: '#4d9cf8' })));
  }
});

// Crear parte — worker autenticado o admin (acepta JSON y FormData con fotos)
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
      const jwt = require('jsonwebtoken');
      jwt.verify(token, process.env.JWT_SECRET || 'fallback');
      const bodyData = req.body.data ? JSON.parse(req.body.data) : req.body;
      const worker = partes.WORKERS.find(w => w.id === bodyData.workerId);
      workerInfo = { workerId: bodyData.workerId || 'admin', workerName: bodyData.workerName || worker?.name || 'Admin', role: 'admin', ip: req.ip, userAgent: req.headers['user-agent'] };
    }

    // Log para debug
    console.log('[Partes] Files recibidos:', req.files?.length || 0);
    console.log('[Partes] Content-Type:', req.headers['content-type']?.slice(0,50));
    console.log('[Partes] Body keys:', Object.keys(req.body||{}));

    // Parsear datos — puede venir como JSON o dentro de FormData
    const bodyData = req.body.data ? JSON.parse(req.body.data) : req.body;

    // Procesar fotos subidas
    const fotosTrabajo  = [];
    const fotosAlbaran  = [];
    if (req.files && req.files.length > 0) {
      req.files.forEach(f => {
        // Convertir buffer a base64 data URL
        const b64 = `data:${f.mimetype};base64,${f.buffer.toString('base64')}`;
        if (f.fieldname.startsWith('foto_trabajo')) fotosTrabajo.push(b64);
        if (f.fieldname.startsWith('foto_albaran')) fotosAlbaran.push(b64);
      });
    }

    bodyData.fotosTrabajo = fotosTrabajo;
    bodyData.fotosAlbaran = fotosAlbaran;

    const parte = await partes.createParte(bodyData, workerInfo);
    res.json({ ok: true, id: parte.id });
  } catch (err) {
    console.error('[Partes] Error create:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Listar partes (solo admin)
app.get('/api/partes', requireAuth, async (req, res) => {
  try {
    const { workerId, clientName, status, from, to, limit, skip } = req.query;
    const data = await partes.getPartes({ workerId, clientName, status, from, to, limit: parseInt(limit||50), skip: parseInt(skip||0) });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ver parte individual con metadatos (solo admin)
app.get('/api/partes/:id', requireAuth, async (req, res) => {
  try {
    const data = await partes.getParte(req.params.id);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Actualizar parte (solo admin)
app.put('/api/partes/:id', requireAuth, async (req, res) => {
  try {
    await partes.updateParte(req.params.id, req.body, 'admin');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eliminar parte (solo admin)
app.delete('/api/partes/:id', requireAuth, async (req, res) => {
  try {
    const { MongoClient, ObjectId } = require('mongodb');
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    const db = client.db('corpprojects');
    await db.collection('partes').deleteOne({ _id: new ObjectId(req.params.id) });
    await client.close();
    console.log(`[Partes] Eliminado: ${req.params.id}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resumen para facturación (solo admin)
app.get('/api/partes/resumen/facturacion', requireAuth, async (req, res) => {
  try {
    const { from, to, clientName } = req.query;
    const data = await partes.getResumenFacturacion({ from, to, clientName });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint de clientes para autocompletado (accesible con cualquier token válido)
app.get('/api/clients/list', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    
    // Verificar token (admin JWT o worker token)
    let valid = false;
    if (token.startsWith('w_') || token.startsWith('u_')) {
      // Token de trabajador o usuario — verificar en DB
      const { verifyWorkerToken } = require('./partes');
      const { verifyUserToken } = require('./users');
      const w = token.startsWith('w_') ? await verifyWorkerToken(token) : await verifyUserToken(token);
      valid = !!w;
    } else {
      // Token admin JWT
      try { const jwt = require('jsonwebtoken'); jwt.verify(token, process.env.JWT_SECRET||'fallback'); valid = true; } catch(e) {}
    }
    
    if (!valid) return res.status(401).json({ error: 'No autorizado' });
    
    // Obtener clientes de StelOrder (ya cacheados en memoria)
    const { getClients } = require('./stelorder');
    const { clients } = await getClients();
    const names = [...new Set(clients.map(c => c['legal-name']||c['fiscal-name']||'').filter(n=>n))].sort();
    res.json(names);
  } catch (err) {
    console.error('[Clients] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Ruta para el informe de presencia
app.get('/informe-presencia', (req, res) => res.sendFile(path.join(__dirname, '../public/informe-presencia.html')));

// Ruta específica para el formulario de trabajadores
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
