'use strict';

const NanoSchlageApp = (() => {
  const el = (tag, cls = '', text) => { const node = document.createElement(tag); node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  function mount(container, lab, hooks = {}) {
    const heading = el('div', 'module-heading'), title = el('h3', '', 'Schlage'), context = el('p', 'vendor-note');
    heading.append(title, context);
    const body = el('div', 'support-module'), identity = el('dl', 'metadata'), transport = el('div', 'schlage-transport');
    const status = el('p', 'protocol-message'); status.setAttribute('role', 'status');
    const actions = el('div', 'inspector-shortcuts');
    const read = el('button', 'button', 'Read identity'), inspect = el('button', 'button secondary', 'Inspect services'), save = el('button', 'button secondary', 'Save to inventory'), exportButton = el('button', 'button secondary', 'Export snapshot');
    for (const button of [read, inspect, save, exportButton]) button.type = 'button';
    actions.append(read, inspect, save, exportButton);
    const location = el('input'); location.type = 'text'; location.maxLength = 100; location.placeholder = 'Entry or location';
    const label = el('label', '', 'Inventory label'); label.append(location);
    const stored = el('p', 'vendor-note'), management = el('p', 'vendor-note', 'Lock controls and access codes use your authorized Schlage Home account.');
    const home = el('a', 'button secondary', 'Schlage Home'); home.href = 'https://www.schlage.com/en/home/products/schlage-home.html'; home.target = '_blank'; home.rel = 'noopener noreferrer';
    const importer = el('details', 'protocol-details'), summary = el('summary', '', 'Decode a captured uWeave packet');
    const direction = el('select'); direction.setAttribute('aria-label', 'Packet direction');
    for (const [value, text] of [[NanoSchlage.tx, 'Response from lock'], [NanoSchlage.rx, 'Command to lock']]) { const option = el('option', '', text); option.value = value; direction.append(option); }
    const packet = el('textarea'); packet.rows = 3; packet.placeholder = 'Hex bytes'; packet.setAttribute('aria-label', 'Captured packet hex');
    const decode = el('button', 'button secondary', 'Decode packet'); decode.type = 'button';
    const decoded = el('dl', 'metadata'); importer.append(summary, direction, packet, decode, decoded);
    const sources = el('details', 'protocol-details'), sourceTitle = el('summary', '', 'Protocol sources'), source = el('a', '', 'Schlage uWeave transport');
    source.href = NanoSchlage.source; source.target = '_blank'; source.rel = 'noopener noreferrer'; sources.append(sourceTitle, source);
    body.append(identity, transport, actions, status, label, stored, management, home, importer, sources); container.append(heading, body);
    let running = false, selectedKey = '', saved = null, snapshot = null, signature = '';
    const device = () => hooks.selected?.() || NanoConnection.snapshot().selected;
    const scope = target => `${NanoAPI.transport?.() === 'serial' ? 'usb' : NanoAPI.origin()}:${target.address.toLowerCase()}/${target.addressType}`;
    const storageKey = target => `gattelier.schlage:${scope(target)}`;
    function row(root, label, value) { const item = el('div'); item.append(el('dt', '', label), el('dd', '', String(value))); root.append(item); }
    function render() {
      const target = device(), state = lab.getState(), match = NanoSchlage.identify(target, state), nextKey = target ? scope(target) : '';
      if (nextKey !== selectedKey) {
        selectedKey = nextKey; saved = null; status.textContent = ''; signature = ''; packet.value = ''; decoded.replaceChildren();
        try { saved = target ? JSON.parse(localStorage.getItem(storageKey(target)) || 'null') : null; } catch {}
        if (saved?.version !== 1 || saved.scope !== selectedKey) saved = null;
        location.value = typeof saved?.label === 'string' ? saved.label : '';
      }
      const services = NanoSchlage.gatt(target, state), fields = match?.identity || {};
      const current = services.length > 0;
      snapshot = target && match ? { version: 1, scope: nextKey, capturedAt: new Date().toISOString(), device: { address: target.address, addressType: target.addressType, name: target.name || '' }, identity: current ? fields : saved?.identity || fields, services: (current ? services : saved?.services || (target.services || []).map(uuid => ({ uuid, characteristics: [] }))).map(service => ({ uuid: service.uuid, characteristics: (service.characteristics || []).map(item => ({ uuid: item.uuid, handle: item.handle, properties: item.properties })) })) } : null;
      const signatureNext = JSON.stringify([nextKey, fields, services.map(item => item.uuid), saved, running, NanoConnection.describe(target)]);
      if (signatureNext === signature) return; signature = signatureNext;
      title.textContent = match?.title || 'Schlage'; context.textContent = target ? `${target.label || target.name || target.address} · ${current ? 'Connected' : saved ? 'Saved snapshot' : 'Discovered'}` : 'Select a Schlage device';
      identity.replaceChildren();
      for (const [key, value] of Object.entries(current ? fields : saved?.identity || fields)) row(identity, ({ model: 'Model', serial: 'Serial number', firmware: 'Firmware', hardware: 'Hardware', software: 'Software', manufacturer: 'Manufacturer' })[key] || key, value);
      transport.replaceChildren();
      const channels = (current ? services : saved?.services || []).find(service => NanoSchlage.uuid(service.uuid) === NanoSchlage.transport);
      if (channels) {
        transport.append(el('h4', '', 'uWeave transport'));
        for (const item of channels.characteristics || []) {
          const known = NanoSchlage.lookup(item.uuid, channels.uuid); if (!known) continue;
          transport.append(el('p', 'vendor-note', `${known.name} · handle ${item.handle} · ${(item.properties || []).join(', ')}`));
        }
      }
      const connection = NanoConnection.describe(target);
      read.disabled = !match || running || !connection.enabled; inspect.disabled = !target; save.disabled = !snapshot || running; exportButton.disabled = !saved && !snapshot;
      location.disabled = !match; stored.textContent = saved?.capturedAt ? `Saved ${new Date(saved.capturedAt).toLocaleString()}` : '';
    }
    read.addEventListener('click', async () => {
      const target = device(); if (running || !NanoSchlage.identify(target, lab.getState())) return;
      const selectedScope = scope(target); running = true; render(); status.textContent = 'Reading identity…';
      try {
        const state = await NanoConnection.ensure(target);
        const safe = new Set(['2a24', '2a25', '2a26', '2a27', '2a28', '2a29']);
        const readable = NanoSchlage.gatt(target, state).filter(item => NanoSchlage.uuid(item.uuid) === '180a').flatMap(item => item.characteristics || []).filter(item => safe.has(NanoSchlage.uuid(item.uuid)) && item.properties.includes('read'));
        let count = 0;
        for (const item of readable) {
          if (!NanoSchlage.same(target, device()) || !lab.getState().ble?.connected || !NanoSchlage.same(target, lab.getState().ble)) throw new Error('The selected connection changed.');
          await lab.action('read', { handle: item.handle }); count++;
        }
        if (selectedKey === selectedScope) status.textContent = `Read ${count} identity fields.`;
      } catch (error) { if (selectedKey === selectedScope) status.textContent = error.message; }
      finally { running = false; render(); }
    });
    inspect.addEventListener('click', () => { const target = device(); if (target) NanoDevicePage.services(target); });
    save.addEventListener('click', () => {
      if (!snapshot) return;
      try { const value = { ...snapshot, label: location.value.trim() }; localStorage.setItem(storageKey(device()), JSON.stringify(value)); saved = value; status.textContent = 'Snapshot saved.'; render(); }
      catch { status.textContent = 'Browser storage is unavailable. Export the snapshot to keep it.'; }
    });
    exportButton.addEventListener('click', () => {
      const data = snapshot || saved; if (!data) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify({ ...data, label: location.value.trim() }, null, 2)], { type: 'application/json' })), link = el('a');
      link.href = url; link.download = 'schlage-snapshot.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    decode.addEventListener('click', () => {
      decoded.replaceChildren(); const hex = packet.value.replace(/\s/g, '');
      const fields = NanoSchlage.decode(direction.value, hex, { serviceUuid: NanoSchlage.transport });
      if (!fields.length) row(decoded, 'Packet', 'Enter 1–512 bytes of hex.');
      else for (const field of fields) row(decoded, field.label, field.value);
    });
    lab.onState(render); document.addEventListener('nanoscope:selection', render); render();
    return { render };
  }
  return { mount };
})();
