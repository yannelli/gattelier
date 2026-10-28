'use strict';

const NanoConnection = (() => {
  const address = device => String(device?.address || '').toLowerCase();
  const same = (a, b) => address(a) === address(b) && a?.addressType === b?.addressType;
  const name = device => typeof deviceDisplayName === 'function' ? deviceDisplayName(device) : device?.label || device?.name || device?.address || 'Device';
  let hooks, inFlight = false, attempt = null, cancelling = false;
  function snapshot() {
    return { state: hooks.state(), selected: hooks.selected(), online: hooks.online(), pending: hooks.pending() || inFlight };
  }
  function connectedDevice(context = snapshot()) {
    if (!context.state.ble.connected) return null;
    const target = context.state.ble.address?.toLowerCase();
    return (hooks?.devices() || context.state.devices || []).find(item => same(item, context.state.ble))
      || (same(context.selected, context.state.ble) ? context.selected : null) || { address: target, addressType: context.state.ble.addressType, name: target };
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
    const ble = context.state.ble || {}, connected = Boolean(device && ble.connected && same(device, ble));
    const live = (context.state.devices || []).find(item => same(item, device)) || (device?.streamLive ? device : null);
    const facts = [];
    if (connected && Number.isFinite(ble.mtu) && ble.mtu > 0) facts.push(`MTU ${ble.mtu}`);
    const security = context.state.security;
    if (connected && security && address(security) === address(ble) && (security.addressType === undefined || security.addressType === ble.addressType) && typeof security.encrypted === 'boolean') facts.push(security.encrypted ? 'Encrypted' : 'Unencrypted');
    const identifying = (context.state.services || []).some(service => (service.characteristics || []).some(item => typeof item.valueHex === 'string' || item.descriptors?.some(descriptor => typeof descriptor.valueHex === 'string')));
    const discovery = Array.isArray(context.state.services) ? `${identifying ? 'Identifying device' : 'Discovering services'} · ${context.state.services.length} found` : 'Discovering services';
    const result = { details: facts.join(' · '), connected, live, enabled: false, label: connected ? 'Disconnect' : 'Connect', status: connected ? 'Connected' : 'Disconnected', reason: '' };
    if (!device) return { ...result, status: 'Choose a device in Discover', reason: '' };
    if (!context.online) return { ...result, status: 'Board offline', reason: 'Reconnect the board first.' };
    if (context.state.usb?.mode === 'hci') return { ...result, status: 'USB controller mode', reason: 'Restore Bluetooth workbench mode in Settings to connect from this page.' };
    const local = inFlight && attempt && same(attempt.device, device), remote = ble.busy && ['connecting', 'discovering', 'cancelling'].includes(ble.operation) && address(device) === String(ble.address).toLowerCase() && device.addressType === ble.addressType && Number.isInteger(ble.connectionAttempt) && ble.connectionAttempt > 0;
    if (!context.checking && (local || remote)) {
      const stopping = cancelling || local && attempt.cancelled || remote && ble.operation === 'cancelling';
      return { ...result, enabled: !stopping, cancel: true, label: stopping ? 'Cancelling...' : 'Cancel connection', status: stopping ? 'Cancelling' : remote && ble.operation === 'discovering' ? discovery : 'Connecting', reason: stopping ? 'Waiting for the connection attempt to stop.' : 'Stop this connection attempt.' };
    }
    if (context.pending || ble.busy) return { ...result, status: connected ? 'Connected' : 'Working', reason: `${ble.operation || 'Bluetooth operation'} in progress…` };
    if (connected) return { ...result, enabled: true, reason: context.state.security?.active ? 'Pairing needs attention in Security.' : '' };
    if ((live || device).connectable === false) return { ...result, status: 'Broadcast only', reason: 'This advertisement does not accept a BLE connection.' };
    if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(address(device)) || !Number.isInteger(device.addressType) || device.addressType < 0 || device.addressType > 3) return { ...result, reason: 'This record has no usable Bluetooth address type.' };
    if (ble.connected) return { ...result, enabled: true, label: 'Switch and connect', status: 'Another device connected', reason: `Disconnects ${name(connectedDevice(context))} and connects this device.` };
    return { ...result, enabled: true, label: live ? 'Connect' : 'Try known address', status: live ? 'Available' : 'Saved device', reason: live ? '' : 'Not in the current scan. Private addresses can change.' };
  }
  async function ensure(device, identify = false) {
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
      // Only a user's Connect asks the board to read identity values; apps keep their own connection timing.
      if (identify) body.identify = true;
      currentAttempt.posted = true;
      const result = await hooks.action('connect', body);
      if (!result.ble.connected || !same(device, result.ble)) throw new Error(result.ble.error || 'The device did not establish a connection. Try again.');
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
    try { const status = describe(device); if (status.cancel) await cancel(device); else if (status.connected) await disconnect(); else await ensure(device, true); }
    catch (error) { hooks.notice(error.message); }
    finally { hooks.changed(); }
  }
  function controls(device, focus = 'connection') {
    const status = describe(device), root = document.createElement('div'); root.className = 'connection-controls';
    const info = document.createElement('div'), label = document.createElement('strong'), reason = document.createElement('p');
    info.setAttribute('role', 'status'); info.setAttribute('aria-live', 'polite');
    label.textContent = status.status; reason.textContent = status.reason; reason.className = 'hint'; info.append(label); if (status.reason) info.append(reason);
    if (status.details) { const details = document.createElement('p'); details.className = 'hint'; details.textContent = status.details; info.append(details); }
    const action = document.createElement('button'); action.type = 'button'; action.className = `button ${status.connected ? 'secondary' : 'primary'}`;
    action.textContent = status.label; action.disabled = !status.enabled; action.title = status.cancel ? 'Cancel connection (Escape)' : status.reason; action.dataset.focus = focus;
    action.addEventListener('click', () => perform(device)); root.append(info, action); return root;
  }
  return { init(options) { hooks = options; }, snapshot, describe, connectedDevice, pendingDevice, ensure, disconnect, cancel, perform, controls };
})();
if (typeof module !== 'undefined') module.exports = NanoConnection;
