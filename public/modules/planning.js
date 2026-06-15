// public/modules/planning.js — Calendario de planificación (lo previsto).
(function(){
  const API = window.location.origin;
  const tok = () => localStorage.getItem('cp_token');
  const esc = s => String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  let _cid=null, _workers=[], _items=[], _ref=new Date();

  async function api(path, opts={}){
    const r = await fetch(`${API}${path}`,{...opts,headers:{'Authorization':`Bearer ${tok()}`,'Content-Type':'application/json',...(opts.headers||{})}});
    if(!r.ok && r.status!==400) throw new Error('HTTP '+r.status);
    return r.json();
  }

  const MESES=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const DIAS=['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];
  const ymd = d => d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');

  async function render(containerId){
    _cid=containerId;
    if(!_workers.length){
      try{ _workers = await api('/api/partes/workers'); }catch(e){ _workers=[]; }
    }
    await _load();
  }

  async function _load(){
    const y=_ref.getFullYear(), m=_ref.getMonth();
    const from=`${y}-${String(m+1).padStart(2,'0')}-01`;
    const to=`${y}-${String(m+1).padStart(2,'0')}-${String(new Date(y,m+1,0).getDate()).padStart(2,'0')}`;
    try{ const r=await api(`/api/planning?from=${from}&to=${to}`); _items=(r&&r.items)||[]; }
    catch(e){ _items=[]; }
    _draw();
  }

  function _draw(){
    const el=document.getElementById(_cid); if(!el) return;
    const y=_ref.getFullYear(), m=_ref.getMonth();
    const primero=new Date(y,m,1);
    let offset=(primero.getDay()+6)%7; // lunes=0
    const diasMes=new Date(y,m+1,0).getDate();

    // agrupar items por fecha
    const porDia={};
    _items.forEach(it=>{ (porDia[it.date]=porDia[it.date]||[]).push(it); });

    // leyenda de colores por trabajador
    const leyenda=_workers.map(w=>`<span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;margin-right:12px">
      <span style="width:10px;height:10px;border-radius:3px;background:${w.color};display:inline-block"></span>${esc(w.name.split(' ')[0])}</span>`).join('');

    let celdas='';
    for(let i=0;i<offset;i++) celdas+=`<div style="background:var(--bg2);border-radius:8px;min-height:96px;opacity:.4"></div>`;
    for(let d=1;d<=diasMes;d++){
      const fecha=`${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const hoy=fecha===ymd(new Date());
      const items=porDia[fecha]||[];
      const chips=items.map(it=>`
        <div onclick="event.stopPropagation();CP.Planning.editar('${it._id}')"
          style="background:${it.color}22;border-left:3px solid ${it.color};border-radius:4px;padding:2px 5px;margin-bottom:3px;cursor:pointer;font-size:11px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${it.tipo==='visita'?'👤':'🔧'} <strong>${esc((it.workerName||'').split(' ')[0])}</strong>${it.client?' · '+esc(it.client):''}${it.workOrderNumber?' <span style="opacity:.7">'+esc(it.workOrderNumber)+'</span>':''}
        </div>`).join('');
      celdas+=`<div onclick="CP.Planning.nuevo('${fecha}')"
        style="background:var(--bg3);border:1px solid ${hoy?'var(--blue)':'var(--border2)'};border-radius:8px;min-height:96px;padding:6px;cursor:pointer;transition:.15s"
        onmouseover="this.style.borderColor='var(--blue)'" onmouseout="this.style.borderColor='${hoy?'var(--blue)':'var(--border2)'}'">
        <div style="font-size:12px;font-weight:${hoy?'800':'600'};color:${hoy?'var(--blue)':'var(--text3)'};margin-bottom:4px">${d}</div>
        ${chips}
      </div>`;
    }

    el.innerHTML=`
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn bgh" style="padding:6px 12px" onclick="CP.Planning.mover(-1)">‹</button>
          <h2 style="font-size:19px;font-weight:700;margin:0">${MESES[m]} ${y}</h2>
          <button class="btn bgh" style="padding:6px 12px" onclick="CP.Planning.mover(1)">›</button>
          <button class="btn bgh" style="padding:6px 12px;font-size:12px" onclick="CP.Planning.hoy()">Hoy</button>
        </div>
        <button class="btn bp" style="padding:8px 16px" onclick="CP.Planning.nuevo('${ymd(new Date())}')">+ Planificar</button>
      </div>
      <div style="margin-bottom:12px">${leyenda}</div>
      <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px;margin-bottom:6px">
        ${DIAS.map(d=>`<div style="font-size:11px;font-weight:700;color:var(--text3);text-align:center;text-transform:uppercase">${d}</div>`).join('')}
      </div>
      <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px">${celdas}</div>
      <div id="plan-modal"></div>`;
  }

  function _modal(item, fecha){
    const esEdit=!!item;
    const it=item||{date:fecha,tipo:'trabajo',color:'#4d9cf8'};
    const opts=_workers.map(w=>`<option value="${w.id}" data-color="${w.color}" ${it.workerId===w.id?'selected':''}>${esc(w.name)}</option>`).join('');
    document.getElementById('plan-modal').innerHTML=`
      <div onclick="if(event.target===this)CP.Planning.cerrar()" style="position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:1000;padding:20px">
        <div style="background:var(--bg);border-radius:14px;padding:22px;width:100%;max-width:440px;max-height:90vh;overflow-y:auto">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
            <h3 style="margin:0;font-size:17px">${esEdit?'Editar':'Nueva'} planificación</h3>
            <button onclick="CP.Planning.cerrar()" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--text3)">✕</button>
          </div>
          <div style="display:flex;flex-direction:column;gap:12px">
            <div>
              <label style="font-size:11px;color:var(--text3);text-transform:uppercase;font-weight:600">Tipo</label>
              <div style="display:flex;gap:8px;margin-top:5px">
                <button id="pl-t-trabajo" class="btn ${it.tipo!=='visita'?'bp':'bgh'}" style="flex:1;padding:8px" onclick="CP.Planning.setTipo('trabajo')">🔧 Trabajo</button>
                <button id="pl-t-visita" class="btn ${it.tipo==='visita'?'bp':'bgh'}" style="flex:1;padding:8px" onclick="CP.Planning.setTipo('visita')">👤 Visita</button>
              </div>
            </div>
            <div><label style="font-size:11px;color:var(--text3);text-transform:uppercase;font-weight:600">Fecha</label>
              <input id="pl-date" type="date" value="${it.date}" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:9px;color:var(--text);margin-top:5px"></div>
            <div><label style="font-size:11px;color:var(--text3);text-transform:uppercase;font-weight:600">Operario</label>
              <select id="pl-worker" onchange="CP.Planning.syncColor()" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:9px;color:var(--text);margin-top:5px">
                <option value="">— Sin asignar —</option>${opts}
              </select></div>
            <div><label style="font-size:11px;color:var(--text3);text-transform:uppercase;font-weight:600">Cliente / Obra</label>
              <input id="pl-client" type="text" value="${esc(it.client||'')}" placeholder="Ej: Joan Maragall 44-46" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:9px;color:var(--text);margin-top:5px"></div>
            <div><label style="font-size:11px;color:var(--text3);text-transform:uppercase;font-weight:600">Nº pedido (opcional)</label>
              <input id="pl-wo" type="text" value="${esc(it.workOrderNumber||'')}" placeholder="Ej: PDT00467" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:9px;color:var(--text);margin-top:5px"></div>
            <div style="display:flex;gap:10px">
              <div style="flex:1"><label style="font-size:11px;color:var(--text3);text-transform:uppercase;font-weight:600">Hora</label>
                <input id="pl-hora" type="time" value="${esc(it.horaInicio||'')}" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:9px;color:var(--text);margin-top:5px"></div>
            </div>
            <div><label style="font-size:11px;color:var(--text3);text-transform:uppercase;font-weight:600">Nota</label>
              <input id="pl-nota" type="text" value="${esc(it.nota||'')}" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:9px;color:var(--text);margin-top:5px"></div>
            <div style="display:flex;gap:10px;margin-top:6px">
              ${esEdit?`<button class="btn bgh" style="color:var(--red);border-color:var(--red);padding:10px 14px" onclick="CP.Planning.borrar('${it._id}')">🗑 Borrar</button>`:''}
              <button class="btn bp" style="flex:1;padding:10px" onclick="CP.Planning.guardar('${esEdit?it._id:''}')">${esEdit?'Guardar':'Crear'}</button>
            </div>
          </div>
        </div>
      </div>`;
    window._planTipo=it.tipo||'trabajo';
  }

  const Planning={
    render,
    mover(n){ _ref=new Date(_ref.getFullYear(),_ref.getMonth()+n,1); _load(); },
    hoy(){ _ref=new Date(); _load(); },
    nuevo(fecha){ _modal(null,fecha); },
    editar(id){ const it=_items.find(x=>String(x._id)===String(id)); if(it) _modal(it); },
    cerrar(){ const m=document.getElementById('plan-modal'); if(m) m.innerHTML=''; },
    setTipo(t){ window._planTipo=t;
      document.getElementById('pl-t-trabajo').className='btn '+(t==='trabajo'?'bp':'bgh');
      document.getElementById('pl-t-visita').className='btn '+(t==='visita'?'bp':'bgh');
    },
    syncColor(){ /* el color se toma del operario al guardar */ },
    async guardar(id){
      const sel=document.getElementById('pl-worker');
      const opt=sel.options[sel.selectedIndex];
      const body={
        date: document.getElementById('pl-date').value,
        workerId: sel.value||null,
        workerName: sel.value?opt.text:'',
        color: sel.value?(opt.getAttribute('data-color')||'#4d9cf8'):'#6b7280',
        tipo: window._planTipo||'trabajo',
        client: document.getElementById('pl-client').value.trim(),
        workOrderNumber: document.getElementById('pl-wo').value.trim(),
        horaInicio: document.getElementById('pl-hora').value,
        nota: document.getElementById('pl-nota').value.trim()
      };
      if(!body.date){ alert('Pon una fecha'); return; }
      try{
        if(id) await api('/api/planning/'+id,{method:'PUT',body:JSON.stringify(body)});
        else   await api('/api/planning',{method:'POST',body:JSON.stringify(body)});
        this.cerrar(); _load();
      }catch(e){ alert('No se pudo guardar: '+e.message); }
    },
    async borrar(id){
      if(!confirm('¿Borrar esta planificación?')) return;
      try{ await api('/api/planning/'+id,{method:'DELETE'}); this.cerrar(); _load(); }
      catch(e){ alert('No se pudo borrar: '+e.message); }
    }
  };

  window.CP=window.CP||{};
  window.CP.Planning=Planning;
})();
