// modules/usuarios.js — Gestión de usuarios y roles (solo admin)
(function(CP) {
  'use strict';

  const ROLE_COLORS = {
    owner:     '#f05252',
    oficina:   '#4d9cf8',
    encargado: '#f59e0b',
    tecnico:   '#22c487',
  };
  const ROLE_LABELS = {
    owner:     '👑 Dueño',
    oficina:   '🖥️ Oficina',
    encargado: '🦺 Encargado',
    tecnico:   '🔧 Técnico',
  };
  const ROLE_ICON = { owner:'👑', oficina:'🖥️', encargado:'🦺', tecnico:'🔧' };
  const ROLE_DESC = {
    owner:     'Todo el sistema + gestionar usuarios y ver el registro',
    oficina:   'Presupuestos, facturas, catálogo, clientes y campo. Sin gestionar usuarios',
    encargado: 'Presupuestos, catálogo y campo. Sin facturas ni usuarios',
    tecnico:   'Solo campo: partes, fichaje, mediciones y llaves. Nada de dinero',
  };
  const ROLES_PASSWORD = ['owner','oficina','encargado']; // entran con contraseña
  const ROLES_FIELD    = ['tecnico','encargado'];         // van a obra → PIN + coste/hora
  // Mapea roles antiguos (admin/office/tech) a los 4 nuevos, para mostrar bien.
  function normRole(r){ return ({admin:'owner',office:'oficina',tech:'tecnico',worker:'tecnico',client:'tecnico',owner:'owner',oficina:'oficina',encargado:'encargado',tecnico:'tecnico'})[r] || 'tecnico'; }

  function api(url, opts={}) {
    const tok = localStorage.getItem('cp_token');
    return fetch(url, {
      ...opts,
      headers: {'Authorization':`Bearer ${tok}`,'Content-Type':'application/json',...(opts.headers||{})}
    }).then(async r => {
      let data = null;
      try { data = await r.json(); } catch(e) {}
      if (!r.ok) {
        const e = new Error(
          (r.status===401 || r.status===403)
            ? 'Sesión caducada — pulsa «Salir» y vuelve a entrar'
            : ((data && data.error) ? data.error : `Error ${r.status}`)
        );
        e.status = r.status;
        throw e;
      }
      return data;
    });
  }

  function render(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;

    el.innerHTML = `
      <div style="display:flex;gap:0;border-bottom:1px solid var(--border);margin-bottom:20px;overflow-x:auto">
        <button class="btab active" onclick="CP.Usuarios.showTab('lista',this)">👥 Trabajadores</button>
        <button class="btab" onclick="CP.Usuarios.showTab('nuevo',this)">➕ Nuevo usuario</button>
        <button class="btab" onclick="CP.Usuarios.showTab('roles',this)">🔑 Roles y accesos</button>
      </div>

      <div id="ut-lista" class="p-tab active">
        <div id="u-metrics" class="metrics-row" style="margin-bottom:16px"></div>
        <div class="card">
          <div class="card-title">
            Usuarios del sistema
            <div style="display:flex;gap:8px">
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:400;color:var(--text2);cursor:pointer">
                <input type="checkbox" id="u-show-inactive" onchange="CP.Usuarios.loadUsers()" style="cursor:pointer">
                Mostrar inactivos
              </label>
            </div>
          </div>
          <div id="u-lista">Cargando...</div>
        </div>
      </div>

      <div id="ut-nuevo" class="p-tab" style="display:none">
        <div class="card" style="max-width:560px">
          <div class="card-title">Nuevo usuario</div>
          ${renderForm()}
          <div id="u-form-msg" style="margin-top:10px;font-size:12px;display:none"></div>
          <div style="display:flex;gap:8px;margin-top:16px">
            <button class="btn bp" onclick="CP.Usuarios.submitUser()">💾 Crear usuario</button>
            <button class="btn bgh" onclick="CP.Usuarios.resetForm()">Limpiar</button>
          </div>
        </div>
      </div>

      <div id="ut-roles" class="p-tab" style="display:none">
        <div class="g2">
          ${Object.entries(ROLE_LABELS).map(([k,v])=>`
            <div class="card">
              <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
                <div style="width:10px;height:10px;border-radius:50%;background:${ROLE_COLORS[k]}"></div>
                <div style="font-weight:600;font-size:14px">${v}</div>
              </div>
              <div style="font-size:12px;color:var(--text2);margin-bottom:10px">${ROLE_DESC[k]}</div>
              <div style="font-size:11px;color:var(--text3)">
                ${k==='owner'?'✅ Presupuestos, facturas, catálogo<br>✅ Campo (partes, fichaje, mediciones)<br>✅ Gestionar usuarios<br>✅ Registro de actividad y ajustes':
                  k==='oficina'?'✅ Presupuestos, facturas, catálogo<br>✅ Clientes<br>✅ Campo<br>❌ Gestionar usuarios / ajustes':
                  k==='encargado'?'✅ Presupuestos y catálogo<br>✅ Campo<br>❌ Facturas<br>❌ Gestionar usuarios':
                  '✅ Partes, fichaje, presencia<br>✅ Mediciones y llaves<br>❌ Presupuestos / facturas / dinero'}
              </div>
              <div style="font-size:10px;color:var(--text3);margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
                ${ROLES_PASSWORD.includes(k)?'🔑 Entra con email + contraseña':'📱 Entra con PIN o enlace mágico'}
              </div>
            </div>`).join('')}
        </div>
        <div class="alert ain" style="margin-top:14px">
          <div>ℹ️</div>
          <div>Cada persona entra con su propia cuenta y <strong>todo lo que crea queda firmado con su nombre</strong>. El Dueño da de alta al resto y le pone su rol.</div>
        </div>
      </div>`;

    loadUsers();
    onRoleChange();
  }

  function renderForm(user={}) {
  return `
    <div class="g2" style="margin-bottom:12px">
      <div>
        <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:5px">Nombre completo *</div>
        <input type="text" id="u-name" value="${user.name||''}" placeholder="Ej: Juan García" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--rs);padding:9px 12px;color:var(--text);font-size:13px">
      </div>
      <div>
        <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:5px">Rol *</div>
        <select id="u-role" onchange="CP.Usuarios.onRoleChange()" style="width:100%;background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:var(--rs);padding:9px 12px;font-size:13px">
          ${Object.entries(ROLE_LABELS).map(([k,v])=>`<option value="${k}" ${normRole(user.role)===k?'selected':''}>${v}</option>`).join('')}
        </select>
        <div id="u-role-desc" style="font-size:10px;color:var(--text3);margin-top:4px"></div>
      </div>
    </div>
    <div id="u-pass-block" class="g2" style="margin-bottom:12px">
      <div>
        <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:5px">🔑 Contraseña ${user._id?'(dejar vacío = no cambiar)':'*'}</div>
        <input type="password" id="u-pass" value="" placeholder="Mínimo 6 caracteres" autocomplete="new-password" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--rs);padding:9px 12px;color:var(--text);font-size:13px">
        <div style="font-size:10px;color:var(--text3);margin-top:3px">Con esto entra al dashboard (junto con su email)</div>
      </div>
      <div></div>
    </div>
    <div id="u-field-block" class="g2" style="margin-bottom:12px">
      <div>
        <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:5px">PIN de acceso (4 dígitos)</div>
        <input type="text" id="u-pin" value="${user.pin&&user.pin!=='••••'?user.pin:''}" placeholder="Ej: 6789" maxlength="6" inputmode="numeric" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--rs);padding:9px 12px;color:var(--text);font-size:13px;font-family:monospace;letter-spacing:4px">
        <div style="font-size:10px;color:var(--text3);margin-top:3px">Para entrar en la app de campo (o enlace mágico)</div>
      </div>
      <div>
        <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:5px">Coste/hora real (€)</div>
        <input type="number" id="u-coste-hora" value="${user.costeHora||''}" placeholder="Ej: 13.28" min="0" step="0.01" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--rs);padding:9px 12px;color:var(--text);font-size:13px">
        <div style="font-size:10px;color:var(--text3);margin-top:3px">Sueldo + SS prorrateado por hora</div>
      </div>
    </div>
    <div class="g2" style="margin-bottom:12px">
      <div>
        <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:5px">📱 Teléfono</div>
        <input type="tel" id="u-telefono" value="${user.telefono||''}" placeholder="+34 6XX XXX XXX" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--rs);padding:9px 12px;color:var(--text);font-size:13px">
        <div style="font-size:10px;color:var(--text3);margin-top:3px">Para enviarle el enlace de acceso por WhatsApp</div>
      </div>
      <div>
        <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:5px">✉️ Email</div>
        <input type="text" id="u-email" value="${user.email||''}" placeholder="trabajador@email.com" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--rs);padding:9px 12px;color:var(--text);font-size:13px">
      </div>
    </div>
    <div class="g2" style="margin-bottom:12px">
      <div>
        <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:5px">Color</div>
        <div style="display:flex;gap:8px;align-items:center;padding-top:6px">
          ${['#4d9cf8','#22c487','#f59e0b','#a78bfa','#f05252','#e879a1','#6b7280'].map(c=>`
            <div onclick="selectColor('${c}')" id="color-${c.slice(1)}"
              style="width:24px;height:24px;border-radius:50%;background:${c};cursor:pointer;border:2px solid ${user.color===c?'#fff':'transparent'};transition:border-color .15s"></div>`).join('')}
          <input type="color" id="u-color" value="${user.color||'#4d9cf8'}" style="width:28px;height:28px;border:none;border-radius:50%;cursor:pointer;background:none;padding:0" onchange="document.querySelectorAll('[id^=color-]').forEach(e=>e.style.borderColor='transparent')">
        </div>
      </div>
      <div>
        <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:5px">Notas internas</div>
        <input type="text" id="u-notes" value="${user.notes||''}" placeholder="Ej: Conductor principal, lunes-viernes" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--rs);padding:9px 12px;color:var(--text);font-size:13px">
      </div>
    </div>
    <div style="background:var(--bg3);border-radius:var(--rs);padding:14px;margin-bottom:0">
      <div style="font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">📁 Documentación (solo admin puede ver)</div>
      <div class="g2" style="margin-bottom:8px">
        <div>
          <div style="font-size:10px;color:var(--text3);margin-bottom:4px">DNI / NIE</div>
          <input type="text" id="u-dni" value="${user.docs?.dni||''}" placeholder="12345678A" style="width:100%;background:var(--bg2);border:1px solid var(--border2);border-radius:var(--rs);padding:8px 10px;color:var(--text);font-size:13px">
        </div>
        <div>
          <div style="font-size:10px;color:var(--text3);margin-bottom:4px">Carnet de conducir</div>
          <input type="text" id="u-carnet" value="${user.docs?.carnet||''}" placeholder="Categoría y número" style="width:100%;background:var(--bg2);border:1px solid var(--border2);border-radius:var(--rs);padding:8px 10px;color:var(--text);font-size:13px">
        </div>
      </div>
      <div>
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px">Contacto de emergencia</div>
        <input type="text" id="u-emergency" value="${user.docs?.emergency||''}" placeholder="Nombre y teléfono" style="width:100%;background:var(--bg2);border:1px solid var(--border2);border-radius:var(--rs);padding:8px 10px;color:var(--text);font-size:13px">
      </div>
    </div>`;
}

  window.selectColor = function(color) {
    document.getElementById('u-color').value = color;
    document.querySelectorAll('[id^="color-"]').forEach(e => e.style.borderColor = 'transparent');
    const el = document.getElementById('color-' + color.slice(1));
    if (el) el.style.borderColor = '#fff';
  };

  // Muestra/oculta contraseña (oficina) vs PIN+coste (campo) según el rol.
  function onRoleChange() {
    const role = document.getElementById('u-role')?.value || 'tecnico';
    const pass = document.getElementById('u-pass-block');
    const field = document.getElementById('u-field-block');
    const desc = document.getElementById('u-role-desc');
    if (pass)  pass.style.display  = ROLES_PASSWORD.includes(role) ? '' : 'none';
    if (field) field.style.display = ROLES_FIELD.includes(role)    ? '' : 'none';
    if (desc)  desc.textContent    = ROLE_DESC[role] || '';
  }

  function showTab(id, btn) {
    document.querySelectorAll('#usuarios-container .p-tab').forEach(p => { p.style.display='none'; p.classList.remove('active'); });
    document.querySelectorAll('#usuarios-container .btab').forEach(b => b.classList.remove('active'));
    const tab = document.getElementById('ut-' + id);
    if (tab) { tab.style.display='block'; tab.classList.add('active'); }
    if (btn) btn.classList.add('active');
    if (id === 'lista') loadUsers();
  }

  async function loadUsers() {
    const el = document.getElementById('u-lista');
    if (!el) return;
    try {
      const list = await api('/api/users');
      if (!Array.isArray(list)) throw new Error('Respuesta inesperada del servidor al cargar usuarios');
      const showInactive = document.getElementById('u-show-inactive')?.checked;
      const filtered = showInactive ? list : list.filter(u => u.active !== false);

      // Métricas
      const metrics = document.getElementById('u-metrics');
      if (metrics) {
        const byRole = {};
        filtered.forEach(u => { const r=normRole(u.role); byRole[r] = (byRole[r]||0)+1; });
        metrics.innerHTML = `
          <div class="mc"><div class="ml">Total usuarios</div><div class="mv b">${filtered.length}</div></div>
          ${Object.entries(ROLE_LABELS).map(([k,v])=>byRole[k]?`<div class="mc"><div class="ml">${v}</div><div class="mv" style="color:${ROLE_COLORS[k]}">${byRole[k]}</div></div>`:'').join('')}`;
      }

      if (!filtered.length) { el.innerHTML='<div class="empty"><div class="ei">👥</div><div class="et">No hay usuarios</div></div>'; return; }

      el.innerHTML = `<div style="display:grid;gap:10px">
        ${filtered.map(u => { const r=normRole(u.role); return `
          <div style="background:var(--bg3);border:1px solid ${u.active===false?'rgba(255,255,255,.05)':'var(--border)'};border-radius:var(--rs);padding:14px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;opacity:${u.active===false?'0.5':'1'}">
            <div style="width:40px;height:40px;border-radius:50%;background:${u.color||'#4d9cf8'}22;border:2px solid ${u.color||'#4d9cf8'};display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">
              ${ROLE_ICON[r]||'👤'}
            </div>
            <div style="flex:1 1 150px;min-width:0">
              <div style="font-weight:600;font-size:13px">${u.name} ${u.active===false?'<span style="font-size:10px;color:var(--text3)">(inactivo)</span>':''}</div>
              <div style="font-size:11px;color:${ROLE_COLORS[r]}">${ROLE_LABELS[r]||r} ${ROLES_PASSWORD.includes(r)?(u.hasPassword?'· <span style="color:var(--green)">🔑 con contraseña</span>':'· <span style="color:var(--amber)">⚠️ sin contraseña</span>'):''}</div>
              ${u.notes?`<div style="font-size:11px;color:var(--text3);margin-top:2px">${u.notes}</div>`:''}
              ${u.lastLogin?`<div style="font-size:10px;color:var(--text3)">Último acceso: ${new Date(u.lastLogin).toLocaleDateString('es-ES')}</div>`:''}
              ${ROLES_FIELD.includes(r)?(u.gpsConsentAt?`<div style="font-size:10px;color:var(--green)">📍 Consentimiento GPS firmado el ${new Date(u.gpsConsentAt).toLocaleDateString('es-ES')}</div>`:`<div style="font-size:10px;color:var(--amber)">📍 GPS sin firmar</div>`):''}
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-left:auto;flex-shrink:0">
              ${ROLES_FIELD.includes(r)?`<button class="btn bgh" style="padding:5px 10px;font-size:11px" onclick="enlaceMagico('${u._id}','${String(u.name).replace(/'/g,"\\'")}')">🔗 Acceso</button>`:''}
              <button class="btn bgh" style="padding:5px 10px;font-size:11px" onclick="CP.Usuarios.editUser('${u._id}')">✏️ Editar</button>
              ${u.active!==false
                ? `<button class="btn bgh" style="padding:5px 10px;font-size:11px;color:var(--red);border-color:var(--red)" onclick="CP.Usuarios.deactivateUser('${u._id}','${u.name}')" title="Desactivar">⏸️</button>`
                : `<button class="btn bgh" style="padding:5px 10px;font-size:11px;color:var(--green);border-color:var(--green)" onclick="CP.Usuarios.reactivateUser('${u._id}','${u.name}')" title="Reactivar">▶️</button>`}
            </div>
          </div>`; }).join('')}
      </div>`;
    } catch (err) {
      el.innerHTML = `<div style="color:var(--red);font-size:12px">Error: ${err.message}</div>`;
    }
  }

  async function editUser(id) {
    try {
      const u = await api(`/api/users/${id}`);
      // Cambiar a pestaña nuevo con datos pre-rellenos
      const tab = document.getElementById('ut-nuevo');
      if (tab) {
        tab.style.display = 'block';
        tab.classList.add('active');
        document.querySelectorAll('#usuarios-container .p-tab').forEach(p => { if(p!==tab){p.style.display='none';p.classList.remove('active');} });
        document.querySelectorAll('#usuarios-container .btab').forEach(b => b.classList.remove('active'));
        document.querySelector('#usuarios-container .btab:nth-child(2)')?.classList.add('active');
      }
      // Rellenar formulario
      const card = tab?.querySelector('.card');
      if (card) {
        card.querySelector('.card-title').textContent = `Editar usuario — ${u.name}`;
        // Cambiar botón guardar
        const btn = card.querySelector('.btn.bp');
        if (btn) {
          btn.textContent = '💾 Guardar cambios';
          btn.onclick = () => updateUser(id);
        }
      }
      const set=(id,v)=>{const e=document.getElementById(id);if(e)e.value=v;};
      set('u-name', u.name||'');
      set('u-role', normRole(u.role));
      set('u-pass', '');
      set('u-pin',  u.pin&&u.pin!=='••••'?u.pin:'');
      set('u-coste-hora', u.costeHora||'');
      set('u-telefono', u.telefono||'');
      set('u-email', u.email||'');
      set('u-color', u.color||'#4d9cf8');
      set('u-notes', u.notes||'');
      set('u-dni', u.docs?.dni||'');
      set('u-carnet', u.docs?.carnet||'');
      set('u-emergency', u.docs?.emergency||'');
      onRoleChange();
    } catch(err) { alert('Error: '+err.message); }
  }

  async function updateUser(id) {
    const data = getFormData();
    const msg  = document.getElementById('u-form-msg');
    try {
      const result = await api(`/api/users/${id}`, { method:'PUT', body:JSON.stringify(data) });
      if (result.error) throw new Error(result.error);
      if (msg) { msg.textContent='✅ Usuario actualizado'; msg.style.display='block'; msg.style.color='var(--green)'; }
      await refreshWorkers();
      setTimeout(() => { loadUsers(); showTab('lista', document.querySelector('#usuarios-container .btab')); }, 1000);
    } catch(err) {
      if (msg) { msg.textContent='❌ '+err.message; msg.style.display='block'; msg.style.color='var(--red)'; }
    }
  }

  async function deactivateUser(id, name) {
    if (!confirm(`¿Desactivar a ${name}? Perderá acceso inmediatamente, pero NO se borra: podrás reactivarlo cuando quieras marcando "Mostrar inactivos".`)) return;
    try {
      await api(`/api/users/${id}`, { method:'DELETE' });
      await refreshWorkers();
      loadUsers();
    } catch(err) { alert('Error: '+err.message); }
  }

  async function reactivateUser(id, name) {
    if (!confirm(`¿Reactivar a ${name}? Volverá a aparecer en Partes y Presencia.`)) return;
    try {
      const result = await api(`/api/users/${id}`, { method:'PUT', body:JSON.stringify({ active:true }) });
      if (result && result.error) throw new Error(result.error);
      await refreshWorkers();
      loadUsers();
    } catch(err) { alert('Error: '+err.message); }
  }

  // Recarga la lista global de trabajadores para que Partes y Presencia
  // se actualicen al cambiar de pestaña, sin tener que recargar la página.
  async function refreshWorkers() {
    try { await window.CP_CONFIG?.loadWorkers?.(); } catch(e) {}
  }

  function getFormData() {
  return {
    name:      document.getElementById('u-name')?.value?.trim(),
    role:      document.getElementById('u-role')?.value,
    password:  document.getElementById('u-pass')?.value || '',
    pin:       document.getElementById('u-pin')?.value?.trim(),
    costeHora: parseFloat(document.getElementById('u-coste-hora')?.value || 0),
    telefono:  document.getElementById('u-telefono')?.value?.trim(),
    email:     document.getElementById('u-email')?.value?.trim(),
    color:     document.getElementById('u-color')?.value,
    notes:     document.getElementById('u-notes')?.value?.trim(),
    docs: {
      dni:       document.getElementById('u-dni')?.value?.trim(),
      carnet:    document.getElementById('u-carnet')?.value?.trim(),
      emergency: document.getElementById('u-emergency')?.value?.trim(),
    }
  };
}

  async function submitUser() {
    const data = getFormData();
    const msg  = document.getElementById('u-form-msg');
    try {
      const result = await api('/api/users', { method:'POST', body:JSON.stringify(data) });
      if (result.error) throw new Error(result.error);
      if (msg) { msg.textContent=`✅ Usuario ${data.name} creado correctamente`; msg.style.display='block'; msg.style.color='var(--green)'; }
      await refreshWorkers();
      resetForm();
      setTimeout(() => showTab('lista', null), 1500);
    } catch(err) {
      if (msg) { msg.textContent='❌ '+err.message; msg.style.display='block'; msg.style.color='var(--red)'; }
    }
  }

  function resetForm() {
    ['u-name','u-pass','u-pin','u-coste-hora','u-telefono','u-email','u-notes','u-dni','u-carnet','u-emergency'].forEach(id => {
      const e = document.getElementById(id); if(e) e.value='';
    });
    const msg = document.getElementById('u-form-msg');
    if (msg) msg.style.display='none';
    const card = document.querySelector('#ut-nuevo .card');
    if (card) {
      card.querySelector('.card-title').textContent = 'Nuevo usuario';
      const btn = card.querySelector('.btn.bp');
      if (btn) { btn.textContent='💾 Crear usuario'; btn.onclick = submitUser; }
    }
    onRoleChange();
  }

  // Enlace MÁGICO del trabajador: genera (idempotente) y ofrece copiar / enviar.
  window.enlaceMagico = async function(userId, userName) {
    let data;
    try { data = await api(`/api/users/${userId}/magic-link`, { method:'POST', body: JSON.stringify({}) }); }
    catch(e){ alert('No se pudo generar el enlace: ' + e.message); return; }
    const url = (data.url || '').replace(/"/g,'&quot;');
    const nombre = String(userName||'').split(' ')[0];
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px';
    ov.innerHTML = `<div style="background:var(--bg2);border:1px solid var(--border2);border-radius:16px;padding:22px;max-width:440px;width:100%">
      <div style="font-weight:700;font-size:16px;margin-bottom:4px">🔗 Acceso de ${nombre}</div>
      <div style="color:var(--text3);font-size:12px;margin-bottom:12px">Al abrir este enlace entra SIN PIN y puede fichar y mandar partes. La primera vez le mostramos una mini-guía. El mismo enlace sirve para los recordatorios.</div>
      <input readonly value="${url}" onclick="this.select()" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:10px;color:var(--text);font-size:12px;margin-bottom:12px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <button class="btn bgh" onclick="navigator.clipboard.writeText('${url}').then(()=>{this.textContent='✅ Copiado'})">📋 Copiar</button>
        <button class="btn bgh" onclick="enviarMagico('${userId}','whatsapp',this)">📲 WhatsApp</button>
        <button class="btn bgh" onclick="enviarMagico('${userId}','email',this)">✉️ Email</button>
        <button class="btn bgh" onclick="this.closest('div').parentNode.remove()">Cerrar</button>
      </div>
      <div id="magic-msg" style="font-size:12px;margin-top:10px"></div>
    </div>`;
    document.body.appendChild(ov);
  };
  window.enviarMagico = async function(userId, via, btn) {
    const msg = document.getElementById('magic-msg'); btn.disabled = true; const old = btn.textContent; btn.textContent = 'Enviando…';
    try { await api(`/api/users/${userId}/magic-link`, { method:'POST', body: JSON.stringify({ enviar: via }) });
      if (msg) { msg.textContent = via==='whatsapp' ? '✅ Enviado por WhatsApp' : '✅ Enviado por email'; msg.style.color = 'var(--green)'; } }
    catch(e){ if (msg) { msg.textContent = '❌ ' + e.message; msg.style.color = 'var(--red)'; } }
    finally { btn.disabled = false; btn.textContent = old; }
  };

  CP.Usuarios = { render, showTab, loadUsers, editUser, deactivateUser, reactivateUser, submitUser, resetForm, onRoleChange };

})(window.CP = window.CP || {});
