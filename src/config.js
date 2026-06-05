// src/config.js — Fuente única de verdad para Corp Projects (backend)
// Se importa con require('./config') desde partes.js, attendance.js, expedientes.js

const CONFIG = {

  // ── Rates por nombre (minúsculas) ─────────────────────────────
  rates: {
    'jose beliard':    26.72,
    'diego campillo':  19.05,
    'abdellah souiri': 13.28,
    'mamadou barry':   13.28,
    'paula morales':   8.66,
  },
  defaultRate: 15,

  // ── Workers fallback (si MongoDB no responde) ─────────────────
  workersFallback: [
    { id: 'jose',     name: 'Jose Beliard',    color: '#4d9cf8', pin: '1234' },
    { id: 'diego',    name: 'Diego Campillo',  color: '#22c487', pin: '2345' },
    { id: 'abdellah', name: 'Abdellah Souiri', color: '#f59e0b', pin: '3456' },
    { id: 'mamadou',  name: 'Mamadou Barry',   color: '#a78bfa', pin: '4567' },
    { id: 'paula',    name: 'Paula Morales',   color: '#f05252', pin: '5678' },
  ],

  // ── Tipos de jornada ──────────────────────────────────────────
  tiposJornada: {
    NORMAL:  { label: 'Normal',  emoji: '📅', color: '#4d9cf8' },
    EXTRA:   { label: 'Extra',   emoji: '⭐', color: '#f59e0b' },
    GUARDIA: { label: 'Guardia', emoji: '🛡️', color: '#a78bfa' },
  },

  // ── Estados del trabajo (partes) ──────────────────────────────
  estadosTrabajo: {
    completado: { label: 'Completado',        emoji: '✅', color: '#22c487' },
    continua:   { label: 'Continúa otro día', emoji: '🔴', color: '#f05252' },
    parcial:    { label: 'Parcial',           emoji: '🟡', color: '#f59e0b' },
    material:   { label: 'Necesito material', emoji: '📦', color: '#a78bfa' },
  },

  // ── Estados de revisión (partes — admin) ──────────────────────
  estadosPartes: {
    pendiente:  { label: 'Pendiente revisión', emoji: '⏳', color: '#f59e0b' },
    verificado: { label: 'Verificado',         emoji: '✅', color: '#22c487' },
    facturado:  { label: 'Facturado',          emoji: '💰', color: '#4d9cf8' },
    incidencia: { label: 'Con incidencia',     emoji: '⚠️', color: '#f05252' },
  },

  // ── Estados de presencia ──────────────────────────────────────
  estadosPresencia: {
    obra:       { label: 'En obra',           emoji: '🏗️', color: '#22c487' },
    oficina:    { label: 'Oficina/almacén',   emoji: '🏢', color: '#4d9cf8' },
    vacaciones: { label: 'Vacaciones',        emoji: '🌴', color: '#a78bfa' },
    baja:       { label: 'Baja médica',       emoji: '🏥', color: '#f59e0b' },
    falta_j:    { label: 'Falta justificada', emoji: '📋', color: '#f59e0b' },
    falta_i:    { label: 'Falta injust.',     emoji: '❌', color: '#f05252' },
    libre:      { label: 'Libre',             emoji: '⏸️', color: '#5a6278' },
  },

  // ── Estados de expedientes ────────────────────────────────────
  estadosExpedientes: {
    EN_CURSO:   { label: 'En curso',   emoji: '🔴', color: '#f05252' },
    COMPLETADO: { label: 'Completado', emoji: '✅', color: '#22c487' },
    PAUSADO:    { label: 'Pausado',    emoji: '⏸️', color: '#f59e0b' },
  },

  // ── Helpers ───────────────────────────────────────────────────
  getRateForWorker(worker) {
    const key = (worker.name || '').toLowerCase();
    return this.rates[key] || worker.rate || this.defaultRate;
  },

  esFinDeSemana(fecha) {
    const dow = new Date(fecha + 'T12:00:00').getDay();
    return dow === 0 || dow === 6;
  },

  tipoJornadaPorFecha(fecha) {
    return this.esFinDeSemana(fecha) ? 'EXTRA' : 'NORMAL';
  },

};

module.exports = CONFIG;
