'use strict';

const NanoConnection = (() => {
  const address = device => String(device?.address || '').toLowerCase();
  const same = (a, b) => address(a) === address(b) && a?.addressType === b?.addressType;
  const name = device => device?.label || device?.name || device?.address || 'Device';
  let hooks, inFlight = false, attempt = null, cancelling = false;
  function snapshot() {
    return { state: hooks.state(), selected: hooks.selected(), online: hooks.online(), pending: hooks.pending() || inFlight };
  }
  function connectedDevice(context = snapshot()) {
    if (!context.state.ble.connected) return null;
    const target = context.state.ble.address?.toLowerCase();
    return (hooks?.devices() || context.state.devices || []).find(item => address(item) === target)
      || (address(context.selected) === target ? context.selected : null) || { address: target, name: target };
  }
  function pendingDevice(context = snapshot()) {
    const ble = context.state.ble || {};
    if (ble.busy && ['connecting', 'discovering', 'cancelling'].includes(ble.operation)) {
      return (hooks?.devices() || context.state.devices || []).find(item => address(item) === String(ble.address).toLowerCase() && item.addressType === ble.addressType)
        || { address: ble.address, addressType: ble.addressType, name: ble.address };
    }
    return inFlight && attempt ? attempt.device : null;
  }
  function describe(device, context = snapshot()) {
    const ble = context.state.ble || {}, connected = Boolean(device && ble.connected && address(device) === String(ble.address).toLowerCase());
    const live = (context.state.devices || []).find(item => same(item, device)) || (device?.streamLive ? device : null);
    const result = { connected, live, enabled: false, label: connected ? 'Disconnect' : 'Connect', status: connected ? 'Connected' : 'Disconnected', reason: '' };
    if (!device) return { ...result, status: 'Choose a device in Discover', reason: '' };
    if (!context.online) return { ...result, status: 'Board offline', reason: 'Reconnect the board first.' };
    if (context.state.usb?.mode === 'hci') return { ...result, status: 'USB controller mode', reason: 'Restore Bluetooth workbench mode in Settings to connect from this page.' };
    const local = inFlight && attempt && same(attempt.device, device), remote = ble.busy && ['connecting', 'discovering', 'cancelling'].includes(ble.operation) && address(device) === String(ble.address).toLowerCase() && device.addressType === ble.addressType && Number.isInteger(ble.connectionAttempt) && ble.connectionAttempt > 0;
    if (!context.checking && (local || remote)) {
      const stopping = cancelling || local && attempt.cancelled || remote && ble.operation === 'cancelling';
      return { ...result, enabled: !stopping, cancel: true, label: stopping ? 'Cancelling...' : 'Cancel connection', status: stopping ? 'Cancelling' : remote && ble.operation === 'discovering' ? 'Discovering services' : 'Connecting', reason: stopping ? 'Waiting for the connection attempt to stop.' : 'Stop this connection attempt.' };
    }
    if (context.pending || ble.busy) return { ...result, status: connected ? 'Connected' : 'Working', reason: `${ble.operation || 'Bluetooth operation'} in progress…` };
    if (connected) return { ...result, enabled: true, reason: context.state.security?.active ? 'Pairing needs attention in Security.' : '' };
    if ((live || device).connectable === false) return { ...result, status: 'Broadcast only', reason: 'This advertisement does not accept a BLE connection.' };
    if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(address(device)) || !Number.isInteger(device.addressType) || device.addressType < 0 || device.addressType > 3) return { ...result, reason: 'This record has no usable Bluetooth address type.' };
    if (ble.connected) return { ...result, enabled: true, label: 'Switch and connect', status: 'Another device connected', reason: `Disconnects ${name(connectedDevice(context))} and connects this device.` };
    return { ...result, enabled: true, label: live ? 'Connect' : 'Try known address', status: live ? 'Available' : 'Saved device', reason: live ? '' : 'Not in the current scan. Private addresses can change.' };
  }
  async function ensure(device) {
    if (inFlight) throw new Error('A connection change is already running.');
    inFlight = true; const currentAttempt = attempt = { device, cancelled: false, posted: false }; hooks.changed();
    try {
      await hooks.refresh();
      if (currentAttempt.cancelled) throw new Error('Connection cancelled.');
      const context = { ...snapshot(), pending: hooks.pending(), checking: true }, status = describe(device, context);
      if (status.connected && context.online && !context.pending && !context.state.ble.busy) return context.state;
      if (!status.enabled) throw new Error(status.reason);
      hooks.select(device); hooks.changed();
      if (context.state.ble.connected) await hooks.action('disconnect');
      if (currentAttempt.cancelled) throw new Error('Connection cancelled.');
      const current = snapshot().state;
      if (current.ble.connected) throw new Error('The current device did not disconnect.');
      const live = (current.devices || []).find(item => same(item, device));
      const body = { address: address(device), addressType: device.addressType };
      if (!live && hooks.recorder?.(device)?.product.includes('PLAUD')) body.scope = 'plaud';
      currentAttempt.posted = true;
      const result = await hooks.action('connect', body);
      if (!result.ble.connected || String(result.ble.address).toLowerCase() !== address(device)) throw new Error(result.ble.error || 'The device did not establish a connection. Try again.');
      return result;
    } finally { inFlight = false; attempt = null; hooks.changed(); }
  }
  async function cancel(device) {
    const status = describe(device);
    if (!status.cancel || !status.enabled) throw new Error(status.reason || 'This connection attempt is no longer active.');
    const local = attempt && same(attempt.device, device) ? attempt : null;
    cancelling = true; hooks.changed();
    try {
      if (local && !local.posted) { local.cancelled = true; return; }
      const ble = snapshot().state.ble || {};
      const body = { address: address(device), addressType: device.addressType };
      if (ble.busy && address(device) === String(ble.address).toLowerCase() && device.addressType === ble.addressType) body.connectionAttempt = ble.connectionAttempt;
      return await hooks.action('cancel-connect', body);
    } finally { cancelling = false; hooks.changed(); }
  }
  async function disconnect() {
    if (inFlight) throw new Error('A connection change is already running.');
    inFlight = true; hooks.changed();
    try {
      await hooks.refresh();
      const context = { ...snapshot(), pending: hooks.pending() }, status = describe(connectedDevice(context), context);
      if (!status.connected) throw new Error('No device is connected.');
      if (!status.enabled) throw new Error(status.reason);
      return await hooks.action('disconnect');
    }
    finally { inFlight = false; hooks.changed(); }
  }
  async function perform(device) {
    hooks.notice('');
    try { const status = describe(device); if (status.cancel) await cancel(device); else if (status.connected) await disconnect(); else await ensure(device); }
    catch (error) { hooks.notice(error.message); }
    finally { hooks.changed(); }
  }
  function controls(device, focus = 'connection') {
    const status = describe(device), root = document.createElement('div'); root.className = 'connection-controls';
    const info = document.createElement('div'), label = document.createElement('strong'), reason = document.createElement('p');
    label.textContent = status.status; reason.textContent = status.reason; reason.className = 'hint'; info.append(label); if (status.reason) info.append(reason);
    const action = document.createElement('button'); action.type = 'button'; action.className = `button ${status.connected ? 'secondary' : 'primary'}`;
    action.textContent = status.label; action.disabled = !status.enabled; action.title = status.reason; action.dataset.focus = focus;
    action.addEventListener('click', () => perform(device)); root.append(info, action); return root;
  }
  return { init(options) { hooks = options; }, snapshot, describe, connectedDevice, pendingDevice, ensure, disconnect, cancel, perform, controls };
})();
if (typeof module !== 'undefined') module.exports = NanoConnection;
