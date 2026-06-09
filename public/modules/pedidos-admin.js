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
  const state = { all: [], filter: 'todos', sortDir: 'desc' };

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
      <div class="card">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px">
          <div class="card-title" style="margin:0;flex:1">Pedidos de trabajo en curso</div>
          <div id="pd-filters" style="display:flex;gap:6px;flex-wrap:wrap"></div>
          <button id="pd-sort" class="btn bgh" style="padding:6px 12px;font-size:12px" onclick="CP.PedidosAdmin.toggleSort()">↓ Más antiguos primero</button>
        </div>
        <div id="pd-table">Cargando…</div>
      </div>`;
    load();
  }

  async function load() {
    const box = document.getElementById('pd-table');
    if (box) box.innerHTML = 'Cargando…';
    try {
      const r = await api('/api/workorders/live');
      if (r && r.error) throw new Error(r.error);
      state.all = (r && r.list) || [];
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
    const counts = { todos: state.all.length, actuacion: 0, presupuesto: 0, otros: 0 };
    state.all.forEach(p => { counts[bucket(p.type)]++; });
    const defs = [
      ['todos', 'Todos'],
      ['actuacion', 'Actuación'],
      ['presupuesto', 'Presupuesto'],
      ['otros', 'Otros']
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
    if (state.filter !== 'todos') list = list.filter(p => bucket(p.type) === state.filter);
    list.sort((a, b) => state.sortDir === 'desc' ? (b.days - a.days) : (a.days - b.days));

    if (!list.length) { box.innerHTML = '<div style="padding:20px;color:var(--text3)">No hay pedidos en esta vista.</div>'; return; }

    const filas = list.map(p => `
      <tr>
        <td style="padding:10px 8px;border-bottom:1px solid var(--border2);font-weight:600">${esc(p.number)}</td>
        <td style="padding:10px 8px;border-bottom:1px solid var(--border2)">${esc(p.client)}</td>
        <td style="padding:10px 8px;border-bottom:1px solid var(--border2)">${typePill(p.type)}</td>
        <td style="padding:10px 8px;border-bottom:1px solid var(--border2);color:var(--text3)">${esc(p.state)}</td>
        <td style="padding:10px 8px;border-bottom:1px solid var(--border2);text-align:center;font-weight:700;color:${p.alertColor}">${p.days}d</td>
        <td style="padding:10px 8px;border-bottom:1px solid var(--border2)">${dot(p.alertColor)}${esc(p.alertLabel)}</td>
        <td style="padding:10px 8px;border-bottom:1px solid var(--border2);text-align:center">${p.pdfPath ? `<a href="${esc(p.pdfPath)}" target="_blank" style="color:var(--accent,#4d9cf8);text-decoration:none;font-weight:600">Ver</a>` : '—'}</td>
      </tr>`).join('');

    box.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr>
          <th style="text-align:left;padding:8px;border-bottom:2px solid var(--border2);color:var(--text3);font-size:12px">Pedido</th>
          <th style="text-align:left;padding:8px;border-bottom:2px solid var(--border2);color:var(--text3);font-size:12px">Cliente / Comunidad</th>
          <th style="text-align:left;padding:8px;border-bottom:2px solid var(--border2);color:var(--text3);font-size:12px">Tipo</th>
          <th style="text-align:left;padding:8px;border-bottom:2px solid var(--border2);color:var(--text3);font-size:12px">Estado</th>
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

  CP.PedidosAdmin = { render, load, setFilter, toggleSort };
})(window.CP = window.CP || {});
