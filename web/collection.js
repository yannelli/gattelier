'use strict';

const NanoCollection = (() => {
  function configuration(value) {
    if (!value || typeof value.enabled !== 'boolean' || typeof value.active !== 'boolean') throw new Error('Choose a collection mode.');
    for (const key of ['intervalMs', 'windowMs', 'periodMs', 'burstMs']) if (!Number.isSafeInteger(value[key])) throw new Error('Timing values must be whole milliseconds.');
    if (value.intervalMs < 10 || value.intervalMs > 10240) throw new Error('Scan interval must be 10 to 10240 ms.');
    if (value.windowMs < 5 || value.windowMs > value.intervalMs) throw new Error('Scan window must be 5 ms through the interval.');
    if (value.burstMs < 1000 || value.burstMs > 600000) throw new Error('Burst duration must be 1 to 600 seconds.');
    if (value.periodMs !== 0 && (value.periodMs < 1000 || value.periodMs > 3600000 || value.burstMs > value.periodMs)) throw new Error('Burst period must be 1 to 3600 seconds and at least the duration.');
    if (typeof value.address !== 'string' || value.address && (value.address.length !== 17 || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value.address))) throw new Error('Enter a full Bluetooth address or leave it blank.');
    return { enabled: value.enabled, active: value.active, intervalMs: value.intervalMs, windowMs: value.windowMs, periodMs: value.periodMs, burstMs: value.burstMs, address: value.address.toLowerCase() };
  }
  function setupCheck(root, { online = true, dirty = false } = {}) {
    if (!online) throw new Error('The board is unavailable. Reconnect before verifying setup.');
    if (dirty) throw new Error('Apply the edited settings before verifying setup.');
    if (root?.usb?.mode !== 'workbench') throw new Error(root?.usb?.mode === 'hci' ? 'USB controller mode is active. Return to workbench mode to verify collection.' : 'The board did not report its USB mode. Refresh and try again.');
    const value = root.collection, config = configuration(value);
    if (!value.storageReady || value.full || value.damaged) throw new Error(value.error || 'Initialize or clear collection storage before verifying setup.');
    if (value.configError || value.error) throw new Error(value.configError || value.error);
    if (!value.persistenceReady || !value.configSaved) throw new Error('Apply settings to save the collection setup before verifying it.');
    const message = !config.enabled ? 'Setup verified and saved. Collection is stopped.' : value.status === 'paused-connected' ? 'Setup verified and saved. Collection is paused while a device is connected.'
      : value.status === 'paused-busy' ? 'Setup verified and saved. Collection is paused during a BLE command.' : value.status === 'scheduled' ? 'Setup verified and saved. Waiting for the next scheduled burst.' : 'Setup verified and saved. Collection is enabled.';
    return { observe: config.enabled && value.status === 'collecting', message };
  }
  function captureCheck(before, after) {
    setupCheck(after);
    if (before.collection.bootId !== after.collection.bootId) throw new Error('The board restarted during verification. Verify setup again.');
    const count = after.collection.recordCount - before.collection.recordCount;
    return count > 0 ? `Setup verified. ${count} new record${count === 1 ? '' : 's'} saved during the check.` : 'Setup is saved and storage is ready, but no new records arrived in 2.5 seconds. Check the address filter or wait for advertisements.';
  }
  function mount(container, lab) {
    if (!container) return;
    let state = null, root = {}, online = false, pending = false, dirty = false, reading = false, verifying = false, lastRefresh = 0, lastStateError = '', generation = 0;
    const get = id => container.querySelector(`#collection-${id}`);
    container.innerHTML = '<div class="panel-heading"><div><h2>Onboard collection</h2></div><div class="heading-tools"><button id="collection-refresh" class="button quiet" type="button">Refresh</button><details class="help"><summary aria-label="About collection"><span aria-hidden="true">?</span></summary><div class="help-body"><p>The board saves sampled advertisement snapshots (address, signal, name, services and raw payload) to onboard flash. It keeps collecting with the browser closed.</p><p>A sweep starts every second. Collection pauses during a BLE connection or command. Settings and the on/off state survive restarts.</p><p>The log holds up to 512 KiB. Collection stops when it is full.</p><p>Hold the board button for 3 seconds to start or stop. The status light adds a teal double pulse while collecting.</p><p>Verify checks the board, saved settings and storage, then watches 2.5 seconds for new records.</p></div></details></div></div><div class="collection-body"><dl class="collection-facts"><div><dt>Status</dt><dd id="collection-state">Checking…</dd></div><div><dt>Records</dt><dd id="collection-count">0</dd></div><div><dt>Storage</dt><dd id="collection-storage">Checking…</dd></div><div><dt>Resumes after restart</dt><dd id="collection-saved">Checking…</dd></div></dl><div class="collection-usage"><progress id="collection-capacity" max="524288" value="0" aria-label="Collection storage used"></progress><span id="collection-usage"></span></div><p id="collection-errors" class="error" role="status"></p><form id="collection-form" class="collection-form" novalidate><label>Scan mode<select id="collection-mode"><option value="passive">Passive</option><option value="active">Active (request scan responses)</option></select></label><label>Device<span class="collection-address"><input id="collection-address" type="text" maxlength="17" placeholder="All devices" aria-label="Device address" autocomplete="off" spellcheck="false"><button id="collection-use-selected" class="button quiet" type="button">Use selected</button></span></label><details class="collection-timing"><summary>Timing</summary><div class="collection-timing-grid"><label>Scan interval (ms)<input id="collection-interval" type="number" min="10" max="10240" step="1" value="160" required></label><label>Scan window (ms)<input id="collection-window" type="number" min="5" max="10240" step="1" value="80" required></label><label>Burst every (s, 0 = continuous)<input id="collection-period" type="number" min="0" max="3600" step="1" value="0" required></label><label>Burst length (s)<input id="collection-duration" type="number" min="1" max="600" step="1" value="10" required></label></div></details><div class="collection-actions"><button id="collection-start" class="button primary" type="button">Start collection</button><button id="collection-stop" class="button secondary" type="button">Stop collection</button><button id="collection-apply" class="button secondary" type="submit">Apply changes</button></div></form><div id="collection-init-area" class="collection-storage-action" hidden><h3>Storage needs setup</h3><p>Initializing erases the onboard SPIFFS partition. Wi-Fi settings and firmware are kept.</p><label class="collection-check"><input id="collection-init-confirm" type="checkbox">Erase the SPIFFS partition</label><button id="collection-init" class="button secondary" type="button">Initialize storage</button></div><div class="collection-actions collection-log"><a id="collection-export" class="button secondary" href="/api/collection/export" download="nanoscope-collection.ndjson">Download log</a><button id="collection-verify" class="button quiet" type="button">Verify setup</button><details class="collection-clear"><summary>Clear log</summary><label class="collection-check"><input id="collection-clear-confirm" type="checkbox">Delete the saved log</label><button id="collection-clear" class="button destructive" type="button">Clear log</button></details></div><p id="collection-verification" role="status"></p><p id="collection-message" role="status"></p></div>';
    function message(text, error = false) { get('message').textContent = text; get('message').classList.toggle('error', error); }
    function sync() {
      const unavailable = pending || verifying || !online || !state, hci = root.usb?.mode === 'hci';
      for (const id of ['apply', 'mode', 'interval', 'window', 'period', 'duration', 'address', 'use-selected']) get(id).disabled = unavailable || hci;
      get('start').disabled = unavailable || hci || state?.enabled || !state?.storageReady || !state?.persistenceReady || state?.full || state?.damaged;
      get('stop').disabled = unavailable || !state?.enabled;
      get('start').hidden = Boolean(state?.enabled); get('stop').hidden = !state?.enabled; get('apply').hidden = !dirty;
      get('init').disabled = unavailable || state?.storageReady || !get('init-confirm').checked;
      get('clear').disabled = unavailable || state?.enabled || !state?.storageReady || !get('clear-confirm').checked;
      get('refresh').disabled = pending || reading || verifying; get('verify').disabled = unavailable || reading;
      const canExport = online && state?.bytes > 0;
      get('export').setAttribute('aria-disabled', String(!canExport)); get('export').tabIndex = canExport ? 0 : -1;
      if (!state) {
        get('state').textContent = online ? 'Checking…' : 'Board unavailable';
        get('count').textContent = '0'; get('storage').textContent = get('saved').textContent = 'Checking…';
        get('errors').textContent = get('usage').textContent = '';
        get('capacity').value = 0; get('capacity').max = 524288; get('init-area').hidden = true;
        return;
      }
      const labels = { stopped: 'Stopped', collecting: state.active ? 'Active scan' : 'Passive scan', scheduled: 'Waiting for next burst', 'paused-connected': 'Paused: device connected', 'paused-busy': 'Paused: BLE command', starting: 'Starting scan' };
      get('state').textContent = online ? labels[state.status] || state.status : 'Board unavailable';
      get('storage').textContent = !state.storageReady ? 'Needs setup' : state.damaged ? 'Incomplete log: download and clear' : state.full ? 'Full: download and clear' : 'Ready';
      get('count').textContent = Number(state.recordCount || 0).toLocaleString();
      get('saved').textContent = state.configSaved ? state.savedEnabled ? 'Yes' : 'No' : state.persistenceReady ? 'Not saved yet' : 'Unavailable';
      get('errors').textContent = state.dropped || state.writeErrors ? `${state.dropped || 0} dropped · ${state.writeErrors || 0} write errors · ${state.queued || 0} queued` : '';
      get('capacity').value = state.bytes || 0; get('capacity').max = state.limitBytes || 524288;
      get('usage').textContent = `${Math.ceil((state.bytes || 0) / 1024)} of ${Math.floor((state.limitBytes || 524288) / 1024)} KiB`;
      get('init-area').hidden = state.storageReady;
      const stateError = state.configError || state.error || '';
      if (stateError) message(stateError, true);
      else if (lastStateError && get('message').textContent === lastStateError) message('');
      lastStateError = stateError;
      if (!dirty) {
        get('mode').value = state.active ? 'active' : 'passive'; get('interval').value = state.intervalMs; get('window').value = state.windowMs;
        get('period').value = state.periodMs / 1000; get('duration').value = state.burstMs / 1000; get('address').value = state.address || '';
      }
    }
    function assertCurrent(token) {
      if (token !== generation) throw Object.assign(new Error('Board connection changed.'), { name: 'AbortError' });
    }
    async function request(path, body, wholeState = false, token = generation) {
      assertCurrent(token);
      const { response, result } = await NanoAPI.requestJson(path, body, 20000);
      assertCurrent(token);
      if (result === undefined) throw new Error('The board returned an incomplete collection response.');
      if (!response.ok) throw new Error(result?.error || `Collection request failed (${response.status}).`);
      const value = wholeState ? result?.collection : result;
      if (!value || typeof value.enabled !== 'boolean' || typeof value.storageReady !== 'boolean') throw new Error('The board returned an invalid collection response.');
      return result;
    }
    async function refresh() {
      if (reading || pending || verifying) return;
      const token = generation;
      reading = true;
      try { const next = await request('/api/collection', undefined, false, token); assertCurrent(token); state = next; online = true; }
      catch (error) { if (token === generation) { online = false; message(error.message, true); } }
      finally { if (token === generation) { reading = false; lastRefresh = Date.now(); sync(); } }
    }
    async function change(path, body, text) {
      if (pending || verifying || !online || path === '/api/collection' && root.usb?.mode === 'hci') return;
      const token = generation;
      pending = true; message('Applying collection settings…'); sync();
      try {
        const next = await request(path, body, false, token); assertCurrent(token);
        state = next; dirty = false; get('init-confirm').checked = false; get('clear-confirm').checked = false; message(text);
      } catch (error) { if (token === generation) message(error.message, true); }
      finally { if (token === generation) { pending = false; sync(); } }
    }
    function payload(enabled) {
      for (const id of ['interval', 'window', 'period', 'duration']) if (!get(id).value.trim()) throw new Error('Fill in all timing values.');
      return configuration({ enabled, active: get('mode').value === 'active', intervalMs: Number(get('interval').value), windowMs: Number(get('window').value),
        periodMs: Number(get('period').value) * 1000, burstMs: Number(get('duration').value) * 1000, address: get('address').value.trim() });
    }
    async function verify() {
      if (pending || reading || verifying) return;
      const token = generation;
      verifying = true; get('verification').textContent = 'Checking the board, saved settings, and log storage…'; sync();
      try {
        const before = await request('/api/state', undefined, true, token); assertCurrent(token);
        root = before; state = before.collection; online = true;
        const result = setupCheck(before, { online, dirty });
        if (result.observe) {
          get('verification').textContent = 'Setup is saved. Watching for new records for 2.5 seconds…';
          await new Promise(resolve => setTimeout(resolve, 2500));
          const after = await request('/api/state', undefined, true, token); assertCurrent(token);
          root = after; state = after.collection;
          get('verification').textContent = captureCheck(before, after);
        } else get('verification').textContent = result.message;
      } catch (error) { if (token === generation) get('verification').textContent = `Verification incomplete: ${error.message}`; }
      finally { if (token === generation) { verifying = false; sync(); } }
    }
    get('form').addEventListener('input', () => { dirty = true; sync(); });
    get('form').addEventListener('submit', event => { event.preventDefault(); try { change('/api/collection', payload(Boolean(state?.enabled)), 'Collection settings applied.'); } catch (error) { message(error.message, true); } });
    get('start').addEventListener('click', () => { try { change('/api/collection', payload(true), 'Collection started.'); } catch (error) { message(error.message, true); } });
    get('stop').addEventListener('click', () => change('/api/collection', { enabled: false }, 'Collection stopped.'));
    get('use-selected').addEventListener('click', () => {
      const device = NanoConnection.snapshot().selected;
      if (!device) { message('Select a device in Discover first.', true); return; }
      get('address').value = device.address; dirty = true; sync();
    });
    get('init-confirm').addEventListener('change', sync); get('clear-confirm').addEventListener('change', sync);
    get('init').addEventListener('click', () => { if (get('init-confirm').checked) change('/api/collection/storage/init', { confirm: true }, 'Onboard storage is ready.'); });
    get('clear').addEventListener('click', () => { if (get('clear-confirm').checked) change('/api/collection/clear', { confirm: true }, 'Collection log cleared.'); });
    get('export').addEventListener('click', async event => {
      event.preventDefault();
      if (get('export').getAttribute('aria-disabled') === 'true') return;
      const token = generation;
      try {
        const response = await NanoAPI.fetch('/api/collection/export');
        assertCurrent(token);
        if (!response.ok) {
          let result = {}; try { result = await response.json(); } catch {}
          assertCurrent(token);
          throw new Error(result.error || `Collection export failed (${response.status}).`);
        }
        const blob = await response.blob(); assertCurrent(token);
        const href = URL.createObjectURL(blob);
        const download = document.createElement('a'); download.href = href; download.download = 'nanoscope-collection.ndjson'; download.click();
        setTimeout(() => URL.revokeObjectURL(href), 0);
      } catch (error) { if (token === generation) message(error.message, true); }
    });
    get('refresh').addEventListener('click', refresh);
    get('verify').addEventListener('click', verify);
    globalThis.addEventListener('nanoscope:api-change', () => {
      generation++; state = null; root = {}; online = false; pending = dirty = reading = verifying = false; lastRefresh = 0; lastStateError = '';
      get('form').reset(); get('init-confirm').checked = get('clear-confirm').checked = false;
      get('verification').textContent = ''; message(''); sync();
    });
    lab.onState((next, available = true) => {
      root = next; online = available;
      if (next.collection) { state = next.collection; lastRefresh = Date.now(); }
      else if (available && Date.now() - lastRefresh >= 3000) refresh();
      sync();
    });
    sync(); if (!state) refresh();
  }
  return { configuration, setupCheck, captureCheck, mount };
})();
if (typeof module !== 'undefined') module.exports = NanoCollection;
