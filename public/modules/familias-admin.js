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
    const freqOpts = (sel) => [
      ['manual','Manual (solo a mano)'],
      ['weekly','Semanal (viernes)'],
      ['biweekly','2/semana (lun y jue)'],
      ['daily','Diaria'],
      ['twice_daily','2 veces/día']
    ].map(([v,l]) => `<option value="${v}" ${sel===v?'selected':''}>${l}</option>`).join('');
    const fmtOpts = (sel) => [
      ['grouped','Agrupado'],
      ['individual','Individual']
    ].map(([v,l]) => `<option value="${v}" ${sel===v?'selected':''}>${l}</option>`).join('');
    const selStyle = "background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:7px 8px;color:var(--text);font-size:12px;outline:none;font-family:'Inter',sans-serif";
    const rows = _contacts.map((c,i) => `
      <tr>
        <td><strong>${esc(c.family)}</strong></td>
        <td><input type="email" id="fc-email-${i}" value="${esc(c.email)}" placeholder="responsable@empresa.com"
            style="width:100%;min-width:200px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:7px 10px;color:var(--text);font-size:13px;outline:none;font-family:'Inter',sans-serif">
            <select id="fc-modo-${i}" style="${selStyle};margin-top:6px;width:100%">
              <option value="familia" ${(c.modo||'familia')==='familia'?'selected':''}>Modo: 1 email para la familia</option>
              <option value="cliente" ${c.modo==='cliente'?'selected':''}>Modo: a cada cliente (email de su ficha)</option>
            </select></td>
        <td><select id="fc-freq-${i}" style="${selStyle}">${freqOpts(c.freq||'manual')}</select></td>
        <td><select id="fc-format-${i}" style="${selStyle}">${fmtOpts(c.format||'grouped')}</select></td>
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
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px">
          <button class="btn bp" style="padding:8px 16px;font-size:13px" onclick="CP.FamiliasAdmin.sendNow('grouped')">📤 Enviar resumen ahora</button>
          <button class="btn bgh" style="padding:8px 16px;font-size:13px" onclick="CP.FamiliasAdmin.sendNow('individual')">📨 Enviar una por factura</button>
          <span id="fc-sum-msg" style="font-size:12px;color:var(--text3)">Fuerza el envío ahora a todas las familias con responsable.</span>
        </div>
        <details style="margin-bottom:14px;background:var(--bg3);border:1px solid var(--border2);border-radius:10px">
          <summary style="cursor:pointer;padding:12px 14px;font-size:13px;font-weight:700;color:var(--text2);user-select:none">🧪 Herramientas de prueba y previsualización</summary>
          <div style="padding:0 14px 14px">
        <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:10px;padding:12px 14px;margin-bottom:14px">
          <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:8px">👁 Previsualizar resumen agrupado (solo a tu correo)</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <input type="email" id="fc-prev-email" placeholder="tu-email@de-prueba.com" style="background:var(--bg2);border:1px solid var(--border2);border-radius:8px;padding:8px 10px;color:var(--text);font-size:13px;outline:none;width:240px">
            <button class="btn bp" id="fc-prev-btn" style="padding:8px 16px;font-size:13px" onclick="CP.FamiliasAdmin.preview()">Enviarme previsualización</button>
            <span id="fc-prev-msg" style="font-size:12px;color:var(--text3)"></span>
          </div>
          <div style="font-size:11px;color:var(--text3);margin-top:6px">Coge la familia con más facturas pendientes y te manda el resumen SOLO a ti (ignora la pausa). No se envía a ningún cliente.</div>
        </div>
        <div style="background:var(--bg2);border:1px dashed var(--border2);border-radius:10px;padding:12px 14px">
          <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:8px">🧪 Prueba: enviar factura OFICIAL por StelOrder</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <input type="text" id="fc-test-num" placeholder="Ref. (FAC.../INC.../PDT...)" style="background:var(--bg2);border:1px solid var(--border2);border-radius:8px;padding:8px 10px;color:var(--text);font-size:13px;outline:none;width:200px">
            <input type="email" id="fc-test-email" placeholder="tu-email@de-prueba.com" style="background:var(--bg2);border:1px solid var(--border2);border-radius:8px;padding:8px 10px;color:var(--text);font-size:13px;outline:none;width:240px">
            <button class="btn bp" id="fc-test-btn" style="padding:8px 16px;font-size:13px" onclick="CP.FamiliasAdmin.testOfficial()">Enviar prueba</button>
            <button class="btn bgh" id="fc-raw-btn" style="padding:8px 16px;font-size:13px" onclick="CP.FamiliasAdmin.inspectRaw()">🔍 Ver datos crudos</button>
            <span id="fc-test-msg" style="font-size:12px;color:var(--text3)"></span>
          </div>
          <div style="font-size:11px;color:var(--text3);margin-top:6px">"Enviar prueba" usa el nº de factura (FAC...) y manda el PDF oficial al email. "Ver datos crudos" acepta factura (FAC...), incidencia (INC...) o pedido de trabajo (PDT...) y vuelca su JSON para inspeccionar campos y relaciones.</div>
          <pre id="fc-debug-out" style="display:none;background:var(--bg2);border:1px solid var(--border2);border-radius:8px;padding:10px;margin-top:8px;font-size:11px;color:var(--text2);max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-word"></pre>
        </div>
          </div>
        </details>
        <div style="font-size:12px;color:var(--text3);margin-bottom:10px">${conEmail} de ${total} familias con responsable asignado.</div>
        <table>
          <thead><tr><th>Familia</th><th>Email del responsable</th><th>Frecuencia</th><th>Formato</th><th style="text-align:center">Estado</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6"><div class="empty"><div class="et">No hay familias.</div></div></td></tr>'}</tbody>
        </table>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-title">🗺 Gestores por comunidad <span style="font-weight:400;font-size:12px;color:var(--text3)">(aprendido de las respuestas a los avisos)</span></div>
        <div style="font-size:12px;color:var(--text3);margin-bottom:10px">Cuando alguien responde a un aviso (RE: Factura FAC...), el sistema asocia el remitente a la comunidad de esa factura. Confirma los que sean correctos: las futuras notificaciones usarán SOLO los confirmados.</div>
        <div id="fc-managers">Cargando…</div>
      </div>`;
    _loadManagers();
  }

  async function _loadManagers() {
    const box = document.getElementById('fc-managers');
    if (!box) return;
    try {
      const r = await api('/api/managers');
      const list = (r && r.managers) || [];
      if (!list.length) { box.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:8px 0">Aún no se ha aprendido ningún gestor. Se irá llenando solo según respondan a los avisos.</div>'; return; }
      box.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr>
          <th style="text-align:left;padding:6px;color:var(--text3);font-size:11px;border-bottom:2px solid var(--border2)">Comunidad</th>
          <th style="text-align:left;padding:6px;color:var(--text3);font-size:11px;border-bottom:2px solid var(--border2)">Familia</th>
          <th style="text-align:left;padding:6px;color:var(--text3);font-size:11px;border-bottom:2px solid var(--border2)">Gestor/a</th>
          <th style="text-align:center;padding:6px;color:var(--text3);font-size:11px;border-bottom:2px solid var(--border2)">Respuestas</th>
          <th style="text-align:left;padding:6px;color:var(--text3);font-size:11px;border-bottom:2px solid var(--border2)">Refs</th>
          <th style="text-align:center;padding:6px;color:var(--text3);font-size:11px;border-bottom:2px solid var(--border2)">Estado</th>
          <th style="border-bottom:2px solid var(--border2)"></th>
        </tr></thead>
        <tbody>${list.map(m => `<tr>
          <td style="padding:8px 6px;border-bottom:1px solid var(--border2)">${esc(m.communityName || m.accountId)}</td>
          <td style="padding:8px 6px;border-bottom:1px solid var(--border2);color:var(--text3)">${esc(m.family || '—')}</td>
          <td style="padding:8px 6px;border-bottom:1px solid var(--border2)"><strong>${esc(m.managerName || '')}</strong><div style="font-size:11px;color:var(--text3)">${esc(m.managerEmail)}</div></td>
          <td style="padding:8px 6px;border-bottom:1px solid var(--border2);text-align:center;font-weight:700">${m.hits || 1}</td>
          <td style="padding:8px 6px;border-bottom:1px solid var(--border2);font-size:11px;color:var(--text3)">${esc((m.refs || []).slice(-3).join(', '))}</td>
          <td style="padding:8px 6px;border-bottom:1px solid var(--border2);text-align:center">${m.confirmed
            ? '<span style="color:var(--green);font-weight:700;font-size:12px">✓ Confirmado</span>'
            : '<span style="color:var(--amber);font-size:12px">Pendiente</span>'}</td>
          <td style="padding:8px 6px;border-bottom:1px solid var(--border2);text-align:right;white-space:nowrap">
            <button class="btn ${m.confirmed ? 'bgh' : 'bp'}" style="padding:4px 10px;font-size:11px" onclick="CP.FamiliasAdmin.confirmManager('${m._id}', ${m.confirmed ? 'false' : 'true'})">${m.confirmed ? 'Quitar confirmación' : '✓ Confirmar'}</button>
            <button class="btn bgh" style="padding:4px 8px;font-size:11px;color:var(--red);border-color:var(--red)" onclick="CP.FamiliasAdmin.deleteManager('${m._id}', '${esc(m.managerEmail).replace(/'/g, "\\'")}')">🗑</button>
          </td>
        </tr>`).join('')}</tbody>
      </table>`;
    } catch (e) {
      box.innerHTML = `<div style="color:var(--red);font-size:13px">Error: ${esc(e.message)}</div>`;
    }
  }

  async function confirmManager(id, confirmed) {
    try { await api('/api/managers/' + id, { method:'PUT', body: JSON.stringify({ confirmed }) }); _loadManagers(); }
    catch (e) { alert('No se pudo: ' + e.message); }
  }

  async function deleteManager(id, email) {
    if (!confirm(`¿Borrar la asociación de ${email}? Si vuelve a responder a un aviso, se aprenderá de nuevo.`)) return;
    try { await api('/api/managers/' + id, { method:'DELETE' }); _loadManagers(); }
    catch (e) { alert('No se pudo: ' + e.message); }
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
    const freq   = document.getElementById('fc-freq-'+i)?.value || 'manual';
    const format = document.getElementById('fc-format-'+i)?.value || 'grouped';
    const modo   = document.getElementById('fc-modo-'+i)?.value || 'familia';
    const msg = document.getElementById('fc-msg-'+i);
    if (msg) { msg.textContent='Guardando...'; msg.style.color='var(--text3)'; }
    try {
      const r = await api('/api/family-contacts', { method:'PUT', body: JSON.stringify({ family: c.family, email, paused, freq, format, modo }) });
      if (r && r.error) throw new Error(r.error);
      c.email = email; c.paused = paused; c.freq = freq; c.format = format; c.modo = modo;
      if (msg) { msg.textContent='✓ Guardado'; msg.style.color='var(--green)'; setTimeout(()=>{ if(msg && msg.textContent==='✓ Guardado') msg.textContent=''; }, 2500); }
    } catch(err) {
      if (msg) { msg.textContent='✗ '+err.message; msg.style.color='var(--red)'; }
    }
  }

  async function sendNow(format) {
    const label = format === 'individual' ? 'una por factura (individual)' : 'un resumen agrupado';
    if (!confirm(`¿Enviar AHORA ${label} a cada familia con responsable asignado? Ignora la frecuencia configurada y envía ya.`)) return;
    const msg = document.getElementById('fc-sum-msg');
    if (msg) { msg.textContent='Enviando...'; msg.style.color='var(--text2)'; }
    try {
      const url = format === 'individual' ? '/api/send-family-individual' : '/api/send-family-summaries';
      const r = await api(url, { method:'POST', body: JSON.stringify({}) });
      if (r && r.error) throw new Error(r.error);
      if (msg) {
        let txt = '✓ ' + (r.message || 'Hecho');
        if (r.sinEmail && r.sinEmail.length) {
          txt += ` · ⚠️ ${r.sinEmail.length} sin email: ${r.sinEmail.join(', ')}`;
          msg.style.color = 'var(--amber)';
        } else { msg.style.color = 'var(--green)'; }
        msg.textContent = txt;
      }
    } catch(err) {
      if (msg) { msg.textContent = '✗ ' + err.message; msg.style.color='var(--red)'; }
    }
  }

  async function testOfficial() {
    const number = document.getElementById('fc-test-num')?.value?.trim();
    const email  = document.getElementById('fc-test-email')?.value?.trim();
    const msg = document.getElementById('fc-test-msg');
    const btn = document.getElementById('fc-test-btn');
    if (!number || !email) { if (msg) { msg.textContent='Pon nº de factura y email'; msg.style.color='var(--amber)'; } return; }
    if (btn && btn.disabled) return;                 // ya hay un envío en curso
    if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; btn.textContent = 'Enviando…'; }
    if (msg) { msg.textContent='StelOrder está enviando (puede tardar ~30s)…'; msg.style.color='var(--text2)'; }
    try {
      const r = await api('/api/invoice/send-official', { method:'POST', body: JSON.stringify({ number, email }) });
      if (r && r.error) throw new Error(r.error);
      if (msg) { msg.textContent = '✓ ' + (r.message || 'Enviada'); msg.style.color='var(--green)'; }
      const out = document.getElementById('fc-debug-out');
      if (out) { out.style.display='block'; out.textContent = 'RESPUESTA de sendDocument:\n' + JSON.stringify(r.data, null, 2); }
    } catch(err) {
      if (msg) { msg.textContent = '✗ ' + err.message; msg.style.color='var(--red)'; }
    } finally {
      if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.textContent = 'Enviar prueba'; }
    }
  }

  async function inspectRaw() {
    const ref = document.getElementById('fc-test-num')?.value?.trim();
    const msg = document.getElementById('fc-test-msg');
    const out = document.getElementById('fc-debug-out');
    if (!ref) { if (msg) { msg.textContent='Pon una referencia (FAC.../INC.../PDT...)'; msg.style.color='var(--amber)'; } return; }
    if (msg) { msg.textContent='Consultando datos… (puede tardar)'; msg.style.color='var(--text2)'; }
    try {
      const r = await api('/api/debug/raw', { method:'POST', body: JSON.stringify({ ref }) });
      if (r && r.error) throw new Error(r.error);
      if (msg) { msg.textContent = '✓ Datos cargados (revisa abajo)'; msg.style.color='var(--green)'; }
      if (out) { out.style.display='block'; out.textContent = ref.toUpperCase() + ':\n' + JSON.stringify(r.data, null, 2); }
    } catch(err) {
      if (msg) { msg.textContent = '✗ ' + err.message; msg.style.color='var(--red)'; }
    }
  }

  async function preview() {
    const email = document.getElementById('fc-prev-email')?.value?.trim();
    const msg = document.getElementById('fc-prev-msg');
    const btn = document.getElementById('fc-prev-btn');
    if (!email) { if (msg) { msg.textContent='Pon tu email'; msg.style.color='var(--amber)'; } return; }
    if (btn && btn.disabled) return;
    if (btn) { btn.disabled = true; btn.style.opacity='0.5'; btn.textContent='Generando…'; }
    if (msg) { msg.textContent='Generando previsualización (puede tardar unos segundos)…'; msg.style.color='var(--text2)'; }
    try {
      const r = await api('/api/avisos/preview', { method:'POST', body: JSON.stringify({ email }) });
      if (r && r.error) throw new Error(r.error);
      if (msg) { msg.textContent = '✓ ' + (r.message || 'Enviada'); msg.style.color='var(--green)'; }
    } catch(err) {
      if (msg) { msg.textContent = '✗ ' + err.message; msg.style.color='var(--red)'; }
    } finally {
      if (btn) { btn.disabled = false; btn.style.opacity='1'; btn.textContent='Enviarme previsualización'; }
    }
  }

  CP.FamiliasAdmin = { render, save, toggleGlobal, sendNow, testOfficial, inspectRaw, preview, confirmManager, deleteManager };

})(window.CP = window.CP || {});
