// modules/presencia.js — v3 con ayudantes en resumen mensual
(function(CP) {
  'use strict';

  const CFG     = window.CP_CONFIG;
  const ESTADOS = CFG.estadosPresencia;
  const MN = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const DN = ['D','L','M','X','J','V','S'];

  let calYear  = new Date().getFullYear();
  let calMonth = new Date().getMonth() + 1;
  let calData  = {};
  let selectedEstado   = null;
  let modalWorker = null, modalDate = null;
  let _equipoPresencia = [];
  let _libresPresencia = [];
  let _obrasModal = [];   // [{clientName, horas}] — obras del día (estado 'obra'), editable a mano

  async function api(url, opts = {}) {
    const tok = localStorage.getItem('cp_token');
    const r = await fetch(url, {
      ...opts,
      headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function render(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

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
          <div><strong>Control de presencia diario</strong> — haz clic en cualquier día para registrar el estado. Los fines de semana se marcan automáticamente como jornada extra.</div>
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
        <div id="p-ayudantes-card" style="display:none"></div>
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
        <div class="card"><div id="p-client-result"><div style="color:var(--text3);font-size:12px">Introduce un cliente para ver el extracto.</div></div></div>
      </div>

      <div id="p-tab-calculadora" class="p-tab" style="display:none">
        <div class="alert ain" style="margin-bottom:16px">
          <div>🧮</div>
          <div><strong>Calculadora de rentabilidad de obra</strong></div>
        </div>
        <div class="g2">
          <div class="card">
            <div class="card-title">Personal en esta obra</div>
            <table>
              <thead><tr><th>Trabajador</th><th style="text-align:center">Días</th><th style="text-align:center">H. extra</th><th style="text-align:right">Coste</th></tr></thead>
              <tbody>
                ${CFG.workers.map(w=>`<tr>
                  <td><strong>${w.name.split(' ')[0]}</strong><br><span style="font-size:9px;color:var(--text3)">${w.rate||w.costeHora||15}€/h</span></td>
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

    if (!document.getElementById('presencia-styles')) {
      const style = document.createElement('style');
      style.id = 'presencia-styles';
      style.textContent = `
        .p-chip{display:inline-flex;align-items:center;gap:5px;background:var(--bg3);border:1.5px solid var(--border2);border-radius:20px;padding:6px 13px;font-size:12px;cursor:pointer;transition:all .15s;font-family:'Inter',sans-serif;color:var(--text2)}
        .p-chip:hover{border-color:var(--blue);color:var(--text)}
        .p-chip.on{border-color:var(--blue);background:rgba(77,156,248,.12);color:var(--blue)}
      `;
      document.head.appendChild(style);
    }

    loadCalendar();
  }

  let sumYear2  = new Date().getFullYear();
  let sumMonth2 = new Date().getMonth() + 1;

  function showTab(id, btn) {
    document.querySelectorAll('.p-tab').forEach(p => { p.style.display='none'; p.classList.remove('active'); });
    document.querySelectorAll('.btab').forEach(b => b.classList.remove('active'));
    const tab = document.getElementById('p-tab-' + id);
    if (tab) { tab.style.display='block'; tab.classList.add('active'); }
    if (btn) btn.classList.add('active');
    if (id === 'calendario') loadCalendar();
    if (id === 'resumen')    loadSummary();
  }

  function updateMonthLabel() {
    const el = document.getElementById('p-month-label');
    if (el) el.textContent = MN[calMonth-1] + ' ' + calYear;
  }

  async function loadCalendar() {
    updateMonthLabel();
    const from = `${calYear}-${String(calMonth).padStart(2,'0')}-01`;
    const to   = `${calYear}-${String(calMonth).padStart(2,'0')}-31`;
    calData = {};
    buildGrid();
    try {
      const data = await api(`/api/attendance?from=${from}&to=${to}`);
      if (Array.isArray(data)) {
        calData = {};
        data.forEach(e => { calData[e.workerId + '_' + e.date] = e; });
        buildGrid();
      }
    } catch(err) {
      console.warn('[Presencia] Error cargando datos:', err.message);
    }
  }

  function buildGrid() {
    const grid = document.getElementById('p-cal-grid');
    if (!grid) return;
    const WORKERS      = CFG.workers;
    const daysInMonth  = new Date(calYear, calMonth, 0).getDate();
    const today        = new Date().toISOString().slice(0,10);
    const days = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${calYear}-${String(calMonth).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const dow  = new Date(calYear, calMonth-1, d).getDay();
      days.push({ d, date, dow, weekend: dow===0||dow===6 });
    }

    let html = `<div style="display:grid;grid-template-columns:100px repeat(${days.length},minmax(26px,1fr));gap:1px;font-size:10px">`;

    html += `<div style="padding:4px 6px;color:var(--text3);font-size:9px;font-weight:600;border-bottom:1px solid var(--border)">Trabajador</div>`;
    days.forEach(({ d, date, dow, weekend }) => {
      const isToday = date === today;
      html += `<div style="text-align:center;padding:2px 1px;border-bottom:1px solid var(--border);background:${weekend?'rgba(245,158,11,.05)':''}">
        <div style="font-size:7px;color:${weekend?'var(--amber)':'var(--text3)'}">${DN[dow]}</div>
        <div style="font-size:10px;font-weight:${isToday?'700':'400'};color:${isToday?'var(--blue)':weekend?'var(--amber)':'var(--text2)'}">${d}</div>
      </div>`;
    });

    WORKERS.forEach(w => {
      html += `<div style="padding:4px 8px;color:var(--text2);font-size:10px;font-weight:500;border-right:1px solid var(--border);display:flex;align-items:center;gap:4px;white-space:nowrap">
        <div style="width:6px;height:6px;border-radius:50%;background:${w.color};flex-shrink:0"></div>
        ${w.name.split(' ')[0]}
      </div>`;
      days.forEach(({ date, weekend }) => {
        const entry       = calData[w.id + '_' + date];
        const est         = entry ? ESTADOS[entry.estado] : null;
        const tieneEquipo = entry?.equipo?.length > 0;
        const numObras    = (entry?.obras?.length) || 0;
        const bg          = est ? est.color+'28' : weekend ? 'rgba(245,158,11,.06)' : 'var(--bg3)';
        const border      = est ? est.color+'55'  : weekend ? 'rgba(245,158,11,.25)' : 'var(--border)';
        // Etiqueta: cliente principal + "+N" si hubo varias obras ese día
        const clientLabel = entry?.clientName
          ? entry.clientName.slice(0,8) + (numObras > 1 ? ' +'+(numObras-1) : '')
          : '';
        const tooltip     = est
          ? (numObras > 1
              ? `${est.label} — ${entry.obras.map(o=>o.clientName+' ('+o.horas+'h)').join(', ')}${tieneEquipo?' · '+entry.equipo.length+' personas':''}`
              : `${est.label}${entry.clientName?' — '+entry.clientName:''}${tieneEquipo?' · '+entry.equipo.length+' personas':''}`)
          : weekend ? 'Fin de semana' : 'Sin registrar';

        html += `<div
          data-wid="${w.id}" data-wname="${w.name}" data-date="${date}" data-clickable="true"
          style="min-height:36px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;background:${bg};border:1px solid ${border};border-radius:3px;cursor:pointer;padding:1px;transition:opacity .15s"
          title="${tooltip}">
          <div style="font-size:11px;line-height:1">${est ? est.emoji : weekend ? '⭐' : ''}</div>
          <div style="font-size:7px;color:${numObras>1?'var(--blue)':'var(--text3)'};overflow:hidden;max-width:100%;white-space:nowrap;text-overflow:ellipsis;padding:0 2px">${clientLabel}</div>
          <div style="font-size:8px;line-height:1;display:flex;gap:1px">
            ${entry?.tieneParte ? '<span title="Tiene parte">📋</span>' : ''}
            ${tieneEquipo ? '<span title="Con ayudantes">👥</span>' : ''}
          </div>
        </div>`;
      });
    });

    html += '</div>';
    grid.innerHTML = html;

    grid.addEventListener('click', e => {
      const cell = e.target.closest('[data-date]');
      if (!cell || cell.dataset.clickable !== 'true') return;
      openModal(cell.dataset.wid, cell.dataset.wname, cell.dataset.date);
    });
    grid.addEventListener('mouseover', e => { const c=e.target.closest('[data-clickable="true"]'); if(c) c.style.opacity='.7'; });
    grid.addEventListener('mouseout',  e => { const c=e.target.closest('[data-clickable="true"]'); if(c) c.style.opacity='1'; });
  }

  function prevMonth() { if(calMonth===1){calMonth=12;calYear--;}else calMonth--; loadCalendar(); }
  function nextMonth() { if(calMonth===12){calMonth=1;calYear++;}else calMonth++; loadCalendar(); }
  function goToday()   { const n=new Date(); calYear=n.getFullYear(); calMonth=n.getMonth()+1; loadCalendar(); }

  function openModal(wid, wname, date) {
    modalWorker      = wid;
    modalDate        = date;
    _equipoPresencia = [];
    _libresPresencia = [];

    const entry         = calData[wid + '_' + date];
    const esFinDeSemana = CFG.esFinDeSemana(date);
    selectedEstado      = entry ? entry.estado : (esFinDeSemana ? 'obra' : null);

    if (entry?.equipo) {
      _equipoPresencia = entry.equipo.filter(m => m.tipo === 'plantilla' || m.tipo === 'externo');
      _libresPresencia = entry.equipo.filter(m => m.tipo === 'libre');
    }

    document.getElementById('p-modal')?.remove();
    const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('es-ES', { weekday:'long', day:'numeric', month:'long' });
    const WORKERS   = CFG.workers;

    // Obras del día (estado 'obra'): lista editable cliente+horas.
    // Se rellena desde entry.obras (multi), o desde clientName/horas (single), o una fila vacía.
    if (entry && Array.isArray(entry.obras) && entry.obras.length) {
      _obrasModal = entry.obras.map(o => ({ clientName: o.clientName || '', horas: o.horas }));
    } else if (entry && entry.estado === 'obra' && entry.clientName) {
      _obrasModal = [{ clientName: entry.clientName, horas: entry.horas }];
    } else {
      _obrasModal = [{ clientName: '', horas: '' }];
    }


    const modal = document.createElement('div');
    modal.id = 'p-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto';

    modal.innerHTML = `
      <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:16px;padding:22px;width:100%;max-width:440px;margin:auto">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">
          <div>
            <div style="font-weight:600;font-size:15px">${wname}</div>
            <div style="font-size:12px;color:var(--text3);margin-top:2px">${dateLabel}</div>
          </div>
          <button onclick="document.getElementById('p-modal').remove()" style="background:none;border:none;color:var(--text3);font-size:18px;cursor:pointer;padding:4px">✕</button>
        </div>

        ${esFinDeSemana ? `
        <div style="background:rgba(245,158,11,.1);border:1.5px solid rgba(245,158,11,.35);border-radius:10px;padding:12px 14px;margin-bottom:14px;display:flex;align-items:center;gap:10px">
          <span style="font-size:22px">⭐</span>
          <div>
            <div style="font-size:13px;font-weight:700;color:var(--amber)">Jornada extra</div>
            <div style="font-size:11px;color:rgba(245,158,11,.8)">Fin de semana — se registrará como jornada extra</div>
          </div>
        </div>` : ''}

        <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Estado</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:14px">
          ${Object.entries(ESTADOS).map(([k,v]) => `
            <button id="p-est-${k}" onclick="CP.Presencia._selectEstado('${k}')"
              style="background:${selectedEstado===k?v.color+'33':'var(--bg3)'};border:1px solid ${selectedEstado===k?v.color:'var(--border2)'};border-radius:8px;padding:8px;cursor:pointer;color:var(--text);text-align:left;font-family:'Inter',sans-serif;transition:all .15s">
              <span style="font-size:15px">${v.emoji}</span>
              <div style="font-size:11px;margin-top:3px">${v.label}</div>
            </button>`).join('')}
        </div>

        <div id="p-obra-fields" style="display:${selectedEstado==='obra'?'block':'none'}">
          <div style="margin-bottom:12px">
            <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px">Cliente / Obra · Horas</div>
            <div id="p-obras-rows">${_obrasModal.map((o,i)=>_obraRowHtml(o,i)).join('')}</div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px">
              <button type="button" onclick="CP.Presencia._addObraRow()"
                style="background:none;border:1px dashed var(--border2);border-radius:8px;color:var(--text2);cursor:pointer;padding:6px 12px;font-size:12px;font-family:'Inter',sans-serif">+ Añadir obra</button>
              <span id="p-obras-total" style="font-size:11px;color:var(--text3)"></span>
            </div>
            <datalist id="p-clients-datalist"></datalist>
          </div>
          <div style="margin-bottom:10px">
            <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Quién estuvo ese día</div>
            <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px" id="p-equipo-chips">
              ${WORKERS.filter(w => w.id !== wid).map(w => {
                const enEquipo = _equipoPresencia.some(m => m.id === w.id);
                return `<button type="button" class="p-chip ${enEquipo?'on':''}"
                  data-id="${w.id}" data-nombre="${w.name}" data-tipo="plantilla"
                  onclick="CP.Presencia._toggleChipEquipo(this)">
                  ${w.name.split(' ')[0]}
                </button>`;
              }).join('')}
            </div>
            <div style="display:flex;gap:6px;margin-bottom:6px">
              <input type="text" id="p-externo-libre" placeholder="Añadir persona no registrada..."
                style="flex:1;background:var(--bg3);border:1.5px dashed var(--border2);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px;outline:none;font-family:'Inter',sans-serif">
              <button onclick="CP.Presencia._addExternoPresencia()"
                style="background:var(--bg3);border:1.5px dashed var(--border2);border-radius:8px;padding:8px 12px;color:var(--text3);font-size:13px;cursor:pointer;font-family:'Inter',sans-serif">
                + Añadir
              </button>
            </div>
            <div id="p-libres-chips" style="display:flex;flex-wrap:wrap;gap:5px"></div>
          </div>
        </div>

        <div style="margin-bottom:12px">
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:10px 14px">
            <input type="checkbox" id="p-tiene-parte" ${entry?.tieneParte?'checked':''} style="width:18px;height:18px;cursor:pointer;accent-color:var(--blue)">
            <div>
              <div style="font-size:13px;font-weight:600">📋 Tiene parte de trabajo</div>
              <div style="font-size:11px;color:var(--text3);margin-top:1px">El trabajador ha subido un parte para este día</div>
            </div>
          </label>
        </div>

        <div style="display:flex;gap:10px;margin-bottom:16px">
          <div style="flex:1;display:${selectedEstado==='obra'?'none':'block'}" id="p-horas-wrap">
            <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px">Horas</div>
            <input type="number" id="p-horas" value="${entry?.horas||8}" min="1" max="16"
              style="width:80px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px;outline:none">
          </div>
          <div style="flex:2">
            <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px">Notas</div>
            <input type="text" id="p-notas" value="${entry?.notas||''}" placeholder="Observaciones..."
              style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px;outline:none;font-family:'Inter',sans-serif">
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
    modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });

    _renderObrasRows();

    _libresPresencia.forEach((m, i) => {
      const cont = document.getElementById('p-libres-chips');
      if (!cont) return;
      const chip = document.createElement('span');
      chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;background:rgba(167,139,250,.12);border:1.5px solid rgba(167,139,250,.4);border-radius:20px;padding:5px 12px;font-size:12px;color:var(--purple)';
      chip.dataset.index = i;
      chip.innerHTML = `👤 ${m.nombre} <button onclick="CP.Presencia._removeLibre(${i},this)" style="background:none;border:none;color:var(--purple);cursor:pointer;font-size:13px;padding:0;line-height:1">✕</button>`;
      cont.appendChild(chip);
    });

    loadClientSuggestions();
  }

  async function loadClientSuggestions() {
    const dl = document.getElementById('p-clients-datalist');
    if (!dl) return;
    try {
      if (!window._cpClients) {
        const names = await api('/api/clients/list');
        window._cpClients = Array.isArray(names) ? names : [];
      }
      dl.innerHTML = window._cpClients.map(n=>`<option value="${n}">`).join('');
    } catch(err) {}
  }

  function _removeLibre(index, btn) {
    _libresPresencia.splice(index, 1);
    btn.parentElement.remove();
    document.querySelectorAll('#p-libres-chips span').forEach((chip, i) => {
      const b = chip.querySelector('button');
      if (b) b.setAttribute('onclick', `CP.Presencia._removeLibre(${i},this)`);
    });
  }

  function _selectEstado(k) {
    selectedEstado = k;
    Object.keys(ESTADOS).forEach(s => {
      const btn = document.getElementById('p-est-' + s);
      if (!btn) return;
      btn.style.background  = s===k ? ESTADOS[s].color+'33' : 'var(--bg3)';
      btn.style.borderColor = s===k ? ESTADOS[s].color      : 'var(--border2)';
    });
    const obraFields = document.getElementById('p-obra-fields');
    if (obraFields) obraFields.style.display = k==='obra' ? 'block' : 'none';
    const horasWrap = document.getElementById('p-horas-wrap');
    if (horasWrap) horasWrap.style.display = k==='obra' ? 'none' : 'block';
    if (k==='obra') _updateObrasTotal();
  }

  function _toggleChipEquipo(btn) {
    const idx = _equipoPresencia.findIndex(m => m.id === btn.dataset.id);
    if (idx >= 0) { _equipoPresencia.splice(idx, 1); btn.classList.remove('on'); }
    else          { _equipoPresencia.push({ id: btn.dataset.id, nombre: btn.dataset.nombre, tipo: btn.dataset.tipo }); btn.classList.add('on'); }
  }

  function _addExternoPresencia() {
    const input  = document.getElementById('p-externo-libre');
    const nombre = input?.value?.trim();
    if (!nombre) return;
    const i = _libresPresencia.length;
    _libresPresencia.push({ nombre, tipo: 'libre' });
    input.value = '';
    const cont = document.getElementById('p-libres-chips');
    if (!cont) return;
    const chip = document.createElement('span');
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;background:rgba(167,139,250,.12);border:1.5px solid rgba(167,139,250,.4);border-radius:20px;padding:5px 12px;font-size:12px;color:var(--purple)';
    chip.innerHTML = `👤 ${nombre} <button onclick="CP.Presencia._removeLibre(${i},this)" style="background:none;border:none;color:var(--purple);cursor:pointer;font-size:13px;padding:0;line-height:1">✕</button>`;
    cont.appendChild(chip);
  }

  // ── OBRAS DEL DÍA (lista editable cliente+horas) ──────────────────
  function _obraRowHtml(o, i) {
    const cli = String(o.clientName || '').replace(/"/g, '&quot;');
    const h   = (o.horas != null && o.horas !== '') ? o.horas : '';
    return `<div class="p-obra-row" data-i="${i}" style="display:flex;gap:6px;margin-bottom:6px">
      <input type="text" class="p-obra-cli" value="${cli}" placeholder="Buscar cliente / obra..." list="p-clients-datalist" autocomplete="off"
        style="flex:1;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:9px 12px;color:var(--text);font-size:13px;outline:none;font-family:'Inter',sans-serif">
      <input type="number" class="p-obra-h" value="${h}" placeholder="h" min="0.5" max="16" step="0.5"
        oninput="CP.Presencia._updateObrasTotal()"
        style="width:62px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:9px 6px;color:var(--text);font-size:13px;outline:none;text-align:center">
      <button type="button" onclick="CP.Presencia._removeObraRow(${i})" title="Quitar obra"
        style="background:var(--bg3);border:1px solid var(--border2);border-radius:8px;color:var(--text3);cursor:pointer;padding:0 11px;font-size:13px">✕</button>
    </div>`;
  }

  function _readObrasFromDOM() {
    const rows = document.querySelectorAll('#p-obras-rows .p-obra-row');
    const arr = [];
    rows.forEach(r => {
      const clientName = r.querySelector('.p-obra-cli')?.value?.trim() || '';
      const raw = r.querySelector('.p-obra-h')?.value;
      const horas = (raw === '' || raw == null) ? '' : parseFloat(raw);
      arr.push({ clientName, horas: isNaN(horas) ? '' : horas });
    });
    return arr;
  }

  function _renderObrasRows() {
    const cont = document.getElementById('p-obras-rows');
    if (!cont) return;
    cont.innerHTML = _obrasModal.map((o,i) => _obraRowHtml(o,i)).join('');
    _updateObrasTotal();
  }

  function _updateObrasTotal() {
    const el = document.getElementById('p-obras-total');
    if (!el) return;
    const total = _readObrasFromDOM().reduce((s,o) => s + (parseFloat(o.horas)||0), 0);
    el.textContent = total > 0 ? `Total: ${total} h` : '';
  }

  function _addObraRow() {
    _obrasModal = _readObrasFromDOM();
    _obrasModal.push({ clientName: '', horas: '' });
    _renderObrasRows();
  }

  function _removeObraRow(i) {
    _obrasModal = _readObrasFromDOM();
    _obrasModal.splice(i, 1);
    if (!_obrasModal.length) _obrasModal.push({ clientName: '', horas: '' });
    _renderObrasRows();
  }

  async function _saveEntry() {
    if (!selectedEstado) {
      const msg = document.getElementById('p-modal-msg');
      if (msg) { msg.textContent='⚠️ Selecciona un estado primero'; msg.style.display='block'; msg.style.color='var(--amber)'; }
      return;
    }
    const workerInfo = CFG.workers.find(w => w.id === modalWorker);
    const msg = document.getElementById('p-modal-msg');

    // En estado 'obra' las horas y el cliente salen de la lista de obras.
    let clientName = '', horas = 0, obras = null;
    if (selectedEstado === 'obra') {
      const valid = _readObrasFromDOM().filter(o => o.clientName);
      if (!valid.length) {
        if (msg) { msg.textContent='⚠️ Añade al menos una obra con cliente'; msg.style.display='block'; msg.style.color='var(--amber)'; }
        return;
      }
      obras      = valid.map(o => ({ clientName: o.clientName, horas: parseFloat(o.horas) || 0 }));
      clientName = obras[0].clientName;
      horas      = obras.reduce((s,o) => s + o.horas, 0);
    } else {
      horas = parseFloat(document.getElementById('p-horas')?.value || 8);
    }

    const entry = {
      workerId:    modalWorker,
      workerName:  workerInfo?.name || '',
      date:        modalDate,
      estado:      selectedEstado,
      clientName,
      horas,
      notas:       document.getElementById('p-notas')?.value?.trim() || '',
      tieneParte:  document.getElementById('p-tiene-parte')?.checked || false,
      tipoJornada: CFG.tipoJornadaPorFecha(modalDate),
      equipo:      [..._equipoPresencia, ..._libresPresencia],
    };
    if (obras) entry.obras = obras;
    if (msg) { msg.textContent='⏳ Guardando...'; msg.style.display='block'; msg.style.color='var(--text2)'; }
    try {
      await api('/api/attendance', { method:'POST', body: JSON.stringify(entry) });
      document.getElementById('p-modal')?.remove();
      loadCalendar();
    } catch(err) {
      if (msg) { msg.textContent='❌ Error: '+err.message; msg.style.color='var(--red)'; }
    }
  }

  async function _deleteEntry() {
    try {
      await api(`/api/attendance/${modalWorker}/${modalDate}`, { method:'DELETE' });
      document.getElementById('p-modal')?.remove();
      loadCalendar();
    } catch(err) { console.error('[Presencia] Error delete:', err.message); }
  }

  function prevSumMonth() { if(sumMonth2===1){sumMonth2=12;sumYear2--;}else sumMonth2--; loadSummary(); }
  function nextSumMonth() { if(sumMonth2===12){sumMonth2=1;sumYear2++;}else sumMonth2++; loadSummary(); }

  async function loadSummary() {
    const el = document.getElementById('p-sum-label');
    if (el) el.textContent = MN[sumMonth2-1] + ' ' + sumYear2;
    try {
      const data = await api(`/api/attendance/summary/${sumYear2}/${sumMonth2}`);
      const eur  = v => new Intl.NumberFormat('es-ES',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(v||0);

      const totalObra      = data.byWorker.reduce((s,w) => s+(w.dias_obra||0), 0);
      const totalFalta     = data.byWorker.reduce((s,w) => s+(w.dias_falta||0), 0);
      const totalBaja      = data.byWorker.reduce((s,w) => s+(w.dias_baja||0), 0);
      const totalHorasProd = data.byWorker.reduce((s,w) => s+(w.horas_productivas||w.horas||0), 0);
      const totalCoste     = data.byWorker.reduce((s,w) => s+(w.coste_real||0), 0);
      const uniqueDates    = new Set((data.entries||[]).map(e=>e.date));

      const metrics = document.getElementById('p-sum-metrics');
      if (metrics) metrics.innerHTML = `
        <div class="mc"><div class="ml">Días registrados</div><div class="mv b">${uniqueDates.size}</div></div>
        <div class="mc"><div class="ml">Días en obra</div><div class="mv g">${totalObra}</div></div>
        <div class="mc"><div class="ml">Faltas/bajas</div><div class="mv r">${totalFalta + totalBaja}</div></div>
        <div class="mc"><div class="ml">Horas productivas</div><div class="mv b">${totalHorasProd.toFixed(0)} h</div></div>
        <div class="mc"><div class="ml">Coste total</div><div class="mv r">${eur(totalCoste)}</div></div>`;

      const tbl = document.getElementById('p-sum-table');
      if (tbl) tbl.innerHTML = `<table>
        <thead><tr>
          <th>Trabajador</th>
          <th style="text-align:right">Días</th>
          <th style="text-align:right">En obra</th>
          <th style="text-align:right">Baja/Vac</th>
          <th style="text-align:right">Faltas</th>
          <th style="text-align:right">Horas prod.</th>
          <th style="text-align:right">Coste real</th>
        </tr></thead>
        <tbody>${data.byWorker.map(w => {
          const diasAus = (w.dias_baja||0) + (w.dias_vacaciones||0);
          return `<tr>
            <td>
              <span style="display:flex;align-items:center;gap:6px">
                <span style="width:7px;height:7px;border-radius:50%;background:${w.color};display:inline-block"></span>
                <strong>${w.name}</strong>
                ${w.nota ? `<span style="font-size:9px;color:var(--amber);background:rgba(245,158,11,.1);padding:1px 5px;border-radius:4px">${w.nota}</span>` : ''}
              </span>
            </td>
            <td style="text-align:right">${w.dias}</td>
            <td style="text-align:right;color:var(--green)">${w.dias_obra||0}</td>
            <td style="text-align:right;color:${diasAus>0?'var(--amber)':'var(--text2)'}">${diasAus||'—'}</td>
            <td style="text-align:right;color:${(w.dias_falta||0)>0?'var(--red)':'var(--text2)'}">${w.dias_falta||'—'}</td>
            <td style="text-align:right">${(w.horas_productivas||w.horas||0).toFixed(0)} h</td>
            <td style="text-align:right;color:var(--red)">${eur(w.coste_real||0)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;

      const clients = data.clientSummary || [];
      const cEl = document.getElementById('p-sum-clients');
      if (cEl) {
        if (!clients.length) {
          cEl.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:10px">No hay días en obra este mes.</div>';
        } else {
          cEl.innerHTML = `<table>
            <thead><tr>
              <th>Cliente / Obra</th>
              <th style="text-align:right">Días únicos</th>
              <th style="text-align:right">Pers/día</th>
              <th style="text-align:right">Horas</th>
              <th style="text-align:right">Coste est.</th>
              <th>Detalle</th>
            </tr></thead>
            <tbody>${clients.map(c=>`<tr>
              <td><strong>${c.client}</strong></td>
              <td style="text-align:right;color:var(--green)">${c.dias_unicos}</td>
              <td style="text-align:right;color:var(--text3);font-size:11px">${c.dias_persona}</td>
              <td style="text-align:right">${c.horas.toFixed(0)} h</td>
              <td style="text-align:right;color:var(--red)">${eur(c.coste)}</td>
              <td style="font-size:11px;color:var(--text2)">${Object.entries(c.workers).map(([n,d])=>`${n.split(' ')[0]}:${d}d`).join(' · ')}</td>
            </tr>`).join('')}</tbody>
          </table>`;
        }
      }

      // ── Sección ayudantes externos ─────────────────────────────
      // Nombres de plantilla normalizados (sin mayúsculas/acentos), para no
      // listar como externo a quien ya es trabajador de plantilla.
      const _norm = s => (s||'').toString().trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
      const registeredNames = new Set((CFG.workers || []).map(w => _norm(w.name)));
      const ayudantesMap = {};
      (data.entries || []).forEach(e => {
        if (!e.equipo) return;
        e.equipo.forEach(m => {
          if (m.tipo !== 'libre' && m.tipo !== 'externo') return;
          const nombre = m.nombre || '?';
          if (registeredNames.has(_norm(nombre))) return;
          if (!ayudantesMap[nombre]) ayudantesMap[nombre] = { dias: 0, obras: {} };
          ayudantesMap[nombre].dias++;
          const cliente = e.clientName || 'Sin cliente';
          ayudantesMap[nombre].obras[cliente] = (ayudantesMap[nombre].obras[cliente] || 0) + 1;
        });
      });

      const ayudantesList = Object.entries(ayudantesMap).sort((a,b) => b[1].dias - a[1].dias);
      const ayCard = document.getElementById('p-ayudantes-card');

      if (ayCard) {
        if (!ayudantesList.length) {
          ayCard.style.display = 'none';
          ayCard.innerHTML = '';
        } else {
          const totalDiasAy = ayudantesList.reduce((s,[,v]) => s+v.dias, 0);
          const totalCosteAy = totalDiasAy * 8 * 10;
          ayCard.style.display = 'block';
          ayCard.className = 'card';
          ayCard.innerHTML = `
            <div class="card-title">👥 Ayudantes / Colaboradores externos</div>
            <table>
              <thead><tr>
                <th>Nombre</th>
                <th style="text-align:right">Días</th>
                <th style="text-align:right">Horas est.</th>
                <th>Obras / Clientes</th>
                <th style="text-align:right">Coste est.</th>
              </tr></thead>
              <tbody>${ayudantesList.map(([nombre, info]) => {
                const dias      = info.dias;
                const horasEst  = dias * 8;
                const costeEst  = horasEst * 10;
                const obrasStr  = Object.entries(info.obras)
                  .map(([c,d]) => `${c}: ${d}d`).join(' · ');
                return `<tr>
                  <td>
                    <strong>👤 ${nombre}</strong>
                    <div style="font-size:10px;color:var(--amber)">Sin alta · pago efectivo</div>
                  </td>
                  <td style="text-align:right;font-weight:600">${dias}</td>
                  <td style="text-align:right">${horasEst} h</td>
                  <td style="font-size:11px;color:var(--text2)">${obrasStr || '—'}</td>
                  <td style="text-align:right;color:var(--amber);font-weight:600">~${eur(costeEst)}</td>
                </tr>`;
              }).join('')}</tbody>
              <tfoot><tr>
                <td><strong>Total ayudantes</strong></td>
                <td style="text-align:right;font-weight:600">${totalDiasAy}d</td>
                <td style="text-align:right;font-weight:600">${totalDiasAy*8} h</td>
                <td></td>
                <td style="text-align:right;color:var(--amber);font-weight:600">~${eur(totalCosteAy)}</td>
              </tr></tfoot>
            </table>
            <div class="alert awa" style="margin-top:12px">
              <div>⚠️</div>
              <div>Coste estimado a <strong>10€/h por defecto</strong>. Se actualizará con el rate real cuando esté registrado en el módulo de pagos en efectivo.</div>
            </div>`;
        }
      }

    } catch(err) { console.error('[Presencia] Error summary:', err.message); }
  }

  async function searchClient() {
    const name = document.getElementById('p-client-search')?.value?.trim() || '';
    const from = document.getElementById('p-client-from')?.value || '';
    const to   = document.getElementById('p-client-to')?.value   || '';
    if (!name) return;
    const el = document.getElementById('p-client-result');
    if (el) el.innerHTML = '<div style="color:var(--text3);font-size:12px">Buscando...</div>';
    try {
      const data    = await api(`/api/attendance/client?clientName=${encodeURIComponent(name)}&from=${from}&to=${to}`);
      const eur     = v => new Intl.NumberFormat('es-ES',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(v||0);
      const workers = Object.values(data.byWorker||{});
      if (!data.totalDias) {
        if(el) el.innerHTML='<div style="color:var(--text3);font-size:12px;padding:10px">Sin registros para este cliente.</div>';
        return;
      }
      const totalCoste = workers.reduce((s,w)=>{
        const wd = CFG.workers.find(x=>x.name===w.name);
        return s+(wd ? w.horas*(wd.rate||wd.costeHora||15) : 0);
      },0);
      if (el) el.innerHTML = `
        <div class="metrics-row" style="margin-bottom:14px">
          <div class="mc"><div class="ml">Total días</div><div class="mv g">${data.totalDias}</div></div>
          <div class="mc"><div class="ml">Total horas</div><div class="mv g">${workers.reduce((s,w)=>s+w.horas,0).toFixed(0)} h</div></div>
          <div class="mc"><div class="ml">Coste personal</div><div class="mv r">${eur(totalCoste)}</div></div>
        </div>
        <table><thead><tr><th>Trabajador</th><th style="text-align:right">Días</th><th style="text-align:right">Horas</th><th style="text-align:right">Coste</th><th>Fechas</th></tr></thead>
        <tbody>${workers.map(w=>{
          const wd=CFG.workers.find(x=>x.name===w.name);
          return`<tr>
            <td><strong>${w.name}</strong></td>
            <td style="text-align:right">${w.dias}</td>
            <td style="text-align:right">${w.horas.toFixed(0)} h</td>
            <td style="text-align:right;color:var(--red)">${eur(wd?w.horas*(wd.rate||wd.costeHora||15):0)}</td>
            <td style="font-size:10px;color:var(--text3)">${w.dates.slice(0,5).map(d=>new Date(d+'T12:00:00').toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit'})).join(', ')}${w.dates.length>5?` +${w.dates.length-5} más`:''}</td>
          </tr>`;
        }).join('')}</tbody></table>`;
    } catch(err) { if(el) el.innerHTML=`<div style="color:var(--red);font-size:12px">Error: ${err.message}</div>`; }
  }

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
    const WORKERS = CFG.workers;
    let totalPersonal = 0;
    WORKERS.forEach(w => {
      const dias  = parseFloat(document.getElementById('calc-d-'+w.id)?.value||0);
      const extra = parseFloat(document.getElementById('calc-h-'+w.id)?.value||0);
      const rate  = w.rate || w.costeHora || 15;
      const cost  = (dias*8+extra)*rate;
      totalPersonal += cost;
      const el = document.getElementById('calc-c-'+w.id);
      if (el) el.textContent = eur(cost);
    });
    let totalMat = 0;
    document.querySelectorAll('.calc-mat-row input[type="number"]').forEach(inp=>{ totalMat+=parseFloat(inp.value||0); });
    const total  = totalPersonal + totalMat;
    const precio = parseFloat(document.getElementById('calc-precio')?.value||0);
    const nombre = document.getElementById('calc-nombre')?.value||'Obra';
    const setEl  = (id,val) => { const e=document.getElementById(id); if(e) e.textContent=val; };
    setEl('calc-personal',  eur(totalPersonal));
    setEl('calc-personal2', eur(totalPersonal));
    setEl('calc-mat',       eur(totalMat));
    setEl('calc-total',     eur(total));
    const res = document.getElementById('calc-result');
    if (!res) return;
    if (!precio) { res.innerHTML='<div style="font-size:12px;color:var(--text3)">Introduce el precio presupuestado para ver el resultado.</div>'; return; }
    const beneficio = precio-total;
    const margen    = precio>0?(beneficio/precio*100):0;
    const ok        = beneficio>0;
    res.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px">
        <div><div style="font-size:9px;color:var(--text3);margin-bottom:3px">Precio</div><div style="font-size:16px;font-weight:700;color:var(--green);font-family:'Space Grotesk',sans-serif">${eur(precio)}</div></div>
        <div><div style="font-size:9px;color:var(--text3);margin-bottom:3px">Coste total</div><div style="font-size:16px;font-weight:700;color:var(--red);font-family:'Space Grotesk',sans-serif">${eur(total)}</div></div>
        <div><div style="font-size:9px;color:var(--text3);margin-bottom:3px">Beneficio</div><div style="font-size:16px;font-weight:700;color:${ok?'var(--green)':'var(--red)'};font-family:'Space Grotesk',sans-serif">${ok?'+':''}${eur(beneficio)}</div></div>
        <div><div style="font-size:9px;color:var(--text3);margin-bottom:3px">Margen</div><div style="font-size:16px;font-weight:700;color:${margen>20?'var(--green)':margen>0?'var(--amber)':'var(--red)'};font-family:'Space Grotesk',sans-serif">${margen.toFixed(1)}%</div></div>
      </div>
      <div style="padding:10px;background:${ok?'var(--green-bg)':'var(--red-bg)'};border-radius:8px;border:1px solid ${ok?'rgba(34,196,135,.3)':'rgba(240,82,82,.3)'};font-size:12px;color:${ok?'var(--green)':'var(--red)'}">
        ${ok
          ? `✅ <strong>${nombre}</strong> — Obra rentable. ${eur(beneficio)} de beneficio con ${margen.toFixed(1)}% de margen.${margen<20?' Margen ajustado.':' Buen margen.'}`
          : `🚨 <strong>${nombre}</strong> — Pérdidas de ${eur(Math.abs(beneficio))}. Precio mínimo para 20%: ${eur(total*1.2)}`}
      </div>`;
  }

  function openReport() {
    const tok = localStorage.getItem('cp_token');
    window.open(`/informe-presencia?year=${sumYear2}&month=${sumMonth2}&token=${tok}`, '_blank');
  }

  async function exportCSV() {
    try {
      const data = await api(`/api/attendance?from=${sumYear2}-${String(sumMonth2).padStart(2,'0')}-01&to=${sumYear2}-${String(sumMonth2).padStart(2,'0')}-31`);
      if (!data?.length) return;
      const rows = [['Fecha','Trabajador','Estado','Cliente/Obra','Horas','Jornada','Equipo','Notas']];
      data.forEach(e => {
        const equipoStr = (e.equipo||[]).map(m=>m.nombre||m.name).join('+');
        rows.push([e.date, e.workerName, ESTADOS[e.estado]?.label||e.estado, e.clientName||'', e.horas||8, e.tipoJornada||'NORMAL', equipoStr, e.notas||'']);
      });
      const csv = rows.map(r=>r.map(v=>`"${v}"`).join(',')).join('\n');
      const a = document.createElement('a');
      a.href = 'data:text/csv;charset=utf-8,\uFEFF'+encodeURIComponent(csv);
      a.download = `presencia_${sumYear2}_${String(sumMonth2).padStart(2,'0')}.csv`;
      a.click();
    } catch(err) { console.error('[Presencia] CSV error:', err.message); }
  }

  CP.Presencia = {
    render, showTab, openReport,
    prevMonth, nextMonth, goToday,
    prevSumMonth, nextSumMonth,
    searchClient, exportCSV,
    addMatRow, calcObra,
    _selectEstado, _saveEntry, _deleteEntry,
    _toggleChipEquipo, _addExternoPresencia, _removeLibre,
    _addObraRow, _removeObraRow, _updateObrasTotal,
  };

})(window.CP = window.CP || {});
