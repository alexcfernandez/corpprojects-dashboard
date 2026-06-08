// modules/familias-admin.js — Responsables de avisos por familia
(function(CP){
  'use strict';

  function api(url, opts={}) {
    const tok = localStorage.getItem('cp_token');
    return fetch(url, {
      ...opts,
      headers: {'Authorization':`Bearer ${tok}`,'Content-Type':'application/json',...(opts.headers||{})}
    }).then(r => r.json());
  }

  const esc = s => String(s==null?'':s)
    .replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  let _contacts = [];
  let _containerId = null;
  let _globalPaused = false;

  async function render(containerId) {
    _containerId = containerId;
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = `<div class="card"><div class="card-title">📧 Responsables de avisos por familia</div><div class="empty"><div class="et">Cargando...</div></div></div>`;
    try {
      const [data, status] = await Promise.all([
        api('/api/family-contacts'),
        api('/api/avisos-status')
      ]);
      _contacts = Array.isArray(data) ? data : [];
      _globalPaused = !!(status && status.globalPaused);
    } catch(e) { _contacts = []; }
    _draw();
  }

  function _draw() {
    const el = document.getElementById(_containerId);
    if (!el) return;
    const conEmail = _contacts.filter(c => c.email).length;
    const total = _contacts.length;
    const rows = _contacts.map((c,i) => `
      <tr>
        <td><strong>${esc(c.family)}</strong></td>
        <td><input type="email" id="fc-email-${i}" value="${esc(c.email)}" placeholder="responsable@empresa.com"
            style="width:100%;min-width:220px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:7px 10px;color:var(--text);font-size:13px;outline:none;font-family:'Inter',sans-serif"></td>
        <td style="text-align:center">
          <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:var(--text2)">
            <input type="checkbox" id="fc-paused-${i}" ${c.paused?'checked':''} style="width:16px;height:16px;cursor:pointer;accent-color:var(--amber)"> Pausada
          </label>
        </td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn bp" style="padding:6px 14px;font-size:12px" onclick="CP.FamiliasAdmin.save(${i})">Guardar</button>
          <span id="fc-msg-${i}" style="font-size:11px;margin-left:8px"></span>
        </td>
      </tr>`).join('');
    el.innerHTML = `
      <div class="card">
        <div class="card-title">📧 Responsables de avisos por familia</div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;background:${_globalPaused?'rgba(239,68,68,.12)':'rgba(34,197,94,.10)'};border:1px solid ${_globalPaused?'rgba(239,68,68,.4)':'rgba(34,197,94,.3)'};border-radius:10px;padding:12px 14px;margin-bottom:14px">
          <div>
            <div style="font-size:13px;font-weight:700;color:${_globalPaused?'var(--red)':'var(--green)'}">${_globalPaused?'⏸ ENVÍOS PAUSADOS':'▶️ Envíos activos'}</div>
            <div style="font-size:11px;color:var(--text3);margin-top:2px">${_globalPaused?'No se está enviando ningún aviso (ni a clientes ni al buzón de avisos).':'Los avisos de factura se están enviando con normalidad.'}</div>
          </div>
          <button class="btn ${_globalPaused?'bp':'bgh'}" style="padding:8px 16px;font-size:13px" onclick="CP.FamiliasAdmin.toggleGlobal()">${_globalPaused?'▶️ Reactivar envíos':'⏸ Pausar TODO'}</button>
        </div>
        <div class="alert ain" style="margin-bottom:14px"><div>ℹ️</div><div>Cada aviso de factura se envía al responsable de su familia. Si una familia no tiene email, el aviso va al buzón de avisos. Marca <strong>Pausada</strong> para dejar de avisar a una familia temporalmente.</div></div>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px">
          <button class="btn bp" style="padding:8px 16px;font-size:13px" onclick="CP.FamiliasAdmin.sendSummaries()">📤 Enviar resumen ahora a cada familia</button>
          <span id="fc-sum-msg" style="font-size:12px;color:var(--text3)">Un solo correo por familia con todas sus facturas pendientes.</span>
        </div>
        <div style="font-size:12px;color:var(--text3);margin-bottom:10px">${conEmail} de ${total} familias con responsable asignado.</div>
        <table>
          <thead><tr><th>Familia</th><th>Email del responsable</th><th style="text-align:center">Estado</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="4"><div class="empty"><div class="et">No hay familias.</div></div></td></tr>'}</tbody>
        </table>
      </div>`;
  }

  async function toggleGlobal() {
    const next = !_globalPaused;
    if (next && !confirm('¿Pausar TODOS los envíos de avisos? No se enviará ningún aviso (ni a clientes ni al buzón) hasta que lo reactives.')) return;
    try {
      const r = await api('/api/avisos-status', { method:'PUT', body: JSON.stringify({ paused: next }) });
      _globalPaused = !!(r && r.globalPaused);
      _draw();
    } catch(err) { alert('No se pudo cambiar: ' + err.message); }
  }

  async function save(i) {
    const c = _contacts[i];
    if (!c) return;
    const email  = document.getElementById('fc-email-'+i)?.value?.trim() || '';
    const paused = document.getElementById('fc-paused-'+i)?.checked || false;
    const msg = document.getElementById('fc-msg-'+i);
    if (msg) { msg.textContent='Guardando...'; msg.style.color='var(--text3)'; }
    try {
      const r = await api('/api/family-contacts', { method:'PUT', body: JSON.stringify({ family: c.family, email, paused }) });
      if (r && r.error) throw new Error(r.error);
      c.email = email; c.paused = paused;
      if (msg) { msg.textContent='✓ Guardado'; msg.style.color='var(--green)'; setTimeout(()=>{ if(msg && msg.textContent==='✓ Guardado') msg.textContent=''; }, 2500); }
    } catch(err) {
      if (msg) { msg.textContent='✗ '+err.message; msg.style.color='var(--red)'; }
    }
  }

  async function sendSummaries() {
    if (!confirm('¿Enviar ahora un resumen a cada familia con responsable asignado? Cada familia recibirá un único correo con todas sus facturas pendientes.')) return;
    const msg = document.getElementById('fc-sum-msg');
    if (msg) { msg.textContent='Enviando...'; msg.style.color='var(--text2)'; }
    try {
      const r = await api('/api/send-family-summaries', { method:'POST', body: JSON.stringify({}) });
      if (r && r.error) throw new Error(r.error);
      if (msg) { msg.textContent = '✓ ' + (r.message || 'Hecho'); msg.style.color='var(--green)'; }
    } catch(err) {
      if (msg) { msg.textContent = '✗ ' + err.message; msg.style.color='var(--red)'; }
    }
  }

  CP.FamiliasAdmin = { render, save, toggleGlobal, sendSummaries };

})(window.CP = window.CP || {});
