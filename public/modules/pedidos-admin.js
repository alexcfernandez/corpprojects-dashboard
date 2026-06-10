// public/modules/pedidos-admin.js — Fase 1: ver y vigilar pedidos de trabajo vivos
(function (CP) {
  function api(url, opts) {
    const o = opts || {};
    o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
    const t = localStorage.getItem('cp_token');
    if (t) o.headers['Authorization'] = 'Bearer ' + t;
    return fetch(url, o).then(r => r.json());
  }

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
  ));

  // Estado interno de la vista
  const state = { all: [], filter: 'todos', sortDir: 'desc', users: [] };

  // Color por tipo de incidencia (mismos que StelOrder)
  function typeColor(type) {
    const t = String(type || '').toLowerCase();
    if (t.includes('actuaci'))   return '#3b5bdb'; // azul
    if (t.includes('presupuesto')) return '#9463fb'; // morado
    if (t.includes('cerrada'))   return '#c12626'; // rojo
    return '#6b7280';                               // gris (sin tipo)
  }

  function dot(color) {
    return `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:6px;vertical-align:middle"></span>`;
  }

  function typePill(type) {
    const c = typeColor(type);
    return `<span style="display:inline-block;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:600;color:${c};background:${c}22">${esc(type || 'Sin tipo')}</span>`;
  }

  function render(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = `
      <div id="pd-alert-panel" class="card" style="margin-bottom:16px"></div>
      <div class="card">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px">
          <div class="card-title" style="margin:0;flex:1">Pedidos de trabajo en curso</div>
          <div id="pd-filters" style="display:flex;gap:6px;flex-wrap:wrap"></div>
          <button id="pd-sort" class="btn bgh" style="padding:6px 12px;font-size:12px" onclick="CP.PedidosAdmin.toggleSort()">↓ Más antiguos primero</button>
        </div>
        <div id="pd-table">Cargando…</div>
      </div>`;
    loadAlertStatus();
    load();
  }

  async function loadAlertStatus() {
    const panel = document.getElementById('pd-alert-panel');
    if (!panel) return;
    try {
      const r = await api('/api/workorders/alert-status');
      const paused = !!(r && r.paused);
      panel.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <div style="flex:1;min-width:220px">
            <div style="font-weight:700;color:${paused ? 'var(--red)' : 'var(--green)'}">
              ${paused ? '⏸ Avisos de pedidos PAUSADOS' : '▶ Avisos de pedidos ACTIVOS'}
            </div>
            <div style="font-size:12px;color:var(--text3);margin-top:2px">
              Resumen diario (rojos + ámbar) a las 08:00 a hola@corpprojects.es.
            </div>
          </div>
          <button class="btn ${paused ? 'bp' : 'bgh'}" style="padding:8px 16px;font-size:13px" onclick="CP.PedidosAdmin.togglePause(${paused})">
            ${paused ? '▶ Activar avisos' : '⏸ Pausar avisos'}
          </button>
          <button class="btn bgh" id="pd-send-btn" style="padding:8px 16px;font-size:13px" onclick="CP.PedidosAdmin.sendNow()">📧 Enviar ahora</button>
          <span id="pd-alert-msg" style="font-size:12px;color:var(--text3)"></span>
        </div>`;
    } catch (err) {
      panel.innerHTML = `<div style="color:var(--red);font-size:13px">No se pudo cargar el estado de avisos: ${esc(err.message)}</div>`;
    }
  }

  async function togglePause(currentlyPaused) {
    try {
      await api('/api/workorders/alert-status', { method:'PUT', body: JSON.stringify({ paused: !currentlyPaused }) });
      loadAlertStatus();
    } catch (err) {
      const m = document.getElementById('pd-alert-msg');
      if (m) { m.textContent = '✗ ' + err.message; m.style.color = 'var(--red)'; }
    }
  }

  async function sendNow() {
    const m = document.getElementById('pd-alert-msg');
    const btn = document.getElementById('pd-send-btn');
    if (btn && btn.disabled) return;
    if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; btn.textContent = 'Enviando…'; }
    if (m) { m.textContent = 'Enviando…'; m.style.color = 'var(--text2)'; }
    try {
      const r = await api('/api/workorders/send-now', { method:'POST', body: JSON.stringify({}) });
      if (r && r.error) throw new Error(r.error);
      if (m) { m.textContent = '✓ ' + (r.message || 'Enviado'); m.style.color = 'var(--green)'; }
    } catch (err) {
      if (m) { m.textContent = '✗ ' + err.message; m.style.color = 'var(--red)'; }
    } finally {
      if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.textContent = '📧 Enviar ahora'; }
    }
  }

  async function load() {
    const box = document.getElementById('pd-table');
    if (box) box.innerHTML = 'Cargando…';
    try {
      const [r, ru] = await Promise.all([
        api('/api/workorders/live'),
        api('/api/workorders/assignable-users')
      ]);
      if (r && r.error) throw new Error(r.error);
      state.all = (r && r.list) || [];
      state.users = (ru && ru.users) || [];
      paintMetrics(state.all);
      paintFilters();
      paint();
    } catch (err) {
      if (box) box.innerHTML = `<div style="padding:20px;color:var(--red)">Error: ${esc(err.message)}</div>`;
    }
  }

  function bucket(type) {
    const t = String(type || '').toLowerCase();
    if (t.includes('actuaci'))     return 'actuacion';
    if (t.includes('presupuesto')) return 'presupuesto';
    return 'otros';
  }

  function paintFilters() {
    const cont = document.getElementById('pd-filters');
    if (!cont) return;
    const abiertos = state.all.filter(p => p.workStatus !== 'done');
    const counts = { todos: abiertos.length, actuacion: 0, presupuesto: 0, otros: 0,
                     completados: state.all.filter(p => p.workStatus === 'done').length };
    abiertos.forEach(p => { counts[bucket(p.type)]++; });
    const defs = [
      ['todos', 'Todos'],
      ['actuacion', 'Actuación'],
      ['presupuesto', 'Presupuesto'],
      ['otros', 'Otros'],
      ['completados', '✅ Pte. facturar']
    ];
    cont.innerHTML = defs.map(([k, label]) => {
      const active = state.filter === k;
      return `<button class="btn ${active ? 'bp' : 'bgh'}" style="padding:6px 12px;font-size:12px"
        onclick="CP.PedidosAdmin.setFilter('${k}')">${label} (${counts[k]})</button>`;
    }).join('');
  }

  function paint() {
    const box = document.getElementById('pd-table');
    if (!box) return;
    let list = state.all.slice();
    if (state.filter === 'completados') {
      list = list.filter(p => p.workStatus === 'done');
    } else {
      list = list.filter(p => p.workStatus !== 'done');
      if (state.filter !== 'todos') list = list.filter(p => bucket(p.type) === state.filter);
    }
    list.sort((a, b) => state.sortDir === 'desc' ? (b.days - a.days) : (a.days - b.days));

    if (!list.length) { box.innerHTML = '<div style="padding:20px;color:var(--text3)">No hay pedidos en esta vista.</div>'; return; }

    const filas = list.map(p => {
      const opts = ['<option value="">— Sin asignar —</option>']
        .concat(state.users.map(u => `<option value="${u.id}" ${u.id === p.assignedUserId ? 'selected' : ''}>${esc(u.name)}</option>`))
        .join('');
      // Prioridad: la guardada, o por defecto según tipo (Actuación→urgente)
      const prio = p.assignedPriority || (/actuaci/i.test(p.type || '') ? 'urgent' : 'normal');
      const sel = `<select id="pd-user-${p.id}" onchange="CP.PedidosAdmin.assignRow('${p.id}')" style="background:var(--bg2);border:1px solid var(--border2);border-radius:6px;padding:5px 8px;color:var(--text);font-size:12px;max-width:140px">${opts}</select>`;
      const selPrio = `<select id="pd-prio-${p.id}" onchange="CP.PedidosAdmin.assignRow('${p.id}')" style="background:var(--bg2);border:1px solid ${prio==='urgent'?'rgba(220,38,38,.5)':'var(--border2)'};border-radius:6px;padding:5px 8px;color:${prio==='urgent'?'#ef4444':'var(--text)'};font-size:12px">
          <option value="urgent" ${prio==='urgent'?'selected':''}>🔴 Urgente</option>
          <option value="normal" ${prio==='normal'?'selected':''}>🔵 Normal</option>
        </select>`;
      return `
      <tr>
        <td style="padding:10px 8px;border-bottom:1px solid var(--border2);font-weight:600">${esc(p.number)}</td>
        <td style="padding:10px 8px;border-bottom:1px solid var(--border2)">${esc(p.client)}</td>
        <td style="padding:10px 8px;border-bottom:1px solid var(--border2)">${typePill(p.type)}</td>
        <td style="padding:10px 8px;border-bottom:1px solid var(--border2)">${sel}</td>
        <td style="padding:10px 8px;border-bottom:1px solid var(--border2)">${selPrio}</td>
        <td style="padding:10px 8px;border-bottom:1px solid var(--border2);text-align:center;font-weight:700;color:${p.alertColor}">${p.days}d</td>
        <td style="padding:10px 8px;border-bottom:1px solid var(--border2)">${dot(p.alertColor)}${esc(p.alertLabel)}${p.workStatus==='done' ? '<div style="font-size:11px;color:var(--green);margin-top:2px">✅ Completado — pte. facturar</div>' : (p.lastWorkerStatus ? `<div style="font-size:11px;color:var(--amber);margin-top:2px">${p.lastWorkerStatus==='material'?'📦 Falta material':(p.lastWorkerStatus==='continua'?'🔴 Continúa otro día':'🟡 Parcialmente hecho')}</div>` : '')}</td>
        <td style="padding:10px 8px;border-bottom:1px solid var(--border2);text-align:center">${p.pdfPath ? `<a href="${esc(p.pdfPath)}" target="_blank" style="color:var(--accent,#4d9cf8);text-decoration:none;font-weight:600">Ver</a>` : '—'}</td>
      </tr>`;
    }).join('');

    box.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr>
          <th style="text-align:left;padding:8px;border-bottom:2px solid var(--border2);color:var(--text3);font-size:12px">Pedido</th>
          <th style="text-align:left;padding:8px;border-bottom:2px solid var(--border2);color:var(--text3);font-size:12px">Cliente / Comunidad</th>
          <th style="text-align:left;padding:8px;border-bottom:2px solid var(--border2);color:var(--text3);font-size:12px">Tipo</th>
          <th style="text-align:left;padding:8px;border-bottom:2px solid var(--border2);color:var(--text3);font-size:12px">Asignado a</th>
          <th style="text-align:left;padding:8px;border-bottom:2px solid var(--border2);color:var(--text3);font-size:12px">Prioridad</th>
          <th style="text-align:center;padding:8px;border-bottom:2px solid var(--border2);color:var(--text3);font-size:12px">Días</th>
          <th style="text-align:left;padding:8px;border-bottom:2px solid var(--border2);color:var(--text3);font-size:12px">Situación</th>
          <th style="text-align:center;padding:8px;border-bottom:2px solid var(--border2);color:var(--text3);font-size:12px">Doc</th>
        </tr></thead>
        <tbody>${filas}</tbody>
      </table>
      <div style="margin-top:10px;color:var(--text3);font-size:12px">${list.length} pedido(s) en esta vista.</div>`;
  }

  function paintMetrics(list) {
    const set = (id, v) => { const e = document.getElementById(id); if (e) { e.textContent = v; e.classList.remove('sk'); } };
    set('pd-m1', list.length);
    set('pd-m2', list.filter(p => p.alertLevel === 'amber').length);
    set('pd-m3', list.filter(p => p.alertLevel === 'red').length);
  }

  function setFilter(k) { state.filter = k; paintFilters(); paint(); }

  function toggleSort() {
    state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
    const btn = document.getElementById('pd-sort');
    if (btn) btn.textContent = state.sortDir === 'desc' ? '↓ Más antiguos primero' : '↑ Más recientes primero';
    paint();
  }

  async function assignRow(workOrderId) {
    const userSel = document.getElementById('pd-user-' + workOrderId);
    const prioSel = document.getElementById('pd-prio-' + workOrderId);
    const userId = userSel ? userSel.value : '';
    const priority = prioSel ? prioSel.value : 'normal';
    try {
      const r = await api('/api/workorders/assign', { method:'PUT', body: JSON.stringify({ workOrderId, userId, priority }) });
      if (r && r.error) throw new Error(r.error);
      const p = state.all.find(x => String(x.id) === String(workOrderId));
      if (p) { p.assignedUserId = userId || null; p.assignedUserName = r.userName || null; p.assignedPriority = r.priority || null; }
      paint(); // repintar para reflejar el color de la prioridad
    } catch (err) {
      alert('No se pudo guardar: ' + err.message);
      load();
    }
  }

  CP.PedidosAdmin = { render, load, setFilter, toggleSort, togglePause, sendNow, assignRow };
})(window.CP = window.CP || {});
