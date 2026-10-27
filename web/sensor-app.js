'use strict';

const NanoSensorApp = (() => {
  let controller;
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const button = (text, action) => { const node = el('button', 'button secondary', text); node.type = 'button'; node.addEventListener('click', action); return node; };
  const number = value => Number(value.toFixed(3)).toLocaleString();
  const measurementOrder = ['Temperature', 'Humidity', 'CO2', 'PM2.5', 'PM10', 'PM1', 'PM4', 'VOC index', 'NOX index', 'Pressure', 'Illuminance', 'Battery'];
  const rank = label => measurementOrder.includes(label) ? measurementOrder.indexOf(label) : measurementOrder.length;
  function download(device, history, csv) {
    const blob = new Blob([csv ? history.csv(device) : JSON.stringify(history.exportDevice(device), null, 2)], { type: csv ? 'text/csv' : 'application/json' });
    const url = URL.createObjectURL(blob), link = el('a'); link.href = url; link.download = `gattelier-sensor-${device.address.replaceAll(':', '')}.${csv ? 'csv' : 'json'}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function chart(points, label) {
    const section = el('div', 'sensor-chart');
    if (!points.length) { section.append(el('p', 'vendor-note', 'Waiting for readings in this time range.')); return section; }
    const low = Math.min(...points.map(point => point.value)), high = Math.max(...points.map(point => point.value));
    const span = Math.max(high - low, 1), start = points[0].at, duration = Math.max(points.at(-1).at - start, 1000);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 640 200'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `${label}: ${number(low)} to ${number(high)} ${points[0].unit}, ${points.length} observations`);
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', points.map((point, index) => `${!index || point.at - points[index - 1].at > 60000 ? 'M' : 'L'}${20 + (point.at - start) / duration * 600},${170 - (point.value - low + (high === low ? .5 : 0)) / span * 140}`).join(' '));
    svg.append(path);
    for (const point of points) { const circle = document.createElementNS(svg.namespaceURI, 'circle'); circle.setAttribute('cx', 20 + (point.at - start) / duration * 600); circle.setAttribute('cy', 170 - (point.value - low + (high === low ? .5 : 0)) / span * 140); circle.setAttribute('r', points.length > 100 ? 1 : 2.5); svg.append(circle); }
    const axis = el('div', 'sensor-chart-axis'); axis.append(el('span', '', new Date(start).toLocaleTimeString()), el('span', '', `${number(low)}–${number(high)} ${points[0].unit}`), el('span', '', new Date(points.at(-1).at).toLocaleTimeString())); section.append(svg, axis); return section;
  }
  function mount(container, hooks) {
    container.classList.add('protocol-panel');
    const heading = el('div', 'panel-heading'), badge = el('span', 'badge'), tools = el('div', 'heading-tools'); heading.append(el('h2', '', 'Readings'), tools); tools.append(badge);
    tools.insertAdjacentHTML('beforeend', '<details class="help"><summary aria-label="About sensor readings"><span aria-hidden="true">?</span></summary><div class="help-body"><p>Readings are collected while this tab is open, including on other views. Unencrypted readings are saved in this browser for up to 32 sensors. Unchanged readings are sampled every 5 seconds.</p><p>Encryption keys stay in memory and clear when you leave this app.</p></div></details>');
    const body = el('div', 'protocol-body'), context = el('p', 'vendor-note'), readings = el('dl', 'protocol-values'), status = el('p', 'protocol-message'); status.setAttribute('role', 'status');
    const keyForm = el('form', 'sensor-key-form'), keyLabel = el('label', '', 'BTHome encryption key'), keyInput = el('input'); keyInput.type = 'password'; keyInput.autocomplete = 'off'; keyInput.spellcheck = false; keyInput.maxLength = 32; keyLabel.append(keyInput);
    const unlock = el('button', 'button secondary', 'Decode with key'); unlock.type = 'submit';
    const forget = button('Forget key', () => { keyInput.value = ''; session.lock(); });
    const keyActions = el('div', 'protocol-actions'); keyActions.append(unlock, forget);
    keyForm.append(keyLabel, keyActions, el('p', 'vendor-note', 'The key and decrypted readings stay in memory only.'));
    const toolbar = el('div', 'sensor-chart-controls'), metricLabel = el('label', '', 'Measurement'), metric = el('select'), rangeLabel = el('label', '', 'Time range'), range = el('select'); metricLabel.append(metric); rangeLabel.append(range);
    for (const [value, text] of [['900000', 'Last 15 minutes'], ['3600000', 'Last hour'], ['0', 'All saved readings']]) { const option = el('option', '', text); option.value = value; range.append(option); }
    toolbar.append(metricLabel, rangeLabel); const plot = el('div'), statistics = el('dl', 'sensor-statistics');
    const actions = el('div', 'protocol-actions'), pause = button('Pause history', () => session.toggle());
    const json = button('Export JSON', () => { const device = session.status().device; if (device) download(device, history, false); });
    const csv = button('Export CSV', () => { const device = session.status().device; if (device) download(device, history, true); }); actions.append(pause, json, csv);
    const storage = el('p', 'vendor-note'), clearDetails = el('details', 'protocol-details'); clearDetails.append(el('summary', '', 'Clear this sensor’s history'));
    clearDetails.append(el('p', 'vendor-note', 'Removes all readings for this sensor. Export first to keep a copy.'), button('Clear readings', async () => { const device = session.status().device; if (device) await history.clear(device); paint(); }));
    const meta = el('details', 'protocol-details'), metaBody = el('div'); meta.append(el('summary', '', 'Advertisement details & sources'), metaBody);
    const imported = el('details', 'protocol-details'), importBody = el('div', 'protocol-import'), importFormatLabel = el('label', '', 'Captured data format'), importFormat = el('select'); importFormatLabel.append(importFormat);
    for (const [value, text] of [['manufacturer', 'Ruuvi manufacturer HEX'], ['bthome', 'BTHome service-data HEX']]) { const option = el('option', '', text); option.value = value; importFormat.append(option); }
    const importLabel = el('label', '', 'Captured advertisement HEX'), importValue = el('textarea'), importResult = el('div'); importValue.rows = 3; importValue.maxLength = 3300; importValue.spellcheck = false; importLabel.append(importValue); importResult.setAttribute('aria-live', 'polite');
    const inspect = button('Inspect locally', () => {
      importResult.replaceChildren(); const hex = importValue.value.replace(/\s/g, '');
      const profile = NanoSensorProfiles.identify(importFormat.value === 'bthome' ? { serviceData: [{ uuid: 'fcd2', hex }] } : { manufacturer: hex });
      if (!profile) { importResult.append(el('p', 'protocol-message', 'No supported sensor frame was found. Ruuvi data starts with company bytes 9904. BTHome data starts with the device-info byte, without the FCD2 UUID.')); return; }
      importResult.append(NanoInsights.profileCard(profile));
    });
    imported.append(el('summary', '', 'Inspect a saved advertisement'), importBody); importBody.append(el('p', 'vendor-note', 'Imported readings stay separate from device history.'), importFormatLabel, importLabel, inspect, importResult);
    body.append(context, status, keyForm, readings, toolbar, plot, statistics, actions, storage, clearDetails, imported, meta); container.append(heading, body);
    const history = NanoSensorHistory.create(), session = NanoSensorSession.create(history, { change: paint }); controller = session;
    let lastFields = '', lastChart = '', optionsKey = '';
    function paint() {
      const state = session.status(), device = state.device, profile = state.profile;
      context.textContent = device ? `${device.label || device.name || device.address} · ${device.rssi} dBm · ${NanoInsights.age(device.lastSeenMs)}` : 'Choose a BTHome or Ruuvi sensor in Discover.';
      badge.textContent = state.pending ? 'Checking authentication' : profile?.authenticated ? 'Authenticated payload' : device?.streamLive || device?.liveId != null ? 'Live' : device ? 'Saved' : '';
      status.textContent = state.message || (state.encrypted && !state.hasKey ? 'This sensor encrypts its readings. Enter its key to decode them locally.' : profile?.fields.some(field => field.label === 'Calibration' && field.value === 'In progress') ? 'Sensor calibration is in progress. Readings have not settled.' : '');
      keyForm.hidden = !state.encrypted; forget.disabled = !state.hasKey; unlock.disabled = state.pending;
      pause.disabled = !profile; pause.textContent = state.recording ? 'Pause history' : 'Resume history';
      const samples = device ? history.samples(device) : [], numeric = (profile?.fields.filter(field => Number.isFinite(field.numericValue)) || []).sort((a, b) => rank(a.label) - rank(b.label));
      const labels = [...new Set([...numeric.map(field => field.label), ...samples.flatMap(sample => sample.fields.map(field => field.label))])].sort((a, b) => rank(a) - rank(b));
      const currentOptions = JSON.stringify(labels);
      if (currentOptions !== optionsKey) { const selected = metric.value; optionsKey = currentOptions; metric.replaceChildren(); for (const label of labels) { const option = el('option', '', label); option.value = label; metric.append(option); } if (labels.includes(selected)) metric.value = selected; }
      metric.disabled = !labels.length; json.disabled = csv.disabled = !samples.length;
      const fieldsKey = JSON.stringify(profile?.fields);
      if (fieldsKey !== lastFields) {
        lastFields = fieldsKey; readings.replaceChildren(); metaBody.replaceChildren();
        for (const field of numeric) { const item = el('div'); item.append(el('dt', '', field.label), el('dd', '', String(field.value))); readings.append(item); }
        if (profile) metaBody.append(NanoInsights.profileCard(profile));
      }
      readings.hidden = !numeric.length;
      const points = device ? history.series(device, metric.value, Number(range.value) ? Date.now() - Number(range.value) : 0) : [];
      const chartKey = JSON.stringify([metric.value, points]);
      if (chartKey !== lastChart) {
        lastChart = chartKey; plot.replaceChildren(chart(points, metric.value)); statistics.replaceChildren(); const summary = history.summary(points);
        if (summary) for (const [label, value] of [['Latest', summary.latest], ['Minimum', summary.minimum], ['Maximum', summary.maximum], ['Average', summary.average]]) { const item = el('div'); item.append(el('dt', '', label), el('dd', '', `${number(value)} ${summary.unit}`)); statistics.append(item); }
      }
      const stored = history.status();
      storage.textContent = `${samples.length} of ${stored.limit} readings${state.recording ? '' : ' · paused'}${stored.available ? '' : ` · memory only. ${stored.error}`}`;
    }
    metric.addEventListener('change', paint); range.addEventListener('change', paint);
    keyForm.addEventListener('submit', async event => { event.preventDefault(); const value = keyInput.value.trim(); keyInput.value = ''; try { await session.unlock(value); } catch (error) { status.textContent = error.message; } });
    document.addEventListener('nanoscope:workspace', () => { if (NanoWorkspace.view() !== 'apps' || NanoWorkspace.module() !== 'sensor') { keyInput.value = ''; importValue.value = ''; importResult.replaceChildren(); session.lock(); } });
    history.init().then(paint); paint();
    return { render(device) { session.select(device); paint(); } };
  }
  function update(devices) { const selected = controller?.status().device; if (selected) controller.observe(devices.find(device => device.address === selected.address && device.addressType === selected.addressType)); }
  return { mount, update };
})();
