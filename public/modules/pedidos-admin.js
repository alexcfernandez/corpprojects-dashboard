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

  function dot(color) {
    return `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:6px;vertical-align:middle"></span>`;
  }

  function render(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = '<div class="card"><div class="card-title">Pedidos de trabajo en curso</div><div id="pd-table">Cargando…</div></div>';
    load();
  }

  async function load() {
    const box = document.getElementById('pd-table');
    if (box) box.innerHTML = 'Cargando…';
    try {
      const r = await api('/api/workorders/live');
      if (r && r.error) throw new Error(r.error);
      const list = (r && r.list) || [];
      paintMetrics(list);
      if (!list.length) { if (box) box.innerHTML = '<div style="padding:20px;color:var(--text3)">No hay pedidos de trabajo en curso. 🎉</div>'; return; }

      const filas = list.map(p => `
        <tr>
          <td style="padding:10px 8px;border-bottom:1px solid var(--border2);font-weight:600">${esc(p.number)}</td>
          <td style="padding:10px 8px;border-bottom:1px solid var(--border2)">${esc(p.client)}</td>
          <td style="padding:10px 8px;border-bottom:1px solid var(--border2);color:var(--text3)">${esc(p.type)}</td>
          <td style="padding:10px 8px;border-bottom:1px solid var(--border2);color:var(--text3)">${esc(p.state)}</td>
          <td style="padding:10px 8px;border-bottom:1px solid var(--border2);text-align:center;font-weight:700;color:${p.alertColor}">${p.days}d</td>
          <td style="padding:10px 8px;border-bottom:1px solid var(--border2)">${dot(p.alertColor)}${esc(p.alertLabel)}</td>
          <td style="padding:10px 8px;border-bottom:1px solid var(--border2);text-align:center">${p.pdfPath ? `<a href="${esc(p.pdfPath)}" target="_blank" style="color:var(--accent,#4d9cf8);text-decoration:none;font-weight:600">Ver</a>` : '—'}</td>
        </tr>`).join('');

      if (box) box.innerHTML = `
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
        </table>`;
    } catch (err) {
      if (box) box.innerHTML = `<div style="padding:20px;color:var(--red)">Error: ${esc(err.message)}</div>`;
    }
  }

  function paintMetrics(list) {
    const set = (id, v) => { const e = document.getElementById(id); if (e) { e.textContent = v; e.classList.remove('sk'); } };
    const rojo  = list.filter(p => p.alertLevel === 'red').length;
    const ambar = list.filter(p => p.alertLevel === 'amber').length;
    set('pd-m1', list.length);
    set('pd-m2', ambar);
    set('pd-m3', rojo);
  }

  CP.PedidosAdmin = { render, load };
})(window.CP = window.CP || {});
