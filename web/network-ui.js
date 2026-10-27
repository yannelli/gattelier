'use strict';

const NanoNetwork = (() => {
  function validateSSID(value) {
    if (typeof value !== 'string' || !value.length || new TextEncoder().encode(value).length > 32) throw new Error('Enter an SSID between 1 and 32 UTF-8 bytes.');
    return value;
  }
  function validatePassword(value) {
    const length = new TextEncoder().encode(value).length;
    if (!(length >= 8 && length <= 63) && !/^[0-9a-f]{64}$/i.test(value)) throw new Error('Use a password of 8–63 UTF-8 bytes, or exactly 64 hexadecimal characters.');
    return value;
  }
  function stationPayload(config, ssid, password) {
    validateSSID(ssid);
    if (!password && ssid !== config.configuredSSID) throw new Error('Enter the Wi-Fi password when changing the saved SSID.');
    return { ssid, ...(password ? { password: validatePassword(password) } : {}) };
  }
  function hotspotPayload(config, ssid, password) {
    validateSSID(ssid);
    return { apSsid: ssid, ...(password ? { apPassword: validatePassword(password) } : {}) };
  }
  function mount(container, lab) {
    if (!container) return;
    let config = null, current = {}, reachable = false, pending = false, reading = null, fingerprint = '';
    let stationDirty = false, hotspotDirty = false, refreshTimer, revealed = false;
    const get = id => container.querySelector(`#network-${id}`);
    container.innerHTML = '<div class="panel-heading"><div><h2>Wi-Fi &amp; hotspot</h2></div><div class="heading-tools"><button id="network-refresh" class="button quiet" type="button">Refresh</button><details class="help"><summary aria-label="About Wi-Fi and the board button"><span aria-hidden="true">?</span></summary><div class="help-body"><p id="network-button-help">Short-press the board button to switch between Wi-Fi and hotspot.</p><p>Leave a password blank to keep the saved one. Changing the Wi-Fi network needs its password. Saving hotspot settings while you are on the hotspot disconnects you until you rejoin.</p><p>Passwords are never stored in this browser.</p><h3>Status light</h3><div class="network-led-legend"><span><i class="network-led" data-led="blue"></i>Blue: Wi-Fi</span><span><i class="network-led" data-led="amber"></i>Amber: hotspot</span><span><i class="network-led" data-led="blue-blink"></i>Blinking blue: connecting</span><span><i class="network-led" data-led="cyan"></i>Cyan: Wi-Fi paused for USB</span><span><i class="network-led" data-led="red"></i>Red: connection failed</span></div><p>The separate blue activity light flashes with BLE and USB HCI traffic.</p></div></details></div></div><div class="network-body"><div class="network-current"><span id="network-led" class="network-led" aria-hidden="true"></span><strong id="network-current-mode">Loading network status…</strong><span id="network-current-status" class="badge"></span></div><dl class="network-facts"><div><dt>Active network</dt><dd id="network-current-ssid">—</dd></div><div><dt>Board address</dt><dd id="network-current-ip" class="mono">—</dd></div><div><dt>Saved Wi-Fi</dt><dd id="network-saved-ssid">—</dd></div><div><dt>Hotspot</dt><dd id="network-ap-name">—</dd></div></dl><div class="network-forms"><form id="network-station-form" autocomplete="off" novalidate><h3>Connect to Wi-Fi</h3><label>Network name<input id="network-station-ssid" type="text" autocomplete="off" spellcheck="false" required></label><label>Password<input id="network-station-password" type="password" autocomplete="off" maxlength="64" placeholder="Unchanged"></label><button id="network-save-station" class="button primary" type="submit">Save and connect</button></form><form id="network-hotspot-form" autocomplete="off" novalidate><h3>Device hotspot</h3><label>Hotspot name<input id="network-hotspot-ssid" type="text" autocomplete="off" spellcheck="false" required></label><label>Password<input id="network-hotspot-password" type="password" autocomplete="off" maxlength="64" placeholder="Unchanged"></label><div class="network-form-actions"><button id="network-save-hotspot" class="button secondary" type="submit">Save hotspot</button><button id="network-reveal" class="button quiet" type="button">Show password</button></div><output id="network-password-value" class="network-password" hidden aria-label="Current hotspot password"></output></form></div><div class="network-mode-actions"><button id="network-hotspot" class="button secondary" type="button">Switch to hotspot</button><button id="network-station" class="button secondary" type="button">Connect to saved Wi-Fi</button></div><div id="network-destination" class="network-destination" role="status" hidden><strong id="network-destination-title"></strong><p id="network-destination-text"></p><a id="network-destination-link"></a></div><p id="network-message" class="network-message" role="status"></p></div>';
    const statusNames = { 'usb-paused': 'Wi-Fi paused', 'station-connected': 'Connected', 'station-connecting': 'Connecting', hotspot: 'Hotspot active', error: 'Connection failed' };
    function message(text, error = false) { get('message').textContent = text; get('message').classList.toggle('error', error); }
    function conceal() { revealed = false; get('password-value').textContent = ''; get('password-value').hidden = true; get('reveal').textContent = 'Show password'; }
    function sync() {
      const busy = pending || !config || !reachable || lab.isActing() || current.ble?.busy || (config?.pending && !config.suspendedForUsb);
      for (const id of ['save-station', 'save-hotspot', 'reveal', 'station-ssid', 'station-password', 'hotspot-ssid', 'hotspot-password']) get(id).disabled = Boolean(busy);
      if (revealed) get('reveal').disabled = false;
      get('hotspot').disabled = Boolean(busy || (config?.mode === 'hotspot' && config?.apActive));
      get('station').disabled = Boolean(busy || !config?.configuredSSID || config?.stationConnected);
      get('refresh').disabled = Boolean(pending || reading);
      if (!config) return;
      get('current-mode').textContent = config.suspendedForUsb ? 'Connected over USB' : config.mode === 'hotspot' ? 'Device hotspot' : 'Wi-Fi connection';
      get('current-status').textContent = reachable ? statusNames[config.status] || config.status || 'Unknown status' : 'Board unavailable';
      get('led').dataset.led = config.led || '';
      get('current-ssid').textContent = config.suspendedForUsb ? 'Wi-Fi paused for USB' : config.networkSSID || (config.mode === 'hotspot' ? config.apSSID : config.ssid) || 'None';
      get('current-ip').textContent = config.suspendedForUsb ? 'USB serial' : config.ip || 'No address assigned';
      get('saved-ssid').textContent = config.configuredSSID || 'None';
      get('ap-name').textContent = config.apSSID || 'None';
      get('button-help').textContent = `Short-press the board button${Number.isInteger(config.buttonPin) ? ` (GPIO ${config.buttonPin})` : ''} ${config.suspendedForUsb ? 'to resume Wi-Fi' : 'to switch between Wi-Fi and hotspot'}.`;
      if (!stationDirty) get('station-ssid').value = config.configuredSSID || '';
      if (!hotspotDirty) get('hotspot-ssid').value = config.apSSID || '';
    }
    async function request(path, body) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await NanoAPI.fetch(path, { method: body === undefined ? 'GET' : 'POST', signal: controller.signal,
          ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
        let result; try { result = await response.json(); } catch { if (response.ok) throw new Error('The board response was incomplete.'); result = {}; }
        if (!response.ok) { const error = new Error(result.error || `The board rejected the request (${response.status}).`); error.rejected = true; throw error; }
        return result;
      } finally { clearTimeout(timer); }
    }
    async function refresh() {
      if (reading) return reading;
      reading = request('/api/network').then(result => {
        if (!['station', 'hotspot', 'usb'].includes(result.mode)) throw new Error('The board returned an invalid network configuration.');
        config = result; reachable = true;
      }).catch(() => { reachable = false; message('Network status is unavailable. Reconnect to the board and refresh.'); })
        .finally(() => { reading = null; sync(); });
      sync(); return reading;
    }
    function destination(mode, ssid, savingHotspot = false) {
      if (NanoAPI.transport() === 'serial') {
        get('destination').hidden = false;
        get('destination-title').textContent = 'USB stays connected';
        get('destination-text').textContent = config?.suspendedForUsb ? 'Saved network settings apply when Wi-Fi resumes. Turn off Pause Wi-Fi in Board connection, or press the board button.' : 'Network settings apply while USB stays connected.';
        get('destination-link').hidden = true;
        return;
      }
      const address = config?.apIP && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(config.apIP) ? config.apIP : '192.168.4.1';
      get('destination').hidden = false;
      get('destination-title').textContent = savingHotspot && mode === 'station' ? 'Saving hotspot settings' : mode === 'hotspot' ? 'After switching, join the device hotspot' : 'After switching, join the saved Wi-Fi';
      get('destination-text').textContent = savingHotspot && mode === 'station'
        ? `The hotspot will use “${ssid}”. The board remains on its current Wi-Fi connection.`
        : mode === 'hotspot' ? `Connect this phone or computer to “${ssid}”, then open the address below. The current page connection will close during the change.`
        : `Connect this phone or computer to “${ssid}”, then open NanoScope below. The router assigns the board’s Wi-Fi address.`;
      get('destination-link').hidden = savingHotspot && mode === 'station';
      get('destination-link').href = mode === 'hotspot' ? `http://${address}/` : 'http://nanoscope.local/';
      get('destination-link').textContent = get('destination-link').href;
    }
    async function change(body, mode, ssid, savingHotspot = false) {
      if (pending || (config?.pending && !config.suspendedForUsb) || lab.isActing() || current.ble?.busy) return;
      if (!config || !reachable) { message('Reconnect to the board before changing its network.', true); return; }
      const expectedDisconnect = NanoAPI.transport() !== 'serial' && (!savingHotspot || config.apActive || config.mode === 'hotspot');
      pending = true; conceal(); destination(mode, ssid, savingHotspot); message('Sending network settings…'); sync();
      await new Promise(resolve => requestAnimationFrame(resolve));
      try {
        const response = await request('/api/network', body);
        if (['station', 'hotspot', 'usb'].includes(response.mode)) config = response;
        if (body.ssid !== undefined) { config.configuredSSID = body.ssid; stationDirty = false; }
        if (body.apSsid !== undefined) { config.apSSID = body.apSsid; hotspotDirty = false; }
        get('station-password').value = ''; get('hotspot-password').value = '';
        message(NanoAPI.transport() === 'serial' ? config.suspendedForUsb ? 'Settings saved. They apply when Wi-Fi resumes.' : 'Settings saved. USB remains connected.' : expectedDisconnect ? 'The board accepted the change. Follow the connection instructions above.' : 'Hotspot settings saved. The current Wi-Fi connection remains selected.');
        clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, Math.max(1000, Number(response.applyAfterMs) + 250 || 1000));
      } catch (error) {
        if (error.rejected) message(error.message, true);
        else message(expectedDisconnect ? 'The connection closed before confirmation. Follow the instructions above, then refresh status.' : 'The board did not confirm the change. Refresh status before retrying.');
      } finally { pending = false; sync(); }
    }
    get('station-form').addEventListener('submit', event => {
      event.preventDefault();
      try { const body = stationPayload(config || {}, get('station-ssid').value, get('station-password').value); change(body, 'station', body.ssid); }
      catch (error) { message(error.message, true); }
    });
    get('hotspot-form').addEventListener('submit', event => {
      event.preventDefault();
      try { const body = hotspotPayload(config || {}, get('hotspot-ssid').value, get('hotspot-password').value); change(body, config?.mode || 'station', body.apSsid, true); }
      catch (error) { message(error.message, true); }
    });
    for (const id of ['station-ssid', 'station-password']) get(id).addEventListener('input', () => { stationDirty = true; });
    for (const id of ['hotspot-ssid', 'hotspot-password']) get(id).addEventListener('input', () => { hotspotDirty = true; });
    get('hotspot').addEventListener('click', () => change({ mode: 'hotspot' }, 'hotspot', config?.apSSID || 'the NanoScope hotspot'));
    get('station').addEventListener('click', () => change({ mode: 'station' }, 'station', config?.configuredSSID || 'the saved Wi-Fi'));
    get('refresh').addEventListener('click', refresh);
    get('reveal').addEventListener('click', async () => {
      if (revealed) { conceal(); return; }
      if (pending || (config?.pending && !config.suspendedForUsb) || lab.isActing() || current.ble?.busy) return;
      pending = true; sync();
      try {
        const result = await request('/api/network/hotspot-password', {}), password = result.apPassword ?? result.password;
        if (typeof password !== 'string' || !password) throw new Error('No hotspot password was returned.');
        get('password-value').textContent = password; get('password-value').hidden = false;
        revealed = true; get('reveal').textContent = 'Hide password';
        message('');
      } catch { message('The hotspot password could not be retrieved. Reconnect and try again.', true); }
      finally { pending = false; sync(); }
    });
    lab.onState((state, available = true) => {
      current = state; reachable = available;
      const wifi = state.wifi || {}, next = JSON.stringify([available, wifi.mode, wifi.status, wifi.ssid, wifi.ip, wifi.apActive]);
      if (next !== fingerprint) { fingerprint = next; if (available && !pending) refresh(); }
      sync();
    });
    document.addEventListener('nanoscope:busy', sync);
    refresh();
  }
  return { mount, stationPayload, hotspotPayload };
})();
if (typeof module !== 'undefined') module.exports = NanoNetwork;
