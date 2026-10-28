'use strict';

const NanoDeviceSupport = (() => {
  const families = { thermometer: ['health-thermometer', 'environmental-sensor'], locks: ['nuki-lock'], resmed: ['resmed-air11'], ge: ['ge-appliance'], samsung: ['samsung-device', 'samsung-tv'] };
  function mount(container, kind, lab, hooks = {}) {
    container.classList.add('support-panel');
    const el = (tag, cls, text) => { const value = document.createElement(tag); if (cls) value.className = cls; if (text !== undefined) value.textContent = text; return value; };
    const body = el('div', 'support-module'), summary = el('div'), controls = el('div', 'inspector-shortcuts'), results = el('dl', 'metadata'), recipes = el('div', 'inspector-shortcuts');
    const status = el('p', 'vendor-note'); status.setAttribute('role', 'status');
    const read = el('button', 'button secondary', 'Read device metadata'), inspect = el('button', 'button secondary', 'Inspect services'); read.type = inspect.type = 'button'; controls.append(read, inspect);
    const details = el('details'), title = el('summary', '', 'Protocol support & sources'); details.append(title);
    body.append(summary, controls, status, results, recipes, details); container.append(body);
    let running = false, signature = '', targetKey = '', connectionKey = '', selectionVersion = 0, connectionVersion = 0;
    const key = device => device ? `${String(device.address || '').toLowerCase()}/${device.addressType}` : '';
    const entries = families[kind].map(id => NanoDeviceLibrary.get(id));
    for (const entry of entries) {
      const heading = el('h3', '', entry.title), text = el('p', 'vendor-note', `${entry.description} ${entry.authentication} ${entry.limitations}`);
      details.append(heading, text);
      for (const source of entry.sources) { const link = el('a', 'vendor-note', source.title); link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; details.append(link); }
    }
    for (const id of [...new Set(entries.flatMap(item => item.recipes))]) {
      const recipe = NanoRecipeLibrary.get(id); if (!recipe) continue;
      const button = el('button', 'button secondary', recipe.name); button.type = 'button';
      button.addEventListener('click', () => NanoRecipeBrowser.load(id)); recipes.append(button);
    }
    const metadata = () => {
      const context = NanoConnection.snapshot(), device = hooks.selected ? hooks.selected() : context.selected;
      const nextTarget = key(device), nextConnection = JSON.stringify([context.online, Boolean(context.state.ble?.connected), key(context.state.ble), context.state.ble?.connectionAttempt]);
      if (nextTarget !== targetKey) { targetKey = nextTarget; selectionVersion++; status.textContent = ''; }
      if (nextConnection !== connectionKey) { connectionKey = nextConnection; connectionVersion++; }
      const connected = device && context.online && context.state.ble?.connected && key(context.state.ble) === nextTarget;
      return { ...context, device, connected, characteristics: connected ? (context.state.services || []).flatMap(service => service.characteristics || []) : [] };
    };
    function render() {
      const context = metadata(), matches = context.device ? NanoDeviceLibrary.match(context.device, context.state).filter(item => families[kind].includes(item.id)) : [];
      const next = JSON.stringify([context.device?.address, context.device?.addressType, context.connected, context.characteristics, context.online, context.pending, context.state.ble?.busy, context.device?.connectable, context.state.usb?.mode, connectionVersion, running]);
      if (next === signature) return; signature = next;
      summary.replaceChildren(el('h3', '', kind === 'locks' ? 'Lock metadata' : kind === 'samsung' ? 'Samsung device metadata' : matches.length ? matches.map(item => item.title).join(' / ') : entries.map(item => item.title).join(' / ')));
      read.disabled = !context.online || !context.device || !context.connected && context.device.connectable === false || context.pending || context.state.ble?.busy || context.state.usb?.mode === 'hci' || running;
      inspect.disabled = !context.device || context.pending || context.state.ble?.busy;
      results.replaceChildren();
      for (const characteristic of context.characteristics) {
        const fields = NanoGattValues.decode(characteristic.uuid, characteristic.valueHex || '');
        for (const field of fields) { const row = el('div'); row.append(el('dt', '', field.label), el('dd', '', field.value)); results.append(row); }
      }
    }
    read.addEventListener('click', async () => {
      const initial = metadata(), device = initial.device, selection = selectionVersion;
      if (!device || running || !initial.online || initial.pending || initial.state.ble?.busy || initial.state.usb?.mode === 'hci' || !initial.connected && device.connectable === false) return;
      const selected = () => { const current = metadata(); return selection === selectionVersion && key(device) === key(current.device); };
      running = true; render(); status.textContent = 'Connecting and reading available metadata…';
      try {
        const state = await NanoConnection.ensure(device), identity = new Set(['2a00', '2a19', '2a24', '2a25', '2a26', '2a27', '2a28', '2a29']);
        const current = metadata(), connection = connectionVersion;
        if (!selected() || !current.connected || key(state.ble) !== key(device) || !state.ble?.connected || state.ble.connectionAttempt !== current.state.ble?.connectionAttempt) throw new Error('The selected connection changed.');
        const guard = () => {
          const context = metadata();
          if (!selected() || !context.connected || connection !== connectionVersion) throw new Error('The selected connection changed.');
          return context;
        };
        const readable = (state.services || []).flatMap(service => service.characteristics || []).filter(item => identity.has(NanoDeviceLibrary.uuid(item.uuid)) && item.properties?.includes('read'));
        let completed = 0;
        for (const item of readable) {
          const context = guard();
          if (context.pending || context.state.ble?.busy || context.state.usb?.mode === 'hci') throw new Error('Wait for the current BLE operation to finish.');
          const available = context.characteristics.find(value => value.handle === item.handle && NanoDeviceLibrary.uuid(value.uuid) === NanoDeviceLibrary.uuid(item.uuid) && value.properties?.includes('read'));
          if (!available || !Number.isInteger(item.handle) || item.handle < 1 || item.handle > 65535) throw new Error('This characteristic is no longer available.');
          await lab.action('read', { handle: item.handle }); guard(); completed++;
        }
        guard();
        status.textContent = completed ? `Read ${completed} metadata values.` : 'This device exposes no standard readable identity or battery fields. Inspect its custom services.';
      } catch (error) { if (selected()) status.textContent = error.message; }
      finally { running = false; render(); }
    });
    inspect.addEventListener('click', () => { const device = metadata().device; if (device) NanoDevicePage.services(device); });
    lab.onState(render); document.addEventListener('nanoscope:busy', render); document.addEventListener('nanoscope:selection', () => { status.textContent = ''; render(); }); render();
    return { render };
  }
  return { mount, families };
})();
