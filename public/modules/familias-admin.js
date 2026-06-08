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

  async function render(containerId) {
    _containerId = containerId;
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = `<div class="card"><div class="card-title">📧 Responsables de avisos por familia</div><div class="empty"><div class="et">Cargando...</div></div></div>`;
    try {
      const data = await api('/api/family-contacts');
      _contacts = Array.isArray(data) ? data : [];
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
        <div class="alert ain" style="margin-bottom:14px"><div>ℹ️</div><div>Cada aviso de factura se envía al responsable de su familia. Si una familia no tiene email, el aviso va al buzón de avisos. Marca <strong>Pausada</strong> para dejar de avisar a una familia temporalmente.</div></div>
        <div style="font-size:12px;color:var(--text3);margin-bottom:10px">${conEmail} de ${total} familias con responsable asignado.</div>
        <table>
          <thead><tr><th>Familia</th><th>Email del responsable</th><th style="text-align:center">Estado</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="4"><div class="empty"><div class="et">No hay familias.</div></div></td></tr>'}</tbody>
        </table>
      </div>`;
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

  CP.FamiliasAdmin = { render, save };

})(window.CP = window.CP || {});
