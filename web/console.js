'use strict';

const NanoConsole = (() => {
  let api, latest = { ble: {}, services: [] }, online = false, signature = '', history = [];
  const notificationCounts = new Map();
  let offEvents, notificationBoot, notificationSeq = 0, notificationSession = null, notificationGeneration = 0, notificationUptime;
  const notificationKey = item => `${notificationSession?.key}/${String(item.uuid || '').toLowerCase()}/${item.handle}`;
  const notificationText = key => notificationSession?.ready && notificationCounts.has(key) && key.startsWith(`${notificationSession.key}/`)
    ? `Captured notifications: ${notificationCounts.get(key)}` : '';
  function refreshCounts() {
    for (const count of document.querySelectorAll('[data-notification-key]')) count.textContent = notificationText(count.dataset.notificationKey);
  }
  function resetCounts() { notificationCounts.clear(); notificationSession = null; refreshCounts(); }
  function trackConnection(state, available) {
    if (Number.isFinite(state.uptime) && state.uptime < notificationUptime) resetCounts();
    notificationUptime = state.uptime;
    const ble = state.ble || {};
    const key = available && ble.connected ? JSON.stringify([notificationGeneration, state.bootId, String(ble.address || '').toLowerCase(), ble.addressType, ble.connectionAttempt]) : null;
    if (key !== (notificationSession?.key || null)) {
      resetCounts();
      if (key) notificationSession = { key, minMs: Number.isFinite(state.uptime) ? (Math.floor(state.uptime) + 1) * 1000 : null, ready: false, blocked: false };
    }
  }
  function watchNotifications() {
    offEvents?.();
    const generation = notificationGeneration;
    offEvents = api.onEvents?.((events, meta = {}) => {
      if (generation !== notificationGeneration) return;
      const first = notificationBoot === undefined;
      if (meta.reboot || !first && meta.bootId !== notificationBoot) { resetCounts(); notificationSeq = 0; }
      notificationBoot = meta.bootId;
      for (const event of events) {
        if (!Number.isInteger(event.seq) || event.seq <= notificationSeq) continue;
        notificationSeq = event.seq;
        const session = notificationSession, ble = latest.ble;
        if (first || !session || session.blocked || session.minMs === null || !Number.isFinite(event.ms) || event.ms < session.minMs) continue;
        if (event.bootId !== undefined && event.bootId !== notificationBoot || latest.bootId !== undefined && latest.bootId !== notificationBoot) continue;
        if (['connect', 'disconnect'].includes(event.kind) || meta.dropped > 0) {
          session.blocked = true; session.ready = false; notificationCounts.clear(); continue;
        }
        if (!['notification', 'indication'].includes(event.kind) || event.success === false) continue;
        if (String(event.address || '').toLowerCase() !== String(ble.address || '').toLowerCase()) continue;
        if (event.addressType !== undefined && event.addressType !== ble.addressType || event.connectionAttempt !== undefined && event.connectionAttempt !== ble.connectionAttempt) continue;
        if (!characteristics().some(item => item.handle === event.handle && item.uuid.toLowerCase() === String(event.uuid || '').toLowerCase())) continue;
        session.ready = true;
        const key = notificationKey(event); notificationCounts.set(key, (notificationCounts.get(key) || 0) + 1);
      }
      refreshCounts();
    });
  }
  function changeNotificationAPI() {
    notificationGeneration++; notificationBoot = undefined; notificationSeq = 0; notificationUptime = undefined;
    resetCounts(); watchNotifications();
  }
  const el = (tag, className, text) => { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; };
  const get = id => document.getElementById(`console-${id}`);
  const characteristics = () => (latest.services || []).flatMap(service => service.characteristics || []);
  const writable = item => item.properties.includes('write') || item.properties.includes('write-no-response');
  const unavailable = () => !online || !latest.ble.connected || latest.ble.busy || api.isActing();
  function notify(message, error = false) { get('status').textContent = message; get('status').classList.toggle('error', error); }
  function button(label, callback, disabled = false) {
    const item = el('button', 'button secondary', label); item.type = 'button'; item.disabled = disabled;
    item.addEventListener('click', callback); return item;
  }
  function modes() {
    const characteristic = characteristics().find(item => item.handle === Number(get('handle').value));
    const options = get('response').options;
    options[0].disabled = !characteristic?.properties.includes('write');
    options[1].disabled = !characteristic?.properties.includes('write-no-response');
    if (get('response').selectedOptions[0]?.disabled) get('response').value = !options[0].disabled ? 'true' : 'false';
    get('send').disabled = unavailable() || !characteristic;
    get('limit').textContent = `MTU ${latest.ble.mtu || 23} · With response: 512 bytes · Without response: ${Math.min(512, (latest.ble.mtu || 23) - 3)} bytes`;
  }
  function update(state, available) {
    trackConnection(state, available); latest = state; online = available;
    if (!get('handle')) return;
    const items = characteristics().filter(writable);
    const next = JSON.stringify([latest.ble.address, latest.ble.addressType, items.map(item => [item.handle, item.uuid, item.properties])]);
    if (signature !== next) {
      signature = next; const selected = get('handle').value;
      get('handle').replaceChildren(...items.map(item => { const option = el('option', '', `${item.handle} · ${item.uuid}`); option.value = item.handle; return option; }));
      if (items.some(item => String(item.handle) === selected)) get('handle').value = selected;
    }
    get('handle').disabled = unavailable() || !items.length;
    get('response').disabled = unavailable() || !items.length;
    get('replay').disabled = unavailable() || !history.some(item => item.hex && NanoDeviceLibrary.connected(item, latest));
    modes();
  }
  function renderHistory() {
    get('history').replaceChildren(...history.map((item, index) => {
      const label = item.redacted ? 'Authentication command · redacted' : `${item.handle} · ${item.hex.slice(0, 36)}${item.hex.length > 36 ? '…' : ''} · ${item.response ? 'response' : 'no response'}`;
      const option = el('option', '', label); option.value = index; option.disabled = item.redacted; return option;
    }));
  }
  async function send(command) {
    try {
      if (unavailable()) throw new Error('Connect to a device and wait for the current operation.');
      const handle = command?.handle ?? Number(get('handle').value);
      const characteristic = characteristics().find(item => item.handle === handle);
      const response = command?.response ?? get('response').value === 'true';
      if (!characteristic?.properties.includes(response ? 'write' : 'write-no-response')) throw new Error('This characteristic does not support the selected write mode.');
      if (command && (!NanoDeviceLibrary.connected(command, latest) || command.uuid !== characteristic.uuid)) throw new Error('Replay belongs to a different device or characteristic.');
      const data = NanoPackets.payload(command?.hex ?? get('payload').value, command ? 'hex' : get('format').value, response, latest.ble.mtu || 23);
      const redacted = NanoPackets.sensitive(data.hex, characteristic?.uuid);
      history.unshift({ handle, uuid: characteristic.uuid, response, address: latest.ble.address, addressType: latest.ble.addressType, hex: redacted ? '' : data.hex, redacted });
      history = history.slice(0, 12); renderHistory();
      notify(`Sending ${data.length} bytes to handle ${handle}…`);
      await api.action('write', { handle, hex: data.hex, response });
      notify(`${data.length} bytes sent to handle ${handle}${response ? ' with response.' : ' without response.'}`);
    } catch (error) { notify(error.message, true); }
    finally { update(latest, online); }
  }
  function select(handle) {
    NanoWorkspace.openTool('command');
    get('handle').value = String(handle); modes();
    document.getElementById('command-panel').scrollIntoView({ behavior: 'auto', block: 'center' });
    get('payload').focus();
  }
  async function perform(path, body) {
    try { await api.action(path, body); }
    catch (error) { notify(error.message, true); get('status').scrollIntoView({ block: 'nearest' }); }
  }
  function characteristicActions(characteristic, readOnly = false) {
    const section = el('div', 'characteristic-tools');
    const controls = el('div', 'lab-actions');
    const target = { address: latest.ble.address, addressType: latest.ble.addressType };
    const allowed = () => !readOnly && !unavailable() && NanoDeviceLibrary.connected(target, latest);
    const act = (path, body) => { if (allowed()) return perform(path, body); };
    if (writable(characteristic)) {
      const write = button('Write…', () => { if (allowed()) select(characteristic.handle); }, !allowed());
      write.dataset.focus = `${characteristic.handle}-write`; controls.append(write);
    }
    const modes = ['notify', 'indicate'].filter(mode => characteristic.properties.includes(mode));
    if (modes.length) {
      const subscribed = modes.includes(characteristic.subscription);
      let mode = subscribed ? characteristic.subscription : modes[0];
      if (modes.length === 2) {
        const choice = el('select'); choice.setAttribute('aria-label', 'Subscription mode');
        choice.dataset.focus = `${characteristic.handle}-subscription-mode`;
        for (const value of modes) { const option = el('option', '', value === 'notify' ? 'Notify' : 'Indicate'); option.value = value; choice.append(option); }
        choice.value = mode; choice.disabled = !allowed() || subscribed;
        choice.addEventListener('change', () => { mode = choice.value; }); controls.append(choice);
      }
      const toggle = button(subscribed ? 'Subscribed' : 'Subscribe', () => {
        const current = characteristics().find(item => item.handle === characteristic.handle && item.uuid === characteristic.uuid);
        if (current) return act('subscribe', { handle: characteristic.handle, mode: modes.includes(current.subscription) ? 'off' : mode });
      }, !allowed());
      toggle.dataset.focus = `${characteristic.handle}-subscription`;
      toggle.setAttribute('aria-pressed', String(subscribed)); controls.append(toggle);
      if (typeof api.onEvents === 'function' && !readOnly) {
        const count = el('span', 'vendor-note'); count.dataset.notificationKey = notificationKey({ ...characteristic, ...target });
        count.textContent = notificationText(count.dataset.notificationKey); controls.append(count);
      }
    }
    if (controls.childElementCount) section.append(controls);
    if (characteristic.descriptors?.length) {
      const details = el('details', 'descriptor-list'); details.dataset.persist = `descriptors-${target.address}/${target.addressType}-${characteristic.handle}`; details.append(el('summary', '', `Descriptors · ${characteristic.descriptors.length}`));
      for (const descriptor of characteristic.descriptors) {
        const name = typeof NanoMetadata !== 'undefined' ? NanoMetadata.lookup(descriptor.uuid)?.name : '';
        const row = el('div', 'descriptor'), label = el('div'), read = button('Read', () => act('read', { handle: descriptor.handle }), !allowed());
        read.dataset.focus = `descriptor-${descriptor.handle}`;
        label.append(el('p', '', name || 'Unknown descriptor'), el('p', 'mono', `${descriptor.handle} · ${descriptor.uuid}`)); row.append(label, read); details.append(row);
        if (typeof descriptor.valueHex !== 'string') continue;
        const decoded = typeof NanoGattValues !== 'undefined' ? NanoGattValues.decode(descriptor.uuid, descriptor.valueHex) : [];
        if (decoded.length) details.append(el('p', 'descriptor-value', decoded.map(field => `${field.label}: ${field.value}`).join('\n')));
        const raw = el('details', 'raw-details'); raw.dataset.persist = `descriptor-value-${target.address}/${target.addressType}-${descriptor.handle}`;
        raw.append(el('summary', '', `Raw value · ${descriptor.valueHex.length / 2} bytes`), el('p', 'mono', descriptor.valueHex || '(empty value)')); details.append(raw);
      }
      section.append(details);
    }
    return section;
  }
  function advertisement(device, state, available) {
    const section = el('div', 'advertisement-tools');
    const capturing = state.ble.captureAddress === device.address || state.captureAddress === device.address;
    const toggle = button(capturing ? 'Stop advertisement capture' : 'Capture advertisements', () => perform('capture', { address: capturing ? '' : device.address }), !available || api.isActing());
    toggle.dataset.focus = `capture-${device.address}`; toggle.setAttribute('aria-pressed', String(capturing)); section.append(toggle);
    const details = el('details', 'advertisement-raw'); details.dataset.persist = `advertisement-${device.address}`; details.append(el('summary', '', 'Raw advertisement & service data'));
    details.append(el('p', 'vendor-note', `Advertisement type: ${device.advType ?? 'Unknown'} · TX power: ${device.txPower ?? 'Not advertised'}${device.txPower == null ? '' : ' dBm'}`));
    details.append(el('pre', 'mono', device.payloadHex || 'No raw payload available.'));
    for (const entry of device.serviceData || []) {
      details.append(el('p', 'uuid', entry.uuid), el('pre', 'mono', entry.hex || '(empty)'));
    }
    section.append(details); return section;
  }
  function mount(container, sharedApi) {
    offEvents?.(); api = sharedApi;
    globalThis.removeEventListener?.('nanoscope:api-change', changeNotificationAPI);
    globalThis.addEventListener?.('nanoscope:api-change', changeNotificationAPI);
    changeNotificationAPI();
    container.innerHTML = '<div class="panel-heading"><div><h2>Command console</h2></div></div><div class="lab-body"><div class="console-grid"><label>Characteristic handle<select id="console-handle" aria-label="Writable characteristic handle"></select></label><label>Write mode<select id="console-response"><option value="true">With response</option><option value="false">Without response</option></select></label><label>Input format<select id="console-format"><option value="hex">HEX bytes</option><option value="utf8">UTF-8 text</option></select></label></div><label class="payload-label" for="console-payload">Payload</label><textarea id="console-payload" rows="3" spellcheck="false" placeholder="01 02 03"></textarea><div class="console-footer"><p id="console-limit" class="vendor-note"></p><button id="console-send" class="button primary" type="button">Send command</button></div><div class="history-row"><label>Recent commands<select id="console-history"></select></label><button id="console-replay" class="button secondary" type="button">Replay selected</button></div><p id="console-status" class="lab-status" role="status">Connect to a writable characteristic.</p></div>';
    get('handle').addEventListener('change', modes); get('response').addEventListener('change', modes);
    get('send').addEventListener('click', () => send());
    get('replay').addEventListener('click', () => { const command = history[Number(get('history').value)]; if (command?.hex) send(command); });
    update(latest, online);
  }
  return { mount, update, select, characteristicActions, advertisement };
})();
