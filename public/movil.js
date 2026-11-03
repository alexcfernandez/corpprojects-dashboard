// public/movil.js — El panel en el MÓVIL (3/11/2026, Álex: «en el móvil, cada apartado en su pantalla, los avisos en una
// campana y sin tanto scroll»). Solo cambia algo por debajo de 760 px; en el ordenador todo sigue como estaba.
//  · Barra de pantalla bajo el menú: «‹ Volver» + título de donde estás. El botón «atrás» del móvil hace lo mismo.
//  · Apartados (las pestañas .btab de Partes, Obras, Presencia, Usuarios, Pagos, Banco): primero un menú de botones
//    grandes y cada apartado en su pantalla, en vez de una fila de pestañas que se pasa de ancho.
//  · 🔔 en la barra de arriba con lo de «Hoy toca» de la portada (que en el móvil deja de ocupar media pantalla).
//  · En la portada, los bloques largos (revisión del día, peticiones, reservas…) salen plegados con su cifra.
(function () {
  const mq = window.matchMedia('(max-width: 760px)');
  const esMovil = () => mq.matches;
  const main = document.querySelector('main.main');
  if (!main || typeof window.showTab !== 'function') return;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ── Dónde estamos ──
  const tabActual = () => { const p = document.querySelector('.panel.active'); return p ? p.id.replace(/^tab-/, '') : 'inicio'; };
  const panelActual = () => document.querySelector('.panel.active');
  function tituloTab(id) {
    const b = document.querySelector(`.nav-btn[onclick*="showTab('${id}'"]`);
    if (!b) return id.charAt(0).toUpperCase() + id.slice(1);
    const c = b.cloneNode(true); c.querySelectorAll('span').forEach(x => x.remove());
    return c.textContent.replace(/\s+/g, ' ').trim();
  }
  const textoBtn = b => { const c = b.cloneNode(true); c.querySelectorAll('span').forEach(x => x.remove()); return c.textContent.replace(/\s+/g, ' ').trim(); };

  // ── Barra de pantalla ──
  const barra = document.createElement('div');
  barra.className = 'mv-barra';
  barra.innerHTML = '<button type="button" class="mv-atras" aria-label="Volver">‹ Inicio</button><div class="mv-tit" role="heading" aria-level="1"></div>';
  main.insertBefore(barra, main.firstChild);
  // Las cajas de apartados de una pantalla (en Banco la caja es la propia pantalla).
  const cajasDe = p => p ? [...(p.classList.contains('mv-caja') ? [p] : []), ...p.querySelectorAll('.mv-caja')] : [];
  const cajaAbierta = () => cajasDe(panelActual()).find(c => !c.classList.contains('mv-hub'));
  function pintarBarra() {
    const t = tabActual();
    document.body.classList.toggle('mv-en-tab', t !== 'inicio');
    if (t === 'inicio') return;
    const caja = cajaAbierta();
    const atras = barra.querySelector('.mv-atras'), tit = barra.querySelector('.mv-tit');
    if (caja) {
      const b = caja.querySelector(':scope > .mv-fila .btab.active');
      atras.textContent = '‹ ' + tituloTab(t).replace(/^\S+\s/, '');
      tit.textContent = b ? textoBtn(b) : tituloTab(t);
    } else { atras.textContent = '‹ Inicio'; tit.textContent = tituloTab(t); }
  }

  // ── Historial: cada pantalla es un paso, así el «atrás» del móvil vuelve donde estabas ──
  let aplicando = false;
  const nivel = () => (history.state && history.state.cpN) || 0;
  function apilar(st) {
    if (!esMovil() || aplicando) return;
    const h = history.state || {};
    if (h.cpTab === st.cpTab && h.cpSub === st.cpSub) return;
    history.pushState({ ...st, cpN: nivel() + 1 }, '');
  }
  history.replaceState({ ...(history.state || {}), cpTab: tabActual() }, '');

  const showTabOrig = window.showTab;
  window.showTab = function (id) {
    const r = showTabOrig.apply(this, arguments);
    const p = document.getElementById('tab-' + id);
    if (!aplicando) cajasDe(p).forEach(c => c.classList.add('mv-hub'));   // al entrar, el menú de apartados
    if (!aplicando) { apilar({ cpTab: id }); if (esMovil() && id !== 'inicio') window.scrollTo({ top: 0 }); }
    pintarBarra();
    return r;
  };

  function irAPantalla(id) {
    if (tabActual() === id) return;
    if (id === 'inicio') window.showTab('inicio', document.querySelector('#nav-grupos .nav-btn'));
    else if (typeof window.irA === 'function') window.irA('', id);
  }
  window.addEventListener('popstate', e => {
    const st = e.state || {};
    if (!st.cpTab && tabActual() === 'inicio') return;
    aplicando = true;
    try {
      irAPantalla(st.cpTab || 'inicio');
      preparar();
      const cajas = cajasDe(panelActual());
      cajas.forEach(c => c.classList.add('mv-hub'));
      if (st.cpSub != null && cajas[st.cpCaja || 0]) abrirApartado(cajas[st.cpCaja || 0], st.cpSub, false);
    } finally { aplicando = false; }
    pintarBarra();
  });
  barra.querySelector('.mv-atras').addEventListener('click', () => {
    if (nivel() > 0) { history.back(); return; }
    // Se entró directo (enlace /?tab=…): no hay paso de antes en el historial, se vuelve «a mano».
    const caja = cajaAbierta();
    aplicando = true;
    try { if (caja) caja.classList.add('mv-hub'); else irAPantalla('inicio'); } finally { aplicando = false; }
    history.replaceState({ cpTab: tabActual() }, '');
    pintarBarra(); window.scrollTo({ top: 0 });
  });

  // ── Apartados: menú de botones grandes y una pantalla para cada uno ──
  function abrirApartado(caja, i, apila = true) {
    const btns = [...caja.querySelectorAll(':scope > .mv-fila .btab')];
    const b = btns[i]; if (!b) return;
    if (/location\.href/.test(b.getAttribute('onclick') || '')) { b.click(); return; }   // es otra página
    caja.classList.remove('mv-hub');
    b.click();
    if (apila) apilar({ cpTab: tabActual(), cpSub: i, cpCaja: cajasDe(panelActual()).indexOf(caja) });
    pintarBarra(); window.scrollTo({ top: 0 });
  }
  function preparar() {
    document.querySelectorAll('.panel .btab').forEach(b => {
      const fila = b.parentElement;
      if (!fila || fila.classList.contains('mv-fila') || b.closest('.p-tab, .bpanel')) return;
      const caja = fila.parentElement; if (!caja) return;
      fila.classList.add('mv-fila');
      caja.classList.add('mv-caja', 'mv-hub');
      const menu = document.createElement('div'); menu.className = 'mv-menu';
      const btns = [...fila.querySelectorAll(':scope > .btab')];
      menu.innerHTML = btns.map((x, i) => `<button type="button" data-i="${i}">${x.innerHTML}</button>`).join('');
      menu.addEventListener('click', e => { const m = e.target.closest('button[data-i]'); if (m) abrirApartado(caja, Number(m.dataset.i)); });
      caja.insertBefore(menu, fila.nextSibling);
      // Si el propio módulo abre un apartado (p. ej. «＋ Nueva obra» desde la portada, o Editar usuario), se va a su pantalla.
      new MutationObserver(() => {
        if (!esMovil() || !caja.classList.contains('mv-hub')) return;
        const visible = [...caja.children].some(x => x.classList.contains('p-tab') && x.style.display === 'block');
        if (!visible) return;
        const act = btns.findIndex(x => x.classList.contains('active'));
        caja.classList.remove('mv-hub');
        apilar({ cpTab: tabActual(), cpSub: Math.max(0, act), cpCaja: cajasDe(panelActual()).indexOf(caja) });
        pintarBarra(); window.scrollTo({ top: 0 });
      }).observe(caja, { attributes: true, attributeFilter: ['style'], subtree: true });
    });
  }

  // ── Portada: bloques largos plegados ──
  const PLEGABLES = ['ini-revision', 'ini-peticiones', 'ini-descuentos', 'ini-facturar', 'ini-precios', 'inicio-reservas'];
  const abiertos = new Set();
  function plegar() {
    PLEGABLES.forEach(id => {
      const el = document.getElementById(id); if (!el) return;
      if (!el.classList.contains('mv-plegable')) {
        el.classList.add('mv-plegable');
        el.addEventListener('click', e => {
          if (!esMovil()) return;
          const cab = el.querySelector(':scope > .card > :first-child');
          if (!cab || !cab.contains(e.target) || e.target.closest('a, button, input, select, summary')) return;
          el.classList.toggle('abierto');
          el.classList.contains('abierto') ? abiertos.add(id) : abiertos.delete(id);
        });
      }
      el.classList.toggle('abierto', abiertos.has(id));
      const cab = el.querySelector(':scope > .card > :first-child');
      if (cab && !cab.querySelector('.mv-pliegue')) cab.insertAdjacentHTML('beforeend', '<span class="mv-pliegue" aria-hidden="true">›</span>');
    });
  }

  // ── 🔔 Avisos (lo de «Hoy toca» de la portada) ──
  let campana = null, sheet = null;
  function chips() { const box = document.getElementById('ini-hoytoca'); return box ? [...box.querySelectorAll('.cp-chip')] : null; }
  function montarCampana() {
    const nav = document.querySelector('.cpnav'); if (!nav || campana) return;
    campana = document.createElement('button');
    campana.type = 'button'; campana.className = 'mv-campana'; campana.hidden = true;
    campana.innerHTML = '<span aria-hidden="true">🔔</span><span class="mv-n" hidden></span>';
    nav.insertBefore(campana, nav.querySelector('.hb'));
    sheet = document.createElement('div'); sheet.className = 'mv-sheet';
    sheet.innerHTML = '<div class="mv-panel" role="dialog" aria-label="Avisos"><div class="mv-cab">Hoy toca</div><div class="mv-lista"></div></div>';
    document.body.appendChild(sheet);
    campana.addEventListener('click', e => { e.stopPropagation(); sheet.classList.contains('abierta') ? cerrar() : abrir(); });
    sheet.addEventListener('click', e => {
      if (e.target === sheet) { cerrar(); return; }
      const f = e.target.closest('.mv-aviso'); if (!f) return;
      const orig = chips()[Number(f.dataset.i)]; cerrar(); if (!orig) return;
      if (/enc-det/.test(orig.getAttribute('onclick') || '')) {   // encargos: el detalle está en la portada
        irAPantalla('inicio'); const d = document.getElementById('enc-det');
        if (d) { d.style.display = ''; setTimeout(() => d.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60); }
        return;
      }
      orig.click();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') cerrar(); });
  }
  function abrir() {
    const l = chips() || [];
    sheet.querySelector('.mv-lista').innerHTML = l.length
      ? l.map((c, i) => { const x = c.cloneNode(true); x.removeAttribute('onclick'); x.removeAttribute('style'); x.className = 'mv-aviso'; x.dataset.i = i; return x.outerHTML; }).join('')
      : '<div class="mv-nada">✔ Nada urgente pendiente</div>';
    sheet.classList.add('abierta'); campana.setAttribute('aria-expanded', 'true');
  }
  function cerrar() { if (sheet) sheet.classList.remove('abierta'); if (campana) campana.setAttribute('aria-expanded', 'false'); }
  function contarCampana() {
    montarCampana(); if (!campana) return;
    const l = chips();
    campana.hidden = !l;   // sin portada con avisos (técnico, encargado) no sale
    if (!l) return;
    const n = campana.querySelector('.mv-n');
    n.hidden = !l.length; n.textContent = l.length > 99 ? '99+' : l.length;
    n.classList.toggle('ambar', !l.some(c => /var\(--red\)/.test(c.innerHTML)));
    campana.setAttribute('aria-label', l.length ? `Avisos: ${l.length}` : 'Avisos: nada urgente');
  }

  // ── Todo esto se repite cuando los módulos pintan (innerHTML) ──
  let pendiente = false;
  const repasar = () => { if (pendiente) return; pendiente = true; setTimeout(() => { pendiente = false; preparar(); plegar(); contarCampana(); pintarBarra(); }, 0); };
  new MutationObserver(repasar).observe(main, { childList: true, subtree: true });
  mq.addEventListener ? mq.addEventListener('change', () => { cerrar(); repasar(); }) : mq.addListener(repasar);
  repasar();
})();
