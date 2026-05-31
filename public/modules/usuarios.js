// modules/usuarios.js — Gestión de usuarios y roles (solo admin)
(function(CP) {
  'use strict';

  const ROLE_COLORS = {
    admin:  '#f05252',
    office: '#4d9cf8',
    tech:   '#22c487',
    client: '#a78bfa',
  };
  const ROLE_LABELS = {
    admin:  '👔 Administrador',
    office: '🖥️ Oficina',
    tech:   '🔧 Técnico',
    client: '👥 Cliente',
  };
  const ROLE_DESC = {
    admin:  'Acceso total al dashboard y configuración',
    office: 'Dashboard completo, partes y presencia. Sin configuración',
    tech:   'Solo formulario de partes desde móvil',
    client: 'Solo consulta sus facturas pendientes (próximamente)',
  };

  function api(url, opts={}) {
    const tok = localStorage.getItem('cp_token');
    return fetch(url, {
      ...opts,
      headers: {'Authorization':`Bearer ${tok}`,'Content-Type':'application/json',...(opts.headers||{})}
    }).then(r => r.json());
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
                ${k==='admin'?'✅ Todo el dashboard<br>✅ Gestión de usuarios<br>✅ Ver metadatos GPS y control<br>✅ Configuración del sistema':
                  k==='office'?'✅ Facturación y cobros<br>✅ Presupuestos y familias<br>✅ Presencia y partes<br>❌ Configuración y usuarios':
                  k==='tech'?'✅ Formulario de partes (/parte)<br>❌ Acceso al dashboard':
                  '✅ Sus facturas pendientes<br>✅ Sus documentos<br>❌ Datos de otros clientes'}
              </div>
            </div>`).join('')}
        </div>
        <div class="alert ain" style="margin-top:14px">
          <div>ℹ️</div>
          <div><strong>Portal de clientes</strong> — próximamente Cinc Gestió, Fabian y otras familias podrán entrar con su propio acceso y ver solo sus facturas pendientes.</div>
        </div>
      </div>`;

    loadUsers();
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
          <select id="u-role" style="width:100%;background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:var(--rs);padding:9px 12px;font-size:13px">
            ${Object.entries(ROLE_LABELS).map(([k,v])=>`<option value="${k}" ${user.role===k?'selected':''}>${v}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="g2" style="margin-bottom:12px">
        <div>
          <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:5px">PIN de acceso * (4 dígitos)</div>
          <input type="text" id="u-pin" value="${user.pin&&user.pin!=='••••'?user.pin:''}" placeholder="Ej: 6789" maxlength="6" inputmode="numeric" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--rs);padding:9px 12px;color:var(--text);font-size:13px;font-family:monospace;letter-spacing:4px">
        </div>
        <div>
          <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:5px">Color</div>
          <div style="display:flex;gap:8px;align-items:center;padding-top:6px">
            ${['#4d9cf8','#22c487','#f59e0b','#a78bfa','#f05252','#e879a1','#6b7280'].map(c=>`
              <div onclick="selectColor('${c}')" id="color-${c.slice(1)}"
                style="width:24px;height:24px;border-radius:50%;background:${c};cursor:pointer;border:2px solid ${user.color===c?'#fff':'transparent'};transition:border-color .15s"></div>`).join('')}
            <input type="color" id="u-color" value="${user.color||'#4d9cf8'}" style="width:28px;height:28px;border:none;border-radius:50%;cursor:pointer;background:none;padding:0" onchange="document.querySelectorAll('[id^=color-]').forEach(e=>e.style.borderColor='transparent')">
          </div>
        </div>
      </div>
      <div style="margin-bottom:12px">
        <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:5px">Notas internas</div>
        <input type="text" id="u-notes" value="${user.notes||''}" placeholder="Ej: Conductor principal, trabaja lunes-viernes" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--rs);padding:9px 12px;color:var(--text);font-size:13px">
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
      const showInactive = document.getElementById('u-show-inactive')?.checked;
      const filtered = showInactive ? list : list.filter(u => u.active !== false);

      // Métricas
      const metrics = document.getElementById('u-metrics');
      if (metrics) {
        const byRole = {};
        filtered.forEach(u => { byRole[u.role] = (byRole[u.role]||0)+1; });
        metrics.innerHTML = `
          <div class="mc"><div class="ml">Total usuarios</div><div class="mv b">${filtered.length}</div></div>
          ${Object.entries(ROLE_LABELS).map(([k,v])=>byRole[k]?`<div class="mc"><div class="ml">${v}</div><div class="mv" style="color:${ROLE_COLORS[k]}">${byRole[k]}</div></div>`:'').join('')}`;
      }

      if (!filtered.length) { el.innerHTML='<div class="empty"><div class="ei">👥</div><div class="et">No hay usuarios</div></div>'; return; }

      el.innerHTML = `<div style="display:grid;gap:10px">
        ${filtered.map(u => `
          <div style="background:var(--bg3);border:1px solid ${u.active===false?'rgba(255,255,255,.05)':'var(--border)'};border-radius:var(--rs);padding:14px 16px;display:flex;align-items:center;gap:12px;opacity:${u.active===false?'0.5':'1'}">
            <div style="width:40px;height:40px;border-radius:50%;background:${u.color||'#4d9cf8'}22;border:2px solid ${u.color||'#4d9cf8'};display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">
              ${u.role==='admin'?'👔':u.role==='office'?'🖥️':u.role==='tech'?'🔧':'👥'}
            </div>
            <div style="flex:1;min-width:0">
              <div style="font-weight:600;font-size:13px">${u.name} ${u.active===false?'<span style="font-size:10px;color:var(--text3)">(inactivo)</span>':''}</div>
              <div style="font-size:11px;color:${ROLE_COLORS[u.role]}">${ROLE_LABELS[u.role]||u.role}</div>
              ${u.notes?`<div style="font-size:11px;color:var(--text3);margin-top:2px">${u.notes}</div>`:''}
              ${u.lastLogin?`<div style="font-size:10px;color:var(--text3)">Último acceso: ${new Date(u.lastLogin).toLocaleDateString('es-ES')}</div>`:''}
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0">
              <button class="btn bgh" style="padding:5px 10px;font-size:11px" onclick="CP.Usuarios.editUser('${u._id}')">✏️ Editar</button>
              ${u.active!==false?`<button class="btn bgh" style="padding:5px 10px;font-size:11px;color:var(--red);border-color:var(--red)" onclick="CP.Usuarios.deactivateUser('${u._id}','${u.name}')">⏸️</button>`:''}
            </div>
          </div>`).join('')}
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
      if (document.getElementById('u-name')) document.getElementById('u-name').value = u.name||'';
      if (document.getElementById('u-role')) document.getElementById('u-role').value = u.role||'tech';
      if (document.getElementById('u-pin'))  document.getElementById('u-pin').value  = u.pin||'';
      if (document.getElementById('u-color'))document.getElementById('u-color').value= u.color||'#4d9cf8';
      if (document.getElementById('u-notes'))document.getElementById('u-notes').value= u.notes||'';
      if (document.getElementById('u-dni'))  document.getElementById('u-dni').value  = u.docs?.dni||'';
      if (document.getElementById('u-carnet'))document.getElementById('u-carnet').value=u.docs?.carnet||'';
      if (document.getElementById('u-emergency'))document.getElementById('u-emergency').value=u.docs?.emergency||'';
    } catch(err) { alert('Error: '+err.message); }
  }

  async function updateUser(id) {
    const data = getFormData();
    const msg  = document.getElementById('u-form-msg');
    try {
      const result = await api(`/api/users/${id}`, { method:'PUT', body:JSON.stringify(data) });
      if (result.error) throw new Error(result.error);
      if (msg) { msg.textContent='✅ Usuario actualizado'; msg.style.display='block'; msg.style.color='var(--green)'; }
      setTimeout(() => { loadUsers(); showTab('lista', document.querySelector('#usuarios-container .btab')); }, 1000);
    } catch(err) {
      if (msg) { msg.textContent='❌ '+err.message; msg.style.display='block'; msg.style.color='var(--red)'; }
    }
  }

  async function deactivateUser(id, name) {
    if (!confirm(`¿Desactivar a ${name}? Perderá acceso inmediatamente.`)) return;
    try {
      await api(`/api/users/${id}`, { method:'DELETE' });
      loadUsers();
    } catch(err) { alert('Error: '+err.message); }
  }

  function getFormData() {
    return {
      name:  document.getElementById('u-name')?.value?.trim(),
      role:  document.getElementById('u-role')?.value,
      pin:   document.getElementById('u-pin')?.value?.trim(),
      color: document.getElementById('u-color')?.value,
      notes: document.getElementById('u-notes')?.value?.trim(),
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
      resetForm();
      setTimeout(() => showTab('lista', null), 1500);
    } catch(err) {
      if (msg) { msg.textContent='❌ '+err.message; msg.style.display='block'; msg.style.color='var(--red)'; }
    }
  }

  function resetForm() {
    ['u-name','u-pin','u-notes','u-dni','u-carnet','u-emergency'].forEach(id => {
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
  }

  CP.Usuarios = { render, showTab, loadUsers, editUser, deactivateUser, submitUser, resetForm };

})(window.CP = window.CP || {});
