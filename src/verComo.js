// src/verComo.js — «Ver como…» (3/11/2026, Álex: «quiero ver cómo le aparecen a David sus partes y trabajos en el móvil»).
// El dueño pide un token w_vc_ de 30 minutos con el rol REAL del trabajador; con él se abre /fichar tal cual lo ve él.
// Este candado va delante de todas las rutas /api/: con un token w_vc_ solo se puede leer (nada de fichar, guardar,
// subir ni traducir) y tampoco se abren sus documentos personales (nóminas, firmas).
'use strict';
const PREFIJO = 'w_vc_', MINUTOS = 30;

function soloLectura(req, res, next) {
  const token = String(req.headers.authorization || '').replace('Bearer ', '');
  if (!token.startsWith(PREFIJO)) return next();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return res.status(403).json({ error: 'Estás en «ver como»: es solo para mirar, no se ha guardado nada.', soloLectura: true });
  if (/^\/(api\/)?fichaje\/(mis-docs\/|firmas\/)/.test(req.path)) return res.status(403).json({ error: 'En «ver como» no se abren los documentos personales.', soloLectura: true });
  next();
}

function nuevoToken(u, por, { ahora = Date.now() } = {}) {
  return {
    token: PREFIJO + require('crypto').randomBytes(16).toString('hex'),
    workerId: String(u._id), workerName: u.name, workerRole: u.role, soloLectura: true, verComoPor: por || 'Dueño',
    createdAt: new Date(ahora), expiresAt: new Date(ahora + MINUTOS * 60 * 1000),
  };
}

module.exports = { soloLectura, nuevoToken, PREFIJO, MINUTOS };
