'use strict';

const NanoRadiaCode = (() => {
  const protocol = () => typeof NanoRadiaCodeProtocol !== 'undefined' ? NanoRadiaCodeProtocol : require('./radiacode-protocol.js');
  function createClient(lab, options = {}) {
    const p = protocol(), connection = options.connection || NanoConnection, timeout = options.timeoutMs ?? 12000;
    let current = lab.getState(), online = false, target = '', boot = '', cursor = 0, gaps, pending = null, priming = null;
    let initialized = false, firmware = null, sequence = 0, running = false, failure = '', poisoned = false, lastAddress = '';
    function fail(message) {
      if (!running) return;
      failure = message; poisoned = Boolean(target); initialized = false;
      pending?.reject(new Error(message)); priming?.reject(new Error(message));
    }
    function guard() {
      if (failure) throw new Error(failure);
      if (!online || !current.ble?.connected || current.ble.address?.toLowerCase() !== target) throw new Error('RadiaCode connection changed. Reconnect the selected device.');
      const handles = p.handles(current);
      if (!handles) throw new Error('The connected device does not expose the documented RadiaCode characteristics.');
      if (!handles.write.properties?.includes('write-no-response') || !handles.notify.properties?.includes('notify')) throw new Error('RadiaCode requires write-without-response and notification properties.');
      return handles;
    }
    function wait(holder, label) {
      let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); promise.catch(() => {});
      const item = { promise, after: cursor, timer: setTimeout(() => fail(`${label} timed out. Reconnect before retrying.`), timeout) };
      const finish = (fn, value) => { clearTimeout(item.timer); if (holder === 'pending') pending = null; else priming = null; fn(value); };
      item.resolve = value => finish(resolve, value); item.reject = error => finish(reject, error); return item;
    }
    async function query(kind) {
      const handles = guard(), frame = p.request(kind, sequence); sequence = (sequence + 1) % 32;
      const item = wait('pending', 'RadiaCode response'); item.frame = frame; item.assembler = new p.Assembler(); pending = item;
      try {
        const size = Math.min(18, Math.max(1, (current.ble.mtu || 23) - 3));
        for (let offset = 0; offset < frame.length; offset += size) { guard(); await lab.action('write', { handle: handles.write.handle, hex: p.hex(frame.slice(offset, offset + size)), response: false }); }
        guard(); return await item.promise;
      } catch (error) { fail(error.message); item.reject(error); throw error; }
    }
    const offEvents = lab.onEvents((events, meta = {}) => {
      const changedBoot = boot && meta.bootId && boot !== meta.bootId;
      if (changedBoot) { initialized = false; sequence = 0; poisoned = false; if (target) fail('The board restarted during the RadiaCode transfer.'); }
      if (meta.bootId) boot = meta.bootId;
      if (running && !priming && (meta.dropped || gaps !== undefined && Number(meta.gaps) > gaps)) fail('RadiaCode packet capture has a gap. Reconnect before retrying.');
      gaps = Number(meta.gaps) || 0;
      for (const event of events) {
        cursor = Math.max(cursor, event.seq || 0);
        if (!pending || event.seq <= pending.after || event.address?.toLowerCase() !== target) continue;
        if (event.kind === 'disconnect') { fail('RadiaCode disconnected during the transfer.'); continue; }
        const handles = p.handles(current);
        if (!handles || event.handle !== handles.notify.handle || !['notification', 'indication'].includes(event.kind)) continue;
        if (event.truncated || event.redacted || event.success === false) { fail('RadiaCode notification is incomplete or unavailable.'); continue; }
        try {
          const item = pending;
          for (const frame of item.assembler.append(event.hex)) { if (pending !== item) break; item.resolve(p.response(frame, item.frame)); }
        } catch (error) { fail(error.message); }
      }
      cursor = meta.reboot ? meta.cursor || meta.nextSeq || 0 : Math.max(cursor, meta.cursor || meta.nextSeq || 0);
      priming?.resolve();
    });
    const offState = lab.onState((state, available = true) => {
      const address = state.ble?.connected ? state.ble.address?.toLowerCase() || '' : '';
      if (address !== lastAddress) { initialized = false; firmware = null; sequence = 0; poisoned = false; lastAddress = address; }
      current = state; online = available;
      if (running && target && (!online || address !== target)) fail('RadiaCode connection changed during the transfer.');
    });
    async function read(kind, device) {
      if (!['identity', 'status', 'measurements'].includes(kind)) throw new Error('Unsupported RadiaCode read.');
      if (running || lab.isActing()) throw new Error('Wait for the current Bluetooth operation to finish.');
      if (!device?.address) throw new Error('Select a RadiaCode device first.');
      running = true; failure = ''; target = '';
      try {
        current = await connection.ensure(device); target = device.address.toLowerCase(); guard();
        if (poisoned) throw new Error('Reconnect RadiaCode after the interrupted transfer before reading again.');
        priming = wait('priming', 'Live packet capture'); const prime = priming.promise; lab.setFastCapture(true); await prime; guard();
        if (!initialized) {
          const handles = guard(); await lab.action('subscribe', { handle: handles.notify.handle, mode: 'notify' }); guard();
          await query('exchange'); firmware = p.version(await query('version')); initialized = true;
        }
        if (kind === 'identity') {
          const serial = p.ascii(p.virtualString(await query('serial')));
          return { kind, serial, ...firmware, fields: [{ label: 'Serial number', value: serial }, { label: 'Firmware', value: `${firmware.firmware.major}.${firmware.firmware.minor} ${firmware.firmware.date}` }, { label: 'Boot firmware', value: `${firmware.boot.major}.${firmware.boot.minor} ${firmware.boot.date}` }] };
        }
        if (kind === 'status') { const flags = p.status(await query('status')); return { kind, flags, fields: [{ label: 'Status flags', value: `0x${flags.toString(16).padStart(8, '0')}` }] }; }
        if (firmware.firmware.major < 4 || firmware.firmware.major === 4 && firmware.firmware.minor < 8) throw new Error('Buffered measurement decoding requires RadiaCode firmware 4.8 or later. Identity and status remain available.');
        const records = p.measurements(p.virtualString(await query('measurements'))), fields = [{ label: 'Measurement records', value: records.length }];
        for (const [key, label, suffix] of [['countRate', 'Count rate', ' cps'], ['doseRate', 'Dose rate (device units)', ''], ['dose', 'Accumulated dose (device units)', ''], ['temperatureC', 'Device temperature', ' °C'], ['batteryPercent', 'Battery level', '%']]) {
          const record = [...records].reverse().find(item => item[key] !== undefined); if (record) fields.push({ label, value: `${record[key]}${suffix}` });
        }
        return { kind, records, fields };
      } catch (error) { if (pending || priming) fail(error.message); throw error; }
      finally { pending?.reject(new Error('RadiaCode read ended.')); priming?.reject(new Error('RadiaCode read ended.')); running = false; target = ''; lab.setFastCapture(false); }
    }
    return { read, stop: () => fail('RadiaCode read stopped. Reconnect before retrying.'), busy: () => running, destroy() { fail('RadiaCode reader closed.'); offEvents?.(); offState?.(); } };
  }
  function mount(container, lab, options = {}) {
    if (!container) return;
    const connection = options.connection || NanoConnection, getDevice = options.getDevice || (() => connection.snapshot().selected), client = createClient(lab, { ...options, connection });
    const el = (tag, cls, text) => { const item = document.createElement(tag); if (cls) item.className = cls; if (text !== undefined) item.textContent = text; return item; };
    const heading = el('div', 'panel-heading'), body = el('div', 'radiacode-body'), selected = el('div', 'radiacode-device');
    const deviceName = el('h3'), addressLabel = el('p', 'mono'), connectionBadge = el('span', 'badge');
    const status = el('p', 'radiacode-status'), controls = el('div', 'radiacode-actions'), results = el('div', 'radiacode-results'), buttons = [];
    const empty = el('div', 'radiacode-empty'), sections = new Map();
    const titles = { measurements: 'Measurements', identity: 'Device identity', status: 'Device status' };
    let selectedAddress = String(getDevice()?.address || '').toLowerCase(), selectionVersion = 0;
    status.setAttribute('role', 'status'); status.setAttribute('aria-atomic', 'true');
    heading.append(el('h2', '', 'RadiaCode'), el('span', 'badge', 'Read only'));
    const deviceInfo = el('div'); deviceInfo.append(deviceName, addressLabel); selected.append(deviceInfo, connectionBadge);
    empty.append(el('h3', '', 'No readings yet'), el('p', '', 'Read measurements to see the latest buffered values from this device.'));
    function setStatus(message, state = 'idle') { status.textContent = message; status.dataset.state = state; }
    function render() {
      const device = getDevice(), context = connection.snapshot(), address = String(device?.address || '').toLowerCase();
      if (address !== selectedAddress) {
        selectedAddress = address; selectionVersion++; if (client.busy()) client.stop();
        sections.clear(); results.replaceChildren(); setStatus('');
      }
      deviceName.textContent = device ? device.label || device.name || 'RadiaCode device' : 'Select a RadiaCode in Discover';
      addressLabel.textContent = device?.address || '';
      const connected = Boolean(device && context.state.ble?.connected && String(context.state.ble.address || '').toLowerCase() === address);
      connectionBadge.textContent = connected ? 'Connected' : 'Not connected';
      connectionBadge.className = `badge${connected ? ' connected' : ''}`; connectionBadge.hidden = !device;
      for (const button of buttons) button.disabled = !device || client.busy() || !context.online || context.pending || context.state.ble?.busy;
      stop.hidden = !client.busy(); empty.hidden = sections.size > 0;
      results.hidden = !sections.size; status.hidden = !status.textContent;
      body.setAttribute('aria-busy', String(client.busy()));
    }
    function showResult(result) {
      const section = el('section', `radiacode-result radiacode-result-${result.kind}`), title = el('div', 'radiacode-result-heading');
      const time = el('time', '', new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }));
      time.dateTime = new Date().toISOString(); time.title = 'Last read'; title.append(el('h3', '', titles[result.kind]), time);
      const fields = el('dl', 'radiacode-fields');
      const orderedFields = result.kind === 'measurements' ? [...result.fields.slice(1), result.fields[0]] : result.fields;
      for (const field of orderedFields) {
        const row = el('div', 'radiacode-field'), value = el('dd');
        let text = String(field.value);
        if (result.kind === 'measurements') {
          const match = /^(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)(.*)$/i.exec(text);
          if (match) {
            value.append(el('span', '', Number(Number(match[1]).toPrecision(6)).toString()));
            if (match[2]) value.append(el('span', 'radiacode-unit', match[2].trim()));
          } else value.textContent = text;
        } else value.textContent = text;
        row.append(el('dt', '', field.label.replace(' (device units)', '')), value); fields.append(row);
      }
      section.append(title, fields);
      if (result.kind === 'measurements') section.append(el('p', 'radiacode-note', `${result.records.length ? 'Latest available value for each measurement.' : 'The device returned no buffered measurements.'} Dose values use device units.`));
      if (result.kind === 'status') section.append(el('p', 'radiacode-note', 'Raw device status flags. Flag meanings are not decoded.'));
      sections.set(result.kind, section);
      results.replaceChildren(...Object.keys(titles).filter(kind => sections.has(kind)).map(kind => sections.get(kind)));
    }
    async function run(kind) {
      render(); const version = selectionVersion;
      setStatus(`Reading ${titles[kind]?.toLowerCase() || 'RadiaCode'}…`, 'reading');
      const operation = client.read(kind, getDevice()); render();
      try {
        const result = await operation; if (version !== selectionVersion) return;
        showResult(result); setStatus(`${titles[kind]} updated.`, 'success'); return result;
      } catch (error) { if (version === selectionVersion) setStatus(error.message, 'error'); }
      finally { render(); }
    }
    for (const [kind, label] of [['measurements', 'Read measurements'], ['identity', 'Identity'], ['status', 'Status']]) {
      const button = el('button', `button ${kind === 'measurements' ? 'primary' : 'secondary'}`, label);
      button.type = 'button'; button.addEventListener('click', () => run(kind)); controls.append(button); buttons.push(button);
    }
    const stop = el('button', 'button quiet', 'Stop'); stop.type = 'button'; stop.addEventListener('click', () => client.stop()); controls.append(stop);
    const source = el('a', '', 'RadiaCode protocol source'); source.href = 'https://github.com/cdump/radiacode'; source.target = '_blank'; source.rel = 'noopener noreferrer';
    const help = el('details', 'radiacode-help'); help.append(el('summary', '', 'About these readings'), el('p', '', 'Readings come from the device buffer. Dose values stay in device units; buffered records use device clock offsets. Reading leaves the device clock and settings unchanged.'), source);
    body.append(selected, controls, status, empty, results, help); container.replaceChildren(heading, body);
    const off = lab.onState(render); document.addEventListener('nanoscope:selection', render); document.addEventListener('nanoscope:busy', render); render();
    return { read: run, stop: client.stop, destroy() { client.destroy(); off?.(); document.removeEventListener('nanoscope:selection', render); document.removeEventListener('nanoscope:busy', render); } };
  }
  return { createClient, mount };
})();
if (typeof module !== 'undefined') module.exports = NanoRadiaCode;
