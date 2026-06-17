// public/modules/activity-admin.js — Pestaña "Actividad": log de cambios en StelOrder.
(function(){
  const API = window.location.origin;
  const tok = () => localStorage.getItem('cp_token');
  const esc = s => String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  let _cid=null, _items=[], _filtro='';

  async function api(path, opts={}){
    const r = await fetch(`${API}${path}`,{...opts,headers:{'Authorization':`Bearer ${tok()}`,'Content-Type':'application/json',...(opts.headers||{})}});
    if(!r.ok) throw new Error('HTTP '+r.status);
    return r.json();
  }

  const ICON = { creado:'🟢', modificado:'🔵', borrado:'🔴' };
  const KIND = { creado:'Creado', modificado:'Modificado', borrado:'Borrado' };

  function fecha(at){
    try{ return new Date(at).toLocaleString('es-ES',{timeZone:'Europe/Madrid',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}); }
    catch(e){ return ''; }
  }

  async function render(containerId){
    _cid = containerId || _cid;
    await _load();
  }

  async function _load(){
    try{ const r = await api('/api/activity?limit=300'); _items = (r&&r.items)||[]; }
    catch(e){ _items=[]; }
    _draw();
  }

  function _draw(){
    const el = document.getElementById(_cid); if(!el) return;
    const lista = _filtro ? _items.filter(i=>i.kind===_filtro) : _items;

    const filas = lista.map(it=>{
      const cambios = (it.changes||[]).map(c=>{
        const flecha = (c.antes && c.antes!=='—') ? `${esc(c.antes)} → ${esc(c.despues)}` : esc(c.despues);
        return `<div style="font-size:12px;color:var(--text2)"><span style="color:var(--text3)">${esc(c.campo)}:</span> ${flecha}</div>`;
      }).join('');
      return `<div style="display:flex;gap:10px;padding:10px 12px;border-bottom:1px solid var(--border2)">
        <div style="font-size:15px">${ICON[it.kind]||'•'}</div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
            <strong style="font-size:13px">${esc(it.label||'')} ${esc(it.ref||'')}</strong>
            <span style="font-size:11px;color:var(--text3)">${KIND[it.kind]||it.kind} · ${fecha(it.at)}</span>
          </div>
          ${cambios}
        </div>
      </div>`;
    }).join('') || '<div style="text-align:center;padding:40px;color:var(--text3)">Sin actividad registrada todavía. En cuanto se mueva algo en StelOrder, aparecerá aquí.</div>';

    const btnFiltro = (val,txt)=>`<button class="btn ${_filtro===val?'bp':'bgh'}" style="padding:5px 10px;font-size:12px" onclick="CP.Actividad.filtrar('${val}')">${txt}</button>`;

    el.innerHTML = `
      <div class="alert ain" style="margin-bottom:16px"><div>📜</div><div><strong>Actividad de StelOrder</strong> — registro de lo que se crea, cambia o cierra en la oficina. Se actualiza cada 15 min; pulsa "Escanear ahora" para verlo al momento.</div></div>
      <div class="card">
        <div class="card-title">
          Últimos cambios
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
            ${btnFiltro('','Todos')}${btnFiltro('creado','🟢 Creados')}${btnFiltro('modificado','🔵 Modificados')}${btnFiltro('borrado','🔴 Borrados')}
            <button class="btn bp" style="padding:6px 12px;font-size:12px" onclick="CP.Actividad.escanear(this)">🔄 Escanear ahora</button>
            <button class="btn bgh" style="padding:6px 12px;font-size:12px" onclick="CP.Actividad.reiniciar(this)">🗑 Reiniciar</button>
          </div>
        </div>
        <div>${filas}</div>
      </div>`;
  }

  const Actividad = {
    render,
    filtrar(v){ _filtro=v; _draw(); },
    async escanear(btn){
      const old = btn ? btn.textContent : '';
      if(btn){ btn.disabled=true; btn.textContent='Escaneando…'; }
      try{
        const r = await api('/api/activity/scan',{method:'POST'});
        await _load();
        const baseline = r && r.types && Object.values(r.types).some(t=>t && t.baseline);
        if(baseline){ alert('Primera foto tomada de los datos nuevos. A partir de ahora se registrarán sus cambios.'); }
      }catch(e){ alert('No se pudo escanear: '+e.message); }
      finally{ if(btn){ btn.disabled=false; btn.textContent=old||'🔄 Escanear ahora'; } }
    },
    async reiniciar(btn){
      if(!confirm('Esto borra el registro actual y vuelve a tomar la foto inicial limpia (no registra lo antiguo). ¿Continuar?')) return;
      const old = btn ? btn.textContent : '';
      if(btn){ btn.disabled=true; btn.textContent='Reiniciando…'; }
      try{
        await api('/api/activity/reset',{method:'POST'});
        await api('/api/activity/scan',{method:'POST'});  // foto inicial limpia
        await _load();
        alert('Registro reiniciado y foto inicial tomada. A partir de ahora solo se registran los cambios nuevos.');
      }catch(e){ alert('No se pudo reiniciar: '+e.message); }
      finally{ if(btn){ btn.disabled=false; btn.textContent=old||'🗑 Reiniciar'; } }
    }
  };

  window.CP = window.CP || {};
  window.CP.Actividad = Actividad;
})();
