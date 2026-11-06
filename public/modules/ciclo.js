// public/modules/ciclo.js — Tablero del ciclo de un trabajo, «modo restaurante» (2/11/2026).
// Una columna por paso (por asignar → sin cita → programado → por facturar → por cobrar → cobrado) y la fila de
// presupuestos. El color de cada tarjeta dice cuánto lleva parada en ese paso: verde, ámbar, rojo. Clic = el
// recorrido entero (petición, incidencia, técnico, cita, parte, factura, cobro) y lo que se puede hacer.
// Modo pantalla: a pantalla completa y se actualiza solo cada 2 minutos (lee las cachés; no gasta cupo de StelOrder).
(function (CP) {
  function api(url, opts) {
    const o = opts || {};
    o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
    const t = localStorage.getItem('cp_token');
    if (t) o.headers['Authorization'] = 'Bearer ' + t;
    return fetch(url, o).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Error'); return d; });
  }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const eur = n => (Number(n) || 0).toLocaleString('es-ES', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' €';
  const fecha = f => f ? new Date(f + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: f.slice(0, 4) === String(new Date().getFullYear()) ? undefined : '2-digit' }) : '';
  const SEM = { rojo: 'var(--red)', ambar: 'var(--amber)', verde: 'var(--green)' };
  const SEMBG = { rojo: 'var(--red-bg)', ambar: 'var(--amber-bg)', verde: 'var(--green-bg)' };

  const st = { d: null, cont: null, filtro: '', soloRojos: false, timer: null, cargadoEn: null };

  const CSS = `
  .cy-top{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
  .cy-top h2{font-family:'Space Grotesk',sans-serif;font-size:20px;margin:0;flex:1;min-width:200px}
  .cy-top select,.cy-top button{background:var(--bg2);border:1px solid var(--border2);border-radius:8px;padding:7px 11px;color:var(--text);font-size:13px;cursor:pointer}
  .cy-top button.on{border-color:var(--red);color:var(--red)}
  .cy-flujo{display:flex;gap:6px;align-items:stretch;overflow-x:auto;margin-bottom:12px;padding-bottom:2px}
  .cy-paso{flex:1;min-width:120px;background:var(--bg2);border:1px solid var(--border2);border-radius:10px;padding:8px 10px;cursor:pointer}
  .cy-paso .n{font-family:'Space Grotesk',sans-serif;font-size:24px;font-weight:700;line-height:1.1}
  .cy-paso .t{font-size:12px;color:var(--text2)}
  .cy-paso .b{font-size:11px;margin-top:2px}
  .cy-flecha{align-self:center;color:var(--text3);font-size:16px}
  .cy-board{display:grid;grid-template-columns:repeat(6,minmax(220px,1fr));gap:10px;overflow-x:auto;padding-bottom:6px}
  .cy-board.dos{grid-template-columns:repeat(2,minmax(260px,1fr))}
  .cy-board.cuatro{grid-template-columns:repeat(4,minmax(220px,1fr))}
  .cy-sug{font-size:12.5px;color:var(--text2);margin:6px 2px 0}
  .cy-q label{display:block;font-size:12px;color:var(--text2);margin:10px 0 3px}
  .cy-q input,.cy-q select{background:var(--bg2);border:1px solid var(--border2);border-radius:7px;color:var(--text);font:inherit;font-size:13px;padding:6px 8px;box-sizing:border-box}
  .cy-q .fila2{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .cy-col{background:var(--bg3);border:1px solid var(--border2);border-radius:12px;padding:8px;display:flex;flex-direction:column;min-height:120px}
  .cy-col h3{font-size:13.5px;margin:2px 4px 2px;display:flex;justify-content:space-between;gap:6px}
  .cy-col .ay{font-size:11px;color:var(--text3);margin:0 4px 8px}
  .cy-lista{display:flex;flex-direction:column;gap:7px;max-height:62vh;overflow-y:auto;padding-right:2px}
  .cy-card{border-radius:10px;padding:8px 10px 8px 12px;border-left:5px solid;cursor:pointer;background:var(--bg2);position:relative}
  .cy-card:hover{filter:brightness(1.08)}
  .cy-card .r1{display:flex;justify-content:space-between;gap:6px;font-size:11px;color:var(--text2)}
  .cy-card .dd{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:15px;line-height:1}
  .cy-card .cl{font-weight:600;font-size:13px;margin-top:3px;line-height:1.25}
  .cy-card .q{font-size:12px;color:var(--text2);margin-top:2px;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .cy-card .et{font-size:11.5px;margin-top:4px;font-weight:600}
  .cy-card .op{display:inline-block;font-size:11px;background:var(--bg4);border-radius:20px;padding:1px 8px;margin-top:4px;margin-right:4px}
  .cy-vacio{font-size:12px;color:var(--text3);text-align:center;padding:16px 4px}
  .cy-mas{font-size:12px;color:var(--text2);text-align:center;padding:6px;cursor:pointer}
  .cy-ley{display:flex;gap:12px;flex-wrap:wrap;font-size:11.5px;color:var(--text2);margin:10px 2px}
  .cy-ley i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:4px;vertical-align:-1px}
  .cy-trab{position:absolute;top:-6px;right:8px;font-size:10.5px;background:var(--blue);color:#fff;border-radius:10px;padding:1px 7px;animation:cyLat 1.6s infinite}
  @keyframes cyLat{50%{opacity:.55}}
  .cy-tv{background:var(--bg);padding:14px;overflow:auto}
  .cy-tv .cy-lista{max-height:calc(100vh - 230px)}
  .cy-tv .cy-card .cl{font-size:15px}.cy-tv .cy-card .dd{font-size:19px}
  .cy-tv .cy-card.rojo{animation:cyRojo 2.4s infinite}
  @keyframes cyRojo{50%{box-shadow:0 0 0 2px var(--red)}}
  .cy-modal{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:40px 12px;overflow:auto}
  .cy-modal .bx{background:var(--bg2);border:1px solid var(--border2);border-radius:14px;max-width:560px;width:100%;padding:18px}
  .cy-paso-l{display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--border2)}
  .cy-paso-l:last-child{border-bottom:0}
  .cy-paso-l .ic{width:24px;height:24px;border-radius:50%;flex:0 0 24px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700}
  .cy-acc{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
  .cy-acc button{border-radius:8px;padding:8px 12px;font-size:13px;cursor:pointer;border:1px solid var(--border2);background:var(--bg3);color:var(--text)}
  .cy-fl{border:1px solid var(--border2);border-radius:10px;padding:8px;margin-bottom:7px;background:var(--bg3)}
  .cy-fl input,.cy-fl textarea,.cy-fx select,.cy-fx input{background:var(--bg2);border:1px solid var(--border2);border-radius:7px;color:var(--text);font:inherit;font-size:13px;padding:6px 8px;width:100%;box-sizing:border-box}
  .cy-fl textarea{font-size:12px;color:var(--text2);resize:vertical;margin-top:5px}
  .cy-fl .nums{display:grid;grid-template-columns:1fr 1fr 1fr 28px;gap:6px;margin-top:5px;align-items:center;font-size:12px}
  .cy-fl .nums label{display:block;color:var(--text3);font-size:10.5px}
  .cy-tot{display:flex;justify-content:flex-end;gap:16px;font-size:13px;margin-top:8px;flex-wrap:wrap}
  .cy-tot b{font-size:16px}
  .cy-limp{margin-top:14px}
  .cy-limp .fila{display:flex;gap:8px;align-items:center;font-size:12.5px;padding:5px 0;border-bottom:1px solid var(--border2)}
  .cy-limp .fila span{flex:1}
  `;

  function render(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    st.cont = el;
    if (!document.getElementById('cy-css')) { const s = document.createElement('style'); s.id = 'cy-css'; s.textContent = CSS; document.head.appendChild(s); }
    el.innerHTML = `
      <div class="cy-top">
        <h2>🚦 Ciclo de trabajos</h2>
        <select id="cy-op" onchange="CP.Ciclo.filtrar(this.value)"><option value="">Todos los técnicos</option></select>
        <button id="cy-rojos" onclick="CP.Ciclo.rojos()">🔴 Solo lo urgente</button>
        <button onclick="CP.Ciclo.cargar()">🔄</button>
        <button onclick="CP.Ciclo.tv()">📺 Modo pantalla</button>
      </div>
      <div id="cy-flujo" class="cy-flujo"></div>
      <div id="cy-board" class="cy-board"><div class="cy-vacio">Cargando…</div></div>
      <h3 style="font-size:14px;margin:18px 2px 8px">🧱 Presupuestos aceptados en cola</h3>
      <div id="cy-cola" class="cy-board cuatro"><div class="cy-vacio">Cargando…</div></div>
      <div id="cy-cola-sug"></div>
      <h3 style="font-size:14px;margin:18px 2px 8px">Presupuestos</h3>
      <div id="cy-pres" class="cy-board dos"></div>
      <div class="cy-ley">
        <span><i style="background:var(--green)"></i>en plazo</span>
        <span><i style="background:var(--amber)"></i>empieza a tardar</span>
        <span><i style="background:var(--red)"></i>parado demasiado</span>
        <span id="cy-limites"></span>
        <span id="cy-act" style="margin-left:auto"></span>
      </div>
      <div id="cy-limp"></div>`;
    cargar();
  }

  async function cargar() {
    try {
      [st.d, st.cola] = await Promise.all([api('/api/ciclo'), api('/api/cola').catch(() => null)]);
      st.cargadoEn = new Date();
      opciones();
      pintar();
    } catch (e) {
      const b = document.getElementById('cy-board');
      if (b) b.innerHTML = `<div class="cy-vacio">No se ha podido cargar: ${esc(e.message)}</div>`;
    }
  }

  function opciones() {
    const sel = document.getElementById('cy-op'); if (!sel) return;
    const ops = new Set();
    st.d.columnas.forEach(c => c.tarjetas.forEach(t => { if (t.operario) ops.add(t.operario); }));
    sel.innerHTML = '<option value="">Todos los técnicos</option>' + [...ops].sort().map(o => `<option${o === st.filtro ? ' selected' : ''}>${esc(o)}</option>`).join('');
  }

  const pasa = t => (!st.filtro || t.operario === st.filtro || (t.equipo || []).includes(st.filtro)) && (!st.soloRojos || t.semaforo === 'rojo');

  function tarjeta(t) {
    const c = SEM[t.semaforo] || 'var(--text3)';
    const dias = t.col === 'programado' ? (t.dias > 0 ? `+${t.dias} d` : '') : (t.col === 'cobrado' ? '' : `${t.dias} d`);
    return `<div class="cy-card ${t.semaforo}" style="border-left-color:${c};background:linear-gradient(90deg,${SEMBG[t.semaforo]},var(--bg2) 70%)" onclick="CP.Ciclo.ver('${esc(t.id)}')">
      ${t.trabajandoAhora ? `<span class="cy-trab">🔨 ${esc(t.trabajandoAhora.quien || 'trabajando')}</span>` : ''}
      <div class="r1"><span>${t.urgente ? '🚨 ' : ''}${esc(t.ref || '')}${t.incRef && t.incRef !== t.ref ? ' · ' + esc(t.incRef) : ''}</span><span class="dd" style="color:${c}">${dias}</span></div>
      <div class="cl">${esc(t.cliente || '¿cliente?')}</div>
      ${t.que ? `<div class="q">${esc(t.que)}</div>` : ''}
      <div class="et" style="color:${c}">${esc(t.etiqueta || '')}${t.importe && t.col !== 'cobrar' ? ' · ' + eur(t.importe) : ''}</div>
      ${t.operario ? `<span class="op">👷 ${esc(t.operario)}${(t.equipo || []).length ? ' +' + t.equipo.length : ''}</span>` : ''}${t.origen && t.col === 'asignar' ? `<span class="op">${esc(t.origen)}</span>` : ''}
    </div>`;
  }

  const MAX = 40;
  function columna(c) {
    const l = c.tarjetas.filter(pasa);
    const visibles = c._todas ? l : l.slice(0, MAX);
    return `<div class="cy-col">
      <h3><span>${esc(c.titulo)}</span><span>${l.length}</span></h3>
      <div class="ay">${esc(c.ayuda)}${c.importe ? ` · <b>${eur(c.importe)}</b>` : ''}</div>
      <div class="cy-lista">${visibles.map(tarjeta).join('') || '<div class="cy-vacio">Nada aquí 👌</div>'}
      ${l.length > visibles.length ? `<div class="cy-mas" onclick="CP.Ciclo.todas('${c.k}')">Ver ${l.length - visibles.length} más</div>` : ''}</div>
    </div>`;
  }

  function pintar() {
    const d = st.d; if (!d) return;
    const f = document.getElementById('cy-flujo');
    if (f) f.innerHTML = d.columnas.map((c, i) => {
      const l = c.tarjetas.filter(pasa); const r = l.filter(t => t.semaforo === 'rojo').length, a = l.filter(t => t.semaforo === 'ambar').length;
      return `${i ? '<span class="cy-flecha">→</span>' : ''}<div class="cy-paso" title="${esc(c.ayuda)}" style="border-color:${r ? 'var(--red)' : a ? 'var(--amber)' : 'var(--border2)'}">
        <div class="t">${esc(c.titulo)}</div><div class="n" style="color:${r ? 'var(--red)' : a ? 'var(--amber)' : 'var(--text)'}">${l.length}</div>
        <div class="b">${r ? `<span style="color:var(--red)">${r} rojo${r > 1 ? 's' : ''}</span> ` : ''}${a ? `<span style="color:var(--amber)">${a} ámbar</span> ` : ''}${c.importe && c.k !== 'asignar' ? `<span style="color:var(--text2)">${eur(c.importe)}</span>` : ''}</div></div>`;
    }).join('');
    const b = document.getElementById('cy-board'); if (b) b.innerHTML = d.columnas.map(columna).join('');
    const p = document.getElementById('cy-pres'); if (p) p.innerHTML = d.presupuestos.map(columna).join('');
    const q = document.getElementById('cy-cola'); if (q) q.innerHTML = st.cola ? st.cola.columnas.map(columna).join('') : '<div class="cy-vacio">No se ha podido cargar la cola</div>';
    const qs = document.getElementById('cy-cola-sug'); if (qs) qs.innerHTML = st.cola && st.cola.sugerencias.length ? st.cola.sugerencias.map(x => `<div class="cy-sug">${esc(x)}</div>`).join('') : '';
    const L = d.limites || {};
    const li = document.getElementById('cy-limites');
    if (li) li.textContent = `Ámbar/rojo: asignar ${L.asignar}, sin cita ${L.cita}, facturar ${L.facturar}, cobrar ${L.cobrar} días`.replace(/,(\d)/g, '/$1');
    const ac = document.getElementById('cy-act'); if (ac && st.cargadoEn) ac.textContent = 'Actualizado ' + st.cargadoEn.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const lp = document.getElementById('cy-limp');
    if (lp) lp.innerHTML = (d.limpieza || []).length ? `<div class="card cy-limp"><div class="card-title" style="margin-bottom:6px">🧹 Incidencias que siguen abiertas en StelOrder y ya están facturadas (${d.limpieza.length})</div>
      ${d.limpieza.map(x => `<div class="fila" id="cy-l-${esc(x.ref)}"><span><b>${esc(x.ref)}</b> · ${esc(x.cliente)} · ${esc(x.que)} <i style="color:var(--text3)">(${esc(x.motivo)})</i></span><button class="btn bgh" style="padding:5px 10px;font-size:12px" onclick="CP.Ciclo.estado('${esc(x.ref)}','cerrada',this)">Cerrar</button></div>`).join('')}</div>` : '';
  }

  function buscar(id) {
    for (const c of [...st.d.columnas, ...st.d.presupuestos, ...(st.cola ? st.cola.columnas : [])]) { const t = c.tarjetas.find(x => x.id === id); if (t) return { t, c }; }
    return {};
  }

  function ver(id) {
    const { t, c } = buscar(id); if (!t) return;
    if (t.cola) return verCola(t, c);
    const icono = { hecho: ['✓', 'var(--green)', '#fff'], actual: ['●', SEM[t.semaforo], '#fff'], pendiente: ['', 'var(--bg4)', 'var(--text3)'] };
    const pasos = (t.pasos || []).map(p => { const [ic, bg, fg] = icono[p.estado] || icono.pendiente;
      return `<div class="cy-paso-l"><div class="ic" style="background:${bg};color:${fg}">${ic}</div><div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:13.5px">${esc(p.titulo)} ${p.fecha ? `<span style="font-weight:400;color:var(--text3);font-size:12px">· ${fecha(p.fecha)}</span>` : ''}</div>
        <div style="font-size:12.5px;color:${p.estado === 'actual' ? SEM[t.semaforo] : 'var(--text2)'}">${esc(p.detalle || '')}</div></div></div>`; }).join('');
    const acc = [];
    if (t.cerrable && t.incRef) {
      if (t.col === 'porHacer') acc.push(`<button onclick="CP.Ciclo.estado('${esc(t.incRef)}','presupuesto_hecho',this,'${esc(t.id)}')">📝 Presupuesto hecho</button>`);
      acc.push(`<button onclick="CP.Ciclo.estado('${esc(t.incRef)}','cerrada',this,'${esc(t.id)}')">✓ Cerrar ${esc(t.incRef)} (hecha o ya no va)</button>`);
      acc.push(`<button onclick="CP.Ciclo.estado('${esc(t.incRef)}','rechazada',this,'${esc(t.id)}')">✕ Rechazada</button>`);
    }
    if (t.descartable && t.peticionId) {
      acc.push(`<button onclick="CP.Ciclo.peticion('${esc(t.peticionId)}','hecho',this,'${esc(t.id)}')">✓ Ya está hecho</button>`);
      acc.push(`<button onclick="CP.Ciclo.peticion('${esc(t.peticionId)}','descartado',this,'${esc(t.id)}')">✕ Descartar</button>`);
    }
    if (t.woId && t.conTecnico && (t.col === 'cita' || t.col === 'programado')) acc.push(t.observacion
      ? `<div style="width:100%;margin:4px 0 2px"><div style="font-size:12.5px;color:var(--text2);margin-bottom:4px">Qué tiene que hacer ${esc((t.operario || 'el técnico').split(' ')[0])} (sale en su parte y le llega por WhatsApp):</div>
          <textarea id="cy-obs-nota" rows="4" style="width:100%;box-sizing:border-box;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:8px;color:var(--text);font:inherit;font-size:13px" placeholder="Ej.: abrir el falso techo del baño, ver por dónde entra el agua y repararlo. Llevar el metro de Marta.">${esc(t.notaTecnico || '')}</textarea></div>
        <button onclick="CP.Ciclo.observacion('${esc(t.woId)}',false,this,'${esc(t.id)}')" style="background:var(--blue);border-color:var(--blue);color:#fff;font-weight:700">▶ Devolver a ${esc((t.operario || 'el técnico').split(' ')[0])} con esta nota</button>`
      : `<button onclick="CP.Ciclo.observacion('${esc(t.woId)}',true,this,'${esc(t.id)}')">👁 En observación (que no le llegue al técnico)</button>`);
    if (t.col === 'cobrar') acc.push(`<button onclick="location.href='/cobrar'" style="background:var(--amber);border-color:var(--amber);color:#111;font-weight:700">💬 Recordatorio al cliente</button>`);
    if (t.col === 'facturar' && t.woId) acc.push(`<button onclick="CP.Ciclo.facturar('${esc(t.woId)}')" style="background:var(--blue);border-color:var(--blue);color:#fff;font-weight:700">🧾 Facturar</button>`);
    if (t.col === 'facturar') acc.push(`<button onclick="CP.Ciclo.ignorar('${esc(t.id)}',this)">Ya está facturado / no se factura</button>`);
    const ayuda = t.col === 'asignar' ? 'Para mandarlo a un técnico: contesta a Corpy «David» cuando te pregunte «¿Quién va?», o desde Inicio → Peticiones.'
      : t.col === 'facturar' ? '«Facturar» monta la factura con el parte (horas, material y desplazamiento); la revisas, se pasa al pedido y se crea en StelOrder enlazada a él. La tarjeta pasa sola a «Por cobrar».'
      : t.col === 'cobrar' ? 'Al pasar a ámbar (30 días) y a rojo (60) te llega un WhatsApp. El recordatorio para el cliente está preparado en /cobrar.'
      : t.col === 'cita' ? 'El técnico pone el día en su app o contesta en el grupo; tú también: «David ha quedado con … el jueves».' : '';
    const m = document.createElement('div');
    m.className = 'cy-modal'; m.id = 'cy-modal';
    m.onclick = e => { if (e.target === m) m.remove(); };
    m.innerHTML = `<div class="bx">
      <div style="display:flex;gap:8px;align-items:flex-start"><div style="flex:1">
        <div style="font-size:12px;color:var(--text2)">${esc(c.titulo)} · ${esc([t.ref, t.incRef !== t.ref ? t.incRef : ''].filter(Boolean).join(' · '))}</div>
        <div style="font-size:17px;font-weight:700;margin-top:2px">${t.urgente ? '🚨 ' : ''}${esc(t.cliente || '¿cliente?')}</div>
        ${t.direccion ? `<div style="font-size:12.5px;color:var(--text2)">📍 ${esc(t.direccion)}</div>` : ''}
      </div><button onclick="document.getElementById('cy-modal').remove()" style="background:none;border:0;color:var(--text2);font-size:20px;cursor:pointer">✕</button></div>
      ${t.que ? `<div style="font-size:13px;margin:10px 0;color:var(--text)">${esc(t.que)}</div>` : ''}
      <div style="font-size:13px;font-weight:600;color:${SEM[t.semaforo]};margin-bottom:6px">${esc(t.etiqueta)}${t.col !== 'cobrado' ? ` · ${t.dias} día${t.dias === 1 ? '' : 's'} en este paso` : ''}</div>
      ${pasos ? `<div style="margin-top:6px">${pasos}</div>` : ''}
      ${(t.facturas || []).length ? `<div style="font-size:12.5px;color:var(--text2);margin-top:8px">${t.facturas.map(f => `${esc(f.ref)} · ${eur(f.total)}${f.pendiente ? ` · faltan ${eur(f.pendiente)}` : ' · cobrada'}`).join('<br>')}</div>` : ''}
      ${ayuda ? `<div style="font-size:12px;color:var(--text3);margin-top:10px">${esc(ayuda)}</div>` : ''}
      ${acc.length ? `<div class="cy-acc">${acc.join('')}</div>` : ''}
    </div>`;
    document.body.appendChild(m);
  }

  // Trabajo aceptado de la cola: día previsto, medio (grúa/plataforma se reservan) y hecho.
  function verCola(t, c) {
    const M = (st.cola && st.cola.medios) || {};
    const m = document.createElement('div');
    m.className = 'cy-modal'; m.id = 'cy-modal';
    m.onclick = e => { if (e.target === m) m.remove(); };
    const al = (t.alertas || []).map(a => `<div style="font-size:12.5px;color:${SEM[t.semaforo]}">${esc(a)}</div>`).join('');
    m.innerHTML = `<div class="bx cy-q">
      <div style="display:flex;gap:8px;align-items:flex-start"><div style="flex:1">
        <div style="font-size:12px;color:var(--text2)">${esc(c.titulo)} · ${esc(t.ref || '')}${t.pedidoRef ? ' · ' + esc(t.pedidoRef) : ''}</div>
        <div style="font-size:17px;font-weight:700;margin-top:2px">${esc(t.cliente || '')}</div>
        ${t.direccion ? `<div style="font-size:12.5px;color:var(--text2)">📍 ${esc(t.direccion)}</div>` : ''}
      </div><button onclick="document.getElementById('cy-modal').remove()" style="background:none;border:0;color:var(--text2);font-size:20px;cursor:pointer">✕</button></div>
      ${t.que ? `<div style="font-size:13px;margin:10px 0">${esc(t.que)}</div>` : ''}
      <div style="font-size:13px;font-weight:600;color:${SEM[t.semaforo]}">${esc(t.etiqueta)}</div>${al}
      <div style="font-size:12.5px;color:var(--text2);margin-top:6px">🛒 ${t.items - t.faltan} de ${t.items} materiales${t.operario ? ` · 👷 ${esc(t.operario)}${(t.equipo || []).length ? ' con ' + esc(t.equipo.join(', ')) : ''}` : ''}</div>
      <label>Día previsto${t.asignado ? ' (cambia también la cita del operario)' : ' (va al calendario)'}</label>
      <div class="fila2"><input type="date" id="cq-f" value="${esc(t.fecha || '')}"><input type="time" id="cq-h" value="${esc(t.hora || '')}" style="width:110px"></div>
      <label>Medios</label>
      <div class="fila2"><select id="cq-m"><option value="">—</option>${Object.entries(M).map(([k, v]) => `<option value="${k}"${t.medio === k ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>
        <label style="margin:0;display:flex;gap:6px;align-items:center;color:var(--text)"><input type="checkbox" id="cq-r"${t.reservado ? ' checked' : ''}> reservada</label>
        <input id="cq-p" placeholder="A quién (Grualpa…)" value="${esc(t.proveedorMedio || '')}" style="flex:1;min-width:120px"></div>
      <div class="cy-acc">
        <button onclick="CP.Ciclo.colaGuardar('${esc(t.listaId)}',this)" style="background:var(--blue);border-color:var(--blue);color:#fff;font-weight:700">Guardar</button>
        ${t.hecho ? `<button onclick="CP.Ciclo.colaGuardar('${esc(t.listaId)}',this,{hecho:false})">↩ No está hecho</button>` : `<button onclick="CP.Ciclo.colaGuardar('${esc(t.listaId)}',this,{hecho:true})">✅ Hecho</button>`}
        <button onclick="CP.Ciclo.colaPdf('${esc(t.listaId)}',0)">📄 Lista de compra</button>
        <button onclick="CP.Ciclo.colaPdf('${esc(t.listaId)}',1)">📋 Parte</button>
      </div>
      <div style="font-size:12px;color:var(--text3);margin-top:10px">También por WhatsApp a Corpy: «Cartagena el martes a las 8», «grúa de Cartagena reservada», «Creu 42 hecho». Si lleva grúa o plataforma sin reservar, te lo recuerda cada mañana desde 5 días antes.</div>
    </div>`;
    document.body.appendChild(m);
  }

  function quitar(id) {
    if (!id) return;
    [...st.d.columnas, ...st.d.presupuestos].forEach(c => { const i = c.tarjetas.findIndex(x => x.id === id); if (i >= 0) { const [t] = c.tarjetas.splice(i, 1); c.total--; if (t.importe) c.importe -= t.importe; } });
    document.getElementById('cy-modal')?.remove();
    pintar();
  }

  async function accion(btn, fn, id, ok) {
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    try { await fn(); quitar(id); if (window.toast && ok) toast(ok); }
    catch (e) { if (btn) { btn.disabled = false; btn.textContent = 'Error: ' + e.message; } }
  }

  // ── Facturar desde el parte ──
  const fx = { p: null };
  const num = v => Number(String(v == null ? '' : v).replace(',', '.')) || 0;
  function fxTotales() {
    const L = fx.p.lineas; const iva = Number(document.getElementById('fx-iva')?.value || fx.p.iva);
    const base = L.reduce((s, l) => s + Math.round(num(l.unidades) * num(l.precio) * 100) / 100, 0);
    const cuota = Math.round(base * iva) / 100;
    L.forEach((l, i) => { const e = document.getElementById('fx-imp-' + i); if (e) e.textContent = eur2(num(l.unidades) * num(l.precio)); });
    const t = document.getElementById('fx-tot');
    if (t) t.innerHTML = `<span>Base ${eur2(base)}</span><span>IVA ${iva} % ${eur2(cuota)}</span><span>Total <b>${eur2(base + cuota)}</b></span>`;
    return { base, cuota, total: Math.round((base + cuota) * 100) / 100, iva };
  }
  const eur2 = n => (Number(n) || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  function fxLineas() {
    const box = document.getElementById('fx-lineas'); if (!box) return;
    box.innerHTML = fx.p.lineas.map((l, i) => `<div class="cy-fl">
      <input value="${esc(l.concepto)}" placeholder="Concepto" oninput="CP.Ciclo._fx(${i},'concepto',this.value)" style="font-weight:600">
      <textarea rows="2" placeholder="Detalle (sale en la factura)" oninput="CP.Ciclo._fx(${i},'descripcion',this.value)">${esc(l.descripcion || '')}</textarea>
      <div class="nums"><div><label>${l.tipo === 'mano' ? 'Horas' : 'Unidades'}</label><input inputmode="decimal" value="${esc(l.unidades)}" oninput="CP.Ciclo._fx(${i},'unidades',this.value)"></div>
        <div><label>Precio €${l.coste ? ` <span title="${esc(l.precioFuente || '')}">(coste ${esc(l.coste)})</span>` : ''}</label><input inputmode="decimal" value="${esc(l.precio)}" oninput="CP.Ciclo._fx(${i},'precio',this.value)"></div>
        <div><label>Importe</label><span id="fx-imp-${i}" style="font-weight:600"></span></div>
        <button title="Quitar" onclick="CP.Ciclo._fxQuitar(${i})" style="background:none;border:0;color:var(--text3);font-size:16px;cursor:pointer">✕</button></div></div>`).join('') || '<div class="cy-vacio">Sin líneas</div>';
    fxTotales();
  }
  async function facturar(woId) {
    document.getElementById('cy-modal')?.remove();
    const m = document.createElement('div'); m.className = 'cy-modal'; m.id = 'cy-modal';
    m.onclick = e => { if (e.target === m) m.remove(); };
    m.innerHTML = '<div class="bx">Montando la factura con el parte…</div>';
    document.body.appendChild(m);
    let p; try { p = await api('/api/ciclo/factura/' + woId); } catch (e) { m.querySelector('.bx').textContent = 'No se ha podido: ' + e.message; return; }
    fx.p = p;
    const bloqueo = p.yaFacturado ? `<div class="alert" style="margin:10px 0;color:var(--green)">✅ Ya está facturado${p.yaFacturado.ref ? ': ' + esc(p.yaFacturado.ref) : ''}.</div>`
      : (p.enCurso === 'revisar' || p.enCurso === 'enviando') ? `<div style="margin:10px 0;color:var(--red);font-size:13px">⚠️ El último intento no tuvo respuesta de StelOrder. Mira en StelOrder si la factura de ${esc(p.pedidoRef)} existe. Si NO existe: <button onclick="CP.Ciclo._fxDesbloquear('${esc(woId)}',this)">Desbloquear</button></div>` : '';
    m.querySelector('.bx').innerHTML = `
      <div style="display:flex;gap:8px;align-items:flex-start"><div style="flex:1">
        <div style="font-size:12px;color:var(--text2)">🧾 Facturar · ${esc(p.pedidoRef)}${p.incRef ? ' · ' + esc(p.incRef) : ''} · ${p.partes} parte${p.partes === 1 ? '' : 's'}</div>
        <div style="font-size:17px;font-weight:700;margin-top:2px">${esc(p.cliente)}</div>
        ${p.familia ? `<div style="font-size:12px;color:var(--text3)">${esc(p.familia)}</div>` : ''}
      </div><button onclick="document.getElementById('cy-modal').remove()" style="background:none;border:0;color:var(--text2);font-size:20px;cursor:pointer">✕</button></div>
      ${bloqueo}
      ${(p.avisos || []).length ? `<div style="font-size:12.5px;color:var(--amber);margin:8px 0">${p.avisos.map(a => '• ' + esc(a)).join('<br>')}</div>` : ''}
      <div class="cy-fx" style="margin:10px 0 8px"><label style="font-size:11px;color:var(--text3)">Título de la factura (sale como sección)</label><input id="fx-tit" value="${esc(p.titulo || '')}"></div>
      <div id="fx-lineas"></div>
      <button onclick="CP.Ciclo._fxNueva()" style="background:none;border:1px dashed var(--border2);border-radius:8px;color:var(--text2);padding:6px 10px;font-size:12.5px;cursor:pointer;width:100%">＋ Añadir línea</button>
      <div class="cy-fx" style="display:flex;gap:8px;align-items:center;margin-top:10px;font-size:13px"><span>IVA</span>
        <select id="fx-iva" style="width:auto" onchange="CP.Ciclo._fxTot()">${[21, 10, 4, 0].map(v => `<option value="${v}"${v === p.iva ? ' selected' : ''}>${v} %</option>`).join('')}</select>
        <span style="font-size:11.5px;color:var(--text3)">10 % reparación en comunidad con material &lt; 40 %</span></div>
      <div class="cy-tot" id="fx-tot"></div>
      <div style="font-size:11.5px;color:var(--text3);margin-top:8px">Precios de partida: mano de obra ${esc(p.reglas.precioHora)} €/h (mín. ${esc(p.reglas.horasMin)} h por salida), material a coste ×${esc(p.reglas.margenMaterial)}, desplazamiento ${esc(p.reglas.desplazamiento)} € por salida. Cambia lo que quieras antes de crearla.</div>
      <div id="fx-res" style="font-size:13px;margin-top:10px"></div>
      ${p.yaFacturado ? '' : `<div class="cy-acc">
        <button id="fx-ok" onclick="CP.Ciclo._fxCrear('${esc(woId)}',false,this)" style="background:var(--blue);border-color:var(--blue);color:#fff;font-weight:700">Crear factura en StelOrder</button>
        <button onclick="CP.Ciclo._fxCrear('${esc(woId)}',true,this)">${p.pedidoConLineas ? 'Las líneas ya están en el pedido' : 'Solo pasar al pedido'}</button></div>`}`;
    fxLineas();
  }
  async function fxCrear(woId, soloPedido, btn) {
    const t = fxTotales();
    const L = fx.p.lineas.filter(l => String(l.concepto || '').trim() && num(l.unidades) > 0);
    if (!L.length) { alert('La factura no tiene líneas'); return; }
    if (!soloPedido && !confirm(`Se va a crear la factura de ${fx.p.cliente} en StelOrder por ${eur2(t.total)} (IVA ${t.iva} % incluido).\n\nEs una factura de verdad: después solo se corrige con una rectificativa. ¿Crearla?`)) return;
    const res = document.getElementById('fx-res');
    document.querySelectorAll('#cy-modal .cy-acc button').forEach(b => { b.disabled = true; });
    btn.textContent = 'Un momento…';
    try {
      const r = await api('/api/ciclo/factura/' + woId, { method: 'POST', body: JSON.stringify({ lineas: L, iva: t.iva, titulo: document.getElementById('fx-tit').value, soloPedido }) });
      res.innerHTML = r.soloPedido ? `<span style="color:var(--green)">✅ Líneas pasadas a ${esc(r.pedidoRef)}. Ya se puede facturar desde el pedido.</span>`
        : `<span style="color:var(--green);font-weight:700">✅ Factura ${esc(r.factura.ref)} creada · ${eur2(r.factura.total != null ? r.factura.total : r.total)}</span>${r.factura.pdfPath ? ` · <a href="${esc(r.factura.pdfPath)}" target="_blank" rel="noopener">Ver PDF</a>` : ''}${r.aviso ? `<div style="color:var(--amber)">${esc(r.aviso)}</div>` : ''}<div style="color:var(--text3);font-size:12px;margin-top:4px">Pasa a «Por cobrar». Para mandársela al cliente, desde StelOrder o Pendientes de cobro.</div>`;
      document.querySelector('#cy-modal .cy-acc')?.remove();
      if (!r.soloPedido) cargar();
    } catch (e) {
      res.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`;
      document.querySelectorAll('#cy-modal .cy-acc button').forEach(b => { b.disabled = false; });
      btn.textContent = soloPedido ? 'Solo pasar al pedido' : 'Crear factura en StelOrder';
    }
  }

  CP.Ciclo = {
    facturar,
    _fx(i, k, v) { fx.p.lineas[i][k] = v; if (k === 'unidades' || k === 'precio') fxTotales(); },
    _fxTot: () => fxTotales(),
    _fxQuitar(i) { fx.p.lineas.splice(i, 1); fxLineas(); },
    _fxNueva() { fx.p.lineas.push({ tipo: 'otro', concepto: '', descripcion: '', unidades: 1, precio: 0 }); fxLineas(); },
    _fxCrear: fxCrear,
    async _fxDesbloquear(woId, b) { try { await api('/api/ciclo/factura/' + woId + '/desbloquear', { method: 'POST' }); facturar(woId); } catch (e) { b.textContent = e.message; } },
    render, cargar, ver,
    async colaGuardar(id, btn, extra = null) {
      const v = k => document.getElementById(k);
      const b = extra || { fecha: v('cq-f').value || null, hora: v('cq-h').value || null, medio: v('cq-m').value || undefined, reservado: v('cq-r').checked, proveedorMedio: v('cq-p').value || undefined };
      btn.disabled = true; btn.textContent = '…';
      try { await api('/api/cola/' + id, { method: 'POST', body: JSON.stringify(b) }); document.getElementById('cy-modal')?.remove(); if (window.toast) toast('Guardado'); cargar(); }
      catch (e) { btn.disabled = false; btn.textContent = 'Error: ' + e.message; }
    },
    async colaPdf(id, parte) {
      try {
        const r = await fetch(`/api/materiales/${id}/pdf${parte ? '?parte=1' : ''}`, { headers: { Authorization: 'Bearer ' + (localStorage.getItem('cp_token') || '') } });
        if (!r.ok) throw new Error('No se ha podido abrir');
        window.open(URL.createObjectURL(await r.blob()), '_blank');
      } catch (e) { if (window.toast) toast(e.message); }
    },
    filtrar(v) { st.filtro = v; pintar(); },
    rojos() { st.soloRojos = !st.soloRojos; document.getElementById('cy-rojos')?.classList.toggle('on', st.soloRojos); pintar(); },
    todas(k) { const c = [...st.d.columnas, ...st.d.presupuestos].find(x => x.k === k); if (c) c._todas = true; pintar(); },
    estado(ref, estado, btn, id) {
      return accion(btn, async () => {
        await api(`/api/ciclo/incidencia/${encodeURIComponent(ref)}/estado`, { method: 'POST', body: JSON.stringify({ estado }) });
        const f = document.getElementById('cy-l-' + ref); if (f) f.remove();
        if (st.d.limpieza) st.d.limpieza = st.d.limpieza.filter(x => x.ref !== ref);
      }, id, `${ref} actualizada en StelOrder`);
    },
    peticion(pid, estado, btn, id) { return accion(btn, () => api('/api/peticiones/' + pid, { method: 'POST', body: JSON.stringify({ estado }) }), id, 'Hecho'); },
    observacion(woId, on, btn, id) {
      const motivo = on ? prompt('¿Qué se está observando? (por ejemplo: «ver si entra agua cuando llueva»). Si es por agua, cuando llueva en Girona te aviso para llamar.', '') : '';
      if (on && motivo === null) return;
      const nota = on ? '' : (document.getElementById('cy-obs-nota')?.value || '').trim();
      return accion(btn, async () => { const r = await api('/api/ciclo/observacion/' + woId, { method: 'POST', body: JSON.stringify({ on, motivo, nota }) }); document.getElementById('cy-modal')?.remove(); cargar(); if (!on && window.toast) toast(r && r.avisado ? 'Vuelve al técnico: le ha llegado por WhatsApp' : 'Vuelve al técnico (lo tiene en la app; WhatsApp no enviado)'); }, null, on ? 'En observación: ya no le llega al técnico' : '');
    },
    ignorar(id, btn) { return accion(btn, () => api('/api/ciclo/ignorar', { method: 'POST', body: JSON.stringify({ id, motivo: 'facturado aparte o no se factura' }) }), id, 'Quitado del tablero'); },
    tv() {
      const el = st.cont; if (!el) return;
      const salir = () => { el.classList.remove('cy-tv'); clearInterval(st.timer); st.timer = null; };
      if (document.fullscreenElement) { document.exitFullscreen(); return; }
      el.classList.add('cy-tv');
      (el.requestFullscreen ? el.requestFullscreen() : Promise.reject()).catch(() => {});
      clearInterval(st.timer);
      st.timer = setInterval(() => { if (!document.hidden) cargar(); }, 120000);
      const onFs = () => { if (!document.fullscreenElement) { salir(); document.removeEventListener('fullscreenchange', onFs); } };
      document.addEventListener('fullscreenchange', onFs);
    },
  };
})(window.CP = window.CP || {});
