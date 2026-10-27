'use strict';

const NanoProtocolApp = (() => {
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  function download(name, value) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })), link = el('a');
    link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function fields(values, primary = []) {
    const list = el('dl', 'protocol-values');
    const order = label => primary.includes(label) ? primary.indexOf(label) : primary.length;
    for (const value of [...values].sort((a, b) => order(a.label) - order(b.label))) { const item = el('div'); item.append(el('dt', '', value.label), el('dd', '', String(value.value))); list.append(item); }
    return list;
  }
  function mount(container, id, hooks) {
    const app = NanoDeviceApps.get(id), protocol = app.protocol;
    container.classList.add('protocol-panel');
    const heading = el('div', 'panel-heading'), title = el('h2', '', 'Observed data'), mode = el('span', 'badge'); heading.append(title, mode);
    const body = el('div', 'protocol-body'), context = el('p', 'vendor-note'), readings = el('div'), evidence = el('div', 'protocol-evidence');
    const packetDetails = el('details', 'protocol-details'), packetFields = el('div'); packetDetails.append(el('summary', '', 'Packet details'), packetFields); packetDetails.hidden = true;
    const actions = el('div', 'protocol-actions'), exportSnapshot = el('button', 'button secondary', 'Export snapshot'), inspect = el('button', 'button secondary', 'Show advertisement');
    const raw = el('pre', 'protocol-preview'); raw.hidden = true;
    exportSnapshot.type = inspect.type = 'button'; actions.append(exportSnapshot, inspect);
    const history = el('details', 'protocol-details'), historyLabel = el('summary', '', 'Changes while this app is open'), historyList = el('ol', 'protocol-history'); history.append(historyLabel, historyList);
    const importer = el('details', 'protocol-details'), importLabel = el('summary', '', 'Inspect a saved value'), importBody = el('div', 'protocol-import'); importer.append(importLabel, importBody);
    const format = el('select'), formatLabel = el('label', '', 'Data format'); formatLabel.append(format);
    for (const [value, text] of [...(protocol.manufacturer === false ? [] : [['manufacturer', 'Manufacturer HEX']]), ...(protocol.decode ? [['gatt', protocol.captureLabel || 'Characteristic HEX']] : []), ...(protocol.decodeService ? [['service', 'Service-data HEX']] : []), ...(protocol.decodeStatus ? [['status', protocol.statusLabel || 'VeSync status JSON']] : []), ...(protocol.decodePlaintext ? [['plaintext', 'Decrypted JSON-RPC']] : [])]) { const option = el('option', '', text); option.value = value; format.append(option); }
    const uuidLabel = el('label', '', 'Characteristic UUID'), uuid = el('input'); uuid.type = 'text'; uuid.placeholder = protocol.characteristics?.status || '00002a19-0000-1000-8000-00805f9b34fb'; uuidLabel.append(uuid); uuidLabel.hidden = true;
    const valueLabel = el('label', '', 'Captured value'), value = el('textarea'); value.rows = 4; value.maxLength = 65536; value.spellcheck = false; valueLabel.append(value);
    const decode = el('button', 'button secondary', 'Decode locally'), imported = el('div', 'protocol-imported'); decode.type = 'button'; imported.setAttribute('aria-live', 'polite');
    importBody.append(el('p', 'vendor-note', 'Imported values stay separate from live observations.'), formatLabel, uuidLabel, valueLabel, decode, imported);
    function selectFormat() { uuidLabel.hidden = !['gatt', 'service'].includes(format.value); uuidLabel.textContent = format.value === 'service' ? 'Service UUID' : 'Characteristic UUID'; uuidLabel.append(uuid); value.placeholder = format.value === 'status' ? protocol.captureExample || '' : ''; uuid.placeholder = format.value === 'service' ? protocol.service : protocol.characteristics?.status || '00002a19-0000-1000-8000-00805f9b34fb'; imported.replaceChildren(); }
    format.addEventListener('change', selectFormat); selectFormat();
    const composer = el('details', 'protocol-details'), composerLabel = el('summary', '', 'Prepare a command'), form = el('form', 'protocol-composer'); composer.append(composerLabel, form);
    const commandLabel = el('label', '', 'Operation'), command = el('select'); commandLabel.append(command);
    const inputs = el('div', 'protocol-inputs'), description = el('p', 'vendor-note'), preview = el('pre', 'protocol-preview protocol-command-preview'), message = el('p', 'protocol-message'); message.setAttribute('role', 'status');
    const prepare = el('button', 'button secondary', 'Build preview'), save = el('button', 'button secondary', 'Export command plan'); prepare.type = 'submit'; save.type = 'button'; save.disabled = true;
    const buttons = el('div', 'protocol-actions'); buttons.append(prepare, save);
    form.append(el('p', 'vendor-note', 'Preview only. Nothing is sent to the device.'), commandLabel, description, inputs, buttons, message, preview);
    for (const item of protocol.commands || []) { const option = el('option', '', item.label); option.value = item.id; command.append(option); }
    composer.hidden = !protocol.commands?.length; preview.hidden = true;
    let controls = new Map(), currentKey = '', currentSnapshot = null, plan = null, before = null, samples = [], lastSignature = '';
    function resetPreview() { plan = null; preview.textContent = ''; preview.hidden = true; save.disabled = true; message.textContent = ''; }
    function buildInputs() {
      inputs.replaceChildren(); controls = new Map(); resetPreview();
      const spec = protocol.commands?.find(item => item.id === command.value); description.textContent = spec?.description || '';
      for (const field of spec?.inputs || []) {
        const label = el('label', '', field.label), input = el(field.type === 'select' ? 'select' : 'input');
        if (field.type === 'select') for (const item of field.options || []) { const option = el('option', '', item.label); option.value = item.value; input.append(option); }
        else { input.type = field.type || 'text'; input.autocomplete = 'off'; if (field.min !== undefined) input.min = field.min; if (field.max !== undefined) input.max = field.max; if (field.step !== undefined) input.step = field.step; }
        input.value = field.default ?? ''; label.append(input); inputs.append(label); controls.set(field.id, input); input.addEventListener('input', resetPreview); input.addEventListener('change', resetPreview);
      }
    }
    command.addEventListener('change', buildInputs); buildInputs();
    form.addEventListener('submit', event => {
      event.preventDefault(); resetPreview();
      try {
        const device = hooks.selected(); if (!device || !protocol.identify(device)) throw new Error('Select a matching device first.');
        const values = Object.fromEntries([...controls].map(([key, input]) => [key, input.value])); if (id !== 'vesync') values.device = device;
        plan = protocol.buildCommand(command.value, values);
        preview.textContent = JSON.stringify({ summary: plan.summary, transport: plan.transport || 'BLE GATT', hex: plan.hex, steps: plan.steps, request: plan.request, ...plan }, null, 2); preview.hidden = false;
        const sensitive = plan.sensitive || protocol.commands.find(item => item.id === command.value)?.sensitive;
        save.disabled = Boolean(sensitive); message.textContent = sensitive ? 'Secret preview is temporary. Export is disabled; close this app to clear it.' : plan.steps ? 'Preview ready. Export it to run in Workbench.' : 'Preview ready.';
      } catch (error) { message.textContent = error.message; }
    });
    save.addEventListener('click', () => {
      if (!plan || save.disabled) return;
      const output = plan.steps ? NanoRecipeModel.validate({ version: 1, name: plan.summary.slice(0, 80), address: hooks.selected().address, steps: plan.steps }) : { version: 1, app: id, createdAt: new Date().toISOString(), plan };
      download(`gattelier-${id}-command.json`, output);
    });
    exportSnapshot.addEventListener('click', () => { if (currentSnapshot) download(`gattelier-${id}-snapshot.json`, { version: 1, app: id, capturedAt: new Date().toISOString(), snapshot: currentSnapshot, changes: samples }); });
    inspect.addEventListener('click', () => { raw.hidden = !raw.hidden; inspect.textContent = raw.hidden ? 'Show advertisement' : 'Hide advertisement'; });
    decode.addEventListener('click', () => {
      imported.replaceChildren();
      try {
        let result;
        if (format.value === 'manufacturer') { const profile = protocol.identify({ ...(hooks.selected() || {}), manufacturer: value.value.replace(/\s/g, ''), services: [], serviceData: [], payloadHex: '', payloadTruncated: false }); result = profile?.fields; }
        else if (format.value === 'gatt') result = protocol.decode(uuid.value.trim() || uuid.placeholder, value.value.trim(), { device: hooks.selected() });
        else if (format.value === 'service') result = protocol.decodeService(uuid.value.trim() || uuid.placeholder, value.value.trim());
        else if (format.value === 'plaintext') result = protocol.decodePlaintext(value.value.trim()).fields;
        else result = protocol.decodeStatus(JSON.parse(value.value));
        if (!result?.length) throw new Error('No supported fields were found. Check the data format and selected device.');
        imported.append(el('h3', '', 'Imported value'), fields(result));
      } catch (error) { imported.append(el('p', 'protocol-message', error.message)); }
    });
    const sourceDetails = el('details', 'protocol-details'), sourceLabel = el('summary', '', 'Protocol support & sources'), sources = el('div', 'protocol-sources'); sourceDetails.append(sourceLabel, sources);
    for (const source of protocol.sources) { const link = el('a', '', source.title); link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; sources.append(link); }
    body.append(context, readings, actions, raw, packetDetails, history, importer, composer, evidence, sourceDetails); container.append(heading, body);
    function clearTransient() { resetPreview(); for (const input of controls.values()) if (input.type === 'password') input.value = ''; value.value = ''; imported.replaceChildren(); }
    document.addEventListener('nanoscope:workspace', () => { if (NanoWorkspace.view() !== 'apps' || NanoWorkspace.module() !== id) clearTransient(); });
    function render(device, state) {
      const key = device ? `${device.address}/${device.addressType}` : '';
      if (key !== currentKey) { currentKey = key; before = null; samples = []; lastSignature = ''; clearTransient(); buildInputs(); raw.hidden = true; inspect.textContent = 'Show advertisement'; }
      composer.hidden = !protocol.commands?.length || Boolean(protocol.canPrepare && !protocol.canPrepare(device));
      currentSnapshot = device && NanoDeviceApps.snapshot(id, device, state);
      exportSnapshot.disabled = !currentSnapshot; inspect.disabled = !currentSnapshot; prepare.disabled = !currentSnapshot;
      raw.textContent = currentSnapshot ? JSON.stringify({ address: device.address, addressType: device.addressType, manufacturer: device.manufacturer, services: device.services, serviceData: device.serviceData, payloadHex: device.payloadHex }, null, 2) : '';
      if (!currentSnapshot) { lastSignature = ''; context.textContent = 'Choose a matching device in Discover.'; mode.textContent = ''; readings.replaceChildren(); packetFields.replaceChildren(); packetDetails.hidden = true; evidence.replaceChildren(); historyList.replaceChildren(); return; }
      context.textContent = `${currentSnapshot.title} · ${Number.isFinite(device.rssi) ? `${device.rssi} dBm · ` : ''}${device.lastSeenMs ? NanoInsights.age(device.lastSeenMs) : 'Saved observation'}`;
      mode.textContent = device.streamLive || device.liveId != null ? 'Broadcast updates' : 'Saved observation';
      const signature = JSON.stringify([currentSnapshot.fields, currentSnapshot.limitations]);
      if (signature === lastSignature) return; lastSignature = signature;
      const delta = NanoDeviceApps.changes(before, currentSnapshot);
      if (before && delta.length) samples.unshift({ at: new Date(device.lastSeenMs || Date.now()).toISOString(), fields: delta });
      samples = samples.slice(0, 80); before = currentSnapshot;
      const prominent = id === 'samsung' ? currentSnapshot.fields.filter(field => app.primary.includes(field.label)) : [];
      const secondary = prominent.length ? currentSnapshot.fields.filter(field => !app.primary.includes(field.label)) : [];
      readings.replaceChildren(fields(prominent.length ? prominent : currentSnapshot.fields, app.primary)); packetDetails.hidden = !secondary.length; packetFields.replaceChildren(...(secondary.length ? [fields(secondary)] : [])); evidence.replaceChildren();
      for (const text of [...currentSnapshot.evidence, ...currentSnapshot.limitations]) evidence.append(el('p', 'vendor-note', text));
      historyList.replaceChildren(); historyLabel.textContent = `Changes while this app is open${samples.length ? ` (${samples.length})` : ''}`;
      if (!samples.length) historyList.append(el('li', 'vendor-note', 'No changes yet'));
      for (const sample of samples) { const row = el('li'); row.append(el('time', '', new Date(sample.at).toLocaleTimeString())); for (const change of sample.fields) row.append(el('p', '', `${change.label}: ${change.before} → ${change.after}`)); historyList.append(row); }
    }
    return { render };
  }
  return { mount };
})();
