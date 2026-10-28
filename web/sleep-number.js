'use strict';

const NanoSleep = (() => {
  function mount(container, lab) {
    if (!container) return;
    const p = NanoSleepProtocol;
    let current = {}, online = false, running = false, generation = 0, target = '', bootId = '', cursor = 0, failure = '';
    let sessionId = null, armed = false, commandHex = '', waiters = new Set(), connecting = false, queryTarget = '';
    const key = device => device ? `${String(device.address || '').toLowerCase()}/${device.addressType}` : '';
    const connectionKey = state => state.ble?.connected ? JSON.stringify([key(state.ble), state.ble.connectionAttempt]) : '';
    const el = (tag, cls, text) => { const item = document.createElement(tag); if (cls) item.className = cls; if (text !== undefined) item.textContent = text; return item; };
    const heading = el('div', 'panel-heading'); heading.append(el('h2', '', 'Sleep Number Fuzion'));
    heading.insertAdjacentHTML('beforeend', '<details class="help"><summary aria-label="About the Fuzion reader"><span aria-hidden="true">?</span></summary><div class="help-body"><p>Reads Fuzion bed settings. If the bed reports an authentication or encryption error, pair it in Security. Cloud sleep scores are not available over BLE.</p><a href="https://github.com/kristofferR/ha-adjustable-bed/blob/main/docs/beds/sleep_number.md" target="_blank" rel="noopener noreferrer">Protocol source</a></div></details>');
    const body = el('div', 'detail'), status = el('p', 'hint'); status.setAttribute('role', 'status');
    const controls = el('div', 'inspector-shortcuts'), results = el('dl', 'metadata'), buttons = [];
    for (const [kind, label] of [['capabilities', 'Read capabilities'], ['left', 'Read left firmness'], ['right', 'Read right firmness'], ['privacy', 'Read privacy state']]) {
      const button = el('button', 'button secondary', label); button.type = 'button'; button.addEventListener('click', () => run(kind)); controls.append(button); buttons.push(button);
    }
    const stop = el('button', 'button quiet', 'Stop query'); stop.type = 'button'; stop.hidden = true; controls.append(stop);
        body.append(status, controls, results); container.replaceChildren(heading, body);
    function sync() {
      const selected = NanoConnection.snapshot().selected;
      const handles = p.handles(current), same = current.ble?.connected && key(selected) === key(current.ble);
      const ready = online && selected && ((same && handles.variant === 'Fuzion') || selected.services?.some(uuid => uuid.toLowerCase() === p.SERVICE));
      for (const button of buttons) button.disabled = !ready || running || current.ble?.busy || lab.isActing();
      stop.hidden = !running;
      if (!running && !ready) status.textContent = handles.variant === 'MCR' ? 'MCR transport detected. This reader supports Fuzion metadata.' : '';
    }
    function rejectAll(message) {
      failure = message;
      for (const pending of [...waiters]) pending.reject(new Error(message));
    }
    function guard(token) {
      if (token !== generation || failure) throw new Error(failure || 'Sleep Number connection changed. Repeat the query.');
      if (!online || !current.ble?.connected || current.ble.address !== target) throw new Error('Sleep Number disconnected.');
      const h = p.handles(current);
      if (h.variant !== 'Fuzion' || !h.auth || !h.bamkey) throw new Error('Fuzion characteristics are unavailable.');
      return h;
    }
    function waitFor(accept, timeout = 12000) {
      let pending;
      const promise = new Promise((resolve, reject) => {
        pending = { after: cursor, accept, resolve, reject, timer: null };
        pending.resolve = value => { clearTimeout(pending.timer); waiters.delete(pending); resolve(value); };
        pending.reject = error => { clearTimeout(pending.timer); waiters.delete(pending); reject(error); };
        pending.timer = setTimeout(() => pending.reject(new Error('Sleep Number metadata reply timed out.')), timeout); waiters.add(pending);
      });
      promise.catch(() => {});
      return { promise, cancel: error => pending.reject(error) };
    }
    async function action(path, data, token) {
      guard(token); const result = await lab.action(path, data); guard(token); return result;
    }
    async function read(handle, token) {
      const reply = waitFor(event => {
        if (event.kind !== 'read' || event.handle !== handle) return;
        if (!event.success || event.truncated) throw new Error(event.message || 'Sleep Number GATT read failed or was truncated. Inspect Security for encryption requirements.');
        return p.bytes(event.hex);
      });
      try { await action('read', { handle }, token); const value = await reply.promise; guard(token); return value; }
      catch (error) { reply.cancel(error); throw error; }
    }
    async function run(kind) {
      if (running || lab.isActing()) return;
      running = true; failure = ''; results.replaceChildren(); status.textContent = 'Reading the Fuzion session…'; lab.setFastCapture(true); sync();
      try {
        const device = NanoConnection.snapshot().selected;
        if (!device) throw new Error('Select a Fuzion bed.');
        queryTarget = key(device); connecting = !current.ble?.connected || key(current.ble) !== queryTarget;
        const connected = await NanoConnection.ensure(device);
        connecting = false;
        if (failure) throw new Error(failure);
        if (connectionKey(connected) !== connectionKey(current)) throw new Error('Sleep Number connection changed.');
        current = connected; target = current.ble.address;
        const token = generation;
        const h = guard(token);
        if (!h.auth.properties.includes('read') || !['read', 'notify', 'write-no-response'].every(property => h.bamkey.properties.includes(property))) throw new Error('Fuzion characteristics do not expose the required read, notify, and write properties.');
        sessionId = p.session(await read(h.auth.handle, token));
        await action('subscribe', { handle: h.bamkey.handle, mode: 'notify' }, token);
        const frame = p.request(kind), size = Math.max(1, Math.min(244, (current.ble.mtu || 23) - 3));
        commandHex = p.hex(frame.subarray(0, size)); armed = false;
        const hint = waitFor(event => event.handle === h.bamkey.handle && ['notification', 'indication'].includes(event.kind) && armed && p.hint(event.hex, sessionId) ? true : undefined);
        try {
          status.textContent = 'Reading bed metadata…';
          for (let offset = 0; offset < frame.length; offset += size) await action('write', { handle: h.bamkey.handle, hex: p.hex(frame.subarray(offset, offset + size)), response: false }, token);
          await hint.promise;
        } catch (error) { hint.cancel(error); throw error; }
        const assembler = new p.Assembler(), deadline = Date.now() + 15000;
        let response = null;
        while (response === null) {
          guard(token); if (Date.now() > deadline) throw new Error('Sleep Number metadata read timed out.');
          response = assembler.append(await read(h.bamkey.handle, token));
        }
        guard(token);
        for (const field of p.response(kind, response)) { const item = el('div'); item.append(el('dt', '', field.label), el('dd', '', field.value)); results.append(item); }
        status.textContent = `Metadata verified at ${new Date().toLocaleTimeString()}.`;
      } catch (error) { const message = failure || error.message; status.textContent = message; rejectAll(message); }
      finally { running = false; connecting = false; queryTarget = ''; sessionId = null; armed = false; commandHex = ''; lab.setFastCapture(false); sync(); }
    }
    stop.addEventListener('click', () => { generation++; rejectAll('Metadata query stopped.'); status.textContent = 'Metadata query stopped.'; });
    lab.onEvents((events, meta) => {
      if (bootId && bootId !== meta.bootId) { generation++; rejectAll('The board restarted. Reconnect the bed.'); }
      bootId = meta.bootId;
      if (meta.dropped && running) rejectAll('Packet capture has a gap. Repeat the metadata query.');
      for (const event of events) {
        cursor = Math.max(cursor, event.seq);
        if (!running || event.address !== target) continue;
        if (event.kind === 'disconnect') { generation++; rejectAll('Sleep Number disconnected.'); continue; }
        if (event.truncated) { rejectAll('A Sleep Number packet was truncated. Repeat the query.'); continue; }
        if (event.kind === 'write' && event.handle === p.handles(current).bamkey?.handle && event.hex === commandHex) armed = true;
        for (const pending of [...waiters]) {
          if (event.seq <= pending.after) continue;
          try { const result = pending.accept(event); if (result !== undefined) pending.resolve(result); } catch (error) { pending.reject(error); }
        }
      }
      cursor = meta.reboot ? meta.cursor || meta.nextSeq || 0 : Math.max(cursor, meta.cursor || meta.nextSeq || 0);
    });
    lab.onState((state, available = true) => {
      const next = state.ble?.connected ? state.ble.address : '';
      if (connectionKey(current) !== connectionKey(state)) { generation++; if (running && !connecting) rejectAll('Sleep Number connection changed.'); results.replaceChildren(); }
      current = state; target = next; online = available;
      if (!online && running) rejectAll('The board is unavailable.');
      sync();
    });
    globalThis.addEventListener('nanoscope:api-change', () => {
      generation++; if (running) rejectAll('Sleep Number connection changed.');
      current = {}; target = ''; online = false; bootId = ''; cursor = 0; results.replaceChildren(); sync();
    });
    document.addEventListener('nanoscope:selection', () => { if (running && key(NanoConnection.snapshot().selected) !== queryTarget) { generation++; rejectAll('Selected device changed.'); } sync(); });
    sync();
  }
  return { mount };
})();
