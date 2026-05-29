// src/server.js
require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt       = require('jsonwebtoken');
const path      = require('path');

const { getSummary, getPendingInvoices, getInvoices, getClients } = require('./stelorder');
const { sendWhatsApp, sendEmail } = require('./notifications');
const { startScheduler, checkPendingInvoices, runDailySummary } = require('./scheduler');

const app  = express();
const PORT = process.env.PORT || 3000;

// Necesario para Railway (está detrás de un proxy)
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: ['https://dashboard.corpprojects.es', 'http://localhost:3000',
           'https://corpprojects-dashboard-production.up.railway.app']
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 200,
  message: { error: 'Demasiadas peticiones.' }
});
app.use('/api/', limiter);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  message: { error: 'Demasiados intentos de login.' }
});

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret');
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

// ── Rutas públicas ───────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok', service: 'Corp Projects Dashboard',
  timestamp: new Date().toISOString(), uptime: Math.round(process.uptime()) + 's'
}));

app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Contraseña requerida' });
    if (password !== process.env.DASHBOARD_PASSWORD)
      return res.status(401).json({ error: 'Contraseña incorrecta' });

    const token = jwt.sign(
      { user: 'admin', company: 'corpprojects' },
      process.env.JWT_SECRET || 'fallback-secret',
      { expiresIn: '24h' }
    );
    res.json({ token, expiresIn: '24h' });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── Rutas protegidas ─────────────────────────────────────────────
app.get('/api/summary',           requireAuth, async (req, res) => {
  const data = await getSummary();
  res.json(data);
});

app.get('/api/invoices/pending',  requireAuth, async (req, res) => {
  const data = await getPendingInvoices();
  res.json(data);
});

app.get('/api/invoices',          requireAuth, async (req, res) => {
  const { limit = 100, offset = 0 } = req.query;
  const data = await getInvoices({ limit: parseInt(limit), offset: parseInt(offset) });
  res.json(data);
});

app.get('/api/clients',           requireAuth, async (req, res) => {
  const data = await getClients();
  res.json(data);
});

app.post('/api/check-alerts',     requireAuth, async (req, res) => {
  checkPendingInvoices().catch(console.error);
  res.json({ message: 'Revisión iniciada. Recibirás las alertas en breve.' });
});

app.post('/api/send-summary',     requireAuth, async (req, res) => {
  runDailySummary().catch(console.error);
  res.json({ message: 'Resumen enviado por WhatsApp y email.' });
});

app.post('/api/test-notification', requireAuth, async (req, res) => {
  try {
    const { type } = req.body;
    const msg = `✅ *Test Corp Projects Dashboard*\n\nSistema funcionando correctamente.\n📅 ${new Date().toLocaleString('es-ES')}`;
    if (type === 'whatsapp' || !type) await sendWhatsApp(msg);
    if (type === 'email' || !type) await sendEmail({
      to: process.env.EMAIL_ADMIN,
      subject: '✅ Test notificación Corp Projects',
      html: `<p>${msg.replace(/\n/g,'<br>')}</p>`, text: msg
    });
    res.json({ message: 'Notificación enviada.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Catch-all → frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Arrancar ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║   Corp Projects Dashboard — Servidor   ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`🚀 Puerto: ${PORT}`);
  console.log(`📊 StelOrder: ${process.env.STELORDER_API_KEY ? '✅' : '❌ Sin API key'}`);
  console.log(`📧 Email: ${process.env.EMAIL_USER ? '✅' : '⚠️ Sin configurar'}`);
  console.log(`💬 WhatsApp: ${process.env.TWILIO_ACCOUNT_SID ? '✅' : '⚠️ Pendiente'}`);
  console.log('');
  startScheduler();
});

module.exports = app;
