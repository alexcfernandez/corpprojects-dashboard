// modules/obras.js — Gestión de obras y rentabilidad
(function(CP) {
  'use strict';

  // ── Todo desde config central ─────────────────────────────────
  const ESTADOS = window.CP_CONFIG.estadosObras;

  const eur = v => new Intl.NumberFormat('es-ES',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(v||0);

  function api(url, opts={}) {
    const tok = localStorage.getItem('cp_token');
    return fetch(url, {
      ...opts,
      headers: {'Authorization':`Bearer ${tok}`,'Content-Type':'application/json',...(opts.headers||{})}
    }).then(r => r.json());
  }

  function render(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;

    el.innerHTML = `
      <div style="display:flex;gap:0;border-bottom:1px solid var(--border);margin-bottom:20px;overflow-x:auto">
        <button class="btab active" onclick="CP.Obras.showTab('resumen',this)">📊 Rentabilidad</button>
        <button class="btab" onclick="CP.Obras.showTab('lista',this)">🏗️ Obras</button>
        <button class="btab" onclick="CP.Obras.showTab('nueva',this)">➕ Nueva obra</button>
      </div>

      <div id="ob-tab-resumen" class="p-tab active">
        <div class="alert ain" style="margin-bottom:16px">
          <div>📊</div>
          <div><strong>Rentabilidad por obra</strong> — cruza los partes de trabajo con lo facturado para saber si cada obra gana o pierde dinero.</div>
        </div>
        <div id="ob-resumen-metrics" class="metrics-row" style="margin-bottom:16px"></div>
        <div id="ob-resumen-lista">
          <div class="empty"><div class="ei">📊</div><div class="et">Cargando rentabilidad...</div></div>
        </div>
      </div>

      <div id="ob-tab-lista" class="p-tab" style="display:none">
        <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:flex-end">
          <div>
            <span class="field-label">Buscar</span>
            <input type="text" id="ob-search" class="srch" placeholder="Cliente o referencia..." style="width:220px" oninput="CP.Obras.loadLista()">
          </div>
          <div>
            <span class="field-label">Estado</span>
            <select id="ob-status-filter" onchange="CP.Obras.loadLista()">
              <option value="">Todas</option>
              ${Object.entries(ESTADOS).map(([k,v])=>`<option value="${k}">${v.emoji} ${v.label}</option>`).join('')}
            </select>
          </div>
        </div>
        <div id="ob-lista">Cargando...</div>
      </div>

      <div id="ob-tab-nueva" class="p-tab" style="display:none">
        <div class="card" style="max-width:600px">
          <div class="card-title" id="ob-form-title">Nueva obra</div>
          ${renderForm()}
          <div id="ob-form-msg" style="margin-top:10px;font-size:12px;display:none"></div>
          <div style="display:flex;gap:8px;margin-top:16px">
            <button class="btn bp" id="ob-submit-btn" onclick="CP.Obras.submitObra()">💾 Crear obra</button>
            <button class="btn bgh" onclick="CP.Obras.resetForm()">Limpiar</button>
          </div>
        </div>
      </div>`;

    loadResumen();
  }

  function renderForm(obra={}) {
    return `
      <div class="field-grid-2" style="margin-bottom:12px">
        <div>
          <span class="field-label">Cliente *</span>
          <input type="text" id="ob-client" value="${obra.clientName||''}" list="ob-clients-list" placeholder="Buscar cliente..." autocomplete="off" class="field-input">
          <datalist id="ob-clients-list"></datalist>
        </div>
        <div>
          <span class="field-label">Estado</span>
          <select id="ob-status" class="field-input">
            ${Object.entries(ESTADOS).map(([k,v])=>`<option value="${k}" ${obra.status===k?'selected':''}>${v.emoji} ${v.label}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field-row">
        <span class="field-label">Referencia de obra * <span style="font-weight:400;text-transform:none;font-size:10px">(nombre interno)</span></span>
        <div style="display:flex;gap:6px">
          <input type="text" id="ob-reference" value="${obra.reference||''}" placeholder="Ej: Pedrosa – fachada" class="field-input" style="flex:1">
          <button type="button" class="btn bgh" style="white-space:nowrap" onclick="CP.Obras.sugerirRef()">💡 Sugerir</button>
        </div>
        <div style="font-size:10px;color:var(--text3);margin-top:3px">Si en una misma calle hay varias obras, dales nombres distintos (Pedrosa – fachada, Pedrosa – tejado) para separar coste y presencia.</div>
      </div>
      <div class="field-row">
        <span class="field-label">Dirección</span>
        <input type="text" id="ob-address" value="${obra.address||''}" placeholder="Calle, número, población" class="field-input">
      </div>
      <div class="field-grid-2" style="margin-bottom:12px">
        <div>
          <span class="field-label">Fecha inicio</span>
          <input type="date" id="ob-start" value="${obra.startDate||new Date().toISOString().slice(0,10)}" class="field-input">
        </div>
        <div>
          <span class="field-label">Precio presupuestado (€)</span>
          <input type="number" id="ob-budget" value="${obra.budgetAmount||''}" min="0" placeholder="0" class="field-input">
        </div>
      </div>
      <div class="field-row">
        <span class="field-label">Descripción / notas</span>
        <textarea id="ob-desc" rows="2" class="field-input" style="resize:vertical" placeholder="Tipo de trabajo, materiales principales...">${obra.description||''}</textarea>
      </div>`;
  }

  function showTab(id, btn) {
    document.querySelectorAll('#obras-container .p-tab').forEach(p => { p.style.display='none'; p.classList.remove('active'); });
    document.querySelectorAll('#obras-container .btab').forEach(b => b.classList.remove('active'));
    const tab = document.getElementById('ob-tab-' + id);
    if (tab) { tab.style.display='block'; tab.classList.add('active'); }
    if (btn) btn.classList.add('active');
    if (id === 'resumen') loadResumen();
    if (id === 'lista')   loadLista();
    if (id === 'nueva')   loadClientSuggestions();
  }

  async function loadClientSuggestions() {
    const dl = document.getElementById('ob-clients-list');
    if (!dl) return;
    try {
      if (!window._cpClients) window._cpClients = await api('/api/clients/list');
      dl.innerHTML = (window._cpClients||[]).map(n=>`<option value="${n}">`).join('');
    } catch(e) {}
  }

  async function loadResumen() {
    const el      = document.getElementById('ob-resumen-lista');
    const metrics = document.getElementById('ob-resumen-metrics');
    if (!el) return;
    try {
      const data = await api('/api/obras/resumen');
      if (!data.length) {
        el.innerHTML = `
          <div class="empty">
            <div class="ei">🏗️</div>
            <div class="et">No hay obras registradas todavía</div>
            <button class="btn bp" style="margin-top:14px" onclick="CP.Obras.showTab('nueva',null)">➕ Crear primera obra</button>
          </div>`;
        return;
      }

      const totalObras    = data.length;
      const obrasActivas  = data.filter(o => o.obra?.status === 'activa').length;
      const totalFacturado = data.reduce((s,o) => s+(o.facturado||0), 0);
      const totalCoste    = data.reduce((s,o) => s+(o.totalCoste||0), 0);
      const totalBeneficio = totalFacturado - totalCoste;
      const margenGlobal  = totalFacturado > 0 ? (totalBeneficio/totalFacturado*100) : 0;

      if (metrics) metrics.innerHTML = `
        <div class="mc"><div class="ml">Obras activas</div><div class="mv g">${obrasActivas}</div><div class="ms">de ${totalObras} total</div></div>
        <div class="mc"><div class="ml">Total facturado</div><div class="mv b">${eur(totalFacturado)}</div></div>
        <div class="mc"><div class="ml">Coste total</div><div class="mv r">${eur(totalCoste)}</div></div>
        <div class="mc"><div class="ml">Beneficio total</div><div class="mv ${totalBeneficio>=0?'g':'r'}">${eur(totalBeneficio)}</div></div>
        <div class="mc"><div class="ml">Margen global</div><div class="mv ${margenGlobal>=20?'g':margenGlobal>=0?'a':'r'}">${margenGlobal.toFixed(1)}%</div></div>`;

      el.innerHTML = `<div style="display:grid;gap:10px">
        ${data.map(o => {
          const obra = o.obra || {};
          const est  = ESTADOS[obra.status] || ESTADOS.activa;
          const diag = o.diagnostico;
          const pct  = o.facturado > 0 ? Math.min(100,(o.totalCoste/o.facturado)*100) : 0;
          const ok   = o.margen >= 0;
          return `
            <div style="background:var(--bg2);border:1px solid ${diag?diag.color+'33':'var(--border)'};border-radius:var(--r);padding:16px;cursor:pointer;transition:all .15s"
              onclick="CP.Obras.openObra('${o.obraId}')"
              onmouseover="this.style.background='var(--bg3)'"
              onmouseout="this.style.background='var(--bg2)'">
              <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px;gap:10px">
                <div style="flex:1;min-width:0">
                  <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
                    <span style="font-size:16px">${est.emoji}</span>
                    <strong style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${obra.reference||'Sin referencia'}</strong>
                  </div>
                  <div style="font-size:11px;color:var(--text3)">${obra.clientName||''} ${obra.address?'· '+obra.address:''}</div>
                </div>
                <div style="text-align:right;flex-shrink:0">
                  <div style="font-size:18px;font-weight:700;color:${ok?'var(--green)':'var(--red)'};font-family:'Space Grotesk',sans-serif">${ok?'+':''}${eur(o.beneficio)}</div>
                  <div style="font-size:11px;color:${o.margen>=20?'var(--green)':o.margen>=0?'var(--amber)':'var(--red)'}">${o.margen.toFixed(1)}% margen</div>
                </div>
              </div>
              ${o.facturado > 0 ? `
              <div style="background:var(--bg3);border-radius:4px;height:6px;margin-bottom:8px;overflow:hidden">
                <div style="height:100%;width:${pct}%;background:${pct>100?'var(--red)':pct>80?'var(--amber)':'var(--green)'};border-radius:4px"></div>
              </div>` : ''}
              <div style="display:flex;gap:16px;font-size:11px;color:var(--text2)">
                <span>💰 Facturado: <strong style="color:var(--text)">${eur(o.facturado)}</strong></span>
                <span>⚡ Coste: <strong style="color:var(--red)">${eur(o.totalCoste)}</strong></span>
                <span>⏱️ <strong>${o.totalHoras?.toFixed(0)||0} h</strong></span>
                <span>📋 <strong>${o.partes||0} partes</strong></span>
              </div>
              ${diag ? `<div style="margin-top:8px;padding:6px 10px;background:${diag.color}15;border-radius:6px;font-size:11px;color:${diag.color}">
                ${diag.emoji} ${diag.mensaje}
                ${diag.recomendacion?`<br><span style="color:var(--text2)">${diag.recomendacion}</span>`:''}
              </div>` : ''}
            </div>`;
        }).join('')}
      </div>`;
    } catch(err) {
      el.innerHTML = `<div style="color:var(--red);font-size:12px;padding:10px">Error: ${err.message}</div>`;
    }
  }

  async function loadLista() {
    const el     = document.getElementById('ob-lista');
    if (!el) return;
    const search = document.getElementById('ob-search')?.value   || '';
    const status = document.getElementById('ob-status-filter')?.value || '';
    try {
      const data = await api(`/api/obras?${new URLSearchParams({search,status})}`);
      if (!data.length) {
        el.innerHTML = '<div class="empty"><div class="ei">🏗️</div><div class="et">No hay obras con estos filtros</div></div>';
        return;
      }
      el.innerHTML = `<div style="display:grid;gap:8px">
        ${data.map(obra => {
          const est = ESTADOS[obra.status] || ESTADOS.activa;
          return `
            <div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--rs);padding:14px 16px;display:flex;align-items:center;gap:12px;cursor:pointer"
              onclick="CP.Obras.openObra('${obra._id}')">
              <div style="font-size:24px">${est.emoji}</div>
              <div style="flex:1;min-width:0">
                <div style="font-weight:600;font-size:13px">${obra.reference}</div>
                <div style="font-size:11px;color:var(--text3)">${obra.clientName} ${obra.address?'· '+obra.address:''}</div>
                ${obra.budgetAmount?`<div style="font-size:11px;color:var(--text2)">Presupuesto: ${eur(obra.budgetAmount)}</div>`:''}
              </div>
              <div style="text-align:right;flex-shrink:0">
                <div style="font-size:11px;font-weight:600;color:${est.color}">${est.label}</div>
                <div style="font-size:10px;color:var(--text3)">${obra.startDate||''}</div>
              </div>
            </div>`;
        }).join('')}
      </div>`;
    } catch(err) {
      el.innerHTML = `<div style="color:var(--red);font-size:12px">Error: ${err.message}</div>`;
    }
  }

  async function openObra(id) {
    try {
      const [obra, rent] = await Promise.all([
        api(`/api/obras/${id}`),
        api(`/api/obras/${id}/rentabilidad`)
      ]);

      document.getElementById('ob-modal')?.remove();
      const modal = document.createElement('div');
      modal.id = 'ob-modal';
      modal.className = 'modal-overlay';

      const est  = ESTADOS[obra.status] || ESTADOS.activa;
      const diag = rent.diagnostico;
      const ok   = rent.beneficio >= 0;

      modal.innerHTML = `
        <div class="modal-box" style="max-width:620px">
          <div class="modal-header">
            <div>
              <div style="font-size:16px;font-weight:700">${est.emoji} ${obra.reference}</div>
              <div style="font-size:12px;color:var(--text3)">${obra.clientName} ${obra.address?'· '+obra.address:''}</div>
            </div>
            <button class="modal-close" onclick="document.getElementById('ob-modal').remove()">✕</button>
          </div>

          ${diag ? `
          <div style="padding:12px 14px;background:${diag.color}18;border:1px solid ${diag.color}44;border-radius:var(--rs);margin-bottom:14px">
            <div style="font-size:14px;font-weight:600;color:${diag.color};margin-bottom:3px">${diag.emoji} ${diag.mensaje}</div>
            ${diag.recomendacion?`<div style="font-size:12px;color:var(--text2)">${diag.recomendacion}</div>`:''}
          </div>` : `
          <div style="padding:10px;background:var(--bg3);border-radius:var(--rs);margin-bottom:14px;font-size:12px;color:var(--text3)">
            Sin facturación registrada. Añade el presupuesto para ver la rentabilidad.
          </div>`}

          <div class="metrics-row" style="margin-bottom:14px">
            <div class="mc"><div class="ml">Facturado</div><div class="mv b">${eur(rent.facturado)}</div></div>
            <div class="mc"><div class="ml">Coste personal</div><div class="mv r">${eur(rent.totalCostePersonal)}</div></div>
            <div class="mc"><div class="ml">Materiales</div><div class="mv r">${eur(rent.totalMateriales)}</div></div>
            <div class="mc"><div class="ml">Beneficio</div><div class="mv ${ok?'g':'r'}">${eur(rent.beneficio)}</div></div>
            <div class="mc"><div class="ml">Horas totales</div><div class="mv b">${(rent.totalHoras||0).toFixed(0)} h</div></div>
            <div class="mc"><div class="ml">Partes</div><div class="mv b">${rent.partes}</div></div>
          </div>

          ${rent.byWorker?.length ? `
          <div class="card" style="margin-bottom:12px">
            <div class="card-title">Personal en esta obra</div>
            <table>
              <thead><tr><th>Trabajador</th><th style="text-align:right">Días</th><th style="text-align:right">Horas</th><th style="text-align:right">Coste</th></tr></thead>
              <tbody>${rent.byWorker.map(w=>`<tr>
                <td><strong>${w.name}</strong></td>
                <td style="text-align:right">${w.dias}</td>
                <td style="text-align:right">${w.horas.toFixed(0)} h</td>
                <td style="text-align:right;color:var(--red)">${eur(w.coste)}</td>
              </tr>`).join('')}</tbody>
            </table>
          </div>` : ''}

          <div class="card" style="margin-bottom:12px">
            <div class="card-title">🧱 Material de la obra</div>
            ${(obra.materiales&&obra.materiales.length)?`<table><thead><tr><th>Concepto</th><th style="text-align:right">Importe</th><th></th></tr></thead><tbody>${obra.materiales.map(m=>`<tr><td>${String(m.concepto||'').replace(/</g,'&lt;')}</td><td style="text-align:right">${eur(m.importe)}</td><td style="text-align:right"><button class="btn bgh" style="padding:2px 8px" onclick="CP.Obras.delMaterial('${id}','${m.id}')">✕</button></td></tr>`).join('')}</tbody></table>`:'<div style="font-size:12px;color:var(--text3);margin-bottom:8px">Sin material añadido todavía.</div>'}
            <div style="display:flex;gap:6px;margin-top:8px">
              <input type="text" id="ob-mat-concepto" class="field-input" placeholder="Concepto (ej: sacos cemento)" style="flex:1">
              <input type="number" id="ob-mat-importe" class="field-input" placeholder="€" style="width:90px" min="0">
              <button class="btn bp" onclick="CP.Obras.addMaterial('${id}')">+ Añadir</button>
            </div>
          </div>

          <div class="card">
            <div class="card-title">Actualizar obra</div>
            <div class="field-grid-2" style="margin-bottom:10px">
              <div>
                <span class="field-label">Estado</span>
                <select id="ob-edit-status" class="field-input">
                  ${Object.entries(ESTADOS).map(([k,v])=>`<option value="${k}" ${obra.status===k?'selected':''}>${v.emoji} ${v.label}</option>`).join('')}
                </select>
              </div>
              <div>
                <span class="field-label">Presupuesto (€)</span>
                <input type="number" id="ob-edit-budget" value="${obra.budgetAmount||''}" min="0" class="field-input">
              </div>
            </div>
            <div style="margin-bottom:10px">
              <span class="field-label">Otros nombres que cuentan (partes / presencia)</span>
              <input type="text" id="ob-edit-aliases" value="${(obra.aliases||[]).join(', ')}" class="field-input" placeholder="Ej: calle comerç, comerç 76">
              <div style="font-size:11px;color:var(--text3);margin-top:4px">Separa por comas. Añade aquí cómo se llamó la obra en los partes o la presencia, para que sus horas cuenten en esta obra.</div>
            </div>
            <div style="display:flex;gap:8px">
              <button class="btn bp" onclick="CP.Obras.saveObraChanges('${id}')">💾 Guardar</button>
              <button class="btn bgh" onclick="document.getElementById('ob-modal').remove()">Cerrar</button>
            </div>
            <div id="ob-modal-msg" style="margin-top:8px;font-size:11px;display:none"></div>
          </div>
        </div>`;

      document.body.appendChild(modal);
      modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });
    } catch(err) { alert('Error: ' + err.message); }
  }

  async function saveObraChanges(id) {
    const status       = document.getElementById('ob-edit-status')?.value;
    const budgetAmount = parseFloat(document.getElementById('ob-edit-budget')?.value || 0);
    const aliases      = (document.getElementById('ob-edit-aliases')?.value || '').split(',').map(s=>s.trim()).filter(Boolean);
    const msg = document.getElementById('ob-modal-msg');
    try {
      await api(`/api/obras/${id}`, { method:'PUT', body: JSON.stringify({ status, budgetAmount, aliases }) });
      openObra(id); // recargar la ficha para ver la rentabilidad recalculada
      if (msg) { msg.textContent='✅ Guardado'; msg.style.display='block'; msg.style.color='var(--green)'; setTimeout(()=>msg.style.display='none',2000); }
      loadResumen();
    } catch(err) {
      if (msg) { msg.textContent='❌ '+err.message; msg.style.display='block'; msg.style.color='var(--red)'; }
    }
  }

  async function submitObra() {
    const data = {
      clientName:   document.getElementById('ob-client')?.value?.trim(),
      reference:    document.getElementById('ob-reference')?.value?.trim(),
      address:      document.getElementById('ob-address')?.value?.trim(),
      status:       document.getElementById('ob-status')?.value,
      startDate:    document.getElementById('ob-start')?.value,
      budgetAmount: parseFloat(document.getElementById('ob-budget')?.value || 0),
      description:  document.getElementById('ob-desc')?.value?.trim(),
    };
    const msg = document.getElementById('ob-form-msg');
    if (!data.clientName || !data.reference) {
      if (msg) { msg.textContent='⚠️ Cliente y referencia son obligatorios'; msg.style.display='block'; msg.style.color='var(--amber)'; }
      return;
    }
    try {
      const result = await api('/api/obras', { method:'POST', body: JSON.stringify(data) });
      if (result.error) throw new Error(result.error);
      if (msg) { msg.textContent=`✅ Obra "${data.reference}" creada`; msg.style.display='block'; msg.style.color='var(--green)'; }
      resetForm();
      setTimeout(() => showTab('resumen', null), 1500);
    } catch(err) {
      if (msg) { msg.textContent='❌ '+err.message; msg.style.display='block'; msg.style.color='var(--red)'; }
    }
  }

  function resetForm() {
    ['ob-client','ob-reference','ob-address','ob-budget','ob-desc'].forEach(id => {
      const e = document.getElementById(id); if(e) e.value='';
    });
    const s = document.getElementById('ob-start');
    if (s) s.value = new Date().toISOString().slice(0,10);
    const msg = document.getElementById('ob-form-msg');
    if (msg) msg.style.display='none';
  }

  async function sugerirRef() {
    const c = document.getElementById('ob-client'); const r = document.getElementById('ob-reference');
    const d = document.getElementById('ob-desc'); const a = document.getElementById('ob-address');
    if (!c || !r) return;
    const clientName = (c.value || '').trim();
    if (!clientName && !(d && d.value.trim())) { alert('Pon primero el cliente o una descripción y te sugiero un nombre.'); return; }
    const prev = r.value; r.value = 'pensando…'; r.disabled = true;
    try {
      const resp = await api('/api/obras/sugerir-ref', { method: 'POST', body: JSON.stringify({ clientName, description: d ? d.value.trim() : '', address: a ? a.value.trim() : '' }) });
      r.value = (resp && resp.nombre) ? resp.nombre : (prev || clientName + ' – ');
    } catch (e) { r.value = prev || clientName + ' – '; }
    r.disabled = false; r.focus();
  }

  async function addMaterial(id) {
    const concepto = document.getElementById('ob-mat-concepto')?.value?.trim();
    const importe  = parseFloat(document.getElementById('ob-mat-importe')?.value || 0);
    if (!importe || importe <= 0) { alert('Pon un importe válido para el material.'); return; }
    try { await api(`/api/obras/${id}/material`, { method:'POST', body: JSON.stringify({ concepto, importe }) }); openObra(id); loadResumen(); }
    catch (err) { alert('Error: ' + err.message); }
  }
  async function delMaterial(id, matId) {
    if (!confirm('¿Borrar este material?')) return;
    try { await api(`/api/obras/${id}/material/${matId}`, { method:'DELETE' }); openObra(id); loadResumen(); }
    catch (err) { alert('Error: ' + err.message); }
  }

  CP.Obras = { render, showTab, loadResumen, loadLista, openObra, saveObraChanges, submitObra, resetForm, sugerirRef, addMaterial, delMaterial };

})(window.CP = window.CP || {});
