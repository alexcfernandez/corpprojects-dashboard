// public/modules/emails-admin.js
// Panel de emails inteligentes — Corp Projects

const CATEGORIAS = {
  INCIDENCIA:        { emoji: '🔧', label: 'Incidencia',        color: '#f59e0b' },
  PRESUPUESTO:       { emoji: '💬', label: 'Presupuesto',       color: '#4d9cf8' },
  FACTURA_PROVEEDOR: { emoji: '📄', label: 'Factura proveedor', color: '#a78bfa' },
  PAGO_RECIBIDO:     { emoji: '💰', label: 'Pago recibido',     color: '#22c487' },
  COMUNICACION:      { emoji: '📋', label: 'Comunicación',      color: '#8b92a8' },
  PEDIDO_ALBARAN:    { emoji: '📦', label: 'Pedido/Albarán',    color: '#f97316' },
  OTRO:              { emoji: '❓', label: 'Otro',              color: '#5a6278' }
};

const URGENCIAS = {
  ALTA:  { emoji: '🔴', label: 'Urgente' },
  MEDIA: { emoji: '🟡', label: 'Normal'  },
  BAJA:  { emoji: '🟢', label: 'Baja'   }
};

let emailsState = {
  emails: [],
  total: 0,
  pendientes: 0,
  noLeidos: 0,
  filtroCategoria: 'TODOS',
  filtroEstado: 'PENDIENTE',
  filtroUrgencia: 'TODOS',
  emailAbierto: null,
  cargando: false
};

async function cargarEmails() {
  emailsState.cargando = true;
  renderEmails();
  try {
    const params = new URLSearchParams({
      categoria: emailsState.filtroCategoria,
      estado: emailsState.filtroEstado,
      urgencia: emailsState.filtroUrgencia,
      limit: 50
    });
    const data = await apiCall(`/api/emails?${params}`);
    emailsState.emails     = data.emails || [];
    emailsState.total      = data.total || 0;
    emailsState.pendientes = data.pendientes || 0;
    emailsState.noLeidos   = data.noLeidos || 0;
  } catch (err) {
    console.error('[Emails] Error cargando:', err.message);
  }
  emailsState.cargando = false;
  renderEmails();
}

async function forzarPoll() {
  const btn = document.getElementById('btn-poll-emails');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Revisando...'; }
  try {
    await apiCall('/api/emails/poll', 'POST');
    setTimeout(() => {
      cargarEmails();
      if (btn) { btn.disabled = false; btn.textContent = '🔄 Revisar ahora'; }
    }, 3000);
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Revisar ahora'; }
  }
}

async function marcarLeido(id) {
  await apiCall(`/api/emails/${id}/read`, 'PUT');
  const email = emailsState.emails.find(e => e._id === id);
  if (email) email.leido = true;
  renderEmails();
}

async function archivarEmail(id) {
  if (!confirm('¿Archivar este email?')) return;
  await apiCall(`/api/emails/${id}/archive`, 'PUT');
  emailsState.emails = emailsState.emails.filter(e => e._id !== id);
  if (emailsState.emailAbierto?._id === id) emailsState.emailAbierto = null;
  const overlay = document.getElementById('email-detalle-overlay');
  if (overlay) overlay.remove();
  renderEmails();
}

async function ejecutarAccion(id, accion, datos = {}) {
  const btn = document.getElementById(`btn-accion-${accion}-${id}`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Procesando...'; }
  try {
    const result = await apiCall(`/api/emails/${id}/action`, 'POST', {
      accion,
      datos: { ...datos, enviarRespuesta: true }
    });
    const email = emailsState.emails.find(e => e._id === id);
    if (email) {
      email.estado = 'GESTIONADO';
      email.accionRealizada = accion;
      email.stelOrderRef = result.stelOrderRef;
    }
    mostrarToast(`✅ ${accion === 'CREAR_INCIDENCIA' ? 'Incidencia creada' : 'Presupuesto creado'} — Respuesta enviada al cliente`);
    if (emailsState.filtroEstado === 'PENDIENTE') {
      emailsState.emails = emailsState.emails.filter(e => e._id !== id);
    }
    emailsState.emailAbierto = null;
    const overlay = document.getElementById('email-detalle-overlay');
    if (overlay) overlay.remove();
    renderEmails();
  } catch (err) {
    mostrarToast('❌ Error: ' + err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = accion === 'CREAR_INCIDENCIA' ? '🔧 Crear incidencia' : '💬 Crear presupuesto'; }
  }
}

function mostrarToast(msg, tipo = 'ok') {
  const t = document.createElement('div');
  t.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:9999;background:${tipo==='ok'?'#22c487':'#f05252'};color:#fff;padding:12px 20px;border-radius:10px;font-size:14px;font-weight:600;box-shadow:0 4px 20px rgba(0,0,0,.3);max-width:350px`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

async function abrirEmail(id) {
  const email = emailsState.emails.find(e => e._id === id);
  if (!email) return;
  emailsState.emailAbierto = email;
  if (!email.leido) await marcarLeido(id);
  renderDetalle();
}

function cerrarDetalle() {
  emailsState.emailAbierto = null;
  const overlay = document.getElementById('email-detalle-overlay');
  if (overlay) overlay.remove();
  renderEmails();
}

function renderEmails() {
  const container = document.getElementById('emails-content');
  if (!container) return;
  const cat = CATEGORIAS;
  const urg = URGENCIAS;
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px">
      <div>
        <h2 style="font-size:20px;font-weight:700;margin:0">📧 Emails</h2>
        <div style="font-size:13px;color:var(--text3);margin-top:4px">
          ${emailsState.noLeidos} sin leer · ${emailsState.pendientes} pendientes
        </div>
      </div>
      <button id="btn-poll-emails" onclick="forzarPoll()"
        style="background:var(--blue);border:none;border-radius:8px;padding:9px 16px;color:#fff;font-size:13px;font-weight:600;cursor:pointer">
        🔄 Revisar ahora
      </button>
    </div>

    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
      <select onchange="emailsState.filtroEstado=this.value;cargarEmails()"
        style="background:var(--bg3);border:1.5px solid var(--border2);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px">
        <option value="TODOS" ${emailsState.filtroEstado==='TODOS'?'selected':''}>Todos los estados</option>
        <option value="PENDIENTE" ${emailsState.filtroEstado==='PENDIENTE'?'selected':''}>Pendientes</option>
        <option value="GESTIONADO" ${emailsState.filtroEstado==='GESTIONADO'?'selected':''}>Gestionados</option>
        <option value="ARCHIVADO" ${emailsState.filtroEstado==='ARCHIVADO'?'selected':''}>Archivados</option>
      </select>
      <select onchange="emailsState.filtroCategoria=this.value;cargarEmails()"
        style="background:var(--bg3);border:1.5px solid var(--border2);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px">
        <option value="TODOS">Todas las categorías</option>
        ${Object.entries(cat).map(([k,v]) =>
          `<option value="${k}" ${emailsState.filtroCategoria===k?'selected':''}>${v.emoji} ${v.label}</option>`
        ).join('')}
      </select>
      <select onchange="emailsState.filtroUrgencia=this.value;cargarEmails()"
        style="background:var(--bg3);border:1.5px solid var(--border2);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px">
        <option value="TODOS">Todas las urgencias</option>
        ${Object.entries(urg).map(([k,v]) =>
          `<option value="${k}" ${emailsState.filtroUrgencia===k?'selected':''}>${v.emoji} ${v.label}</option>`
        ).join('')}
      </select>
    </div>

    ${emailsState.cargando ? '<div style="text-align:center;padding:40px;color:var(--text3)">⏳ Cargando emails...</div>' : ''}
    ${!emailsState.cargando && emailsState.emails.length === 0 ? `
      <div style="text-align:center;padding:60px 20px;color:var(--text3)">
        <div style="font-size:48px;margin-bottom:12px">📭</div>
        <div style="font-size:16px">No hay emails en esta vista</div>
      </div>
    ` : ''}

    <div style="display:flex;flex-direction:column;gap:10px">
      ${emailsState.emails.map(email => {
        const c = cat[email.categoria] || cat.OTRO;
        const u = urg[email.urgencia] || urg.BAJA;
        const fecha = new Date(email.fecha).toLocaleString('es-ES', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
        const esNuevo = !email.leido && email.estado === 'PENDIENTE';
        const remVerif = email.remitente?.encontrado;
        return `
        <div onclick="abrirEmail('${email._id}')" style="
          background:var(--bg2);border:1.5px solid ${esNuevo ? 'var(--blue)' : 'var(--border)'};
          border-radius:12px;padding:16px;cursor:pointer;transition:border-color .15s;
          ${esNuevo ? 'box-shadow:0 0 0 1px rgba(77,156,248,.2)' : ''}
        ">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
                <span style="background:${c.color}22;color:${c.color};border:1px solid ${c.color}44;border-radius:6px;padding:2px 8px;font-size:12px;font-weight:600">
                  ${c.emoji} ${c.label}
                </span>
                <span style="font-size:12px">${u.emoji} ${u.label}</span>
                ${esNuevo ? '<span style="background:var(--blue);color:#fff;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700">NUEVO</span>' : ''}
                ${email.estado === 'GESTIONADO' ? '<span style="background:rgba(34,196,135,.15);color:var(--green);border-radius:6px;padding:2px 8px;font-size:11px;font-weight:600">✅ GESTIONADO</span>' : ''}
                ${!remVerif ? '<span style="background:rgba(240,82,82,.1);color:var(--red);border-radius:6px;padding:2px 8px;font-size:11px">❌ Desconocido</span>' : '<span style="background:rgba(34,196,135,.1);color:var(--green);border-radius:6px;padding:2px 8px;font-size:11px">✅ Verificado</span>'}
              </div>
              <div style="font-size:13px;color:var(--text3);margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${email.de}</div>
              <div style="font-size:15px;font-weight:${esNuevo?'700':'600'};margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${email.asunto}</div>
              <div style="font-size:13px;color:var(--text2)">💡 ${email.resumen || 'Sin resumen'}</div>
              ${email.stelOrderRef ? `<div style="font-size:12px;color:var(--green);margin-top:4px">📎 ${email.stelOrderRef}</div>` : ''}
            </div>
            <div style="font-size:12px;color:var(--text3);white-space:nowrap;flex-shrink:0">${fecha}</div>
          </div>
        </div>`;
      }).join('')}
    </div>
  `;
}

function renderDetalle() {
  const email = emailsState.emailAbierto;
  if (!email) return;
  const c = CATEGORIAS[email.categoria] || CATEGORIAS.OTRO;
  const u = URGENCIAS[email.urgencia] || URGENCIAS.BAJA;
  const fecha = new Date(email.fecha).toLocaleString('es-ES');
  const remitente = email.remitente || {};
  const permisos = email.permisos || {};

  let overlay = document.getElementById('email-detalle-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'email-detalle-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:1000;display:flex;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto';
    overlay.onclick = (e) => { if (e.target === overlay) cerrarDetalle(); };
    document.body.appendChild(overlay);
  }

  overlay.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:16px;width:100%;max-width:680px;margin:auto">
      <div style="padding:20px 24px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:flex-start">
        <div style="flex:1">
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
            <span style="background:${c.color}22;color:${c.color};border:1px solid ${c.color}44;border-radius:6px;padding:3px 10px;font-size:13px;font-weight:600">${c.emoji} ${c.label}</span>
            <span style="font-size:13px">${u.emoji} ${u.label}</span>
            ${email.estado === 'GESTIONADO' ? '<span style="background:rgba(34,196,135,.15);color:var(--green);border-radius:6px;padding:3px 10px;font-size:13px;font-weight:600">✅ Gestionado</span>' : ''}
          </div>
          <h3 style="font-size:17px;font-weight:700;margin:0 0 6px">${email.asunto}</h3>
          <div style="font-size:13px;color:var(--text3)">${email.de} · ${fecha}</div>
        </div>
        <button onclick="cerrarDetalle()" style="background:none;border:none;color:var(--text3);font-size:20px;cursor:pointer;padding:4px;margin-left:12px">✕</button>
      </div>

      <div style="padding:20px 24px">
        <div style="background:${remitente.encontrado ? 'rgba(34,196,135,.08)' : 'rgba(240,82,82,.08)'};border:1px solid ${remitente.encontrado ? 'rgba(34,196,135,.3)' : 'rgba(240,82,82,.3)'};border-radius:10px;padding:12px 16px;margin-bottom:16px">
          <div style="font-size:13px;font-weight:600;color:${remitente.encontrado ? 'var(--green)' : 'var(--red)'};margin-bottom:4px">
            ${remitente.encontrado ? '✅ Remitente verificado en StelOrder' : '❌ Remitente desconocido'}
          </div>
          ${remitente.encontrado ? `<div style="font-size:13px;color:var(--text2)"><strong>${remitente.nombre}</strong> · ${remitente.tipo}${remitente.familia ? ` · Familia: ${remitente.familia}` : ''}</div>` : `<div style="font-size:13px;color:var(--text3)">Este email no corresponde a ningún cliente en StelOrder. Gestiona manualmente.</div>`}
          <div style="font-size:12px;color:var(--text3);margin-top:4px">${permisos.razon || ''}</div>
        </div>

        <div style="background:var(--bg3);border-radius:10px;padding:14px 16px;margin-bottom:16px">
          <div style="font-size:12px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">💡 Resumen IA</div>
          <div style="font-size:14px;color:var(--text)">${email.resumen || 'Sin resumen'}</div>
          ${email.accionSugerida ? `<div style="font-size:13px;color:var(--blue);margin-top:6px">→ ${email.accionSugerida}</div>` : ''}
          ${email.clienteDetectado ? `<div style="font-size:13px;color:var(--text2);margin-top:4px">Cliente mencionado: <strong>${email.clienteDetectado}</strong></div>` : ''}
          <div style="font-size:11px;color:var(--text3);margin-top:6px">Confianza: ${Math.round((email.confianza||0)*100)}%</div>
        </div>

        <div style="background:var(--bg3);border-radius:10px;padding:14px 16px;margin-bottom:16px;max-height:200px;overflow-y:auto">
          <div style="font-size:12px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">📨 Mensaje</div>
          <div style="font-size:13px;color:var(--text2);white-space:pre-wrap;line-height:1.6">${(email.cuerpo||'').slice(0,1500)}</div>
        </div>

        ${email.stelOrderRef ? `
          <div style="background:rgba(34,196,135,.08);border:1px solid rgba(34,196,135,.2);border-radius:10px;padding:12px 16px;margin-bottom:16px">
            <div style="font-size:13px;color:var(--green);font-weight:600">📎 ${email.stelOrderRef}</div>
          </div>
        ` : ''}

        ${email.estado !== 'GESTIONADO' && email.estado !== 'ARCHIVADO' ? `
          <div style="margin-bottom:16px">
            <div style="font-size:12px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">⚡ Acciones</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${permisos.permitido !== false ? `
                <button id="btn-accion-CREAR_INCIDENCIA-${email._id}" onclick="ejecutarAccion('${email._id}','CREAR_INCIDENCIA')"
                  style="background:rgba(245,158,11,.15);border:1px solid rgba(245,158,11,.4);border-radius:8px;padding:10px 16px;color:#f59e0b;font-size:13px;font-weight:600;cursor:pointer">
                  🔧 Crear incidencia
                </button>
                <button id="btn-accion-CREAR_PRESUPUESTO-${email._id}" onclick="ejecutarAccion('${email._id}','CREAR_PRESUPUESTO')"
                  style="background:rgba(77,156,248,.15);border:1px solid rgba(77,156,248,.4);border-radius:8px;padding:10px 16px;color:var(--blue);font-size:13px;font-weight:600;cursor:pointer">
                  💬 Crear presupuesto
                </button>
              ` : `
                <div style="background:rgba(240,82,82,.1);border:1px solid rgba(240,82,82,.2);border-radius:8px;padding:10px 16px;color:var(--red);font-size:13px">
                  🚫 ${permisos.razon || 'Sin permisos para acciones automáticas'}
                </div>
              `}
              <button onclick="archivarEmail('${email._id}')"
                style="background:var(--bg3);border:1.5px solid var(--border2);border-radius:8px;padding:10px 16px;color:var(--text2);font-size:13px;font-weight:600;cursor:pointer">
                📁 Archivar
              </button>
            </div>
          </div>
        ` : ''}

        <div>
          <div style="font-size:12px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">📝 Notas internas</div>
          <textarea id="nota-email-${email._id}" placeholder="Añade notas internas..."
            style="width:100%;background:var(--bg3);border:1.5px solid var(--border2);border-radius:8px;padding:10px 12px;color:var(--text);font-size:13px;resize:vertical;min-height:70px;font-family:inherit"
          >${email.notas || ''}</textarea>
          <button onclick="guardarNota('${email._id}')"
            style="margin-top:8px;background:var(--bg3);border:1.5px solid var(--border2);border-radius:8px;padding:8px 16px;color:var(--text2);font-size:13px;cursor:pointer">
            💾 Guardar nota
          </button>
        </div>
      </div>
    </div>
  `;
}

async function guardarNota(id) {
  const notas = document.getElementById(`nota-email-${id}`)?.value || '';
  await apiCall(`/api/emails/${id}/nota`, 'PUT', { notas });
  const email = emailsState.emails.find(e => e._id === id);
  if (email) email.notas = notas;
  mostrarToast('✅ Nota guardada');
}

function initEmails() {
  cargarEmails();
  setInterval(async () => {
    try {
      const stats = await apiCall('/api/emails/stats');
      actualizarBadgeEmails(stats.noLeidos);
    } catch(e) {}
  }, 5 * 60 * 1000);
}

function actualizarBadgeEmails(count) {
  const badge = document.getElementById('badge-emails');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

window.initEmails     = initEmails;
window.cargarEmails   = cargarEmails;
window.forzarPoll     = forzarPoll;
window.abrirEmail     = abrirEmail;
window.cerrarDetalle  = cerrarDetalle;
window.archivarEmail  = archivarEmail;
window.ejecutarAccion = ejecutarAccion;
window.guardarNota    = guardarNota;
