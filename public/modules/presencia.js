// modules/presencia.js — Módulo de presencia y calendario
// Completamente independiente. Se carga dinámicamente desde index.html
// No modifica ningún archivo existente.

(function(CP) {
  'use strict';

  // Workers se cargan dinámicamente desde MongoDB
  let WORKERS = [];
  const RATES = { jose:26.72, diego:19.05, abdellah:13.28, mamadou:13.28, paula:8.66 };

  async function loadWorkers() {
    try {
      const data = await api('/api/partes/workers');
      if (Array.isArray(data) && data.length > 0) {
        WORKERS = data.map(w => ({
          ...w,
          rate: RATES[w.id] || 15  // rate por defecto si es nuevo
        }));
      }
    } catch(e) {
      console.warn('[Presencia] Usando workers fallback');
      WORKERS = [
        {id:'jose',    name:'Jose Beliard',    color:'#4d9cf8', rate:26.72},
        {id:'diego',   name:'Diego Campillo',  color:'#22c487', rate:19.05},
        {id:'abdellah',name:'Abdellah Souiri', color:'#f59e0b', rate:13.28},
        {id:'mamadou', name:'Mamadou Barry',   color:'#a78bfa', rate:13.28},
        {id:'paula',   name:'Paula Morales',   color:'#f05252', rate:8.66},
      ];
    }
  }

  const ESTADOS = {
    obra:       {label:'En obra',           color:'#22c487', emoji:'🏗️'},
    oficina:    {label:'Oficina/almacén',   color:'#4d9cf8', emoji:'🏢'},
    vacaciones: {label:'Vacaciones',        color:'#a78bfa', emoji:'🌴'},
    baja:       {label:'Baja médica',       color:'#f59e0b', emoji:'🏥'},
    falta_j:    {label:'Falta justificada', color:'#f59e0b', emoji:'📋'},
    falta_i:    {label:'Falta injust.',     color:'#f05252', emoji:'❌'},
    libre:      {label:'Libre',             color:'#5a6278', emoji:'⏸️'},
  };

  const MN = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const DN = ['D','L','M','X','J','V','S'];

  let calYear  = new Date().getFullYear();
  let calMonth = new Date().getMonth() + 1;
  let calData  = {};
  let selectedEstado = null;
  let modalWorker = null, modalDate = null;

  // ── API ───────────────────────────────────────────────────────────
  async function api(url, opts = {}) {
    const tok = localStorage.getItem('cp_token');
    const r = await fetch(url, {
      ...opts,
      headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  // ── RENDER PRINCIPAL ──────────────────────────────────────────────
  async function render(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    await loadWorkers(); // Cargar trabajadores desde MongoDB

    container.innerHTML = `
      <div style="display:flex;gap:0;border-bottom:1px solid var(--border);margin-bottom:20px;overflow-x:auto">
        <button class="btab active" onclick="CP.Presencia.showTab('calendario',this)">📅 Calendario</button>
        <button class="btab" onclick="CP.Presencia.showTab('resumen',this)">📊 Resumen mensual</button>
        <button class="btab" onclick="CP.Presencia.showTab('clientes',this)">👷 Por cliente/obra</button>
        <button class="btab" onclick="CP.Presencia.showTab('calculadora',this)">🧮 Calculadora obra</button>
      </div>

      <div id="p-tab-calendario" class="p-tab active">
        <div class="alert ain" style="margin-bottom:16px">
          <div>📅</div>
          <div><strong>Control de presencia diario</strong> — haz clic en cualquier día laborable para registrar el estado del trabajador.</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">
          <button class="btn bgh" onclick="CP.Presencia.prevMonth()">← Anterior</button>
          <span style="font-size:16px;font-weight:600;font-family:'Space Grotesk',sans-serif" id="p-month-label">—</span>
          <button class="btn bgh" onclick="CP.Presencia.nextMonth()">Siguiente →</button>
          <button class="btn bgh" onclick="CP.Presencia.goToday()">Hoy</button>
          <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap">
            ${Object.entries(ESTADOS).map(([,v])=>`<span style="font-size:10px;display:flex;align-items:center;gap:3px"><span style="width:8px;height:8px;border-radius:2px;background:${v.color};display:inline-block"></span>${v.emoji} ${v.label}</span>`).join('')}
          </div>
        </div>
        <div class="card" style="overflow-x:auto;padding:10px">
          <div id="p-cal-grid" style="min-width:600px"></div>
        </div>
      </div>

      <div id="p-tab-resumen" class="p-tab" style="display:none">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">
          <button class="btn bgh" onclick="CP.Presencia.prevSumMonth()">← Anterior</button>
          <span style="font-size:15px;font-weight:600;font-family:'Space Grotesk',sans-serif" id="p-sum-label">—</span>
          <button class="btn bgh" onclick="CP.Presencia.nextSumMonth()">Siguiente →</button>
          <button class="btn bg2" onclick="CP.Presencia.exportCSV()">📥 CSV</button>
          <button class="btn bp" onclick="CP.Presencia.openReport()">📄 Informe PDF</button>
        </div>
        <div id="p-sum-metrics" class="metrics-row"></div>
        <div class="card"><div class="card-title">Días por trabajador</div><div id="p-sum-table">Cargando...</div></div>
        <div class="card"><div class="card-title">Horas en obra por cliente</div><div id="p-sum-clients">Cargando...</div></div>
      </div>

      <div id="p-tab-clientes" class="p-tab" style="display:none">
        <div class="card" style="padding:16px 20px;margin-bottom:14px">
          <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
            <div>
              <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Cliente / Obra</div>
              <input type="text" class="srch" id="p-client-search" placeholder="Ej: Habitat Migdia..." style="width:220px">
            </div>
            <div>
              <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Desde</div>
              <input type="date" class="srch" id="p-client-from" style="width:145px">
            </div>
            <div>
              <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Hasta</div>
              <input type="date" class="srch" id="p-client-to" style="width:145px">
            </div>
            <button class="btn bp" onclick="CP.Presencia.searchClient()">Buscar</button>
          </div>
        </div>
        <div class="card"><div id="p-client-result"><div style="color:var(--text3);font-size:12px">Introduce un cliente para ver el extracto de días y horas.</div></div></div>
      </div>

      <div id="p-tab-calculadora" class="p-tab" style="display:none">
        <div class="alert ain" style="margin-bottom:16px">
          <div>🧮</div>
          <div><strong>Calculadora de rentabilidad de obra</strong> — introduce días por trabajador, materiales y precio para ver si la obra sale rentable.</div>
        </div>
        <div class="g2">
          <div class="card">
            <div class="card-title">Personal en esta obra</div>
            <table>
              <thead><tr><th>Trabajador</th><th style="text-align:center">Días</th><th style="text-align:center">H. extra</th><th style="text-align:right">Coste</th></tr></thead>
              <tbody>
                ${WORKERS.map(w=>`<tr>
                  <td><strong>${w.name.split(' ')[0]}</strong><br><span style="font-size:9px;color:var(--text3)">${w.rate}€/h</span></td>
                  <td><input type="number" id="calc-d-${w.id}" min="0" max="31" value="0" oninput="CP.Presencia.calcObra()" style="width:50px;text-align:center;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:4px;color:var(--text);font-size:12px"></td>
                  <td><input type="number" id="calc-h-${w.id}" min="0" max="50" value="0" oninput="CP.Presencia.calcObra()" style="width:50px;text-align:center;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:4px;color:var(--text);font-size:12px"></td>
                  <td style="text-align:right;font-weight:600" id="calc-c-${w.id}">0 €</td>
                </tr>`).join('')}
              </tbody>
              <tfoot><tr style="background:rgba(255,255,255,.03)"><td colspan="3"><strong>Total personal</strong></td><td style="text-align:right;color:var(--red);font-weight:700" id="calc-personal">0 €</td></tr></tfoot>
            </table>
          </div>
          <div class="card">
            <div class="card-title">Materiales y otros costes</div>
            <div id="calc-mat-rows">
              <div class="calc-mat-row" style="display:flex;gap:6px;margin-bottom:6px">
                <input type="text" placeholder="Concepto" style="flex:1;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:6px 10px;color:var(--text);font-size:12px">
                <input type="number" placeholder="€" min="0" oninput="CP.Presencia.calcObra()" style="width:85px;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:6px;color:var(--text);font-size:12px;text-align:right">
              </div>
            </div>
            <button class="btn bgh" style="width:100%;margin-bottom:14px;font-size:11px" onclick="CP.Presencia.addMatRow()">+ Añadir línea</button>
            <table>
              <tr><td style="color:var(--text2)">Total materiales</td><td style="text-align:right;font-weight:600" id="calc-mat">0 €</td></tr>
              <tr><td style="color:var(--text2)">Total personal</td><td style="text-align:right;color:var(--red);font-weight:600" id="calc-personal2">0 €</td></tr>
              <tr style="background:rgba(240,82,82,.05)"><td><strong>Coste total obra</strong></td><td style="text-align:right;color:var(--red);font-weight:700;font-size:15px" id="calc-total">0 €</td></tr>
            </table>
          </div>
        </div>
        <div class="card">
          <div class="card-title">Precio y resultado</div>
          <div style="display:flex;gap:12px;margin-bottom:14px;flex-wrap:wrap">
            <div>
              <div style="font-size:10px;color:var(--text3);margin-bottom:4px">Precio presupuestado (sin IVA)</div>
              <input type="number" id="calc-precio" min="0" oninput="CP.Presencia.calcObra()" placeholder="0" style="font-size:18px;font-weight:700;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:10px 14px;color:var(--text);width:160px">
            </div>
            <div>
              <div style="font-size:10px;color:var(--text3);margin-bottom:4px">Nombre de la obra</div>
              <input type="text" id="calc-nombre" placeholder="Ej: Habitat Migdia - tejado" style="background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:10px 14px;color:var(--text);width:260px;font-size:13px">
            </div>
          </div>
          <div id="calc-result" style="padding:14px;background:var(--bg3);border-radius:var(--rs);border:1px solid var(--border);font-size:12px;color:var(--text3)">
            Introduce el precio presupuestado para ver el resultado.
          </div>
        </div>
      </div>`;

    // Añadir estilos del módulo si no están
    if (!document.getElementById('presencia-styles')) {
      const style = document.createElement('style');
      style.id = 'presencia-styles';
      style.textContent = `
        .btab{background:none;border:none;color:var(--text3);padding:10px 16px;font-size:12px;font-weight:500;cursor:pointer;border-bottom:2px solid transparent;font-family:'Inter',sans-serif;white-space:nowrap;transition:all .2s}
        .btab:hover{color:var(--text)}.btab.active{color:var(--green);border-bottom-color:var(--green)}
        .p-tab{display:none}.p-tab.active{display:block}
      `;
      document.head.appendChild(style);
    }

    loadCalendar();
  }

  // ── TABS DEL MÓDULO ───────────────────────────────────────────────
  let sumYear = new Date().getFullYear();
  let sumMonth = new Date().getMonth() + 1;

  function showTab(id, btn) {
    document.querySelectorAll('.p-tab').forEach(p => { p.style.display = 'none'; p.classList.remove('active'); });
    document.querySelectorAll('.btab').forEach(b => b.classList.remove('active'));
    const tab = document.getElementById('p-tab-' + id);
    if (tab) { tab.style.display = 'block'; tab.classList.add('active'); }
    if (btn) btn.classList.add('active');
    if (id === 'calendario') loadCalendar();
    if (id === 'resumen')    loadSummary();
  }

  // ── CALENDARIO ────────────────────────────────────────────────────
  function updateMonthLabel() {
    const el = document.getElementById('p-month-label');
    if (el) el.textContent = MN[calMonth - 1] + ' ' + calYear;
  }

  async function loadCalendar() {
    updateMonthLabel();
    const from = `${calYear}-${String(calMonth).padStart(2,'0')}-01`;
    const to   = `${calYear}-${String(calMonth).padStart(2,'0')}-31`;
    calData = {};
    buildGrid(); // Mostrar vacío inmediatamente

    try {
      const data = await api(`/api/attendance?from=${from}&to=${to}`);
      if (Array.isArray(data)) {
        calData = {};
        data.forEach(e => { calData[e.workerId + '_' + e.date] = e; });
        buildGrid();
      }
    } catch (err) {
      console.warn('[Presencia] No se pudieron cargar datos:', err.message);
    }
  }

  function buildGrid() {
    const grid = document.getElementById('p-cal-grid');
    if (!grid) return;

    const daysInMonth = new Date(calYear, calMonth, 0).getDate();
    const today = new Date().toISOString().slice(0, 10);
    const days = [];

    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${calYear}-${String(calMonth).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const dow  = new Date(calYear, calMonth - 1, d).getDay();
      days.push({ d, date, dow, weekend: dow === 0 || dow === 6 });
    }

    let html = `<div style="display:grid;grid-template-columns:100px repeat(${days.length},minmax(26px,1fr));gap:1px;font-size:10px">`;

    // Header
    html += `<div style="padding:4px 6px;color:var(--text3);font-size:9px;font-weight:600;border-bottom:1px solid var(--border)">Trabajador</div>`;
    days.forEach(({ d, date, dow, weekend }) => {
      const isToday = date === today;
      html += `<div style="text-align:center;padding:2px 1px;border-bottom:1px solid var(--border);background:${weekend ? 'rgba(255,255,255,.02)' : ''}">
        <div style="font-size:7px;color:var(--text3)">${DN[dow]}</div>
        <div style="font-size:10px;font-weight:${isToday ? '700' : '400'};color:${isToday ? 'var(--blue)' : weekend ? 'var(--text3)' : 'var(--text2)'}">${d}</div>
      </div>`;
    });

    // Filas por trabajador
    WORKERS.forEach(w => {
      html += `<div style="padding:4px 8px;color:var(--text2);font-size:10px;font-weight:500;border-right:1px solid var(--border);display:flex;align-items:center;gap:4px;white-space:nowrap">
        <div style="width:6px;height:6px;border-radius:50%;background:${w.color};flex-shrink:0"></div>
        ${w.name.split(' ')[0]}
      </div>`;
      days.forEach(({ date, weekend }) => {
        const entry = calData[w.id + '_' + date];
        const est   = entry ? ESTADOS[entry.estado] : null;
        const bg    = weekend ? 'rgba(255,255,255,.01)' : (est ? est.color + '28' : 'var(--bg3)');
        const border = est ? est.color + '55' : weekend ? 'transparent' : 'var(--border)';
        html += `<div
          data-wid="${w.id}" data-wname="${w.name}" data-date="${date}" data-clickable="${!weekend}"
          style="min-height:36px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;background:${bg};border:1px solid ${border};border-radius:3px;cursor:${weekend ? 'default' : 'pointer'};padding:1px;transition:opacity .15s"
          title="${est ? est.label + (entry.clientName ? ' — ' + entry.clientName : '') : weekend ? 'Fin de semana' : 'Sin registrar'}">
          <div style="font-size:12px;line-height:1">${est ? est.emoji : ''}</div>
          <div style="font-size:7px;color:var(--text3);overflow:hidden;max-width:100%;white-space:nowrap;text-overflow:ellipsis;padding:0 2px">${entry?.clientName ? entry.clientName.slice(0, 8) : ''}</div>
        </div>`;
      });
    });

    html += '</div>';
    grid.innerHTML = html;

    // Event delegation
    grid.addEventListener('click', e => {
      const cell = e.target.closest('[data-date]');
      if (!cell || cell.dataset.clickable !== 'true') return;
      openModal(cell.dataset.wid, cell.dataset.wname, cell.dataset.date);
    });
    grid.addEventListener('mouseover', e => {
      const c = e.target.closest('[data-clickable="true"]');
      if (c) c.style.opacity = '.7';
    });
    grid.addEventListener('mouseout', e => {
      const c = e.target.closest('[data-clickable="true"]');
      if (c) c.style.opacity = '1';
    });
  }

  function prevMonth()  { if (calMonth === 1) { calMonth = 12; calYear--; } else calMonth--; loadCalendar(); }
  function nextMonth()  { if (calMonth === 12) { calMonth = 1; calYear++; } else calMonth++; loadCalendar(); }
  function goToday()    { const n = new Date(); calYear = n.getFullYear(); calMonth = n.getMonth() + 1; loadCalendar(); }

  // ── MODAL ─────────────────────────────────────────────────────────
  function openModal(wid, wname, date) {
    modalWorker = wid; modalDate = date; selectedEstado = null;
    const entry = calData[wid + '_' + date];
    if (entry) selectedEstado = entry.estado;

    const existing = document.getElementById('p-modal');
    if (existing) existing.remove();

    const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('es-ES', { weekday:'long', day:'numeric', month:'long' });

    const modal = document.createElement('div');
    modal.id = 'p-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
    modal.innerHTML = `
      <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:16px;padding:22px;width:100%;max-width:400px;max-height:90vh;overflow-y:auto">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
          <div>
            <div style="font-weight:600;font-size:14px">${wname}</div>
            <div style="font-size:11px;color:var(--text3)">${dateLabel}</div>
          </div>
          <button onclick="document.getElementById('p-modal').remove()" style="background:none;border:none;color:var(--text3);font-size:18px;cursor:pointer;padding:4px">✕</button>
        </div>

        <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:8px">Estado</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:14px">
          ${Object.entries(ESTADOS).map(([k, v]) => `
            <button id="p-est-${k}" onclick="CP.Presencia._selectEstado('${k}')"
              style="background:${selectedEstado===k?v.color+'33':'var(--bg3)'};border:1px solid ${selectedEstado===k?v.color:'var(--border2)'};border-radius:8px;padding:8px;cursor:pointer;color:var(--text);text-align:left;font-family:'Inter',sans-serif;transition:all .15s">
              <span style="font-size:15px">${v.emoji}</span>
              <div style="font-size:11px;margin-top:3px">${v.label}</div>
            </button>`).join('')}
        </div>

        <div id="p-obra-fields" style="display:${selectedEstado === 'obra' ? 'block' : 'none'};margin-bottom:10px">
          <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:5px">Cliente / Obra</div>
          <input type="text" id="p-client-name" value="${entry?.clientName || ''}" placeholder="Buscar cliente..." 
            list="p-clients-datalist" autocomplete="off"
            style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px">
          <datalist id="p-clients-datalist"></datalist>
        </div>

        <div style="display:flex;gap:10px;margin-bottom:14px">
          <div style="flex:1">
            <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:5px">Horas</div>
            <input type="number" id="p-horas" value="${entry?.horas || 8}" min="1" max="16"
              style="width:80px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px">
          </div>
          <div style="flex:2">
            <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:5px">Notas</div>
            <input type="text" id="p-notas" value="${entry?.notas || ''}" placeholder="Observaciones..."
              style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px">
          </div>
        </div>

        <div style="display:flex;gap:8px">
          <button class="btn bp" style="flex:1" onclick="CP.Presencia._saveEntry()">💾 Guardar</button>
          ${entry ? `<button class="btn bgh" onclick="CP.Presencia._deleteEntry()">🗑️ Borrar</button>` : ''}
          <button class="btn bgh" onclick="document.getElementById('p-modal').remove()">Cancelar</button>
        </div>
        <div id="p-modal-msg" style="margin-top:8px;font-size:11px;display:none"></div>
      </div>`;

    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

    // Cargar clientes de StelOrder para autocompletado
    loadClientSuggestions();
  }

  async function loadClientSuggestions() {
    const dl = document.getElementById('p-clients-datalist');
    if (!dl) return;
    try {
      // Caché global para no repetir llamadas
      if (!window._cpClients) {
        const names = await api('/api/clients/list');
        window._cpClients = Array.isArray(names) ? names : [];
      }
      dl.innerHTML = window._cpClients.map(n => `<option value="${n}">`).join('');
    } catch (err) {
      console.warn('[Presencia] No se pudieron cargar clientes:', err.message);
    }
  }

  function _selectEstado(k) {
    selectedEstado = k;
    Object.keys(ESTADOS).forEach(s => {
      const btn = document.getElementById('p-est-' + s);
      if (!btn) return;
      btn.style.background = s === k ? ESTADOS[s].color + '33' : 'var(--bg3)';
      btn.style.borderColor = s === k ? ESTADOS[s].color : 'var(--border2)';
    });
    const obraFields = document.getElementById('p-obra-fields');
    if (obraFields) obraFields.style.display = k === 'obra' ? 'block' : 'none';
  }

  async function _saveEntry() {
    if (!selectedEstado) {
      const msg = document.getElementById('p-modal-msg');
      if (msg) { msg.textContent = '⚠️ Selecciona un estado primero'; msg.style.display = 'block'; msg.style.color = 'var(--amber)'; }
      return;
    }
    const entry = {
      workerId:   modalWorker,
      workerName: WORKERS.find(w => w.id === modalWorker)?.name || '',
      date:       modalDate,
      estado:     selectedEstado,
      clientName: selectedEstado === 'obra' ? (document.getElementById('p-client-name')?.value?.trim() || '') : '',
      horas:      parseFloat(document.getElementById('p-horas')?.value || 8),
      notas:      document.getElementById('p-notas')?.value?.trim() || '',
    };

    const msg = document.getElementById('p-modal-msg');
    if (msg) { msg.textContent = '⏳ Guardando...'; msg.style.display = 'block'; msg.style.color = 'var(--text2)'; }

    try {
      await api('/api/attendance', { method: 'POST', body: JSON.stringify(entry) });
      document.getElementById('p-modal')?.remove();
      loadCalendar();
    } catch (err) {
      if (msg) { msg.textContent = '❌ Error: ' + err.message; msg.style.color = 'var(--red)'; }
    }
  }

  async function _deleteEntry() {
    try {
      await api(`/api/attendance/${modalWorker}/${modalDate}`, { method: 'DELETE' });
      document.getElementById('p-modal')?.remove();
      loadCalendar();
    } catch (err) {
      console.error('[Presencia] Error delete:', err.message);
    }
  }

  // ── RESUMEN MENSUAL ───────────────────────────────────────────────
  function prevSumMonth() { if (sumMonth === 1) { sumMonth = 12; sumYear--; } else sumMonth--; loadSummary(); }
  function nextSumMonth() { if (sumMonth === 12) { sumMonth = 1; sumYear++; } else sumMonth++; loadSummary(); }

  async function loadSummary() {
    const el = document.getElementById('p-sum-label');
    if (el) el.textContent = MN[sumMonth - 1] + ' ' + sumYear;

    try {
      const data = await api(`/api/attendance/summary/${sumYear}/${sumMonth}`);
      const totalDias  = data.byWorker.reduce((s, w) => s + w.dias, 0);
      const totalObra  = data.byWorker.reduce((s, w) => s + w.dias_obra, 0);
      const totalFalta = data.byWorker.reduce((s, w) => s + w.dias_falta, 0);

      const metrics = document.getElementById('p-sum-metrics');
      if (metrics) metrics.innerHTML = `
        <div class="mc"><div class="ml">Días registrados</div><div class="mv b">${totalDias}</div></div>
        <div class="mc"><div class="ml">Días en obra</div><div class="mv g">${totalObra}</div></div>
        <div class="mc"><div class="ml">Faltas/bajas</div><div class="mv r">${totalFalta}</div></div>
        <div class="mc"><div class="ml">Horas totales</div><div class="mv b">${data.byWorker.reduce((s,w)=>s+w.horas,0).toFixed(0)} h</div></div>`;

      const eur = v => new Intl.NumberFormat('es-ES',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(v||0);
      const tbl = document.getElementById('p-sum-table');
      if (tbl) tbl.innerHTML = `<table>
        <thead><tr><th>Trabajador</th><th style="text-align:right">Días reg.</th><th style="text-align:right">En obra</th><th style="text-align:right">Faltas</th><th style="text-align:right">Horas</th><th style="text-align:right">Coste est.</th></tr></thead>
        <tbody>${data.byWorker.map(w => {
          const wd = WORKERS.find(x => x.id === w.id);
          return `<tr>
            <td><span style="display:flex;align-items:center;gap:6px"><span style="width:7px;height:7px;border-radius:50%;background:${w.color};display:inline-block"></span><strong>${w.name}</strong></span></td>
            <td style="text-align:right">${w.dias}</td>
            <td style="text-align:right;color:var(--green)">${w.dias_obra}</td>
            <td style="text-align:right;color:${w.dias_falta > 0 ? 'var(--red)' : 'var(--text2)'}">${w.dias_falta}</td>
            <td style="text-align:right">${w.horas.toFixed(0)} h</td>
            <td style="text-align:right;color:var(--red)">${eur(w.horas * (wd?.rate || 0))}</td>
          </tr>`;
        }).join('')}</tbody></table>`;

      // Clientes
      const clientMap = {};
      data.byWorker.forEach(w => {
        Object.entries(w.clientes || {}).forEach(([client, v]) => {
          if (!clientMap[client]) clientMap[client] = { dias: 0, horas: 0, workers: {} };
          clientMap[client].dias += v.dias;
          clientMap[client].horas += v.horas;
          clientMap[client].workers[w.name] = (clientMap[client].workers[w.name] || 0) + v.dias;
        });
      });
      const clients = Object.entries(clientMap).sort((a, b) => b[1].dias - a[1].dias);
      const cEl = document.getElementById('p-sum-clients');
      if (cEl) {
        if (!clients.length) { cEl.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:10px">No hay días en obra registrados este mes.</div>'; return; }
        cEl.innerHTML = `<table>
          <thead><tr><th>Cliente / Obra</th><th style="text-align:right">Días</th><th style="text-align:right">Horas</th><th>Trabajadores</th></tr></thead>
          <tbody>${clients.map(([client, v]) => `<tr>
            <td><strong>${client}</strong></td>
            <td style="text-align:right">${v.dias}</td>
            <td style="text-align:right">${v.horas.toFixed(0)} h</td>
            <td style="font-size:11px;color:var(--text2)">${Object.entries(v.workers).map(([n, d]) => `${n.split(' ')[0]}:${d}d`).join(' · ')}</td>
          </tr>`).join('')}</tbody></table>`;
      }
    } catch (err) {
      console.error('[Presencia] Error summary:', err.message);
    }
  }

  // ── BÚSQUEDA POR CLIENTE ──────────────────────────────────────────
  async function searchClient() {
    const name = document.getElementById('p-client-search')?.value?.trim() || '';
    const from = document.getElementById('p-client-from')?.value || '';
    const to   = document.getElementById('p-client-to')?.value   || '';
    if (!name) return;
    const el = document.getElementById('p-client-result');
    if (el) el.innerHTML = '<div style="color:var(--text3);font-size:12px">Buscando...</div>';

    try {
      const data = await api(`/api/attendance/client?clientName=${encodeURIComponent(name)}&from=${from}&to=${to}`);
      const eur = v => new Intl.NumberFormat('es-ES',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(v||0);
      const workers = Object.values(data.byWorker || {});
      if (!data.totalDias) { if (el) el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:10px">Sin registros para este cliente en el período.</div>'; return; }
      const totalCoste = workers.reduce((s, w) => { const wd = WORKERS.find(x => x.name === w.name); return s + (wd ? w.horas * wd.rate : 0); }, 0);
      if (el) el.innerHTML = `
        <div class="metrics-row" style="margin-bottom:14px">
          <div class="mc"><div class="ml">Total días en obra</div><div class="mv g">${data.totalDias}</div></div>
          <div class="mc"><div class="ml">Total horas</div><div class="mv g">${workers.reduce((s,w)=>s+w.horas,0).toFixed(0)} h</div></div>
          <div class="mc"><div class="ml">Coste personal</div><div class="mv r">${eur(totalCoste)}</div></div>
        </div>
        <table><thead><tr><th>Trabajador</th><th style="text-align:right">Días</th><th style="text-align:right">Horas</th><th style="text-align:right">Coste</th><th>Fechas</th></tr></thead>
        <tbody>${workers.map(w => {
          const wd = WORKERS.find(x => x.name === w.name);
          return `<tr>
            <td><strong>${w.name}</strong></td>
            <td style="text-align:right">${w.dias}</td>
            <td style="text-align:right">${w.horas.toFixed(0)} h</td>
            <td style="text-align:right;color:var(--red)">${eur(wd ? w.horas * wd.rate : 0)}</td>
            <td style="font-size:10px;color:var(--text3)">${w.dates.slice(0,5).map(d=>new Date(d+'T12:00:00').toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit'})).join(', ')}${w.dates.length>5?` +${w.dates.length-5} más`:''}</td>
          </tr>`;
        }).join('')}</tbody></table>`;
    } catch (err) {
      if (el) el.innerHTML = `<div style="color:var(--red);font-size:12px">Error: ${err.message}</div>`;
    }
  }

  // ── CALCULADORA OBRA ──────────────────────────────────────────────
  function addMatRow() {
    const container = document.getElementById('calc-mat-rows');
    if (!container) return;
    const row = document.createElement('div');
    row.className = 'calc-mat-row';
    row.style.cssText = 'display:flex;gap:6px;margin-bottom:6px';
    row.innerHTML = `
      <input type="text" placeholder="Concepto" style="flex:1;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:6px 10px;color:var(--text);font-size:12px">
      <input type="number" placeholder="€" min="0" oninput="CP.Presencia.calcObra()" style="width:85px;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:6px;color:var(--text);font-size:12px;text-align:right">
      <button onclick="this.parentElement.remove();CP.Presencia.calcObra()" style="background:var(--red-bg);border:1px solid var(--red);border-radius:6px;padding:3px 8px;color:var(--red);cursor:pointer;font-size:11px">✕</button>`;
    container.appendChild(row);
  }

  function calcObra() {
    const eur = v => new Intl.NumberFormat('es-ES',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(v||0);
    let totalPersonal = 0;
    WORKERS.forEach(w => {
      const dias  = parseFloat(document.getElementById('calc-d-' + w.id)?.value || 0);
      const extra = parseFloat(document.getElementById('calc-h-' + w.id)?.value || 0);
      const cost  = (dias * 8 + extra) * w.rate;
      totalPersonal += cost;
      const el = document.getElementById('calc-c-' + w.id);
      if (el) el.textContent = eur(cost);
    });

    let totalMat = 0;
    document.querySelectorAll('.calc-mat-row input[type="number"]').forEach(inp => { totalMat += parseFloat(inp.value || 0); });

    const total  = totalPersonal + totalMat;
    const precio = parseFloat(document.getElementById('calc-precio')?.value || 0);
    const nombre = document.getElementById('calc-nombre')?.value || 'Obra';

    const setEl = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
    setEl('calc-personal',  eur(totalPersonal));
    setEl('calc-personal2', eur(totalPersonal));
    setEl('calc-mat',       eur(totalMat));
    setEl('calc-total',     eur(total));

    const res = document.getElementById('calc-result');
    if (!res) return;
    if (!precio) { res.innerHTML = '<div style="font-size:12px;color:var(--text3)">Introduce el precio presupuestado para ver el resultado.</div>'; return; }

    const beneficio = precio - total;
    const margen    = precio > 0 ? (beneficio / precio * 100) : 0;
    const ok        = beneficio > 0;
    res.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px">
        <div><div style="font-size:9px;color:var(--text3);margin-bottom:3px">Precio</div><div style="font-size:16px;font-weight:700;color:var(--green);font-family:'Space Grotesk',sans-serif">${eur(precio)}</div></div>
        <div><div style="font-size:9px;color:var(--text3);margin-bottom:3px">Coste total</div><div style="font-size:16px;font-weight:700;color:var(--red);font-family:'Space Grotesk',sans-serif">${eur(total)}</div></div>
        <div><div style="font-size:9px;color:var(--text3);margin-bottom:3px">Beneficio</div><div style="font-size:16px;font-weight:700;color:${ok?'var(--green)':'var(--red)'};font-family:'Space Grotesk',sans-serif">${ok?'+':''}${eur(beneficio)}</div></div>
        <div><div style="font-size:9px;color:var(--text3);margin-bottom:3px">Margen</div><div style="font-size:16px;font-weight:700;color:${margen>20?'var(--green)':margen>0?'var(--amber)':'var(--red)'};font-family:'Space Grotesk',sans-serif">${margen.toFixed(1)}%</div></div>
      </div>
      <div style="padding:10px;background:${ok?'var(--green-bg)':'var(--red-bg)'};border-radius:8px;border:1px solid ${ok?'rgba(34,196,135,.3)':'rgba(240,82,82,.3)'};font-size:12px;color:${ok?'var(--green)':'var(--red)'}">
        ${ok
          ? `✅ <strong>${nombre}</strong> — Obra rentable. ${eur(beneficio)} de beneficio con ${margen.toFixed(1)}% de margen.${margen < 20 ? ' Margen algo ajustado.' : ' Buen margen.'}`
          : `🚨 <strong>${nombre}</strong> — Pérdidas de ${eur(Math.abs(beneficio))}. Precio mínimo para 20% de margen: ${eur(total * 1.2)}`}
      </div>`;
  }

  // ── INFORME PDF/HTML ──────────────────────────────────────────────
  function openReport() {
    const tok = localStorage.getItem('cp_token');
    const url = `/informe-presencia?year=${sumYear}&month=${sumMonth}&token=${tok}`;
    window.open(url, '_blank');
  }

  // ── EXPORTAR CSV ──────────────────────────────────────────────────
  async function exportCSV() {
    try {
      const data = await api(`/api/attendance?from=${sumYear}-${String(sumMonth).padStart(2,'0')}-01&to=${sumYear}-${String(sumMonth).padStart(2,'0')}-31`);
      if (!data?.length) return;
      const rows = [['Fecha','Trabajador','Estado','Cliente/Obra','Horas','Notas']];
      data.forEach(e => rows.push([e.date, e.workerName, ESTADOS[e.estado]?.label || e.estado, e.clientName || '', e.horas || 8, e.notas || '']));
      const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
      const a = document.createElement('a');
      a.href = 'data:text/csv;charset=utf-8,\uFEFF' + encodeURIComponent(csv);
      a.download = `presencia_${sumYear}_${String(sumMonth).padStart(2,'0')}.csv`;
      a.click();
    } catch (err) { console.error('[Presencia] CSV error:', err.message); }
  }

  // ── API PÚBLICA DEL MÓDULO ────────────────────────────────────────
  CP.Presencia = {
    render, showTab, openReport,
    prevMonth, nextMonth, goToday,
    prevSumMonth, nextSumMonth,
    searchClient, exportCSV,
    addMatRow, calcObra,
    _selectEstado, _saveEntry, _deleteEntry,
  };

})(window.CP = window.CP || {});
