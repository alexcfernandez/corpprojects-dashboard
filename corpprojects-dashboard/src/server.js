// src/server.js
// Servidor principal Corp Projects Dashboard
require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcryptjs');
const path       = require('path');

const { getSummary, getPendingInvoices, getInvoices, getClients } = require('./stelorder');
const { sendWhatsApp, sendEmail }  = require('./notifications');
const { startScheduler, checkPendingInvoices, runDailySummary } = require('./scheduler');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Middlewares de seguridad ────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false // Lo gestionamos en el frontend
}));
app.use(cors({
  origin: [
    'https://dashboard.corpprojects.es',
    'http://localhost:3000'
  ]
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Rate limiting — máximo 100 requests por 15 min por IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Demasiadas peticiones. Espera un momento.' }
});
app.use('/api/', limiter);

// Rate limiting más estricto para login
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Demasiados intentos de login.' }
});

// ─── Middleware de autenticación ─────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret');
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

// ─── RUTAS PÚBLICAS ───────────────────────────────────────────────

// Health check para Railway
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Corp Projects Dashboard',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()) + 's'
  });
});

// Login
app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Contraseña requerida' });

    const validPassword = process.env.DASHBOARD_PASSWORD;
    if (!validPassword) return res.status(500).json({ error: 'Servidor no configurado' });

    // Comparación directa (para simplificar el setup inicial)
    const isValid = password === validPassword;
    if (!isValid) {
      console.log(`[Auth] Intento de login fallido desde ${req.ip}`);
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    const token = jwt.sign(
      { user: 'admin', company: 'corpprojects' },
      process.env.JWT_SECRET || 'fallback-secret',
      { expiresIn: '24h' }
    );

    console.log(`[Auth] Login exitoso desde ${req.ip}`);
    res.json({ token, expiresIn: '24h' });

  } catch (err) {
    console.error('[Auth] Error en login:', err.message);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ─── RUTAS PROTEGIDAS (requieren token) ──────────────────────────

// Resumen general StelOrder
app.get('/api/summary', requireAuth, async (req, res) => {
  try {
    const summary = await getSummary();
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Facturas pendientes
app.get('/api/invoices/pending', requireAuth, async (req, res) => {
  try {
    const pending = await getPendingInvoices();
    res.json(pending);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Todas las facturas
app.get('/api/invoices', requireAuth, async (req, res) => {
  try {
    const { page = 1, limit = 100 } = req.query;
    const invoices = await getInvoices({ page: parseInt(page), limit: parseInt(limit) });
    res.json(invoices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clientes
app.get('/api/clients', requireAuth, async (req, res) => {
  try {
    const clients = await getClients();
    res.json(clients);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Forzar revisión manual de alertas (desde el dashboard)
app.post('/api/check-alerts', requireAuth, async (req, res) => {
  try {
    console.log(`[API] Revisión manual de alertas solicitada por ${req.ip}`);
    // Ejecutar en background
    checkPendingInvoices().catch(console.error);
    res.json({ message: 'Revisión iniciada. Las alertas se enviarán en breve.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Enviar resumen manual
app.post('/api/send-summary', requireAuth, async (req, res) => {
  try {
    runDailySummary().catch(console.error);
    res.json({ message: 'Resumen enviado por WhatsApp y email.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test de notificaciones
app.post('/api/test-notification', requireAuth, async (req, res) => {
  try {
    const { type } = req.body; // 'whatsapp' | 'email'
    const msg = `✅ *Test Corp Projects Dashboard*\n\nEl sistema de notificaciones funciona correctamente.\n📅 ${new Date().toLocaleString('es-ES')}`;

    if (type === 'whatsapp' || !type) {
      await sendWhatsApp(msg);
    }
    if (type === 'email' || !type) {
      await sendEmail({
        to:      process.env.EMAIL_ADMIN,
        subject: '✅ Test notificación Corp Projects Dashboard',
        html:    `<p>${msg.replace(/\n/g, '<br>')}</p>`,
        text:    msg
      });
    }
    res.json({ message: 'Notificación de prueba enviada.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Catch-all — sirve el frontend para cualquier ruta
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── Arrancar servidor ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║   Corp Projects Dashboard — Servidor   ║');
  console.log(`╚════════════════════════════════════════╝`);
  console.log(`🚀 Servidor en puerto ${PORT}`);
  console.log(`🌍 Entorno: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📊 StelOrder: ${process.env.STELORDER_API_KEY ? '✅ Configurado' : '❌ Sin API key'}`);
  console.log(`📧 Email: ${process.env.EMAIL_USER ? '✅ Configurado' : '⚠️ Sin configurar'}`);
  console.log(`💬 WhatsApp: ${process.env.TWILIO_ACCOUNT_SID ? '✅ Configurado' : '⚠️ Sin configurar (se añade después)'}`);
  console.log('');

  // Arrancar el scheduler de tareas automáticas
  startScheduler();
});

module.exports = app;
