var NanoPWA = (() => {
  let panel, registration, retry = () => {}, failures = 0;
  let status = 'Checking offline support', message = '', updating = false, installPrompt;
  const secure = () => globalThis.isSecureContext && 'serviceWorker' in navigator;
  const installed = () => globalThis.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone;
  const pollDelay = ({ background = false } = {}) => document.hidden
    ? background ? 30000 : null : Math.min(30000, 1500 * 2 ** Math.min(failures, 5));
  function render() {
    if (!panel) return;
    panel.querySelector('[data-pwa-status]').textContent = status;
    panel.querySelector('[data-pwa-detail]').textContent = message;
    const update = panel.querySelector('[data-pwa-update]');
    const preparing = !registration?.active && registration?.installing?.state === 'installing';
    update.disabled = !secure() || updating || preparing;
    update.textContent = preparing ? 'Saving…' : updating ? registration ? 'Updating…' : 'Setting up…' : registration?.waiting ? 'Install update' : secure() && (!registration || status === 'Offline setup unavailable') ? 'Retry offline setup' : 'Check for updates';
    panel.querySelector('[data-pwa-install]').hidden = !installPrompt || installed();
  }
  function reportConnection(connected) {
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
  function setupFailed() { status = 'Offline setup unavailable'; message = 'Could not save the app for offline use. Check your connection and retry.'; }
  async function setup() {
    status = 'Saving for offline use…'; message = ''; render();
    try {
      registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
      const ready = () => { status = registration.waiting ? 'Update ready' : installed() ? 'Installed · available offline' : 'Available offline'; message = ''; render(); };
      const watch = () => {
        const worker = registration.installing;
        if (!worker) return;
        const changed = () => {
          if (registration.waiting || registration.active) ready();
          else if (worker.state === 'redundant') { setupFailed(); render(); }
        };
        worker.addEventListener('statechange', changed); changed();
      };
      registration.addEventListener('updatefound', watch); watch();
      if (registration.active) ready();
      else navigator.serviceWorker.ready.then(ready);
    } catch { setupFailed(); }
  }
  async function refresh() {
    if (!secure() || updating || !registration?.active && registration?.installing?.state === 'installing') return;
    updating = true; message = ''; render();
    try {
      if (!registration?.active && !registration?.waiting) { await setup(); updating = false; render(); return; }
      if (!registration.waiting) await registration.update();
      if (!registration.waiting && registration.installing) await new Promise((resolve, reject) => {
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
    } catch (error) {
      if (!registration?.active && !registration?.waiting) setupFailed(); else message = error.message;
      updating = false; render();
    }
  }
  async function mount(container, hooks = {}) {
    if (!container || panel) return;
    panel = container; retry = hooks.retry || retry;
    panel.classList.add('settings-card', 'pwa-settings');
    panel.innerHTML = '<div class="panel-heading"><div><h2>Offline app</h2><p data-pwa-status role="status"></p></div><details class="help"><summary aria-label="About the offline app"><span aria-hidden="true">?</span></summary><div class="help-body"><p>Install Gattelier to open it without a connection. Saved history, settings and credentials are kept when the app updates.</p><p>On iPhone, tap Share, then Add to Home Screen. Offline launch needs an HTTPS address; open it once while online first.</p></div></details></div><div class="pwa-body"><div class="pwa-actions"><button class="button primary" data-pwa-install type="button" hidden>Install app</button><button class="button secondary" data-pwa-update type="button">Check for updates</button></div><p data-pwa-detail role="status"></p></div>';
    panel.querySelector('[data-pwa-update]').addEventListener('click', refresh);
    panel.querySelector('[data-pwa-install]').addEventListener('click', async () => { await installPrompt?.prompt(); installPrompt = null; render(); });
    globalThis.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; render(); });
    globalThis.addEventListener('appinstalled', render);
    globalThis.addEventListener('online', () => { failures = 0; retry(); });
    if (!secure()) { status = 'Needs HTTPS for offline use'; render(); return; }
    updating = true; render();
    await setup();
    updating = false; render();
  }
  return { mount, reportConnection, pollDelay, refresh };
})();
if (typeof module !== 'undefined') module.exports = NanoPWA;
