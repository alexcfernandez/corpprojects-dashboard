// public/config.js — Fuente única de verdad para Corp Projects (frontend)
// Se carga antes que todos los módulos en index.html

window.CP_CONFIG = {

  // ── Workers ───────────────────────────────────────────────────
  // Se rellenan al init desde /api/partes/workers
  // Nunca los definas en otro sitio — usa siempre window.CP_CONFIG.workers
  workers: [],

  // ── Rates de coste por hora (por nombre en minúsculas) ────────
  rates: {
    'jose beliard':    26.72,
    'diego campillo':  19.05,
    'abdellah souiri': 13.28,
    'mamadou barry':   13.28,
    'paula morales':   8.66,
  },
  defaultRate: 15,

  // ── Colores por worker ID (para parte.html y presencia) ───────
  workerColors: {
    jose:     '#4d9cf8',
    diego:    '#22c487',
    abdellah: '#f59e0b',
    mamadou:  '#a78bfa',
    paula:    '#f05252',
  },

  // ── Tipos de jornada ──────────────────────────────────────────
  tiposJornada: {
    NORMAL:  { label: 'Normal',  emoji: '📅', color: '#4d9cf8' },
    EXTRA:   { label: 'Extra',   emoji: '⭐', color: '#f59e0b' },
    GUARDIA: { label: 'Guardia', emoji: '🛡️', color: '#a78bfa' },
  },

  // ── Estados del trabajo (partes — lo que reporta el trabajador)
  estadosTrabajo: {
    completado: { label: 'Completado',        emoji: '✅', color: '#22c487' },
    continua:   { label: 'Continúa otro día', emoji: '🔴', color: '#f05252' },
    parcial:    { label: 'Parcial',           emoji: '🟡', color: '#f59e0b' },
    material:   { label: 'Necesito material', emoji: '📦', color: '#a78bfa' },
  },

  // ── Estados de revisión de partes (admin) ─────────────────────
  estadosPartes: {
    pendiente:  { label: 'Pendiente revisión', emoji: '⏳', color: '#f59e0b' },
    verificado: { label: 'Verificado',         emoji: '✅', color: '#22c487' },
    facturado:  { label: 'Facturado',          emoji: '💰', color: '#4d9cf8' },
    incidencia: { label: 'Con incidencia',     emoji: '⚠️', color: '#f05252' },
  },

  // ── Estados de presencia (calendario admin) ───────────────────
  estadosPresencia: {
    obra:       { label: 'En obra',            emoji: '🏗️', color: '#22c487' },
    oficina:    { label: 'Oficina/almacén',    emoji: '🏢', color: '#4d9cf8' },
    vacaciones: { label: 'Vacaciones',         emoji: '🌴', color: '#a78bfa' },
    baja:       { label: 'Baja médica',        emoji: '🏥', color: '#f59e0b' },
    falta_j:    { label: 'Falta justificada',  emoji: '📋', color: '#f59e0b' },
    falta_i:    { label: 'Falta injust.',      emoji: '❌', color: '#f05252' },
    libre:      { label: 'Libre',              emoji: '⏸️', color: '#5a6278' },
  },

  // ── Estados de presencia para informe PDF ─────────────────────
  // (letra corta para el calendario impreso)
  estadosPresenciaInforme: {
    obra:       { l: 'O', bg: '#dcfce7', c: '#16a34a', label: 'En obra' },
    oficina:    { l: 'F', bg: '#dbeafe', c: '#2563eb', label: 'Oficina' },
    vacaciones: { l: 'V', bg: '#ede9fe', c: '#7c3aed', label: 'Vacaciones' },
    baja:       { l: 'B', bg: '#fef3c7', c: '#d97706', label: 'Baja' },
    falta_j:    { l: 'J', bg: '#fef3c7', c: '#d97706', label: 'Falta just.' },
    falta_i:    { l: 'X', bg: '#fee2e2', c: '#dc2626', label: 'Falta injust.' },
    libre:      { l: 'L', bg: '#f1f5f9', c: '#94a3b8', label: 'Libre' },
  },

  // ── Estados de obras ──────────────────────────────────────────
  estadosObras: {
    activa:    { label: 'En curso',   emoji: '🏗️', color: '#22c487' },
    pausada:   { label: 'Pausada',    emoji: '⏸️', color: '#f59e0b' },
    terminada: { label: 'Terminada',  emoji: '✅', color: '#4d9cf8' },
    facturada: { label: 'Facturada',  emoji: '💰', color: '#a78bfa' },
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

  // Carga workers desde API y los guarda aquí
  // Llamar una sola vez al init del dashboard
  async loadWorkers() {
    try {
      const tok = localStorage.getItem('cp_token');
      const r   = await fetch('/api/partes/workers', {
        headers: { 'Authorization': `Bearer ${tok}` }
      });
      const data = await r.json();
      if (Array.isArray(data) && data.length > 0) {
        this.workers = data.map(w => ({
          ...w,
          rate: this.getRateForWorker(w)
        }));
        console.log(`[Config] ✅ ${this.workers.length} workers cargados`);
      }
    } catch(e) {
      console.warn('[Config] Workers fallback:', e.message);
      this.workers = [
        { id:'jose',     name:'Jose Beliard',    color:'#4d9cf8', rate:26.72 },
        { id:'diego',    name:'Diego Campillo',  color:'#22c487', rate:19.05 },
        { id:'abdellah', name:'Abdellah Souiri', color:'#f59e0b', rate:13.28 },
        { id:'mamadou',  name:'Mamadou Barry',   color:'#a78bfa', rate:13.28 },
        { id:'paula',    name:'Paula Morales',   color:'#f05252', rate:8.66  },
      ];
    }
    return this.workers;
  },

  // Detecta si una fecha es fin de semana
  esFinDeSemana(fecha) {
    const dow = new Date(fecha + 'T12:00:00').getDay();
    return dow === 0 || dow === 6;
  },

  // Detecta tipo de jornada según fecha
  tipoJornadaPorFecha(fecha) {
    return this.esFinDeSemana(fecha) ? 'EXTRA' : 'NORMAL';
  },

};
