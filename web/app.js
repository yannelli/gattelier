'use strict';

const $ = id => document.getElementById(id);
const vendorTools = typeof module !== 'undefined' ? require('./vendors.js') : NanoVendors;
const deviceKey = device => `${device.address}/${device.addressType}`;
const visibleDevices = (devices, query, database = vendorDatabase) => devices.filter(device =>
  `${device.name || ''} ${device.address} ${vendorTools.identify(device, database).search}`.toLowerCase().includes(query.trim().toLowerCase())
).slice().sort((a, b) => b.rssi - a.rssi || a.address.localeCompare(b.address));
const canScan = (state, online, pending) => online && !pending && !state.ble.busy && !state.ble.connected && state.usb?.mode !== 'hci' && !state.collection?.enabled;
const canConnect = (state, device, online, pending) => canScan(state, online, pending) && device.connectable;
const canRead = (state, characteristic, online, pending) => online && !pending && !state.ble.busy && state.ble.connected && characteristic.properties.includes('read');
const operationLabel = operation => ({ scanning: 'Scanning continuously', connecting: 'Connecting…', discovering: 'Discovering services…', reading: 'Reading value…', writing: 'Writing value…', subscribing: 'Updating subscription…', disconnecting: 'Disconnecting…' })[operation] || 'Working…';
const scanAction = ble => ble.scanning ? 'stop-scan' : 'scan';
const scanStatus = ble => ble.operation === 'usb-hci' ? 'USB controller mode' : ble.busy ? operationLabel(ble.operation) : ble.scanning ? 'Scanning continuously' : ble.connected && ble.scanEnabled ? 'Scanning paused while connected' : 'Scanning stopped';
function lastSeenLabel(device, uptime) {
  if (!Number.isFinite(device.lastSeen) || !Number.isFinite(uptime)) return '';
  const age = Math.max(0, Math.floor(uptime - device.lastSeen));
  return age < 3 ? 'Seen just now' : age < 60 ? `Seen ${age}s ago` : `Seen ${Math.floor(age / 60)}m ago`;
}
const names = {
  '1910': 'PLAUD recorder', '2bb1': 'PLAUD commands', '2bb0': 'PLAUD responses',
  '001120a0-2233-4455-6677-889912345678': 'Pocket recorder',
  '001120a2-2233-4455-6677-889912345678': 'Pocket commands',
  '001120a3-2233-4455-6677-889912345678': 'Pocket responses',
  '001120a1-2233-4455-6677-889912345678': 'Pocket audio stream',
  '1800': 'Generic Access', '1801': 'Generic Attribute', '180a': 'Device Information',
  '180f': 'Battery Service', '1812': 'Human Interface Device', '180d': 'Heart Rate',
  '2a00': 'Device Name', '2a01': 'Appearance', '2a19': 'Battery Level',
  '2a24': 'Model Number', '2a25': 'Serial Number', '2a26': 'Firmware Revision',
  '2a27': 'Hardware Revision', '2a28': 'Software Revision', '2a29': 'Manufacturer Name'
};
function uuidName(uuid, fallback) {
  const normalized = String(uuid).toLowerCase().replace(/^0x/, '');
  const short = /^0000[0-9a-f]{4}-0000-1000-8000-00805f9b34fb$/.test(normalized) ? normalized.slice(4, 8) : normalized;
  return names[short] || fallback;
}
let state = { wifi: {}, ble: {}, devices: [], services: [] };
let online = false, pending = false, selected = '', notice = '', transportError = '', pollPromise, timer, ticking = false;
let listSignature = '', detailSignature = '';
let vendorDatabase = null, vendorStatus = 'loading';
let scanStore, browserUI;
const browseDevices = () => scanStore ? scanStore.devices() : state.devices;
const selectedDevice = () => browseDevices().find(item => deviceKey(item) === selected);
function selectDevice(device) {
  selected = deviceKey(device); scanStore?.setPreference('selectedDevice', selected); render();
  document.dispatchEvent(new CustomEvent('nanoscope:selection', { detail: device }));
  if (NanoWorkspace.view() === 'discover' && matchMedia('(max-width: 700px)').matches) $('inspector').closest('.panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function button(label, className, action, disabled, focusKey) {
  const element = node('button', `button ${className}`, label);
  element.type = 'button'; element.disabled = disabled;
  element.dataset.focus = focusKey;
  element.addEventListener('click', action);
  return element;
}
function replacePreservingFocus(container, content) {
  const focused = container.contains(document.activeElement) ? document.activeElement : null;
  const active = focused?.dataset.focus, start = focused?.selectionStart, end = focused?.selectionEnd;
  const expanded = new Set(Array.from(container.querySelectorAll('details[open][data-persist]'), item => item.dataset.persist));
  container.replaceChildren(content);
  for (const item of container.querySelectorAll('details[data-persist]')) item.open = expanded.has(item.dataset.persist);
  if (active) {
    const next = Array.from(container.querySelectorAll('[data-focus]')).find(element => element.dataset.focus === active);
    next?.focus({ preventScroll: true });
    if (typeof start === 'number' && typeof next?.setSelectionRange === 'function') next.setSelectionRange(start, end);
  }
}
function empty(title, message, className = 'compact') {
  const element = node('div', `empty ${className}`);
  element.append(node('span', 'empty-symbol', '◎'), node('h3', '', title), node('p', '', message));
  element.firstChild.setAttribute('aria-hidden', 'true');
  return element;
}
function metadata(label, value, wide = false, mono = false) {
  const element = node('div', wide ? 'wide' : '');
  element.append(node('dt', '', label), node('dd', mono ? 'mono' : '', value));
  return element;
}
function renderList() {
  const devices = browserUI ? browserUI.select(browseDevices(), vendorDatabase) : visibleDevices(state.devices, $('search').value);
  const signature = JSON.stringify([devices, selected, state.ble.address, state.ble.connected, state.ble.scanning, state.uptime]);
  if (signature === listSignature) return;
  listSignature = signature;
  const fragment = document.createDocumentFragment();
  if (!devices.length) {
    const searching = $('search').value.trim() || browserUI?.isFiltered();
    const scanning = state.ble.scanning;
    fragment.append(empty(searching ? 'No matching devices' : scanning ? 'Listening for devices…' : 'No cached devices',
      searching ? 'Adjust or reset the filters to see more devices.' : scanning ? 'Nearby devices appear as their advertisements arrive.' : 'Start scanning to discover nearby advertising devices.'));
  }
  for (const device of devices) {
    const row = node('button', 'device');
    row.type = 'button'; row.dataset.focus = deviceKey(device);
    row.setAttribute('aria-pressed', String(selected === deviceKey(device)));
    const icon = node('span', 'device-icon', '◇'); icon.setAttribute('aria-hidden', 'true');
    const info = node('span', 'device-info');
    info.append(node('span', 'device-name', `${device.favorite ? '★ ' : ''}${device.label || device.name || 'Unnamed device'}`), node('span', 'device-address', device.address));
    const recorder = NanoRecorders.identify(device);
    if (recorder) info.append(node('span', 'device-vendor', recorder.product));
    const vendor = vendorTools.identify(device, vendorDatabase);
    if (vendor.hint) info.append(node('span', 'device-vendor', vendor.hint));
    const signal = node('span', 'signal', `${device.rssi} dBm`);
    signal.append(node('small', '', state.ble.connected && state.ble.address === device.address ? 'Connected' : device.connectable ? 'Connectable' : 'Broadcast'));
    const seen = device.lastSeenMs ? NanoInsights.age(device.lastSeenMs) : lastSeenLabel(device, state.uptime);
    if (seen) signal.append(node('small', '', seen));
    row.append(icon, info, signal);
    row.addEventListener('click', () => selectDevice(device));
    fragment.append(row);
  }
  replacePreservingFocus($('devices'), fragment);
  if ($('list-summary')) $('list-summary').textContent = `${devices.length} matching · ${browseDevices().length} in browser`;
}
function render() {
  NanoLab.update(state, online);
  NanoLab.setBackgroundCapture(scanStore?.getPreference('backgroundScan', false));
  const scanning = state.ble.scanning;
  $('network').textContent = online ? (state.wifi.connected ? `${state.wifi.ssid} · ${state.wifi.ip}` : 'Wi-Fi disconnected') : 'Board unavailable';
  $('network-dot').classList.toggle('online', online && state.wifi.connected);
  $('scan').disabled = !canScan(state, online, pending);
  $('scan').title = state.collection?.enabled ? 'Collection controls are in Settings. Hold the board button for 3 seconds to stop.' : state.usb?.mode === 'hci' ? 'Restore Bluetooth workbench in Settings.' : '';
  $('scan-label').textContent = scanning ? 'Stop scan' : 'Scan';
  $('scan').setAttribute('aria-label', scanning ? 'Stop scanning' : 'Start scanning');
  $('scan-indicator').hidden = !scanning;
  $('count').textContent = state.devices.length;
  $('scan-status').textContent = pending ? 'Sending request…' : state.collection?.enabled ? `${state.collection.active ? 'Active' : 'Passive'} collection · ${state.collection.status} · ${state.collection.recordCount} records` : scanStatus(state.ble);
  const error = transportError || notice || state.ble.error;
  $('notice').hidden = !error; $('notice-text').textContent = error || '';
  $('retry').hidden = online; $('retry').disabled = pending;
  $('board-status').textContent = online ? `Board online · ${Math.floor((state.freeHeap || 0) / 1024)} KB free` : 'Reconnect to the board’s Wi-Fi network';
  renderList(); renderInspector();
  const device = selectedDevice();
  NanoWorkspace.update({ device, connected: Boolean(device && state.ble.connected && state.ble.address === device.address) });
  NanoDevicePage.render();
  if (NanoWorkspace.view() === 'apps') NanoModules.render(device, browseDevices());
  browserUI?.update();
  if (NanoWorkspace.view() === 'insights') NanoInsights.render($('insights-content'), selectedDevice(), browseDevices(), selectDevice, category => browserUI.setKind(category));
}
async function request(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await NanoAPI.fetch(path, { ...options, signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  } finally { clearTimeout(timeout); }
}
function poll() {
  if (pollPromise) return pollPromise;
  pollPromise = (async () => {
    try {
      state = await request('state'); online = true;
      scanStore?.ingest(state);
      transportError = '';
      if (!selected && state.ble.connected) {
        const device = state.devices.find(item => item.address === state.ble.address);
        if (device) selected = deviceKey(device);
      }
    } catch (error) {
      online = false;
      scanStore?.setOffline();
      transportError = error.name === 'AbortError' ? 'The board took too long to respond. Check its power and Wi-Fi connection.' : 'Cannot reach the board. Check its power and connect to the same Wi-Fi network.';
    } finally { NanoPWA.reportConnection(online); render(); }
  })().finally(() => { pollPromise = null; });
  return pollPromise;
}
async function mutate(action, data = {}) {
  if (pending || !online || state.ble.busy) return;
  pending = true; notice = ''; render();
  try {
    await NanoLab.action(action, data);
    if (pollPromise) await pollPromise;
    await poll();
  } catch (error) {
    notice = error.name === 'AbortError' ? 'The request timed out. Refresh the board status before trying again.' : error.message;
  } finally { pending = false; render(); }
}
async function tick() {
  clearTimeout(timer);
  if ((document.hidden && !scanStore?.getPreference('backgroundScan', false)) || ticking) return;
  ticking = true;
  try { await poll(); } finally { ticking = false; }
  const delay = NanoPWA.pollDelay({ background: scanStore?.getPreference('backgroundScan', false) });
  if (delay !== null) timer = setTimeout(tick, delay);
}
async function loadVendors() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const cached = await NanoBrowserCache.readVendors();
    let database = cached && Date.now() - cached.savedAt < 86400000 ? cached.data : null;
    if (!database) {
      const response = await fetch('/vendors.json', { signal: controller.signal });
      if (!response.ok) throw new Error('Vendor database unavailable');
      database = await response.json();
      if (database.oui && database.company) await NanoBrowserCache.saveVendors(database);
    }
    if (!database.oui || !database.company) throw new Error('Invalid vendor database');
    vendorDatabase = database; vendorStatus = 'ready';
    $('vendor-status').textContent = 'Vendor database ready';
    $('vendor-status').title = database.updated ? `Updated ${database.updated}` : '';
  } catch {
    vendorStatus = 'failed';
    $('vendor-status').textContent = 'Vendor database unavailable';
  } finally {
    clearTimeout(timeout); listSignature = ''; detailSignature = ''; render();
  }
}
async function boot() {
  NanoTheme.init();
  scanStore = NanoScanStore.create(); await scanStore.init();
  selected = scanStore.getPreference('selectedDevice', '');
  browserUI = NanoBrowserUI.mount(scanStore, { change: () => { listSignature = ''; detailSignature = ''; render(); tick(); }, getSelected: selectedDevice, getState: () => state });
  NanoWorkspace.init({ getPreference: (key, fallback) => scanStore.getPreference(key, fallback), setPreference: (key, value) => scanStore.setPreference(key, value), onChange: render });
  document.addEventListener('nanoscope:state', event => { state = event.detail; scanStore.ingest(state); online = true; render(); });
  document.addEventListener('nanoscope:busy', event => { pending = event.detail; render(); });
  globalThis.addEventListener('nanoscope:api-change', () => {
    clearTimeout(timer);
    state = { wifi: {}, ble: {}, devices: [], services: [] };
    online = false; pending = false; transportError = NanoAPI.configured() ? 'Checking the new board endpoint.' : 'Set the private board endpoint in Settings.';
    scanStore?.setOffline(); NanoLab.update(state, false); render();
    tick();
  });
  NanoLab.init();
  NanoCredentials.init();
  NanoConnection.init({ state: () => state, online: () => online, pending: () => pending, selected: selectedDevice, devices: browseDevices, refresh: poll, select: selectDevice, action: NanoLab.action, recorder: NanoRecorders.identify, changed: render, notice: message => { notice = message; } });
  NanoCredentialsUI.mount($('credentials-panel'));
  NanoAPIUI.mount($('api-panel'));
  NanoPocket.mount($('pocket-panel'), NanoLab);
  NanoPlaud.mount($('plaud-panel'), NanoLab);
  NanoSleepRouter.mount($('sleep-panel'), NanoLab);
  NanoRadiaCode.mount($('radiacode-panel'), NanoLab);
  NanoNetwork.mount($('network-panel'), NanoLab);
  NanoUSB.mount($('usb-panel'), NanoLab);
  NanoPWA.mount($('pwa-panel'), { retry: tick });
  NanoCollection.mount($('collection-panel'), NanoLab);
  NanoRecipes.mount($('recipes-panel'), NanoLab);
  NanoSnapshots.mount($('snapshots-panel'), { getDevice: selectedDevice, getState: () => state });
  NanoGuide.mount($('guide-panel'));
  NanoModules.mount({ select: selectDevice, selected: selectedDevice, devices: browseDevices });
  NanoDevicePage.mount();
  $('scan').addEventListener('click', () => mutate(scanAction(state.ble)));
  $('search').addEventListener('input', renderList);
  $('retry').addEventListener('click', tick);
  document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (!document.hidden) tick(); });
  tick(); loadVendors();
}
if (typeof module !== 'undefined') module.exports = { deviceKey, visibleDevices, canScan, canConnect, canRead, uuidName, operationLabel, scanAction, scanStatus, lastSeenLabel };
if (typeof document !== 'undefined') boot();
