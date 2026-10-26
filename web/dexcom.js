'use strict';

const NanoDexcom = (() => {
  const protocol = () => typeof NanoDexcomProtocol !== 'undefined' ? NanoDexcomProtocol : require('./dexcom-protocol.js');
  function createClient(lab, options = {}) {
    const p = protocol(), now = options.now || Date.now;
    let state = lab.getState(), online = false, store = null, listening = false, primed = false, boot = '', cursor = 0, gaps = 0, error = '', anchor = null;
    const changed = () => options.onChange?.(snapshot());
    function stop(message = '') { listening = false; error = message; changed(); }
    function snapshot() { return { listening, error, ...(store?.snapshot() || { records: [], packets: 0 }) }; }
    const offState = lab.onState((next, available = true) => {
      state = next; online = available;
      anchor = Number.isFinite(next.uptime) ? now() - next.uptime * 1000 : null;
      if (listening && (!online || !state.ble?.connected || state.ble.address?.toLowerCase() !== store.snapshot().scope.address)) stop('Capture stopped because the connection changed.');
    });
    const offEvents = lab.onEvents((events, meta = {}) => {
      if (!listening) return;
      if (!primed) { primed = true; boot = meta.bootId; cursor = meta.cursor || meta.nextSeq || Math.max(0, ...events.map(event => event.seq || 0)); gaps = Number(meta.gaps) || 0; return; }
      if (meta.reboot || boot && meta.bootId && meta.bootId !== boot) { stop('Capture stopped because the board restarted.'); return; }
      if (meta.dropped || Number(meta.gaps) > gaps) { stop('Capture stopped because packets are missing.'); return; }
      gaps = Number(meta.gaps) || gaps;
      const scope = store.snapshot().scope;
      for (const event of events) {
        if (!Number.isInteger(event.seq) || event.seq <= cursor) continue;
        cursor = event.seq;
        if (event.address?.toLowerCase() !== scope.address) continue;
        if (event.kind === 'disconnect') { stop('Capture stopped because Dexcom disconnected.'); break; }
        if (!['notification', 'indication', 'read'].includes(event.kind) || event.request) continue;
        const characteristic = p.characteristics(state).find(item => item.handle === event.handle);
        if (!characteristic || event.uuid && event.uuid.toLowerCase() !== characteristic.uuid.toLowerCase()) continue;
        if (event.truncated || event.redacted || event.success === false || Number(event.length) > String(event.hex || '').replace(/\s/g, '').length / 2) { stop('Capture stopped because a Dexcom packet is incomplete.'); break; }
        const receivedAt = anchor !== null && Number.isFinite(event.ms) ? anchor + event.ms : null;
        try { store.add(characteristic.uuid, event.hex, { receivedAt }); error = ''; }
        catch (failure) { error = failure.message; }
      }
      changed();
    });
    function select(device) {
      const scope = store?.snapshot().scope;
      if (!scope && !device?.address) return;
      if (scope && device?.address && scope.address === device.address.toLowerCase() && scope.addressType === device.addressType) return;
      listening = false; primed = false; store = device?.address ? p.createStore(device) : null; error = ''; changed();
    }
    return { snapshot, select, stop,
      listen(device) {
        select(device);
        if (!store) throw new Error('Select a Dexcom device first.');
        if (!online || !state.ble?.connected || state.ble.address?.toLowerCase() !== store.snapshot().scope.address) throw new Error('Connect the selected Dexcom before capturing received packets.');
        if (!p.characteristics(state).length) throw new Error('The connection has no documented Dexcom control or backfill characteristic.');
        listening = true; primed = false; error = ''; changed();
      },
      importPacket(device, uuid, value, receivedAt = null) {
        select(device);
        if (!store) throw new Error('Select a Dexcom device first.');
        if (listening) throw new Error('Stop capture before importing a packet.');
        const result = store.add(uuid, value, { receivedAt }); error = ''; changed(); return result;
      },
      clear(device) { listening = false; store = null; select(device); },
      destroy() { listening = false; offState?.(); offEvents?.(); }
    };
  }
  function mount(container, lab, options = {}) {
    if (!container) return;
    const p = protocol(), connection = options.connection || NanoConnection, getDevice = options.getDevice || (() => connection.snapshot().selected);
    const el = (tag, cls = '', text) => { const node = document.createElement(tag); node.className = cls; if (text !== undefined) node.textContent = text; return node; };
    const heading = el('div', 'panel-heading'), intro = el('div'), body = el('div', 'dexcom-body');
    intro.append(el('h2', '', 'Dexcom G7'), el('p', 'hint', 'Decode received G7 packets and inspect captured glucose history.')); heading.append(intro);
    const selected = el('p', 'hint'), status = el('p', 'lab-status'), results = el('div', 'dexcom-results'); status.setAttribute('role', 'status');
    const actions = el('div', 'dexcom-actions'), listen = el('button', 'button secondary', 'Capture received packets'), stop = el('button', 'button quiet', 'Stop capture'), clear = el('button', 'button quiet', 'Clear readings');
    for (const button of [listen, stop, clear]) { button.type = 'button'; actions.append(button); }
    const client = createClient(lab, { ...options, onChange: render });
    const info = el('p', 'hint', 'Direct G7 pairing, live readings, and history requests are not implemented yet. This module decodes received or pasted packets from an authenticated session. Exact stop and expiry times are not available from the supported packets.');
    const details = el('details', 'dexcom-import'); details.append(el('summary', '', 'Decode a captured packet'));
    const uuidLabel = el('label', '', 'Characteristic'), uuid = el('select');
    for (const [value, label] of [[p.CONTROL, 'G7 control (3534)'], [p.BACKFILL, 'G7 backfill (3536)']]) { const option = el('option', '', label); option.value = value; uuid.append(option); } uuidLabel.append(uuid);
    const hexLabel = el('label', '', 'Packet HEX'), input = el('textarea'); input.rows = 3; input.spellcheck = false; input.placeholder = 'Paste one received characteristic value'; hexLabel.append(input);
    const timeLabel = el('label', '', 'Original capture time (optional)'), time = el('input'); time.type = 'datetime-local'; time.step = '1'; timeLabel.append(time);
    const decode = el('button', 'button secondary', 'Decode packet'); decode.type = 'button';
    details.append(uuidLabel, hexLabel, timeLabel, el('p', 'hint', 'Use the original receive time for estimated timestamps. Imported bytes stay in this page until cleared or closed.'), decode);
    const source = el('a', '', 'Packet layouts and status codes: xDrip source'); source.href = p.SOURCE; source.target = '_blank'; source.rel = 'noopener noreferrer';
    body.append(selected, info, actions, status, results, details, source); container.replaceChildren(heading, body);
    const displayTime = value => value === null || value === undefined ? 'Unavailable' : new Date(value).toLocaleString();
    function render() {
      const device = getDevice(); client.select(device);
      const data = client.snapshot(); selected.textContent = device ? `${device.label || device.name || 'Dexcom'} · ${device.address}` : 'Select a Dexcom device in Discover.';
      listen.disabled = !device || data.listening; stop.hidden = !data.listening; clear.disabled = !data.packets; decode.disabled = !device || data.listening;
      status.textContent = data.error || (data.listening ? 'Listening for new received packets. Authentication and subscriptions must already exist.' : `${data.packets} packets decoded in this page.`);
      results.replaceChildren();
      if (!data.packets) return;
      const fields = el('dl', 'dexcom-fields'), add = (name, value) => { const row = el('div'); row.append(el('dt', '', name), el('dd', '', String(value))); fields.append(row); };
      if (data.latest) {
        add('Last decoded glucose', data.latest.glucoseMgDl === null ? `Unavailable (raw ${data.latest.glucoseRaw})` : `${data.latest.glucoseMgDl} mg/dL`);
        add('Sensor state', `${data.latest.stateLabel} (0x${data.latest.state.toString(16).padStart(2, '0')})`);
        add('Reading time (estimated)', displayTime(data.latest.timestamp)); add('Reading age in packet', `${data.latest.ageSeconds} seconds`);
        add('Sensor start (estimated)', displayTime(data.estimatedStart)); add('Raw transmitter status', `0x${data.latest.statusRaw.toString(16).padStart(2, '0')}`);
      }
      if (data.identity) { add('Serial number', data.identity.serial); add('Firmware', data.identity.firmware); add('Build', data.identity.build); }
      add('Exact stop time', 'Unavailable in these packets'); add('Expiry time', 'Unavailable in these packets'); results.append(fields);
      const table = el('table', 'dexcom-history'), head = el('thead'), headings = el('tr'), rows = el('tbody');
      for (const label of ['Time (estimated)', 'Sensor seconds', 'Glucose', 'State', 'Source']) headings.append(el('th', '', label)); head.append(headings);
      for (const item of data.records.slice(-100).reverse()) { const row = el('tr'); for (const value of [displayTime(item.timestamp), item.clock, item.glucoseMgDl === null ? `Raw ${item.glucoseRaw}` : `${item.glucoseMgDl} mg/dL`, item.stateLabel, item.source]) row.append(el('td', '', String(value))); rows.append(row); }
      table.append(head, rows); const scroll = el('div', 'table-scroll'); scroll.append(table); results.append(el('h3', '', `Captured history (${data.records.length} records)`), scroll);
    }
    function run(callback) { try { callback(); } catch (error) { status.textContent = error.message; } }
    listen.addEventListener('click', () => run(() => client.listen(getDevice()))); stop.addEventListener('click', () => client.stop()); clear.addEventListener('click', () => client.clear(getDevice()));
    decode.addEventListener('click', () => run(() => { const receivedAt = time.value ? new Date(time.value).getTime() : null; if (time.value && !Number.isFinite(receivedAt)) throw new Error('Enter a valid capture time.'); client.importPacket(getDevice(), uuid.value, input.value, receivedAt); }));
    document.addEventListener('nanoscope:selection', render); render();
    return { render, client, destroy() { client.destroy(); document.removeEventListener('nanoscope:selection', render); } };
  }
  return { createClient, mount };
})();
if (typeof module !== 'undefined') module.exports = NanoDexcom;
