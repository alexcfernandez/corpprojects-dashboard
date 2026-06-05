// modules/pagos-admin.js — v2 Pagos, Colaboradores y Proyectos
(function(CP) {
  'use strict';

  const TIPOS_PAGO = {
    efectivo:   { label: 'Pago efectivo',     emoji: '💵', color: '#f59e0b' },
    adelanto:   { label: 'Adelanto nómina',   emoji: '💰', color: '#4d9cf8' },
    devolucion: { label: 'Devolución',        emoji: '↩️',  color: '#22c487' },
    material:   { label: 'Material efectivo', emoji: '📦', color: '#a78bfa' },
    ingreso:    { label: 'Ingreso cash',      emoji: '⬆️',  color: '#22c487' },
  };

  const TIPOS_MOV = {
  semana_trabajada: { label: 'Semana trabajada', emoji: '📅', color: '#22c487' },
  pago_semana:      { label: 'Pago semana',       emoji: '💵', color: '#4d9cf8' },
  pago_dias:        { label: 'Pago días',          emoji: '📆', color: '#4d9cf8' },
  adelanto:         { label: 'Adelanto',           emoji: '💸', color: '#f59e0b' },
  descuento:        { label: 'Descuento',          emoji: '➖', color: '#f05252' },
  devolucion:       { label: 'Devolución',         emoji: '↩️',  color: '#a78bfa' },
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

  function mostrarMsg(id, texto, tipo) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent   = texto;
    el.style.display = 'block';
    el.style.color   = tipo==='ok'?'var(--green)':tipo==='warn'?'var(--amber)':'var(--red)';
    if (tipo !== 'error') setTimeout(() => el.style.display='none', 3000);
  }

  // ── RENDER PRINCIPAL ──────────────────────────────────────────
  function render(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;

    el.innerHTML = `
      <div style="display:flex;gap:0;border-bottom:1px solid var(--border);margin-bottom:20px;overflow-x:auto">
        <button class="btab active" onclick="CP.Pagos.showTab('colaboradores',this)">👷 Colaboradores</button>
        <button class="btab" onclick="CP.Pagos.showTab('pagos',this)">💵 Pagos generales</button>
        <button class="btab" onclick="CP.Pagos.showTab('proyectos',this)">🏠 Proyectos inversión</button>
      </div>

      <!-- COLABORADORES -->
      <div id="pg-tab-colaboradores" class="p-tab active">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px">
          <div style="font-size:12px;color:var(--text3)">Colaboradores externos con cuenta corriente de pagos</div>
          <button class="btn bp" onclick="CP.Pagos.abrirModalColaborador()">+ Nuevo colaborador</button>
        </div>
        <div id="pg-col-resumen"><div class="empty"><div class="et">Cargando...</div></div></div>
      </div>

      <!-- PAGOS GENERALES -->
      <div id="pg-tab-pagos" class="p-tab" style="display:none">
        <div style="display:flex;gap:0;border-bottom:1px solid var(--border);margin-bottom:16px;overflow-x:auto">
          <button class="btab active" onclick="CP.Pagos.showPagosTab('resumen',this)">📊 Resumen</button>
          <button class="btab" onclick="CP.Pagos.showPagosTab('lista',this)">📋 Lista</button>
          <button class="btab" onclick="CP.Pagos.showPagosTab('nuevo',this)">➕ Registrar</button>
        </div>
        <div id="pg-pagos-inner">
          <div id="pg-pagos-resumen">
            <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:flex-end">
              <div><div style="font-size:10px;color:var(--text3);margin-bottom:4px">Desde</div><input type="date" id="pg-res-from" class="srch" style="width:145px"></div>
              <div><div style="font-size:10px;color:var(--text3);margin-bottom:4px">Hasta</div><input type="date" id="pg-res-to" class="srch" style="width:145px"></div>
              <button class="btn bp" onclick="CP.Pagos.loadResumen()">Ver resumen</button>
              <button class="btn bg2" onclick="CP.Pagos.exportCSV()">📥 CSV</button>
            </div>
            <div id="pg-res-metrics" class="metrics-row" style="margin-bottom:14px"></div>
            <div id="pg-res-content"><div class="empty"><div class="et">Selecciona un período</div></div></div>
          </div>
          <div id="pg-pagos-lista" style="display:none">
            <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:flex-end">
              <div><div style="font-size:10px;color:var(--text3);margin-bottom:4px">Persona</div><input type="text" id="pg-f-persona" class="srch" placeholder="Buscar..." style="width:180px" oninput="CP.Pagos.loadLista()"></div>
              <div><div style="font-size:10px;color:var(--text3);margin-bottom:4px">Tipo</div>
                <select id="pg-f-tipo" onchange="CP.Pagos.loadLista()" style="background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:var(--rs);padding:7px 10px;font-size:12px">
                  <option value="">Todos</option>
                  ${Object.entries(TIPOS_PAGO).map(([k,v])=>`<option value="${k}">${v.emoji} ${v.label}</option>`).join('')}
                </select>
              </div>
              <div><div style="font-size:10px;color:var(--text3);margin-bottom:4px">Desde</div><input type="date" id="pg-f-from" class="srch" style="width:145px" onchange="CP.Pagos.loadLista()"></div>
              <div><div style="font-size:10px;color:var(--text3);margin-bottom:4px">Hasta</div><input type="date" id="pg-f-to" class="srch" style="width:145px" onchange="CP.Pagos.loadLista()"></div>
            </div>
            <div class="card"><div class="card-title">Pagos <span id="pg-count" style="font-weight:400;color:var(--text3)">—</span></div><div id="pg-lista">Cargando...</div></div>
          </div>
          <div id="pg-pagos-nuevo" style="display:none">
            <div class="g2">
              <div class="card" style="max-width:560px">
                <div class="card-title">Registrar pago</div>
                ${renderFormPago()}
                <div id="pg-form-msg" style="margin-top:10px;font-size:12px;display:none"></div>
                <div style="display:flex;gap:8px;margin-top:14px">
                  <button class="btn bp" onclick="CP.Pagos.submitPago()">💾 Guardar</button>
                  <button class="btn bgh" onclick="CP.Pagos.resetFormPago()">Limpiar</button>
                </div>
              </div>
              <div class="card">
                <div class="card-title">💡 Tipos de pago</div>
                ${Object.entries(TIPOS_PAGO).map(([k,v])=>`
                  <div style="padding:8px 0;border-bottom:1px solid var(--border);display:flex;gap:10px;align-items:flex-start">
                    <span style="font-size:18px">${v.emoji}</span>
                    <div>
                      <div style="font-weight:600;font-size:12px;color:${v.color}">${v.label}</div>
                      <div style="font-size:11px;color:var(--text3)">${
                        k==='efectivo'?'Gastos pagados en cash: gasolina, material, pequeñas compras':
                        k==='adelanto'?'Anticipos de nómina a trabajadores de plantilla':
                        k==='devolucion'?'Dinero que nos devuelven':
                        k==='material'?'Materiales comprados en efectivo, con o sin factura':
                        'Cobros de clientes en efectivo, pagos de obras'
                      }</div>
                    </div>
                  </div>`).join('')}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- PROYECTOS -->
      <div id="pg-tab-proyectos" class="p-tab" style="display:none">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px">
          <div style="font-size:12px;color:var(--text3)">Inversiones y proyectos propios</div>
          <button class="btn bp" onclick="CP.Pagos.abrirModalProyecto()">+ Nuevo proyecto</button>
        </div>
        <div id="pg-proyectos-lista"><div class="empty"><div class="et">Cargando...</div></div></div>
      </div>`;

    // Cargar datos iniciales
    loadColaboradores();

    const hoy  = new Date();
    const from = `${hoy.getFullYear()}-${String(hoy.getMonth()+1).padStart(2,'0')}-01`;
    const to   = `${hoy.getFullYear()}-${String(hoy.getMonth()+1).padStart(2,'0')}-31`;
    const fe   = document.getElementById('pg-res-from');
    const te   = document.getElementById('pg-res-to');
    if (fe) fe.value = from;
    if (te) te.value = to;
  }

  // ── TABS ─────────────────────────────────────────────────────
  function showTab(id, btn) {
    document.querySelectorAll('#pagos-container .p-tab').forEach(p => { p.style.display='none'; p.classList.remove('active'); });
    document.querySelectorAll('#pagos-container > div > .btab').forEach(b => b.classList.remove('active'));
    const tab = document.getElementById('pg-tab-' + id);
    if (tab) { tab.style.display='block'; tab.classList.add('active'); }
    if (btn) btn.classList.add('active');
    if (id === 'colaboradores') loadColaboradores();
    if (id === 'pagos')         loadResumen();
    if (id === 'proyectos')     loadProyectos();
  }

  function showPagosTab(id, btn) {
    ['resumen','lista','nuevo'].forEach(t => {
      const el = document.getElementById('pg-pagos-' + t);
      if (el) el.style.display = t===id ? 'block' : 'none';
    });
    document.querySelectorAll('#pg-tab-pagos > div:first-child .btab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    if (id === 'lista')   loadLista();
    if (id === 'resumen') loadResumen();
  }

  // ── COLABORADORES ─────────────────────────────────────────────
  async function loadColaboradores() {
    const el = document.getElementById('pg-col-resumen');
    if (!el) return;
    el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:10px">Cargando...</div>';
    try {
      const data = await api('/api/colaboradores/resumen');

      if (!data.length) {
        el.innerHTML = `<div class="empty">
          <div class="ei">👷</div>
          <div class="et">No hay colaboradores registrados</div>
          <button class="btn bp" style="margin-top:14px" onclick="CP.Pagos.abrirModalColaborador()">+ Añadir primero</button>
        </div>`;
        return;
      }

      // Métricas globales
      const totalSaldo     = data.reduce((s,c) => s + Math.max(0, c.saldoPendiente), 0);
      const totalPagado    = data.reduce((s,c) => s + c.totalPagado, 0);
      const totalDevengado = data.reduce((s,c) => s + c.totalDevengado, 0);

      el.innerHTML = `
        <div class="metrics-row" style="margin-bottom:16px">
          <div class="mc"><div class="ml">Colaboradores activos</div><div class="mv b">${data.length}</div></div>
          <div class="mc"><div class="ml">Total devengado</div><div class="mv g">${eur(totalDevengado)}</div></div>
          <div class="mc"><div class="ml">Total pagado</div><div class="mv b">${eur(totalPagado)}</div></div>
          <div class="mc"><div class="ml">Pendiente pagar</div><div class="mv ${totalSaldo>0?'r':'g'}">${eur(totalSaldo)}</div></div>
        </div>
        <div style="display:grid;gap:12px">
          ${data.map(c => {
            const col    = c.colaborador;
            const saldo  = c.saldoPendiente;
            const ok     = saldo <= 0;
            return `
            <div class="card" style="margin-bottom:0;cursor:pointer" onclick="CP.Pagos.abrirFichaColaborador('${col._id}')">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">
                <div>
                  <div style="font-size:15px;font-weight:700">👤 ${col.nombre}</div>
                  <div style="font-size:11px;color:var(--text3);margin-top:2px">
                    ${col.oficio||'Colaborador'} ·
                    ${col.tipoTarifa==='semana'?`${eur(col.tarifaSemana)}/semana`:
                      col.tipoTarifa==='dia'?`${eur(col.tarifaDia)}/día`:
                      `${col.tarifaHora}€/h`}
                  </div>
                </div>
                <div style="text-align:right">
                  <div style="font-size:18px;font-weight:700;color:${ok?'var(--green)':'var(--red)'};font-family:'Space Grotesk',sans-serif">
                    ${saldo > 0 ? `Le debemos ${eur(saldo)}` : saldo < 0 ? `Nos debe ${eur(Math.abs(saldo))}` : '✅ Al día'}
                  </div>
                  <div style="font-size:11px;color:var(--text3);margin-top:2px">${c.movimientos} movimientos</div>
                </div>
              </div>
              <div style="display:flex;gap:16px;font-size:11px;color:var(--text2)">
                <span>💰 Devengado: <strong>${eur(c.totalDevengado)}</strong></span>
                <span>✅ Pagado: <strong>${eur(c.totalPagado)}</strong></span>
                ${c.totalDescuentos > 0 ? `<span>➖ Descuentos: <strong>${eur(c.totalDescuentos)}</strong></span>` : ''}
                ${c.ultimoMovimiento ? `<span>📅 Último: <strong>${dt(c.ultimoMovimiento)}</strong></span>` : ''}
              </div>
              <div style="display:flex;gap:8px;margin-top:12px">
                <button class="btn bp" style="font-size:11px;padding:5px 12px" onclick="event.stopPropagation();CP.Pagos.abrirModalMovimiento('${col._id}','${col.nombre}')">+ Añadir movimiento</button>
                <button class="btn bgh" style="font-size:11px;padding:5px 12px" onclick="event.stopPropagation();CP.Pagos.abrirFichaColaborador('${col._id}')">Ver ficha completa →</button>
              </div>
            </div>`;
          }).join('')}
        </div>`;
    } catch(err) {
      el.innerHTML = `<div style="color:var(--red);font-size:12px">Error: ${err.message}</div>`;
    }
  }

  async function abrirFichaColaborador(id) {
    try {
      const data = await api(`/api/colaboradores/${id}`);
      const col  = data.colaborador;
      const movs = await api(`/api/colaboradores/${id}/movimientos`);
      const saldo = data.saldoPendiente;

      document.getElementById('pg-col-ficha-modal')?.remove();
      const modal = document.createElement('div');
      modal.id = 'pg-col-ficha-modal';
      modal.className = 'modal-overlay';

      modal.innerHTML = `
        <div class="modal-box" style="max-width:700px">
          <div class="modal-header">
            <div>
              <div style="font-size:16px;font-weight:700">👤 ${col.nombre}</div>
              <div style="font-size:12px;color:var(--text3)">${col.oficio||'Colaborador'} · Alta: ${dt(col.fechaAlta)}</div>
            </div>
            <button class="modal-close" onclick="document.getElementById('pg-col-ficha-modal').remove()">✕</button>
          </div>

          <div class="metrics-row" style="margin-bottom:16px">
            <div class="mc"><div class="ml">Devengado total</div><div class="mv g">${eur(data.totalDevengado)}</div></div>
            <div class="mc"><div class="ml">Total pagado</div><div class="mv b">${eur(data.totalPagado)}</div></div>
            <div class="mc"><div class="ml">Descuentos</div><div class="mv a">${eur(data.totalDescuentos)}</div></div>
            <div class="mc"><div class="ml">${saldo>0?'Le debemos':'Nos debe'}</div><div class="mv ${saldo>0?'r':'g'}">${eur(Math.abs(saldo))}</div></div>
          </div>

          <div style="display:flex;gap:8px;margin-bottom:16px">
            <button class="btn bp" onclick="CP.Pagos.abrirModalMovimiento('${col._id}','${col.nombre}')">+ Añadir movimiento</button>
            <div style="margin-left:auto;font-size:11px;color:var(--text3);line-height:1.4">
              Tarifa: <strong>${eur(col.tarifaSemana)}/semana</strong> ·
              <strong>${eur(col.tarifaDia)}/día</strong> ·
              <strong>${col.tarifaHora}€/h</strong>
            </div>
          </div>

          <div class="card" style="max-height:400px;overflow-y:auto">
            <div class="card-title">Historial de movimientos</div>
            ${!movs.length ? '<div class="empty"><div class="et">Sin movimientos</div></div>' : `
            <table>
              <thead><tr>
                <th>Fecha</th><th>Tipo</th><th>Concepto</th><th>Semana / Período</th>
                <th style="text-align:right">Importe</th><th></th>
              </tr></thead>
              <tbody>${movs.map(m => {
                const t = TIPOS_MOV[m.tipo] || TIPOS_MOV.pago_semana;
                const esNegativo = m.tipo === 'descuento';
                return `<tr>
                  <td>${dt(m.fecha)}</td>
                  <td><span style="color:${t.color}">${t.emoji} ${t.label}</span></td>
                  <td style="color:var(--text2);font-size:11px">${m.concepto||m.clienteObra||'—'}</td>
                  <td style="font-size:11px;color:var(--text3)">${m.semanaDesde&&m.semanaHasta?`${dt(m.semanaDesde)} → ${dt(m.semanaHasta)}`:m.diasTrabajados?`${m.diasTrabajados}d`:'—'}</td>
                  <td style="text-align:right;color:${esNegativo?'var(--red)':m.tipo==='devolucion'?'var(--green)':'var(--text)'};font-weight:600">
                    ${esNegativo?'-':''}${eur(m.importe)}
                  </td>
                  <td>
                    <button class="btn bgh" style="font-size:10px;padding:2px 7px;color:var(--red);border-color:var(--red)"
                      onclick="CP.Pagos.deleteMovimiento('${m._id}','${col._id}')">🗑</button>
                  </td>
                </tr>`;
              }).join('')}</tbody>
            </table>`}
          </div>

          <div class="modal-footer" style="margin-top:12px">
            <button class="btn bgh" onclick="document.getElementById('pg-col-ficha-modal').remove()">Cerrar</button>
          </div>
        </div>`;

      document.body.appendChild(modal);
      modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });
    } catch(err) { alert('Error: ' + err.message); }
  }

  function abrirModalColaborador() {
    document.getElementById('pg-nuevo-col-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'pg-nuevo-col-modal';
    modal.className = 'modal-overlay';
    modal.style.alignItems = 'center';
    modal.innerHTML = `
      <div class="modal-box" style="max-width:500px">
        <div class="modal-header">
          <div class="modal-title">Nuevo colaborador externo</div>
          <button class="modal-close" onclick="document.getElementById('pg-nuevo-col-modal').remove()">✕</button>
        </div>
        <div class="field-row">
          <span class="field-label">Nombre completo *</span>
          <input type="text" id="nc-nombre" placeholder="Nombre y apellidos..." class="field-input">
        </div>
        <div class="field-row">
          <span class="field-label">Oficio / especialidad</span>
          <input type="text" id="nc-oficio" placeholder="Ej: Pladur, Pintor, Electricista..." class="field-input">
        </div>
        <div class="field-row">
          <span class="field-label">Teléfono</span>
          <input type="tel" id="nc-telefono" placeholder="Opcional..." class="field-input">
        </div>
        <div class="field-grid-2" style="margin-bottom:12px">
          <div>
            <span class="field-label">Tipo de tarifa</span>
            <select id="nc-tipo-tarifa" class="field-input" onchange="CP.Pagos._onTipoTarifaChange()">
              <option value="semana">Por semana</option>
              <option value="dia">Por día</option>
              <option value="hora">Por hora</option>
            </select>
          </div>
          <div>
            <span class="field-label" id="nc-tarifa-label">€/semana *</span>
            <input type="number" id="nc-tarifa" placeholder="300" min="0" step="0.01" class="field-input">
          </div>
        </div>
        <div class="field-grid-2" style="margin-bottom:12px">
          <div>
            <span class="field-label">Días/semana</span>
            <input type="number" id="nc-dias" value="5" min="1" max="7" class="field-input">
          </div>
          <div>
            <span class="field-label">Horas/día</span>
            <input type="number" id="nc-horas" value="8" min="1" max="16" class="field-input">
          </div>
        </div>
        <div class="field-row">
          <span class="field-label">Fecha de alta</span>
          <input type="date" id="nc-fecha-alta" value="${new Date().toISOString().slice(0,10)}" class="field-input" style="width:160px">
        </div>
        <div class="field-row">
          <span class="field-label">Notas</span>
          <input type="text" id="nc-notas" placeholder="Observaciones..." class="field-input">
        </div>
        <div class="modal-footer">
          <button class="btn bp" onclick="CP.Pagos.guardarColaborador()">💾 Crear colaborador</button>
          <button class="btn bgh" onclick="document.getElementById('pg-nuevo-col-modal').remove()">Cancelar</button>
        </div>
        <div id="nc-msg" style="margin-top:8px;font-size:12px;display:none"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });
  }

  function _onTipoTarifaChange() {
    const tipo  = document.getElementById('nc-tipo-tarifa')?.value;
    const label = document.getElementById('nc-tarifa-label');
    if (label) label.textContent = tipo==='semana'?'€/semana *':tipo==='dia'?'€/día *':'€/hora *';
  }

  async function guardarColaborador() {
    const nombre     = document.getElementById('nc-nombre')?.value?.trim();
    const oficio     = document.getElementById('nc-oficio')?.value?.trim()    || '';
    const telefono   = document.getElementById('nc-telefono')?.value?.trim()  || '';
    const tipoTarifa = document.getElementById('nc-tipo-tarifa')?.value       || 'semana';
    const tarifa     = parseFloat(document.getElementById('nc-tarifa')?.value || 0);
    const dias       = parseInt(document.getElementById('nc-dias')?.value     || 5);
    const horas      = parseInt(document.getElementById('nc-horas')?.value    || 8);
    const fechaAlta  = document.getElementById('nc-fecha-alta')?.value        || '';
    const notas      = document.getElementById('nc-notas')?.value?.trim()     || '';

    if (!nombre) { mostrarMsg('nc-msg','⚠️ El nombre es obligatorio','warn'); return; }
    if (!tarifa) { mostrarMsg('nc-msg','⚠️ La tarifa es obligatoria','warn'); return; }

    const body = {
      nombre, oficio, telefono, tipoTarifa, diasSemanales: dias, horasDia: horas, fechaAlta, notas,
      ...(tipoTarifa==='semana' ? {tarifaSemana:tarifa} : tipoTarifa==='dia' ? {tarifaDia:tarifa} : {tarifaHora:tarifa})
    };

    try {
      await api('/api/colaboradores', { method:'POST', body: JSON.stringify(body) });
      document.getElementById('pg-nuevo-col-modal').remove();
      loadColaboradores();
    } catch(err) { mostrarMsg('nc-msg','❌ '+err.message,'error'); }
  }

  function abrirModalMovimiento(colId, colNombre) {
    document.getElementById('pg-mov-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'pg-mov-modal';
    modal.className = 'modal-overlay';
    modal.style.alignItems = 'center';
    modal.innerHTML = `
      <div class="modal-box" style="max-width:480px">
        <div class="modal-header">
          <div class="modal-title">Añadir movimiento — ${colNombre}</div>
          <button class="modal-close" onclick="document.getElementById('pg-mov-modal').remove()">✕</button>
        </div>
        <div class="field-grid-2" style="margin-bottom:12px">
          <div>
            <span class="field-label">Tipo *</span>
            <select id="mov-tipo" class="field-input" onchange="CP.Pagos._onMovTipoChange()">
              ${Object.entries(TIPOS_MOV).map(([k,v])=>`<option value="${k}">${v.emoji} ${v.label}</option>`).join('')}
            </select>
          </div>
          <div>
            <span class="field-label">Fecha *</span>
            <input type="date" id="mov-fecha" value="${new Date().toISOString().slice(0,10)}" class="field-input">
          </div>
        </div>
        <div class="field-row">
          <span class="field-label">Importe (€) *</span>
          <input type="number" id="mov-importe" min="0" step="0.01" placeholder="0.00" class="field-input" style="width:160px">
        </div>
        <div id="mov-semana-fields">
          <div class="field-grid-2" style="margin-bottom:12px">
            <div>
              <span class="field-label">Semana desde</span>
              <input type="date" id="mov-desde" class="field-input">
            </div>
            <div>
              <span class="field-label">Semana hasta</span>
              <input type="date" id="mov-hasta" class="field-input">
            </div>
          </div>
          <div class="field-grid-2" style="margin-bottom:12px">
            <div>
              <span class="field-label">Días trabajados</span>
              <input type="number" id="mov-dias" min="0" max="7" step="0.5" placeholder="5" class="field-input">
            </div>
            <div>
              <span class="field-label">Horas extra</span>
              <input type="number" id="mov-horas-extra" min="0" step="0.5" placeholder="0" class="field-input">
            </div>
          </div>
          <div class="field-row">
            <span class="field-label">Cliente / Obra</span>
            <input type="text" id="mov-obra" placeholder="En qué obra trabajó..." class="field-input" list="mov-clientes-list">
            <datalist id="mov-clientes-list"></datalist>
          </div>
        </div>
        <div class="field-row">
          <span class="field-label">Concepto / notas</span>
          <input type="text" id="mov-concepto" placeholder="Descripción del movimiento..." class="field-input">
        </div>
        <div class="modal-footer">
          <button class="btn bp" onclick="CP.Pagos.guardarMovimiento('${colId}')">💾 Guardar</button>
          <button class="btn bgh" onclick="document.getElementById('pg-mov-modal').remove()">Cancelar</button>
        </div>
        <div id="mov-msg" style="margin-top:8px;font-size:12px;display:none"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });
    // Cargar sugerencias de clientes
    try {
      if (window._cpClients) {
        const dl = document.getElementById('mov-clientes-list');
        if (dl) dl.innerHTML = window._cpClients.map(n=>`<option value="${n}">`).join('');
      }
    } catch(e) {}
  }

  function _onMovTipoChange() {
    const tipo   = document.getElementById('mov-tipo')?.value;
    const fields = document.getElementById('mov-semana-fields');
    if (fields) fields.style.display = (tipo==='pago_semana'||tipo==='pago_dias') ? 'block' : 'none';
  }

  async function guardarMovimiento(colId) {
    const tipo       = document.getElementById('mov-tipo')?.value;
    const fecha      = document.getElementById('mov-fecha')?.value;
    const importe    = parseFloat(document.getElementById('mov-importe')?.value || 0);
    const desde      = document.getElementById('mov-desde')?.value  || '';
    const hasta      = document.getElementById('mov-hasta')?.value  || '';
    const dias       = parseFloat(document.getElementById('mov-dias')?.value || 0);
    const horasExtra = parseFloat(document.getElementById('mov-horas-extra')?.value || 0);
    const obra       = document.getElementById('mov-obra')?.value?.trim()    || '';
    const concepto   = document.getElementById('mov-concepto')?.value?.trim() || '';

    if (!importe || importe <= 0) { mostrarMsg('mov-msg','⚠️ El importe es obligatorio','warn'); return; }

    try {
      await api(`/api/colaboradores/${colId}/movimientos`, {
        method: 'POST',
        body: JSON.stringify({ tipo, fecha, importe, semanaDesde: desde, semanaHasta: hasta, diasTrabajados: dias, horasExtra, clienteObra: obra, concepto })
      });
      document.getElementById('pg-mov-modal').remove();
      // Refrescar ficha si está abierta
      document.getElementById('pg-col-ficha-modal')?.remove();
      loadColaboradores();
    } catch(err) { mostrarMsg('mov-msg','❌ '+err.message,'error'); }
  }

  async function deleteMovimiento(movId, colId) {
    if (!confirm('¿Eliminar este movimiento?')) return;
    try {
      await api(`/api/colaboradores/movimientos/${movId}`, { method:'DELETE' });
      document.getElementById('pg-col-ficha-modal')?.remove();
      await abrirFichaColaborador(colId);
      loadColaboradores();
    } catch(err) { alert('Error: ' + err.message); }
  }

  // ── PAGOS GENERALES ───────────────────────────────────────────
  function renderFormPago() {
    return `
      <div class="field-grid-2" style="margin-bottom:12px">
        <div>
          <span class="field-label">Tipo *</span>
          <select id="pg-tipo" class="field-input" onchange="CP.Pagos._onPagoTipoChange()">
            ${Object.entries(TIPOS_PAGO).map(([k,v])=>`<option value="${k}">${v.emoji} ${v.label}</option>`).join('')}
          </select>
        </div>
        <div>
          <span class="field-label">Fecha *</span>
          <input type="date" id="pg-fecha" value="${new Date().toISOString().slice(0,10)}" class="field-input">
        </div>
      </div>
      <div class="field-row">
        <span class="field-label">Persona / descripción *</span>
        <input type="text" id="pg-persona" placeholder="A quién o qué..." class="field-input">
      </div>
      <div class="field-row">
        <span class="field-label">Importe (€) *</span>
        <input type="number" id="pg-importe" min="0" step="0.01" placeholder="0.00" class="field-input" style="width:160px">
      </div>
      <div id="pg-material-fields" style="display:none">
        <div class="field-row">
          <span class="field-label">Nº factura / referencia</span>
          <input type="text" id="pg-referencia" placeholder="Ej: 1/804/10/14358" class="field-input">
        </div>
      </div>
      <div class="field-row">
        <span class="field-label">Cliente / Obra relacionada</span>
        <input type="text" id="pg-cliente-obra" placeholder="Para qué obra..." class="field-input" list="pg-clientes-list2">
        <datalist id="pg-clientes-list2"></datalist>
      </div>
      <div class="field-row">
        <span class="field-label">Concepto / notas</span>
        <textarea id="pg-concepto" rows="2" class="field-input" style="resize:vertical" placeholder="Descripción del pago..."></textarea>
      </div>`;
  }

  function _onPagoTipoChange() {
    const tipo   = document.getElementById('pg-tipo')?.value;
    const fields = document.getElementById('pg-material-fields');
    if (fields) fields.style.display = tipo==='material' ? 'block' : 'none';
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
        <div class="mc"><div class="ml">Total salidas</div><div class="mv r">${eur(data.totales.total)}</div></div>
        <div class="mc"><div class="ml">Efectivo</div><div class="mv a">${eur(data.totales.efectivo)}</div></div>
        <div class="mc"><div class="ml">Adelantos plantilla</div><div class="mv b">${eur(data.totales.adelantos)}</div></div>
        <div class="mc"><div class="ml">Materiales</div><div class="mv p">${eur(data.totales.material)}</div></div>
        <div class="mc"><div class="ml">Personas</div><div class="mv b">${data.byPersona.length}</div></div>`;

      if (!data.pagos.length) {
        el.innerHTML = '<div class="empty"><div class="ei">💵</div><div class="et">No hay pagos en este período</div></div>';
        return;
      }

      el.innerHTML = `<div style="display:flex;flex-direction:column;gap:10px">
        ${data.byPersona.map(p => `
          <div class="card" style="margin-bottom:0">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
              <div style="font-weight:700">💵 ${p.persona}</div>
              <div style="font-weight:700;color:var(--red)">${eur(p.totalPagado)}</div>
            </div>
            <table style="font-size:11px">
              <thead><tr><th>Fecha</th><th>Tipo</th><th>Concepto</th><th style="text-align:right">Importe</th><th></th></tr></thead>
              <tbody>${p.pagos.map(pg => {
                const t = TIPOS_PAGO[pg.tipo] || TIPOS_PAGO.efectivo;
                return `<tr>
                  <td>${dt(pg.fecha)}</td>
                  <td><span style="color:${t.color}">${t.emoji} ${t.label}</span></td>
                  <td style="color:var(--text2)">${pg.concepto||pg.persona||'—'}</td>
                  <td style="text-align:right;font-weight:600;color:var(--red)">${eur(pg.importe)}</td>
                  <td><button class="btn bgh" style="font-size:10px;padding:2px 7px;color:var(--red);border-color:var(--red)" onclick="CP.Pagos.deletePago('${pg._id}','${pg.persona?.replace(/'/g,"\\'")||''}')">🗑</button></td>
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
        el.innerHTML = '<div class="empty"><div class="ei">💵</div><div class="et">Sin resultados</div></div>';
        return;
      }
      el.innerHTML = `<table>
        <thead><tr><th>Fecha</th><th>Persona</th><th>Tipo</th><th>Concepto</th><th style="text-align:right">Importe</th><th></th></tr></thead>
        <tbody>${data.pagos.map(pg => {
          const t = TIPOS_PAGO[pg.tipo] || TIPOS_PAGO.efectivo;
          return `<tr>
            <td>${dt(pg.fecha)}</td>
            <td><strong>${pg.persona}</strong></td>
            <td><span style="color:${t.color}">${t.emoji} ${t.label}</span></td>
            <td style="color:var(--text2);font-size:11px">${pg.concepto||'—'}</td>
            <td style="text-align:right;color:var(--red);font-weight:600">${eur(pg.importe)}</td>
            <td><button class="btn bgh" style="font-size:10px;padding:2px 7px;color:var(--red);border-color:var(--red)" onclick="CP.Pagos.deletePago('${pg._id}','${pg.persona?.replace(/'/g,"\\'")||''}')">🗑</button></td>
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
    const ref     = document.getElementById('pg-referencia')?.value?.trim() || '';
    const obra    = document.getElementById('pg-cliente-obra')?.value?.trim() || '';
    const concepto = document.getElementById('pg-concepto')?.value?.trim()   || '';

    if (!persona) { mostrarMsg('pg-form-msg','⚠️ El nombre/descripción es obligatorio','warn'); return; }
    if (!importe || importe <= 0) { mostrarMsg('pg-form-msg','⚠️ El importe debe ser mayor que 0','warn'); return; }

    try {
      await api('/api/pagos', { method:'POST', body: JSON.stringify({ tipo, fecha, persona, importe, concepto, clienteObra: obra, referencia: ref }) });
      mostrarMsg('pg-form-msg', `✅ Pago de ${eur(importe)} registrado`, 'ok');
      resetFormPago();
    } catch(err) { mostrarMsg('pg-form-msg','❌ '+err.message,'error'); }
  }

  async function deletePago(id, persona) {
    if (!confirm(`¿Eliminar el pago de "${persona}"?`)) return;
    try {
      await api(`/api/pagos/${id}`, { method:'DELETE' });
      loadResumen();
      loadLista();
    } catch(err) { alert('Error: ' + err.message); }
  }

  function resetFormPago() {
    ['pg-persona','pg-importe','pg-referencia','pg-cliente-obra','pg-concepto'].forEach(id => {
      const e = document.getElementById(id); if(e) e.value='';
    });
    const d = document.getElementById('pg-fecha');
    if (d) d.value = new Date().toISOString().slice(0,10);
    const msg = document.getElementById('pg-form-msg');
    if (msg) msg.style.display = 'none';
  }

  async function exportCSV() {
    const from = document.getElementById('pg-res-from')?.value || '';
    const to   = document.getElementById('pg-res-to')?.value   || '';
    try {
      const data = await api(`/api/pagos?from=${from}&to=${to}&limit=1000`);
      if (!data.pagos.length) return;
      const rows = [['Fecha','Persona','Tipo','Concepto','Importe','Obra']];
      data.pagos.forEach(p => rows.push([p.fecha, p.persona, TIPOS_PAGO[p.tipo]?.label||p.tipo, p.concepto||'', p.importe, p.clienteObra||'']));
      const csv = rows.map(r=>r.map(v=>`"${v}"`).join(',')).join('\n');
      const a   = document.createElement('a');
      a.href    = 'data:text/csv;charset=utf-8,\uFEFF'+encodeURIComponent(csv);
      a.download = `pagos_${from||'todos'}.csv`;
      a.click();
    } catch(err) { console.error('[Pagos] CSV error:', err.message); }
  }

  // ── PROYECTOS DE INVERSIÓN ─────────────────────────────────────
  async function loadProyectos() {
    const el = document.getElementById('pg-proyectos-lista');
    if (!el) return;
    el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:10px">Cargando...</div>';
    try {
      const lista = await api('/api/proyectos');
      if (!lista.length) {
        el.innerHTML = `<div class="empty">
          <div class="ei">🏠</div>
          <div class="et">No hay proyectos registrados</div>
          <button class="btn bp" style="margin-top:14px" onclick="CP.Pagos.abrirModalProyecto()">+ Crear proyecto</button>
        </div>`;
        return;
      }
      el.innerHTML = `<div style="display:grid;gap:12px">
        ${lista.map(p => `
          <div class="card" style="margin-bottom:0;cursor:pointer" onclick="CP.Pagos.abrirFichaProyecto('${p._id}')">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
              <div>
                <div style="font-size:15px;font-weight:700">🏠 ${p.nombre}</div>
                <div style="font-size:11px;color:var(--text3)">${p.descripcion||''} · Inicio: ${dt(p.fechaInicio)}</div>
              </div>
              <span style="font-size:11px;font-weight:600;padding:3px 10px;border-radius:8px;background:${p.estado==='vendido'?'rgba(34,196,135,.15)':p.estado==='en_curso'?'rgba(77,156,248,.15)':'rgba(245,158,11,.15)'};color:${p.estado==='vendido'?'var(--green)':p.estado==='en_curso'?'var(--blue)':'var(--amber)'}">
                ${p.estado==='vendido'?'✅ Vendido':p.estado==='en_curso'?'🔨 En curso':'⏸️ Pausado'}
              </span>
            </div>
            ${p.precioVentaPactado ? `
            <div style="font-size:12px;color:var(--text2)">
              Precio venta pactado: <strong style="color:var(--green)">${eur(p.precioVentaPactado)}</strong>
            </div>` : ''}
            <div style="margin-top:8px;display:flex;gap:8px">
              <button class="btn bgh" style="font-size:11px;padding:5px 12px" onclick="event.stopPropagation();CP.Pagos.abrirFichaProyecto('${p._id}')">Ver detalle →</button>
            </div>
          </div>`).join('')}
      </div>`;
    } catch(err) {
      el.innerHTML = `<div style="color:var(--red);font-size:12px">Error: ${err.message}</div>`;
    }
  }

  async function abrirFichaProyecto(id) {
    try {
      const p = await api(`/api/proyectos/${id}`);
      document.getElementById('pg-proyecto-modal')?.remove();
      const modal = document.createElement('div');
      modal.id = 'pg-proyecto-modal';
      modal.className = 'modal-overlay';
      modal.innerHTML = `
        <div class="modal-box" style="max-width:680px">
          <div class="modal-header">
            <div>
              <div style="font-size:16px;font-weight:700">🏠 ${p.nombre}</div>
              <div style="font-size:12px;color:var(--text3)">${p.descripcion||''}</div>
            </div>
            <button class="modal-close" onclick="document.getElementById('pg-proyecto-modal').remove()">✕</button>
          </div>

          <div class="metrics-row" style="margin-bottom:16px">
            <div class="mc"><div class="ml">Total invertido</div><div class="mv r">${eur(p.totalInvertido)}</div></div>
            <div class class="mc"><div class="ml">Total cobrado</div><div class="mv g">${eur(p.totalCobrado)}</div></div>
            ${p.precioVentaPactado?`<div class="mc"><div class="ml">Precio venta</div><div class="mv g">${eur(p.precioVentaPactado)}</div></div>`:''}
            <div class="mc"><div class="ml">Beneficio est.</div><div class="mv ${p.beneficioEstimado>=0?'g':'r'}">${eur(p.beneficioEstimado)}</div></div>
          </div>

          <div style="display:flex;gap:8px;margin-bottom:14px">
            <button class="btn bp" onclick="CP.Pagos.abrirModalMovProyecto('${p._id}','gasto')">+ Añadir gasto</button>
            <button class="btn bg2" onclick="CP.Pagos.abrirModalMovProyecto('${p._id}','ingreso')">+ Añadir ingreso</button>
          </div>

          <div class="card" style="max-height:380px;overflow-y:auto">
            <div class="card-title">Movimientos</div>
            ${!p.movimientos.length ? '<div class="empty"><div class="et">Sin movimientos</div></div>' : `
            <table>
              <thead><tr><th>Fecha</th><th>Tipo</th><th>Concepto</th><th>Forma pago</th><th style="text-align:right">Importe</th><th></th></tr></thead>
              <tbody>${p.movimientos.map(m=>`<tr>
                <td>${dt(m.fecha)}</td>
                <td><span style="color:${m.tipo==='ingreso'?'var(--green)':'var(--red)'}">${m.tipo==='ingreso'?'⬆️ Ingreso':'⬇️ Gasto'}</span></td>
                <td style="color:var(--text2);font-size:11px">${m.concepto||'—'}</td>
                <td style="font-size:11px;color:var(--text3)">${m.formaPago==='mixto'?`💵${eur(m.importeCash)} + 🏦${eur(m.importeBanco)}`:m.formaPago==='banco'?'🏦 Banco':'💵 Efectivo'}</td>
                <td style="text-align:right;font-weight:600;color:${m.tipo==='ingreso'?'var(--green)':'var(--red)'}">${eur(m.importe)}</td>
                <td><button class="btn bgh" style="font-size:10px;padding:2px 7px;color:var(--red);border-color:var(--red)" onclick="CP.Pagos.deleteMovProyecto('${m._id}','${p._id}')">🗑</button></td>
              </tr>`).join('')}</tbody>
            </table>`}
          </div>

          <div class="modal-footer">
            <button class="btn bgh" onclick="document.getElementById('pg-proyecto-modal').remove()">Cerrar</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });
    } catch(err) { alert('Error: ' + err.message); }
  }

  function abrirModalProyecto() {
    document.getElementById('pg-nuevo-proy-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'pg-nuevo-proy-modal';
    modal.className = 'modal-overlay';
    modal.style.alignItems = 'center';
    modal.innerHTML = `
      <div class="modal-box" style="max-width:460px">
        <div class="modal-header">
          <div class="modal-title">Nuevo proyecto de inversión</div>
          <button class="modal-close" onclick="document.getElementById('pg-nuevo-proy-modal').remove()">✕</button>
        </div>
        <div class="field-row">
          <span class="field-label">Nombre del proyecto *</span>
          <input type="text" id="np-nombre" placeholder="Ej: Piso Santa Eugenia" class="field-input">
        </div>
        <div class="field-row">
          <span class="field-label">Descripción</span>
          <textarea id="np-desc" rows="2" class="field-input" style="resize:vertical" placeholder="Detalles del proyecto..."></textarea>
        </div>
        <div class="field-grid-2" style="margin-bottom:12px">
          <div>
            <span class="field-label">Fecha inicio</span>
            <input type="date" id="np-fecha" value="${new Date().toISOString().slice(0,10)}" class="field-input">
          </div>
          <div>
            <span class="field-label">Precio venta pactado (€)</span>
            <input type="number" id="np-precio" min="0" placeholder="0" class="field-input">
          </div>
        </div>
        <div class="field-row">
          <span class="field-label">Notas</span>
          <input type="text" id="np-notas" placeholder="Observaciones..." class="field-input">
        </div>
        <div class="modal-footer">
          <button class="btn bp" onclick="CP.Pagos.guardarProyecto()">📁 Crear proyecto</button>
          <button class="btn bgh" onclick="document.getElementById('pg-nuevo-proy-modal').remove()">Cancelar</button>
        </div>
        <div id="np-msg" style="margin-top:8px;font-size:12px;display:none"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });
  }

  async function guardarProyecto() {
    const nombre = document.getElementById('np-nombre')?.value?.trim();
    const desc   = document.getElementById('np-desc')?.value?.trim()  || '';
    const fecha  = document.getElementById('np-fecha')?.value         || '';
    const precio = parseFloat(document.getElementById('np-precio')?.value || 0);
    const notas  = document.getElementById('np-notas')?.value?.trim() || '';
    if (!nombre) { mostrarMsg('np-msg','⚠️ El nombre es obligatorio','warn'); return; }
    try {
      await api('/api/proyectos', { method:'POST', body: JSON.stringify({ nombre, descripcion: desc, fechaInicio: fecha, precioVentaPactado: precio, notas }) });
      document.getElementById('pg-nuevo-proy-modal').remove();
      loadProyectos();
    } catch(err) { mostrarMsg('np-msg','❌ '+err.message,'error'); }
  }

  function abrirModalMovProyecto(proyId, tipo) {
    document.getElementById('pg-mov-proy-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'pg-mov-proy-modal';
    modal.className = 'modal-overlay';
    modal.style.alignItems = 'center';
    modal.innerHTML = `
      <div class="modal-box" style="max-width:460px">
        <div class="modal-header">
          <div class="modal-title">${tipo==='gasto'?'⬇️ Añadir gasto':'⬆️ Añadir ingreso'}</div>
          <button class="modal-close" onclick="document.getElementById('pg-mov-proy-modal').remove()">✕</button>
        </div>
        <div class="field-grid-2" style="margin-bottom:12px">
          <div>
            <span class="field-label">Fecha *</span>
            <input type="date" id="mp-fecha" value="${new Date().toISOString().slice(0,10)}" class="field-input">
          </div>
          <div>
            <span class="field-label">Forma de pago</span>
            <select id="mp-forma" class="field-input" onchange="CP.Pagos._onFormaChange()">
              <option value="efectivo">💵 Efectivo</option>
              <option value="banco">🏦 Banco</option>
              <option value="mixto">💵+🏦 Mixto</option>
            </select>
          </div>
        </div>
        <div class="field-row">
          <span class="field-label">Importe total (€) *</span>
          <input type="number" id="mp-importe" min="0" step="0.01" placeholder="0.00" class="field-input" style="width:160px" oninput="CP.Pagos._calcMixto()">
        </div>
        <div id="mp-mixto-fields" style="display:none">
          <div class="field-grid-2" style="margin-bottom:12px">
            <div>
              <span class="field-label">De los cuales en cash (€)</span>
              <input type="number" id="mp-cash" min="0" step="0.01" placeholder="0.00" class="field-input" oninput="CP.Pagos._calcMixto()">
            </div>
            <div>
              <span class="field-label">En banco (€)</span>
              <input type="number" id="mp-banco" min="0" step="0.01" placeholder="Auto" class="field-input" readonly style="opacity:.7">
            </div>
          </div>
        </div>
        <div class="field-row">
          <span class="field-label">Concepto *</span>
          <input type="text" id="mp-concepto" placeholder="Ej: Pago Montse arquitecta, Reforma baño..." class="field-input">
        </div>
        <div class="field-row">
          <span class="field-label">Referencia / factura</span>
          <input type="text" id="mp-ref" placeholder="Nº de factura o referencia..." class="field-input">
        </div>
        <div class="modal-footer">
          <button class="btn bp" onclick="CP.Pagos.guardarMovProyecto('${proyId}','${tipo}')">💾 Guardar</button>
          <button class="btn bgh" onclick="document.getElementById('pg-mov-proy-modal').remove()">Cancelar</button>
        </div>
        <div id="mp-msg" style="margin-top:8px;font-size:12px;display:none"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });
  }

  function _onFormaChange() {
    const forma  = document.getElementById('mp-forma')?.value;
    const fields = document.getElementById('mp-mixto-fields');
    if (fields) fields.style.display = forma==='mixto' ? 'block' : 'none';
  }

  function _calcMixto() {
    const total = parseFloat(document.getElementById('mp-importe')?.value || 0);
    const cash  = parseFloat(document.getElementById('mp-cash')?.value    || 0);
    const banco = document.getElementById('mp-banco');
    if (banco) banco.value = Math.max(0, total - cash).toFixed(2);
  }

  async function guardarMovProyecto(proyId, tipo) {
    const fecha    = document.getElementById('mp-fecha')?.value;
    const forma    = document.getElementById('mp-forma')?.value    || 'efectivo';
    const importe  = parseFloat(document.getElementById('mp-importe')?.value  || 0);
    const cash     = parseFloat(document.getElementById('mp-cash')?.value     || 0);
    const banco    = parseFloat(document.getElementById('mp-banco')?.value    || 0);
    const concepto = document.getElementById('mp-concepto')?.value?.trim()    || '';
    const ref      = document.getElementById('mp-ref')?.value?.trim()         || '';

    if (!importe || importe <= 0) { mostrarMsg('mp-msg','⚠️ El importe es obligatorio','warn'); return; }
    if (!concepto) { mostrarMsg('mp-msg','⚠️ El concepto es obligatorio','warn'); return; }

    try {
      await api(`/api/proyectos/${proyId}/movimientos`, {
        method: 'POST',
        body: JSON.stringify({ tipo, fecha, formaPago: forma, importe, importeCash: forma==='mixto'?cash:forma==='efectivo'?importe:0, importeBanco: forma==='mixto'?banco:forma==='banco'?importe:0, concepto, referencia: ref })
      });
      document.getElementById('pg-mov-proy-modal').remove();
      document.getElementById('pg-proyecto-modal')?.remove();
      await abrirFichaProyecto(proyId);
    } catch(err) { mostrarMsg('mp-msg','❌ '+err.message,'error'); }
  }

  async function deleteMovProyecto(movId, proyId) {
    if (!confirm('¿Eliminar este movimiento?')) return;
    try {
      await api(`/api/proyectos/movimientos/${movId}`, { method:'DELETE' });
      document.getElementById('pg-proyecto-modal')?.remove();
      await abrirFichaProyecto(proyId);
    } catch(err) { alert('Error: ' + err.message); }
  }

  CP.Pagos = {
    render, showTab, showPagosTab,
    loadColaboradores, abrirFichaColaborador,
    abrirModalColaborador, guardarColaborador,
    abrirModalMovimiento, guardarMovimiento, deleteMovimiento,
    loadResumen, loadLista, submitPago, deletePago, resetFormPago, exportCSV,
    loadProyectos, abrirFichaProyecto, abrirModalProyecto, guardarProyecto,
    abrirModalMovProyecto, guardarMovProyecto, deleteMovProyecto,
    _onTipoTarifaChange, _onMovTipoChange, _onPagoTipoChange,
    _onFormaChange, _calcMixto,
  };

})(window.CP = window.CP || {});
