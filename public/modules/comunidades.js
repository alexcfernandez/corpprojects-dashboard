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
        </div>
        <div id="com-cuentas" style="margin-top:22px"><p style="color:var(--muted)">Cargando cuentas del cliente…</p></div>`;
      cont.innerHTML = html;
      cuentas(comunidad);
    } catch (e) { cont.innerHTML = `<p style="color:var(--red)">Error: ${esc(e.message)}</p>`; }
  }

  // 💶 Cuentas: facturado, coste de sus obras y gastos sueltos a su nombre (Compras → «Un cliente»).
  async function cuentas(comunidad) {
    const el = document.getElementById('com-cuentas'); if (!el) return;
    let d; try { d = await api('/api/clientes/historial?nombre=' + encodeURIComponent(comunidad)); } catch (e) { el.innerHTML = ''; return; }
    if (_sel !== comunidad) return;
    const eur = v => Number(v || 0).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
    const fd = f => f ? String(f).slice(0, 10).split('-').reverse().join('/') : '';
    const t = d.totales;
    const kpi = (l, v, c) => `<div style="flex:1;min-width:130px;background:var(--card2);border:1px solid var(--border);border-radius:10px;padding:10px 12px"><div style="font-size:11px;color:var(--muted)">${l}</div><div style="font-size:18px;font-weight:700;${c ? 'color:' + c : ''}">${v}</div></div>`;
    const tabla = (cab, filas) => `<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:6px"><tr>${cab.map(c => `<th style="text-align:left;padding:5px;border-bottom:1px solid var(--border);color:var(--muted);font-weight:600">${c}</th>`).join('')}</tr>${filas.map(f => `<tr>${f.map(c => `<td style="padding:5px;border-bottom:1px solid var(--border)">${c}</td>`).join('')}</tr>`).join('')}</table>`;
    el.innerHTML = `<h3 style="margin:0 0 8px">💶 Cuentas del cliente</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${kpi('Facturado (sin IVA)', eur(t.facturado))}${kpi('Pendiente de cobro', eur(t.pendienteCobro), t.pendienteCobro > 0 ? 'var(--amber,#f59e0b)' : '')}${kpi('Gasto en sus obras', eur(t.gastoObras))}${kpi('Gasto suelto (sin obra)', eur(t.gastoDirecto))}${kpi('Queda (sin mano de obra propia)', eur(t.margenSinManoObra), t.margenSinManoObra < 0 ? 'var(--red,#f05252)' : 'var(--green,#22c487)')}</div>
      <div style="font-size:11.5px;color:var(--muted);margin-top:6px">Gastos sin IVA, de Compras y facturas de proveedor. No incluye las horas de nuestra gente (eso está en la rentabilidad de cada obra).</div>
      ${d.obras.length ? `<div style="font-weight:700;margin-top:14px">🏗️ Obras (${d.obras.length})</div>` + tabla(['Obra', 'Estado', 'Presupuesto', 'Gasto en compras'], d.obras.map(o => [esc(o.referencia), esc(o.estado), o.presupuesto ? eur(o.presupuesto) : '—', eur(o.compras) + ` <span style="color:var(--muted)">(${o.nCompras})</span>`])) : ''}
      <div style="font-weight:700;margin-top:14px">👤 Gastos sueltos a su nombre (${d.compras.length})</div>
      ${d.compras.length ? tabla(['Fecha', 'Proveedor', 'Nº', 'Importe', ''], d.compras.map(c => [fd(c.fecha), esc(c.proveedor || ''), esc(c.numero || ''), eur(c.base != null ? c.base : c.total), c.estado === 'revisada' ? '' : '<span style="color:var(--amber,#f59e0b)">por revisar</span>'])) : '<div style="font-size:12.5px;color:var(--muted)">Ninguno. En Compras, «¿Para qué es?» → «👤 Un cliente (reparación sin obra)».</div>'}
      <div style="font-weight:700;margin-top:14px">🧾 Facturas que le hemos hecho (${d.nFacturas})</div>
      ${d.facturas.length ? tabla(['Fecha', 'Nº', 'Base', 'Pendiente'], d.facturas.map(f => [fd(f.fecha), esc(f.numero), eur(f.base), f.pendiente > 0.01 ? `<b style="color:var(--amber,#f59e0b)">${eur(f.pendiente)}</b>` : '✓'])) : '<div style="font-size:12.5px;color:var(--muted)">Ninguna.</div>'}`;
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
