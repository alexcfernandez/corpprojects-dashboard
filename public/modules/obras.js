// modules/obras.js — Gestión de obras y rentabilidad
(function(CP) {
  'use strict';

  // ── Todo desde config central ─────────────────────────────────
  const ESTADOS = window.CP_CONFIG.estadosObras;

  const eur = v => new Intl.NumberFormat('es-ES',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(v||0);
  const ceMod = s => String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

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

      el.innerHTML = `<div style="display:grid;grid-template-columns:minmax(0,1fr);gap:10px">
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
                  <div style="font-size:18px;font-weight:700;color:${o.beneficio>=0?'var(--green)':'var(--red)'};font-family:'Space Grotesk',sans-serif">${o.beneficio>0?'+':''}${eur(o.beneficio)}</div>
                  <div style="font-size:11px;color:${o.margen>=20?'var(--green)':o.margen>=0?'var(--amber)':'var(--red)'}">${o.margen.toFixed(1)}% margen</div>
                </div>
              </div>
              ${o.facturado > 0 ? `
              <div style="background:var(--bg3);border-radius:4px;height:6px;margin-bottom:8px;overflow:hidden">
                <div style="height:100%;width:${pct}%;background:${pct>100?'var(--red)':pct>80?'var(--amber)':'var(--green)'};border-radius:4px"></div>
              </div>` : ''}
              <div style="display:flex;flex-wrap:wrap;gap:6px 16px;font-size:11px;color:var(--text2)">
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
      const cert = rent.certificaciones || { certs:[], certificado:0, cobrado:0, pendiente:0, sinCertificar:0, pctCertificado:0 };
      const ce = s => String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
      _obraData = { obra, certs: cert.certs };

      // Estimado vs Real: tiempo (días) y equipo
      const estT = obra.tiempoEstimado;
      const estDias = (estT && estT.valor) ? (estT.unidad === 'horas' ? Math.round((estT.valor/8)*10)/10 : Number(estT.valor)) : null;
      const realDias = Object.keys(rent.byDate || {}).length;
      const desvDias = estDias != null ? Math.round((realDias - estDias)*10)/10 : null;
      const equipoPrev = (obra.equipoPresup || []).map(x => x && x.name).filter(Boolean);
      const equipoReal = (rent.byWorker || []).map(w => w && w.name).filter(Boolean);

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

          ${(rent.costePresupuestado > 0 || estDias != null || equipoPrev.length || realDias) ? `
          <div class="card" style="margin-bottom:14px">
            <div class="card-title">📊 Estimado vs Real</div>
            ${rent.costePresupuestado > 0 ? `
            <div class="metrics-row">
              <div class="mc"><div class="ml">Coste estimado</div><div class="mv b">${eur(rent.costePresupuestado)}</div></div>
              <div class="mc"><div class="ml">Coste real (acumulado)</div><div class="mv r">${eur(rent.totalCoste)}</div></div>
              <div class="mc"><div class="ml">Desvío coste</div><div class="mv ${rent.desvioCoste<=0?'g':'r'}">${rent.desvioCoste>0?'+':''}${eur(rent.desvioCoste)} (${rent.desvioCoste>0?'+':''}${(rent.desvioCoste/rent.costePresupuestado*100).toFixed(0)}%)</div></div>
            </div>` : ''}
            ${estDias != null ? `
            <div class="metrics-row" style="margin-top:10px">
              <div class="mc"><div class="ml">Días estimados</div><div class="mv b">${estDias} d</div></div>
              <div class="mc"><div class="ml">Días trabajados</div><div class="mv r">${realDias} d</div></div>
              <div class="mc"><div class="ml">Desvío tiempo</div><div class="mv ${desvDias<=0?'g':'r'}">${desvDias>0?'+':''}${desvDias} d</div></div>
            </div>` : (realDias ? `<div style="font-size:12px;color:var(--text2);margin-top:8px">Días trabajados: <b>${realDias}</b> <span style="color:var(--text3)">(sin estimación de tiempo en el presupuesto)</span></div>` : '')}
            ${(equipoPrev.length || equipoReal.length) ? `
            <div style="margin-top:10px;font-size:12px;color:var(--text2)">
              <div><span style="color:var(--text3)">Equipo previsto:</span> ${equipoPrev.length?equipoPrev.map(ce).join(', '):'—'}</div>
              <div style="margin-top:2px"><span style="color:var(--text3)">Equipo real:</span> ${equipoReal.length?equipoReal.map(ce).join(', '):'—'}</div>
            </div>` : ''}
            ${(rent.costePresupuestado>0 || (estDias!=null)) ? `<div style="font-size:11px;color:var(--text3);margin-top:8px">${rent.costePresupuestado>0?(rent.desvioCoste>0?'⚠️ Vas gastando más de lo presupuestado.':'✅ En coste, por debajo de lo presupuestado.'):''}${(estDias!=null&&desvDias>0)?' ⚠️ Llevas más días de los estimados.':((estDias!=null&&desvDias<=0)?' ✅ En plazo de tiempo.':'')}</div>` : ''}
          </div>` : ''}

          <div class="metrics-row" style="margin-bottom:14px">
            <div class="mc"><div class="ml">Facturado</div><div class="mv b">${eur(rent.facturado)}</div></div>
            <div class="mc"><div class="ml">Coste personal</div><div class="mv r">${eur(rent.totalCostePersonal)}</div></div>
            <div class="mc"><div class="ml">Materiales</div><div class="mv r">${eur(rent.totalMateriales)}</div></div>
            <div class="mc"><div class="ml">Proveedores</div><div class="mv r">${eur(rent.totalProveedores||0)}</div></div>
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
            <div class="card-title">🧾 Facturas de proveedor</div>
            ${(rent.proveedores&&rent.proveedores.length)?`<table><thead><tr><th>Proveedor</th><th style="text-align:right">Importe</th><th></th></tr></thead><tbody>${rent.proveedores.map(p=>`<tr>
              <td><strong>${String(p.supplier||'—').replace(/</g,'&lt;')}</strong><div style="font-size:11px;color:var(--text3)">${String(p.number||'')}${p.categoria?' · '+p.categoria:''}${p.fuente&&p.fuente!=='manual'?' · '+p.fuente:''}</div></td>
              <td style="text-align:right;color:var(--red)">${eur(p.total)}</td>
              <td style="text-align:right">${p.fuente==='reparto'?`<button class="btn bgh" style="padding:2px 8px" title="Quitar de esta obra" onclick="CP.Obras.quitarReparto('${p.id}','${id}')">✕</button>`:(p.fuente==='manual'?`<button class="btn bgh" style="padding:2px 8px" title="Quitar de esta obra" onclick="CP.Obras.quitarFactura('${p.id}','${id}')">✕</button>`:'')}</td>
            </tr>`).join('')}</tbody></table>`:'<div style="font-size:12px;color:var(--text3)">Ninguna factura de proveedor asignada todavía.</div>'}
            <div style="margin-top:10px"><button class="btn bp" style="padding:6px 12px;font-size:12px" onclick="CP.Obras.abrirPickerFacturas('${id}','${String((obra.reference||'')+' — '+(obra.clientName||'')).replace(/'/g,'').replace(/"/g,'')}')">+ Añadir factura</button></div>
          </div>

          <div class="card" style="margin-bottom:12px">
            <div class="card-title">🧱 Material de la obra</div>
            ${(obra.materiales&&obra.materiales.length)?`<table><thead><tr><th>Concepto</th><th style="text-align:right">Importe</th><th></th></tr></thead><tbody>${obra.materiales.map(m=>`<tr><td>${String(m.concepto||'').replace(/</g,'&lt;')}</td><td style="text-align:right">${eur(m.importe)}</td><td style="text-align:right"><button class="btn bgh" style="padding:2px 8px" onclick="CP.Obras.delMaterial('${id}','${m.id}')">✕</button></td></tr>`).join('')}</tbody></table>`:'<div style="font-size:12px;color:var(--text3);margin-bottom:8px">Sin material añadido todavía.</div>'}
            <div style="display:flex;gap:6px;margin-top:8px">
              <input type="text" id="ob-mat-concepto" class="field-input" placeholder="Concepto (ej: sacos cemento)" style="flex:1">
              <input type="number" id="ob-mat-importe" class="field-input" placeholder="€" style="width:90px" min="0">
              <button class="btn bp" onclick="CP.Obras.addMaterial('${id}')">+ Añadir</button>
            </div>
          </div>

          <div class="card" style="margin-bottom:12px">
            <div class="card-title">🧾 Certificaciones y cobros</div>
            <div class="metrics-row" style="margin-bottom:10px">
              <div class="mc"><div class="ml">Certificado</div><div class="mv b">${eur(cert.certificado)} <span style="font-size:11px;color:var(--text3)">${cert.pctCertificado}%</span></div></div>
              <div class="mc"><div class="ml">Cobrado</div><div class="mv g">${eur(cert.cobrado)}</div></div>
              <div class="mc"><div class="ml">Pendiente</div><div class="mv ${cert.pendiente>0?'a':''}">${eur(cert.pendiente)}</div></div>
              <div class="mc"><div class="ml">Sin certificar</div><div class="mv">${eur(cert.sinCertificar)}</div></div>
            </div>
            ${cert.certs.length?`<table><thead><tr><th>Concepto</th><th style="text-align:right">Importe</th><th>Estado</th><th></th></tr></thead><tbody>${cert.certs.map(c=>`<tr>
              <td><strong>${ce(c.concepto)}</strong>${c.pct?` <span style="color:var(--text3);font-size:11px">(${c.pct}%)</span>`:''}</td>
              <td style="text-align:right">${eur(c.importe)}</td>
              <td>${c.estado==='cobrado'?`<span style="color:var(--green)">✅ Cobrado${c.cobradoAt?' · '+new Date(c.cobradoAt).toLocaleDateString('es-ES'):''}</span>${c.cobradoRef?`<div style="font-size:10px;color:var(--text3)">🏦 ${ce(String(c.cobradoRef.concepto||'').slice(0,32))}${c.cobradoRef.fecha?' · '+c.cobradoRef.fecha:''}</div>`:'<div style="font-size:10px;color:var(--amber)">sin conciliar con el banco</div>'}`:'<span style="color:var(--amber)">⏳ Pendiente</span>'}</td>
              <td style="text-align:right;white-space:nowrap"><button class="btn bgh" style="padding:3px 8px;font-size:11px" title="Recibo para el cliente" onclick="CP.Obras.reciboCert('${c.id}')">📄</button> ${c.estado==='cobrado'?`<button class="btn bgh" style="padding:3px 8px;font-size:11px" title="Marcar pendiente" onclick="CP.Obras.certEstado('${obra._id}','${c.id}','pendiente')">↺</button>`:`<button class="btn bgh" style="padding:3px 9px;font-size:11px;color:var(--green);border-color:var(--green)" onclick="CP.Obras.conciliarCert('${obra._id}','${c.id}',${c.importe})">Cobrado ✓</button>`} <button class="btn bgh" style="padding:3px 8px;font-size:11px;color:var(--red)" onclick="CP.Obras.delCert('${obra._id}','${c.id}')">✕</button></td></tr>`).join('')}</tbody></table>`:'<div style="font-size:12px;color:var(--text3);margin-bottom:8px">Sin certificaciones todavía. Cobra la obra por partes (ej. 40% al empezar).</div>'}
            <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;align-items:center">
              <input type="text" id="ob-cert-concepto" class="field-input" placeholder="Concepto (ej: 40% inicio)" style="flex:1;min-width:130px">
              <input type="number" id="ob-cert-pct" class="field-input" placeholder="%" style="width:60px" min="0" max="100">
              <span style="color:var(--text3);font-size:12px">o</span>
              <input type="number" id="ob-cert-importe" class="field-input" placeholder="€" style="width:88px" min="0">
              <button class="btn bp" onclick="CP.Obras.addCert('${obra._id}')">+ Certificar</button>
            </div>
            <div style="margin-top:7px;display:flex;gap:6px;flex-wrap:wrap">
              <button class="btn bgh" style="padding:4px 10px;font-size:11px" onclick="CP.Obras.certRapida('${obra._id}','40% inicio',40,0)">40% inicio</button>
              <button class="btn bgh" style="padding:4px 10px;font-size:11px" onclick="CP.Obras.certRapida('${obra._id}','30% avance',30,0)">30% avance</button>
              ${cert.sinCertificar>0?`<button class="btn bgh" style="padding:4px 10px;font-size:11px" onclick="CP.Obras.certRapida('${obra._id}','Resto (fin de obra)',0,${cert.sinCertificar})">Resto · ${eur(cert.sinCertificar)}</button>`:''}
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
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn bp" onclick="CP.Obras.saveObraChanges('${id}')">💾 Guardar</button>
              <button class="btn bgh" onclick="document.getElementById('ob-modal').remove()">Cerrar</button>
              <button class="btn bgh" style="color:var(--red);border-color:var(--red)" onclick="CP.Obras.eliminarObra('${id}','${String(obra.reference||'').replace(/'/g,'')}')">🗑️ Eliminar obra</button>
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
  async function addCert(id) {
    const concepto = document.getElementById('ob-cert-concepto')?.value?.trim();
    const pct = parseFloat(document.getElementById('ob-cert-pct')?.value || 0);
    const importe = parseFloat(document.getElementById('ob-cert-importe')?.value || 0);
    if (!(pct > 0) && !(importe > 0)) { alert('Indica un % (sobre el presupuesto) o un importe.'); return; }
    try { await api(`/api/obras/${id}/certificacion`, { method:'POST', body: JSON.stringify({ concepto, pct, importe }) }); openObra(id); loadResumen(); }
    catch (err) { alert('Error: ' + err.message); }
  }
  async function certRapida(id, concepto, pct, importe) {
    try { await api(`/api/obras/${id}/certificacion`, { method:'POST', body: JSON.stringify({ concepto, pct: pct || 0, importe: importe || 0 }) }); openObra(id); loadResumen(); }
    catch (err) { alert('Error: ' + err.message); }
  }
  async function certEstado(id, certId, estado, cobradoRef) {
    try { await api(`/api/obras/${id}/certificacion/${certId}`, { method:'PUT', body: JSON.stringify({ estado, cobradoRef }) }); openObra(id); loadResumen(); }
    catch (err) { alert('Error: ' + err.message); }
  }
  // Conciliación: al marcar cobrada una certificación, elige el movimiento del banco que la casa.
  async function conciliarCert(obraId, certId, importe) {
    _ccObra = obraId; _ccCert = certId; _ccData = [];
    document.getElementById('cc-picker')?.remove();
    const modal = document.createElement('div');
    modal.id = 'cc-picker'; modal.className = 'modal-overlay'; modal.style.zIndex = '10002';
    modal.innerHTML = `<div class="modal-box" style="max-width:520px">
      <div class="modal-header"><div style="font-size:15px;font-weight:700">Conciliar cobro · ${eur(importe)}</div><button class="btn bgh" onclick="document.getElementById('cc-picker').remove()">✕</button></div>
      <div style="font-size:12px;color:var(--text3);margin-bottom:8px">Elige el ingreso del banco que corresponde a este cobro. Los que cuadran con el importe salen primero y en verde.</div>
      <div id="cc-list"><div style="color:var(--text3);font-size:12px;padding:12px">Cargando ingresos del banco…</div></div>
      <div style="margin-top:10px;text-align:right"><button class="btn bgh" onclick="CP.Obras.certEstado('${obraId}','${certId}','cobrado');document.getElementById('cc-picker').remove()">Marcar cobrado sin conciliar</button></div>
    </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    try {
      const d = await api('/api/banco/entradas?importe=' + encodeURIComponent(importe));
      _ccData = d.entradas || [];
      const box = document.getElementById('cc-list');
      if (!box) return;
      if (!_ccData.length) { box.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:12px">No hay ingresos en el banco. Sube el Excel del banco (pestaña Banco) o marca cobrado sin conciliar.</div>'; return; }
      box.innerHTML = `<div style="max-height:52vh;overflow:auto">${_ccData.slice(0,80).map((m,i)=>`
        <div onclick="CP.Obras._ccPick(${i})" style="display:flex;justify-content:space-between;gap:10px;padding:10px 8px;border-bottom:1px solid var(--border);cursor:pointer;${m.match?'background:color-mix(in srgb,var(--green) 14%,transparent)':''}">
          <div style="min-width:0"><div style="font-size:13px">${ceMod(String(m.concepto||'').slice(0,50))}</div><div style="font-size:11px;color:var(--text3)">${m.fecha?String(m.fecha).slice(0,10):''}${m.match?' · ✅ cuadra':''}</div></div>
          <div style="font-weight:700;white-space:nowrap">${eur(m.importe)}</div></div>`).join('')}</div>`;
    } catch (e) { const box = document.getElementById('cc-list'); if (box) box.innerHTML = '<div style="color:var(--red);font-size:12px;padding:12px">' + e.message + '</div>'; }
  }
  async function _ccPick(i) {
    const m = _ccData[i]; if (!m) return;
    document.getElementById('cc-picker')?.remove();
    await certEstado(_ccObra, _ccCert, 'cobrado', { huella: m.huella, fecha: m.fecha ? String(m.fecha).slice(0,10) : '', concepto: m.concepto, importe: m.importe });
  }
  async function delCert(id, certId) {
    if (!confirm('¿Quitar esta certificación?')) return;
    try { await api(`/api/obras/${id}/certificacion/${certId}`, { method:'DELETE' }); openObra(id); loadResumen(); }
    catch (err) { alert('Error: ' + err.message); }
  }
  async function getEmpresaCached(){ if(_empresaCache) return _empresaCache; try{ _empresaCache = await api('/api/empresa'); }catch(e){ _empresaCache = {}; } return _empresaCache; }
  // Recibo/certificación imprimible para enviar al cliente.
  async function reciboCert(certId){
    if(!_obraData){ alert('Abre la obra primero'); return; }
    const certs = _obraData.certs || [];
    const idx = certs.findIndex(x=>x.id===certId);
    const c = certs[idx]; if(!c){ return; }
    const e = await getEmpresaCached(); const o = _obraData.obra || {};
    const esc = s => String(s==null?'':s).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const eur2 = n => (Number(n)||0).toLocaleString('es-ES',{minimumFractionDigits:2,maximumFractionDigits:2})+' €';
    const fch = x => { try{ return new Date(x||Date.now()).toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'}); }catch(_){ return ''; } };
    // Trazabilidad: nº del presupuesto de origen y nº de recibo correlativo por obra
    const presuNum = o.presupuestoNumero || (o.aliases||[]).find(a=>/^PRES-/i.test(a)) || '';
    const recNum = (presuNum ? presuNum : (o.reference||'REC')) + '/C' + (idx>=0?idx+1:1);
    const cobrado = c.estado === 'cobrado';
    const cobradoLine = cobrado ? `<div class="m" style="color:#16a34a">✔ Cobrado el ${fch(c.cobradoAt||c.fecha)}</div>` : '';
    const empSub=[e.cif?('CIF '+e.cif):'',e.direccion,e.telefono?('Tel '+e.telefono):'',e.email].filter(Boolean).join(' · ');
    const pago = e.iban ? `<div class="box"><div class="h">Datos para el pago (transferencia)</div>
      <div class="r"><span>Titular</span><b>${esc(e.titular||e.nombre||'')}</b></div>
      <div class="r"><span>IBAN</span><b>${esc(e.iban)}</b></div>
      <div class="r"><span>Concepto</span><b>${esc(o.reference||'')} · ${esc(c.concepto||'')}</b></div></div>` : '';
    const html=`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Recibo · ${esc(o.reference||'')}</title><style>
*{box-sizing:border-box}html,body{background:#fff}body{font-family:-apple-system,Arial,sans-serif;color:#1a1a1a;margin:0;padding:34px;font-size:14px;line-height:1.55}
.top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1a1a1a;padding-bottom:14px;margin-bottom:20px}
.emp b{font-size:18px}.emp .s{color:#555;font-size:11px;margin-top:3px;max-width:340px}
.doc{text-align:right}.doc .n{font-size:16px;font-weight:800}.doc .m{color:#555;font-size:12px}
.parts{display:flex;gap:22px;margin-bottom:18px;flex-wrap:wrap}.part{flex:1;min-width:200px}
.h{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#888;margin-bottom:4px}
.imp{margin:10px 0 18px;padding:16px;background:#f5f7fa;border-radius:10px;display:flex;justify-content:space-between;align-items:center}
.imp .c{font-weight:700;font-size:15px}.imp .v{font-size:24px;font-weight:800}
.box{border:1px solid #ddd;border-radius:10px;padding:14px;margin-top:6px}
.box .r{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid #f0f0f0}.box .r:last-child{border-bottom:none}
@media print{body{padding:0}.noprint{display:none}}
.bar{background:#4d9cf8;color:#fff;padding:8px 12px;border-radius:6px;border:none;font-size:13px;cursor:pointer;font-family:inherit}
</style></head><body>
<div class="noprint" style="display:flex;justify-content:space-between;margin-bottom:12px"><button class="bar" onclick="window.close()">✕ Cerrar</button><button class="bar" onclick="window.print()">🖨️ Imprimir / Guardar PDF</button></div>
<div class="top"><div class="emp"><b>${esc(e.nombre||'')}</b>${empSub?`<div class="s">${esc(empSub)}</div>`:''}</div>
  <div class="doc"><div class="n">RECIBO / CERTIFICACIÓN</div><div class="m">Nº ${esc(recNum)}</div><div class="m">Fecha: ${fch(c.fecha)}</div>${cobradoLine}</div></div>
<div class="parts">
  <div class="part"><div class="h">Cliente</div><b>${esc(o.clientName||'—')}</b></div>
  <div class="part"><div class="h">Obra</div><b>${esc(o.reference||'—')}</b>${o.address?`<div style="color:#555">${esc(o.address)}</div>`:''}${presuNum?`<div style="color:#555;font-size:12px;margin-top:2px">Presupuesto: ${esc(presuNum)}</div>`:''}</div>
</div>
<div class="imp"><div class="c">${esc(c.concepto||'Certificación')}${c.pct?` (${c.pct}% del presupuesto)`:''}</div><div class="v">${eur2(c.importe)}</div></div>
${pago}
<div style="margin-top:20px;font-size:12px;color:#777">Este documento certifica la cantidad indicada correspondiente a la obra referenciada.</div>
</body></html>`;
    const w=window.open('','_blank'); if(!w){ alert('Permite las ventanas emergentes'); return; }
    w.document.open(); w.document.write(html); w.document.close();
  }
  async function delMaterial(id, matId) {
    if (!confirm('¿Borrar este material?')) return;
    try { await api(`/api/obras/${id}/material/${matId}`, { method:'DELETE' }); openObra(id); loadResumen(); }
    catch (err) { alert('Error: ' + err.message); }
  }

  // Picker: asignar a la obra una factura de proveedor ya subida (sin clasificar).
  let _fpData = [], _fpObra = {}, _fpDetalle = null, _obraData = null, _empresaCache = null;
  let _ccObra = null, _ccCert = null, _ccData = [];
  async function abrirPickerFacturas(obraId, obraRef) {
    document.getElementById('fac-picker')?.remove();
    _fpObra = { id: obraId, ref: obraRef };
    const modal = document.createElement('div');
    modal.id = 'fac-picker'; modal.className = 'modal-overlay'; modal.style.zIndex = '10001'; // por encima de la ficha de obra (9999)
    modal.innerHTML = `<div class="modal-box" style="max-width:560px">
      <div class="modal-header"><div style="font-size:15px;font-weight:700">Añadir factura a la obra</div>
        <button class="btn bgh" onclick="document.getElementById('fac-picker').remove()">✕</button></div>
      <input type="text" id="fp-search" class="field-input" placeholder="Buscar proveedor…" oninput="CP.Obras._fpFilter()" style="margin-bottom:10px">
      <div id="fp-list" style="max-height:60vh;overflow-y:auto"><div style="color:var(--text3);font-size:12px;padding:12px">Cargando facturas sin clasificar…</div></div>
    </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    try {
      const data = await api('/api/facturas/proveedor?filtro=sin');
      _fpData = data.facturas || [];
      _fpRender(_fpData);
    } catch (err) {
      const b = document.getElementById('fp-list'); if (b) b.innerHTML = '<div style="color:var(--red);font-size:12px;padding:12px">Error: ' + err.message + '</div>';
    }
  }
  function _fpRender(list) {
    const box = document.getElementById('fp-list'); if (!box) return;
    if (!list.length) { box.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:12px">No hay facturas sin clasificar.</div>'; return; }
    box.innerHTML = list.slice(0, 150).map(f => `<div onclick="CP.Obras._fpPick('${f.id}')" style="display:flex;justify-content:space-between;gap:10px;padding:11px 8px;border-bottom:1px solid var(--border);cursor:pointer">
        <div style="min-width:0"><strong style="font-size:13px">${String(f.supplier || '—').replace(/</g, '&lt;')}</strong><div style="font-size:11px;color:var(--text3)">${String(f.number || '')}${f.date ? ' · ' + String(f.date).slice(0, 10) : ''}</div></div>
        <div style="font-weight:700;white-space:nowrap">${eur(f.total)}</div></div>`).join('') +
      (list.length > 150 ? `<div style="font-size:11px;color:var(--text3);padding:8px">Mostrando 150 de ${list.length}. Afina con el buscador.</div>` : '');
  }
  function _fpFilter() {
    const q = (document.getElementById('fp-search').value || '').toLowerCase();
    _fpRender(_fpData.filter(f => [f.supplier, f.number].some(x => String(x || '').toLowerCase().includes(q))));
  }
  // Al elegir una factura: mostramos sus LÍNEAS con checkboxes para asignar
  // toda la factura o solo las líneas que van a esta obra.
  async function _fpPick(fId) {
    const f = _fpData.find(x => String(x.id) === String(fId));
    const box = document.getElementById('fp-list'); if (!box) return;
    box.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:12px">Cargando líneas de la factura…</div>';
    let det = null;
    try { det = await api('/api/facturas/proveedor/' + fId + '/detalle'); } catch (e) {}
    const lineas = (det && det.lineas) || [];
    const usables = lineas.filter(l => l.importe != null);
    _fpDetalle = { id: fId, total: (f ? Number(f.total) || 0 : (det ? det.total : 0)), supplier: (f && f.supplier) || (det && det.supplier) || '', number: (f && f.number) || (det && det.number) || '' };
    if (!usables.length) { _fpPickManual(fId); return; } // sin líneas con importe → importe a mano
    box.innerHTML = `
      <button class="btn bgh" style="padding:4px 10px;font-size:12px;margin-bottom:8px" onclick="CP.Obras._fpBack()">← Volver a facturas</button>
      <div style="font-size:12px;color:var(--text3);margin-bottom:8px">${String(_fpDetalle.supplier).replace(/</g,'&lt;')} · ${String(_fpDetalle.number).replace(/</g,'&lt;')} · total <b>${eur(_fpDetalle.total)}</b></div>
      <label style="display:flex;gap:9px;align-items:center;font-weight:600;font-size:13px;padding:9px;background:var(--bg3);border-radius:8px;cursor:pointer;margin-bottom:8px">
        <input type="checkbox" id="fp-all" onchange="CP.Obras._fpToggleAll()"> Seleccionar TODA la factura
      </label>
      <div style="max-height:42vh;overflow:auto">${lineas.map(l => `
        <label style="display:flex;gap:10px;align-items:flex-start;padding:9px 8px;border-bottom:1px solid var(--border);cursor:${l.importe!=null?'pointer':'default'};opacity:${l.importe!=null?'1':'.5'}">
          <input type="checkbox" class="fp-lin" data-imp="${l.importe||0}" ${l.importe==null?'disabled':''} onchange="CP.Obras._fpSum()" style="margin-top:3px;flex-shrink:0">
          <div style="flex:1;min-width:0"><div style="font-size:13px">${String(l.concepto).replace(/</g,'&lt;')}</div>
            <div style="font-size:11px;color:var(--text3)">${l.units?fmtUnits(l.units)+' ud · ':''}${l.importe!=null?eur(l.importe):'importe no disponible'}</div></div>
        </label>`).join('')}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;padding-top:10px;border-top:1px solid var(--border2)">
        <div style="font-size:13px">Seleccionado: <b id="fp-sel-total" style="color:var(--green)">${eur(0)}</b></div>
        <button class="btn bp" id="fp-asignar" onclick="CP.Obras._fpAsignar()" disabled style="opacity:.5">Asignar a la obra</button>
      </div>`;
  }
  function fmtUnits(u){ const n=Number(u)||0; return n%1===0?String(n):n.toFixed(2); }
  function _fpBack() { _fpRender(_fpData); }
  function _fpToggleAll() {
    const on = document.getElementById('fp-all').checked;
    document.querySelectorAll('.fp-lin:not(:disabled)').forEach(c => { c.checked = on; });
    _fpSum();
  }
  function _fpSum() {
    let s = 0; document.querySelectorAll('.fp-lin:checked').forEach(c => { s += Number(c.getAttribute('data-imp')) || 0; });
    s = Math.round(s * 100) / 100;
    const el = document.getElementById('fp-sel-total'); if (el) el.textContent = eur(s);
    const b = document.getElementById('fp-asignar'); if (b) { b.disabled = !(s > 0); b.style.opacity = s > 0 ? '1' : '.5'; }
    return s;
  }
  async function _fpAsignar() {
    const importe = _fpSum();
    if (!(importe > 0)) { alert('Selecciona al menos una línea'); return; }
    try {
      await api('/api/facturas/proveedor/' + _fpDetalle.id + '/repartir', { method: 'POST', body: JSON.stringify({ obraId: _fpObra.id, obraRef: _fpObra.ref, importe }) });
      document.getElementById('fac-picker')?.remove();
      openObra(_fpObra.id);
    } catch (err) { alert('No se pudo asignar: ' + err.message); }
  }
  async function _fpPickManual(fId) {
    const f = _fpData.find(x => String(x.id) === String(fId));
    const total = f ? Number(f.total) || 0 : 0;
    const val = prompt('Esta factura no trae líneas con importe. ¿Cuánto va a ESTA obra?', total);
    if (val === null) { _fpRender(_fpData); return; }
    const importe = parseFloat(String(val).replace(',', '.').replace(/[^0-9.]/g, ''));
    if (!(importe > 0)) { alert('Importe no válido'); return; }
    try {
      await api('/api/facturas/proveedor/' + fId + '/repartir', { method: 'POST', body: JSON.stringify({ obraId: _fpObra.id, obraRef: _fpObra.ref, importe }) });
      document.getElementById('fac-picker')?.remove();
      openObra(_fpObra.id);
    } catch (err) { alert('No se pudo asignar: ' + err.message); }
  }
  async function quitarReparto(facturaId, obraId) {
    if (!confirm('¿Quitar esta factura de la obra? (el resto del reparto no se toca)')) return;
    try {
      await api('/api/facturas/proveedor/' + facturaId + '/quitar-reparto', { method: 'POST', body: JSON.stringify({ obraId }) });
      openObra(obraId);
    } catch (err) { alert('No se pudo quitar: ' + err.message); }
  }

  async function quitarFactura(facturaId, obraId) {
    if (!confirm('¿Quitar esta factura de la obra?\n\nVolverá a "sin clasificar" en Herramientas → Clasificar facturas.')) return;
    try {
      await api('/api/facturas/proveedor/' + facturaId, { method: 'DELETE' });
      openObra(obraId); // recargar la ficha con la rentabilidad recalculada
    } catch (err) { alert('No se pudo quitar: ' + err.message); }
  }

  async function eliminarObra(id, ref) {
    if (!confirm('¿Eliminar la obra "' + (ref || '') + '"?\n\nNo borra partes, presencia ni facturas — solo quita la obra (útil para eliminar duplicadas).')) return;
    try {
      await api('/api/obras/' + id, { method: 'DELETE' });
      document.getElementById('ob-modal')?.remove();
      loadResumen();
    } catch (err) { alert('No se pudo borrar: ' + err.message); }
  }

  CP.Obras = { render, showTab, loadResumen, loadLista, openObra, saveObraChanges, submitObra, resetForm, sugerirRef, addMaterial, delMaterial, addCert, certRapida, certEstado, conciliarCert, _ccPick, delCert, reciboCert, eliminarObra, quitarFactura, quitarReparto, abrirPickerFacturas, _fpFilter, _fpPick, _fpBack, _fpToggleAll, _fpSum, _fpAsignar };

})(window.CP = window.CP || {});
