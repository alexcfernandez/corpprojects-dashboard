// public/dialogo.js — Ventanas propias para pedir un dato o confirmar (en vez de prompt()/confirm()).
// El navegador puede bloquear sus cuadros sin avisar («no permitir más diálogos» en Brave/Chrome, o una
// app instalada en el móvil): el botón parecía no hacer nada. Estas siempre se ven.
//   const ok   = await CPDialog.confirmar('¿Terminar la jornada?', { ok: 'Terminar' });
//   const nota = await CPDialog.pedir('Motivo', { opciones: ['Foto repetida', 'No es una compra'] });  // null = cancelado
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function abrir(cuerpo, botones) {
    return new Promise(resolve => {
      const ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px';
      ov.innerHTML = `<div role="dialog" aria-modal="true" style="background:var(--bg2,#fff);color:var(--text,#111);border:1px solid var(--border2,#ddd);border-radius:16px;width:100%;max-width:440px;padding:18px;box-shadow:0 20px 50px rgba(0,0,0,.35);font-family:inherit">${cuerpo}<div class="cpd-bt" style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap"></div></div>`;
      const zona = ov.querySelector('.cpd-bt');
      const cerrar = v => { ov.remove(); document.removeEventListener('keydown', tecla); resolve(v); };
      botones.forEach(b => {
        const el = document.createElement('button');
        el.type = 'button'; el.textContent = b.texto;
        el.style.cssText = `padding:11px 16px;border-radius:10px;font:inherit;font-size:15px;font-weight:600;cursor:pointer;border:1px solid ${b.principal ? (b.peligro ? '#f05252' : '#4d9cf8') : 'var(--border2,#ccc)'};background:${b.principal ? (b.peligro ? '#f05252' : '#4d9cf8') : 'transparent'};color:${b.principal ? '#fff' : 'var(--text,#111)'}`;
        el.onclick = () => cerrar(b.valor());
        zona.appendChild(el);
      });
      const tecla = e => { if (e.key === 'Escape') cerrar(botones.find(b => !b.principal).valor()); if (e.key === 'Enter' && !(e.target && e.target.tagName === 'TEXTAREA')) { const p = botones.find(b => b.principal); if (p) cerrar(p.valor()); } };
      document.addEventListener('keydown', tecla);
      ov.addEventListener('click', e => { if (e.target === ov) cerrar(botones.find(b => !b.principal).valor()); });
      document.body.appendChild(ov);
      const inp = ov.querySelector('input,textarea'); if (inp) setTimeout(() => { inp.focus(); inp.select && inp.select(); }, 30);
      ov._cerrar = cerrar;
    });
  }
  window.CPDialog = {
    confirmar(texto, { ok = 'Sí', cancelar = 'Cancelar', peligro = false } = {}) {
      return abrir(`<div style="font-size:16px;line-height:1.5">${esc(texto)}</div>`,
        [{ texto: cancelar, valor: () => false }, { texto: ok, principal: true, peligro, valor: () => true }]);
    },
    // Devuelve el texto (puede ser '') o null si se cancela. opciones: botones rápidos que rellenan el campo.
    pedir(texto, { valor = '', placeholder = '', opciones = [], ok = 'Aceptar', obligatorio = false } = {}) {
      const p = abrir(`<div style="font-size:16px;line-height:1.5;margin-bottom:10px">${esc(texto)}</div>
        ${opciones.length ? `<div class="cpd-op" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">${opciones.map(o => `<button type="button" data-v="${esc(o)}" style="padding:7px 11px;border-radius:20px;border:1px solid var(--border2,#ccc);background:var(--bg3,#f3f4f6);color:var(--text,#111);font:inherit;font-size:13.5px;cursor:pointer">${esc(o)}</button>`).join('')}</div>` : ''}
        <input class="cpd-in" value="${esc(valor)}" placeholder="${esc(placeholder)}" style="width:100%;box-sizing:border-box;padding:11px 12px;border-radius:10px;border:1px solid var(--border2,#ccc);background:var(--bg3,#fff);color:var(--text,#111);font:inherit;font-size:15px">`,
        [{ texto: 'Cancelar', valor: () => null }, { texto: ok, principal: true, valor: () => { const v = document.querySelector('.cpd-in'); return v ? v.value : ''; } }]);
      setTimeout(() => {
        const box = document.querySelector('.cpd-in'); if (!box) return;
        document.querySelectorAll('.cpd-op button').forEach(b => { b.onclick = () => { box.value = b.dataset.v; box.focus(); }; });
      }, 0);
      return obligatorio ? p.then(v => (v !== null && !String(v).trim() ? CPDialog.pedir(texto, { valor, placeholder, opciones, ok, obligatorio }) : v)) : p;
    },
  };
})();
