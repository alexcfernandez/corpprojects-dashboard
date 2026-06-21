// modules/cobros.js — Panel de cobros: prioriza a quién reclamar y deriva a Paypymes/judicial.
(function (CP) {
  'use strict';

  async function api(url, opts = {}) {
    const tok = localStorage.getItem('cp_token');
    const r = await fetch(url, {
      ...opts,
      headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  const eur = v => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(v || 0);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let _container = null;

  function nivel(emoji, titulo, color, arr) {
    if (!arr || !arr.length) return '';
    const sub = arr.reduce((s, c) => s + (c.total || 0), 0);
    const filas = arr.map(c => `
      <tr>
        <td style="padding:8px 10px;font-weight:600">${esc(c.cliente)}</td>
        <td style="padding:8px 10px;text-align:right;font-weight:700">${eur(c.total)}</td>
        <td style="padding:8px 10px;text-align:center;color:var(--muted)">${c.n}</td>
        <td style="padding:8px 10px;text-align:center;color:var(--muted)">${c.maxDias}d</td>
        <td style="padding:8px 10px;text-align:right;white-space:nowrap">
          <button class="cb-btn" onclick='CP.Cobros.derivar(${JSON.stringify(c.cliente)},"Paypymes")'>→ Paypymes</button>
          <button class="cb-btn" onclick='CP.Cobros.derivar(${JSON.stringify(c.cliente)},"Judicial")'>⚖️</button>
        </td>
      </tr>`).join('');
    return `
      <div style="margin-top:18px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <h3 style="margin:0;color:${color}">${emoji} ${titulo} — ${arr.length}</h3>
          <span style="font-weight:700;color:${color}">${eur(sub)}</span>
        </div>
        <div style="overflow-x:auto;border:1px solid var(--border);border-radius:10px">
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <thead><tr style="background:var(--card2);color:var(--muted);font-size:12px;text-align:left">
              <th style="padding:8px 10px">Cliente</th>
              <th style="padding:8px 10px;text-align:right">Deuda</th>
              <th style="padding:8px 10px;text-align:center">Fras</th>
              <th style="padding:8px 10px;text-align:center">Antig.</th>
              <th style="padding:8px 10px;text-align:right">Derivar</th>
            </tr></thead>
            <tbody>${filas}</tbody>
          </table>
        </div>
      </div>`;
  }

  function bloqueGestion(gestion) {
    if (!gestion || !gestion.length) return '';
    const filas = gestion.map(g => `
      <tr>
        <td style="padding:6px 10px">${esc(g.valor)}</td>
        <td style="padding:6px 10px;color:var(--muted)">${g.tipo === 'factura' ? 'Factura' : 'Cliente'}</td>
        <td style="padding:6px 10px">${g.motivo ? `<span style="background:var(--card2);border-radius:6px;padding:2px 8px;font-size:12px">${esc(g.motivo)}</span>` : '—'}</td>
        <td style="padding:6px 10px;text-align:right">
          <button class="cb-btn" onclick='CP.Cobros.reactivar(${JSON.stringify(g.tipo)},${JSON.stringify(g.clave)})'>↩︎ Reactivar</button>
        </td>
      </tr>`).join('');
    return `
      <div style="margin-top:24px">
        <h3 style="margin:0 0 6px;color:var(--muted)">🔕 En gestión (ocultos del aviso; siguen recibiendo correos) — ${gestion.length}</h3>
        <div style="overflow-x:auto;border:1px solid var(--border);border-radius:10px">
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tbody>${filas}</tbody>
          </table>
        </div>
      </div>`;
  }

  async function load() {
    if (!_container) return;
    _container.innerHTML = `<p style="color:var(--muted)">Cargando cobros…</p>`;
    try {
      const d = await api('/api/cobros');
      const total = (d.rojo || []).concat(d.naranja || [], d.amarillo || []).reduce((s, c) => s + (c.total || 0), 0);
      let html = `
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <div>
            <h2 style="margin:0">💸 Cobros</h2>
            <p style="margin:4px 0 0;color:var(--muted)">A quién reclamar, priorizado por antigüedad. Se reclama a todos; el importe solo ordena.</p>
          </div>
          <div style="text-align:right">
            <div style="font-size:12px;color:var(--muted)">Pendiente activo</div>
            <div style="font-size:22px;font-weight:800">${eur(total)}</div>
          </div>
        </div>`;
      html += nivel('🔴', 'Derivar ya (+365d)', 'var(--red)', d.rojo);
      html += nivel('🟠', 'Apretar (200–365d)', 'var(--amber)', d.naranja);
      html += nivel('🟡', 'Vigilar (<200d)', '#caa92e', d.amarillo);
      if (!(d.rojo || []).length && !(d.naranja || []).length && !(d.amarillo || []).length) {
        html += `<p style="margin-top:18px;color:var(--green)">✅ Nada que reclamar fuera de lo que ya tienes en gestión.</p>`;
      }
      html += bloqueGestion(d.gestion);
      _container.innerHTML = html;
    } catch (e) {
      _container.innerHTML = `<p style="color:var(--red)">No se pudo cargar (${esc(e.message)}).</p>`;
    }
  }

  async function derivar(cliente, motivo) {
    if (!confirm(`¿Derivar "${cliente}" a ${motivo}?\nSaldrá del panel pero seguirá recibiendo los correos de impago.`)) return;
    try {
      await api('/api/cobros/gestion', { method: 'POST', body: JSON.stringify({ tipo: 'cliente', valor: cliente, motivo, activar: true }) });
      load();
    } catch (e) { alert('No se pudo: ' + e.message); }
  }

  async function reactivar(tipo, clave) {
    try {
      await api('/api/cobros/gestion', { method: 'POST', body: JSON.stringify({ tipo, clave, activar: false }) });
      load();
    } catch (e) { alert('No se pudo: ' + e.message); }
  }

  function render(containerId) {
    _container = document.getElementById(containerId);
    load();
  }

  CP.Cobros = { render, derivar, reactivar };
})(window.CP = window.CP || {});
