// modules/hoy.js — «Hoy en obra»: quién está fichado ahora, dónde, quién falta y quién está ausente.
// Se pinta en la portada del dashboard (para todos los roles) y se refresca solo.
(function(CP) {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hm = m => { m = Math.max(0, Math.round(m || 0)); return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0'); };
  const hora = ts => ts ? new Date(ts).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : '';
  const AUS = { vacaciones: '🏖️ vacaciones', baja: '🤒 baja', baja_medica: '🤒 baja médica', permiso: '📄 permiso', festivo: '🎉 festivo', ausencia: '⛔ ausencia' };
  let _timer = null;

  async function render(containerId) {
    const el = document.getElementById(containerId); if (!el) return;
    const tok = localStorage.getItem('cp_token');
    let d;
    try { const r = await fetch('/api/fichaje/hoy', { headers: { 'Authorization': 'Bearer ' + tok } }); if (!r.ok) throw new Error(); d = await r.json(); }
    catch (e) { el.innerHTML = ''; return; }
    const dentro = d.trabajadores.filter(t => t.estado === 'dentro'), pausa = d.trabajadores.filter(t => t.estado === 'pausa'), fuera = d.trabajadores.filter(t => t.estado === 'fuera');
    const chip = (t, color, txt) => `<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:10px;background:var(--bg3);min-width:0">
        <span style="width:9px;height:9px;border-radius:50%;background:${color};flex-shrink:0"></span>
        <div style="min-width:0"><div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.userName || t.name)}</div><div style="font-size:11px;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${txt}</div></div></div>`;
    const ahora = new Date(); const hhmm = ahora.toTimeString().slice(0, 5);
    const bloques = [];
    if (dentro.length) bloques.push(`<div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin:8px 0 6px">Trabajando · ${dentro.length}</div><div class="hoy-grid">${dentro.map(t => chip(t, 'var(--green)', (t.obraRef ? '🏗️ ' + esc(t.obraRef) : 'sin obra') + (t.desde ? ' · desde ' + hora(t.desde) : '') + ' · ' + hm(t.minutos) + (t.lejos ? ' · 📍 lejos' : ''))).join('')}</div>`);
    if (pausa.length) bloques.push(`<div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin:8px 0 6px">En pausa · ${pausa.length}</div><div class="hoy-grid">${pausa.map(t => chip(t, 'var(--amber)', (t.obraRef ? '🏗️ ' + esc(t.obraRef) + ' · ' : '') + hm(t.minutos) + ' hechas')).join('')}</div>`);
    if (fuera.length) bloques.push(`<div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin:8px 0 6px">Jornada terminada · ${fuera.length}</div><div class="hoy-grid">${fuera.map(t => chip(t, 'var(--text3)', (t.obraRef ? '🏗️ ' + esc(t.obraRef) + ' · ' : '') + hm(t.minutos) + ' h')).join('')}</div>`);
    if (d.laborable && d.sinFichar.length) bloques.push(`<div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin:8px 0 6px">Sin fichar · ${d.sinFichar.length}</div><div class="hoy-grid">${d.sinFichar.map(t => chip(t, hhmm >= '09:00' ? 'var(--red)' : 'var(--text3)', hhmm >= '09:00' ? 'no ha fichado la entrada' : 'todavía no ha empezado')).join('')}</div>`);
    if (d.ausentes.length) bloques.push(`<div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin:8px 0 6px">Ausentes · ${d.ausentes.length}</div><div class="hoy-grid">${d.ausentes.map(t => chip(t, 'var(--text3)', AUS[t.estado] || esc(t.estado))).join('')}</div>`);
    const nada = !bloques.length;
    el.innerHTML = `<div class="card" style="margin-bottom:16px">
      <div class="card-title" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">🕐 Hoy en obra <span style="font-weight:400;color:var(--text3);font-size:11px">${ahora.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })}${d.laborable ? '' : ' · no laborable'} · ${dentro.length + pausa.length} en marcha</span>
        <span style="margin-left:auto;display:flex;gap:6px"><a class="btn bgh" style="padding:4px 10px;font-size:11px;text-decoration:none" href="/fichajes">Fichajes</a><a class="btn bgh" style="padding:4px 10px;font-size:11px;text-decoration:none" href="/gps">Mapa</a><a class="btn bgh" style="padding:4px 10px;font-size:11px;text-decoration:none" href="/sitios">¿Dónde hemos estado?</a></span></div>
      <style>.hoy-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px}</style>
      ${nada ? '<div style="font-size:13px;color:var(--text3)">Nadie ha fichado todavía hoy.</div>' : bloques.join('')}
    </div>`;
  }
  function auto(containerId) {
    render(containerId);
    if (_timer) clearInterval(_timer);
    _timer = setInterval(() => { if (!document.hidden && document.getElementById(containerId)) render(containerId); }, 120000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) render(containerId); });
  }
  CP.Hoy = { render, auto };
})(window.CP = window.CP || {});
