// modules/partes-admin.js — Vista admin de partes, asignaciones y expedientes
(function(CP) {
  'use strict';

  // ── Todo desde config central ─────────────────────────────────
  const ESTADOS         = window.CP_CONFIG.estadosPartes;
  const ESTADOS_TRABAJO = window.CP_CONFIG.estadosTrabajo;
  const TIPOS_JORNADA   = window.CP_CONFIG.tiposJornada;

  // WORKERS se lee siempre de CP_CONFIG.workers (cargados al init)
  function getWorkers() { return window.CP_CONFIG.workers; }

  let currentPage = 0;
  const PAGE = 20;
  let filters = { workerId:'', clientName:'', status:'', from:'', to:'' };

  function dt(d){ return d ? new Date(d).toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'}) : '—'; }
  function dtFull(d){ return d ? new Date(d).toLocaleString('es-ES') : '—'; }

  async function api(url, opts={}) {
    const tok = localStorage.getItem('cp_token');
    const r = await fetch(url, { ...opts, headers:{ 'Authorization':`Bearer ${tok}`, 'Content-Type':'application/json', ...(opts.headers||{}) } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  function mostrarMsg(id, texto, tipo) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = texto;
    el.style.display = 'block';
    el.style.color = tipo === 'ok' ? 'var(--green)' : tipo === 'warn' ? 'var(--amber)' : 'var(--red)';
    if (tipo !== 'error') setTimeout(() => el.style.display = 'none', 2500);
  }

  // ── RENDER PRINCIPAL ────────────────────────────────────────────
  function render(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const WORKERS = getWorkers();
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
              <span class="field-label">Trabajador</span>
              <select id="pa-f-worker" onchange="CP.PartesAdmin.applyFilters()">
                <option value="">Todos</option>
                ${WORKERS.map(w=>`<option value="${w.id}">${w.name}</option>`).join('')}
              </select>
            </div>
            <div>
              <span class="field-label">Estado</span>
              <select id="pa-f-status" onchange="CP.PartesAdmin.applyFilters()">
                <option value="">Todos</option>
                ${Object.entries(ESTADOS).map(([k,v])=>`<option value="${k}">${v.emoji} ${v.label}</option>`).join('')}
              </select>
            </div>
            <div>
              <span class="field-label">Cliente</span>
              <input type="text" id="pa-f-client" placeholder="Buscar..." class="srch" style="width:160px" oninput="CP.PartesAdmin.applyFilters()">
            </div>
            <div>
              <span class="field-label">Desde</span>
              <input type="date" id="pa-f-from" class="srch" style="width:135px" onchange="CP.PartesAdmin.applyFilters()">
            </div>
            <div>
              <span class="field-label">Hasta</span>
              <input type="date" id="pa-f-to" class="srch" style="width:135px" onchange="CP.PartesAdmin.applyFilters()">
            </div>
            <button class="btn bgh" onclick="CP.PartesAdmin.clearFilters()">Limpiar</button>
          </div>
        </div>
        <div id="pa-metrics" class="metrics-row" style="margin-bottom:14px"></div>
        <div class="card">
          <div class="card-title">Partes de trabajo <span id="pa-count" style="font-weight:400;color:var(--text3)">—</span></div>
          <div id="pa-lista">Cargando...</div>
          <div id="pa-pagination" style="margin-top:10px"></div>
        </div>
      </div>

      <!-- ASIGNACIONES -->
      <div id="pa-tab-asignaciones" class="p-tab" style="display:none">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px">
          <input type="date" id="asig-fecha" onchange="CP.PartesAdmin.loadAsignaciones()"
            style="background:var(--bg3);border:1px solid var(--border2);border-radius:var(--rs);padding:8px 12px;color:var(--text);font-size:13px">
          <button class="btn bp" onclick="CP.PartesAdmin.abrirModalAsignacion(null)">+ Nueva asignación</button>
        </div>
        <div id="asig-planning"><div class="empty"><div class="ei">📅</div><div class="et">Selecciona una fecha</div></div></div>
      </div>

      <!-- EXPEDIENTES -->
      <div id="pa-tab-expedientes" class="p-tab" style="display:none">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px">
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <select id="exp-f-estado" onchange="CP.PartesAdmin.loadExpedientes()">
              <option value="">Todos</option>
              <option value="EN_CURSO" selected>🔴 En curso</option>
              <option value="COMPLETADO">✅ Completados</option>
              <option value="PAUSADO">⏸️ Pausados</option>
            </select>
            <input type="text" id="exp-f-cliente" placeholder="Filtrar cliente..." class="srch" style="width:180px" oninput="CP.PartesAdmin.loadExpedientes()">
          </div>
          <button class="btn bp" onclick="CP.PartesAdmin.abrirModalExpediente()">+ Nuevo expediente</button>
        </div>
        <div id="exp-lista"><div class="empty"><div class="ei">📁</div><div class="et">Cargando...</div></div></div>
      </div>

      <!-- FACTURACIÓN -->
      <div id="pa-tab-facturacion" class="p-tab" style="display:none">
        <div class="alert ain" style="margin-bottom:14px"><div>💰</div><div><strong>Resumen para facturación</strong> — partes verificados y pendientes agrupados por cliente.</div></div>
        <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:flex-end">
          <div><span class="field-label">Desde</span><input type="date" id="pa-fac-from" class="srch" style="width:145px"></div>
          <div><span class="field-label">Hasta</span><input type="date" id="pa-fac-to" class="srch" style="width:145px"></div>
          <button class="btn bp" onclick="CP.PartesAdmin.loadFacturacion()">Ver resumen</button>
        </div>
        <div id="pa-facturacion"><div class="empty"><div class="et">Selecciona un período</div></div></div>
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
        <div class="alert ain" style="margin-bottom:14px"><div>🔑</div><div><strong>Acceso de trabajadores</strong> — entran con PIN en <strong>/parte</strong></div></div>
        <div class="g2">
          <div class="card">
            <div class="card-title">Externos / colaboradores</div>
            <div id="externos-admin-lista"><div class="empty"><div class="et">Cargando...</div></div></div>
            <button class="btn bp" style="margin-top:10px" onclick="CP.PartesAdmin.abrirModalExterno()">+ Añadir externo</button>
          </div>
        </div>
      </div>`;

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
    if (id === 'lista')        loadLista();
    if (id === 'asignaciones') loadAsignaciones();
    if (id === 'expedientes')  loadExpedientes();
    if (id === 'nuevo')        loadClientsSuggestions();
    if (id === 'accesos')      loadExternosAdmin();
  }

  // ── LISTA PARTES ────────────────────────────────────────────────
  function applyFilters() {
    filters.workerId   = document.getElementById('pa-f-worker')?.value || '';
    filters.clientName = document.getElementById('pa-f-client')?.value || '';
    filters.status     = document.getElementById('pa-f-status')?.value || '';
    filters.from       = document.getElementById('pa-f-from')?.value   || '';
    filters.to         = document.getElementById('pa-f-to')?.value     || '';
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
        const pend     = data.partes.filter(p => p.status === 'pendiente').length;
        const ver      = data.partes.filter(p => p.status === 'verificado').length;
        const horas    = data.partes.reduce((s,p) => s + (p.horas||0), 0);
        const continua = data.partes.filter(p => p.estadoTrabajo === 'continua').length;
        metrics.innerHTML = `
          <div class="mc"><div class="ml">Total partes</div><div class="mv b">${data.total}</div></div>
          <div class="mc"><div class="ml">Pendientes</div><div class="mv a">${pend}</div></div>
          <div class="mc"><div class="ml">Verificados</div><div class="mv g">${ver}</div></div>
          <div class="mc"><div class="ml">Horas</div><div class="mv b">${horas.toFixed(1)} h</div></div>
          ${continua > 0 ? `<div class="mc"><div class="ml">Continúan otro día</div><div class="mv r">${continua}</div></div>` : ''}`;
      }

      if (!data.partes?.length) {
        el.innerHTML = '<div class="empty"><div class="ei">📋</div><div class="et">No hay partes con estos filtros</div></div>';
        return;
      }

      const grupos = {
        pendiente:  data.partes.filter(p => p.status === 'pendiente'),
        incidencia: data.partes.filter(p => p.status === 'incidencia'),
        verificado: data.partes.filter(p => p.status === 'verificado'),
        facturado:  data.partes.filter(p => p.status === 'facturado'),
      };

      const renderRow = (p) => {
        const est   = ESTADOS[p.status]               || ESTADOS.pendiente;
        const etrab = ESTADOS_TRABAJO[p.estadoTrabajo] || null;
        const ejor  = TIPOS_JORNADA[p.tipoJornada]    || null;
        const enviado = p._meta?.submittedAt
          ? new Date(p._meta.submittedAt).toLocaleString('es-ES',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})
          : '—';
        const dateMatch = p.date === (p._meta?.submittedAt?.slice?.(0,10) || p.date);
        return `<tr style="${p.estadoTrabajo==='continua'?'background:rgba(240,82,82,.03)':''}">
          <td>
            ${dt(p.date)}
            ${!dateMatch ? '<span title="Fecha declarada difiere del envío" style="color:var(--amber);font-size:10px"> ⚠️</span>' : ''}
          </td>
          <td>
            ${p.workerName}
            ${p.generadoAuto ? '<div style="font-size:9px;color:var(--text3)">🤖 auto</div>' : ''}
          </td>
          <td>
            <strong>${p.clientName||'—'}</strong>
            ${p.description ? `<div style="font-size:10px;color:var(--text3)">${p.description.slice(0,40)}${p.description.length>40?'...':''}</div>` : ''}
            ${p.equipo?.length > 1 ? `<div style="font-size:10px;color:var(--blue)">👥 ${p.equipo.length} personas</div>` : ''}
            ${p.expedienteId ? '<div style="font-size:10px;color:var(--amber)">📁 Expediente</div>' : ''}
          </td>
          <td style="text-align:right">${p.horas} h</td>
          <td>
            <span class="badge" style="background:${est.color}22;color:${est.color}">${est.emoji} ${est.label}</span>
            ${etrab && p.estadoTrabajo !== 'completado' ? `<div style="margin-top:3px"><span class="etrab ${p.estadoTrabajo}">${etrab.emoji} ${etrab.label}</span></div>` : ''}
            ${ejor && p.tipoJornada !== 'NORMAL' ? `<div style="margin-top:2px"><span class="jornada ${p.tipoJornada}">${ejor.emoji} ${ejor.label}</span></div>` : ''}
          </td>
          <td style="font-size:10px;color:var(--text3)">${enviado}</td>
          <td>
            <div style="display:flex;gap:4px">
              <button class="btn bgh" style="padding:3px 8px;font-size:11px" onclick="CP.PartesAdmin.openParte('${p._id}')">Ver →</button>
              <button class="btn bgh" style="padding:3px 8px;font-size:11px;color:var(--red);border-color:var(--red)" onclick="CP.PartesAdmin.deleteParte('${p._id}','${(p.clientName||'parte').replace(/'/g,"\\'")}')">🗑</button>
            </div>
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
          <td colspan="7" style="background:${est.color}18;color:${est.color};font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;padding:8px 10px;border-top:2px solid ${est.color}44">
            ${sectionLabels[status]} <span style="font-weight:400;opacity:.7">(${partes.length})</span>
          </td></tr>`;

        // Dentro de cada estado: agrupar por día + trabajador (más reciente primero)
        const ordenados = [...partes].sort((a, b) =>
          (b.date || '').localeCompare(a.date || '') || (a.workerName || '').localeCompare(b.workerName || ''));
        let claveAnterior = null;
        ordenados.forEach(p => {
          const clave = `${p.date}|${p.workerName}`;
          if (clave !== claveAnterior) {
            const n = ordenados.filter(x => `${x.date}|${x.workerName}` === clave).length;
            rows += `<tr><td colspan="7" style="background:var(--bg2);color:var(--text3);font-size:11px;font-weight:600;padding:5px 10px 5px 18px">
              📅 ${dt(p.date)} — ${p.workerName}${n > 1 ? ` <span style="font-weight:400;opacity:.7">(${n} partes)</span>` : ''}
            </td></tr>`;
            claveAnterior = clave;
          }
          rows += renderRow(p);
        });
      });

      el.innerHTML = `<table>
        <thead><tr>
          <th style="width:85px">Fecha</th>
          <th style="width:110px">Trabajador</th>
          <th>Cliente / Obra</th>
          <th style="text-align:right;width:55px">Horas</th>
          <th style="width:160px">Estados</th>
          <th style="width:75px">Enviado</th>
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
    } catch(err) {
      el.innerHTML = `<div style="color:var(--red);font-size:12px;padding:10px">Error: ${err.message}</div>`;
    }
  }

  // ── DETALLE PARTE ───────────────────────────────────────────────
  async function openParte(id) {
    try {
      const p     = await api(`/api/partes/${id}`);
      const est   = ESTADOS[p.status]               || ESTADOS.pendiente;
      const etrab = ESTADOS_TRABAJO[p.estadoTrabajo] || null;
      const ejor  = TIPOS_JORNADA[p.tipoJornada]    || null;
      const gps   = p._meta?.gpsLat ? `${p._meta.gpsLat.toFixed(5)}, ${p._meta.gpsLng.toFixed(5)}` : 'No disponible';
      const mapsUrl = p._meta?.gpsLat ? `https://maps.google.com/?q=${p._meta.gpsLat},${p._meta.gpsLng}` : null;

      document.getElementById('pa-detail-modal')?.remove();
      const modal = document.createElement('div');
      modal.id = 'pa-detail-modal';
      modal.className = 'modal-overlay';

      modal.innerHTML = `
        <div class="modal-box" style="max-width:600px">
          <div class="modal-header">
            <div>
              <div style="font-weight:600;font-size:15px">${p.workerName} — ${p.clientName||'Sin cliente'}</div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:5px">
                <span style="font-size:12px;color:var(--text3)">${dt(p.date)}</span>
                ${ejor && p.tipoJornada !== 'NORMAL' ? `<span class="jornada ${p.tipoJornada}">${ejor.emoji} ${ejor.label}</span>` : ''}
                ${etrab ? `<span class="etrab ${p.estadoTrabajo}">${etrab.emoji} ${etrab.label}</span>` : ''}
                ${p.expedienteId ? '<span class="badge" style="background:var(--amber-bg);color:var(--amber)">📁 Expediente</span>' : ''}
                ${p.generadoAuto ? '<span class="badge bbl">🤖 Auto-generado</span>' : ''}
              </div>
            </div>
            <button class="modal-close" onclick="document.getElementById('pa-detail-modal').remove()">✕</button>
          </div>

          ${p.equipo?.length > 1 ? `
          <div class="alert ain" style="margin-bottom:12px">
            <div>👥</div>
            <div>
              <strong>Equipo de trabajo</strong>
              <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:6px">
                ${p.equipo.map(m => `<span class="equipo-chip ${m.tipo==='externo'?'externo':''} selected" style="cursor:default;font-size:11px">
                  ${m.esResponsable?'👷':'👤'} ${m.nombre}
                  ${m.tipo==='externo'?'<span style="font-size:10px;opacity:.7">(ext.)</span>':''}
                  ${m.esResponsable?'<span style="font-size:10px;color:var(--amber)">★</span>':''}
                </span>`).join('')}
              </div>
            </div>
          </div>` : ''}

          ${(p.estadoTrabajo === 'continua' || p.estadoTrabajo === 'parcial') && p.pendienteDetalle ? `
          <div class="alert ada" style="margin-bottom:12px">
            <div>🔴</div>
            <div><strong>Qué queda por hacer</strong><br>${p.pendienteDetalle}</div>
          </div>` : ''}

          ${p.estadoTrabajo === 'material' && p.materialDetalle ? `
          <div class="alert apu" style="margin-bottom:12px">
            <div>📦</div>
            <div><strong>Material necesario</strong><br>${p.materialDetalle}</div>
          </div>` : ''}

          <div class="card" style="margin-bottom:12px">
            <div class="card-title">Datos del parte</div>
            <table style="font-size:12px">
              <tr><td style="color:var(--text2);width:130px">Descripción</td><td>${p.description||'—'}</td></tr>
              <tr><td style="color:var(--text2)">Horas</td><td>${p.horas} h</td></tr>
              <tr><td style="color:var(--text2)">Notas trabajador</td><td>${p.notas||'—'}</td></tr>
            </table>
            ${p.materiales?.length ? `
              <div style="margin-top:10px;font-size:10px;color:var(--text3);text-transform:uppercase;font-weight:600;margin-bottom:4px">Materiales</div>
              <table style="font-size:12px">
                <thead><tr><th>Material</th><th style="text-align:right">Cant.</th><th style="text-align:right">€/ud</th><th style="text-align:right">Total</th></tr></thead>
                <tbody>${p.materiales.map(m=>`<tr>
                  <td>${m.nombre||'—'}</td>
                  <td style="text-align:right">${m.cantidad||0}</td>
                  <td style="text-align:right">${m.precio||0}€</td>
                  <td style="text-align:right">${((m.cantidad||0)*(m.precio||0)).toFixed(2)}€</td>
                </tr>`).join('')}</tbody>
              </table>` : ''}
          </div>

          ${(p._meta?.fotosTrabajo?.length || p._meta?.fotosAlbaran?.length) ? `
          <div class="card" style="margin-bottom:12px">
            ${p._meta.fotosTrabajo?.length ? `
              <div class="card-title">📸 Fotos trabajo (${p._meta.fotosTrabajo.length})</div>
              <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:6px;margin-bottom:10px">
                ${p._meta.fotosTrabajo.map(src=>`<img src="${src}" onclick="window.open('${src}','_blank')" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;border:1px solid var(--border);cursor:pointer">`).join('')}
              </div>` : ''}
            ${p._meta.fotosAlbaran?.length ? `
              <div class="card-title">🧾 Albaranes (${p._meta.fotosAlbaran.length})</div>
              <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:6px">
                ${p._meta.fotosAlbaran.map(src=>`<img src="${src}" onclick="window.open('${src}','_blank')" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;border:1px solid var(--border);cursor:pointer">`).join('')}
              </div>` : ''}
          </div>` : ''}

          <div class="card" style="margin-bottom:12px;border-color:rgba(77,156,248,.2)">
            <div class="card-title" style="color:var(--blue)">🔒 Control admin</div>
            <table style="font-size:11px">
              <tr><td style="color:var(--text2);width:130px">Envío real</td><td>${dtFull(p._meta?.submittedAt)}</td></tr>
              <tr><td style="color:var(--text2)">Enviado por</td><td>${p._meta?.submittedBy==='worker'?'👷 Trabajador':p._meta?.submittedBy==='auto'?'🤖 Sistema':'👔 Admin'}</td></tr>
              <tr><td style="color:var(--text2)">GPS</td><td>${mapsUrl?`<a href="${mapsUrl}" target="_blank" style="color:var(--blue)">${gps} →</a>`:gps}</td></tr>
              ${p._meta?.gpsAccuracy?`<tr><td style="color:var(--text2)">Precisión</td><td>±${p._meta.gpsAccuracy.toFixed(0)}m</td></tr>`:''}
            </table>
          </div>

          <div style="margin-bottom:14px">
            <span class="field-label">Estado revisión</span>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
              ${Object.entries(ESTADOS).map(([k,v])=>`
                <button onclick="CP.PartesAdmin.updateStatus('${p._id}','${k}')"
                  style="background:${p.status===k?v.color+'33':'var(--bg3)'};border:1px solid ${p.status===k?v.color:'var(--border2)'};border-radius:8px;padding:6px 12px;cursor:pointer;color:var(--text);font-size:11px;font-family:'Inter',sans-serif">
                  ${v.emoji} ${v.label}
                </button>`).join('')}
            </div>
          </div>

          <div class="field-row">
            <span class="field-label">Notas admin</span>
            <textarea id="pa-admin-notes-${p._id}" rows="2" class="field-input" style="resize:vertical">${p.adminNotes||''}</textarea>
          </div>
          <div class="field-row">
            <span class="field-label">Referencia factura</span>
            <input type="text" id="pa-factura-ref-${p._id}" value="${p.facturaRef||''}" placeholder="FAC00892" class="field-input" style="width:220px">
          </div>

          ${p.expedienteId ? `
          <div style="margin-bottom:14px">
            <button class="btn bgh" onclick="CP.PartesAdmin.verExpediente('${p.expedienteId}');document.getElementById('pa-detail-modal').remove()">
              📁 Ver expediente completo →
            </button>
          </div>` : ''}

          <div class="modal-footer">
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
    try {
      await api(`/api/partes/${id}`, { method:'PUT', body: JSON.stringify({ adminNotes: notes, facturaRef }) });
      mostrarMsg(`pa-detail-msg-${id}`, '✅ Guardado', 'ok');
      loadLista();
    } catch(err) { mostrarMsg(`pa-detail-msg-${id}`, '❌ ' + err.message, 'error'); }
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
    el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:10px">Cargando...</div>';
    try {
      const lista = await api(`/api/asignaciones/dia/${fecha}`);
      if (!lista.length) {
        el.innerHTML = `<div class="empty"><div class="ei">📅</div><div class="et">No hay asignaciones para este día</div>
          <button class="btn bp" style="margin-top:14px" onclick="CP.PartesAdmin.abrirModalAsignacion(null)">+ Crear asignación</button></div>`;
        return;
      }
      const extrasCount = lista.filter(a => a.tipoJornada === 'EXTRA').length;
      el.innerHTML = `
        <div style="display:flex;gap:8px;margin-bottom:14px;font-size:12px;color:var(--text3)">
          <span>${lista.length} trabajo${lista.length>1?'s':''}</span>
          ${extrasCount ? `<span style="color:var(--amber)">· ${extrasCount} extra</span>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:12px">
          ${lista.map(a => {
            const cls = a.tipoJornada === 'EXTRA' ? 'extra' : a.tipoJornada === 'GUARDIA' ? 'guardia' : '';
            const jor = TIPOS_JORNADA[a.tipoJornada] || TIPOS_JORNADA.NORMAL;
            const responsable = a.equipo?.find(m => m.esResponsable);
            const resto = a.equipo?.filter(m => !m.esResponsable) || [];
            return `
            <div class="asig-card ${cls}">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
                <div>
                  <div style="font-size:15px;font-weight:700;margin-bottom:2px">${a.clientName}</div>
                  <div style="font-size:13px;color:var(--text2)">${a.descripcion||'—'}</div>
                </div>
                <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
                  <span class="jornada ${a.tipoJornada}">${jor.emoji} ${jor.label}</span>
                  ${a.horaInicio ? `<span style="font-size:12px;color:var(--text3)">${a.horaInicio}${a.horaFin?' – '+a.horaFin:''}</span>` : ''}
                </div>
              </div>
              <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">
                ${responsable ? `<span class="equipo-chip selected" style="cursor:default">👷 ${responsable.nombre}</span>` : ''}
                ${resto.map(m => `<span class="equipo-chip ${m.tipo==='externo'?'externo selected':'selected'}" style="cursor:default">
                  👤 ${m.nombre}${m.tipo==='externo'?' <span style="font-size:10px;opacity:.7">(ext.)</span>':''}
                </span>`).join('')}
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
    let workers = [], externos = [];
    try { workers  = await api('/api/partes/workers'); } catch(e) {}
    try { externos = await api('/api/externos'); }        catch(e) {}

    const fecha = document.getElementById('asig-fecha')?.value || new Date().toISOString().slice(0,10);
    const equipoActual = asig?.equipo || [];

    document.getElementById('asig-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'asig-modal';
    modal.className = 'modal-overlay';

    modal.innerHTML = `
      <div class="modal-box" style="max-width:580px">
        <div class="modal-header">
          <div class="modal-title">${asig ? 'Editar asignación' : 'Nueva asignación'}</div>
          <button class="modal-close" onclick="document.getElementById('asig-modal').remove()">✕</button>
        </div>

        <div class="field-grid-2">
          <div>
            <span class="field-label">Fecha</span>
            <input type="date" id="asig-m-fecha" value="${asig?.fecha||fecha}" class="field-input">
          </div>
          <div>
            <span class="field-label">Tipo jornada</span>
            <select id="asig-m-jornada" class="field-input">
              ${Object.entries(TIPOS_JORNADA).map(([k,v])=>
                `<option value="${k}" ${(asig?.tipoJornada||'NORMAL')===k?'selected':''}>${v.emoji} ${v.label}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <div class="field-grid-2">
          <div>
            <span class="field-label">Hora inicio</span>
            <input type="time" id="asig-m-hinicio" value="${asig?.horaInicio||''}" class="field-input">
          </div>
          <div>
            <span class="field-label">Hora fin</span>
            <input type="time" id="asig-m-hfin" value="${asig?.horaFin||''}" class="field-input">
          </div>
        </div>

        <div class="field-row">
          <span class="field-label">Cliente / Obra</span>
          <input type="text" id="asig-m-cliente" list="asig-clients-list" value="${asig?.clientName||''}" placeholder="Nombre del cliente..." class="field-input">
          <datalist id="asig-clients-list"></datalist>
        </div>

        <div class="field-row">
          <span class="field-label">Descripción del trabajo</span>
          <textarea id="asig-m-desc" rows="2" class="field-input" style="resize:vertical">${asig?.descripcion||''}</textarea>
        </div>

        <div class="field-row">
          <span class="field-label">Equipo — plantilla</span>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px" id="asig-m-workers">
            ${workers.map(w => {
              const miembro = equipoActual.find(m => m.id === String(w.id));
              return `<button type="button" class="equipo-chip-modal${miembro?' chip-sel':''}" data-id="${w.id}" data-nombre="${w.name}" data-tipo="plantilla" onclick="toggleChipModal(this)">
                ${w.name.split(' ')[0]}
                ${miembro?.esResponsable?'<span style="color:var(--amber);font-size:10px"> ★</span>':''}
              </button>`;
            }).join('')}
          </div>
        </div>

        ${externos.length > 0 ? `
        <div class="field-row">
          <span class="field-label">Equipo — externos</span>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px">
            ${externos.map(e => {
              const sel = equipoActual.some(m => m.id === String(e._id));
              return `<button type="button" class="equipo-chip-modal${sel?' chip-sel':''}" data-id="${e._id}" data-nombre="${e.nombre}" data-tipo="externo" onclick="toggleChipModal(this)">
                👤 ${e.nombre}
              </button>`;
            }).join('')}
          </div>
        </div>` : ''}

        <div class="field-row">
          <span class="field-label">Responsable principal</span>
          <select id="asig-m-responsable" class="field-input" style="width:auto">
            ${workers.map(w => `<option value="${w.id}" ${equipoActual.find(m=>m.id===String(w.id)&&m.esResponsable)?'selected':''}>${w.name}</option>`).join('')}
          </select>
        </div>

        <div class="field-row">
          <span class="field-label">Notas</span>
          <input type="text" id="asig-m-notas" value="${asig?.notas||''}" placeholder="Observaciones..." class="field-input">
        </div>

        <div class="modal-footer">
          <button class="btn bp" onclick="CP.PartesAdmin.guardarAsignacion('${asig?._id||''}')">💾 Guardar</button>
          <button class="btn bgh" onclick="document.getElementById('asig-modal').remove()">Cancelar</button>
        </div>
        <div id="asig-modal-msg" style="margin-top:8px;font-size:12px;display:none"></div>
      </div>`;

    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });

    try {
      if (!window._cpClients) window._cpClients = await api('/api/clients/list');
      const dl = document.getElementById('asig-clients-list');
      if (dl) dl.innerHTML = (window._cpClients||[]).map(n=>`<option value="${n}">`).join('');
    } catch(e) {}
  }

  window.toggleChipModal = function(btn) {
    btn.classList.toggle('chip-sel');
  };

  async function guardarAsignacion(id) {
    const fecha   = document.getElementById('asig-m-fecha')?.value;
    const jornada = document.getElementById('asig-m-jornada')?.value || 'NORMAL';
    const hinicio = document.getElementById('asig-m-hinicio')?.value || '';
    const hfin    = document.getElementById('asig-m-hfin')?.value   || '';
    const cliente = document.getElementById('asig-m-cliente')?.value?.trim() || '';
    const desc    = document.getElementById('asig-m-desc')?.value?.trim()    || '';
    const notas   = document.getElementById('asig-m-notas')?.value?.trim()   || '';
    const respId  = document.getElementById('asig-m-responsable')?.value     || '';

    if (!fecha || !cliente) { mostrarMsg('asig-modal-msg', '⚠️ Fecha y cliente son obligatorios', 'warn'); return; }

    const equipo = [];
    document.querySelectorAll('.equipo-chip-modal.chip-sel').forEach(btn => {
      equipo.push({ id: btn.dataset.id, nombre: btn.dataset.nombre, tipo: btn.dataset.tipo, esResponsable: btn.dataset.id === respId });
    });

    try {
      const data = { fecha, tipoJornada: jornada, horaInicio: hinicio, horaFin: hfin, clientName: cliente, descripcion: desc, equipo, notas };
      if (id) {
        await api(`/api/asignaciones/${id}`, { method:'PUT', body: JSON.stringify(data) });
      } else {
        await api('/api/asignaciones', { method:'POST', body: JSON.stringify(data) });
      }
      document.getElementById('asig-modal').remove();
      const fechaInput = document.getElementById('asig-fecha');
      if (fechaInput) fechaInput.value = fecha;
      loadAsignaciones();
    } catch(err) { mostrarMsg('asig-modal-msg', '❌ ' + err.message, 'error'); }
  }

  async function borrarAsignacion(id) {
    if (!confirm('¿Eliminar esta asignación?')) return;
    try { await api(`/api/asignaciones/${id}`, { method:'DELETE' }); loadAsignaciones(); }
    catch(err) { alert('Error: ' + err.message); }
  }

  // ── EXPEDIENTES ─────────────────────────────────────────────────
  async function loadExpedientes() {
    const estado  = document.getElementById('exp-f-estado')?.value  || '';
    const cliente = document.getElementById('exp-f-cliente')?.value || '';
    const el      = document.getElementById('exp-lista');
    if (!el) return;
    el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:10px">Cargando...</div>';
    try {
      const params = new URLSearchParams({ estado, clientName: cliente });
      const lista  = await api(`/api/expedientes?${params}`);
      if (!lista.length) {
        el.innerHTML = '<div class="empty"><div class="ei">📁</div><div class="et">No hay expedientes</div></div>';
        return;
      }
      el.innerHTML = `<div style="display:flex;flex-direction:column;gap:10px">
        ${lista.map(exp => {
          const dias = Math.floor((Date.now() - new Date(exp.fechaApertura)) / (1000*60*60*24));
          const expEst = window.CP_CONFIG.estadosExpedientes[exp.estado] || { emoji:'❓', color:'var(--text3)' };
          return `
          <div class="card" style="margin-bottom:0">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
              <div>
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                  <span class="exp-numero">${exp.numero}</span>
                  <span class="exp-estado ${exp.estado}">${expEst.emoji} ${exp.estado.replace('_',' ')}</span>
                </div>
                <div style="font-size:15px;font-weight:700">${exp.clientName}</div>
                <div style="font-size:13px;color:var(--text2)">${exp.descripcion||'—'}</div>
              </div>
              <div style="text-align:right;font-size:12px;color:var(--text3)">
                <div style="font-weight:600;color:var(--green)">${exp.totalHoras||0} h</div>
                <div>${dias} día${dias!==1?'s':''} abierto</div>
              </div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn bgh" style="font-size:11px;padding:5px 12px" onclick="CP.PartesAdmin.verExpediente('${exp._id}')">📁 Ver hilo</button>
              ${exp.estado==='EN_CURSO' ? `
              <button class="btn bgh" style="font-size:11px;padding:5px 12px;color:var(--green);border-color:var(--green)" onclick="CP.PartesAdmin.cerrarExpediente('${exp._id}','${exp.clientName.replace(/'/g,"\\'")}')">✅ Cerrar</button>
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
      showTab('expedientes', document.querySelector('#presencia-container .btab:nth-child(3)'));
      document.getElementById('exp-lista').innerHTML = `
        <button class="btn bgh" style="margin-bottom:14px" onclick="CP.PartesAdmin.loadExpedientes()">← Volver</button>
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
            <div>
              <span class="exp-numero">${exp.numero}</span>
              <div style="font-size:17px;font-weight:700;margin-top:4px">${exp.clientName}</div>
              <div style="font-size:13px;color:var(--text2)">${exp.descripcion||'—'}</div>
            </div>
            <div style="text-align:right">
              <div style="font-size:15px;font-weight:700;color:var(--green)">${exp.totalHoras||0} h</div>
              <div style="font-size:12px;color:var(--text3)">${(exp.partes||[]).length} partes</div>
            </div>
          </div>

          <div class="card-title">Hilo de partes</div>
          <div style="display:flex;flex-direction:column;gap:8px">
            ${(exp.partes||[]).map(p => {
              const etrab = ESTADOS_TRABAJO[p.estadoTrabajo] || ESTADOS_TRABAJO.completado;
              const ejor  = TIPOS_JORNADA[p.tipoJornada]    || TIPOS_JORNADA.NORMAL;
              return `
              <div class="exp-hilo-item ${p.estadoTrabajo||'completado'}">
                <div style="display:flex;justify-content:space-between;align-items:flex-start">
                  <div>
                    <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap">
                      <span style="font-size:13px;font-weight:600">${dt(p.date)}</span>
                      <span class="etrab ${p.estadoTrabajo||'completado'}">${etrab.emoji} ${etrab.label}</span>
                      ${p.tipoJornada !== 'NORMAL' ? `<span class="jornada ${p.tipoJornada}">${ejor.emoji} ${ejor.label}</span>` : ''}
                    </div>
                    <div style="font-size:13px;color:var(--text2)">${p.workerName}</div>
                    <div style="font-size:12px;color:var(--text3);margin-top:2px">${p.description||'—'}</div>
                    ${p.pendienteDetalle ? `<div style="font-size:12px;color:var(--red);margin-top:4px">🔴 ${p.pendienteDetalle}</div>` : ''}
                    ${p.materialDetalle ? `<div style="font-size:12px;color:var(--purple);margin-top:4px">📦 ${p.materialDetalle}</div>` : ''}
                    ${p.equipo?.length > 1 ? `<div style="font-size:11px;color:var(--blue);margin-top:4px">👥 ${p.equipo.map(m=>m.nombre.split(' ')[0]).join(', ')}</div>` : ''}
                  </div>
                  <div style="text-align:right">
                    <div style="font-size:13px;font-weight:600">${p.horas} h</div>
                    <button class="btn bgh" style="font-size:10px;padding:3px 8px;margin-top:6px" onclick="CP.PartesAdmin.openParte('${p._id}')">Ver →</button>
                  </div>
                </div>
              </div>`;
            }).join('')}
          </div>

          ${exp.estado === 'EN_CURSO' ? `
          <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
            <button class="btn bg2" onclick="CP.PartesAdmin.cerrarExpediente('${exp._id}','${exp.clientName.replace(/'/g,"\\'")}')">✅ Cerrar y preparar para facturar</button>
          </div>` : ''}
        </div>`;
    } catch(err) { alert('Error: ' + err.message); }
  }

  async function cerrarExpediente(id, clientName) {
    if (!confirm(`¿Cerrar el expediente de "${clientName}"?`)) return;
    try {
      const r = await api(`/api/expedientes/${id}/cerrar`, { method:'POST' });
      alert(`✅ Expediente cerrado. Total: ${r.totalHoras} horas en ${r.partes} partes.`);
      loadExpedientes();
    } catch(err) { alert('Error: ' + err.message); }
  }

  async function pausarExpediente(id) {
    try { await api(`/api/expedientes/${id}`, { method:'PUT', body: JSON.stringify({ estado:'PAUSADO' }) }); loadExpedientes(); }
    catch(err) { alert('Error: ' + err.message); }
  }

  async function abrirModalExpediente() {
    document.getElementById('exp-create-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'exp-create-modal';
    modal.className = 'modal-overlay';
    modal.style.alignItems = 'center';
    modal.innerHTML = `
      <div class="modal-box" style="max-width:480px">
        <div class="modal-header">
          <div class="modal-title">Nuevo expediente</div>
          <button class="modal-close" onclick="document.getElementById('exp-create-modal').remove()">✕</button>
        </div>
        <div class="field-row">
          <span class="field-label">Cliente *</span>
          <input type="text" id="exp-m-cliente" list="exp-clients-list" placeholder="Nombre del cliente..." class="field-input">
          <datalist id="exp-clients-list"></datalist>
        </div>
        <div class="field-row">
          <span class="field-label">Descripción del trabajo</span>
          <textarea id="exp-m-desc" rows="3" class="field-input" style="resize:vertical" placeholder="¿Qué trabajo incluye este expediente?"></textarea>
        </div>
        <div class="modal-footer">
          <button class="btn bp" onclick="CP.PartesAdmin.crearExpediente()">📁 Crear expediente</button>
          <button class="btn bgh" onclick="document.getElementById('exp-create-modal').remove()">Cancelar</button>
        </div>
        <div id="exp-create-msg" style="margin-top:8px;font-size:12px;display:none"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });
    try {
      if (!window._cpClients) window._cpClients = await api('/api/clients/list');
      const dl = document.getElementById('exp-clients-list');
      if (dl) dl.innerHTML = (window._cpClients||[]).map(n=>`<option value="${n}">`).join('');
    } catch(e) {}
  }

  async function crearExpediente() {
    const cliente = document.getElementById('exp-m-cliente')?.value?.trim() || '';
    const desc    = document.getElementById('exp-m-desc')?.value?.trim()    || '';
    if (!cliente) { mostrarMsg('exp-create-msg', '⚠️ El cliente es obligatorio', 'warn'); return; }
    try {
      await api('/api/expedientes', { method:'POST', body: JSON.stringify({ clientName: cliente, descripcion: desc }) });
      document.getElementById('exp-create-modal').remove();
      loadExpedientes();
    } catch(err) { mostrarMsg('exp-create-msg', '❌ ' + err.message, 'error'); }
  }

  // ── EXTERNOS ────────────────────────────────────────────────────
  async function loadExternosAdmin() {
    const el = document.getElementById('externos-admin-lista');
    if (!el) return;
    try {
      const lista = await api('/api/externos');
      if (!lista.length) { el.innerHTML = '<div class="empty"><div class="et">No hay externos registrados</div></div>'; return; }
      el.innerHTML = `<table>
        <thead><tr><th>Nombre</th><th>Oficio</th><th>Teléfono</th><th></th></tr></thead>
        <tbody>${lista.map(e=>`<tr>
          <td><strong>${e.nombre}</strong></td>
          <td style="color:var(--text2)">${e.oficio||'—'}</td>
          <td style="color:var(--text2)">${e.telefono||'—'}</td>
          <td><button class="btn bgh" style="font-size:10px;padding:3px 8px;color:var(--red);border-color:var(--red)" onclick="CP.PartesAdmin.borrarExterno('${e._id}','${e.nombre.replace(/'/g,"\\'")}')">🗑</button></td>
        </tr>`).join('')}</tbody>
      </table>`;
    } catch(e) { el.innerHTML = '<div style="color:var(--red);font-size:12px">Error cargando</div>'; }
  }

  function abrirModalExterno() {
    document.getElementById('ext-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'ext-modal';
    modal.className = 'modal-overlay';
    modal.style.alignItems = 'center';
    modal.innerHTML = `
      <div class="modal-box" style="max-width:400px">
        <div class="modal-header">
          <div class="modal-title">Nuevo externo / colaborador</div>
          <button class="modal-close" onclick="document.getElementById('ext-modal').remove()">✕</button>
        </div>
        <div class="field-row">
          <span class="field-label">Nombre *</span>
          <input type="text" id="ext-m-nombre" placeholder="Nombre completo..." class="field-input">
        </div>
        <div class="field-row">
          <span class="field-label">Oficio</span>
          <input type="text" id="ext-m-oficio" placeholder="Ej: Pintor, Electricista..." class="field-input">
        </div>
        <div class="field-row">
          <span class="field-label">Teléfono</span>
          <input type="tel" id="ext-m-tel" placeholder="Opcional..." class="field-input">
        </div>
        <div class="modal-footer">
          <button class="btn bp" onclick="CP.PartesAdmin.guardarExterno()">💾 Guardar</button>
          <button class="btn bgh" onclick="document.getElementById('ext-modal').remove()">Cancelar</button>
        </div>
        <div id="ext-modal-msg" style="margin-top:8px;font-size:12px;display:none"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });
  }

  async function guardarExterno() {
    const nombre   = document.getElementById('ext-m-nombre')?.value?.trim() || '';
    const oficio   = document.getElementById('ext-m-oficio')?.value?.trim() || '';
    const telefono = document.getElementById('ext-m-tel')?.value?.trim()    || '';
    if (!nombre) { mostrarMsg('ext-modal-msg', '⚠️ El nombre es obligatorio', 'warn'); return; }
    try {
      await api('/api/externos', { method:'POST', body: JSON.stringify({ nombre, oficio, telefono }) });
      document.getElementById('ext-modal').remove();
      loadExternosAdmin();
    } catch(err) { mostrarMsg('ext-modal-msg', '❌ ' + err.message, 'error'); }
  }

  async function borrarExterno(id, nombre) {
    if (!confirm(`¿Eliminar a "${nombre}"?`)) return;
    try { await api(`/api/externos/${id}`, { method:'DELETE' }); loadExternosAdmin(); }
    catch(err) { alert('Error: ' + err.message); }
  }

  // ── NUEVO PARTE (admin) ─────────────────────────────────────────
  function renderFormAdmin() {
    const WORKERS = getWorkers();
    return `
      <div class="field-grid-2">
        <div>
          <span class="field-label">Trabajador</span>
          <select id="pa-new-worker" class="field-input">
            ${WORKERS.map(w=>`<option value="${w.id}" data-name="${w.name}">${w.name}</option>`).join('')}
          </select>
        </div>
        <div>
          <span class="field-label">Fecha</span>
          <input type="date" id="pa-new-date" value="${new Date().toISOString().slice(0,10)}" class="field-input">
        </div>
      </div>
      <div class="field-row">
        <span class="field-label">Tipo jornada</span>
        <select id="pa-new-jornada" class="field-input">
          ${Object.entries(TIPOS_JORNADA).map(([k,v])=>
            `<option value="${k}">${v.emoji} ${v.label}</option>`
          ).join('')}
        </select>
      </div>
      <div class="field-row">
        <span class="field-label">Cliente / Obra</span>
        <input type="text" id="pa-new-client" list="pa-clients-list" placeholder="Buscar cliente..." class="field-input">
        <datalist id="pa-clients-list"></datalist>
      </div>
      <div class="field-row">
        <span class="field-label">Descripción</span>
        <textarea id="pa-new-desc" rows="3" class="field-input" style="resize:vertical" placeholder="Qué se hizo..."></textarea>
      </div>
      <div class="field-grid-2">
        <div>
          <span class="field-label">Horas</span>
          <input type="number" id="pa-new-horas" value="8" min="0.5" max="16" step="0.5" class="field-input">
        </div>
        <div>
          <span class="field-label">Estado trabajo</span>
          <select id="pa-new-estado-trabajo" class="field-input">
            ${Object.entries(ESTADOS_TRABAJO).map(([k,v])=>
              `<option value="${k}">${v.emoji} ${v.label}</option>`
            ).join('')}
          </select>
        </div>
      </div>
      <div class="field-row">
        <span class="field-label">Notas internas</span>
        <input type="text" id="pa-new-notas" placeholder="Notas..." class="field-input">
      </div>`;
  }

  async function loadClientsSuggestions() {
    try {
      if (!window._cpClients) window._cpClients = await api('/api/clients/list');
      const dl = document.getElementById('pa-clients-list');
      if (dl) dl.innerHTML = (window._cpClients||[]).map(n=>`<option value="${n}">`).join('');
    } catch(e) {}
  }

  async function submitParte() {
    const workerSel     = document.getElementById('pa-new-worker');
    const workerId      = workerSel?.value;
    const workerName    = workerSel?.options[workerSel.selectedIndex]?.dataset.name || '';
    const date          = document.getElementById('pa-new-date')?.value;
    const clientName    = document.getElementById('pa-new-client')?.value?.trim() || '';
    const description   = document.getElementById('pa-new-desc')?.value?.trim()   || '';
    const horas         = parseFloat(document.getElementById('pa-new-horas')?.value || 8);
    const tipoJornada   = document.getElementById('pa-new-jornada')?.value        || 'NORMAL';
    const estadoTrabajo = document.getElementById('pa-new-estado-trabajo')?.value  || 'completado';
    const notas         = document.getElementById('pa-new-notas')?.value?.trim()  || '';

    if (!date || !clientName) { mostrarMsg('pa-form-msg', '⚠️ Fecha y cliente son obligatorios', 'warn'); return; }

    try {
      await api('/api/partes', { method:'POST', body: JSON.stringify({
        workerId, workerName, date, clientName, description,
        horas, tipoJornada, estadoTrabajo, notas, materiales:[], status:'verificado'
      })});
      mostrarMsg('pa-form-msg', '✅ Parte guardado', 'ok');
      setTimeout(() => resetForm(), 1500);
      loadLista();
    } catch(err) { mostrarMsg('pa-form-msg', '❌ ' + err.message, 'error'); }
  }

  function resetForm() {
    ['pa-new-client','pa-new-desc','pa-new-notas'].forEach(id => { const e=document.getElementById(id); if(e) e.value=''; });
    const h = document.getElementById('pa-new-horas'); if(h) h.value='8';
    const d = document.getElementById('pa-new-date');  if(d) d.value=new Date().toISOString().slice(0,10);
    const m = document.getElementById('pa-form-msg');  if(m) m.style.display='none';
  }

  async function loadFacturacion() {
    const from = document.getElementById('pa-fac-from')?.value || '';
    const to   = document.getElementById('pa-fac-to')?.value   || '';
    const el   = document.getElementById('pa-facturacion');
    if (!el) return;
    el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:10px">Cargando...</div>';
    try {
      const data = await api(`/api/partes/resumen/facturacion?${new URLSearchParams({from,to})}`);
      if (!data.length) { el.innerHTML = '<div class="empty"><div class="et">No hay partes en este período</div></div>'; return; }
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
    } catch(err) { el.innerHTML = `<div style="color:var(--red);font-size:12px">Error: ${err.message}</div>`; }
  }

  CP.PartesAdmin = {
    render, showTab, applyFilters, clearFilters, goPage,
    openParte, updateStatus, saveParteChanges, deleteParte,
    submitParte, resetForm, loadFacturacion,
    loadAsignaciones, abrirModalAsignacion, guardarAsignacion, borrarAsignacion,
    loadExpedientes, verExpediente, cerrarExpediente, pausarExpediente,
    abrirModalExpediente, crearExpediente,
    loadExternosAdmin, abrirModalExterno, guardarExterno, borrarExterno,
  };

})(window.CP = window.CP || {});
