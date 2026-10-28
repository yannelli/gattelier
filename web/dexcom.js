'use strict';

const NanoDexcom = (() => {
  const readers = new Set();
  const protocol = () => typeof NanoDexcomProtocol !== 'undefined' ? NanoDexcomProtocol : require('./dexcom-protocol.js');
  function createClient(lab, options = {}) {
    const p = protocol(), now = options.now || Date.now;
    let state = lab.getState(), online = false, store = null, listening = false, primed = false, boot = '', cursor = 0, gaps = 0, error = '', anchor = null, captureAttempt = null;
    const changed = () => options.onChange?.(snapshot());
    function stop(message = '') { listening = false; error = message; changed(); }
    function snapshot() { return { listening, error, ...(store?.snapshot() || { records: [], packets: 0 }) }; }
    const connected = scope => online && state.ble?.connected && state.ble.address?.toLowerCase() === scope.address && state.ble.addressType === scope.addressType;
    const offState = lab.onState((next, available = true) => {
      state = next; online = available;
      anchor = Number.isFinite(next.uptime) ? now() - next.uptime * 1000 : null;
      if (listening && (!connected(store.snapshot().scope) || state.ble.connectionAttempt !== captureAttempt)) stop('Capture stopped because the connection changed.');
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
        if (event.addressType !== undefined && event.addressType !== scope.addressType || event.connectionAttempt !== undefined && event.connectionAttempt !== captureAttempt) continue;
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
        if (!connected(store.snapshot().scope)) throw new Error('Connect the selected Dexcom before capturing received packets.');
        if (!p.characteristics(state).length) throw new Error('The connection has no documented Dexcom control or backfill characteristic.');
        captureAttempt = state.ble.connectionAttempt; listening = true; primed = false; error = ''; changed();
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
    const { el } = NanoDexcomView, storage = NanoDexcomStorage.create();
    const heading = el('div', 'panel-heading'), intro = el('div'), body = el('div', 'dexcom-body');
    intro.append(el('h2', '', 'Sensor'));
    heading.append(intro); heading.insertAdjacentHTML('beforeend', '<details class="help"><summary aria-label="About Dexcom G7"><span aria-hidden="true">?</span></summary><div class="help-body"><p>Enter the 4-digit code printed on the applicator to authenticate, then request the latest reading, history or identity.</p><p>Times combine the sensor clock with when the browser received each packet. G7 packets do not carry exact stop or expiry times.</p><p>The applicator code is never saved. Saved sessions and readings stay in this browser, tied to this board and sensor.</p><a href="https://github.com/yannelli/gattelier/blob/main/DEXCOM-CRYPTO-NOTICE.md" target="_blank" rel="noopener noreferrer">Protocol sources and licenses</a></div></details>');
    const selected = el('p', 'hint'), status = el('p', 'lab-status'), results = el('div', 'dexcom-results'); status.setAttribute('role', 'status');
    const form = el('form', 'dexcom-connect'), pinLabel = el('label', '', '4-digit applicator code'), pin = el('input');
    pin.type = 'password'; pin.inputMode = 'numeric'; pin.pattern = '[0-9]{4}'; pin.maxLength = 4; pin.autocomplete = 'off'; pin.placeholder = '0000'; pinLabel.append(pin);
    const rememberLabel = el('label', 'dexcom-check'), remember = el('input'); remember.type = 'checkbox'; remember.checked = true;
    rememberLabel.append(remember, el('span', '', 'Remember session on this browser'));
    const reconnectLabel = el('label', 'dexcom-check'), reconnect = el('input'); reconnect.type = 'checkbox'; reconnect.checked = true;
    reconnectLabel.append(reconnect, el('span', '', 'Reconnect within this 10-minute window'));
    const keepLabel = el('label', 'dexcom-check'), keep = el('input'); keep.type = 'checkbox'; keepLabel.append(keep, el('span', '', 'Save readings in this browser'));
    const actions = el('div', 'dexcom-actions');
    const button = (text, style = 'secondary') => { const node = el('button', `button ${style}`, text); node.type = 'button'; return node; };
    const connect = button('Connect to G7', 'primary'), cancel = button('Cancel', 'quiet'), disconnect = button('Disconnect', 'quiet'), forget = button('Forget session', 'quiet'); connect.type = 'submit';
    const acquisition = el('div', 'dexcom-acquisition'), countdown = el('strong'), observed = el('p', 'hint'), attempt = el('p', 'hint'), packetCount = el('p', 'hint');
    acquisition.append(countdown, observed, attempt, packetCount);
    actions.append(connect, cancel, disconnect);
    const connectionOptions = el('details', 'dexcom-options');
    form.append(pinLabel, actions, connectionOptions);
    const toolbar = el('div', 'dexcom-actions'), latest = button('Read latest'), history = button('Get history'), identity = button('Read identity');
    const hoursLabel = el('label', 'dexcom-history-window'), hours = el('select'); hours.setAttribute('aria-label', 'History window');
    for (const count of [1, 3, 6, 12, 24]) { const choice = el('option', '', `${count} hour${count === 1 ? '' : 's'}`); choice.value = count; if (count === 6) choice.selected = true; hours.append(choice); } hoursLabel.append(hours);
    const historyGroup = el('div', 'dexcom-history-group'); historyGroup.append(hoursLabel, history);
    toolbar.append(latest, identity, historyGroup);
    const exportButton = button('Export readings', 'quiet'), clear = button('Clear saved readings', 'quiet'), savedActions = el('div', 'dexcom-actions'); savedActions.append(exportButton, clear, forget);
    connectionOptions.append(el('summary', '', 'Session & storage'), rememberLabel, reconnectLabel, keepLabel, savedActions);
    const details = el('details', 'dexcom-import'); details.append(el('summary', '', 'Captured packets'));
    const passiveActions = el('div', 'dexcom-actions'), listen = button('Capture received packets'), stop = button('Stop capture', 'quiet'), exportCapture = button('Export acquisition capture', 'quiet'); passiveActions.append(listen, stop, exportCapture);
    const uuidLabel = el('label', '', 'Characteristic'), uuid = el('select');
    for (const [value, label] of [[p.CONTROL, 'G7 control (3534)'], [p.BACKFILL, 'G7 backfill (3536)']]) { const choice = el('option', '', label); choice.value = value; uuid.append(choice); } uuidLabel.append(uuid);
    const hexLabel = el('label', '', 'Packet HEX'), input = el('textarea'); input.rows = 3; input.spellcheck = false; input.placeholder = 'Paste one received characteristic value'; hexLabel.append(input);
    const timeLabel = el('label', '', 'Original capture time (optional)'), time = el('input'); time.type = 'datetime-local'; time.step = '1'; timeLabel.append(time);
    const decode = button('Decode packet'); details.append(passiveActions, uuidLabel, hexLabel, timeLabel, decode);
    body.append(selected, form, status, acquisition, toolbar, results, details); container.replaceChildren(heading, body);
    let session, client, selectedScope = '', displayed = {}, destroying = false, rendering = false, uiError = '', saveStamp = '', uiOperation = 0;
    const schedule = () => { if (!destroying) queueMicrotask(render); };
    client = createClient(lab, { ...options, onChange: schedule });
    const makeSession = () => { const reader = NanoDexcomSession.create(lab, { ...options, connection, ...storage, onChange: schedule }); readers.add(reader); return reader; };
    session = makeSession();
    const scope = device => device?.address ? `${NanoAPI.transport?.() === 'serial' ? 'usb' : NanoAPI.origin()}/${device.address}/${device.addressType}` : '';
    function render() {
      if (destroying || rendering || !session || !client) return;
      rendering = true;
      try {
        const device = getDevice(), nextScope = scope(device);
        if (selectedScope !== nextScope) { selectedScope = nextScope; pin.value = ''; uiError = ''; keep.checked = Boolean(storage.loadReadings(device)); saveStamp = ''; client.select(device); }
        const direct = session.snapshot(), captured = client.snapshot(), same = scope(direct.device || direct.scope) === nextScope;
        const active = same && (direct.busy || direct.authenticated || direct.acquisition?.active);
        const fresh = same && direct.packets ? direct : captured.packets ? captured : null;
        if (fresh && keep.checked && fresh.packets && saveStamp !== `${nextScope}:${fresh.packets}`) {
          try { storage.saveReadings(device, fresh); saveStamp = `${nextScope}:${fresh.packets}`; } catch (error) { uiError = error.message; }
        }
        const saved = storage.loadReadings(device);
        displayed = fresh && saved && saveStamp === `${nextScope}:${fresh.packets}` ? { ...fresh, records: saved.records } : fresh || saved || { records: [] };
        selected.textContent = device ? `${device.label || device.name || 'Dexcom'} · ${device.address}` : 'Choose a Dexcom sensor in Discover.';
        const savedSession = storage.hasSession(device);
        pin.placeholder = savedSession ? 'Saved session available' : '0000'; pin.required = !savedSession; pin.disabled = active;
        connect.disabled = !device || active; connect.textContent = savedSession ? 'Reconnect for 10 minutes' : 'Acquire for 10 minutes';
        cancel.hidden = !same || !direct.busy && !direct.acquisition?.active; disconnect.hidden = !same || !direct.authenticated || direct.busy;
        forget.disabled = !savedSession || active; remember.disabled = reconnect.disabled = active;
        for (const control of [latest, history, identity, hours]) control.disabled = !same || !direct.authenticated || direct.busy;
        listen.disabled = !device || active || captured.listening; stop.hidden = !captured.listening; decode.disabled = !device || active || captured.listening;
        exportButton.disabled = !displayed.records?.length; clear.disabled = !saved;
        status.textContent = uiError || (same && (direct.error || direct.stage)) || captured.error || (captured.listening ? 'Capturing received packets.' : saved ? 'Showing saved readings.' : '');
        status.classList.toggle('error', Boolean(uiError || same && direct.error || captured.error));
        const window = same ? direct.acquisition : null, seconds = Math.ceil((window?.remainingMs || 0) / 1000);
        acquisition.hidden = !window?.startedAt;
        countdown.textContent = window?.active ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} remaining` : 'Acquisition stopped';
        observed.textContent = window?.lastSeenAt !== null && window?.lastSeenAt !== undefined ? `Last advertisement: ${new Date(window.lastSeenAt).toLocaleTimeString()}` : 'Waiting for the selected address and address type';
        attempt.textContent = `${window?.attempts || 0} connection attempts${window?.lastAttemptAt ? ` · Last attempt ${new Date(window.lastAttemptAt).toLocaleTimeString()}` : ''}${window?.lastAttemptStatus || window?.attemptStatus ? ` · ${window.lastAttemptStatus || window.attemptStatus}` : ''}`;
        packetCount.textContent = `${window?.packetCount || 0} captured packets`;
        exportCapture.disabled = !window?.packetCount;
        NanoDexcomView.render(results, displayed, !fresh && Boolean(saved));
      } finally { rendering = false; }
    }
    async function run(callback) { const operation = ++uiOperation; uiError = ''; try { await callback(); } catch (error) { if (operation === uiOperation) uiError = error.message; } render(); }
    form.addEventListener('submit', event => { event.preventDefault(); const code = pin.value; pin.value = ''; client.stop(); run(() => session.connect(getDevice(), { pin: code, remember: remember.checked, reconnect: reconnect.checked })); });
    cancel.addEventListener('click', () => run(() => session.cancel())); disconnect.addEventListener('click', () => run(() => session.disconnect()));
    latest.addEventListener('click', () => run(() => session.readLatest())); history.addEventListener('click', () => run(() => session.readHistory({ hours: Number(hours.value) }))); identity.addEventListener('click', () => run(() => session.readIdentity()));
    forget.addEventListener('click', () => run(async () => { await session.forgetSession(); storage.forgetSession(getDevice()); }));
    keep.addEventListener('change', () => run(() => { saveStamp = ''; if (!keep.checked) storage.clearReadings(getDevice()); }));
    clear.addEventListener('click', () => run(() => { keep.checked = false; storage.clearReadings(getDevice()); }));
    listen.addEventListener('click', () => run(() => client.listen(getDevice()))); stop.addEventListener('click', () => client.stop());
    decode.addEventListener('click', () => run(() => { const receivedAt = time.value ? new Date(time.value).getTime() : null; if (time.value && !Number.isFinite(receivedAt)) throw new Error('Enter a valid capture time.'); client.importPacket(getDevice(), uuid.value, input.value, receivedAt); }));
    exportButton.addEventListener('click', () => { const url = URL.createObjectURL(new Blob([NanoDexcomView.csv(displayed)], { type: 'text/csv' })), link = el('a'); link.href = url; link.download = 'gattelier-g7-readings.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
    exportCapture.addEventListener('click', () => { const url = URL.createObjectURL(new Blob([JSON.stringify(session.captureSnapshot(), null, 2)], { type: 'application/json' })), link = el('a'); link.href = url; link.download = 'gattelier-g7-acquisition.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
    const selectionChanged = () => { if (selectedScope !== scope(getDevice())) { uiOperation++; session.cancel(); } render(); };
    const boardChanged = () => { uiOperation++; readers.delete(session); session.destroy(); session = makeSession(); client.clear(getDevice()); selectedScope = ''; render(); };
    document.addEventListener('nanoscope:selection', selectionChanged); globalThis.addEventListener('nanoscope:api-change', boardChanged); render();
    return { render, client, session, destroy() { destroying = true; readers.delete(session); client.destroy(); session.destroy(); document.removeEventListener('nanoscope:selection', selectionChanged); globalThis.removeEventListener('nanoscope:api-change', boardChanged); } };
  }
  return { createClient, mount, isAcquiring: () => [...readers].some(reader => reader.snapshot().acquisition?.active), pollAcquisition: () => Promise.all([...readers].map(reader => reader.pollAcquisition())) };
})();
if (typeof module !== 'undefined') module.exports = NanoDexcom;
