// push-client.js — Activar las notificaciones push de la PWA en ESTE dispositivo.
// Uso:  CPPush.estado()  →  'activo' | 'inactivo' | 'denegado' | 'ios-instalar' | 'no-soportado'
//       CPPush.activar(token)   (debe llamarse desde un toque del usuario)
//       CPPush.resync(token)    (silencioso: re-registra la suscripción existente)
(function () {
  const esIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  const soportado = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  function b64ToBytes(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }
  async function registro() {
    const reg = (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.register('/sw.js'));
    await navigator.serviceWorker.ready;
    return reg;
  }
  const hdr = token => ({ 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' });

  async function estado() {
    // En iPhone el push SOLO existe con la app añadida a la pantalla de inicio (iOS 16.4+).
    if (esIOS && !standalone()) return 'ios-instalar';
    if (!soportado()) return 'no-soportado';
    if (Notification.permission === 'denied') return 'denegado';
    if (Notification.permission !== 'granted') return 'inactivo';
    try { const sub = await (await registro()).pushManager.getSubscription(); return sub ? 'activo' : 'inactivo'; }
    catch (e) { return 'inactivo'; }
  }

  async function suscribir(token) {
    const reg = await registro();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const r = await fetch('/api/push/key'); const k = await r.json();
      if (!r.ok || !k.publicKey) throw new Error('No se pudo preparar el aviso');
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(k.publicKey) });
    }
    const r2 = await fetch('/api/push/subscribe', { method: 'POST', headers: hdr(token), body: JSON.stringify({ subscription: sub.toJSON() }) });
    if (!r2.ok) throw new Error((await r2.json().catch(() => ({}))).error || 'No se pudo guardar');
    return sub;
  }

  async function activar(token) {
    if (esIOS && !standalone()) throw new Error('En iPhone, añade primero la app a la pantalla de inicio');
    if (!soportado()) throw new Error('Este navegador no admite avisos');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('No has dado permiso para los avisos');
    const sub = await suscribir(token);
    // Aviso de prueba para que vea que funciona
    fetch('/api/push/test', { method: 'POST', headers: hdr(token), body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
    return true;
  }

  // Si ya dio permiso, re-asocia la suscripción a quien ha iniciado sesión (sin molestar).
  async function resync(token) {
    try { if (soportado() && Notification.permission === 'granted' && !(esIOS && !standalone())) await suscribir(token); } catch (e) {}
  }

  window.CPPush = { estado, activar, resync, esIOS, standalone };
})();
