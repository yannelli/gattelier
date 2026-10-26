var NanoPWA = (() => {
  let panel, registration, retry = () => {}, failures = 0, boardOnline = false;
  let status = 'Checking offline support', message = '', updating = false, installPrompt;
  const secure = () => globalThis.isSecureContext && 'serviceWorker' in navigator;
  const installed = () => globalThis.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone;
  const pollDelay = ({ background = false } = {}) => document.hidden
    ? background ? 30000 : null : Math.min(30000, 1500 * 2 ** Math.min(failures, 5));
  function render() {
    if (!panel) return;
    panel.querySelector('[data-pwa-status]').textContent = status;
    panel.querySelector('[data-pwa-connection]').textContent = boardOnline ? 'Board connected' : 'Waiting for board';
    panel.querySelector('[data-pwa-connection]').classList.toggle('online', boardOnline);
    panel.querySelector('[data-pwa-detail]').textContent = message || (boardOnline
      ? 'Device history and app settings stay in this browser.'
      : 'Saved history remains available. Live tools reconnect when this app can reach the board.');
    const update = panel.querySelector('[data-pwa-update]');
    update.disabled = !registration || updating;
    update.textContent = updating ? 'Updating...' : registration?.waiting ? 'Install update' : 'Refresh app cache';
    panel.querySelector('[data-pwa-install]').hidden = !installPrompt || installed();
    panel.querySelector('[data-pwa-instructions]').textContent = installed() ? 'Opened as an installed app.'
      : secure() ? 'On iPhone: Share > Add to Home Screen. Open this HTTPS address once before using the app offline.'
        : 'Offline launch requires HTTPS. Open NanoScope from an HTTPS address before installing it.';
  }
  function reportConnection(connected) {
    boardOnline = Boolean(connected);
    failures = connected ? 0 : Math.min(failures + 1, 5);
    render();
  }
  function sendRefresh(worker) {
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => { channel.port1.close(); reject(new Error('App refresh timed out. The saved app is still available.')); }, 45000);
      channel.port1.onmessage = ({ data }) => {
        clearTimeout(timeout); channel.port1.close();
        data.ok ? resolve() : reject(new Error(data.error || 'App refresh failed.'));
      };
      worker.postMessage({ type: 'REFRESH_SHELL' }, [channel.port2]);
    });
  }
  async function refresh() {
    if (!registration || updating) return;
    updating = true; message = 'Downloading the current app. Saved devices and credentials are preserved.'; render();
    try {
      await registration.update();
      if (registration.installing) await new Promise((resolve, reject) => {
        const worker = registration.installing;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' || worker.state === 'activated') resolve();
          if (worker.state === 'redundant') reject(new Error('The app update could not be installed.'));
        });
      });
      if (registration.waiting) {
        navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      } else {
        const worker = registration.active;
        if (!worker) throw new Error('The offline app is still installing. Try again shortly.');
        await sendRefresh(worker); location.reload();
      }
    } catch (error) { message = error.message; updating = false; render(); }
  }
  async function mount(container, hooks = {}) {
    if (!container || panel) return;
    panel = container; retry = hooks.retry || retry;
    panel.classList.add('settings-card', 'pwa-settings');
    panel.innerHTML = '<div class="panel-heading"><div><h2>Offline app</h2><p data-pwa-status role="status"></p></div><span class="badge" data-pwa-connection></span></div><div class="pwa-body"><p data-pwa-detail></p><p class="pwa-instructions" data-pwa-instructions></p><div class="pwa-actions"><button class="button secondary" data-pwa-update type="button">Refresh app cache</button><button class="button quiet" data-pwa-retry type="button">Retry connection</button><button class="button primary" data-pwa-install type="button" hidden>Install app</button></div></div>';
    panel.querySelector('[data-pwa-update]').addEventListener('click', refresh);
    panel.querySelector('[data-pwa-retry]').addEventListener('click', () => { failures = 0; retry(); });
    panel.querySelector('[data-pwa-install]').addEventListener('click', async () => { await installPrompt?.prompt(); installPrompt = null; render(); });
    globalThis.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; render(); });
    globalThis.addEventListener('appinstalled', render);
    globalThis.addEventListener('online', () => { failures = 0; retry(); });
    if (!secure()) { status = 'HTTPS required for offline launch'; render(); return; }
    try {
      registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
      const ready = () => { status = registration.waiting ? 'App update ready' : 'App saved for offline launch'; render(); };
      registration.addEventListener('updatefound', () => {
        registration.installing?.addEventListener('statechange', () => {
          if (registration.waiting || registration.active) ready();
        });
      });
      if (registration.active) ready();
      else { status = 'Saving app for offline launch'; navigator.serviceWorker.ready.then(ready); }
    } catch (error) { status = 'Offline setup unavailable'; message = error.message; }
    render();
  }
  return { mount, reportConnection, pollDelay, refresh };
})();
if (typeof module !== 'undefined') module.exports = NanoPWA;
