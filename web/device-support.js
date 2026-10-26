'use strict';

const NanoDeviceSupport = (() => {
  const families = { thermometer: ['health-thermometer', 'environmental-sensor'], locks: ['nuki-lock'], resmed: ['resmed-air11'], ge: ['ge-appliance'], samsung: ['samsung-device', 'samsung-tv'] };
  function mount(container, kind, lab) {
    container.classList.add('support-panel');
    const el = (tag, cls, text) => { const value = document.createElement(tag); if (cls) value.className = cls; if (text !== undefined) value.textContent = text; return value; };
    const body = el('div', 'support-module'), summary = el('div'), controls = el('div', 'inspector-shortcuts'), results = el('dl', 'metadata'), recipes = el('div', 'inspector-shortcuts');
    const status = el('p', 'vendor-note'); status.setAttribute('role', 'status');
    const read = el('button', 'button secondary', 'Read device metadata'), inspect = el('button', 'button secondary', 'Inspect services'); read.type = inspect.type = 'button'; controls.append(read, inspect);
    const details = el('details'), title = el('summary', '', 'Protocol support & sources'); details.append(title);
    body.append(summary, controls, status, results, recipes, details); container.append(body);
    let running = false, signature = '';
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
      const context = NanoConnection.snapshot(), device = context.selected;
      const connected = device && context.state.ble?.connected && context.state.ble.address === device.address;
      return { ...context, device, connected, characteristics: connected ? (context.state.services || []).flatMap(service => service.characteristics || []) : [] };
    };
    function render() {
      const context = metadata(), matches = context.device ? NanoDeviceLibrary.match(context.device, context.state).filter(item => families[kind].includes(item.id)) : [];
      const next = JSON.stringify([context.device?.address, context.connected, context.characteristics, context.online, context.pending, running]);
      if (next === signature) return; signature = next;
      summary.replaceChildren(el('h3', '', kind === 'locks' ? 'Lock metadata' : kind === 'samsung' ? 'Samsung device metadata' : entries.map(item => item.title).join(' / ')), el('p', 'vendor-note', matches.length ? matches.map(item => `${item.confidence}: ${item.evidence}`).join(' ') : context.device ? 'No documented service signature matched this device. Inspect its services to collect evidence.' : 'Select a device from Discover.'));
      read.disabled = !context.online || !context.device || context.device.connectable === false || context.pending || running;
      inspect.disabled = !context.device;
      results.replaceChildren();
      for (const characteristic of context.characteristics) {
        const fields = NanoGattValues.decode(characteristic.uuid, characteristic.valueHex || '');
        for (const field of fields) { const row = el('div'); row.append(el('dt', '', field.label), el('dd', '', field.value)); results.append(row); }
      }
    }
    read.addEventListener('click', async () => {
      const device = metadata().device; if (!device || running) return;
      running = true; render(); status.textContent = 'Connecting and reading available metadata…';
      try {
        const state = await NanoConnection.ensure(device), identity = new Set(['2a00', '2a19', '2a24', '2a25', '2a26', '2a27', '2a28', '2a29']);
        const readable = (state.services || []).flatMap(service => service.characteristics || []).filter(item => identity.has(NanoDeviceLibrary.uuid(item.uuid)) && item.properties.includes('read'));
        let completed = 0;
        for (const item of readable) {
          if (metadata().device?.address !== device.address || !metadata().connected) throw new Error('The selected connection changed.');
          await lab.action('read', { handle: item.handle }); completed++;
        }
        status.textContent = completed ? `Read ${completed} metadata values.` : 'This device exposes no standard readable identity or battery fields. Inspect its custom services.';
      } catch (error) { status.textContent = error.message; }
      finally { running = false; render(); }
    });
    inspect.addEventListener('click', () => { const device = metadata().device; if (device) NanoDevicePage.services(device); });
    lab.onState(render); document.addEventListener('nanoscope:selection', () => { status.textContent = ''; render(); }); render();
  }
  return { mount, families };
})();
