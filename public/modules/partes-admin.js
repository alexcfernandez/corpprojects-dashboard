// modules/partes-admin.js — Vista de partes para el administrador
// Solo accesible desde el dashboard con sesión de admin

(function(CP) {
  'use strict';

  const ESTADOS = {
    pendiente:  { label:'Pendiente revisión', color:'#f59e0b', emoji:'⏳' },
    verificado: { label:'Verificado',         color:'#22c487', emoji:'✅' },
    facturado:  { label:'Facturado',          color:'#4d9cf8', emoji:'💰' },
    incidencia: { label:'Con incidencia',     color:'#f05252', emoji:'⚠️' },
  };

  const WORKERS = [
    {id:'jose',    name:'Jose Beliard'},
    {id:'diego',   name:'Diego Campillo'},
    {id:'abdellah',name:'Abdellah Souiri'},
    {id:'mamadou', name:'Mamadou Barry'},
    {id:'paula',   name:'Paula Morales'},
  ];

  let currentPage = 0;
  const PAGE = 20;
  let filters = { workerId:'', clientName:'', status:'', from:'', to:'' };

  function eur(v){ return new Intl.NumberFormat('es-ES',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(v||0); }
  function dt(d){ return d ? new Date(d).toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'}) : '—'; }
  function dtFull(d){ return d ? new Date(d).toLocaleString('es-ES') : '—'; }

  async function api(url, opts={}) {
    const tok = localStorage.getItem('cp_token');
    const r = await fetch(url, { ...opts, headers:{'Authorization':`Bearer ${tok}`,'Content-Type':'application/json',...(opts.headers||{})} });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  // ── RENDER PRINCIPAL ────────────────────────────────────────────
  function render(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;

    el.innerHTML = `
      <div style="display:flex;gap:0;border-bottom:1px solid var(--border);margin-bottom:20px;overflow-x:auto">
        <button class="btab active" onclick="CP.PartesAdmin.showTab('lista',this)">📋 Todos los partes</button>
        <button class="btab" onclick="CP.PartesAdmin.showTab('facturacion',this)">💰 Por facturar</button>
        <button class="btab" onclick="CP.PartesAdmin.showTab('nuevo',this)">➕ Nuevo parte (admin)</button>
        <button class="btab" onclick="CP.PartesAdmin.showTab('accesos',this)">🔑 Acceso trabajadores</button>
      </div>

      <div id="pa-tab-lista" class="p-tab active">
        <!-- Filtros -->
        <div class="card" style="padding:14px 20px;margin-bottom:14px">
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
            <div>
              <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Trabajador</div>
              <select id="pa-f-worker" onchange="CP.PartesAdmin.applyFilters()" style="background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:var(--rs);padding:6px 10px;font-size:12px">
                <option value="">Todos</option>
                ${WORKERS.map(w=>`<option value="${w.id}">${w.name}</option>`).join('')}
              </select>
            </div>
            <div>
              <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Estado</div>
              <select id="pa-f-status" onchange="CP.PartesAdmin.applyFilters()" style="background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:var(--rs);padding:6px 10px;font-size:12px">
                <option value="">Todos</option>
                ${Object.entries(ESTADOS).map(([k,v])=>`<option value="${k}">${v.emoji} ${v.label}</option>`).join('')}
              </select>
            </div>
            <div>
              <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Cliente</div>
              <input type="text" id="pa-f-client" placeholder="Buscar cliente..." class="srch" style="width:180px" oninput="CP.PartesAdmin.applyFilters()">
            </div>
            <div>
              <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Desde</div>
              <input type="date" id="pa-f-from" class="srch" style="width:140px" onchange="CP.PartesAdmin.applyFilters()">
            </div>
            <div>
              <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Hasta</div>
              <input type="date" id="pa-f-to" class="srch" style="width:140px" onchange="CP.PartesAdmin.applyFilters()">
            </div>
            <button class="btn bgh" onclick="CP.PartesAdmin.clearFilters()">Limpiar</button>
          </div>
        </div>

        <div id="pa-metrics" class="metrics-row" style="margin-bottom:14px"></div>

        <div class="card">
          <div class="card-title">
            Partes de trabajo
            <span style="font-size:10px;color:var(--text3)" id="pa-count">—</span>
          </div>
          <div id="pa-lista">Cargando...</div>
          <div id="pa-pagination" style="margin-top:10px"></div>
        </div>
      </div>

      <div id="pa-tab-facturacion" class="p-tab" style="display:none">
        <div class="alert ain" style="margin-bottom:14px">
          <div>💰</div>
          <div><strong>Resumen para facturación</strong> — partes verificados y pendientes agrupados por cliente.</div>
        </div>
        <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:flex-end">
          <div>
            <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Desde</div>
            <input type="date" id="pa-fac-from" class="srch" style="width:145px">
          </div>
          <div>
            <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Hasta</div>
            <input type="date" id="pa-fac-to" class="srch" style="width:145px">
          </div>
          <button class="btn bp" onclick="CP.PartesAdmin.loadFacturacion()">Ver resumen</button>
        </div>
        <div id="pa-facturacion">Selecciona un período para ver el resumen.</div>
      </div>

      <div id="pa-tab-nuevo" class="p-tab" style="display:none">
        <div class="card" style="max-width:600px">
          <div class="card-title">Nuevo parte de trabajo (admin)</div>
          ${renderFormAdmin()}
          <div id="pa-form-msg" style="margin-top:10px;font-size:12px;display:none"></div>
          <div style="display:flex;gap:8px;margin-top:14px">
            <button class="btn bp" onclick="CP.PartesAdmin.submitParte()">💾 Guardar parte</button>
            <button class="btn bgh" onclick="CP.PartesAdmin.resetForm()">Limpiar</button>
          </div>
        </div>
      </div>

      <div id="pa-tab-accesos" class="p-tab" style="display:none">
        <div class="alert ain" style="margin-bottom:14px">
          <div>🔑</div>
          <div><strong>Acceso de trabajadores</strong> — cada trabajador entra con su PIN en <strong>dashboard.corpprojects.es/parte</strong>. Solo pueden crear partes, no editar ni ver los anteriores.</div>
        </div>
        <div class="card" style="max-width:500px">
          <div class="card-title">PINs de acceso</div>
          <table>
            <thead><tr><th>Trabajador</th><th style="text-align:center">PIN</th><th>Enlace directo</th></tr></thead>
            <tbody>
              ${WORKERS.map(w=>`<tr>
                <td><strong>${w.name}</strong></td>
                <td style="text-align:center"><span style="font-family:monospace;background:var(--bg3);padding:3px 10px;border-radius:6px;font-size:14px" id="pin-${w.id}">••••</span>
                  <button onclick="togglePin('${w.id}')" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:11px;margin-left:6px">👁</button>
                </td>
                <td><a href="/parte?w=${w.id}" target="_blank" style="color:var(--blue);font-size:11px">Abrir →</a></td>
              </tr>`).join('')}
            </tbody>
          </table>
          <div style="margin-top:14px;padding:10px;background:var(--amber-bg);border-radius:8px;border:1px solid rgba(245,158,11,.2);font-size:11px;color:rgba(245,158,11,.9)">
            ⚠️ Cambia los PINs en <code>src/partes.js</code> antes de darlo a los trabajadores. Los PINs por defecto son solo de ejemplo.
          </div>
        </div>
      </div>`;

    loadLista();
  }

  function renderFormAdmin() {
    const now = new Date().toISOString().slice(0,10);
    return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <div>
          <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Trabajador</div>
          <select id="pa-new-worker" style="width:100%;background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:var(--rs);padding:8px 10px;font-size:13px">
            ${WORKERS.map(w=>`<option value="${w.id}" data-name="${w.name}">${w.name}</option>`).join('')}
          </select>
        </div>
        <div>
          <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Fecha del trabajo</div>
          <input type="date" id="pa-new-date" value="${now}" style="width:100%;background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:var(--rs);padding:8px 10px;font-size:13px">
        </div>
      </div>
      <div style="margin-bottom:12px">
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Cliente / Obra</div>
        <input type="text" id="pa-new-client" list="pa-clients-list" placeholder="Buscar cliente..." style="width:100%;background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:var(--rs);padding:8px 10px;font-size:13px">
        <datalist id="pa-clients-list"></datalist>
      </div>
      <div style="margin-bottom:12px">
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Descripción del trabajo</div>
        <textarea id="pa-new-desc" rows="3" placeholder="Qué se hizo..." style="width:100%;background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:var(--rs);padding:8px 10px;font-size:13px;resize:vertical;font-family:'Inter',sans-serif"></textarea>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <div>
          <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Horas trabajadas</div>
          <input type="number" id="pa-new-horas" value="8" min="0.5" max="16" step="0.5" style="width:100%;background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:var(--rs);padding:8px 10px;font-size:13px">
        </div>
        <div>
          <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Estado</div>
          <select id="pa-new-status" style="width:100%;background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:var(--rs);padding:8px 10px;font-size:13px">
            ${Object.entries(ESTADOS).map(([k,v])=>`<option value="${k}">${v.emoji} ${v.label}</option>`).join('')}
          </select>
        </div>
      </div>
      <div style="margin-bottom:12px">
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Materiales usados</div>
        <div id="pa-mat-rows">
          <div class="pa-mat-row" style="display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:6px;margin-bottom:6px">
            <input type="text" placeholder="Material" style="background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:6px;padding:6px 8px;font-size:12px">
            <input type="number" placeholder="Cant." min="0" step="0.1" style="background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:6px;padding:6px 8px;font-size:12px">
            <input type="number" placeholder="€/ud" min="0" step="0.01" style="background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:6px;padding:6px 8px;font-size:12px">
            <button onclick="this.closest('.pa-mat-row').remove()" style="background:var(--red-bg);border:1px solid var(--red);border-radius:6px;padding:4px 8px;color:var(--red);cursor:pointer;font-size:11px">✕</button>
          </div>
        </div>
        <button class="btn bgh" style="font-size:11px;margin-top:4px" onclick="CP.PartesAdmin.addMatRow()">+ Material</button>
      </div>
      <div>
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Notas internas (solo admin)</div>
        <input type="text" id="pa-new-notas" placeholder="Notas para el expediente..." style="width:100%;background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:var(--rs);padding:8px 10px;font-size:13px">
      </div>`;
  }

  function showTab(id, btn) {
    document.querySelectorAll('#presencia-container .p-tab').forEach(p => { p.style.display='none'; p.classList.remove('active'); });
    document.querySelectorAll('#presencia-container .btab').forEach(b => b.classList.remove('active'));
    const tab = document.getElementById('pa-tab-' + id);
    if (tab) { tab.style.display='block'; tab.classList.add('active'); }
    if (btn) btn.classList.add('active');
    if (id === 'lista') loadLista();
    if (id === 'nuevo') loadClientsSuggestions();
  }

  async function loadClientsSuggestions() {
    const dl = document.getElementById('pa-clients-list');
    if (!dl) return;
    try {
      if (!window._cpClients) {
        const names = await api('/api/clients/list');
        window._cpClients = Array.isArray(names) ? names : [];
      }
      dl.innerHTML = window._cpClients.map(n => `<option value="${n}">`).join('');
    } catch(e) {
      console.warn('[PartesAdmin] No se pudieron cargar clientes:', e.message);
    }
  }

  function applyFilters() {
    filters.workerId   = document.getElementById('pa-f-worker')?.value  || '';
    filters.clientName = document.getElementById('pa-f-client')?.value  || '';
    filters.status     = document.getElementById('pa-f-status')?.value  || '';
    filters.from       = document.getElementById('pa-f-from')?.value    || '';
    filters.to         = document.getElementById('pa-f-to')?.value      || '';
    currentPage = 0;
    loadLista();
  }

  function clearFilters() {
    ['pa-f-worker','pa-f-status','pa-f-client','pa-f-from','pa-f-to'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    filters = { workerId:'', clientName:'', status:'', from:'', to:'' };
    currentPage = 0;
    loadLista();
  }

  async function loadLista() {
    const el = document.getElementById('pa-lista');
    if (!el) return;
    el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:10px">Cargando...</div>';

    try {
      const params = new URLSearchParams({
        ...filters, limit: PAGE, skip: currentPage * PAGE
      });
      const data = await api(`/api/partes?${params}`);

      document.getElementById('pa-count').textContent = `${data.total} partes`;

      // Métricas rápidas
      const metrics = document.getElementById('pa-metrics');
      if (metrics && data.partes) {
        const pend = data.partes.filter(p => p.status === 'pendiente').length;
        const ver  = data.partes.filter(p => p.status === 'verificado').length;
        const horas = data.partes.reduce((s, p) => s + (p.horas || 0), 0);
        metrics.innerHTML = `
          <div class="mc"><div class="ml">Total partes</div><div class="mv b">${data.total}</div></div>
          <div class="mc"><div class="ml">Pendientes revisión</div><div class="mv a">${pend}</div></div>
          <div class="mc"><div class="ml">Verificados</div><div class="mv g">${ver}</div></div>
          <div class="mc"><div class="ml">Horas registradas</div><div class="mv b">${horas.toFixed(1)} h</div></div>`;
      }

      if (!data.partes?.length) {
        el.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text3)"><div style="font-size:32px;margin-bottom:8px">📋</div><div>No hay partes con estos filtros</div></div>';
        return;
      }

      el.innerHTML = `<table>
        <thead><tr>
          <th>Fecha</th><th>Trabajador</th><th>Cliente / Obra</th>
          <th style="text-align:right">Horas</th><th>Estado</th>
          <th style="font-size:10px;color:var(--text3)">Enviado</th>
          <th></th>
        </tr></thead>
        <tbody>${data.partes.map(p => {
          const est = ESTADOS[p.status] || ESTADOS.pendiente;
          const enviado = p._meta?.submittedAt ? new Date(p._meta.submittedAt).toLocaleString('es-ES',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—';
          const dateMatch = p.date === (p._meta?.submittedAt?.slice?.(0,10) || p.date);
          return `<tr>
            <td>${dt(p.date)}${!dateMatch ? ' <span title="Fecha declarada difiere del envío real" style="color:var(--amber);font-size:10px">⚠️</span>' : ''}</td>
            <td>${p.workerName}</td>
            <td><strong>${p.clientName || '—'}</strong>${p.description ? `<br><span style="font-size:10px;color:var(--text3)">${p.description.slice(0,40)}${p.description.length>40?'...':''}</span>` : ''}</td>
            <td style="text-align:right">${p.horas} h</td>
            <td><span style="background:${est.color}22;color:${est.color};padding:2px 8px;border-radius:8px;font-size:10px;font-weight:600">${est.emoji} ${est.label}</span></td>
            <td style="font-size:10px;color:var(--text3)">${enviado}</td>
            <td><button class="btn bgh" style="padding:3px 10px;font-size:11px" onclick="CP.PartesAdmin.openParte('${p._id}')">Ver →</button></td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;

      // Paginación
      const pag = document.getElementById('pa-pagination');
      if (pag) {
        const totalPages = Math.ceil(data.total / PAGE);
        if (totalPages > 1) {
          pag.innerHTML = `<div style="display:flex;gap:6px;align-items:center">
            <button class="btn bgh" ${currentPage===0?'disabled':''} onclick="CP.PartesAdmin.goPage(${currentPage-1})">← Anterior</button>
            <span style="font-size:12px;color:var(--text2)">Página ${currentPage+1} de ${totalPages}</span>
            <button class="btn bgh" ${currentPage>=totalPages-1?'disabled':''} onclick="CP.PartesAdmin.goPage(${currentPage+1})">Siguiente →</button>
          </div>`;
        } else pag.innerHTML = '';
      }
    } catch (err) {
      el.innerHTML = `<div style="color:var(--red);font-size:12px;padding:10px">Error: ${err.message}</div>`;
    }
  }

  function goPage(n) { currentPage = n; loadLista(); }

  async function openParte(id) {
    try {
      const p = await api(`/api/partes/${id}`);
      const est = ESTADOS[p.status] || ESTADOS.pendiente;

      const existing = document.getElementById('pa-detail-modal');
      if (existing) existing.remove();

      const modal = document.createElement('div');
      modal.id = 'pa-detail-modal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto';
      
      const gps = p._meta?.gpsLat ? `${p._meta.gpsLat.toFixed(5)}, ${p._meta.gpsLng.toFixed(5)}` : 'No disponible';
      const mapsUrl = p._meta?.gpsLat ? `https://maps.google.com/?q=${p._meta.gpsLat},${p._meta.gpsLng}` : null;

      modal.innerHTML = `
        <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:16px;padding:24px;width:100%;max-width:580px;margin:auto">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
            <div>
              <div style="font-weight:600;font-size:15px">${p.workerName} — ${p.clientName || 'Sin cliente'}</div>
              <div style="font-size:11px;color:var(--text3)">${dt(p.date)}</div>
            </div>
            <button onclick="document.getElementById('pa-detail-modal').remove()" style="background:none;border:none;color:var(--text3);font-size:18px;cursor:pointer">✕</button>
          </div>

          <!-- DATOS DECLARADOS -->
          <div style="background:var(--bg3);border-radius:var(--rs);padding:14px;margin-bottom:12px">
            <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:8px;font-weight:600">Datos del parte</div>
            <table style="font-size:12px">
              <tr><td style="color:var(--text2);padding:3px 0;width:130px">Descripción</td><td>${p.description || '—'}</td></tr>
              <tr><td style="color:var(--text2);padding:3px 0">Horas</td><td>${p.horas} h</td></tr>
              <tr><td style="color:var(--text2);padding:3px 0">Notas trabajador</td><td>${p.notas || '—'}</td></tr>
            </table>
            ${p.materiales?.length ? `
              <div style="margin-top:8px;font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:4px">Materiales</div>
              <table style="font-size:12px;width:100%">
                <thead><tr><th>Material</th><th style="text-align:right">Cant.</th><th style="text-align:right">€/ud</th><th style="text-align:right">Total</th></tr></thead>
                <tbody>${p.materiales.map(m=>`<tr><td>${m.nombre||m.name||'—'}</td><td style="text-align:right">${m.cantidad||m.qty||0}</td><td style="text-align:right">${m.precio||m.price||0}€</td><td style="text-align:right">${((m.cantidad||m.qty||0)*(m.precio||m.price||0)).toFixed(2)}€</td></tr>`).join('')}</tbody>
              </table>` : ''}
          </div>

          <!-- METADATOS ADMIN -->
          <div style="background:rgba(77,156,248,.06);border:1px solid rgba(77,156,248,.2);border-radius:var(--rs);padding:14px;margin-bottom:12px">
            <div style="font-size:10px;color:var(--blue);text-transform:uppercase;margin-bottom:8px;font-weight:600">🔒 Datos de control (solo admin)</div>
            <table style="font-size:11px">
              <tr><td style="color:var(--text2);padding:2px 0;width:130px">Fecha/hora real envío</td><td style="color:var(--text)">${dtFull(p._meta?.submittedAt)}</td></tr>
              <tr><td style="color:var(--text2);padding:2px 0">Enviado por</td><td>${p._meta?.submittedBy === 'worker' ? '👷 Trabajador' : '👔 Admin'}</td></tr>
              <tr><td style="color:var(--text2);padding:2px 0">Ubicación GPS</td><td>${mapsUrl ? `<a href="${mapsUrl}" target="_blank" style="color:var(--blue)">${gps} →</a>` : gps}</td></tr>
              ${p._meta?.gpsAccuracy ? `<tr><td style="color:var(--text2);padding:2px 0">Precisión GPS</td><td>±${p._meta.gpsAccuracy.toFixed(0)}m</td></tr>` : ''}
            </table>
          </div>

          <!-- CONTROL ADMIN -->
          <div style="margin-bottom:14px">
            <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:6px">Estado</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              ${Object.entries(ESTADOS).map(([k,v])=>`
                <button onclick="CP.PartesAdmin.updateStatus('${p._id}','${k}')"
                  style="background:${p.status===k?v.color+'33':'var(--bg3)'};border:1px solid ${p.status===k?v.color:'var(--border2)'};border-radius:8px;padding:6px 12px;cursor:pointer;color:var(--text);font-size:11px;font-family:'Inter',sans-serif">
                  ${v.emoji} ${v.label}
                </button>`).join('')}
            </div>
          </div>

          <div style="margin-bottom:14px">
            <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:4px">Notas admin</div>
            <textarea id="pa-admin-notes-${p._id}" rows="2" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:8px;color:var(--text);font-size:12px;resize:vertical;font-family:'Inter',sans-serif">${p.adminNotes||''}</textarea>
          </div>
          <div style="margin-bottom:14px">
            <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:4px">Referencia factura</div>
            <input type="text" id="pa-factura-ref-${p._id}" value="${p.facturaRef||''}" placeholder="Ej: FAC00892" style="width:200px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:8px;color:var(--text);font-size:12px">
          </div>

          <div style="display:flex;gap:8px">
            <button class="btn bp" onclick="CP.PartesAdmin.saveParteChanges('${p._id}')">💾 Guardar cambios</button>
            <button class="btn bgh" onclick="document.getElementById('pa-detail-modal').remove()">Cerrar</button>
          </div>
          <div id="pa-detail-msg-${p._id}" style="margin-top:8px;font-size:11px;display:none"></div>
        </div>`;

      document.body.appendChild(modal);
      modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function updateStatus(id, status) {
    try {
      await api(`/api/partes/${id}`, { method:'PUT', body: JSON.stringify({ status }) });
      document.getElementById('pa-detail-modal')?.remove();
      loadLista();
    } catch (err) { alert('Error: ' + err.message); }
  }

  async function saveParteChanges(id) {
    const notes    = document.getElementById(`pa-admin-notes-${id}`)?.value || '';
    const facturaRef = document.getElementById(`pa-factura-ref-${id}`)?.value || '';
    const msg = document.getElementById(`pa-detail-msg-${id}`);
    try {
      await api(`/api/partes/${id}`, { method:'PUT', body: JSON.stringify({ adminNotes: notes, facturaRef }) });
      if (msg) { msg.textContent = '✅ Guardado'; msg.style.display='block'; msg.style.color='var(--green)'; setTimeout(()=>msg.style.display='none',2000); }
      loadLista();
    } catch (err) {
      if (msg) { msg.textContent = '❌ ' + err.message; msg.style.display='block'; msg.style.color='var(--red)'; }
    }
  }

  function addMatRow() {
    const c = document.getElementById('pa-mat-rows');
    if (!c) return;
    const row = document.createElement('div');
    row.className = 'pa-mat-row';
    row.style.cssText = 'display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:6px;margin-bottom:6px';
    row.innerHTML = `
      <input type="text" placeholder="Material" style="background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:6px;padding:6px 8px;font-size:12px">
      <input type="number" placeholder="Cant." min="0" step="0.1" style="background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:6px;padding:6px 8px;font-size:12px">
      <input type="number" placeholder="€/ud" min="0" step="0.01" style="background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:6px;padding:6px 8px;font-size:12px">
      <button onclick="this.closest('.pa-mat-row').remove()" style="background:var(--red-bg);border:1px solid var(--red);border-radius:6px;padding:4px 8px;color:var(--red);cursor:pointer;font-size:11px">✕</button>`;
    c.appendChild(row);
  }

  async function submitParte() {
    const workerSel = document.getElementById('pa-new-worker');
    const workerId  = workerSel?.value;
    const workerName = workerSel?.options[workerSel.selectedIndex]?.dataset.name || '';
    const date      = document.getElementById('pa-new-date')?.value;
    const clientName = document.getElementById('pa-new-client')?.value?.trim() || '';
    const description = document.getElementById('pa-new-desc')?.value?.trim() || '';
    const horas     = parseFloat(document.getElementById('pa-new-horas')?.value || 8);
    const status    = document.getElementById('pa-new-status')?.value || 'pendiente';
    const notas     = document.getElementById('pa-new-notas')?.value?.trim() || '';

    const materiales = [];
    document.querySelectorAll('.pa-mat-row').forEach(row => {
      const inputs = row.querySelectorAll('input');
      const nombre = inputs[0]?.value?.trim();
      const cantidad = parseFloat(inputs[1]?.value || 0);
      const precio  = parseFloat(inputs[2]?.value || 0);
      if (nombre) materiales.push({ nombre, cantidad, precio });
    });

    if (!date || !clientName) {
      const msg = document.getElementById('pa-form-msg');
      if (msg) { msg.textContent = '⚠️ Fecha y cliente son obligatorios'; msg.style.display='block'; msg.style.color='var(--amber)'; }
      return;
    }

    try {
      await api('/api/partes', { method:'POST', body: JSON.stringify({ workerId, workerName, date, clientName, description, horas, status, notas, materiales }) });
      const msg = document.getElementById('pa-form-msg');
      if (msg) { msg.textContent = '✅ Parte guardado correctamente'; msg.style.display='block'; msg.style.color='var(--green)'; }
      setTimeout(() => resetForm(), 1500);
      loadLista();
    } catch (err) {
      const msg = document.getElementById('pa-form-msg');
      if (msg) { msg.textContent = '❌ Error: ' + err.message; msg.style.display='block'; msg.style.color='var(--red)'; }
    }
  }

  function resetForm() {
    ['pa-new-date','pa-new-client','pa-new-desc','pa-new-horas','pa-new-notas'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = id === 'pa-new-horas' ? '8' : '';
    });
    const rows = document.getElementById('pa-mat-rows');
    if (rows) rows.innerHTML = '';
    const msg = document.getElementById('pa-form-msg');
    if (msg) msg.style.display = 'none';
  }

  async function loadFacturacion() {
    const from = document.getElementById('pa-fac-from')?.value || '';
    const to   = document.getElementById('pa-fac-to')?.value   || '';
    const el   = document.getElementById('pa-facturacion');
    if (!el) return;
    el.innerHTML = '<div style="color:var(--text3);font-size:12px">Cargando...</div>';
    try {
      const params = new URLSearchParams({ from, to });
      const data = await api(`/api/partes/resumen/facturacion?${params}`);
      if (!data.length) { el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:10px">No hay partes en este período.</div>'; return; }
      const totalHoras = data.reduce((s,c)=>s+c.horas,0);
      el.innerHTML = `
        <div class="metrics-row" style="margin-bottom:14px">
          <div class="mc"><div class="ml">Clientes con partes</div><div class="mv b">${data.length}</div></div>
          <div class="mc"><div class="ml">Total partes</div><div class="mv b">${data.reduce((s,c)=>s+c.partes,0)}</div></div>
          <div class="mc"><div class="ml">Total horas</div><div class="mv g">${totalHoras.toFixed(1)} h</div></div>
          <div class="mc"><div class="ml">Pendientes verificar</div><div class="mv a">${data.reduce((s,c)=>s+c.pendiente,0)}</div></div>
        </div>
        <div class="card">
          <table>
            <thead><tr><th>Cliente / Obra</th><th style="text-align:right">Partes</th><th style="text-align:right">Horas</th><th>Trabajadores</th><th style="text-align:right">Verificados</th><th style="text-align:right">Pendientes</th></tr></thead>
            <tbody>${data.map(c=>`<tr>
              <td><strong>${c.client}</strong></td>
              <td style="text-align:right">${c.partes}</td>
              <td style="text-align:right;color:var(--green)">${c.horas.toFixed(1)} h</td>
              <td style="font-size:11px;color:var(--text2)">${c.workers.map(w=>w.split(' ')[0]).join(', ')}</td>
              <td style="text-align:right;color:var(--green)">${c.verificado}</td>
              <td style="text-align:right;color:${c.pendiente>0?'var(--amber)':'var(--text2)'}">${c.pendiente}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>`;
    } catch (err) {
      el.innerHTML = `<div style="color:var(--red);font-size:12px">Error: ${err.message}</div>`;
    }
  }

  // PINs (solo mostrar al admin que pulsa el ojo)
  window.togglePin = function(wid) {
    const pins = { jose:'1234', diego:'2345', abdellah:'3456', mamadou:'4567', paula:'5678' };
    const el = document.getElementById('pin-' + wid);
    if (!el) return;
    el.textContent = el.textContent === '••••' ? (pins[wid] || '????') : '••••';
  };

  CP.PartesAdmin = {
    render, showTab, applyFilters, clearFilters, goPage,
    openParte, updateStatus, saveParteChanges,
    addMatRow, submitParte, resetForm, loadFacturacion,
  };

})(window.CP = window.CP || {});
