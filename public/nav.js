// public/nav.js — MENÚ COMÚN de oficina: el mismo en todas las pantallas (antes, al entrar en Compras, Vehículos,
// Cierre… el menú desaparecía y había que volver con «← Dashboard»). Una sola lista (CP_MENU) por secciones; en el
// móvil se abre con el botón ☰. Las pestañas del dashboard se abren con /?tab=<id>.
// Solo para la sesión de oficina (cp_token); en las pantallas de los trabajadores (fichar, compra, parte) no sale.
(function () {
  const MENU = [
    { t: 'Inicio', i: '🏠', href: '/' },
    { t: 'Obras', i: '🏗️', items: [
      ['Obras', '/?tab=obras'], ['Pedidos de trabajo', '/?tab=pedidos'], ['Planificación', '/?tab=planning'], ['Partes', '/?tab=partes'],
      ['Comunidades', '/?tab=comunidades'], ['Mediciones', '/medir'], ['Presupuestos', '/presupuestos'], ['Catálogo de precios', '/catalogo'],
      ['Amidaments', '/amidaments'], ['Competencia', '/competencia']] },
    { t: 'Dinero', i: '💰', items: [
      ['Informes · resultado', '/?tab=informes'], ['Facturación', '/?tab=facturas'], ['Pendientes de cobro', '/?tab=pendientes'], ['Cobros', '/?tab=cobros'],
      ['Presupuestos StelOrder', '/?tab=presupuestos'], ['Banco y gastos', '/?tab=banco'], ['Cierre del trimestre', '/trimestre'], ['Pagos y autónomos', '/?tab=pagos']] },
    { t: 'Compras', i: '🧾', items: [
      ['Compras por revisar', '/compras'], ['Cuentas de proveedores', '/compras#cuentas'], ['Subir una compra', '/compra'], ['Almacén', '/almacen']] },
    { t: 'Personal', i: '👷', items: [
      ['Presencia', '/?tab=presencia'], ['Fichajes', '/fichajes'], ['Horas fichadas', '/horas'], ['Documentación y nóminas', '/personal'],
      ['¿Dónde hemos estado?', '/sitios'], ['Fichar jornada', '/fichar'], ['Parte de trabajo', '/parte']] },
    { t: 'Flota', i: '🚐', items: [['Vehículos', '/vehiculos'], ['Llaves y herramientas', '/activos']] },
    { t: 'Documentos', i: '📄', items: [['Documentos para clientes', '/documentos'], ['Conversaciones WhatsApp', '/conversaciones']] },
    { t: 'Ajustes', i: '⚙️', items: [
      ['Usuarios', '/?tab=usuarios'], ['Familias', '/?tab=familias'], ['Emails', '/?tab=emails'], ['Alertas', '/?tab=alertas'], ['Actividad', '/?tab=actividad'],
      ['Copias de seguridad', '/copias'], ['Diagnóstico', '/diag']] },
  ];
  window.CP_MENU = MENU;
  const SIN_MENU = /^\/(fichar|compra|parte|login|acceso)(\/|$|\?|#)/;
  if (SIN_MENU.test(location.pathname + location.search) && location.pathname !== '/compras') return;
  if (location.pathname === '/' || location.pathname === '/index.html') return;     // el dashboard tiene su propio menú
  let tok = null; try { tok = localStorage.getItem('cp_token'); } catch (e) {}
  if (!tok) return;
  const actual = location.pathname + location.hash;
  const seccionActiva = MENU.find(s => s.items && s.items.some(([, h]) => h === actual || h === location.pathname));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const css = `
  .cpnav{position:sticky;top:0;z-index:2000;display:flex;align-items:center;gap:4px;height:48px;padding:0 12px;background:rgba(13,15,18,.92);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid rgba(255,255,255,.08);font-family:'Inter',-apple-system,'Segoe UI',sans-serif}
  body.light .cpnav{background:rgba(255,255,255,.92);border-bottom-color:rgba(0,0,0,.08)}
  .cpnav .lg{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,#4d9cf8,#22c487);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;color:#fff;text-decoration:none;margin-right:6px;flex-shrink:0}
  .cpnav .sc{position:relative}
  .cpnav .bt{background:none;border:0;color:var(--text2,#a0a8b3);font:inherit;font-size:13.5px;font-weight:600;padding:7px 10px;border-radius:9px;cursor:pointer;display:flex;align-items:center;gap:6px;text-decoration:none;white-space:nowrap}
  .cpnav .bt:hover,.cpnav .sc.on>.bt{color:var(--text,#eef0f2);background:rgba(255,255,255,.06)}
  body.light .cpnav .bt:hover,body.light .cpnav .sc.on>.bt{background:rgba(0,0,0,.05)}
  .cpnav .sc.act>.bt{color:var(--text,#eef0f2)}.cpnav .sc.act>.bt::after{content:'';position:absolute;left:12px;right:12px;bottom:-9px;height:2px;border-radius:2px;background:linear-gradient(90deg,#4d9cf8,#22c487)}
  .cpnav .dd{display:none;position:absolute;top:42px;left:0;min-width:230px;background:var(--bg2,#171b20);border:1px solid var(--border2,rgba(255,255,255,.12));border-radius:14px;padding:6px;box-shadow:0 18px 40px rgba(0,0,0,.35);animation:cpIn .14s ease}
  .cpnav .sc.on .dd{display:block}
  .cpnav .dd a{display:block;padding:9px 12px;border-radius:9px;color:var(--text,#eef0f2);text-decoration:none;font-size:14px}
  .cpnav .dd a:hover,.cpnav .dd a.act{background:rgba(77,156,248,.14)}
  .cpnav .sp{flex:1}.cpnav .hb{display:none;margin-left:auto}
  @keyframes cpIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
  @media(max-width:860px){.cpnav .sc,.cpnav .sp{display:none}.cpnav .hb{display:flex}
    .cpnav.abierto{height:auto;max-height:100vh;overflow:auto;flex-wrap:wrap;align-items:flex-start;padding:9px 12px 14px}
    .cpnav.abierto .lg{order:0}.cpnav.abierto .hb{order:1}
    .cpnav.abierto .sc{display:block;width:100%;order:2;border-top:1px solid rgba(255,255,255,.06)}
    body.light .cpnav.abierto .sc{border-top-color:rgba(0,0,0,.06)}
    .cpnav.abierto .sc>.bt{padding:12px 4px;font-size:15px;width:100%}
    .cpnav.abierto .sc .dd{display:none;position:static;box-shadow:none;border:0;background:none;padding:0 0 8px 30px;animation:none}
    .cpnav.abierto .sc.on .dd{display:block}.cpnav.abierto .sc .dd a{padding:10px 8px;font-size:15px}
    .cpnav .sc.act>.bt::after{display:none}}
  .header{top:48px!important}
  .header .hbtn[href="/"],.header a.hbtn[href="/"],a.hbtn[href="/"]{display:none!important}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  const nav = document.createElement('nav'); nav.className = 'cpnav'; nav.setAttribute('aria-label', 'Menú');
  nav.innerHTML = `<a class="lg" href="/" title="Inicio">CP</a>` + MENU.map((s, k) => s.href
    ? `<div class="sc"><a class="bt" href="${s.href}"><span>${s.i}</span>${esc(s.t)}</a></div>`
    : `<div class="sc${s === seccionActiva ? ' act' : ''}" data-k="${k}"><button class="bt" type="button"><span>${s.i}</span>${esc(s.t)} <span style="font-size:10px;opacity:.6">▾</span></button><div class="dd">${s.items.map(([t, h]) => `<a href="${h}"${h === actual || h === location.pathname ? ' class="act"' : ''}>${esc(t)}</a>`).join('')}</div></div>`).join('') +
    `<span class="sp"></span><button class="bt hb" type="button" aria-label="Abrir menú">☰ Menú</button>`;
  document.body.insertBefore(nav, document.body.firstChild);
  const cerrar = () => nav.querySelectorAll('.sc.on').forEach(x => x.classList.remove('on'));
  nav.querySelectorAll('.sc[data-k] > .bt').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); const sc = b.parentElement; const on = sc.classList.contains('on'); cerrar(); if (!on) sc.classList.add('on'); }));
  nav.querySelector('.hb').addEventListener('click', () => { nav.classList.toggle('abierto'); nav.querySelector('.hb').textContent = nav.classList.contains('abierto') ? '✕ Cerrar' : '☰ Menú'; if (seccionActiva && nav.classList.contains('abierto')) { const k = MENU.indexOf(seccionActiva); const sc = nav.querySelector(`.sc[data-k="${k}"]`); if (sc) sc.classList.add('on'); } });
  document.addEventListener('click', e => { if (!nav.contains(e.target)) cerrar(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { cerrar(); nav.classList.remove('abierto'); } });
})();
