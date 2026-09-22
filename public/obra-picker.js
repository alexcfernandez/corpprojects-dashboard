// obra-picker.js — SELECTOR ÚNICO DE OBRA para toda la app.
// Se busca por nombre, dirección, motes ("can pedretes", "aura y lluís") y cliente.
// Arriba las obras abiertas; abajo las cerradas hace poco; las antiguas solo al buscar.
//
//   const p = CPObra.crear(contenedor, { obras, value, vacio:'— Sin obra —', onChange(obra){} });
//   p.value  → id elegido ('' si ninguno)   p.obra → objeto elegido   p.set(id)   p.setObras(lista)
//
// `obras` = [{ id, reference, clientName, address, aliases[], status, grupo }]  (GET /api/campo/obras,
// /api/obras/selector o /api/facturas/obras). Sin importes: lo ven también los trabajadores.
(function () {
  const CSS = `
.cpo-campo{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:var(--bg3,var(--bg2,#1c1f26));border:1px solid var(--border2,var(--border,#333));border-radius:12px;color:var(--text,#fff);font:inherit;font-size:15px;padding:13px 14px;cursor:pointer}
.cpo-campo .cpo-t{flex:1;min-width:0}.cpo-campo .cpo-n{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cpo-campo .cpo-s{font-size:12px;color:var(--text3,#8a8f98);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.cpo-campo.vacio .cpo-n{font-weight:500;color:var(--text2,#b5bac4)}.cpo-campo .cpo-ch{color:var(--text3,#8a8f98);font-size:13px}
.cpo-ov{position:fixed;inset:0;z-index:900;background:rgba(0,0,0,.6);display:flex;align-items:flex-end;justify-content:center}
.cpo-hoja{background:var(--bg,#111318);color:var(--text,#fff);width:100%;max-width:560px;height:88vh;border-radius:18px 18px 0 0;border:1px solid var(--border2,var(--border,#333));border-bottom:none;display:flex;flex-direction:column;overflow:hidden}
@media(min-width:700px){.cpo-ov{align-items:center}.cpo-hoja{height:78vh;border-radius:18px;border-bottom:1px solid var(--border2,var(--border,#333))}}
.cpo-cab{display:flex;align-items:center;gap:10px;padding:14px 14px 10px}.cpo-cab b{flex:1;font-size:16px}
.cpo-x{background:none;border:none;color:var(--text2,#b5bac4);font-size:22px;line-height:1;cursor:pointer;padding:4px 8px}
.cpo-q{margin:0 14px 10px;padding:13px 14px;border-radius:12px;border:1px solid var(--border2,var(--border,#333));background:var(--bg2,#1c1f26);color:var(--text,#fff);font:inherit;font-size:16px;outline:none}
.cpo-lista{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0 8px 18px}
.cpo-g{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3,#8a8f98);font-weight:600;padding:14px 8px 6px}
.cpo-it{display:block;width:100%;text-align:left;background:none;border:none;border-radius:12px;color:inherit;font:inherit;padding:12px 10px;cursor:pointer}
.cpo-it:hover,.cpo-it:focus{background:var(--bg2,#1c1f26);outline:none}.cpo-it.sel{background:var(--bg2,#1c1f26);box-shadow:inset 3px 0 0 var(--green,#22c487)}
.cpo-it .n{font-weight:600;font-size:15px}.cpo-it .s{font-size:12.5px;color:var(--text3,#8a8f98);margin-top:3px;line-height:1.4}
.cpo-it .m{font-size:12px;color:var(--text2,#b5bac4);margin-top:3px}.cpo-it .tag{display:inline-block;font-size:10.5px;border:1px solid var(--border2,var(--border,#333));border-radius:20px;padding:1px 7px;margin-left:6px;color:var(--text3,#8a8f98);font-weight:500;vertical-align:1px}
.cpo-nada{color:var(--text3,#8a8f98);text-align:center;padding:30px 16px;font-size:14px;line-height:1.5}
.cpo-mas{display:block;width:100%;background:none;border:1px dashed var(--border2,#444);border-radius:12px;color:var(--text2,#b5bac4);font:inherit;font-size:13px;padding:11px;margin:10px 0 4px;cursor:pointer}
.cpo-crear{display:block;width:100%;text-align:left;background:rgba(34,196,135,.1);border:1px solid rgba(34,196,135,.45);border-radius:12px;color:var(--text,#fff);font:inherit;font-size:14.5px;font-weight:600;padding:12px;margin:8px 0 4px;cursor:pointer}`;
  let cssOk = false;
  function css() { if (cssOk) return; cssOk = true; const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // minúsculas, sin acentos ni signos: "Can Pedretes" = "can pedretés" = "CAN-PEDRETES"
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñç]+/g, ' ').trim();
  const ESTADO_TXT = { estudio: 'en estudio', pausada: 'pausada', terminada: 'terminada', facturada: 'facturada' };

  function buscar(obras, texto, verAntiguas) {
    const toks = norm(texto).split(' ').filter(Boolean);
    if (!toks.length) return obras.filter(o => verAntiguas || o.grupo !== 'antigua').map(o => ({ o, mote: null }));
    const res = [];
    for (const o of obras) {
      const campos = [o.reference, o.address, o.clientName, ...(o.aliases || [])].map(norm);
      const todo = campos.join(' | ');
      if (!toks.every(t => todo.includes(t))) continue;
      // si lo encontró por un mote (y no por el nombre), se enseña cuál
      const enNombre = toks.every(t => campos[0].includes(t));
      const mote = enNombre ? null : (o.aliases || []).find(a => toks.some(t => norm(a).includes(t))) || null;
      // primero las que casan por el principio del nombre
      res.push({ o, mote, peso: (campos[0].startsWith(toks[0]) ? 0 : enNombre ? 1 : 2) });
    }
    const g = { abierta: 0, estudio: 1, cerrada: 2, antigua: 3 };
    return res.sort((a, b) => (g[a.o.grupo] - g[b.o.grupo]) || (a.peso - b.peso));
  }

  function crear(cont, opt) {
    css(); opt = opt || {};
    let obras = Array.isArray(opt.obras) ? opt.obras : [], valor = opt.value || '';
    const vacio = opt.vacio === undefined ? '— Sin obra —' : opt.vacio; // null = obligatorio elegir
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'cpo-campo';
    cont.innerHTML = ''; cont.appendChild(btn);
    const actual = () => obras.find(o => o.id === valor) || null;

    function pintarCampo() {
      const o = actual();
      btn.classList.toggle('vacio', !o);
      btn.innerHTML = o
        ? `<span>🏗️</span><span class="cpo-t"><div class="cpo-n">${esc(o.reference)}</div>${o.address || o.clientName ? `<div class="cpo-s">${esc(o.address || o.clientName)}</div>` : ''}</span><span class="cpo-ch">Cambiar</span>`
        : `<span>🏗️</span><span class="cpo-t"><div class="cpo-n">${esc(opt.placeholder || 'Elegir obra…')}</div></span><span class="cpo-ch">▾</span>`;
    }
    function elegir(id) {
      valor = id || ''; pintarCampo();
      if (typeof opt.onChange === 'function') opt.onChange(actual());
    }
    function abrir() {
      let verAntiguas = false;
      const ov = document.createElement('div'); ov.className = 'cpo-ov';
      ov.innerHTML = `<div class="cpo-hoja" role="dialog" aria-label="Elegir obra"><div class="cpo-cab"><b>${esc(opt.titulo || '¿Qué obra?')}</b><button type="button" class="cpo-x" aria-label="Cerrar">×</button></div>
        <input class="cpo-q" type="search" placeholder="Busca por nombre, calle o mote…" autocomplete="off" autocorrect="off" spellcheck="false">
        <div class="cpo-lista"></div></div>`;
      const q = ov.querySelector('.cpo-q'), lista = ov.querySelector('.cpo-lista');
      const cerrar = () => { ov.remove(); document.removeEventListener('keydown', tecla); btn.focus(); };
      const tecla = e => { if (e.key === 'Escape') cerrar(); };
      function pintar() {
        const r = buscar(obras, q.value, verAntiguas); let h = '', g = null;
        if (vacio !== null && !norm(q.value)) h += `<button type="button" class="cpo-it ${!valor ? 'sel' : ''}" data-id=""><div class="n" style="font-weight:500">${esc(vacio)}</div></button>`;
        const TIT = { abierta: 'Obras abiertas', estudio: 'En estudio (aún sin aceptar)', cerrada: 'Cerradas hace poco', antigua: 'Cerradas hace tiempo' };
        for (const { o, mote } of r) {
          if (o.grupo !== g) { g = o.grupo; h += `<div class="cpo-g">${TIT[g] || ''}</div>`; }
          const sub = [o.address, o.clientName].filter(Boolean).map(esc).join(' · ');
          h += `<button type="button" class="cpo-it ${o.id === valor ? 'sel' : ''}" data-id="${esc(o.id)}"><div class="n">${esc(o.reference)}${ESTADO_TXT[o.status] ? `<span class="tag">${ESTADO_TXT[o.status]}</span>` : ''}</div>${sub ? `<div class="s">${sub}</div>` : ''}${mote ? `<div class="m">también: «${esc(mote)}»</div>` : ''}</button>`;
        }
        if (!r.length) h += `<div class="cpo-nada">${obras.length ? 'No hay ninguna obra que se llame así.<br>Prueba con la calle o con el nombre del cliente.' : 'Todavía no hay obras.'}</div>`;
        // Cerradas hace tiempo: escondidas hasta que se pide verlas (o al buscar, que salen solas)
        const nAnt = obras.filter(o => o.grupo === 'antigua').length;
        if (nAnt && !verAntiguas && !norm(q.value)) h += `<button type="button" class="cpo-mas" data-mas="1">Ver también las cerradas hace tiempo (${nAnt})</button>`;
        // Crear una obra aquí mismo (solo si la pantalla lo permite: oficina)
        if (typeof opt.crear === 'function') { const t = q.value.trim(); h += `<button type="button" class="cpo-crear" data-crear="1">＋ Crear la obra${t ? ' «' + esc(t) + '»' : ' nueva…'}</button>`; }
        lista.innerHTML = h; lista.scrollTop = 0;
      }
      q.addEventListener('input', pintar);
      q.addEventListener('keydown', e => { if (e.key === 'Enter') { const p = lista.querySelector('.cpo-it[data-id]:not([data-id=""])'); if (p && norm(q.value)) { elegir(p.dataset.id); cerrar(); } } });
      lista.addEventListener('click', async e => {
        const mas = e.target.closest('[data-mas]'); if (mas) { verAntiguas = true; pintar(); return; }
        const cr = e.target.closest('[data-crear]');
        if (cr) {
          let nombre = q.value.trim();
          if (!nombre) { nombre = (window.prompt('Nombre de la obra nueva (como la llamáis vosotros):') || '').trim(); if (!nombre) return; }
          const dir = (window.prompt('Dirección de la obra (calle, número y población). Puedes dejarlo vacío y ponerla luego:', '') || '').trim();
          cr.disabled = true; cr.textContent = 'Creando…';
          try { const o = await opt.crear(nombre, dir); if (o && o.id) { obras = [{ ...o, aliases: o.aliases || [], grupo: o.grupo || 'abierta', status: o.status || 'activa' }, ...obras.filter(x => x.id !== o.id)]; elegir(o.id); cerrar(); } }
          catch (err) { alert(err.message || 'No se pudo crear la obra'); cr.disabled = false; pintar(); }
          return;
        }
        const it = e.target.closest('.cpo-it'); if (!it) return; elegir(it.dataset.id); cerrar(); });
      ov.addEventListener('click', e => { if (e.target === ov) cerrar(); });
      ov.querySelector('.cpo-x').addEventListener('click', cerrar);
      document.addEventListener('keydown', tecla);
      document.body.appendChild(ov); pintar();
      // En móvil no se abre el teclado de golpe si hay pocas obras (tapa media lista)
      if (obras.length > 8 || window.matchMedia('(min-width:700px)').matches) q.focus();
    }
    btn.addEventListener('click', abrir);
    pintarCampo();
    return {
      get value() { return valor; }, get obra() { return actual(); },
      set(id) { valor = id || ''; pintarCampo(); },
      setObras(l) { obras = Array.isArray(l) ? l : []; pintarCampo(); },
      abrir,
    };
  }
  window.CPObra = { crear, buscar, norm };
})();
