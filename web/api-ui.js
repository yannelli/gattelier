'use strict';

var NanoAPIUI = (() => {
  let panel;

  function mount(container) {
    if (!container || panel) return;
    panel = container;
    panel.classList.add('settings-card', 'api-settings');
    panel.innerHTML = `
      <div class="panel-heading"><div><h2>Board connection</h2></div><div class="heading-tools"><span class="badge" data-api-state></span><details class="help"><summary aria-label="About board connection"><span aria-hidden="true">?</span></summary><div class="help-body"><h3>USB</h3><p>Works in desktop Chrome. Choose the NanoC6 when Chrome asks for serial access. Board data goes straight over USB.</p><p>Wi-Fi resumes when you disconnect. After an interrupted session the board restores Wi-Fi on its own within 90 seconds. USB HCI mode in Board settings is a separate feature.</p><h3>Network</h3><p>Chrome 142 and later can reach the board over local HTTP after you allow local-network access. Other browsers need the HTTPS bridge.</p></div></details></div></div>
      <div class="settings-group api-method"><div class="segmented" role="radiogroup" aria-label="Connection method">
        <label><input type="radio" name="board-transport" value="serial"><span>USB</span></label>
        <label><input type="radio" name="board-transport" value="http"><span>Network</span></label>
      </div></div>
      <p class="api-message" data-api-message role="status" aria-live="polite"></p>
      <section class="api-usb" aria-label="USB connection">
        <label class="setting-row"><span><strong>Pause Wi-Fi while connected</strong></span><input data-api-wifi-off class="setting-switch" type="checkbox" role="switch" checked></label>
        <div class="settings-actions"><button class="button primary" data-api-usb-connect type="button">Connect USB</button><button class="button secondary" data-api-usb-disconnect type="button">Disconnect</button></div>
      </section>
      <section class="api-network" aria-label="Network connection">
        <form class="api-form" data-api-form novalidate><label>Board address<input data-api-origin type="url" inputmode="url" autocomplete="url" spellcheck="false" placeholder="http://nanoscope.local"></label>
          <div class="api-actions"><button class="button primary" type="submit">Save</button><button class="button secondary" data-api-check type="button">Test</button><button class="button quiet" data-api-clear type="button">Clear</button></div>
        </form>
        <details class="api-help"><summary>HTTPS bridge</summary><p>Run this on a computer that can reach the NanoC6, then enter the bridge's HTTPS address above.</p><pre><code data-api-command></code></pre></details>
      </section>`;
    const input = panel.querySelector('[data-api-origin]');
    const message = panel.querySelector('[data-api-message]');
    const state = panel.querySelector('[data-api-state]');
    const connect = panel.querySelector('[data-api-usb-connect]');
    const disconnect = panel.querySelector('[data-api-usb-disconnect]');
    const wifiOff = panel.querySelector('[data-api-wifi-off]');
    const appOrigin = globalThis.location?.origin || 'https://your-app.example';
    panel.querySelector('[data-api-command]').textContent = `NANOSCOPE_ALLOWED_ORIGIN=${appOrigin} NANOSCOPE_BOARD_URL=http://nanoscope.local scripts/start-pwa.sh --serve`;
    let wifiChanging = false, checkGeneration = 0, originDirty = false, checkController;
    function invalidateCheck() { checkGeneration++; checkController?.abort(); checkController = null; }

    function render(text = '', resetOrigin = false) {
      const origin = NanoAPI.origin(), usb = NanoAPI.transport() === 'serial', status = NanoAPI.serialStatus();
      if (resetOrigin) originDirty = false;
      if (!originDirty && (resetOrigin || globalThis.document.activeElement !== input)) input.value = origin || '';
      for (const radio of panel.querySelectorAll('[name="board-transport"]')) radio.checked = radio.value === NanoAPI.transport();
      panel.querySelector('.api-usb').hidden = !usb; panel.querySelector('.api-network').hidden = usb;
      connect.disabled = !status.supported || !status.secure || status.state !== 'disconnected';
      disconnect.hidden = status.state !== 'connected'; connect.hidden = !disconnect.hidden;
      wifiOff.disabled = wifiChanging || ['connecting', 'closing'].includes(status.state);
      if (status.connected) wifiOff.checked = status.wifiSuspended;
      state.textContent = usb ? ({ connected: 'Connected', connecting: 'Connecting', closing: 'Disconnecting', disconnected: '' }[status.state]) : originDirty ? 'Not saved' : origin ? 'Saved' : 'Not set up';
      state.classList.toggle('online', usb && status.connected);
      const usbText = !status.secure ? 'USB requires HTTPS or localhost.' : !status.supported ? 'Web Serial is unavailable. Open this app in desktop Chrome.' : status.error || (status.connected ? `Wi-Fi is ${status.wifiSuspended ? 'paused' : 'on'}.` : '');
      message.textContent = text || (usb ? usbText : '');
    }

    async function check() {
      if (NanoAPI.transport() !== 'http') return;
      invalidateCheck(); const token = checkGeneration;
      state.textContent = 'Testing'; state.classList.remove('online'); message.textContent = 'Allow local-network access if your browser asks.';
      const controller = checkController = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
      let target;
      try {
        const origin = NanoAPI.validateOrigin(input.value);
        target = new URL('/api/state', origin);
        const space = target.protocol === 'http:' ? NanoAPI.addressSpace(target.hostname) : '';
        const response = await fetch(target.href, { method: 'GET', credentials: 'omit', cache: 'no-store', signal: controller.signal, ...(space ? { targetAddressSpace: space } : {}) });
        let body;
        try { body = await response.json(); } catch (error) {
          if (error.name === 'AbortError') throw error;
          throw new Error(response.ok ? 'The endpoint did not return Gattelier board status.' : `Connection failed (${response.status}).`);
        }
        if (!response.ok) throw new Error(body?.error || `Connection failed (${response.status}).`);
        if (!body?.ble || !body?.wifi) throw new Error('The endpoint did not return Gattelier board status.');
        if (token !== checkGeneration) return;
        const saved = origin === NanoAPI.origin();
        state.textContent = saved ? 'Connected' : 'Test passed'; state.classList.add('online');
        message.textContent = saved ? `Connected to ${origin}.` : `Found Gattelier at ${origin}. Save to use this address.`;
      } catch (error) {
        if (token !== checkGeneration) return;
        state.textContent = 'Connection failed'; state.classList.remove('online');
        message.textContent = error.name === 'AbortError' ? 'The connection check timed out or the endpoint changed.' : error instanceof TypeError && target?.protocol === 'http:' ? 'Could not reach the board. Check local-network permission, Wi-Fi and the board\'s allowed app. If this browser blocks local HTTP, use the HTTPS bridge.' : error.message;
      } finally { clearTimeout(timer); if (checkController === controller) checkController = null; }
    }

    for (const radio of panel.querySelectorAll('[name="board-transport"]')) radio.addEventListener('change', () => NanoAPI.selectTransport(radio.value));
    connect.addEventListener('click', async () => {
      try { await NanoAPI.connectSerial({ wifiOff: wifiOff.checked }); }
      catch (error) { render(error.message); }
    });
    disconnect.addEventListener('click', async () => {
      try { await NanoAPI.disconnectSerial(); }
      catch (error) { render(error.message); }
    });
    wifiOff.addEventListener('change', async () => {
      if (!NanoAPI.serialStatus().connected) return;
      const value = wifiOff.checked;
      let errorMessage = '';
      wifiChanging = true; render();
      try { await NanoAPI.setSerialWifiOff(value); }
      catch (error) { errorMessage = error.message; }
      finally { wifiChanging = false; render(errorMessage); }
    });
    input.addEventListener('input', () => { invalidateCheck(); originDirty = true; render(); });
    panel.querySelector('[data-api-form]').addEventListener('submit', event => {
      event.preventDefault(); invalidateCheck();
      try { NanoAPI.setOrigin(input.value); render('Saved. Testing…', true); check(); }
      catch (error) { render(error.message); }
    });
    panel.querySelector('[data-api-check]').addEventListener('click', check);
    panel.querySelector('[data-api-clear]').addEventListener('click', () => {
      invalidateCheck(); NanoAPI.clearOrigin();
      render(NanoAPI.configured() ? 'Using this page\'s address.' : 'Address cleared.', true);
    });
    globalThis.addEventListener('nanoscope:api-change', () => { invalidateCheck(); render(); });
    globalThis.addEventListener('nanoscope:serial', () => render());
    NanoAccessUI.mount(panel);
    render();
  }

  return { mount };
})();
globalThis.NanoAPIUI = NanoAPIUI;
if (typeof module !== 'undefined') module.exports = NanoAPIUI;
