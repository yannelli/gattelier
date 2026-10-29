'use strict';

const NanoStandardApp = (() => {
  const profiles = { '180d': 'Heart rate', '1816': 'Cycling speed and cadence', '1818': 'Cycling power', '1814': 'Running speed and cadence', '1809': 'Health thermometer', '181a': 'Environmental sensing', '181d': 'Weight scale', '1822': 'Pulse oximeter', '180f': 'Battery' };
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  function uuid(value) {
    if (typeof value !== 'string') return '';
    const text = value.trim().toLowerCase();
    return /^(?:0x)?[\da-f]{4}$/.test(text) ? text.replace(/^0x/, '') : text.replace(/^0000([\da-f]{4})-0000-1000-8000-00805f9b34fb$/, '$1');
  }
  function key(device) {
    const address = String(device?.address || '').toLowerCase(), type = device?.addressType;
    return /^(?:[\da-f]{2}:){5}[\da-f]{2}$/.test(address) && Number.isInteger(type) && type >= 0 && type <= 3 ? `${address}/${type}` : '';
  }
  const connected = (device, state) => Boolean(key(device) && state?.ble?.connected && key(device) === key(state.ble));
  const displayName = device => typeof deviceDisplayName === 'function' ? deviceDisplayName(device) : [device.label, device.name, device.gattName].find(value => typeof value === 'string' && value.trim())?.trim() || device.address;
  function services(device, state) {
    return connected(device, state) ? (state.services || []).filter(service => Object.hasOwn(profiles, uuid(service.uuid))) : [];
  }
  function supported(device, state) {
    if (!device) return [];
    const advertised = [...(device.services || []).map(service => typeof service === 'string' ? service : service.uuid), ...(device.serviceData || []).map(service => service.uuid)];
    return [...new Set([...advertised, ...services(device, state).map(service => service.uuid)].map(uuid))].filter(id => Object.hasOwn(profiles, id));
  }
  function mount(container, lab, { selected } = {}) {
    container.classList.add('protocol-panel');
    const heading = el('div', 'panel-heading'), badge = el('span', 'badge'); heading.append(el('h2', '', 'Standard BLE'), badge);
    const body = el('div', 'protocol-body'), context = el('p', 'vendor-note'), profileList = el('ul', 'protocol-sources');
    const controls = el('div', 'protocol-actions'), message = el('p', 'protocol-message'), readings = el('div', 'protocol-evidence');
    message.setAttribute('role', 'status'); body.append(context, profileList, controls, message, readings); container.append(heading, body);
    let online = false, running = null, destroyed = false, targetKey = '', scopeKey = '', selectionVersion = 0, connectionVersion = 0, bootId = '', notice = '';
    function sync() {
      const device = selected?.(), state = lab.getState(), nextTarget = key(device);
      const nextScope = JSON.stringify([online, Boolean(state.ble?.connected), key(state.ble), state.ble?.connectionAttempt ?? null]);
      if (targetKey !== nextTarget) { targetKey = nextTarget; selectionVersion++; notice = ''; }
      if (scopeKey !== nextScope) { scopeKey = nextScope; connectionVersion++; }
      if (running && (running.target !== targetKey || running.selection !== selectionVersion || !online || !running.connect && running.connection !== connectionVersion)) { running = null; notice = ''; }
      return { device, state };
    }
    function guard(token, requireConnection = true) {
      const current = sync();
      if (destroyed || !online || !targetKey || targetKey !== token.target || selectionVersion !== token.selection || connectionVersion !== token.connection || requireConnection && !connected(current.device, current.state)) throw new Error('The selected device or connection changed.');
      return current;
    }
    function characteristic(state, target) {
      const found = services(selected?.(), state).filter(service => uuid(service.uuid) === target.service)
        .flatMap(service => service.characteristics || []).filter(item => item.handle === target.handle && uuid(item.uuid) === target.uuid);
      if (found.length !== 1) throw new Error('This characteristic is no longer available.');
      return found[0];
    }
    function button(label, callback, disabled, focusKey) {
      const node = el('button', 'button secondary', label); node.type = 'button'; node.disabled = disabled;
      node.dataset.focus = focusKey;
      node.addEventListener('click', callback); return node;
    }
    async function act(token, target, action, mode) {
      let operation;
      try {
        const { state } = guard(token), item = characteristic(state, target), properties = item.properties || [];
        if (running || lab.isActing() || state.ble?.busy) throw new Error('Wait for the current BLE operation to finish.');
        if (!Number.isInteger(item.handle) || item.handle < 1 || item.handle > 65535) throw new Error('This characteristic has no usable handle.');
        if (action === 'read' ? !properties.includes('read') : mode === 'off' ? !['notify', 'indicate'].includes(item.subscription) : !properties.includes(mode) || ['notify', 'indicate'].includes(item.subscription)) throw new Error('This action is no longer available.');
        operation = running = { ...token }; notice = action === 'read' ? 'Reading...' : mode === 'off' ? 'Stopping subscription...' : 'Subscribing...'; render();
        await lab.action(action, { handle: target.handle, ...(action === 'subscribe' ? { mode } : {}) });
        const current = guard(token); characteristic(current.state, target);
        notice = action === 'read' ? 'Read complete.' : mode === 'off' ? 'Subscription stopped.' : 'Subscription active.';
      } catch (error) { sync(); if (operation ? running === operation : !destroyed && !running && token.target === targetKey && token.selection === selectionVersion && token.connection === connectionVersion) notice = error.message; }
      finally { if (operation && running === operation) running = null; if (!destroyed) render(); }
    }
    async function connect(token) {
      let operation;
      try {
        const { device, state } = guard(token, false);
        if (running || lab.isActing() || state.ble?.busy) throw new Error('Wait for the current BLE operation to finish.');
        if (device.connectable === false || state.usb?.mode === 'hci') throw new Error('This device is unavailable for a BLE connection.');
        operation = running = { ...token, connect: true }; notice = 'Connecting...'; render();
        await NanoConnection.ensure(device);
        const current = sync();
        if (running !== operation) return;
        if (destroyed || !online || token.target !== targetKey || token.selection !== selectionVersion || !connected(current.device, current.state)) throw new Error('The selected device or connection changed.');
        notice = 'Connected.';
      } catch (error) { sync(); if (operation ? running === operation : !destroyed && !running && token.target === targetKey && token.selection === selectionVersion && token.connection === connectionVersion) notice = error.message; }
      finally { if (operation && running === operation) running = null; if (!destroyed) render(); }
    }
    function fields(item) {
      const list = el('dl', 'protocol-values'), values = NanoGattValues.decode(item.uuid, item.valueHex || '');
      for (const field of values) {
        const row = el('div'), value = el('dd', '', String(field.value)); row.append(el('dt', '', field.label), value);
        if (uuid(item.uuid) === '2a19' && field.label === 'Battery level' && /^(?:100|\d{1,2})%$/.test(field.value)) {
          const meter = el('meter'); meter.min = 0; meter.max = 100; meter.value = parseInt(field.value, 10); meter.setAttribute('aria-label', `Battery level ${field.value}`); row.append(meter);
        }
        if (uuid(item.uuid) === '2a37' && field.label === 'Heart rate measurement' && /^\d+ bpm$/.test(field.value)) {
          const heart = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          heart.setAttribute('viewBox', '0 0 24 24'); heart.setAttribute('width', '32'); heart.setAttribute('height', '32'); heart.setAttribute('aria-hidden', 'true');
          path.setAttribute('fill', 'currentColor'); path.setAttribute('d', 'M12 21S2 15 2 8a5 5 0 0 1 10-1 5 5 0 0 1 10 1c0 7-10 13-10 13Z'); heart.append(path); row.append(heart);
        }
        list.append(row);
      }
      return values.length ? list : null;
    }
    function render() {
      if (destroyed) return;
      const { device, state } = sync(), active = online && connected(device, state), ids = supported(device, online ? state : {});
      const busy = Boolean(running) || lab.isActing() || Boolean(state.ble?.busy), token = { target: targetKey, selection: selectionVersion, connection: connectionVersion };
      const nextControls = document.createDocumentFragment(), nextReadings = document.createDocumentFragment();
      const update = () => {
        for (const [root, content] of [[controls, nextControls], [readings, nextReadings]]) {
          if (typeof replacePreservingFocus === 'function') replacePreservingFocus(root, content);
          else root.replaceChildren(content);
        }
      };
      context.textContent = device ? `${displayName(device)} (${device.address}, type ${device.addressType})` : 'Choose a device in Discover.';
      badge.textContent = !online ? 'Board offline' : active ? 'Connected' : 'Disconnected';
      profileList.replaceChildren(...ids.map(id => el('li', '', `${profiles[id]} (0x${id})`)));
      message.textContent = notice;
      if (!device) return update();
      if (!ids.length) { nextReadings.append(el('p', 'vendor-note', 'No supported standard service was found.')); return update(); }
      if (!active) {
        const label = state.ble?.connected ? 'Switch and connect' : 'Connect';
        nextControls.append(button(label, () => connect(token), !online || busy || !targetKey || device.connectable === false || state.usb?.mode === 'hci', `standard-${targetKey}-connect`));
        return update();
      }
      for (const service of services(device, state)) {
        const section = el('section', 'protocol-evidence'); section.append(el('h3', '', profiles[uuid(service.uuid)]));
        for (const item of service.characteristics || []) {
          const row = el('div', 'protocol-evidence'), actions = el('div', 'protocol-actions'), properties = item.properties || [];
          const name = typeof NanoMetadata !== 'undefined' ? NanoMetadata.lookup(item.uuid)?.name : '';
          row.append(el('h4', '', name || `Characteristic ${item.uuid}`));
          const decoded = fields(item); if (decoded) row.append(decoded);
          const target = { service: uuid(service.uuid), uuid: uuid(item.uuid), handle: item.handle }, disabled = busy || !Number.isInteger(item.handle) || item.handle < 1 || item.handle > 65535;
          const itemKey = `standard-${targetKey}-${target.service}-${target.uuid}-${target.handle}`;
          if (properties.includes('read')) actions.append(button('Read', () => act(token, target, 'read'), disabled, `${itemKey}-read`));
          const mode = properties.includes('notify') ? 'notify' : properties.includes('indicate') ? 'indicate' : '';
          if (mode) {
            const subscribed = ['notify', 'indicate'].includes(item.subscription);
            actions.append(button('Subscribe', () => act(token, target, 'subscribe', mode), disabled || subscribed, `${itemKey}-${mode}`), button('Stop', () => act(token, target, 'subscribe', 'off'), disabled || !subscribed, `${itemKey}-stop`));
            actions.append(el('span', 'vendor-note', subscribed ? `${item.subscription === 'indicate' ? 'Indications' : 'Notifications'} active` : `Uses ${mode === 'indicate' ? 'indications' : 'notifications'}`));
          }
          row.append(actions);
          if (item.readError) row.append(el('p', 'protocol-message', item.readError));
          if (typeof item.valueHex === 'string') {
            const raw = el('details', 'protocol-details'), summary = el('summary', '', 'Raw bytes');
            raw.dataset.persist = `${itemKey}-raw`; summary.dataset.focus = `${itemKey}-raw-summary`;
            raw.append(summary, el('p', 'vendor-note', `${item.uuid} / handle ${item.handle}`), el('pre', 'protocol-preview', item.valueHex || '(empty value)')); row.append(raw);
          }
          section.append(row);
        }
        if (!service.characteristics?.length) section.append(el('p', 'vendor-note', 'No characteristics were discovered for this service.'));
        nextReadings.append(section);
      }
      if (!nextReadings.children.length) nextReadings.append(el('p', 'vendor-note', 'No supported characteristics were discovered on this connection.'));
      update();
    }
    const offState = lab.onState((state, available = true) => { online = available; render(); });
    const offEvents = lab.onEvents?.((events, meta = {}) => {
      if (meta.reboot || bootId && meta.bootId && bootId !== meta.bootId) { connectionVersion++; online = false; running = null; notice = 'Board restarted. Waiting for connection state.'; render(); }
      if (meta.bootId) bootId = meta.bootId;
    });
    document.addEventListener('nanoscope:selection', render); document.addEventListener('nanoscope:busy', render);
    render();
    return { render, destroy() { destroyed = true; running = null; offState?.(); offEvents?.(); document.removeEventListener('nanoscope:selection', render); document.removeEventListener('nanoscope:busy', render); } };
  }
  return { matches: (device, state = {}) => supported(device, state).map(id => ({ uuid: id, title: profiles[id] })), mount };
})();
if (typeof module !== 'undefined') module.exports = NanoStandardApp;
