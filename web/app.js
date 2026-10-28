'use strict';

const $ = id => document.getElementById(id);
const vendorTools = typeof module !== 'undefined' ? require('./vendors.js') : NanoVendors;
const deviceKey = device => `${device.address.toLowerCase()}/${device.addressType}`;
const visibleDevices = (devices, query, database = vendorDatabase) => devices.filter(device =>
  `${deviceDisplayName(device, database)} ${device.label || ''} ${device.name || ''} ${device.gattName || ''} ${device.address} ${vendorTools.identify(device, database).search}`.toLowerCase().includes(query.trim().toLowerCase())
).slice().sort((a, b) => b.rssi - a.rssi || a.address.localeCompare(b.address));
function deviceDisplayName(device, database = vendorDatabase) {
  if (!device) return 'Device';
  for (const name of [device.label, device.name, device.gattName]) if (typeof name === 'string' && name.trim()) return name.trim();
  const vendor = vendorTools.identify(device, database);
  const recorder = typeof NanoRecorders !== 'undefined' ? NanoRecorders.identify(device) : null;
  const profile = typeof NanoProfiles !== 'undefined' ? NanoProfiles.identify(device) : null;
  return recorder?.product || vendor.manufacturer || vendor.addressVendor || (profile?.category !== 'other' && profile?.title) || device.address;
}
function rememberGattName(boardState, store = scanStore) {
  const ble = boardState.ble;
  if (!store || !ble?.connected || typeof NanoGattValues === 'undefined') return;
  const key = deviceKey(ble), stored = store.devices().find(item => deviceKey(item) === key);
  const device = stored || (selectedFallback && deviceKey(selectedFallback) === key ? selectedFallback : null);
  if (!device) return;
  for (const service of boardState.services || []) for (const item of service.characteristics || []) {
    if (shortUuid(item.uuid) !== '2a00' || !item.valueHex) continue;
    const name = NanoGattValues.decode(item.uuid, item.valueHex).find(field => !field.placeholder)?.value?.trim();
    if (name && (!stored || name !== device.gattName)) {
      if (stored) store.annotate(key, { gattName: name });
      device.gattName = name;
    }
  }
}
function handleDeviceKeyboard(event) {
  const target = event.target;
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing || target?.isContentEditable || target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
  if (event.key === 'Escape') {
    const device = NanoConnection.pendingDevice();
    if (device && NanoConnection.describe(device).cancel && NanoConnection.describe(device).enabled) { event.preventDefault(); NanoConnection.perform(device); }
    return;
  }
  const list = $('devices'), row = target?.closest?.('button.device');
  if (list?.contains(target) && (target === list || row)) {
    const rows = [...list.querySelectorAll('button.device')];
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const index = row ? rows.indexOf(row) : rows.findIndex(item => item.dataset.focus === selected);
      const next = rows[index < 0 ? event.key === 'ArrowDown' ? 0 : rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
      const device = browseDevices().find(item => deviceKey(item) === next?.dataset.focus);
      if (device) { selectDevice(device); [...list.querySelectorAll('button.device')].find(item => item.dataset.focus === deviceKey(device))?.focus(); }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (event.repeat) return;
      const device = row ? browseDevices().find(item => deviceKey(item) === row.dataset.focus) : selectedDevice();
      const status = NanoConnection.describe(device);
      if (device && status.enabled && (status.cancel || !status.connected)) NanoConnection.perform(device);
    }
  } else if (event.key.toLowerCase() === 'r' && !event.repeat && target?.closest?.('#inspector, #device-services, #device-summary')) {
    event.preventDefault(); readAllValues();
  }
}
const canScan = (state, online, pending) => online && !pending && !state.ble.busy && !state.ble.connected && state.usb?.mode !== 'hci' && !state.collection?.enabled;
const canConnect = (state, device, online, pending) => canScan(state, online, pending) && device.connectable;
const canRead = (state, characteristic, online, pending) => online && !pending && !state.ble.busy && state.ble.connected && characteristic.properties.includes('read');
const operationLabel = operation => ({ scanning: 'Scanning continuously', connecting: 'Connecting…', discovering: 'Discovering services…', reading: 'Reading value…', writing: 'Writing value…', subscribing: 'Updating subscription…', disconnecting: 'Disconnecting…' })[operation] || 'Working…';
const scanAction = ble => ble.scanning ? 'stop-scan' : 'scan';
const needsStatePoll = (state, online, pending, elapsed) => !online || pending || state.ble.busy || !state.ble.scanning || !state.ble.advertisementStream || elapsed >= 2000;
const scanStatus = ble => ble.operation === 'usb-hci' ? 'USB controller mode' : ble.busy ? operationLabel(ble.operation) : ble.scanning ? 'Scanning continuously' : ble.connected && ble.scanEnabled ? 'Scanning paused while connected' : 'Scanning stopped';
function lastSeenLabel(device, uptime) {
  if (!Number.isFinite(device.lastSeen) || !Number.isFinite(uptime)) return '';
  const age = Math.max(0, Math.floor(uptime - device.lastSeen));
  return age < 3 ? 'Seen just now' : age < 60 ? `Seen ${age}s ago` : `Seen ${Math.floor(age / 60)}m ago`;
}
const names = {
  '1910': 'PLAUD recorder',
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
function shortUuid(uuid) {
  const normalized = String(uuid).toLowerCase().replace(/^0x/, '');
  return /^0000[0-9a-f]{4}-0000-1000-8000-00805f9b34fb$/.test(normalized) ? normalized.slice(4, 8) : normalized;
}
function uuidName(uuid, fallback, serviceUuid = '') {
  const short = shortUuid(uuid);
  if (/^(?:0x)?1910$|^00001910-0000-1000-8000-00805f9b34fb$/i.test(serviceUuid) && ['2bb0', '2bb1'].includes(short)) return short === '2bb1' ? 'PLAUD commands' : 'PLAUD responses';
  return (typeof NanoSchlage !== 'undefined' ? NanoSchlage.lookup(short, serviceUuid)?.name : '') || names[short] || (typeof NanoDeviceLibrary !== 'undefined' ? NanoDeviceLibrary.lookup(short, serviceUuid)?.name : '') || (typeof NanoMetadata !== 'undefined' ? NanoMetadata.lookup(short)?.name : '') || fallback;
}
let state = { wifi: {}, ble: {}, devices: [], services: [] };
let selectedFallback = null;
let online = false, pending = false, selected = '', notice = '', transportError = '', pollPromise, timer, ticking = false;
let listSignature = '', detailSignature = '', lastRender = 0;
let vendorDatabase = null, vendorStatus = 'loading';
let scanStore, scanStream, browserUI, stateController, apiGeneration = 0, stateRevision = 0, lastStatePoll = 0;
const browseDevices = () => scanStore ? scanStore.devices() : state.devices;
const selectedDevice = () => browseDevices().find(item => deviceKey(item) === selected) || (selectedFallback && deviceKey(selectedFallback) === selected ? selectedFallback : null);
const activeSession = () => Boolean(state.ble.connected || NanoDexcom.isAcquiring());
const backgroundPolling = () => activeSession() || scanStore?.getPreference('backgroundScan', false);
function selectDevice(device, restored = false) {
  if (typeof readSession !== 'undefined' && readSession && readSession.key !== deviceKey(device)) readSession.stopped = true;
  selectedFallback = device; selected = deviceKey(device); scanStore?.setPreference('selectedDevice', selected);
  if (restored || NanoWorkspace.view() !== 'apps' || !NanoWorkspace.module() || NanoModules.rememberTarget(NanoWorkspace.module(), device)) NanoWorkspace.selectTarget?.(device);
  else NanoWorkspace.openDevice?.(device);
  render();
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
  const collapsed = new Set(Array.from(container.querySelectorAll('details[data-collapse]:not([open])'), item => item.dataset.collapse));
  container.replaceChildren(content);
  for (const item of container.querySelectorAll('details[data-persist]')) item.open = expanded.has(item.dataset.persist);
  for (const item of container.querySelectorAll('details[data-collapse]')) item.open = !collapsed.has(item.dataset.collapse);
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
  if ($('workspace-pane')?.hidden) return;
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
    row.title = 'Arrow keys: select device. Enter: connect. Escape: cancel connection.';
    row.setAttribute('aria-pressed', String(selected === deviceKey(device)));
    const icon = node('span', 'device-icon', '◇'); icon.setAttribute('aria-hidden', 'true');
    const info = node('span', 'device-info');
    info.append(node('span', 'device-name', `${device.favorite ? '★ ' : ''}${deviceDisplayName(device)}`));
    if (deviceDisplayName(device) !== device.address) info.append(node('span', 'device-address', device.address));
    const recorder = NanoRecorders.identify(device);
    if (recorder) info.append(node('span', 'device-vendor', recorder.product));
    const vendor = vendorTools.identify(device, vendorDatabase);
    if (vendor.hint && !recorder) info.append(node('span', 'device-vendor', vendor.hint));
    const signal = node('span', 'signal', `${device.rssi} dBm`);
    signal.append(node('small', '', state.ble.connected && NanoDeviceLibrary.connected(device, state) ? 'Connected' : device.connectable ? 'Connectable' : 'Broadcast'));
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
  lastRender = Date.now();
  NanoSensorApp.update(browseDevices());
  rememberGattName(state);
  if (typeof retainGattResults === 'function') retainGattResults();
  NanoLab.update(state, online);
  NanoLab.setBackgroundCapture(backgroundPolling());
  const scanning = state.ble.scanning;
  const usbConnected = NanoAPI.transport() === 'serial' && online;
  $('network').textContent = usbConnected ? `USB connected${state.wifi.suspendedForUsb ? ' · Wi-Fi paused' : ''}` : online ? (state.wifi.connected ? `${state.wifi.ssid} · ${state.wifi.ip}` : 'Wi-Fi disconnected') : 'Board unavailable';
  $('network-dot').classList.toggle('online', online && (usbConnected || state.wifi.connected));
  $('scan').disabled = !canScan(state, online, pending);
  $('scan').title = state.collection?.enabled ? 'Collection controls are in Settings. Hold the board button for 3 seconds to stop.' : state.usb?.mode === 'hci' ? 'Restore Bluetooth workbench in Settings.' : '';
  $('scan-label').textContent = scanning ? 'Stop scan' : 'Scan';
  $('scan').setAttribute('aria-label', scanning ? 'Stop scanning' : 'Start scanning');
  $('scan-indicator').hidden = !scanning;
  $('count').textContent = scanStore?.status().count ?? state.devices.length;
  $('scan-status').textContent = pending ? 'Sending request…' : state.collection?.enabled ? `${state.collection.active ? 'Active' : 'Passive'} collection · ${state.collection.status} · ${state.collection.recordCount} records` : scanStatus(state.ble);
  const error = transportError || notice || state.ble.error;
  $('notice').hidden = !error; $('notice-text').textContent = error || '';
  $('retry').hidden = online; $('retry').disabled = pending;
  $('board-status').textContent = online ? `Board online · ${Math.floor((state.freeHeap || 0) / 1024)} KB free` : NanoAPI.transport() === 'serial' ? 'Connect USB in Settings' : 'Reconnect to the board’s Wi-Fi network';
  renderList(); renderInspector();
  const device = selectedDevice();
  const workspaceDevice = NanoWorkspace.view() === 'apps' && NanoWorkspace.module() ? NanoModules.appDevice(NanoWorkspace.module()) : device;
  NanoWorkspace.update({ device: workspaceDevice, state: { ...state, devices: browseDevices() }, online, pending, error, connected: NanoDeviceLibrary.connected(workspaceDevice, state) });
  NanoDevicePage.render();
  if (NanoWorkspace.view() === 'apps') NanoModules.render(device, browseDevices());
  browserUI?.update();
  if (NanoWorkspace.view() === 'insights') NanoInsights.render($('insights-content'), selectedDevice(), browseDevices(), selectDevice, category => browserUI.setKind(category), state);
}
async function request(path, options = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await NanoAPI.fetch(path, { ...options, signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  } finally { clearTimeout(timeout); options.signal?.removeEventListener('abort', cancel); }
}
function poll({ streamOnly = false } = {}) {
  if (pollPromise) return pollPromise;
  const generation = apiGeneration, revision = stateRevision;
  const pollingController = stateController = new AbortController();
  pollPromise = (async () => {
    const sessionWasActive = activeSession();
    try {
      if (!streamOnly || needsStatePoll(state, online, pending, Date.now() - lastStatePoll)) {
        const next = await request('state?devices=0', { signal: pollingController.signal });
        if (generation !== apiGeneration || revision !== stateRevision) return;
        state = next; online = true; lastStatePoll = Date.now();
        scanStore?.ingest(state);
      }
      if (state.ble.advertisementStream && state.ble.scanning && !state.ble.busy && !state.ble.connected) {
        await scanStream.poll();
        if (generation !== apiGeneration) return;
        if (scanStream.status().supported === false) {
          const full = await request('state', { signal: pollingController.signal });
          if (generation !== apiGeneration || revision !== stateRevision) return;
          state = full; scanStore?.ingest(state);
        }
      }
      transportError = '';
      if (!selected && state.ble.connected) {
        const device = browseDevices().find(item => NanoDeviceLibrary.connected(item, state));
        if (device) selected = deviceKey(device);
      }
    } catch (error) {
      if (generation !== apiGeneration || revision !== stateRevision) return;
      if (error.name === 'AbortError' && online && NanoAPI.transport() === 'serial' && NanoAPI.serialStatus().connected) {
        transportError = 'USB is connected. Board status refresh is delayed; waiting for the next update.';
      } else {
        online = false;
        scanStore?.setOffline();
        transportError = NanoAPI.transport() === 'serial' ? NanoAPI.serialStatus().error || 'USB is unavailable. Connect the board in Settings.' : error.name === 'AbortError' ? 'The board took too long to respond. Check its power and Wi-Fi connection.' : 'Cannot reach the board. Check its power and connect to the same Wi-Fi network.';
      }
    } finally {
      if (generation === apiGeneration) {
        NanoPWA.reportConnection(online);
        if (!streamOnly || (!document.hidden || sessionWasActive || activeSession()) && Date.now() - lastRender >= 500) render();
      }
    }
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
  if ((document.hidden && !backgroundPolling()) || ticking) return;
  ticking = true;
  const generation = apiGeneration;
  try { await poll({ streamOnly: true }); } finally { ticking = false; }
  if (generation !== apiGeneration) return;
  const collecting = !document.hidden || backgroundPolling();
  const delay = online && activeSession() ? 1000 : collecting && online && state.ble.scanning && state.ble.advertisementStream ? Math.max(document.hidden ? 1000 : 0, scanStream.status().delay) : NanoPWA.pollDelay({ background: backgroundPolling() });
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
      database = vendorTools.expand(await response.json());
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
  scanStream = NanoScanStream.create(scanStore);
  selected = scanStore.getPreference('selectedDevice', '');
  browserUI = NanoBrowserUI.mount(scanStore, { change: () => { listSignature = ''; detailSignature = ''; render(); tick(); }, getSelected: selectedDevice, getState: () => state });
  document.addEventListener('nanoscope:state', event => { stateRevision++; state = event.detail; scanStore.ingest(state); online = true; transportError = ''; render(); });
  document.addEventListener('nanoscope:busy', event => { if (event.detail) stateRevision++; pending = event.detail; render(); });
  globalThis.addEventListener('nanoscope:api-change', () => {
    apiGeneration++; stateController?.abort(); scanStream.reset();
    clearTimeout(timer);
    state = { wifi: {}, ble: {}, devices: [], services: [] };
    online = false; pending = false; transportError = NanoAPI.transport() === 'serial' ? NanoAPI.configured() ? 'Checking the USB board.' : 'Connect USB in Settings.' : NanoAPI.configured() ? 'Checking the new board endpoint.' : 'Set the private board endpoint in Settings.';
    scanStore?.setOffline(); NanoLab.update(state, false); render();
    Promise.resolve(pollPromise).finally(tick);
  });
  NanoLab.init();
  NanoCredentials.init();
  NanoConnection.init({ state: () => state, online: () => online, pending: () => pending, selected: selectedDevice, devices: browseDevices, refresh: poll, select: selectDevice, action: NanoLab.action, recorder: NanoRecorders.identify, changed: render, notice: message => { notice = message; } });
  NanoSettings.mount();
  NanoCredentialsUI.mount($('credentials-panel'));
  NanoAPIUI.mount($('api-panel'));
  NanoActivityLedUI.mount($('activity-led-panel'), NanoLab);
  NanoCatalogs.init({ hosted: Boolean(document.querySelector('meta[name="nanoscope-hosted"]')) });
  NanoMetadataUI.mount($('metadata-panel'));
  NanoCatalogUI.mount($('metadata-panel'));
  globalThis.addEventListener('nanoscope:catalogs', () => { listSignature = ''; detailSignature = ''; render(); });
  NanoMetadata.init();
  globalThis.addEventListener('nanoscope:metadata', () => { detailSignature = ''; render(); });
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
  NanoWorkspace.init({ getPreference: (key, fallback) => scanStore.getPreference(key, fallback), setPreference: (key, value) => scanStore.setPreference(key, value),
    getSelected: selectedDevice, selectDevice, resolveTarget: key => browseDevices().find(item => deviceKey(item) === key),
    getDeviceDisplay: device => {
      const recorder = NanoRecorders.identify(device), vendor = vendorTools.identify(device, vendorDatabase);
      return { name: deviceDisplayName(device), manufacturer: NanoSchlage.identify(device, state) ? 'Schlage' : recorder?.product.split(' ')[0] || vendor.manufacturer || vendor.addressVendor };
    },
    selectModuleTarget: (id, device, restored) => NanoModules.selectAppDevice(id, device, restored),
    getModuleTarget: id => NanoModules.matches(selectedDevice()).includes(id) ? selectedDevice() : NanoModules.appDevice(id), onChange: render, onPaneOpen: renderList });
  $('scan').addEventListener('click', () => mutate(scanAction(state.ble)));
  $('search').addEventListener('input', renderList);
  $('devices').tabIndex = 0;
  document.addEventListener('keydown', handleDeviceKeyboard);
  $('retry').addEventListener('click', tick);
  document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (!document.hidden || backgroundPolling()) tick(); });
  tick(); loadVendors();
}
if (typeof module !== 'undefined') module.exports = { deviceDisplayName, rememberGattName, handleDeviceKeyboard, deviceKey, visibleDevices, canScan, canConnect, canRead, shortUuid, uuidName, operationLabel, scanAction, scanStatus, lastSeenLabel, needsStatePoll };
if (typeof document !== 'undefined') boot();
