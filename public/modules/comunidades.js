// modules/comunidades.js — Fichas técnicas de comunidad: buscar, ver, añadir y borrar notas.
(function (CP) {
  'use strict';

  async function api(url, opts = {}) {
    const tok = localStorage.getItem('cp_token');
    const r = await fetch(url, { ...opts, headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let _c = null, _todas = [], _conFicha = [], _sel = '', _cats = {}, _orden = [];

  async function loadIndex() {
    const d = await api('/api/comunidades');
    _todas = d.todas || [];
    _conFicha = d.conFicha || [];
  }

  function header() {
    const opciones = _todas.map(n => `<option value="${esc(n)}"${n === _sel ? ' selected' : ''}>${esc(n)}</option>`).join('');
    const chips = _conFicha.slice(0, 30).map(c =>
      `<button class="cb-btn" style="margin:3px" onclick='CP.Comunidades.ver(${JSON.stringify(c.comunidad)})'>${esc(c.comunidad)} <span style="color:var(--muted)">·${c.n}</span></button>`).join('');
    return `
      <h2 style="margin:0">🏘️ Fichas de comunidad</h2>
      <p style="margin:4px 0 12px;color:var(--muted)">Datos de mantenimiento del día a día: iluminación, accesos, calderas… Lo que apuntes aquí o por WhatsApp se comparte.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <select id="com-sel" style="padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--card2);color:var(--text);min-width:240px">
          <option value="">— elige una comunidad —</option>${opciones}
        </select>
        <button class="cb-btn" onclick="CP.Comunidades.verSel()">Ver ficha</button>
      </div>
      ${_conFicha.length ? `<div style="margin-top:12px"><div style="font-size:12px;color:var(--muted);margin-bottom:4px">Con ficha:</div>${chips}</div>` : ''}
      <div id="com-ficha" style="margin-top:18px"></div>`;
  }

  function render(containerId) {
    _c = document.getElementById(containerId);
    _c.innerHTML = `<p style="color:var(--muted)">Cargando…</p>`;
    loadIndex().then(() => { _c.innerHTML = header(); }).catch(e => { _c.innerHTML = `<p style="color:var(--red)">Error: ${esc(e.message)}</p>`; });
  }

  function verSel() {
    const v = document.getElementById('com-sel').value;
    if (v) ver(v);
  }

  async function ver(comunidad) {
    _sel = comunidad;
    const cont = document.getElementById('com-ficha') || _c;
    cont.innerHTML = `<p style="color:var(--muted)">Cargando ficha…</p>`;
    try {
      const d = await api('/api/comunidades/ficha?comunidad=' + encodeURIComponent(comunidad));
      _cats = d.cats; _orden = d.orden;
      const notas = d.notas || [];
      const porCat = {};
      notas.forEach((nt, i) => { const cat = _cats[nt.cat] ? nt.cat : 'otros'; (porCat[cat] = porCat[cat] || []).push({ n: i + 1, texto: nt.texto }); });
      let html = `<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <h3 style="margin:0">${esc(comunidad)}</h3></div>`;
      if (!notas.length) {
        html += `<p style="color:var(--muted)">Sin datos todavía. Añade la primera nota abajo.</p>`;
      } else {
        for (const key of _orden) {
          if (!porCat[key]) continue;
          html += `<div style="margin-top:12px"><div style="font-weight:700;margin-bottom:4px">${_cats[key]}</div>`;
          html += porCat[key].map(x => `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
              <span>${esc(x.texto)}</span>
              <button class="cb-btn" title="Borrar" onclick='CP.Comunidades.borrar(${JSON.stringify(comunidad)},${x.n})'>🗑️</button>
            </div>`).join('');
          html += `</div>`;
        }
      }
      // Formulario de añadir
      html += `
        <div style="margin-top:18px;padding:12px;border:1px dashed var(--border);border-radius:10px">
          <div style="font-weight:600;margin-bottom:6px">Añadir nota</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <input id="com-nueva" placeholder="p. ej. luces escalera: downlight 26W 4000K" style="flex:1;min-width:240px;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--card2);color:var(--text)" onkeydown="if(event.key==='Enter')CP.Comunidades.anadir(${JSON.stringify(comunidad)})">
            <button class="cb-btn" onclick='CP.Comunidades.anadir(${JSON.stringify(comunidad)})'>+ Añadir</button>
          </div>
          <div style="font-size:12px;color:var(--muted);margin-top:6px">Se clasifica sola en su categoría.</div>
        </div>`;
      cont.innerHTML = html;
    } catch (e) { cont.innerHTML = `<p style="color:var(--red)">Error: ${esc(e.message)}</p>`; }
  }

  async function anadir(comunidad) {
    const inp = document.getElementById('com-nueva');
    const texto = (inp && inp.value || '').trim();
    if (!texto) return;
    try {
      await api('/api/comunidades/nota', { method: 'POST', body: JSON.stringify({ comunidad, texto }) });
      await loadIndex();
      ver(comunidad);
    } catch (e) { alert('No se pudo: ' + e.message); }
  }

  async function borrar(comunidad, idx) {
    if (!confirm('¿Borrar esta nota?')) return;
    try {
      await api('/api/comunidades/nota/borrar', { method: 'POST', body: JSON.stringify({ comunidad, idx }) });
      await loadIndex();
      ver(comunidad);
    } catch (e) { alert('No se pudo: ' + e.message); }
  }

  CP.Comunidades = { render, verSel, ver, anadir, borrar };
})(window.CP = window.CP || {});
