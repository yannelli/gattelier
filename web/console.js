'use strict';

const NanoConsole = (() => {
  let api, latest = { ble: {}, services: [] }, online = false, signature = '', history = [];
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
    latest = state; online = available;
    if (!get('handle')) return;
    const items = characteristics().filter(writable);
    const next = JSON.stringify([latest.ble.address, items.map(item => [item.handle, item.uuid, item.properties])]);
    if (signature !== next) {
      signature = next; const selected = get('handle').value;
      get('handle').replaceChildren(...items.map(item => { const option = el('option', '', `${item.handle} · ${item.uuid}`); option.value = item.handle; return option; }));
      if (items.some(item => String(item.handle) === selected)) get('handle').value = selected;
    }
    get('handle').disabled = unavailable() || !items.length;
    get('response').disabled = unavailable() || !items.length;
    get('replay').disabled = unavailable() || !history.some(item => item.hex && item.address === latest.ble.address);
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
      if (command && command.address !== latest.ble.address) throw new Error('Replay belongs to a different device.');
      const data = NanoPackets.payload(command?.hex ?? get('payload').value, command ? 'hex' : get('format').value, response, latest.ble.mtu || 23);
      const redacted = NanoPackets.sensitive(data.hex, characteristic?.uuid);
      history.unshift({ handle, response, address: latest.ble.address, hex: redacted ? '' : data.hex, redacted });
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
  function characteristicActions(characteristic) {
    const section = el('div', 'characteristic-tools');
    const controls = el('div', 'lab-actions');
    if (writable(characteristic)) controls.append(button('Write…', () => select(characteristic.handle), unavailable()));
    for (const [property, mode, label] of [['notify', 'notify', 'Notify'], ['indicate', 'indicate', 'Indicate']]) {
      if (characteristic.properties.includes(property)) controls.append(button(characteristic.subscription === mode ? `${label} active` : label,
        () => perform('subscribe', { handle: characteristic.handle, mode }), unavailable() || characteristic.subscription === mode));
    }
    if (characteristic.subscription && characteristic.subscription !== 'off') controls.append(button('Unsubscribe', () => perform('subscribe', { handle: characteristic.handle, mode: 'off' }), unavailable()));
    for (const control of controls.children) control.dataset.focus = `${characteristic.handle}-${control.textContent}`;
    if (controls.childElementCount) section.append(controls);
    if (characteristic.descriptors?.length) {
      const details = el('details', 'descriptor-list'); details.dataset.persist = `descriptors-${characteristic.handle}`; details.append(el('summary', '', `Descriptors · ${characteristic.descriptors.length}`));
      for (const descriptor of characteristic.descriptors) {
        const name = typeof NanoMetadata !== 'undefined' ? NanoMetadata.lookup(descriptor.uuid)?.name : '';
        const row = el('div', 'descriptor'), label = el('div'), read = button('Read', () => perform('read', { handle: descriptor.handle }), unavailable());
        read.dataset.focus = `descriptor-${descriptor.handle}`;
        label.append(el('p', '', name || 'Unknown descriptor'), el('p', 'mono', `${descriptor.handle} · ${descriptor.uuid}`)); row.append(label, read); details.append(row);
        if (typeof descriptor.valueHex !== 'string') continue;
        const decoded = typeof NanoGattValues !== 'undefined' ? NanoGattValues.decode(descriptor.uuid, descriptor.valueHex) : [];
        details.append(el('p', 'mono descriptor-value', decoded.length ? decoded.map(field => `${field.label}: ${field.value}`).join('\n') : descriptor.valueHex || '(empty value)'));
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
    api = sharedApi;
    container.innerHTML = '<div class="panel-heading"><div><h2>Command console</h2></div></div><div class="lab-body"><div class="console-grid"><label>Characteristic handle<select id="console-handle" aria-label="Writable characteristic handle"></select></label><label>Write mode<select id="console-response"><option value="true">With response</option><option value="false">Without response</option></select></label><label>Input format<select id="console-format"><option value="hex">HEX bytes</option><option value="utf8">UTF-8 text</option></select></label></div><label class="payload-label" for="console-payload">Payload</label><textarea id="console-payload" rows="3" spellcheck="false" placeholder="01 02 03"></textarea><div class="console-footer"><p id="console-limit" class="vendor-note"></p><button id="console-send" class="button primary" type="button">Send command</button></div><div class="history-row"><label>Recent commands<select id="console-history"></select></label><button id="console-replay" class="button secondary" type="button">Replay selected</button></div><p id="console-status" class="lab-status" role="status">Connect to a writable characteristic.</p></div>';
    get('handle').addEventListener('change', modes); get('response').addEventListener('change', modes);
    get('send').addEventListener('click', () => send());
    get('replay').addEventListener('click', () => { const command = history[Number(get('history').value)]; if (command?.hex) send(command); });
    update(latest, online);
  }
  return { mount, update, select, characteristicActions, advertisement };
})();
