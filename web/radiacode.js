'use strict';

const NanoRadiaCode = (() => {
  const protocol = () => typeof NanoRadiaCodeProtocol !== 'undefined' ? NanoRadiaCodeProtocol : require('./radiacode-protocol.js');
  function createClient(lab, options = {}) {
    const p = protocol(), notify = typeof NanoNotifyClient !== 'undefined' ? NanoNotifyClient : require('./notify-client.js');
    let initialized = false, firmware = null, format = null, sequence = 0, latest = {};
    const link = notify.create(lab, p, {
      name: 'RadiaCode', connection: options.connection || NanoConnection, timeout: options.timeoutMs ?? 12000, chunk: 18,
      text: { changed: 'RadiaCode connection changed. Reconnect the selected device.', moved: 'RadiaCode connection changed during the transfer.', disconnect: 'RadiaCode disconnected during the transfer.', select: 'Select a RadiaCode device first.', poisoned: 'Reconnect RadiaCode after the interrupted transfer before reading again.' },
      check(handles) {
        if (!handles) throw new Error('The connected device does not expose the documented RadiaCode characteristics.');
        if (!handles.write.properties?.includes('write-no-response') || !handles.notify.properties?.includes('notify')) throw new Error('RadiaCode requires write-without-response and notification properties.');
      },
      writeResponse: () => false,
      reset(scope) {
        initialized = false;
        if (scope !== 'fail') sequence = 0;
        if (scope === 'address') { firmware = null; format = null; latest = {}; }
      },
      onFrame: (frame, item) => item.resolve(p.response(frame, item.frame))
    });
    const query = kind => link.request(kind, 'RadiaCode response', () => { const frame = p.request(kind, sequence); sequence = (sequence + 1) % 32; return frame; });
    function perform(kind, device) {
      return link.run(device, async () => {
        await link.prime();
        if (!initialized) { await link.subscribe(); await query('exchange'); firmware = p.version(await query('version')); initialized = true; }
        if (kind === 'identity') {
          const serial = p.ascii(p.virtualString(await query('serial')));
          return { kind, serial, ...firmware, fields: [{ label: 'Serial number', value: serial }, { label: 'Firmware', value: `${firmware.firmware.major}.${firmware.firmware.minor} ${firmware.firmware.date}` }, { label: 'Boot firmware', value: `${firmware.boot.major}.${firmware.boot.minor} ${firmware.boot.date}` }] };
        }
        if (kind === 'status') { const flags = p.status(await query('status')); return { kind, flags, fields: [{ label: 'Status flags', value: `0x${flags.toString(16).padStart(8, '0')}` }] }; }
        if (firmware.firmware.major < 4 || firmware.firmware.major === 4 && firmware.firmware.minor < 8) throw new Error('Measurements, spectra and dose reset require RadiaCode firmware 4.8 or later.');
        if (kind === 'resetDose') { p.acknowledge(await query('resetDose')); delete latest.dose; delete latest.durationSeconds; return { kind, fields: [{ label: 'Accumulated dose', value: 'Reset acknowledged by device' }] }; }
        if (kind === 'spectrum') {
          if (format === null) format = p.spectrumFormat(p.virtualString(await query('configuration')));
          const spectrum = p.spectrum(p.virtualString(await query('spectrum')), format);
          return { kind, ...spectrum, fields: [{ label: 'Acquisition time', value: `${spectrum.durationSeconds} s` }, { label: 'Total counts', value: spectrum.totalCounts }, { label: 'Channels', value: spectrum.counts.length }] };
        }
        const records = p.measurements(p.virtualString(await query('measurements')), { partial: true }), fields = [{ label: 'Measurement records', value: records.length }];
        for (const record of records) Object.assign(latest, record);
        for (const [key, label, suffix] of [['countRate', 'Count rate', ' cps'], ['doseRate', 'Dose rate (device units)', ''], ['dose', 'Accumulated dose (device units)', ''], ['temperatureC', 'Device temperature', ' °C'], ['batteryPercent', 'Battery level', '%']]) {
          if (latest[key] !== undefined) fields.push({ label, value: `${latest[key]}${suffix}` });
        }
        return { kind, records, fields, warning: records.warning || '' };
      });
    }
    return {
      read(kind, device) { if (!['identity', 'status', 'measurements', 'spectrum'].includes(kind)) return Promise.reject(new Error('Unsupported RadiaCode read.')); return perform(kind, device); },
      resetDose(device, confirmed = false) { if (confirmed !== true) return Promise.reject(new Error('Confirm the accumulated dose reset first.')); return perform('resetDose', device); },
      stop: () => link.fail('RadiaCode operation stopped. Reconnect before retrying.'), busy: link.busy,
      destroy: () => link.close('RadiaCode reader closed.')
    };
  }
  function createPoller({ read, onResult = () => {}, onError = () => {}, onChange = () => {}, stopRead = () => {}, intervalMs = 5000, schedule = setTimeout, cancel = clearTimeout }) {
    let active = false, timer = null, generation = 0;
    function stop() { active = false; generation++; if (timer !== null) cancel(timer); timer = null; stopRead(); onChange(); }
    async function tick(version) {
      try {
        for (const kind of ['measurements', 'spectrum']) {
          if (!active || version !== generation) return;
          const result = await read(kind);
          if (!active || version !== generation) return;
          onResult(result);
        }
        if (active && version === generation) timer = schedule(() => tick(version), intervalMs);
      } catch (error) { if (active && version === generation) { stop(); onError(error); } }
    }
    return { start() { if (active) return; active = true; const version = ++generation; onChange(); return tick(version); }, stop, active: () => active };
  }
  function spectrumChart(result, el) {
    const figure = el('figure', 'radiacode-spectrum');
    if (!result.counts.length) { figure.append(el('p', 'radiacode-note', 'The device returned no spectrum channels.')); return figure; }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), peak = Math.max(...result.counts, 1);
    const min = Math.min(...result.energiesKeV), max = Math.max(...result.energiesKeV), span = max - min || 1;
    svg.setAttribute('viewBox', '0 0 720 240'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `Energy spectrum with ${result.counts.length} channels and ${result.totalCounts} counts. Energy in keV; vertical axis is counts per channel.`);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', result.counts.map((count, index) => `${index ? 'L' : 'M'}${(24 + (result.energiesKeV[index] - min) / span * 672).toFixed(2)},${(216 - count / peak * 192).toFixed(2)}`).join(' '));
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.5'); path.setAttribute('vector-effect', 'non-scaling-stroke'); svg.append(path);
    const scale = el('div', 'radiacode-spectrum-scale'); scale.append(el('span', '', `${Number(min.toPrecision(5))} keV`), el('span', '', `${Number(max.toPrecision(5))} keV`));
    figure.append(el('figcaption', '', `Counts per channel (0 to ${peak.toLocaleString()})`), svg, scale);
    return figure;
  }
  function mount(container, lab, options = {}) {
    if (!container) return;
    const connection = options.connection || NanoConnection, getDevice = options.getDevice || (() => connection.snapshot().selected), client = createClient(lab, { ...options, connection });
    const el = (tag, cls, text) => { const item = document.createElement(tag); if (cls) item.className = cls; if (text !== undefined) item.textContent = text; return item; };
    const heading = el('div', 'panel-heading'), body = el('div', 'radiacode-body'), selected = el('div', 'radiacode-device');
    const deviceName = el('h3'), addressLabel = el('p', 'mono'), connectionBadge = el('span', 'badge');
    const status = el('p', 'radiacode-status'), controls = el('div', 'radiacode-actions'), results = el('div', 'radiacode-results'), buttons = [];
    const empty = el('div', 'radiacode-empty'), sections = new Map();
    const titles = { measurements: 'Measurements', spectrum: 'Energy spectrum', identity: 'Device identity', status: 'Device status', resetDose: 'Dose reset' };
    const deviceKey = device => device?.address ? `${device.address.toLowerCase()}/${device.addressType}` : '';
    let selectedKey = deviceKey(getDevice()), selectionVersion = 0, liveVersion = 0, connectedKey = '', destroyed = false;
    const live = el('button', 'button secondary', 'Start live'), liveBadge = el('span', 'badge', 'Manual reads');
    const active = () => !document.hidden && (options.isActive ? options.isActive() : typeof NanoWorkspace === 'undefined' || NanoWorkspace.view() === 'apps' && NanoWorkspace.module() === 'radiacode');
    const poller = createPoller({ read: kind => { if (!liveCurrent()) return; liveVersion = selectionVersion; return client.read(kind, getDevice()); }, onResult: result => { if (!liveCurrent()) return; showResult(result); setStatus('Live readings updated.', 'success'); render(); }, onError: error => { if (!current(liveVersion)) return; setStatus(error.message, 'error'); render(); }, onChange: () => render(), stopRead: () => { if (client.busy()) { client.stop(); setStatus('RadiaCode transfer stopped. Reconnect before reading again.', 'error'); } }, intervalMs: options.pollIntervalMs ?? 5000 });
    status.setAttribute('role', 'status'); status.setAttribute('aria-atomic', 'true');
    heading.append(el('h2', '', 'RadiaCode'), liveBadge);
    const deviceInfo = el('div'); deviceInfo.append(deviceName, addressLabel); selected.append(deviceInfo, connectionBadge);
    empty.append(el('h3', '', 'No readings yet'));
    function setStatus(message, state = 'idle') { status.textContent = message; status.dataset.state = state; }
    function clearResults() { sections.clear(); results.replaceChildren(); }
    function current(version) { if (!destroyed) render(); return !destroyed && active() && version === selectionVersion; }
    function liveCurrent() { render(); if (destroyed || !active()) poller.stop(); return poller.active(); }
    function render() {
      if (destroyed) return;
      const device = getDevice(), context = connection.snapshot(), key = deviceKey(device);
      const connected = Boolean(context.online && key && context.state.ble?.connected && deviceKey(context.state.ble) === key);
      const nextConnected = connected ? `${key}/${context.state.ble.connectionAttempt}` : '';
      const selectionChanged = key !== selectedKey, connectionChanged = connectedKey && connectedKey !== nextConnected;
      selectedKey = key; connectedKey = nextConnected;
      if (selectionChanged || connectionChanged) {
        selectionVersion++; poller.stop(); clearResults();
        if (selectionChanged || !client.busy()) setStatus('');
      }
      deviceName.textContent = device ? device.label || device.name || 'RadiaCode device' : ''; selected.hidden = !device;
      addressLabel.textContent = device?.address || '';
      connectionBadge.textContent = connected ? 'Connected' : '';
      connectionBadge.className = `badge${connected ? ' connected' : ''}`; connectionBadge.hidden = !device;
      for (const button of buttons) button.disabled = !device || client.busy() || poller.active() || !context.online || context.pending || context.state.ble?.busy;
      live.disabled = !poller.active() && (!device || client.busy() || !context.online || context.pending || context.state.ble?.busy);
      live.textContent = poller.active() ? 'Stop live' : 'Start live'; live.setAttribute('aria-pressed', String(poller.active()));
      liveBadge.textContent = poller.active() ? 'Live' : 'Manual reads';
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
      if (result.kind === 'spectrum') section.append(spectrumChart(result, el));
      if (result.kind === 'measurements') section.append(el('p', 'radiacode-note', `${result.records.length ? 'Latest available value for each measurement.' : 'The device returned no buffered measurements.'} Dose values use device units.`));
      if (result.warning) section.append(el('p', 'radiacode-note', result.warning));
      if (result.kind === 'status') section.append(el('p', 'radiacode-note', 'Raw status flags (not decoded).'));
      sections.set(result.kind, section);
      results.replaceChildren(...Object.keys(titles).filter(kind => sections.has(kind)).map(kind => sections.get(kind)));
    }
    async function run(kind) {
      if (destroyed || !active() || poller.active()) return;
      render(); const version = selectionVersion;
      setStatus(`Reading ${titles[kind]?.toLowerCase() || 'RadiaCode'}...`, 'reading');
      const operation = client.read(kind, getDevice()); render();
      try {
        const result = await operation; if (!current(version)) return;
        showResult(result); setStatus(`${titles[kind]} updated.`, 'success'); return result;
      } catch (error) { if (current(version)) setStatus(error.message, 'error'); }
      finally { if (!destroyed) render(); }
    }
    for (const [kind, label] of [['measurements', 'Read measurements'], ['spectrum', 'Read spectrum'], ['identity', 'Identity'], ['status', 'Status']]) {
      const button = el('button', `button ${kind === 'measurements' ? 'primary' : 'secondary'}`, label);
      button.type = 'button'; button.addEventListener('click', () => run(kind)); controls.append(button); buttons.push(button);
    }
    live.type = 'button'; live.addEventListener('click', () => { let operation; if (poller.active()) { const interrupted = client.busy(); poller.stop(); if (!interrupted) setStatus('Live refresh stopped.'); } else if (active()) operation = poller.start(); render(); return operation; }); controls.append(live);
    const reset = el('button', 'button radiacode-reset', 'Reset dose'); reset.type = 'button'; buttons.push(reset); controls.append(reset);
    reset.addEventListener('click', async () => {
      if (destroyed || !active()) return;
      render();
      const device = getDevice(), version = selectionVersion;
      if (client.busy() || poller.active() || !device || !(options.confirm || globalThis.confirm)(`Reset the accumulated dose on ${device.label || device.name || device.address}? This clears the device's dose history and statistics.`)) return;
      if (deviceKey(device) !== deviceKey(getDevice()) || !current(version)) return;
      const operation = client.resetDose(device, true); setStatus('Resetting accumulated dose...', 'reading'); render();
      try { const result = await operation; if (current(version)) { sections.delete('measurements'); showResult(result); setStatus('Device acknowledged the dose reset. Read measurements to check the new values.', 'success'); } }
      catch (error) { if (current(version)) setStatus(error.message, 'error'); }
      finally { if (!destroyed) render(); }
    });
    const stop = el('button', 'button quiet', 'Stop'); stop.type = 'button'; stop.addEventListener('click', () => { poller.stop(); render(); }); controls.append(stop);
    const source = el('a', '', 'RadiaCode protocol source'); source.href = 'https://github.com/cdump/radiacode'; source.target = '_blank'; source.rel = 'noopener noreferrer';
    const help = el('details', 'radiacode-help'); help.append(el('summary', '', 'About these readings'), el('p', '', 'Live refresh reads measurements and the spectrum every 5 seconds after the previous read finishes. It stops when you leave this app, hide the page, change devices or disconnect. Spectrum energy uses the calibration stored with the spectrum, in keV. Dose values use device units. Reset dose clears accumulated dose on the device after confirmation.'), source);
    body.append(selected, controls, status, empty, results, help); container.replaceChildren(heading, body);
    const onVisibility = () => { if (!active()) { selectionVersion++; poller.stop(); } render(); };
    const onApiChange = () => { selectionVersion++; connectedKey = ''; poller.stop(); clearResults(); setStatus(''); render(); };
    const off = lab.onState(render); document.addEventListener('nanoscope:selection', render); document.addEventListener('nanoscope:busy', render); document.addEventListener('nanoscope:workspace', onVisibility); document.addEventListener('visibilitychange', onVisibility); render();
    globalThis.addEventListener?.('nanoscope:api-change', onApiChange);
    return { read: run, stop: () => poller.stop(), destroy() { destroyed = true; poller.stop(); client.destroy(); off?.(); document.removeEventListener('nanoscope:selection', render); document.removeEventListener('nanoscope:busy', render); document.removeEventListener('nanoscope:workspace', onVisibility); document.removeEventListener('visibilitychange', onVisibility); globalThis.removeEventListener?.('nanoscope:api-change', onApiChange); } };
  }
  return { createClient, createPoller, mount };
})();
if (typeof module !== 'undefined') module.exports = NanoRadiaCode;
