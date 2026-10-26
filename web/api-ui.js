'use strict';

var NanoAPIUI = (() => {
  let panel;

  function mount(container) {
    if (!container || panel) return;
    panel = container;
    panel.classList.add('settings-card', 'api-settings');
    panel.innerHTML = '<div class="panel-heading"><div><h2>Board connection</h2><p>Connect directly over your local network</p></div><span class="badge" data-api-state></span></div><form class="api-form" data-api-form novalidate><label>Board API origin<input data-api-origin type="url" inputmode="url" autocomplete="url" spellcheck="false" placeholder="http://nanoscope.local"></label><div class="api-actions"><button class="button primary" type="submit">Save and check</button><button class="button quiet" data-api-check type="button">Check connection</button><button class="button quiet" data-api-clear type="button">Clear endpoint</button></div></form><p class="api-message" data-api-message role="status"></p><p class="hint">Chrome 142+ supports local HTTP connections after you allow local-network access. Use the board IP address or .local name. Browsers without this support need the HTTPS bridge below.</p><details class="api-help"><summary>Set up a private HTTPS bridge</summary><p>Run the bridge on a computer that can reach the NanoC6. Allow this app origin, then enter the bridge HTTPS origin above.</p><pre><code data-api-command></code></pre><p>The hosted app stores the bridge address in this browser. Board commands and credentials go straight to your private bridge. The hosted app does not receive them.</p></details>';
    const input = panel.querySelector('[data-api-origin]');
    const message = panel.querySelector('[data-api-message]');
    const state = panel.querySelector('[data-api-state]');
    const command = panel.querySelector('[data-api-command]');
    const appOrigin = globalThis.location?.origin || 'https://your-app.example';
    command.textContent = `NANOSCOPE_ALLOWED_ORIGIN=${appOrigin} NANOSCOPE_BOARD_URL=http://nanoscope.local scripts/start-pwa.sh --serve`;

    function render(text = '') {
      const origin = NanoAPI.origin();
      input.value = origin || '';
      state.textContent = origin ? 'Endpoint saved' : 'Setup required';
      state.classList.toggle('online', Boolean(origin));
      message.textContent = text || (origin ? `Live tools use ${origin}.` : 'Enter the board HTTP address or a private HTTPS bridge.');
    }

    async function check() {
      if (!NanoAPI.configured()) { render('Save a private board endpoint before checking the connection.'); return; }
      state.textContent = 'Checking'; message.textContent = 'Contacting the board. Allow local-network access if your browser asks.';
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await NanoAPI.fetch('/api/state', { signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || `Connection failed (${response.status}).`);
        if (!body?.ble || !body?.wifi) throw new Error('The endpoint did not return Gattelier board status.');
        state.textContent = 'Board connected'; state.classList.add('online');
        message.textContent = `Connected through ${NanoAPI.origin()}.`;
      } catch (error) {
        state.textContent = 'Connection failed'; state.classList.remove('online');
        message.textContent = error.name === 'AbortError' ? 'The connection check timed out or the endpoint changed.' : error instanceof TypeError && NanoAPI.origin().startsWith('http:') ? 'Could not reach the local board. Check local-network permission, Wi-Fi, and the allowed hosted app origin on the board. If this browser blocks local HTTP, use the HTTPS bridge.' : error.message;
      } finally { clearTimeout(timer); }
    }

    panel.querySelector('[data-api-form]').addEventListener('submit', event => {
      event.preventDefault();
      try { NanoAPI.setOrigin(input.value); render('Endpoint saved in this browser. Checking the board...'); check(); }
      catch (error) {
        message.textContent = error.message; state.textContent = NanoAPI.configured() ? 'Endpoint saved' : 'Setup required';
        state.classList.toggle('online', NanoAPI.configured());
      }
    });
    panel.querySelector('[data-api-check]').addEventListener('click', check);
    panel.querySelector('[data-api-clear]').addEventListener('click', () => {
      NanoAPI.clearOrigin();
      render(NanoAPI.configured() ? 'Using the app origin for the local board connection.' : 'Board endpoint cleared. Live tools are offline.');
    });
    globalThis.addEventListener('nanoscope:api-change', () => render());
    NanoAccessUI.mount(panel);
    render();
  }

  return { mount };
})();
globalThis.NanoAPIUI = NanoAPIUI;
if (typeof module !== 'undefined') module.exports = NanoAPIUI;
