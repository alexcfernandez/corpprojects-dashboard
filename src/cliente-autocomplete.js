/* Autocompletador de clientes compartido (competencia, amidaments...).
   Uso: initClienteAutocomplete(inputEl, token)
   - Carga los nombres de /api/clients/list (una vez, cacheado).
   - Sugiere mientras escribes; al elegir, deja el nombre EXACTO de StelOrder. */
(function () {
  if (!document.getElementById('ac-styles')) {
    const s = document.createElement('style'); s.id = 'ac-styles';
    s.textContent = `
    .ac-wrap{position:relative}
    .ac-list{position:absolute;left:0;right:0;top:calc(100% + 4px);background:var(--bg3,#1a1e27);
      border:1px solid var(--border2,rgba(255,255,255,.15));border-radius:10px;max-height:230px;
      overflow-y:auto;z-index:50;box-shadow:0 10px 28px rgba(0,0,0,.45)}
    .ac-list.hide{display:none}
    .ac-item{padding:10px 12px;cursor:pointer;font-size:14px;border-bottom:1px solid var(--border,rgba(255,255,255,.06))}
    .ac-item:last-child{border-bottom:none}
    .ac-item.act,.ac-item:hover{background:var(--blue,#4d9cf8);color:#fff}
    .ac-empty{padding:10px 12px;color:var(--text2,#8b92a8);font-size:13px}`;
    document.head.appendChild(s);
  }
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  let cache = null, cargando = null;
  async function cargar(token) {
    if (cache) return cache;
    if (!cargando) cargando = fetch('/api/clients/list', { headers: { Authorization: 'Bearer ' + token } })
      .then(r => r.ok ? r.json() : []).then(j => { cache = Array.isArray(j) ? j : []; return cache; })
      .catch(() => { cache = []; return cache; });
    return cargando;
  }

  window.initClienteAutocomplete = function (input, token) {
    if (!input || input._acReady) return; input._acReady = true;
    const wrap = document.createElement('div'); wrap.className = 'ac-wrap';
    input.parentNode.insertBefore(wrap, input); wrap.appendChild(input);
    const list = document.createElement('div'); list.className = 'ac-list hide'; wrap.appendChild(list);
    let nombres = [], items = [], act = -1;
    cargar(token).then(n => { nombres = n || []; });

    function pintar(arr) {
      items = arr; act = -1;
      if (!arr.length) { list.innerHTML = '<div class="ac-empty">Sin coincidencias en StelOrder</div>'; list.classList.remove('hide'); return; }
      list.innerHTML = arr.map((n, i) => '<div class="ac-item" data-i="' + i + '">' + n.replace(/</g, '&lt;') + '</div>').join('');
      list.classList.remove('hide');
      list.querySelectorAll('.ac-item').forEach(el => {
        el.onmousedown = e => { e.preventDefault(); elegir(+el.dataset.i); };
      });
    }
    function elegir(i) { if (items[i] != null) { input.value = items[i]; } list.classList.add('hide'); }
    function filtrar() {
      const q = norm(input.value);
      if (!q) { list.classList.add('hide'); return; }
      pintar(nombres.filter(n => norm(n).includes(q)).slice(0, 8));
    }
    function marca() { list.querySelectorAll('.ac-item').forEach((el, i) => el.classList.toggle('act', i === act)); }

    input.addEventListener('input', filtrar);
    input.addEventListener('focus', () => { if (input.value) filtrar(); });
    input.addEventListener('blur', () => setTimeout(() => list.classList.add('hide'), 120));
    input.addEventListener('keydown', e => {
      if (list.classList.contains('hide') || !items.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); act = Math.min(act + 1, items.length - 1); marca(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); act = Math.max(act - 1, 0); marca(); }
      else if (e.key === 'Enter' && act >= 0) { e.preventDefault(); elegir(act); }
      else if (e.key === 'Escape') { list.classList.add('hide'); }
    });
  };
})();
