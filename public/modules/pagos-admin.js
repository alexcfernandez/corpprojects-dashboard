// modules/pagos-admin.js — Gestión de pagos en efectivo y adelantos
(function(CP) {
  'use strict';

  const TIPOS = {
    efectivo:   { label: 'Pago efectivo',    emoji: '💵', color: '#f59e0b' },
    adelanto:   { label: 'Adelanto nómina',  emoji: '💰', color: '#4d9cf8' },
    devolucion: { label: 'Devolución',       emoji: '↩️',  color: '#22c487' },
    material:   { label: 'Material efectivo',emoji: '📦', color: '#a78bfa' },
  };

  async function api(url, opts = {}) {
    const tok = localStorage.getItem('cp_token');
    const r   = await fetch(url, {
      ...opts,
      headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json', ...(opts.headers||{}) }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  const eur = v => new Intl.NumberFormat('es-ES',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(v||0);
  const dt  = d => d ? new Date(d+'T12:00:00').toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'}) : '—';

  function render(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;

    el.innerHTML = `
      <div style="display:flex;gap:0;border-bottom:1px solid var(--border);margin-bottom:20px;overflow-x:auto">
        <button class="btab active" onclick="CP.Pagos.showTab('resumen',this)">📊 Resumen</button>
        <button class="btab" onclick="CP.Pagos.showTab('lista',this)">📋 Todos los pagos</button>
        <button class="btab" onclick="CP.Pagos.showTab('nuevo',this)">➕ Registrar pago</button>
      </div>

      <!-- RESUMEN -->
      <div id="pg-tab-resumen" class="p-tab active">
        <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:flex-end">
          <div>
            <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Desde</div>
            <input type="date" id="pg-res-from" class="srch" style="width:145px">
          </div>
          <div>
            <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Hasta</div>
            <input type="date" id="pg-res-to" class="srch" style="width:145px">
          </div>
          <button class="btn bp" onclick="CP.Pagos.loadResumen()">Ver resumen</button>
          <button class="btn bg2" onclick="CP.Pagos.exportCSV()">📥 CSV</button>
        </div>
        <div id="pg-res-metrics" class="metrics-row" style="margin-bottom:14px"></div>
        <div id="pg-res-content">
          <div class="empty"><div class="et">Selecciona un período para ver el resumen</div></div>
        </div>
      </div>

      <!-- LISTA -->
      <div id="pg-tab-lista" class="p-tab" style="display:none">
        <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:flex-end">
          <div>
            <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Persona</div>
            <input type="text" id="pg-f-persona" class="srch" placeholder="Buscar..." style="width:180px" oninput="CP.Pagos.loadLista()">
          </div>
          <div>
            <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Tipo</div>
            <select id="pg-f-tipo" onchange="CP.Pagos.loadLista()" style="background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:var(--rs);padding:7px 10px;font-size:12px">
              <option value="">Todos</option>
              ${Object.entries(TIPOS).map(([k,v])=>`<option value="${k}">${v.emoji} ${v.label}</option>`).join('')}
            </select>
          </div>
          <div>
            <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Desde</div>
            <input type="date" id="pg-f-from" class="srch" style="width:145px" onchange="CP.Pagos.loadLista()">
          </div>
          <div>
            <div style="font-size:10px;color:var(--text3);margin-bottom:4px;text-transform:uppercase">Hasta</div>
            <input type="date" id="pg-f-to" class="srch" style="width:145px" onchange="CP.Pagos.loadLista()">
          </div>
        </div>
        <div class="card">
          <div class="card-title">Pagos registrados <span id="pg-count" style="font-weight:400;color:var(--text3)">—</span></div>
          <div id="pg-lista">Cargando...</div>
        </div>
      </div>

      <!-- NUEVO PAGO -->
      <div id="pg-tab-nuevo" class="p-tab" style="display:none">
        <div class="g2">
          <div class="card" style="max-width:560px">
            <div class="card-title" id="pg-form-title">Registrar pago</div>
            ${renderForm()}
            <div id="pg-form-msg" style="margin-top:10px;font-size:12px;display:none"></div>
            <div style="display:flex;gap:8px;margin-top:14px">
              <button class="btn bp" id="pg-submit-btn" onclick="CP.Pagos.submitPago()">💾 Guardar pago</button>
              <button class="btn bgh" onclick="CP.Pagos.resetForm()">Limpiar</button>
            </div>
          </div>
          <div class="card">
            <div class="card-title">💡 Guía de tipos de pago</div>
            ${Object.entries(TIPOS).map(([k,v])=>`
              <div style="display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)">
                <span style="font-size:20px">${v.emoji}</span>
                <div>
                  <div style="font-weight:600;font-size:13px;color:${v.color}">${v.label}</div>
                  <div style="font-size:11px;color:var(--text3);margin-top:2px">${
                    k==='efectivo'   ? 'Colaborador sin alta que trabaja por días. Indica días trabajados y cliente/obra.' :
                    k==='adelanto'   ? 'Anticipo de nómina a trabajador de plantilla. Se descuenta del siguiente sueldo.' :
                    k==='devolucion' ? 'El trabajador devuelve un adelanto previo.' :
                    'Materiales comprados en efectivo para una obra.'
                  }</div>
                </div>
              </div>`).join('')}
            <div class="alert awa" style="margin-top:12px">
              <div>⚠️</div>
              <div>Todos los pagos en efectivo quedan registrados para control interno. No son facturas.</div>
            </div>
          </div>
        </div>
      </div>`;

    // Cargar resumen del mes actual por defecto
    const hoy    = new Date();
    const from   = `${hoy.getFullYear()}-${String(hoy.getMonth()+1).padStart(2,'0')}-01`;
    const to     = `${hoy.getFullYear()}-${String(hoy.getMonth()+1).padStart(2,'0')}-31`;
    const fromEl = document.getElementById('pg-res-from');
    const toEl   = document.getElementById('pg-res-to');
    if (fromEl) fromEl.value = from;
    if (toEl)   toEl.value   = to;
    loadResumen();
  }

  function renderForm(pago = {}) {
    const WORKERS = window.CP_CONFIG?.workers || [];
    return `
      <div class="field-grid-2" style="margin-bottom:12px">
        <div>
          <span class="field-label">Tipo de pago *</span>
          <select id="pg-tipo" class="field-input" onchange="CP.Pagos._onTipoChange()">
            ${Object.entries(TIPOS).map(([k,v])=>`<option value="${k}" ${pago.tipo===k?'selected':''}>${v.emoji} ${v.label}</option>`).join('')}
          </select>
        </div>
        <div>
          <span class="field-label">Fecha *</span>
          <input type="date" id="pg-fecha" value="${pago.fecha||new Date().toISOString().slice(0,10)}" class="field-input">
        </div>
      </div>
      <div class="field-row">
        <span class="field-label">Persona *</span>
        <input type="text" id="pg-persona" value="${pago.persona||''}" placeholder="Nombre completo..."
          list="pg-personas-list" autocomplete="off" class="field-input">
        <datalist id="pg-personas-list">
          ${WORKERS.map(w=>`<option value="${w.name}">`).join('')}
        </datalist>
        <div style="font-size:10px;color:var(--text3);margin-top:3px">Trabajador de plantilla o colaborador externo</div>
      </div>
      <div class="field-row">
        <span class="field-label">Importe (€) *</span>
        <input type="number" id="pg-importe" value="${pago.importe||''}" min="0" step="0.01" placeholder="0.00" class="field-input" style="width:160px">
      </div>
      <div id="pg-efectivo-fields" style="display:${(!pago.tipo||pago.tipo==='efectivo')?'block':'none'}">
        <div class="field-grid-2" style="margin-bottom:12px">
          <div>
            <span class="field-label">Días trabajados</span>
            <input type="number" id="pg-dias" value="${pago.diasTrabajados||''}" min="0" step="0.5" placeholder="0" class="field-input" oninput="CP.Pagos._calcCosteHora()">
          </div>
          <div>
            <span class="field-label">€/hora real <span style="font-size:9px;color:var(--text3)" id="pg-coste-hora-calc"></span></span>
            <input type="number" id="pg-coste-hora" value="${pago.costeHoraReal||''}" min="0" step="0.01" placeholder="Auto" class="field-input">
          </div>
        </div>
        <div class="field-row">
          <span class="field-label">Cliente / Obra</span>
          <input type="text" id="pg-cliente-obra" value="${pago.clienteObra||''}" placeholder="En qué obra trabajó..."
            list="pg-clientes-list" autocomplete="off" class="field-input">
          <datalist id="pg-clientes-list"></datalist>
        </div>
      </div>
      <div class="field-row">
        <span class="field-label">Concepto / descripción</span>
        <textarea id="pg-concepto" rows="2" class="field-input" style="resize:vertical" placeholder="Describe el pago...">${pago.concepto||''}</textarea>
      </div>
      <div class="field-row">
        <span class="field-label">Notas internas</span>
        <input type="text" id="pg-notas" value="${pago.notas||''}" placeholder="Solo visible para admin..." class="field-input">
      </div>`;
  }

  function showTab(id, btn) {
    document.querySelectorAll('#pagos-container .p-tab').forEach(p => { p.style.display='none'; p.classList.remove('active'); });
    document.querySelectorAll('#pagos-container .btab').forEach(b => b.classList.remove('active'));
    const tab = document.getElementById('pg-tab-' + id);
    if (tab) { tab.style.display='block'; tab.classList.add('active'); }
    if (btn) btn.classList.add('active');
    if (id === 'lista')   loadLista();
    if (id === 'nuevo')   loadClientesSuggestions();
    if (id === 'resumen') loadResumen();
  }

  function _onTipoChange() {
    const tipo    = document.getElementById('pg-tipo')?.value;
    const fields  = document.getElementById('pg-efectivo-fields');
    if (fields) fields.style.display = tipo === 'efectivo' ? 'block' : 'none';
  }

  function _calcCosteHora() {
    const importe = parseFloat(document.getElementById('pg-importe')?.value || 0);
    const dias    = parseFloat(document.getElementById('pg-dias')?.value    || 0);
    const el      = document.getElementById('pg-coste-hora-calc');
    if (!el) return;
    if (importe > 0 && dias > 0) {
      const horas     = dias * 8;
      const costeHora = (importe / horas).toFixed(2);
      el.textContent  = `→ ${costeHora}€/h calculado`;
      const inp = document.getElementById('pg-coste-hora');
      if (inp && !inp.value) inp.value = costeHora;
    } else {
      el.textContent = '';
    }
  }

  async function loadClientesSuggestions() {
    try {
      if (!window._cpClients) {
        const tok  = localStorage.getItem('cp_token');
        const names = await fetch('/api/clients/list', { headers:{ Authorization:`Bearer ${tok}` } }).then(r=>r.json());
        window._cpClients = Array.isArray(names) ? names : [];
      }
      const dl = document.getElementById('pg-clientes-list');
      if (dl) dl.innerHTML = window._cpClients.map(n=>`<option value="${n}">`).join('');
    } catch(e) {}
  }

  async function loadResumen() {
    const from = document.getElementById('pg-res-from')?.value || '';
    const to   = document.getElementById('pg-res-to')?.value   || '';
    const el   = document.getElementById('pg-res-content');
    if (!el) return;
    el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:10px">Cargando...</div>';
    try {
      const data    = await api(`/api/pagos/resumen?from=${from}&to=${to}`);
      const metrics = document.getElementById('pg-res-metrics');
      if (metrics) metrics.innerHTML = `
        <div class="mc"><div class="ml">Total pagado</div><div class="mv r">${eur(data.totales.total)}</div></div>
        <div class="mc"><div class="ml">Efectivo colaboradores</div><div class="mv a">${eur(data.totales.efectivo)}</div></div>
        <div class="mc"><div class="ml">Adelantos nómina</div><div class="mv b">${eur(data.totales.adelantos)}</div></div>
        <div class="mc"><div class="ml">Material efectivo</div><div class="mv p">${eur(data.totales.material)}</div></div>
        <div class="mc"><div class="ml">Personas pagadas</div><div class="mv b">${data.byPersona.length}</div></div>`;

      if (!data.pagos.length) {
        el.innerHTML = '<div class="empty"><div class="ei">💵</div><div class="et">No hay pagos en este período</div></div>';
        return;
      }

      el.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:12px">
          ${data.byPersona.map(p => `
            <div class="card" style="margin-bottom:0">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
                <div>
                  <div style="font-weight:700;font-size:14px">👤 ${p.persona}</div>
                  <div style="font-size:11px;color:var(--text3);margin-top:2px">
                    ${p.pagos.length} pago${p.pagos.length>1?'s':''}
                    ${p.totalDias > 0 ? ` · ${p.totalDias} días trabajados` : ''}
                    ${p.efectivos > 0 ? ` · ${eur(p.efectivos)} efectivo` : ''}
                    ${p.adelantos > 0 ? ` · ${eur(p.adelantos)} adelanto` : ''}
                  </div>
                </div>
                <div style="font-size:18px;font-weight:700;color:var(--red);font-family:'Space Grotesk',sans-serif">${eur(p.totalPagado)}</div>
              </div>
              <table style="font-size:11px">
                <thead><tr>
                  <th>Fecha</th><th>Tipo</th><th>Concepto</th><th>Obra</th>
                  <th style="text-align:right">Días</th>
                  <th style="text-align:right">€/h</th>
                  <th style="text-align:right">Importe</th>
                  <th></th>
                </tr></thead>
                <tbody>${p.pagos.map(pg => {
                  const t = TIPOS[pg.tipo] || TIPOS.efectivo;
                  return `<tr>
                    <td>${dt(pg.fecha)}</td>
                    <td><span style="color:${t.color}">${t.emoji} ${t.label}</span></td>
                    <td>${pg.concepto||'—'}</td>
                    <td style="color:var(--text3)">${pg.clienteObra||'—'}</td>
                    <td style="text-align:right">${pg.diasTrabajados||'—'}</td>
                    <td style="text-align:right">${pg.costeHoraReal?pg.costeHoraReal+'€':'—'}</td>
                    <td style="text-align:right;color:var(--red);font-weight:600">${eur(pg.importe)}</td>
                    <td>
                      <button class="btn bgh" style="font-size:10px;padding:2px 7px;color:var(--red);border-color:var(--red)"
                        onclick="CP.Pagos.deletePago('${pg._id}','${pg.persona.replace(/'/g,"\\'")}')">🗑</button>
                    </td>
                  </tr>`;
                }).join('')}</tbody>
              </table>
            </div>`).join('')}
        </div>`;
    } catch(err) {
      el.innerHTML = `<div style="color:var(--red);font-size:12px">Error: ${err.message}</div>`;
    }
  }

  async function loadLista() {
    const el      = document.getElementById('pg-lista');
    if (!el) return;
    const persona = document.getElementById('pg-f-persona')?.value || '';
    const tipo    = document.getElementById('pg-f-tipo')?.value    || '';
    const from    = document.getElementById('pg-f-from')?.value    || '';
    const to      = document.getElementById('pg-f-to')?.value      || '';
    el.innerHTML  = '<div style="color:var(--text3);font-size:12px;padding:10px">Cargando...</div>';
    try {
      const data = await api(`/api/pagos?persona=${encodeURIComponent(persona)}&tipo=${tipo}&from=${from}&to=${to}`);
      document.getElementById('pg-count').textContent = `${data.total} pagos`;
      if (!data.pagos.length) {
        el.innerHTML = '<div class="empty"><div class="ei">💵</div><div class="et">No hay pagos con estos filtros</div></div>';
        return;
      }
      el.innerHTML = `<table>
        <thead><tr>
          <th>Fecha</th><th>Persona</th><th>Tipo</th><th>Concepto</th><th>Obra</th>
          <th style="text-align:right">Días</th>
          <th style="text-align:right">Importe</th>
          <th></th>
        </tr></thead>
        <tbody>${data.pagos.map(pg => {
          const t = TIPOS[pg.tipo] || TIPOS.efectivo;
          return `<tr>
            <td>${dt(pg.fecha)}</td>
            <td><strong>${pg.persona}</strong></td>
            <td><span style="color:${t.color}">${t.emoji} ${t.label}</span></td>
            <td style="color:var(--text2)">${pg.concepto||'—'}</td>
            <td style="color:var(--text3);font-size:11px">${pg.clienteObra||'—'}</td>
            <td style="text-align:right">${pg.diasTrabajados||'—'}</td>
            <td style="text-align:right;color:var(--red);font-weight:600">${eur(pg.importe)}</td>
            <td>
              <button class="btn bgh" style="font-size:10px;padding:2px 7px;color:var(--red);border-color:var(--red)"
                onclick="CP.Pagos.deletePago('${pg._id}','${pg.persona.replace(/'/g,"\\'")}')">🗑</button>
            </td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
    } catch(err) {
      el.innerHTML = `<div style="color:var(--red);font-size:12px">Error: ${err.message}</div>`;
    }
  }

  async function submitPago() {
    const tipo    = document.getElementById('pg-tipo')?.value;
    const fecha   = document.getElementById('pg-fecha')?.value;
    const persona = document.getElementById('pg-persona')?.value?.trim();
    const importe = parseFloat(document.getElementById('pg-importe')?.value || 0);
    const dias    = parseFloat(document.getElementById('pg-dias')?.value    || 0);
    const costeH  = parseFloat(document.getElementById('pg-coste-hora')?.value || 0);
    const cliente = document.getElementById('pg-cliente-obra')?.value?.trim() || '';
    const concepto = document.getElementById('pg-concepto')?.value?.trim()   || '';
    const notas   = document.getElementById('pg-notas')?.value?.trim()       || '';
    const msg     = document.getElementById('pg-form-msg');

    if (!persona) { mostrarMsg('pg-form-msg', '⚠️ El nombre de la persona es obligatorio', 'warn'); return; }
    if (!importe || importe <= 0) { mostrarMsg('pg-form-msg', '⚠️ El importe debe ser mayor que 0', 'warn'); return; }

    // Calcular costeHoraReal si no se introdujo manualmente
    const costeHoraFinal = costeH || (dias > 0 ? parseFloat((importe / (dias * 8)).toFixed(2)) : 0);

    try {
      await api('/api/pagos', { method:'POST', body: JSON.stringify({
        tipo, fecha, persona, importe, concepto, notas,
        diasTrabajados: dias, costeHoraReal: costeHoraFinal, clienteObra: cliente,
      })});
      mostrarMsg('pg-form-msg', `✅ Pago de ${eur(importe)} a ${persona} registrado`, 'ok');
      resetForm();
      setTimeout(() => showTab('resumen', null), 1500);
    } catch(err) { mostrarMsg('pg-form-msg', '❌ ' + err.message, 'error'); }
  }

  async function deletePago(id, persona) {
    if (!confirm(`¿Eliminar el pago a "${persona}"?`)) return;
    try {
      await api(`/api/pagos/${id}`, { method:'DELETE' });
      loadResumen();
      loadLista();
    } catch(err) { alert('Error: ' + err.message); }
  }

  async function exportCSV() {
    const from = document.getElementById('pg-res-from')?.value || '';
    const to   = document.getElementById('pg-res-to')?.value   || '';
    try {
      const data = await api(`/api/pagos?from=${from}&to=${to}&limit=1000`);
      if (!data.pagos.length) return;
      const rows = [['Fecha','Persona','Tipo','Concepto','Días trabajados','€/hora','Importe','Obra','Notas']];
      data.pagos.forEach(p => rows.push([
        p.fecha, p.persona, TIPOS[p.tipo]?.label||p.tipo,
        p.concepto||'', p.diasTrabajados||'', p.costeHoraReal||'',
        p.importe, p.clienteObra||'', p.notas||''
      ]));
      const csv = rows.map(r=>r.map(v=>`"${v}"`).join(',')).join('\n');
      const a   = document.createElement('a');
      a.href    = 'data:text/csv;charset=utf-8,\uFEFF'+encodeURIComponent(csv);
      a.download = `pagos_efectivo_${from||'todos'}.csv`;
      a.click();
    } catch(err) { console.error('[Pagos] CSV error:', err.message); }
  }

  function resetForm() {
    ['pg-persona','pg-importe','pg-dias','pg-coste-hora','pg-cliente-obra','pg-concepto','pg-notas'].forEach(id => {
      const e = document.getElementById(id); if(e) e.value='';
    });
    const d = document.getElementById('pg-fecha');
    if (d) d.value = new Date().toISOString().slice(0,10);
    const msg = document.getElementById('pg-form-msg');
    if (msg) msg.style.display = 'none';
    const calc = document.getElementById('pg-coste-hora-calc');
    if (calc) calc.textContent = '';
  }

  function mostrarMsg(id, texto, tipo) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent   = texto;
    el.style.display = 'block';
    el.style.color   = tipo==='ok'?'var(--green)':tipo==='warn'?'var(--amber)':'var(--red)';
    if (tipo !== 'error') setTimeout(() => el.style.display = 'none', 3000);
  }

  CP.Pagos = {
    render, showTab, loadResumen, loadLista,
    submitPago, deletePago, exportCSV, resetForm,
    _onTipoChange, _calcCosteHora,
  };

})(window.CP = window.CP || {});
