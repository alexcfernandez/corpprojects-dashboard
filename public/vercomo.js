// public/vercomo.js — «Ver como…» en las pantallas del trabajador (fichar, parte, compra). 3/11/2026.
// El dueño abre /fichar#vc=<token>&n=<nombre> desde Usuarios. En esta pestaña, y solo en ella:
//  · lo que la app guarda en localStorage (token, obra, cola sin red…) va aparte, en sessionStorage, así no se mezcla
//    con la sesión de fichar que pueda tener Álex en su móvil;
//  · todo lo que no sea leer se para aquí antes de salir (y el servidor también lo rechaza: src/verComo.js);
//  · una franja fija arriba recuerda que es «solo lectura» y deja salir.
// Tiene que cargarse ANTES que el resto de scripts de la página.
(function () {
  const PREF = 'vc:';
  let ss; try { ss = window.sessionStorage; } catch (e) { return; }
  const m = location.hash.match(/(?:^#|&)vc=(w_vc_[0-9a-f]+)(?:&n=([^&]*))?/);
  if (m) {
    try {
      Object.keys(ss).filter(k => k.startsWith(PREF)).forEach(k => ss.removeItem(k));
      ss.setItem('cpVC', m[1]); ss.setItem('cpVCN', decodeURIComponent(m[2] || '')); ss.setItem('cpVCHasta', String(Date.now() + 30 * 60 * 1000));
      ss.setItem(PREF + 'cpWT', m[1]); ss.setItem(PREF + 'cpWN', decodeURIComponent(m[2] || ''));
    } catch (e) {}
    history.replaceState(history.state, '', location.pathname + location.search);
  }
  const token = ss.getItem('cpVC');
  if (!token) return;
  window.CP_VER_COMO = true;

  // localStorage → sessionStorage con prefijo, salvo el tema (día/noche), que es del dispositivo.
  const real = { get: Storage.prototype.getItem, set: Storage.prototype.setItem, del: Storage.prototype.removeItem };
  const propio = k => k === 'cp_theme';
  Storage.prototype.getItem = function (k) { return this === localStorage && !propio(k) ? real.get.call(ss, PREF + k) : real.get.call(this, k); };
  Storage.prototype.setItem = function (k, v) { return this === localStorage && !propio(k) ? real.set.call(ss, PREF + k, v) : real.set.call(this, k, v); };
  Storage.prototype.removeItem = function (k) { return this === localStorage && !propio(k) ? real.del.call(ss, PREF + k) : real.del.call(this, k); };

  // Nada que guarde sale de aquí: respuesta 403 como la del servidor y un aviso.
  const fetchReal = window.fetch.bind(window);
  window.fetch = function (url, opt) {
    const metodo = String((opt && opt.method) || (url && url.method) || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(metodo)) {
      aviso();
      return Promise.resolve(new Response(JSON.stringify({ error: 'Estás en «ver como»: es solo para mirar, no se ha guardado nada.', soloLectura: true }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
    }
    return fetchReal(url, opt).then(r => {   // pase caducado (30 min): que se entienda en vez de pedir un PIN
      if (r.status === 401) { const q = document.getElementById('vc-quedan'); if (q) q.textContent = 'Se ha acabado el pase: sal y vuelve a entrar desde Usuarios'; }
      return r;
    });
  };

  function salir() {
    ['cpVC', 'cpVCN', 'cpVCHasta'].forEach(k => ss.removeItem(k));
    Object.keys(ss).filter(k => k.startsWith(PREF)).forEach(k => ss.removeItem(k));
    if (window.opener) { try { window.close(); } catch (e) {} }
    location.href = '/?tab=usuarios';
  }
  let tAviso = null;
  function aviso() {
    const t = document.getElementById('vc-aviso'); if (!t) return;
    t.style.display = 'block'; clearTimeout(tAviso); tAviso = setTimeout(() => { t.style.display = 'none'; }, 3500);
  }
  function franja() {
    if (document.getElementById('vc-franja')) return;
    const nombre = ss.getItem('cpVCN') || 'el trabajador';
    const st = document.createElement('style');
    st.textContent = `#vc-franja{position:fixed;top:0;left:0;right:0;z-index:99999;display:flex;align-items:center;gap:10px;padding:10px 14px calc(10px);padding-top:max(10px,env(safe-area-inset-top));background:#f59e0b;color:#1a1200;font:600 14px/1.3 Inter,-apple-system,'Segoe UI',sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25)}
#vc-franja .q{font-weight:400;opacity:.85;font-size:12.5px}#vc-franja button{margin-left:auto;min-height:36px;padding:0 14px;border-radius:10px;border:1.5px solid #1a1200;background:transparent;color:#1a1200;font:inherit;cursor:pointer}
body{padding-top:58px!important}
#vc-aviso{display:none;position:fixed;left:12px;right:12px;bottom:max(16px,env(safe-area-inset-bottom));z-index:99999;padding:14px 16px;border-radius:14px;background:#1a1200;color:#fff;font:500 14px/1.4 Inter,-apple-system,sans-serif;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.35)}`;
    document.head.appendChild(st);
    const f = document.createElement('div'); f.id = 'vc-franja'; f.setAttribute('role', 'status');
    f.innerHTML = `<span>👁</span><div><div>Viendo como ${nombre.replace(/[<>&"]/g, '')}</div><div class="q" id="vc-quedan">Solo lectura</div></div><button type="button">Salir</button>`;
    f.querySelector('button').addEventListener('click', salir);
    document.body.appendChild(f);
    const a = document.createElement('div'); a.id = 'vc-aviso'; a.textContent = '👁 Solo lectura: esto no se ha guardado. Así lo vería él al tocarlo.';
    document.body.appendChild(a);
    const quedan = () => {
      const min = Math.ceil((Number(ss.getItem('cpVCHasta')) - Date.now()) / 60000);
      const q = document.getElementById('vc-quedan'); if (!q) return;
      if (min <= 0) { q.textContent = 'Se ha acabado el tiempo: sal y vuelve a entrar desde Usuarios'; return; }
      q.textContent = `Solo lectura · quedan ${min} min`;
    };
    quedan(); setInterval(quedan, 30000);
  }
  if (document.body) franja(); else document.addEventListener('DOMContentLoaded', franja);
})();
