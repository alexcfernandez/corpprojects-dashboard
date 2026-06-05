// modules/partes-admin.js — Vista de partes para el administrador
(function(CP) {
  'use strict';

  const ESTADOS = {
    pendiente:  { label:'Pendiente revisión', color:'#f59e0b', emoji:'⏳' },
    verificado: { label:'Verificado',         color:'#22c487', emoji:'✅' },
    facturado:  { label:'Facturado',          color:'#4d9cf8', emoji:'💰' },
    incidencia: { label:'Con incidencia',     color:'#f05252', emoji:'⚠️' },
  };

  const ESTADOS_TRABAJO = {
    completado: { label:'Completado',     color:'#22c487', emoji:'✅' },
    continua:   { label:'Continúa',       color:'#f05252', emoji:'🔴' },
    parcial:    { label:'Parcial',        color:'#f59e0b', emoji:'🟡' },
  };

  const TIPOS_JORNADA = {
    NORMAL:  { label:'Normal',  color:'#4d9cf8', emoji:'📅' },
    EXTRA:   { label:'Extra',   color:'#f59e0b', emoji:'⭐' },
    GUARDIA: { label:'Guardia', color:'#a78bfa', emoji:'🛡️' },
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
  let tabActiva = 'lista';

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
        <button class="btab active" onclick="CP.PartesAdmin.showTab('lista',this)">📋 Partes</button>
        <button class="btab" onclick="CP.PartesAdmin.showTab('asignaciones',this)">📅 Asignaciones</button>
        <button class="btab" onclick="CP.PartesAdmin.showTab('expedientes',this)">📁 Expedientes</button>
        <button class="btab" onclick="CP.PartesAdmin.showTab('facturacion',this)">💰 Por facturar</button>
        <button class="btab" onclick="CP.PartesAdmin.showTab('nuevo',this)">➕ Nuevo parte</button>
        <button class="btab" onclick="CP.PartesAdmin.showTab('accesos',this)">🔑 Accesos</button>
      </div>

      <!-- LISTA PARTES -->
      <div id="pa-tab-lista" class="p-tab active">
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
              <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Estado parte</div>
              <select id="pa-f-status" onchange="CP.PartesAdmin.applyFilters()" style="background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:var(--rs);padding:6px 10px;font-size:12px">
                <option value="">Todos</option>
                ${Object.entries(ESTADOS).map(([k,v])=>`<option value="${k}">${v.emoji} ${v.label}</option>`).join('')}
              </select>
            </div>
            <div>
              <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Cliente</div>
              <input type="text" id="pa-f-client" placeholder="Buscar..." class="srch" style="width:160px" oninput="CP.PartesAdmin.applyFilters()">
            </div>
            <div>
              <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Desde</div>
              <input type="date" id="pa-f-from" class="srch" style="width:135px" onchange="CP.PartesAdmin.applyFilters()">
            </div>
            <div>
              <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Hasta</div>
              <input type="date" id="pa-f-to" class="srch" style="width:135px" onchange="CP.PartesAdmin.applyFilters()">
            </div>
            <button class="btn bgh" onclick="CP.PartesAdmin.clearFilters()">Limpiar</button>
          </div>
        </div>
        <div id="pa-metrics" class="metrics-row" style="margin-bottom:14px"></div>
        <div class="card">
          <div class="card-title">Partes de trabajo <span style="font-size:10px;color:var(--text3)" id="pa-count">—</span></div>
          <div id="pa-lista">Cargando...</div>
          <div id="pa-pagination" style="margin-top:10px"></div>
        </div>
      </div>

      <!-- ASIGNACIONES -->
      <div id="pa-tab-asignaciones" class="p-tab" style="display:none">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px">
          <div style="display:flex;align-items:center;gap:10px">
            <input type="date" id="asig-fecha" onchange="CP.PartesAdmin.loadAsignaciones()" style="background:var(--bg3);border:1px solid var(--border2);border-radius:var(--rs);padding:8px 12px;color:var(--text);font-size:13px">
          </div>
          <button class="btn bp" onclick="CP.PartesAdmin.abrirModalAsignacion(null)">+ Nueva asignación</button>
        </div>
        <div id="asig-planning">Selecciona una fecha para ver el planning.</div>
      </div>

      <!-- EXPEDIENTES -->
      <div id="pa-tab-expedientes" class="p-tab" style="display:none">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px">
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <select id="exp-f-estado" onchange="CP.PartesAdmin.loadExpedientes()" style="background:var(--bg3);border:1px solid var(--border2);border-radius:var(--rs);padding:8px 12px;color:var(--text);font-size:13px">
              <option value="">Todos</option>
              <option value="EN_CURSO" selected>🔴 En curso</option>
              <option value="COMPLETADO">✅ Completados</option>
              <option value="PAUSADO">⏸️ Pausados</option>
            </select>
            <input type="text" id="exp-f-cliente" placeholder="Filtrar cliente..." class="srch" style="width:180px" oninput="CP.PartesAdmin.loadExpedientes()">
          </div>
          <button class="btn bp" onclick="CP.PartesAdmin.abrirModalExpediente(null)">+ Nuevo expediente</button>
        </div>
        <div id="exp-lista">Cargando...</div>
      </div>

      <!-- FACTURACIÓN -->
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
        <div id="pa-facturacion">Selecciona un período.</div>
      </div>

      <!-- NUEVO PARTE -->
      <div id="pa-tab-nuevo" class="p-tab" style="display:none">
        <div class="card" style="max-width:600px">
          <div class="card-title">Nuevo parte (admin)</div>
          ${renderFormAdmin()}
          <div id="pa-form-msg" style="margin-top:10px;font-size:12px;display:none"></div>
          <div style="display:flex;gap:8px;margin-top:14px">
            <button class="btn bp" onclick="CP.PartesAdmin.submitParte()">💾 Guardar parte</button>
            <button class="btn bgh" onclick="CP.PartesAdmin.resetForm()">Limpiar</button>
          </div>
        </div>
      </div>

      <!-- ACCESOS -->
      <div id="pa-tab-accesos" class="p-tab" style="display:none">
        <div class="alert ain" style="margin-bottom:14px">
          <div>🔑</div>
          <div><strong>Acceso de trabajadores</strong> — entran con PIN en <strong>dashboard.corpprojects.es/parte</strong></div>
        </div>
        <div class="card" style="max-width:500px">
          <div class="card-title">PINs de acceso</div>
          <table>
            <thead><tr><th>Trabajador</th><th style="text-align:center">PIN</th><th>Enlace</th></tr></thead>
            <tbody>
              ${WORKERS.map(w=>`<tr>
                <td><strong>${w.name}</strong></td>
                <td style="text-align:center">
                  <span style="font-family:monospace;background:var(--bg3);padding:3px 10px;border-radius:6px;font-size:14px" id="pin-${w.id}">••••</span>
                  <button onclick="togglePin('${w.id}')" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:11px;margin-left:6px">👁</button>
                </td>
                <td><a href="/parte?w=${w.id}" target="_blank" style="color:var(--blue);font-size:11px">Abrir →</a></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="card" style="max-width:500px;margin-top:14px">
          <div class="card-title">Externos registrados</div>
          <div id="externos-admin-lista">Cargando...</div>
          <button class="btn bp" style="margin-top:10px" onclick="CP.PartesAdmin.abrirModalExterno()">+ Añadir externo</button>
        </div>
      </div>`;

    // Cargar tab inicial
    loadLista();
    const hoy = new Date().toISOString().slice(0,10);
    const asigFecha = document.getElementById('asig-fecha');
    if (asigFecha) asigFecha.value = hoy;
  }

  // ── TABS ────────────────────────────────────────────────────────
  function showTab(id, btn) {
    document.querySelectorAll('#presencia-container .p-tab').forEach(p => { p.style.display='none'; p.classList.remove('active'); });
    document.querySelectorAll('#presencia-container .btab').forEach(b => b.classList.remove('active'));
    const tab = document.getElementById('pa-tab-' + id);
    if (tab) { tab.style.display='block'; tab.classList.add('active'); }
    if (btn) btn.classList.add('active');
    tabActiva = id;
    if (id === 'lista')        loadLista();
    if (id === 'asignaciones') loadAsignaciones();
    if (id === 'expedientes')  loadExpedientes();
    if (id === 'nuevo')        loadClientsSuggestions();
    if (id === 'accesos')      loadExternosAdmin();
  }

  // ── LISTA PARTES ────────────────────────────────────────────────
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

  function goPage(n) { currentPage = n; loadLista(); }

  async function loadLista() {
    const el = document.getElementById('pa-lista');
    if (!el) return;
    el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:10px">Cargando...</div>';
    try {
      const params = new URLSearchParams({ ...filters, limit: PAGE, skip: currentPage * PAGE });
      const data = await api(`/api/partes?${params}`);
      document.getElementById('pa-count').textContent = `${data.total} partes`;

      const metrics = document.getElementById('pa-metrics');
      if (metrics && data.partes) {
        const pend  = data.partes.filter(p => p.status === 'pendiente').length;
        const ver   = data.partes.filter(p => p.status === 'verificado').length;
        const horas = data.partes.reduce((s,p) => s + (p.horas||0), 0);
        const continua = data.partes.filter(p => p.estadoTrabajo === 'continua').length;
        metrics.innerHTML = `
          <div class="mc"><div class="ml">Total partes</div><div class="mv b">${data.total}</div></div>
          <div class="mc"><div class="ml">Pendientes revisión</div><div class="mv a">${pend}</div></div>
          <div class="mc"><div class="ml">Verificados</div><div class="mv g">${ver}</div></div>
          <div class="mc"><div class="ml">Horas registradas</div><div class="mv b">${horas.toFixed(1)} h</div></div>
          ${continua > 0 ? `<div class="mc"><div class="ml">⚠️ Continúan otro día</div><div class="mv a">${continua}</div></div>` : ''}`;
      }

      if (!data.partes?.length) {
        el.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text3)"><div style="font-size:32px;margin-bottom:8px">📋</div><div>No hay partes con estos filtros</div></div>';
        return;
      }

      const grupos = {
        pendiente:  data.partes.filter(p => p.status === 'pendiente'),
        incidencia: data.partes.filter(p => p.status === 'incidencia'),
        verificado: data.partes.filter(p => p.status === 'verificado'),
        facturado:  data.partes.filter(p => p.status === 'facturado'),
      };

      const renderRow = (p) => {
        const est  = ESTADOS[p.status]              || ESTADOS.pendiente;
        const etrab = ESTADOS_TRABAJO[p.estadoTrabajo] || null;
        const ejor  = TIPOS_JORNADA[p.tipoJornada]    || null;
        const enviado = p._meta?.submittedAt ? new Date(p._meta.submittedAt).toLocaleString('es-ES',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—';
        const dateMatch = p.date === (p._meta?.submittedAt?.slice?.(0,10) || p.date);
        const tieneEquipo = p.equipo?.length > 1;
        const esAutoGen = p.generadoAuto;
        return `<tr style="${p.estadoTrabajo==='continua'?'background:rgba(240,82,82,.04)':''}">
          <td>${dt(p.date)}${!dateMatch?' <span title="Fecha declarada difiere del envío" style="color:var(--amber);font-size:10px">⚠️</span>':''}</td>
          <td>
            ${p.workerName}
            ${esAutoGen ? '<div style="font-size:9px;color:var(--text3)">auto-generado</div>' : ''}
          </td>
          <td>
            <strong>${p.clientName||'—'}</strong>
            ${p.description ? `<br><span style="font-size:10px;color:var(--text3)">${p.description.slice(0,40)}${p.description.length>40?'...':''}</span>` : ''}
            ${tieneEquipo ? `<div style="font-size:10px;color:var(--blue)">👥 ${p.equipo.length} personas</div>` : ''}
            ${p.expedienteId ? `<div style="font-size:10px;color:var(--amber)">📁 Expediente</div>` : ''}
          </td>
          <td style="text-align:right">${p.horas} h</td>
          <td>
            <span style="background:${est.color}22;color:${est.color};padding:2px 8px;border-radius:8px;font-size:10px;font-weight:600">${est.emoji} ${est.label}</span>
            ${etrab && p.estadoTrabajo !== 'completado' ? `<div style="margin-top:3px"><span style="background:${etrab.color}22;color:${etrab.color};padding:1px 6px;border-radius:6px;font-size:9px;font-weight:600">${etrab.emoji} ${etrab.label}</span></div>` : ''}
            ${ejor && p.tipoJornada !== 'NORMAL' ? `<div style="margin-top:2px"><span style="background:${ejor.color}22;color:${ejor.color};padding:1px 6px;border-radius:6px;font-size:9px">${ejor.emoji} ${ejor.label}</span></div>` : ''}
          </td>
          <td style="font-size:10px;color:var(--text3)">${enviado}</td>
          <td style="display:flex;gap:4px">
            <button class="btn bgh" style="padding:3px 8px;font-size:11px" onclick="CP.PartesAdmin.openParte('${p._id}')">Ver →</button>
            <button class="btn bgh" style="padding:3px 8px;font-size:11px;color:var(--red);border-color:var(--red)" onclick="CP.PartesAdmin.deleteParte('${p._id}','${p.clientName||'parte'}')">🗑</button>
          </td>
        </tr>`;
      };

      const sectionLabels = {
        pendiente:  '⏳ Pendientes de revisión',
        incidencia: '⚠️ Con incidencia',
        verificado: '✅ Verificados',
        facturado:  '💰 Facturados',
      };

      let rows = '';
      Object.entries(grupos).forEach(([status, partes]) => {
        if (!partes.length) return;
        const est = ESTADOS[status];
        rows += `<tr>
          <td colspan="7" style="background:${est?.color||'#666'}18;color:${est?.color||'var(--text3)'};font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;padding:8px 10px;border-top:2px solid ${est?.color||'var(--border)'}44">
            ${sectionLabels[status]} <span style="font-weight:400;opacity:.7">(${partes.length})</span>
          </td></tr>`;
        rows += partes.map(p => renderRow(p)).join('');
      });

      el.innerHTML = `<table>
        <thead><tr>
          <th style="width:85px">Fecha</th>
          <th style="width:110px">Trabajador</th>
          <th>Cliente / Obra</th>
          <th style="text-align:right;width:55px">Horas</th>
          <th style="width:150px">Estados</th>
          <th style="width:75px;font-size:10px;color:var(--text3)">Enviado</th>
          <th style="width:90px"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;

      const pag = document.getElementById('pa-pagination');
      if (pag) {
        const totalPages = Math.ceil(data.total / PAGE);
        pag.innerHTML = totalPages > 1 ? `<div style="display:flex;gap:6px;align-items:center">
          <button class="btn bgh" ${currentPage===0?'disabled':''} onclick="CP.PartesAdmin.goPage(${currentPage-1})">← Anterior</button>
          <span style="font-size:12px;color:var(--text2)">Página ${currentPage+1} de ${totalPages}</span>
          <button class="btn bgh" ${currentPage>=totalPages-1?'disabled':''} onclick="CP.PartesAdmin.goPage(${currentPage+1})">Siguiente →</button>
        </div>` : '';
      }
    } catch (err) {
      el.innerHTML = `<div style="color:var(--red);font-size:12px;padding:10px">Error: ${err.message}</div>`;
    }
  }

  // ── DETALLE PARTE ───────────────────────────────────────────────
  async function openParte(id) {
    try {
      const p = await api(`/api/partes/${id}`);
      const est   = ESTADOS[p.status]               || ESTADOS.pendiente;
      const etrab = ESTADOS_TRABAJO[p.estadoTrabajo] || null;
      const ejor  = TIPOS_JORNADA[p.tipoJornada]    || null;
      const gps   = p._meta?.gpsLat ? `${p._meta.gpsLat.toFixed(5)}, ${p._meta.gpsLng.toFixed(5)}` : 'No disponible';
      const mapsUrl = p._meta?.gpsLat ? `https://maps.google.com/?q=${p._meta.gpsLat},${p._meta.gpsLng}` : null;

      document.getElementById('pa-detail-modal')?.remove();
      const modal = document.createElement('div');
      modal.id = 'pa-detail-modal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto';

      modal.innerHTML = `
        <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:16px;padding:24px;width:100%;max-width:600px;margin:auto">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
            <div>
              <div style="font-weight:600;font-size:15px">${p.workerName} — ${p.clientName||'Sin cliente'}</div>
              <div style="font-size:11px;color:var(--text3);margin-top:3px;display:flex;gap:6px;flex-wrap:wrap">
                <span>${dt(p.date)}</span>
                ${ejor && p.tipoJornada !== 'NORMAL' ? `<span style="background:${ejor.color}22;color:${ejor.color};padding:1px 8px;border-radius:6px;font-size:11px">${ejor.emoji} ${ejor.label}</span>` : ''}
                ${etrab ? `<span style="background:${etrab.color}22;color:${etrab.color};padding:1px 8px;border-radius:6px;font-size:11px">${etrab.emoji} Trabajo: ${etrab.label}</span>` : ''}
                ${p.expedienteId ? `<span style="background:rgba(245,158,11,.15);color:var(--amber);padding:1px 8px;border-radius:6px;font-size:11px">📁 En expediente</span>` : ''}
                ${p.generadoAuto ? `<span style="background:rgba(77,156,248,.1);color:var(--blue);padding:1px 8px;border-radius:6px;font-size:11px">🤖 Auto-generado</span>` : ''}
              </div>
            </div>
            <button onclick="document.getElementById('pa-detail-modal').remove()" style="background:none;border:none;color:var(--text3);font-size:18px;cursor:pointer">✕</button>
          </div>

          <!-- EQUIPO -->
          ${p.equipo?.length > 1 ? `
          <div style="background:rgba(77,156,248,.06);border:1px solid rgba(77,156,248,.2);border-radius:10px;padding:12px 16px;margin-bottom:12px">
            <div style="font-size:10px;color:var(--blue);text-transform:uppercase;font-weight:600;margin-bottom:8px">👥 Equipo de trabajo</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">
              ${p.equipo.map(m => `<span style="background:var(--bg3);border:1px solid var(--border2);border-radius:20px;padding:4px 12px;font-size:12px">${m.esResponsable?'👷':'👤'} ${m.nombre}${m.tipo==='externo'?' <span style="color:var(--text3);font-size:10px">(ext.)</span>':''}${m.esResponsable?' <span style="color:var(--blue);font-size:10px">responsable</span>':''}</span>`).join('')}
            </div>
          </div>` : ''}

          <!-- PENDIENTE DETALLE -->
          ${(p.estadoTrabajo === 'continua' || p.estadoTrabajo === 'parcial') && p.pendienteDetalle ? `
          <div style="background:rgba(240,82,82,.08);border:1px solid rgba(240,82,82,.25);border-radius:10px;padding:12px 16px;margin-bottom:12px">
            <div style="font-size:10px;color:var(--red);text-transform:uppercase;font-weight:600;margin-bottom:4px">🔴 Qué queda por hacer</div>
            <div style="font-size:13px;color:var(--text)">${p.pendienteDetalle}</div>
          </div>` : ''}

          <!-- DATOS PARTE -->
          <div style="background:var(--bg3);border-radius:var(--rs);padding:14px;margin-bottom:12px">
            <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:8px;font-weight:600">Datos del parte</div>
            <table style="font-size:12px">
              <tr><td style="color:var(--text2);padding:3px 0;width:130px">Descripción</td><td>${p.description||'—'}</td></tr>
              <tr><td style="color:var(--text2);padding:3px 0">Horas</td><td>${p.horas} h</td></tr>
              <tr><td style="color:var(--text2);padding:3px 0">Notas trabajador</td><td>${p.notas||'—'}</td></tr>
            </table>
            ${p.materiales?.length ? `
              <div style="margin-top:8px;font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:4px">Materiales</div>
              <table style="font-size:12px;width:100%">
                <thead><tr><th>Material</th><th style="text-align:right">Cant.</th><th style="text-align:right">€/ud</th><th style="text-align:right">Total</th></tr></thead>
                <tbody>${p.materiales.map(m=>`<tr><td>${m.nombre||'—'}</td><td style="text-align:right">${m.cantidad||0}</td><td style="text-align:right">${m.precio||0}€</td><td style="text-align:right">${((m.cantidad||0)*(m.precio||0)).toFixed(2)}€</td></tr>`).join('')}</tbody>
              </table>` : ''}
          </div>

          <!-- FOTOS -->
          ${(p._meta?.fotosTrabajo?.length || p._meta?.fotosAlbaran?.length) ? `
          <div style="margin-bottom:12px">
            ${p._meta.fotosTrabajo?.length ? `
              <div style="font-size:10px;color:var(--text3);text-transform:uppercase;font-weight:600;margin-bottom:6px">📸 Fotos trabajo (${p._meta.fotosTrabajo.length})</div>
              <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:6px;margin-bottom:10px">
                ${p._meta.fotosTrabajo.map(src=>`<img src="${src}" onclick="window.open('${src}','_blank')" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;border:1px solid var(--border);cursor:pointer">`).join('')}
              </div>` : ''}
            ${p._meta.fotosAlbaran?.length ? `
              <div style="font-size:10px;color:var(--text3);text-transform:uppercase;font-weight:600;margin-bottom:6px">🧾 Albaranes (${p._meta.fotosAlbaran.length})</div>
              <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:6px">
                ${p._meta.fotosAlbaran.map(src=>`<img src="${src}" onclick="window.open('${src}','_blank')" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;border:1px solid var(--border);cursor:pointer">`).join('')}
              </div>` : ''}
          </div>` : '<div style="font-size:11px;color:var(--text3);padding:6px 0;margin-bottom:8px">Sin fotos adjuntas</div>'}

          <!-- METADATOS -->
          <div style="background:rgba(77,156,248,.06);border:1px solid rgba(77,156,248,.2);border-radius:var(--rs);padding:14px;margin-bottom:12px">
            <div style="font-size:10px;color:var(--blue);text-transform:uppercase;margin-bottom:8px;font-weight:600">🔒 Control admin</div>
            <table style="font-size:11px">
              <tr><td style="color:var(--text2);padding:2px 0;width:130px">Envío real</td><td>${dtFull(p._meta?.submittedAt)}</td></tr>
              <tr><td style="color:var(--text2);padding:2px 0">Enviado por</td><td>${p._meta?.submittedBy==='worker'?'👷 Trabajador':p._meta?.submittedBy==='auto'?'🤖 Sistema':'👔 Admin'}</td></tr>
              <tr><td style="color:var(--text2);padding:2px 0">GPS</td><td>${mapsUrl?`<a href="${mapsUrl}" target="_blank" style="color:var(--blue)">${gps} →</a>`:gps}</td></tr>
              ${p._meta?.gpsAccuracy?`<tr><td style="color:var(--text2);padding:2px 0">Precisión</td><td>±${p._meta.gpsAccuracy.toFixed(0)}m</td></tr>`:''}
            </table>
          </div>

          <!-- CAMBIAR ESTADO -->
          <div style="margin-bottom:14px">
            <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:6px">Estado revisión</div>
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
            <input type="text" id="pa-factura-ref-${p._id}" value="${p.facturaRef||''}" placeholder="Ej: FAC00892" style="width:220px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:8px;color:var(--text);font-size:12px">
          </div>

          ${p.expedienteId ? `
          <div style="margin-bottom:14px">
            <button class="btn bgh" onclick="CP.PartesAdmin.verExpediente('${p.expedienteId}');document.getElementById('pa-detail-modal').remove()">
              📁 Ver expediente completo →
            </button>
          </div>` : ''}

          <div style="display:flex;gap:8px">
            <button class="btn bp" onclick="CP.PartesAdmin.saveParteChanges('${p._id}')">💾 Guardar</button>
            <button class="btn bgh" onclick="document.getElementById('pa-detail-modal').remove()">Cerrar</button>
          </div>
          <div id="pa-detail-msg-${p._id}" style="margin-top:8px;font-size:11px;display:none"></div>
        </div>`;

      document.body.appendChild(modal);
      modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });
    } catch(err) { alert('Error: ' + err.message); }
  }

  async function updateStatus(id, status) {
    try {
      await api(`/api/partes/${id}`, { method:'PUT', body: JSON.stringify({ status }) });
      document.getElementById('pa-detail-modal')?.remove();
      loadLista();
    } catch(err) { alert('Error: ' + err.message); }
  }

  async function saveParteChanges(id) {
    const notes      = document.getElementById(`pa-admin-notes-${id}`)?.value || '';
    const facturaRef = document.getElementById(`pa-factura-ref-${id}`)?.value || '';
    const msg        = document.getElementById(`pa-detail-msg-${id}`);
    try {
      await api(`/api/partes/${id}`, { method:'PUT', body: JSON.stringify({ adminNotes: notes, facturaRef }) });
      if (msg) { msg.textContent='✅ Guardado'; msg.style.display='block'; msg.style.color='var(--green)'; setTimeout(()=>msg.style.display='none',2000); }
      loadLista();
    } catch(err) {
      if (msg) { msg.textContent='❌ '+err.message; msg.style.display='block'; msg.style.color='var(--red)'; }
    }
  }

  async function deleteParte(id, name) {
    if (!confirm(`¿Eliminar el parte de "${name}"?`)) return;
    try {
      await api(`/api/partes/${id}`, { method:'DELETE' });
      loadLista();
    } catch(err) { alert('Error: ' + err.message); }
  }

  // ── ASIGNACIONES ────────────────────────────────────────────────
  async function loadAsignaciones() {
    const fecha = document.getElementById('asig-fecha')?.value || new Date().toISOString().slice(0,10);
    const el    = document.getElementById('asig-planning');
    if (!el) return;
    el.innerHTML = '<div style="color:var(--text3);font-size:12px">Cargando...</div>';
    try {
      const lista = await api(`/api/asignaciones/dia/${fecha}`);
      if (!lista.length) {
        el.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text3)">
          <div style="font-size:36px;margin-bottom:8px">📅</div>
          <div>No hay asignaciones para este día</div>
          <button class="btn bp" style="margin-top:14px" onclick="CP.PartesAdmin.abrirModalAsignacion(null)">+ Crear primera asignación</button>
        </div>`;
        return;
      }

      const extrasCount = lista.filter(a => a.tipoJornada === 'EXTRA').length;
      el.innerHTML = `
        <div style="display:flex;gap:8px;margin-bottom:14px;font-size:12px;color:var(--text3)">
          <span>${lista.length} trabajo${lista.length>1?'s':''}</span>
          ${extrasCount ? `<span style="color:var(--amber)">· ${extrasCount} jornada${extrasCount>1?'s':''} extra</span>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:12px">
          ${lista.map(a => {
            const esExtra  = a.tipoJornada === 'EXTRA';
            const esGuardia = a.tipoJornada === 'GUARDIA';
            const colorBorde = esExtra ? 'var(--amber)' : esGuardia ? 'var(--purple)' : 'var(--border2)';
            const responsable = a.equipo?.find(m => m.esResponsable);
            const resto = a.equipo?.filter(m => !m.esResponsable) || [];
            return `
            <div style="background:var(--bg2);border:1.5px solid ${colorBorde};border-radius:14px;padding:16px">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
                <div>
                  <div style="font-size:15px;font-weight:700;margin-bottom:2px">${a.clientName}</div>
                  <div style="font-size:13px;color:var(--text2)">${a.descripcion||'—'}</div>
                </div>
                <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
                  <span style="background:${esExtra?'rgba(245,158,11,.15)':esGuardia?'rgba(167,139,250,.15)':'rgba(77,156,248,.1)'};color:${esExtra?'var(--amber)':esGuardia?'var(--purple)':'var(--blue)'};border-radius:6px;padding:2px 10px;font-size:11px;font-weight:600">
                    ${esExtra?'⭐ EXTRA':esGuardia?'🛡️ GUARDIA':'📅 Normal'}
                  </span>
                  ${a.horaInicio ? `<span style="font-size:12px;color:var(--text3)">${a.horaInicio}${a.horaFin?' – '+a.horaFin:''}</span>` : ''}
                </div>
              </div>
              <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">
                ${responsable ? `<span style="background:rgba(77,156,248,.1);border:1px solid rgba(77,156,248,.3);border-radius:20px;padding:4px 12px;font-size:12px;color:var(--blue)">👷 ${responsable.nombre}</span>` : ''}
                ${resto.map(m => `<span style="background:var(--bg3);border:1px solid var(--border2);border-radius:20px;padding:4px 12px;font-size:12px">${m.tipo==='externo'?'👤':'👤'} ${m.nombre}${m.tipo==='externo'?' <span style="font-size:10px;color:var(--text3)">(ext.)</span>':''}</span>`).join('')}
              </div>
              <div style="display:flex;gap:8px">
                <button class="btn bgh" style="font-size:11px;padding:5px 12px" onclick="CP.PartesAdmin.abrirModalAsignacion(${JSON.stringify(a).replace(/"/g,'&quot;')})">✏️ Editar</button>
                <button class="btn bgh" style="font-size:11px;padding:5px 12px;color:var(--red);border-color:var(--red)" onclick="CP.PartesAdmin.borrarAsignacion('${a._id}')">🗑 Eliminar</button>
              </div>
            </div>`;
          }).join('')}
        </div>`;
    } catch(err) {
      el.innerHTML = `<div style="color:var(--red);font-size:12px">Error: ${err.message}</div>`;
    }
  }

  async function abrirModalAsignacion(asig) {
    // Cargar datos necesarios
    let workers = [], externos = [];
    try { workers  = await api('/api/partes/workers'); } catch(e) {}
    try { externos = await api('/api/externos'); }        catch(e) {}

    const fecha = document.getElementById('asig-fecha')?.value || new Date().toISOString().slice(0,10);
    const equipoActual = asig?.equipo || [];

    document.getElementById('asig-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'asig-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto';

    modal.innerHTML = `
      <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:16px;padding:24px;width:100%;max-width:580px;margin:auto">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
          <div style="font-size:16px;font-weight:700">${asig ? 'Editar asignación' : 'Nueva asignación'}</div>
          <button onclick="document.getElementById('asig-modal').remove()" style="background:none;border:none;color:var(--text3);font-size:18px;cursor:pointer">✕</button>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
          <div>
            <div style="font-size:11px;color:var(--text3);text-transform:uppercase;margin-bottom:4px">Fecha</div>
            <input type="date" id="asig-m-fecha" value="${asig?.fecha || fecha}" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--rs);padding:9px;color:var(--text);font-size:13px">
          </div>
          <div>
            <div style="font-size:11px;color:var(--text3);text-transform:uppercase;margin-bottom:4px">Tipo jornada</div>
            <select id="asig-m-jornada" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--rs);padding:9px;color:var(--text);font-size:13px">
              <option value="NORMAL" ${(asig?.tipoJornada||'NORMAL')==='NORMAL'?'selected':''}>📅 Normal</option>
              <option value="EXTRA" ${asig?.tipoJornada==='EXTRA'?'selected':''}>⭐ Extra / Sábado</option>
              <option value="GUARDIA" ${asig?.tipoJornada==='GUARDIA'?'selected':''}>🛡️ Guardia</option>
            </select>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
          <div>
            <div style="font-size:11px;color:var(--text3);text-transform:uppercase;margin-bottom:4px">Hora inicio</div>
            <input type="time" id="asig-m-hinicio" value="${asig?.horaInicio||''}" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--rs);padding:9px;color:var(--text);font-size:13px">
          </div>
          <div>
            <div style="font-size:11px;color:var(--text3);text-transform:uppercase;margin-bottom:4px">Hora fin</div>
            <input type="time" id="asig-m-hfin" value="${asig?.horaFin||''}" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--rs);padding:9px;color:var(--text);font-size:13px">
          </div>
        </div>

        <div style="margin-bottom:14px">
          <div style="font-size:11px;color:var(--text3);text-transform:uppercase;margin-bottom:4px">Cliente / Obra</div>
          <input type="text" id="asig-m-cliente" list="asig-clients-list" value="${asig?.clientName||''}" placeholder="Nombre del cliente..." style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--rs);padding:9px;color:var(--text);font-size:13px">
          <datalist id="asig-clients-list"></datalist>
        </div>

        <div style="margin-bottom:14px">
          <div style="font-size:11px;color:var(--text3);text-transform:uppercase;margin-bottom:4px">Descripción del trabajo</div>
          <textarea id="asig-m-desc" rows="2" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--rs);padding:9px;color:var(--text);font-size:13px;font-family:inherit;resize:vertical">${asig?.descripcion||''}</textarea>
        </div>

        <div style="margin-bottom:14px">
          <div style="font-size:11px;color:var(--text3);text-transform:uppercase;margin-bottom:8px">Equipo de trabajo</div>
          <div style="font-size:11px;color:var(--text3);margin-bottom:6px">Plantilla:</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px" id="asig-m-workers">
            ${workers.map(w => {
              const miembro = equipoActual.find(m => m.id === String(w.id));
              const sel = !!miembro;
              const esResp = miembro?.esResponsable;
              return `<button type="button" class="equipo-chip-modal${sel?' chip-sel':''}" data-id="${w.id}" data-nombre="${w.name}" data-tipo="plantilla" onclick="toggleChipModal(this)"
                style="background:${sel?'rgba(77,156,248,.15)':'var(--bg3)'};border:1.5px solid ${sel?'var(--blue)':'var(--border2)'};border-radius:20px;padding:7px 14px;font-size:13px;cursor:pointer;color:${sel?'var(--blue)':'var(--text2)'}">
                ${w.name.split(' ')[0]}
                ${esResp?'<span style="font-size:10px;color:var(--amber)"> ★</span>':''}
              </button>`;
            }).join('')}
          </div>
          ${externos.length > 0 ? `
          <div style="font-size:11px;color:var(--text3);margin-bottom:6px">Externos:</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px" id="asig-m-externos">
            ${externos.map(e => {
              const sel = equipoActual.some(m => m.id === String(e._id));
              return `<button type="button" class="equipo-chip-modal${sel?' chip-sel':''}" data-id="${e._id}" data-nombre="${e.nombre}" data-tipo="externo" onclick="toggleChipModal(this)"
                style="background:${sel?'rgba(245,158,11,.12)':'var(--bg3)'};border:1.5px dashed ${sel?'var(--amber)':'var(--border2)'};border-radius:20px;padding:7px 14px;font-size:13px;cursor:pointer;color:${sel?'var(--amber)':'var(--text3)'}">
                👤 ${e.nombre}
              </button>`;
            }).join('')}
          </div>` : ''}

          <div style="margin-top:10px">
            <div style="font-size:11px;color:var(--text3);margin-bottom:4px">Responsable principal:</div>
            <select id="asig-m-responsable" style="background:var(--bg3);border:1px solid var(--border2);border-radius:var(--rs);padding:8px;color:var(--text);font-size:13px">
              ${workers.map(w => `<option value="${w.id}" ${equipoActual.find(m=>m.id===String(w.id)&&m.esResponsable)?'selected':''}>${w.name}</option>`).join('')}
            </select>
          </div>
        </div>

        <div style="margin-bottom:20px">
          <div style="font-size:11px;color:var(--text3);text-transform:uppercase;margin-bottom:4px">Notas</div>
          <input type="text" id="asig-m-notas" value="${asig?.notas||''}" placeholder="Observaciones..." style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--rs);padding:9px;color:var(--text);font-size:13px">
        </div>

        <div style="display:flex;gap:8px">
          <button class="btn bp" onclick="CP.PartesAdmin.guardarAsignacion('${asig?._id||''}')">💾 Guardar</button>
          <button class="btn bgh" onclick="document.getElementById('asig-modal').remove()">Cancelar</button>
        </div>
        <div id="asig-modal-msg" style="margin-top:8px;font-size:12px;display:none"></div>
      </div>`;

    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });

    // Cargar clientes en datalist
    try {
      if (!window._cpClients) {
        const names = await api('/api/clients/list');
        window._cpClients = Array.isArray(names) ? names : [];
      }
      const dl = document.getElementById('asig-clients-list');
      if (dl) dl.innerHTML = window._cpClients.map(n=>`<option value="${n}">`).join('');
    } catch(e) {}
  }

  window.toggleChipModal = function(btn) {
    const sel = btn.classList.toggle('chip-sel');
    const tipo = btn.dataset.tipo;
    if (sel) {
      btn.style.background = tipo === 'externo' ? 'rgba(245,158,11,.12)' : 'rgba(77,156,248,.15)';
      btn.style.borderColor = tipo === 'externo' ? 'var(--amber)' : 'var(--blue)';
      btn.style.color       = tipo === 'externo' ? 'var(--amber)' : 'var(--blue)';
    } else {
      btn.style.background = 'var(--bg3)';
      btn.style.borderColor = tipo === 'externo' ? 'var(--border2)' : 'var(--border2)';
      btn.style.color       = tipo === 'externo' ? 'var(--text3)' : 'var(--text2)';
    }
  };

  async function guardarAsignacion(id) {
    const fecha     = document.getElementById('asig-m-fecha')?.value;
    const jornada   = document.getElementById('asig-m-jornada')?.value || 'NORMAL';
    const hinicio   = document.getElementById('asig-m-hinicio')?.value || '';
    const hfin      = document.getElementById('asig-m-hfin')?.value   || '';
    const cliente   = document.getElementById('asig-m-cliente')?.value?.trim() || '';
    const desc      = document.getElementById('asig-m-desc')?.value?.trim()    || '';
    const notas     = document.getElementById('asig-m-notas')?.value?.trim()   || '';
    const responsableId = document.getElementById('asig-m-responsable')?.value || '';
    const msg       = document.getElementById('asig-modal-msg');

    if (!fecha || !cliente) {
      if (msg) { msg.textContent = '⚠️ Fecha y cliente son obligatorios'; msg.style.display='block'; msg.style.color='var(--amber)'; }
      return;
    }

    // Construir equipo
    const equipo = [];
    document.querySelectorAll('.equipo-chip-modal.chip-sel').forEach(btn => {
      equipo.push({
        id:           btn.dataset.id,
        nombre:       btn.dataset.nombre,
        tipo:         btn.dataset.tipo,
        esResponsable: btn.dataset.id === responsableId
      });
    });

    const data = { fecha, tipoJornada: jornada, horaInicio: hinicio, horaFin: hfin, clientName: cliente, descripcion: desc, equipo, notas };

    try {
      if (id) {
        await api(`/api/asignaciones/${id}`, { method:'PUT', body: JSON.stringify(data) });
      } else {
        await api('/api/asignaciones', { method:'POST', body: JSON.stringify(data) });
      }
      document.getElementById('asig-modal').remove();
      // Actualizar fecha del planning
      const fechaInput = document.getElementById('asig-fecha');
      if (fechaInput) fechaInput.value = fecha;
      loadAsignaciones();
    } catch(err) {
      if (msg) { msg.textContent = '❌ ' + err.message; msg.style.display='block'; msg.style.color='var(--red)'; }
    }
  }

  async function borrarAsignacion(id) {
    if (!confirm('¿Eliminar esta asignación?')) return;
    try {
      await api(`/api/asignaciones/${id}`, { method:'DELETE' });
      loadAsignaciones();
    } catch(err) { alert('Error: ' + err.message); }
  }

  // ── EXPEDIENTES ─────────────────────────────────────────────────
  async function loadExpedientes() {
    const estado   = document.getElementById('exp-f-estado')?.value   || '';
    const cliente  = document.getElementById('exp-f-cliente')?.value  || '';
    const el       = document.getElementById('exp-lista');
    if (!el) return;
    el.innerHTML = '<div style="color:var(--text3);font-size:12px">Cargando...</div>';
    try {
      const params = new URLSearchParams({ estado, clientName: cliente });
      const lista  = await api(`/api/expedientes?${params}`);
      if (!lista.length) {
        el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text3)"><div style="font-size:36px;margin-bottom:8px">📁</div><div>No hay expedientes</div></div>';
        return;
      }
      el.innerHTML = `<div style="display:flex;flex-direction:column;gap:10px">
        ${lista.map(exp => {
          const colorEstado = exp.estado === 'EN_CURSO' ? 'var(--red)' : exp.estado === 'COMPLETADO' ? 'var(--green)' : 'var(--amber)';
          const emojiEstado = exp.estado === 'EN_CURSO' ? '🔴' : exp.estado === 'COMPLETADO' ? '✅' : '⏸️';
          const dias = Math.floor((Date.now() - new Date(exp.fechaApertura)) / (1000*60*60*24));
          return `
          <div style="background:var(--bg2);border:1.5px solid var(--border);border-radius:14px;padding:16px">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
              <div>
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                  <span style="font-size:12px;font-weight:700;color:var(--text3)">${exp.numero}</span>
                  <span style="background:${colorEstado}22;color:${colorEstado};border-radius:6px;padding:2px 8px;font-size:11px;font-weight:600">${emojiEstado} ${exp.estado.replace('_',' ')}</span>
                </div>
                <div style="font-size:15px;font-weight:700">${exp.clientName}</div>
                <div style="font-size:13px;color:var(--text2)">${exp.descripcion||'—'}</div>
              </div>
              <div style="text-align:right;font-size:12px;color:var(--text3)">
                <div>${exp.totalHoras||0} h acumuladas</div>
                <div>${dias} día${dias!==1?'s':''} abierto</div>
              </div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn bgh" style="font-size:11px;padding:5px 12px" onclick="CP.PartesAdmin.verExpediente('${exp._id}')">📁 Ver hilo completo</button>
              ${exp.estado === 'EN_CURSO' ? `
              <button class="btn bgh" style="font-size:11px;padding:5px 12px;color:var(--green);border-color:var(--green)" onclick="CP.PartesAdmin.cerrarExpediente('${exp._id}','${exp.clientName}')">✅ Cerrar expediente</button>
              <button class="btn bgh" style="font-size:11px;padding:5px 12px;color:var(--amber);border-color:var(--amber)" onclick="CP.PartesAdmin.pausarExpediente('${exp._id}')">⏸️ Pausar</button>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>`;
    } catch(err) {
      el.innerHTML = `<div style="color:var(--red);font-size:12px">Error: ${err.message}</div>`;
    }
  }

  async function verExpediente(id) {
    try {
      const exp = await api(`/api/expedientes/${id}`);
      showTab('expedientes', document.querySelector('.btab:nth-child(3)'));

      document.getElementById('exp-lista').innerHTML = `
        <button class="btn bgh" style="margin-bottom:14px" onclick="CP.PartesAdmin.loadExpedientes()">← Volver a la lista</button>
        <div style="background:var(--bg2);border:1.5px solid var(--border2);border-radius:14px;padding:20px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
            <div>
              <div style="font-size:12px;color:var(--text3);font-weight:700">${exp.numero}</div>
              <div style="font-size:17px;font-weight:700">${exp.clientName}</div>
              <div style="font-size:13px;color:var(--text2)">${exp.descripcion||'—'}</div>
            </div>
            <div style="text-align:right">
              <div style="font-size:13px;font-weight:700;color:var(--green)">${exp.totalHoras||0} h totales</div>
              <div style="font-size:12px;color:var(--text3)">${(exp.partes||[]).length} partes</div>
            </div>
          </div>

          <div style="font-size:12px;font-weight:700;color:var(--text3);text-transform:uppercase;margin-bottom:10px">Hilo de partes</div>
          <div style="display:flex;flex-direction:column;gap:8px">
            ${(exp.partes||[]).map((p,i) => {
              const etrab = ESTADOS_TRABAJO[p.estadoTrabajo] || ESTADOS_TRABAJO.completado;
              const ejor  = TIPOS_JORNADA[p.tipoJornada]    || TIPOS_JORNADA.NORMAL;
              return `
              <div style="background:var(--bg3);border-radius:10px;padding:14px;${i < (exp.partes.length-1) ? 'border-left:3px solid var(--border2);margin-left:8px;' : 'border-left:3px solid '+etrab.color+';margin-left:8px;'}">
                <div style="display:flex;justify-content:space-between;align-items:flex-start">
                  <div>
                    <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
                      <span style="font-size:13px;font-weight:600">${dt(p.date)}</span>
                      <span style="background:${etrab.color}22;color:${etrab.color};border-radius:6px;padding:1px 7px;font-size:10px;font-weight:600">${etrab.emoji} ${etrab.label}</span>
                      ${p.tipoJornada !== 'NORMAL' ? `<span style="background:${ejor.color}22;color:${ejor.color};border-radius:6px;padding:1px 7px;font-size:10px">${ejor.emoji} ${ejor.label}</span>` : ''}
                    </div>
                    <div style="font-size:13px;color:var(--text2)">${p.workerName}</div>
                    <div style="font-size:12px;color:var(--text3);margin-top:3px">${p.description||'—'}</div>
                    ${p.pendienteDetalle ? `<div style="font-size:12px;color:var(--red);margin-top:4px">🔴 Pendiente: ${p.pendienteDetalle}</div>` : ''}
                  </div>
                  <div style="text-align:right;font-size:12px;color:var(--text3)">
                    <div style="font-weight:600">${p.horas} h</div>
                    <button class="btn bgh" style="font-size:10px;padding:3px 8px;margin-top:6px" onclick="CP.PartesAdmin.openParte('${p._id}')">Ver →</button>
                  </div>
                </div>
              </div>`;
            }).join('')}
          </div>

          ${exp.estado === 'EN_CURSO' ? `
          <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border);display:flex;gap:8px">
            <button class="btn bp" style="color:var(--green);background:rgba(34,196,135,.15);border-color:var(--green)" onclick="CP.PartesAdmin.cerrarExpediente('${exp._id}','${exp.clientName}')">✅ Cerrar y preparar para facturar</button>
          </div>` : ''}
        </div>`;
    } catch(err) { alert('Error: ' + err.message); }
  }

  async function cerrarExpediente(id, clientName) {
    if (!confirm(`¿Cerrar el expediente de "${clientName}"? Se marcará como completado y listo para facturar.`)) return;
    try {
      const r = await api(`/api/expedientes/${id}/cerrar`, { method:'POST' });
      alert(`✅ Expediente cerrado. Total: ${r.totalHoras} horas en ${r.partes} partes.`);
      loadExpedientes();
    } catch(err) { alert('Error: ' + err.message); }
  }

  async function pausarExpediente(id) {
    try {
      await api(`/api/expedientes/${id}`, { method:'PUT', body: JSON.stringify({ estado: 'PAUSADO' }) });
      loadExpedientes();
    } catch(err) { alert('Error: ' + err.message); }
  }

  async function abrirModalExpediente(exp) {
    document.getElementById('exp-create-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'exp-create-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
    modal.innerHTML = `
      <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:16px;padding:24px;width:100%;max-width:480px">
        <div style="font-size:16px;font-weight:700;margin-bottom:16px">Nuevo expediente</div>
        <div style="margin-bottom:12px">
          <div style="font-size:11px;color:var(--text3);text-transform:uppercase;margin-bottom:4px">Cliente</div>
          <input type="text" id="exp-m-cliente" list="exp-clients-list" placeholder="Nombre del cliente..." style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--rs);padding:9px;color:var(--text);font-size:13px">
          <datalist id="exp-clients-list"></datalist>
        </div>
        <div style="margin-bottom:16px">
          <div style="font-size:11px;color:var(--text3);text-transform:uppercase;margin-bottom:4px">Descripción del trabajo</div>
          <textarea id="exp-m-desc" rows="3" placeholder="¿Qué trabajo incluye este expediente?" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--rs);padding:9px;color:var(--text);font-size:13px;font-family:inherit;resize:vertical"></textarea>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn bp" onclick="CP.PartesAdmin.crearExpediente()">📁 Crear expediente</button>
          <button class="btn bgh" onclick="document.getElementById('exp-create-modal').remove()">Cancelar</button>
        </div>
        <div id="exp-create-msg" style="margin-top:8px;font-size:12px;display:none"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });
    try {
      if (!window._cpClients) { window._cpClients = await api('/api/clients/list'); }
      const dl = document.getElementById('exp-clients-list');
      if (dl) dl.innerHTML = (window._cpClients||[]).map(n=>`<option value="${n}">`).join('');
    } catch(e) {}
  }

  async function crearExpediente() {
    const cliente = document.getElementById('exp-m-cliente')?.value?.trim() || '';
    const desc    = document.getElementById('exp-m-desc')?.value?.trim()    || '';
    const msg     = document.getElementById('exp-create-msg');
    if (!cliente) { if(msg){msg.textContent='⚠️ El cliente es obligatorio';msg.style.display='block';msg.style.color='var(--amber)';} return; }
    try {
      await api('/api/expedientes', { method:'POST', body: JSON.stringify({ clientName: cliente, descripcion: desc }) });
      document.getElementById('exp-create-modal').remove();
      loadExpedientes();
    } catch(err) {
      if(msg){msg.textContent='❌ '+err.message;msg.style.display='block';msg.style.color='var(--red)';}
    }
  }

  // ── EXTERNOS ADMIN ──────────────────────────────────────────────
  async function loadExternosAdmin() {
    const el = document.getElementById('externos-admin-lista');
    if (!el) return;
    try {
      const lista = await api('/api/externos');
      if (!lista.length) { el.innerHTML = '<div style="color:var(--text3);font-size:12px">No hay externos registrados</div>'; return; }
      el.innerHTML = `<table style="font-size:12px">
        <thead><tr><th>Nombre</th><th>Oficio</th><th>Teléfono</th><th></th></tr></thead>
        <tbody>${lista.map(e => `<tr>
          <td><strong>${e.nombre}</strong></td>
          <td style="color:var(--text2)">${e.oficio||'—'}</td>
          <td style="color:var(--text2)">${e.telefono||'—'}</td>
          <td><button class="btn bgh" style="font-size:10px;padding:3px 8px;color:var(--red);border-color:var(--red)" onclick="CP.PartesAdmin.borrarExterno('${e._id}','${e.nombre}')">🗑</button></td>
        </tr>`).join('')}</tbody>
      </table>`;
    } catch(e) { el.innerHTML = '<div style="color:var(--red);font-size:12px">Error cargando</div>'; }
  }

  function abrirModalExterno() {
    document.getElementById('ext-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'ext-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
    modal.innerHTML = `
      <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:16px;padding:24px;width:100%;max-width:400px">
        <div style="font-size:16px;font-weight:700;margin-bottom:16px">Nuevo externo / colaborador</div>
        <div style="margin-bottom:12px">
          <div style="font-size:11px;color:var(--text3);text-transform:uppercase;margin-bottom:4px">Nombre *</div>
          <input type="text" id="ext-m-nombre" placeholder="Nombre completo..." style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--rs);padding:9px;color:var(--text);font-size:13px">
        </div>
        <div style="margin-bottom:12px">
          <div style="font-size:11px;color:var(--text3);text-transform:uppercase;margin-bottom:4px">Oficio</div>
          <input type="text" id="ext-m-oficio" placeholder="Ej: Pintor, Electricista..." style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--rs);padding:9px;color:var(--text);font-size:13px">
        </div>
        <div style="margin-bottom:16px">
          <div style="font-size:11px;color:var(--text3);text-transform:uppercase;margin-bottom:4px">Teléfono</div>
          <input type="tel" id="ext-m-tel" placeholder="Opcional..." style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--rs);padding:9px;color:var(--text);font-size:13px">
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn bp" onclick="CP.PartesAdmin.guardarExterno()">💾 Guardar</button>
          <button class="btn bgh" onclick="document.getElementById('ext-modal').remove()">Cancelar</button>
        </div>
        <div id="ext-modal-msg" style="margin-top:8px;font-size:12px;display:none"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });
  }

  async function guardarExterno() {
    const nombre  = document.getElementById('ext-m-nombre')?.value?.trim() || '';
    const oficio  = document.getElementById('ext-m-oficio')?.value?.trim() || '';
    const telefono = document.getElementById('ext-m-tel')?.value?.trim()   || '';
    const msg     = document.getElementById('ext-modal-msg');
    if (!nombre) { if(msg){msg.textContent='⚠️ El nombre es obligatorio';msg.style.display='block';msg.style.color='var(--amber)';} return; }
    try {
      await api('/api/externos', { method:'POST', body: JSON.stringify({ nombre, oficio, telefono }) });
      document.getElementById('ext-modal').remove();
      loadExternosAdmin();
    } catch(err) {
      if(msg){msg.textContent='❌ '+err.message;msg.style.display='block';msg.style.color='var(--red)';}
    }
  }

  async function borrarExterno(id, nombre) {
    if (!confirm(`¿Eliminar a "${nombre}" de los externos?`)) return;
    try {
      await api(`/api/externos/${id}`, { method:'DELETE' });
      loadExternosAdmin();
    } catch(err) { alert('Error: ' + err.message); }
  }

  // ── FORM ADMIN NUEVO PARTE ──────────────────────────────────────
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
          <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Fecha</div>
          <input type="date" id="pa-new-date" value="${now}" style="width:100%;background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:var(--rs);padding:8px 10px;font-size:13px">
        </div>
      </div>
      <div style="margin-bottom:12px">
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Tipo jornada</div>
        <select id="pa-new-jornada" style="width:100%;background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:var(--rs);padding:8px 10px;font-size:13px">
          <option value="NORMAL">📅 Normal</option>
          <option value="EXTRA">⭐ Extra / Sábado</option>
          <option value="GUARDIA">🛡️ Guardia</option>
        </select>
      </div>
      <div style="margin-bottom:12px">
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Cliente / Obra</div>
        <input type="text" id="pa-new-client" list="pa-clients-list" placeholder="Buscar cliente..." style="width:100%;background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:var(--rs);padding:8px 10px;font-size:13px">
        <datalist id="pa-clients-list"></datalist>
      </div>
      <div style="margin-bottom:12px">
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Descripción</div>
        <textarea id="pa-new-desc" rows="3" placeholder="Qué se hizo..." style="width:100%;background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:var(--rs);padding:8px 10px;font-size:13px;resize:vertical;font-family:'Inter',sans-serif"></textarea>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <div>
          <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Horas</div>
          <input type="number" id="pa-new-horas" value="8" min="0.5" max="16" step="0.5" style="width:100%;background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:var(--rs);padding:8px 10px;font-size:13px">
        </div>
        <div>
          <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Estado trabajo</div>
          <select id="pa-new-estado-trabajo" style="width:100%;background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:var(--rs);padding:8px 10px;font-size:13px">
            <option value="completado">✅ Completado</option>
            <option value="continua">🔴 Continúa otro día</option>
            <option value="parcial">🟡 Parcial</option>
          </select>
        </div>
      </div>
      <div style="margin-bottom:12px">
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Notas internas</div>
        <input type="text" id="pa-new-notas" placeholder="Notas..." style="width:100%;background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:var(--rs);padding:8px 10px;font-size:13px">
      </div>`;
  }

  async function loadClientsSuggestions() {
    const dl = document.getElementById('pa-clients-list');
    if (!dl) return;
    try {
      if (!window._cpClients) { window._cpClients = await api('/api/clients/list'); }
      dl.innerHTML = (window._cpClients||[]).map(n=>`<option value="${n}">`).join('');
    } catch(e) {}
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
    const workerSel  = document.getElementById('pa-new-worker');
    const workerId   = workerSel?.value;
    const workerName = workerSel?.options[workerSel.selectedIndex]?.dataset.name || '';
    const date       = document.getElementById('pa-new-date')?.value;
    const clientName = document.getElementById('pa-new-client')?.value?.trim() || '';
    const description = document.getElementById('pa-new-desc')?.value?.trim()  || '';
    const horas      = parseFloat(document.getElementById('pa-new-horas')?.value || 8);
    const tipoJornada = document.getElementById('pa-new-jornada')?.value || 'NORMAL';
    const estadoTrabajo = document.getElementById('pa-new-estado-trabajo')?.value || 'completado';
    const notas      = document.getElementById('pa-new-notas')?.value?.trim() || '';
    const msg        = document.getElementById('pa-form-msg');

    if (!date || !clientName) {
      if (msg) { msg.textContent='⚠️ Fecha y cliente son obligatorios'; msg.style.display='block'; msg.style.color='var(--amber)'; }
      return;
    }
    try {
      await api('/api/partes', { method:'POST', body: JSON.stringify({ workerId, workerName, date, clientName, description, horas, tipoJornada, estadoTrabajo, notas, materiales:[], status:'verificado' }) });
      if (msg) { msg.textContent='✅ Parte guardado'; msg.style.display='block'; msg.style.color='var(--green)'; }
      setTimeout(() => resetForm(), 1500);
      loadLista();
    } catch(err) {
      if (msg) { msg.textContent='❌ Error: '+err.message; msg.style.display='block'; msg.style.color='var(--red)'; }
    }
  }

  function resetForm() {
    ['pa-new-date','pa-new-client','pa-new-desc','pa-new-notas'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = id === 'pa-new-date' ? new Date().toISOString().slice(0,10) : '';
    });
    const el = document.getElementById('pa-new-horas'); if (el) el.value = '8';
    const msg = document.getElementById('pa-form-msg'); if (msg) msg.style.display = 'none';
  }

  async function loadFacturacion() {
    const from = document.getElementById('pa-fac-from')?.value || '';
    const to   = document.getElementById('pa-fac-to')?.value   || '';
    const el   = document.getElementById('pa-facturacion');
    if (!el) return;
    el.innerHTML = '<div style="color:var(--text3);font-size:12px">Cargando...</div>';
    try {
      const params = new URLSearchParams({ from, to });
      const data   = await api(`/api/partes/resumen/facturacion?${params}`);
      if (!data.length) { el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:10px">No hay partes en este período.</div>'; return; }
      const totalHoras = data.reduce((s,c)=>s+c.horas,0);
      el.innerHTML = `
        <div class="metrics-row" style="margin-bottom:14px">
          <div class="mc"><div class="ml">Clientes</div><div class="mv b">${data.length}</div></div>
          <div class="mc"><div class="ml">Total partes</div><div class="mv b">${data.reduce((s,c)=>s+c.partes,0)}</div></div>
          <div class="mc"><div class="ml">Total horas</div><div class="mv g">${totalHoras.toFixed(1)} h</div></div>
          <div class="mc"><div class="ml">Pendientes verificar</div><div class="mv a">${data.reduce((s,c)=>s+c.pendiente,0)}</div></div>
        </div>
        <div class="card">
          <table>
            <thead><tr><th>Cliente</th><th style="text-align:right">Partes</th><th style="text-align:right">Horas</th><th>Trabajadores</th><th style="text-align:right">✅</th><th style="text-align:right">⏳</th></tr></thead>
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
    } catch(err) {
      el.innerHTML = `<div style="color:var(--red);font-size:12px">Error: ${err.message}</div>`;
    }
  }

  window.togglePin = function(wid) {
    const pins = { jose:'1234', diego:'2345', abdellah:'3456', mamadou:'4567', paula:'5678' };
    const el = document.getElementById('pin-' + wid);
    if (!el) return;
    el.textContent = el.textContent === '••••' ? (pins[wid]||'????') : '••••';
  };

  CP.PartesAdmin = {
    render, showTab, applyFilters, clearFilters, goPage,
    openParte, updateStatus, saveParteChanges, deleteParte,
    addMatRow, submitParte, resetForm, loadFacturacion,
    loadAsignaciones, abrirModalAsignacion, guardarAsignacion, borrarAsignacion,
    loadExpedientes, verExpediente, cerrarExpediente, pausarExpediente,
    abrirModalExpediente, crearExpediente,
    loadExternosAdmin, abrirModalExterno, guardarExterno, borrarExterno,
  };

})(window.CP = window.CP || {});
