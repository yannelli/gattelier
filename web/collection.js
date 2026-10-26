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
    return count > 0 ? `Setup verified. ${count} new record${count === 1 ? '' : 's'} saved during the check.` : 'Setup is saved and storage is ready. Live capture is unverified: no new records arrived in 2.5 seconds. Check the address filter or wait for advertisements.';
  }
  function mount(container, lab) {
    if (!container) return;
    let state = null, root = {}, online = false, pending = false, dirty = false, reading = false, verifying = false, lastRefresh = 0, lastStateError = '';
    const get = id => container.querySelector(`#collection-${id}`);
    container.innerHTML = '<div class="panel-heading"><div><h2>Collection</h2><p>Save advertisement snapshots on the board</p></div><button id="collection-refresh" class="button quiet" type="button">Refresh</button></div><div class="collection-body"><dl class="collection-facts"><div><dt>Storage</dt><dd id="collection-storage">Checking…</dd></div><div><dt>Collection</dt><dd id="collection-state">Checking…</dd></div><div><dt>Records</dt><dd id="collection-count">0</dd></div><div><dt>Saved setup</dt><dd id="collection-saved">Checking…</dd></div><div><dt>Queue / dropped / write errors</dt><dd id="collection-errors">0 / 0 / 0</dd></div></dl><progress id="collection-capacity" max="524288" value="0" aria-label="Collection storage used"></progress><p id="collection-usage" class="vendor-note"></p><form id="collection-form" class="collection-form" novalidate><label>Scan mode<select id="collection-mode"><option value="passive">Passive: listen for advertisements</option><option value="active">Active: request scan responses</option></select></label><label>Scan interval (ms)<input id="collection-interval" type="number" min="10" max="10240" step="1" value="160" required></label><label>Scan window (ms)<input id="collection-window" type="number" min="5" max="10240" step="1" value="80" required></label><label>Burst period (seconds; 0 = continuous)<input id="collection-period" type="number" min="0" max="3600" step="1" value="0" required></label><label>Burst duration (seconds)<input id="collection-duration" type="number" min="1" max="600" step="1" value="10" required></label><label class="collection-address">Device address (blank = all devices)<input id="collection-address" type="text" maxlength="17" placeholder="aa:bb:cc:dd:ee:ff" autocomplete="off" spellcheck="false"></label><div class="collection-actions"><button id="collection-use-selected" class="button quiet" type="button">Use selected device</button><button id="collection-apply" class="button secondary" type="submit">Apply settings</button><button id="collection-start" class="button primary" type="button">Start collection</button><button id="collection-stop" class="button secondary" type="button">Stop collection</button></div></form><p class="vendor-note">Logs contain sampled advertisement snapshots, including address, signal, name, services, and raw payload. A sweep starts each second while scanning. Collection pauses during a BLE connection or command. Settings and the start/stop choice are saved on the board and restored after power cycles. Logs remain on the board.</p><div id="collection-init-area" class="collection-storage-action" hidden><h3>Initialize onboard storage</h3><p>The filesystem did not mount. Initialization erases the board’s SPIFFS storage partition and creates collection storage. It leaves Wi-Fi settings and firmware in their separate partitions.</p><label class="collection-check"><input id="collection-init-confirm" type="checkbox">Erase and initialize the onboard SPIFFS partition</label><button id="collection-init" class="button secondary" type="button">Initialize storage</button></div><div class="collection-actions"><a id="collection-export" class="button secondary" href="/api/collection/export" download="nanoscope-collection.ndjson">Download NDJSON</a><details class="collection-clear"><summary>Clear saved log</summary><label class="collection-check"><input id="collection-clear-confirm" type="checkbox">Delete the saved collection log</label><button id="collection-clear" class="button secondary" type="button">Clear log</button></details></div><div class="collection-actions"><button id="collection-verify" class="button secondary" type="button">Verify setup</button><label class="collection-check"><input id="collection-verify-capture" type="checkbox" checked>Check new records for 2.5 seconds when collecting</label></div><p id="collection-verification" role="status"></p><p id="collection-message" role="status"></p><details class="collection-help"><summary>Button, LED, and USB storage</summary><p>Hold the board button for 3 seconds to start or stop collection after storage is initialized. Short-press switches Wi-Fi and hotspot. Collection adds a teal double pulse to the current blue or amber network color.</p><p>The NanoC6 cannot host a USB drive through a hub. Its built-in USB supports serial and debugging. Logs use onboard flash, capped at 512 KiB, and download to this browser. The board stops collection when the file is full.</p><a href="https://docs.espressif.com/projects/esp-idf/en/stable/esp32c6/api-guides/usb-serial-jtag-console.html" target="_blank" rel="noopener noreferrer">ESP32-C6 USB capabilities</a></details></div>';
    function message(text, error = false) { get('message').textContent = text; get('message').classList.toggle('error', error); }
    function sync() {
      const unavailable = pending || verifying || !online || !state, hci = root.usb?.mode === 'hci';
      for (const id of ['apply', 'mode', 'interval', 'window', 'period', 'duration', 'address', 'use-selected']) get(id).disabled = unavailable || hci;
      get('start').disabled = unavailable || hci || state?.enabled || !state?.storageReady || !state?.persistenceReady || state?.full || state?.damaged;
      get('stop').disabled = unavailable || !state?.enabled;
      get('init').disabled = unavailable || state?.storageReady || !get('init-confirm').checked;
      get('clear').disabled = unavailable || state?.enabled || !state?.storageReady || !get('clear-confirm').checked;
      get('refresh').disabled = pending || reading || verifying; get('verify').disabled = unavailable || reading;
      const canExport = online && state?.bytes > 0;
      get('export').setAttribute('aria-disabled', String(!canExport)); get('export').tabIndex = canExport ? 0 : -1;
      if (!state) return;
      const labels = { stopped: 'Stopped', collecting: state.active ? 'Active scan' : 'Passive scan', scheduled: 'Waiting for next burst', 'paused-connected': 'Paused: device connected', 'paused-busy': 'Paused: BLE command', starting: 'Starting scan' };
      get('state').textContent = online ? labels[state.status] || state.status : 'Board unavailable';
      get('storage').textContent = !state.storageReady ? 'Initialization required' : state.damaged ? 'Incomplete log: export and clear' : state.full ? 'Full: export and clear' : 'Ready';
      get('count').textContent = Number(state.recordCount || 0).toLocaleString();
      get('saved').textContent = state.configSaved ? `Saved · run after power cycle: ${state.savedEnabled ? 'on' : 'off'}` : state.persistenceReady ? 'Apply settings to save' : 'Settings storage unavailable';
      get('errors').textContent = `${state.queued || 0} / ${state.dropped || 0} / ${state.writeErrors || 0}`;
      get('capacity').value = state.bytes || 0; get('capacity').max = state.limitBytes || 524288;
      get('usage').textContent = `${Math.ceil((state.bytes || 0) / 1024)} / ${Math.floor((state.limitBytes || 524288) / 1024)} KiB saved`;
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
    async function request(path, body, wholeState = false) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await NanoAPI.fetch(path, { method: body === undefined ? 'GET' : 'POST', signal: controller.signal,
          ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
        let result; try { result = await response.json(); } catch { throw new Error('The board returned an incomplete collection response.'); }
        if (!response.ok) throw new Error(result.error || `Collection request failed (${response.status}).`);
        const value = wholeState ? result?.collection : result;
        if (!value || typeof value.enabled !== 'boolean' || typeof value.storageReady !== 'boolean') throw new Error('The board returned an invalid collection response.');
        return result;
      } finally { clearTimeout(timer); }
    }
    async function refresh() {
      if (reading || pending || verifying) return;
      reading = true;
      try { state = await request('/api/collection'); online = true; }
      catch (error) { online = false; message(error.message, true); }
      finally { reading = false; lastRefresh = Date.now(); sync(); }
    }
    async function change(path, body, text) {
      if (pending || verifying || !online || path === '/api/collection' && root.usb?.mode === 'hci') return;
      pending = true; message('Applying collection settings…'); sync();
      try { state = await request(path, body); dirty = false; get('init-confirm').checked = false; get('clear-confirm').checked = false; message(text); }
      catch (error) { message(error.message, true); }
      finally { pending = false; sync(); }
    }
    function payload(enabled) {
      for (const id of ['interval', 'window', 'period', 'duration']) if (!get(id).value.trim()) throw new Error('Fill in all timing values.');
      return configuration({ enabled, active: get('mode').value === 'active', intervalMs: Number(get('interval').value), windowMs: Number(get('window').value),
        periodMs: Number(get('period').value) * 1000, burstMs: Number(get('duration').value) * 1000, address: get('address').value.trim() });
    }
    async function verify() {
      if (pending || reading || verifying) return;
      verifying = true; get('verification').textContent = 'Checking the board, saved settings, and log storage…'; sync();
      try {
        const before = await request('/api/state', undefined, true); root = before; state = before.collection; online = true;
        const result = setupCheck(before, { online, dirty });
        if (result.observe && get('verify-capture').checked) {
          get('verification').textContent = 'Setup is saved. Watching for new records for 2.5 seconds…';
          await new Promise(resolve => setTimeout(resolve, 2500));
          const after = await request('/api/state', undefined, true); root = after; state = after.collection;
          get('verification').textContent = captureCheck(before, after);
        } else get('verification').textContent = result.message;
      } catch (error) { get('verification').textContent = `Verification incomplete: ${error.message}`; }
      finally { verifying = false; sync(); }
    }
    get('form').addEventListener('input', () => { dirty = true; });
    get('form').addEventListener('submit', event => { event.preventDefault(); try { change('/api/collection', payload(Boolean(state?.enabled)), 'Collection settings applied.'); } catch (error) { message(error.message, true); } });
    get('start').addEventListener('click', () => { try { change('/api/collection', payload(true), 'Collection started. The browser can close while the board stays powered.'); } catch (error) { message(error.message, true); } });
    get('stop').addEventListener('click', () => change('/api/collection', { enabled: false }, 'Collection stopped. Saved records remain on the board.'));
    get('use-selected').addEventListener('click', () => {
      const device = NanoConnection.snapshot().selected;
      if (!device) { message('Select a device in Discover first.', true); return; }
      get('address').value = device.address; dirty = true;
    });
    get('init-confirm').addEventListener('change', sync); get('clear-confirm').addEventListener('change', sync);
    get('init').addEventListener('click', () => { if (get('init-confirm').checked) change('/api/collection/storage/init', { confirm: true }, 'Onboard storage is ready.'); });
    get('clear').addEventListener('click', () => { if (get('clear-confirm').checked) change('/api/collection/clear', { confirm: true }, 'Collection log cleared.'); });
    get('export').addEventListener('click', async event => {
      event.preventDefault();
      if (get('export').getAttribute('aria-disabled') === 'true') return;
      try {
        const response = await NanoAPI.fetch('/api/collection/export');
        if (!response.ok) {
          let result = {}; try { result = await response.json(); } catch {}
          throw new Error(result.error || `Collection export failed (${response.status}).`);
        }
        const href = URL.createObjectURL(await response.blob());
        const download = document.createElement('a'); download.href = href; download.download = 'nanoscope-collection.ndjson'; download.click();
        setTimeout(() => URL.revokeObjectURL(href), 0);
      } catch (error) { message(error.message, true); }
    });
    get('refresh').addEventListener('click', refresh);
    get('verify').addEventListener('click', verify);
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
