// src/server.js v2
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
  getSummary, getPendingInvoices, getInvoices,
  getClients, getEstimatesSummary
} = require('./stelorder');
const { sendWhatsApp, sendEmail } = require('./notifications');
const { startScheduler, checkPendingInvoices, runDailySummary } = require('./scheduler');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: ['https://dashboard.corpprojects.es','http://localhost:3000',
           'https://corpprojects-dashboard-production.up.railway.app']
}));
app.use(express.json());

// Carpeta de uploads para el Excel del banco
const UPLOADS_DIR = path.join(__dirname, '../uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => cb(null, `bank_${Date.now()}.xlsx`)
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

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
app.get('/api/summary',           requireAuth, async (req,res) => res.json(await getSummary()));
app.get('/api/invoices/pending',  requireAuth, async (req,res) => res.json(await getPendingInvoices()));
app.get('/api/invoices',          requireAuth, async (req,res) => res.json(await getInvoices()));
app.get('/api/clients',           requireAuth, async (req,res) => res.json(await getClients()));

// Presupuestos
app.get('/api/estimates', requireAuth, async (req, res) => {
  const data = await getEstimatesSummary();
  res.json(data);
});

// Upload fichero Excel banco
app.post('/api/bank/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
  // Guardar referencia al último fichero
  const metaPath = path.join(UPLOADS_DIR, 'latest.json');
  fs.writeFileSync(metaPath, JSON.stringify({
    filename: req.file.filename,
    originalname: req.file.originalname,
    uploadedAt: new Date().toISOString(),
    size: req.file.size
  }));
  console.log(`[Upload] Nuevo fichero bancario: ${req.file.originalname}`);
  res.json({ message: 'Fichero subido correctamente. Procesando...', filename: req.file.filename });
});

// Info del último fichero subido
app.get('/api/bank/info', requireAuth, (req, res) => {
  const metaPath = path.join(UPLOADS_DIR, 'latest.json');
  if (!fs.existsSync(metaPath)) return res.json({ uploaded: false });
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  res.json({ uploaded: true, ...meta });
});

app.post('/api/check-alerts',      requireAuth, (req,res) => { checkPendingInvoices().catch(console.error); res.json({message:'Revisión iniciada.'}); });
app.post('/api/send-summary',      requireAuth, (req,res) => { runDailySummary().catch(console.error); res.json({message:'Resumen enviado.'}); });
app.post('/api/test-notification', requireAuth, async (req,res) => {
  const { type } = req.body;
  const msg = `✅ *Test Corp Projects*\nSistema OK.\n📅 ${new Date().toLocaleString('es-ES')}`;
  if (type==='whatsapp'||!type) await sendWhatsApp(msg);
  if (type==='email'||!type) await sendEmail({ to:process.env.EMAIL_ADMIN, subject:'✅ Test', html:`<p>${msg}</p>`, text:msg });
  res.json({ message:'Notificación enviada.' });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

app.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════════╗`);
  console.log(`║   Corp Projects Dashboard — Servidor   ║`);
  console.log(`╚════════════════════════════════════════╝`);
  console.log(`🚀 Puerto: ${PORT}`);
  console.log(`📊 StelOrder: ${process.env.STELORDER_API_KEY ? '✅' : '❌'}`);
  console.log(`📧 Email: ${process.env.EMAIL_USER ? '✅' : '⚠️'}`);
  console.log(`💬 WhatsApp: ${process.env.TWILIO_ACCOUNT_SID ? '✅' : '⚠️ Pendiente'}\n`);
  startScheduler();
});

module.exports = app;
