// public/modules/emails-admin.js
// Panel de emails inteligentes — Corp Projects

const CATEGORIAS = {
  INCIDENCIA:        { emoji: '🔧', label: 'Incidencia',        color: '#f59e0b' },
  PRESUPUESTO:       { emoji: '💬', label: 'Presupuesto',       color: '#4d9cf8' },
  FACTURA_PROVEEDOR: { emoji: '📄', label: 'Factura proveedor', color: '#a78bfa' },
  PAGO_RECIBIDO:     { emoji: '💰', label: 'Pago recibido',     color: '#22c487' },
  COMUNICACION:      { emoji: '📋', label: 'Comunicación',      color: '#8b92a8' },
  PEDIDO_ALBARAN:    { emoji: '📦', label: 'Pedido/Albarán',    color: '#f97316' },
  PUBLICIDAD:        { emoji: '📢', label: 'Publicidad',        color: '#6b7280' },
  SPAM:              { emoji: '🚫', label: 'Spam',              color: '#ef4444' },
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

// ── Helpers ───────────────────────────────────────────────────────
function extraerEmailMostrado(de) {
  if (!de) return { nombre: 'Desconocido', email: '' };
  const m = de.match(/^"?([^"<]+)"?\s*<([^>]+)>/);
  if (m) return { nombre: m[1].trim(), email: m[2].trim().toLowerCase() };
  return { nombre: de.split('@')[0], email: de.trim().toLowerCase() };
}

function limpiarMensaje(cuerpo) {
  if (!cuerpo) return '';
  return cuerpo
    // URLs muy largas → reemplazar por texto legible
    .replace(/https?:\/\/\S{80,}/g, '[ver enlace]')
    // Quitar líneas que son solo URL corta
    .replace(/^https?:\/\/\S+$/gm, '')
    // Quitar caracteres de encoding quoted-printable
    .replace(/=[A-F0-9]{2}/g, '')
    // Limpiar espacios y saltos excesivos
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{4,}/g, '\n\n')
    .trim()
    .slice(0, 2000);
}

function formatFecha(fecha) {
  const d = new Date(fecha);
  const ahora = new Date();
  const diff = ahora - d;
  if (diff < 60 * 60 * 1000) return `hace ${Math.round(diff / 60000)}min`;
  if (diff < 24 * 60 * 60 * 1000) return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' }) +
    ' ' + d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

function mostrarToast(msg, tipo = 'ok') {
  const t = document.createElement('div');
  t.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:9999;background:${tipo==='ok'?'#22c487':'#f05252'};color:#fff;padding:12px 20px;border-radius:10px;font-size:14px;font-weight:600;box-shadow:0 4px 20px rgba(0,0,0,.3);max-width:350px`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// ── API calls ─────────────────────────────────────────────────────
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
}

async function marcarImportante(id) {
  const email = emailsState.emails.find(e => e._id === id);
  if (!email) return;
  const nuevoValor = !email.importante;
  await apiCall(`/api/emails/${id}/importante`, 'PUT', { importante: nuevoValor });
  email.importante = nuevoValor;
  renderEmails();
  if (emailsState.emailAbierto?._id === id) renderDetalle();
  mostrarToast(nuevoValor ? '⭐ Marcado como importante' : 'Desmarcado como importante');
}

async function archivarEmail(id) {
  if (!confirm('¿Archivar este email?')) return;
  await apiCall(`/api/emails/${id}/archive`, 'PUT');
  emailsState.emails = emailsState.emails.filter(e => e._id !== id);
  cerrarDetalle();
  renderEmails();
  mostrarToast('📁 Email archivado');
}

async function eliminarEmail(id) {
  if (!confirm('¿Eliminar este email permanentemente?')) return;
  await apiCall(`/api/emails/${id}`, 'DELETE');
  emailsState.emails = emailsState.emails.filter(e => e._id !== id);
  cerrarDetalle();
  renderEmails();
  mostrarToast('🗑️ Email eliminado');
}

async function responderEmail(id) {
  const email = emailsState.emails.find(e => e._id === id);
  if (!email) return;
  const { email: emailAddr } = extraerEmailMostrado(email.de);
  // Abrir cliente de correo nativo con el email prellenado
  const mailtoUrl = `mailto:${emailAddr}?subject=Re: ${encodeURIComponent(email.asunto)}`;
  window.open(mailtoUrl, '_blank');
}

async function reenviarEmail(id) {
  const email = emailsState.emails.find(e => e._id === id);
  if (!email) return;
  const dest = prompt('Reenviar a (email):');
  if (!dest) return;
  await apiCall(`/api/emails/${id}/reenviar`, 'POST', { destino: dest });
  mostrarToast(`📤 Reenviado a ${dest}`);
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
    const labels = {
      CREAR_INCIDENCIA: 'Incidencia creada',
      CREAR_PRESUPUESTO: 'Presupuesto creado',
      MARCAR_PAGADO: 'Marcado como pagado'
    };
    mostrarToast(`✅ ${labels[accion] || 'Acción ejecutada'} — Respuesta enviada`);
    if (emailsState.filtroEstado === 'PENDIENTE') {
      emailsState.emails = emailsState.emails.filter(e => e._id !== id);
    }
    emailsState.emailAbierto = null;
    cerrarDetalle();
    renderEmails();
  } catch (err) {
    mostrarToast('❌ Error: ' + err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '⚡ Reintentar'; }
  }
}

async function guardarNota(id) {
  const notas = document.getElementById(`nota-email-${id}`)?.value || '';
  await apiCall(`/api/emails/${id}/nota`, 'PUT', { notas });
  const email = emailsState.emails.find(e => e._id === id);
  if (email) email.notas = notas;
  mostrarToast('✅ Nota guardada');
}

// ── Modal detalle ─────────────────────────────────────────────────
async function abrirEmail(id) {
  const email = emailsState.emails.find(e => e._id === id);
  if (!email) return;
  emailsState.emailAbierto = email;
  if (!email.leido) await marcarLeido(id);
  renderDetalle();
  cargarAdjuntos(id);
}

function fmtBytes(n) {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

async function cargarAdjuntos(emailId) {
  const box = document.getElementById('email-adjuntos-lista');
  if (!box) return;
  try {
    const r = await apiCall(`/api/emails/${emailId}/attachments`);
    const atts = (r && r.attachments) || [];
    if (!atts.length) {
      const wrap = document.getElementById('email-adjuntos');
      if (wrap) wrap.style.display = 'none';
      return;
    }
    box.innerHTML = atts.map(a => `
      <div style="display:inline-flex;align-items:center;gap:8px;background:var(--bg2);border:1px solid var(--border2);border-radius:8px;padding:8px 12px;margin:0 8px 8px 0">
        <span style="font-size:13px;color:var(--text)">📄 ${escE(a.filename)}</span>
        <span style="font-size:11px;color:var(--text3)">${fmtBytes(a.size)}</span>
        <button class="btn bp" style="padding:4px 10px;font-size:12px"
          onclick="descargarAdjunto('${emailId}', '${escE(a.attachmentId)}', '${escE(a.filename).replace(/'/g, "\\'")}')">⬇ Descargar</button>
      </div>`).join('');
  } catch (e) {
    box.innerHTML = `<span style="color:var(--red)">No se pudieron cargar los adjuntos: ${escE(e.message)}</span>`;
  }
}

async function descargarAdjunto(emailId, attId, filename) {
  try {
    const resp = await fetch(`${API}/api/emails/${emailId}/attachments/${encodeURIComponent(attId)}/download`, {
      headers: { 'Authorization': `Bearer ${tok}` }
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename || 'adjunto';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (e) {
    alert('No se pudo descargar el adjunto: ' + e.message);
  }
}

function cerrarDetalle() {
  emailsState.emailAbierto = null;
  const overlay = document.getElementById('email-detalle-overlay');
  if (overlay) overlay.remove();
}

// ── Render lista ──────────────────────────────────────────────────
// Escapar HTML: imprescindible porque asuntos/remitentes pueden traer < > "
// (un remitente "<facturacion@...>" sin escapar rompía el DOM y anidaba las tarjetas)
function escE(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
  ));
}

async function diagIA() {
  const out = document.getElementById('emails-diag-out');
  if (out) { out.style.display = 'block'; out.textContent = 'Probando la IA…'; }
  try {
    const r = await apiCall('/api/emails/diag');
    if (!r || r.error || !r.ok) {
      out.textContent = '✗ La IA NO está funcionando.\nCausa: ' + ((r && r.error) || 'desconocida') +
        (r && r.uso ? `\nLlamadas hoy: ${r.uso.usadas}/${r.uso.limite}` : '');
    } else {
      out.textContent = '✅ La IA funciona (' + (r.modelo || '') + '). Prueba: ' + (r.resultado?.categoria || '?') +
        ' / ' + (r.resultado?.urgencia || '?') +
        (r.uso ? `\nLlamadas hoy: ${r.uso.usadas}/${r.uso.limite}` : '') +
        '\nPulsa "Reclasificar" para arreglar los emails ya guardados.';
    }
  } catch (e) { if (out) out.textContent = '✗ Error: ' + e.message; }
}

async function reclasificarEmails() {
  if (!confirm('Se reclasificarán con IA los emails que quedaron sin clasificar (puede tardar un par de minutos). ¿Continuar?')) return;
  const out = document.getElementById('emails-diag-out');
  if (out) { out.style.display = 'block'; out.textContent = 'Reclasificando… (no cierres la pestaña)'; }
  try {
    const r = await apiCall('/api/emails/reclassify', 'POST', {});
    if (!r || r.error) throw new Error((r && r.error) || 'sin respuesta');
    out.textContent = `✓ Reclasificados ${r.reclasificados} de ${r.encontrados}` +
      (r.fallos ? ` · ${r.fallos} fallos (${r.primerError || ''})` : '');
    cargarEmails();
  } catch (e) { if (out) out.textContent = '✗ Error: ' + e.message; }
}

function renderEmails() {
  const container = document.getElementById('emails-content');
  if (!container) return;

  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px">
      <div>
        <h2 style="font-size:20px;font-weight:700;margin:0">📧 Emails</h2>
        <div style="font-size:13px;color:var(--text3);margin-top:4px">
          ${emailsState.noLeidos} sin leer · ${emailsState.pendientes} pendientes
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button onclick="diagIA()"
          style="background:var(--bg3);border:1.5px solid var(--border2);border-radius:8px;padding:9px 14px;color:var(--text);font-size:13px;font-weight:600;cursor:pointer">
          🧪 Diagnóstico IA
        </button>
        <button onclick="reclasificarEmails()"
          style="background:var(--bg3);border:1.5px solid var(--border2);border-radius:8px;padding:9px 14px;color:var(--text);font-size:13px;font-weight:600;cursor:pointer">
          ♻️ Reclasificar
        </button>
        <button id="btn-poll-emails" onclick="forzarPoll()"
          style="background:var(--blue);border:none;border-radius:8px;padding:9px 16px;color:#fff;font-size:13px;font-weight:600;cursor:pointer">
          🔄 Revisar ahora
        </button>
      </div>
    </div>
    <pre id="emails-diag-out" style="display:none;background:var(--bg2);border-radius:8px;padding:10px;font-size:12px;white-space:pre-wrap;margin-bottom:14px"></pre>

    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
      <select onchange="emailsState.filtroEstado=this.value;cargarEmails()"
        style="background:var(--bg3);border:1.5px solid var(--border2);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px">
        <option value="TODOS">Todos los estados</option>
        <option value="PENDIENTE" ${emailsState.filtroEstado==='PENDIENTE'?'selected':''}>Pendientes</option>
        <option value="GESTIONADO">Gestionados</option>
        <option value="ARCHIVADO">Archivados</option>
      </select>
      <select onchange="emailsState.filtroCategoria=this.value;cargarEmails()"
        style="background:var(--bg3);border:1.5px solid var(--border2);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px">
        <option value="TODOS">Todas las categorías</option>
        ${Object.entries(CATEGORIAS).map(([k,v]) =>
          `<option value="${k}" ${emailsState.filtroCategoria===k?'selected':''}>${v.emoji} ${v.label}</option>`
        ).join('')}
      </select>
      <select onchange="emailsState.filtroUrgencia=this.value;cargarEmails()"
        style="background:var(--bg3);border:1.5px solid var(--border2);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px">
        <option value="TODOS">Todas las urgencias</option>
        ${Object.entries(URGENCIAS).map(([k,v]) =>
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

    <div style="display:flex;flex-direction:column;gap:8px">
      ${emailsState.emails.map(email => {
        const c = CATEGORIAS[email.categoria] || CATEGORIAS.OTRO;
        const u = URGENCIAS[email.urgencia]   || URGENCIAS.BAJA;
        const { nombre, email: addr } = extraerEmailMostrado(email.de);
        const esNuevo = !email.leido && email.estado === 'PENDIENTE';
        const remVerif = email.remitente?.encontrado;
        return `
        <div onclick="abrirEmail('${email._id}')" style="
          background:var(--bg2);
          border:1.5px solid ${esNuevo ? 'var(--blue)' : email.importante ? '#f59e0b' : 'var(--border)'};
          border-radius:12px;padding:14px 16px;cursor:pointer;
          ${esNuevo ? 'box-shadow:0 0 0 1px rgba(77,156,248,.15)' : ''}
          ${email.importante ? 'box-shadow:0 0 0 1px rgba(245,158,11,.15)' : ''}
        ">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap">
                <span style="background:${c.color}22;color:${c.color};border:1px solid ${c.color}44;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:600">
                  ${c.emoji} ${c.label}
                </span>
                <span style="font-size:12px">${u.emoji} ${u.label}</span>
                ${esNuevo ? '<span style="background:var(--blue);color:#fff;border-radius:6px;padding:2px 7px;font-size:11px;font-weight:700">NUEVO</span>' : ''}
                ${email.importante ? '<span style="color:#f59e0b;font-size:14px">⭐</span>' : ''}
                ${email.estado === 'GESTIONADO' ? '<span style="background:rgba(34,196,135,.15);color:var(--green);border-radius:6px;padding:2px 7px;font-size:11px;font-weight:600">✅ GESTIONADO</span>' : ''}
                ${!remVerif ? '<span style="background:rgba(240,82,82,.1);color:var(--red);border-radius:6px;padding:2px 7px;font-size:11px">❌ Desconocido</span>'
                            : '<span style="background:rgba(34,196,135,.1);color:var(--green);border-radius:6px;padding:2px 7px;font-size:11px">✅ Verificado</span>'}
              </div>
              <div style="font-size:13px;color:var(--text3);margin-bottom:3px">
                <strong style="color:var(--text2)">${escE(nombre)}</strong>
                ${addr ? `<span style="opacity:.7"> · ${escE(addr)}</span>` : ''}
              </div>
              <div style="font-size:15px;font-weight:${esNuevo?'700':'500'};margin-bottom:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                ${email.tieneAdjuntos ? '📎 ' : ''}${escE(email.asunto)}
              </div>
              <div style="font-size:13px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                💡 ${escE(email.resumen || '—')}
              </div>
            </div>
            <div style="font-size:12px;color:var(--text3);white-space:nowrap;flex-shrink:0;text-align:right">
              ${formatFecha(email.fecha)}
              ${email.stelOrderRef ? `<div style="color:var(--green);margin-top:4px;font-size:11px">📎</div>` : ''}
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>
  `;
}

// ── Render detalle (modal) ────────────────────────────────────────
function renderDetalle() {
  const email = emailsState.emailAbierto;
  if (!email) return;

  const c = CATEGORIAS[email.categoria] || CATEGORIAS.OTRO;
  const u = URGENCIAS[email.urgencia]   || URGENCIAS.BAJA;
  const { nombre, email: addr } = extraerEmailMostrado(email.de);
  const remitente = email.remitente || {};
  const permisos  = email.permisos  || {};
  const cuerpoLimpio = limpiarMensaje(email.cuerpo);
  const fecha = new Date(email.fecha).toLocaleString('es-ES');

  let overlay = document.getElementById('email-detalle-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'email-detalle-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:1000;display:flex;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto';
    overlay.onclick = (e) => { if (e.target === overlay) cerrarDetalle(); };
    document.body.appendChild(overlay);
  }

  overlay.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:16px;width:100%;max-width:700px;margin:auto">

      <!-- CABECERA -->
      <div style="padding:18px 22px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
        <div style="flex:1;min-width:0">
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
            <span style="background:${c.color}22;color:${c.color};border:1px solid ${c.color}44;border-radius:6px;padding:3px 10px;font-size:13px;font-weight:600">${c.emoji} ${c.label}</span>
            <span style="background:var(--bg3);border-radius:6px;padding:3px 10px;font-size:13px">${u.emoji} ${u.label}</span>
            ${email.importante ? '<span style="color:#f59e0b;font-size:18px">⭐</span>' : ''}
            ${email.estado === 'GESTIONADO' ? '<span style="background:rgba(34,196,135,.15);color:var(--green);border-radius:6px;padding:3px 10px;font-size:13px;font-weight:600">✅ Gestionado</span>' : ''}
          </div>
          <h3 style="font-size:17px;font-weight:700;margin:0 0 8px;line-height:1.3">${escE(email.asunto)}</h3>
          <div style="font-size:13px;color:var(--text3)">
            <strong style="color:var(--text)">${escE(nombre)}</strong>
            ${addr ? `<span> · ${escE(addr)}</span>` : ''}
            <span> · ${fecha}</span>
          </div>
        </div>
        <button onclick="cerrarDetalle()" style="background:none;border:none;color:var(--text3);font-size:22px;cursor:pointer;padding:2px 6px;flex-shrink:0;line-height:1">✕</button>
      </div>

      <!-- BARRA DE ACCIONES RÁPIDAS -->
      <div style="padding:12px 22px;border-bottom:1px solid var(--border);display:flex;gap:8px;flex-wrap:wrap">
        <button onclick="responderEmail('${email._id}')"
          style="background:var(--blue);border:none;border-radius:8px;padding:8px 14px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px">
          ↩️ Responder
        </button>
        <button onclick="reenviarEmail('${email._id}')"
          style="background:var(--bg3);border:1.5px solid var(--border2);border-radius:8px;padding:8px 14px;color:var(--text2);font-size:13px;font-weight:600;cursor:pointer">
          📤 Reenviar
        </button>
        <button onclick="marcarImportante('${email._id}')"
          style="background:var(--bg3);border:1.5px solid ${email.importante ? '#f59e0b' : 'var(--border2)'};border-radius:8px;padding:8px 14px;color:${email.importante ? '#f59e0b' : 'var(--text2)'};font-size:13px;font-weight:600;cursor:pointer">
          ${email.importante ? '⭐ Importante' : '☆ Marcar importante'}
        </button>
        <button onclick="archivarEmail('${email._id}')"
          style="background:var(--bg3);border:1.5px solid var(--border2);border-radius:8px;padding:8px 14px;color:var(--text2);font-size:13px;font-weight:600;cursor:pointer">
          📁 Archivar
        </button>
        <button onclick="eliminarEmail('${email._id}')"
          style="background:rgba(240,82,82,.1);border:1.5px solid rgba(240,82,82,.3);border-radius:8px;padding:8px 14px;color:var(--red);font-size:13px;font-weight:600;cursor:pointer">
          🗑️ Eliminar
        </button>
      </div>

      <div style="padding:20px 22px;display:flex;flex-direction:column;gap:14px">

        <!-- REMITENTE -->
        <div style="background:${remitente.encontrado ? 'rgba(34,196,135,.08)' : 'rgba(240,82,82,.08)'};border:1px solid ${remitente.encontrado ? 'rgba(34,196,135,.3)' : 'rgba(240,82,82,.3)'};border-radius:10px;padding:12px 16px">
          <div style="font-size:13px;font-weight:700;color:${remitente.encontrado ? 'var(--green)' : 'var(--red)'};margin-bottom:6px">
            ${remitente.encontrado ? '✅ Remitente verificado en StelOrder' : '❌ Remitente desconocido'}
          </div>
          ${remitente.encontrado
            ? `<div style="font-size:13px;color:var(--text2)">
                <strong>${remitente.nombre}</strong> · ${remitente.tipo}
                ${remitente.familia ? ` · Familia: ${remitente.familia}` : ''}
               </div>`
            : `<div style="font-size:13px;color:var(--text)">
                <strong>${escE(nombre)}</strong>
                ${addr ? `<span style="color:var(--text3)"> · ${escE(addr)}</span>` : ''}
               </div>
               <div style="font-size:12px;color:var(--text3);margin-top:4px">
                 Este email no corresponde a ningún cliente en StelOrder. Gestiona manualmente.
               </div>`
          }
          <div style="font-size:12px;color:var(--text3);margin-top:4px">${permisos.razon || ''}</div>
        </div>

        <!-- RESUMEN IA -->
        <div style="background:var(--bg3);border-radius:10px;padding:14px 16px">
          <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">💡 Resumen IA</div>
          <div style="font-size:14px;color:var(--text);line-height:1.5;margin-bottom:6px">
            ${escE(email.resumen || `Email de ${nombre} sobre "${email.asunto}"`)}
          </div>
          ${email.accionSugerida ? `<div style="font-size:13px;color:var(--blue);margin-top:6px">→ ${escE(email.accionSugerida)}</div>` : ''}
          ${email.clienteDetectado ? `<div style="font-size:13px;color:var(--text2);margin-top:4px">Cliente mencionado: <strong>${email.clienteDetectado}</strong></div>` : ''}
          <div style="font-size:11px;color:var(--text3);margin-top:8px">Confianza: ${Math.round((email.confianza||0)*100)}%</div>
        </div>

        <!-- CUERPO DEL EMAIL -->
        <div style="background:var(--bg3);border-radius:10px;padding:14px 16px">
          <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">📨 Mensaje</div>
          <div style="font-size:13px;color:var(--text2);white-space:pre-wrap;line-height:1.7;max-height:260px;overflow-y:auto">
            ${cuerpoLimpio ? escE(cuerpoLimpio) : '<span style="color:var(--text3);font-style:italic">Sin contenido de texto</span>'}
          </div>
        </div>

        <!-- ADJUNTOS (se cargan al abrir, en vivo desde Gmail) -->
        <div id="email-adjuntos" style="background:var(--bg3);border-radius:10px;padding:14px 16px">
          <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">📎 Adjuntos</div>
          <div id="email-adjuntos-lista" style="font-size:13px;color:var(--text3)">Buscando adjuntos…</div>
        </div>

        ${email.stelOrderRef ? `
          <div style="background:rgba(34,196,135,.08);border:1px solid rgba(34,196,135,.2);border-radius:10px;padding:12px 16px">
            <div style="font-size:13px;color:var(--green);font-weight:600">📎 Creado en StelOrder: ${email.stelOrderRef}</div>
          </div>
        ` : ''}

        <!-- ACCIONES STELORDER -->
        ${email.estado !== 'GESTIONADO' && email.estado !== 'ARCHIVADO' ? `
          <div>
            <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">⚡ Acciones en StelOrder</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${permisos.permitido !== false ? `
                <button id="btn-accion-CREAR_INCIDENCIA-${email._id}"
                  onclick="ejecutarAccion('${email._id}','CREAR_INCIDENCIA')"
                  style="background:rgba(245,158,11,.15);border:1px solid rgba(245,158,11,.4);border-radius:8px;padding:10px 16px;color:#f59e0b;font-size:13px;font-weight:600;cursor:pointer">
                  🔧 Crear incidencia
                </button>
                <button id="btn-accion-CREAR_PRESUPUESTO-${email._id}"
                  onclick="ejecutarAccion('${email._id}','CREAR_PRESUPUESTO')"
                  style="background:rgba(77,156,248,.15);border:1px solid rgba(77,156,248,.4);border-radius:8px;padding:10px 16px;color:var(--blue);font-size:13px;font-weight:600;cursor:pointer">
                  💬 Crear presupuesto
                </button>
                ${email.categoria === 'PAGO_RECIBIDO' ? `
                  <button id="btn-accion-MARCAR_PAGADO-${email._id}"
                    onclick="ejecutarAccion('${email._id}','MARCAR_PAGADO')"
                    style="background:rgba(34,196,135,.15);border:1px solid rgba(34,196,135,.4);border-radius:8px;padding:10px 16px;color:var(--green);font-size:13px;font-weight:600;cursor:pointer">
                    💰 Marcar recibo pagado
                  </button>
                ` : ''}
              ` : `
                <div style="background:rgba(240,82,82,.08);border:1px solid rgba(240,82,82,.2);border-radius:8px;padding:10px 16px;color:var(--red);font-size:13px">
                  🚫 ${permisos.razon || 'Sin permisos para acciones automáticas'}
                </div>
              `}
            </div>
          </div>
        ` : ''}

        <!-- NOTAS INTERNAS -->
        <div>
          <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">📝 Notas internas</div>
          <textarea id="nota-email-${email._id}" placeholder="Añade notas internas..."
            style="width:100%;background:var(--bg3);border:1.5px solid var(--border2);border-radius:8px;padding:10px 12px;color:var(--text);font-size:13px;resize:vertical;min-height:70px;font-family:inherit;box-sizing:border-box"
          >${email.notas || ''}</textarea>
          <button onclick="guardarNota('${email._id}')"
            style="margin-top:8px;background:var(--bg3);border:1.5px solid var(--border2);border-radius:8px;padding:8px 16px;color:var(--text2);font-size:13px;cursor:pointer;font-weight:600">
            💾 Guardar nota
          </button>
        </div>

      </div>
    </div>
  `;
}

// ── Init ──────────────────────────────────────────────────────────
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

window.initEmails      = initEmails;
window.cargarEmails    = cargarEmails;
window.forzarPoll      = forzarPoll;
window.abrirEmail      = abrirEmail;
window.cerrarDetalle   = cerrarDetalle;
window.archivarEmail   = archivarEmail;
window.eliminarEmail   = eliminarEmail;
window.responderEmail  = responderEmail;
window.reenviarEmail   = reenviarEmail;
window.marcarImportante = marcarImportante;
window.ejecutarAccion  = ejecutarAccion;
window.guardarNota     = guardarNota;
