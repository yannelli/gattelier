'use strict';

var NanoAPIUI = (() => {
  let panel;

  function mount(container) {
    if (!container || panel) return;
    panel = container;
    panel.classList.add('settings-card', 'api-settings');
    panel.innerHTML = `
      <div class="panel-heading"><div><h2>Board connection</h2><p>Connect through USB or your local network</p></div><span class="badge" data-api-state></span></div>
      <fieldset class="api-transport"><legend>Connection method</legend>
        <label><input type="radio" name="board-transport" value="serial"> USB</label>
        <label><input type="radio" name="board-transport" value="http"> HTTP / HTTPS</label>
      </fieldset>
      <section class="api-usb" aria-labelledby="api-usb-title">
        <h3 id="api-usb-title">USB connection</h3>
        <p>In desktop Chrome, choose the NanoC6 when the USB permission window opens. Board data travels directly over USB and is not sent to Cloudflare.</p>
        <label class="api-wifi-toggle"><input data-api-wifi-off type="checkbox" checked> Pause Wi-Fi while USB is connected</label>
        <div class="api-actions"><button class="button primary" data-api-usb-connect type="button">Connect USB</button><button class="button quiet" data-api-usb-disconnect type="button">Disconnect USB</button></div>
        <p class="hint">Wi-Fi resumes when you disconnect here. After an interrupted USB session, the board restores Wi-Fi when it detects the disconnect or its 90-second lease expires. USB workbench mode is separate from H4 HCI mode.</p>
      </section>
      <section aria-labelledby="api-network-title"><h3 id="api-network-title" class="api-section-title">Network connection</h3>
        <form class="api-form" data-api-form novalidate><label>Board API origin<input data-api-origin type="url" inputmode="url" autocomplete="url" spellcheck="false" placeholder="http://nanoscope.local"></label>
          <div class="api-actions"><button class="button primary" type="submit">Save and check</button><button class="button quiet" data-api-check type="button">Check connection</button><button class="button quiet" data-api-clear type="button">Clear endpoint</button></div>
        </form>
        <p class="hint api-network-hint">Select HTTP / HTTPS to use this endpoint. Chrome 142+ supports local HTTP connections after you allow local-network access. Browsers without this support need the HTTPS bridge below.</p>
        <details class="api-help"><summary>Set up a private HTTPS bridge</summary><p>Run the bridge on a computer that can reach the NanoC6. Allow this app origin, then enter the bridge HTTPS origin above.</p><pre><code data-api-command></code></pre><p>The hosted app stores the bridge address in this browser. Board commands and credentials go straight to your private bridge.</p></details>
      </section>
      <p class="api-message" data-api-message role="status" aria-live="polite"></p>`;
    const input = panel.querySelector('[data-api-origin]');
    const message = panel.querySelector('[data-api-message]');
    const state = panel.querySelector('[data-api-state]');
    const connect = panel.querySelector('[data-api-usb-connect]');
    const disconnect = panel.querySelector('[data-api-usb-disconnect]');
    const wifiOff = panel.querySelector('[data-api-wifi-off]');
    const appOrigin = globalThis.location?.origin || 'https://your-app.example';
    panel.querySelector('[data-api-command]').textContent = `NANOSCOPE_ALLOWED_ORIGIN=${appOrigin} NANOSCOPE_BOARD_URL=http://nanoscope.local scripts/start-pwa.sh --serve`;
    let wifiChanging = false, checkGeneration = 0;

    function render(text = '') {
      const origin = NanoAPI.origin(), usb = NanoAPI.transport() === 'serial', status = NanoAPI.serialStatus();
      if (globalThis.document.activeElement !== input) input.value = origin || '';
      for (const radio of panel.querySelectorAll('[name="board-transport"]')) radio.checked = radio.value === NanoAPI.transport();
      for (const control of panel.querySelectorAll('[data-api-form] button')) control.disabled = usb;
      connect.disabled = !status.supported || !status.secure || status.state !== 'disconnected';
      disconnect.disabled = status.state !== 'connected';
      wifiOff.disabled = wifiChanging || ['connecting', 'closing'].includes(status.state);
      if (status.connected) wifiOff.checked = status.wifiSuspended;
      state.textContent = usb ? ({ connected: 'USB connected', connecting: 'Connecting USB', closing: 'Disconnecting USB', disconnected: 'USB offline' }[status.state]) : origin ? 'Endpoint saved' : 'Setup required';
      state.classList.toggle('online', usb && status.connected);
      const usbText = !status.secure ? 'USB requires HTTPS or localhost.' : !status.supported ? 'Web Serial is unavailable. Open this app in desktop Chrome.' : status.error || (status.connected ? `USB connected. Wi-Fi is ${status.wifiSuspended ? 'paused' : 'enabled'}.` : 'Click Connect USB and select the NanoC6.');
      message.textContent = text || (usb ? usbText : origin ? `Live tools use ${origin}.` : 'Enter the board HTTP address or a private HTTPS bridge.');
    }

    async function check() {
      if (NanoAPI.transport() !== 'http' || !NanoAPI.configured()) return;
      const token = ++checkGeneration;
      state.textContent = 'Checking'; message.textContent = 'Contacting the board. Allow local-network access if your browser asks.';
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await NanoAPI.fetch('/api/state', { signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || `Connection failed (${response.status}).`);
        if (!body?.ble || !body?.wifi) throw new Error('The endpoint did not return Gattelier board status.');
        if (token !== checkGeneration) return;
        state.textContent = 'Board connected'; state.classList.add('online');
        message.textContent = `Connected through ${NanoAPI.origin()}.`;
      } catch (error) {
        if (token !== checkGeneration) return;
        state.textContent = 'Connection failed'; state.classList.remove('online');
        message.textContent = error.name === 'AbortError' ? 'The connection check timed out or the endpoint changed.' : error instanceof TypeError && NanoAPI.origin().startsWith('http:') ? 'Could not reach the local board. Check local-network permission, Wi-Fi, and the allowed hosted app origin on the board. If this browser blocks local HTTP, use the HTTPS bridge.' : error.message;
      } finally { clearTimeout(timer); }
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
      wifiChanging = true; render();
      try { await NanoAPI.setSerialWifiOff(value); }
      catch (error) { message.textContent = error.message; }
      finally { wifiChanging = false; render(); }
    });
    panel.querySelector('[data-api-form]').addEventListener('submit', event => {
      event.preventDefault();
      try { NanoAPI.setOrigin(input.value); render('Endpoint saved in this browser. Checking the board...'); check(); }
      catch (error) { render(error.message); }
    });
    panel.querySelector('[data-api-check]').addEventListener('click', check);
    panel.querySelector('[data-api-clear]').addEventListener('click', () => {
      NanoAPI.clearOrigin();
      render(NanoAPI.configured() ? 'Using the app origin for the local board connection.' : 'Board endpoint cleared. Live tools are offline.');
    });
    globalThis.addEventListener('nanoscope:api-change', () => { checkGeneration++; render(); });
    globalThis.addEventListener('nanoscope:serial', () => render());
    NanoAccessUI.mount(panel);
    render();
  }

  return { mount };
})();
globalThis.NanoAPIUI = NanoAPIUI;
if (typeof module !== 'undefined') module.exports = NanoAPIUI;
