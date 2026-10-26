'use strict';

const NanoModules = (() => {
  const recorders = typeof module !== 'undefined' ? require('./recorders.js') : NanoRecorders;
  const profiles = typeof module !== 'undefined' ? require('./profiles.js') : NanoProfiles;
  const library = typeof module !== 'undefined' ? require('./device-library.js') : NanoDeviceLibrary;
  const deviceApps = typeof module !== 'undefined' ? require('./device-apps.js') : NanoDeviceApps;
  const catalog = [
    { id: 'plaud', title: 'PLAUD', description: 'Authenticate your Note Pro and download recordings.', category: 'recorder' },
    { id: 'pocket', title: 'Pocket', description: 'Browse recorder storage and retrieve audio.', category: 'recorder' },
    { id: 'sleep', title: 'Sleep Number', description: 'Read supported Fuzion and MCR bed settings.', category: 'sleep' },
    { id: 'radiacode', title: 'RadiaCode', description: 'Read measurements and spectrum, refresh live, and reset accumulated dose.', category: 'sensor' },
    { id: 'thermometer', title: 'Thermometers', description: 'Read or capture standard temperature measurements.', category: 'sensor' },
    { id: 'locks', title: 'Locks', description: 'Inspect lock services, identity, and security requirements.', category: 'lock' },
    { id: 'resmed', title: 'ResMed CPAP', description: 'Inspect Air11 transport and exposed device metadata.', category: 'medical' },
    { id: 'ge', title: 'GE appliances', description: 'Inspect BLE metadata and GEA transport requirements.', category: 'appliance' },
    { id: 'samsung', title: 'Samsung devices', description: 'Recognize Samsung broadcasts and inspect available device metadata.', category: 'appliance' },
    { id: 'tracker', title: 'Trackers & beacons', description: 'Inspect Find My, Tile, iBeacon and Eddystone broadcasts.', category: 'tracker' },
    { id: 'medical', title: 'Dexcom G7', description: 'Authenticate G7 sensors and request readings, history, and identity.', category: 'medical' },
    { id: 'sensor', title: 'Environmental sensors', description: 'Decode BTHome and Ruuvi broadcast measurements.', category: 'sensor' },
    ...deviceApps.entries.map(({ id, title, description, category }) => ({ id, title, description, category }))
  ];
  function matches(device) {
    if (!device) return [];
    const recorder = recorders.identify(device), profile = profiles.identify(device);
    if (recorder) return [recorder.product.includes('PLAUD') ? 'plaud' : 'pocket'];
    const found = library.match(device, typeof NanoLab === 'undefined' ? {} : NanoLab.getState());
    const mapping = { 'sleep-fuzion': 'sleep', 'sleep-mcr': 'sleep', radiacode: 'radiacode', 'health-thermometer': 'thermometer', 'environmental-sensor': 'thermometer', 'nuki-lock': 'locks', 'resmed-air11': 'resmed', 'ge-appliance': 'ge', 'samsung-tv': 'samsung', 'samsung-device': 'samsung' };
    const ids = [...deviceApps.matches(device), ...found.map(item => mapping[item.id]).filter(Boolean)];
    if (/^(?:Schlage|Yale|August|Nuki)\b/i.test(device.name || '')) ids.push('locks');
    if (!ids.length) ids.push(...(profile.category === 'beacon' ? ['tracker'] : ['tracker', 'medical', 'sleep', 'sensor'].includes(profile.category) ? [profile.category] : []));
    return [...new Set(ids)];
  }
  let hooks, signature = '', connectionSignature = '', appQuery = '', appScope = 'all';
  const readers = new Map();
  const localTargets = new Map();
  function appDevice(id) {
    const key = localTargets.get(id), selected = hooks.selected();
    return hooks.devices().find(device => `${device.address}/${device.addressType}` === key) || (deviceApps.matches(selected).includes(id) ? selected : null);
  }
  function selectAppDevice(id, device) {
    if (deviceApps.get(id)) localTargets.set(id, `${device.address}/${device.addressType}`);
    else hooks.select(device);
  }
  function mount(options) {
    hooks = options;
    for (const id of ['tracker', 'medical', 'sensor', 'thermometer', 'locks', 'resmed', 'ge', 'samsung', ...deviceApps.entries.map(app => app.id)]) {
      const panel = document.createElement('section'); panel.id = `${id}-panel`; panel.className = 'panel metadata-module'; panel.hidden = true;
      panel.setAttribute('aria-label', catalog.find(item => item.id === id).title);
      document.getElementById('module-content').append(panel);
      if (id === 'medical') NanoDexcom.mount(panel, NanoLab, { getDevice: hooks.selected });
      if (Object.hasOwn(NanoDeviceSupport.families, id)) NanoDeviceSupport.mount(panel, id, NanoLab);
      if (deviceApps.get(id)) readers.set(id, NanoProtocolApp.mount(panel, id, { selected: () => appDevice(id) }));
    }
  }
  function render(device, devices) {
    const active = NanoWorkspace.module(), match = matches(device);
    document.getElementById('module-connection').hidden = active === 'medical' || Boolean(deviceApps.get(active));
    if (readers.has(active)) {
      const target = appDevice(active); readers.get(active).render(target, NanoLab.getState());
      document.getElementById('recorder-context').textContent = target ? `Inspecting ${target.label || target.name || target.address}` : 'Choose an observed device from the app catalog.';
    }
    const connection = NanoConnection.describe(device), connectionKey = JSON.stringify([device?.address, connection.status, connection.reason, connection.enabled, connection.label]);
    if (connectionKey !== connectionSignature) {
      connectionSignature = connectionKey;
      replacePreservingFocus(document.getElementById('module-connection'), NanoConnection.controls(device, 'module-connect'));
    }
    const next = JSON.stringify([appQuery, appScope, device && [device.address, device.addressType, device.name, device.label, match], devices.map(item => [item.address, item.addressType, item.name, item.label, matches(item), item.liveId != null || item.streamLive === true])]);
    if (next !== signature) {
    signature = next;
    const root = document.getElementById('apps-catalog'), intro = document.createElement('p'); intro.className = 'hint';
    intro.textContent = device ? `Selected: ${device.label || device.name || device.address}. ${match.length ? 'Matching apps appear first.' : 'No specialized app matches this advertisement.'}` : 'Select a device to see matching apps, or choose an observed device below.';
    const filters = document.createElement('div'); filters.className = 'app-catalog-filters';
    const searchLabel = document.createElement('label'); searchLabel.textContent = 'Find an app';
    const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Name, device, or capability'; search.value = appQuery; search.dataset.focus = 'app-search'; searchLabel.append(search);
    const scopeLabel = document.createElement('label'); scopeLabel.textContent = 'Show';
    const scope = document.createElement('select'); scope.dataset.focus = 'app-scope';
    for (const [value, text] of [['all', 'All apps'], ['observed', 'Observed devices']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; scope.append(option); }
    scope.value = appScope; scopeLabel.append(scope); filters.append(searchLabel, scopeLabel);
    search.addEventListener('input', () => { appQuery = search.value; render(hooks.selected(), hooks.devices()); });
    scope.addEventListener('change', () => { appScope = scope.value; render(hooks.selected(), hooks.devices()); });
    const grid = document.createElement('div'); grid.className = 'apps-grid';
    const observed = new Set(devices.flatMap(matches));
    const visible = catalog.filter(app => (appScope !== 'observed' || observed.has(app.id)) && `${app.title} ${app.description} ${app.category}`.toLowerCase().includes(appQuery.trim().toLowerCase()));
    for (const app of [...visible].sort((a, b) => Number(match.includes(b.id)) - Number(match.includes(a.id)) || Number(observed.has(b.id)) - Number(observed.has(a.id)))) {
      const card = document.createElement('article'); card.className = `app-card${match.includes(app.id) ? ' matched' : ''}`;
      const heading = document.createElement('h3'); heading.textContent = app.title;
      const description = document.createElement('p'); description.textContent = app.description;
      const found = devices.filter(item => matches(item).includes(app.id)), status = document.createElement('span'); status.className = 'badge'; status.textContent = match.includes(app.id) ? 'Matches selected device' : `${found.length} observed`;
      const open = document.createElement('button'); open.className = 'button secondary'; open.type = 'button'; open.textContent = `Open ${app.title}`;
      open.addEventListener('click', () => { if (!match.includes(app.id) && found.length === 1) selectAppDevice(app.id, found[0]); NanoWorkspace.openModule(app.id); render(hooks.selected(), hooks.devices()); });
      card.append(status, heading, description, open);
      if (found.length) {
        const label = document.createElement('label'); label.textContent = 'Observed devices';
        const select = document.createElement('select'); select.setAttribute('aria-label', `${app.title} device`); select.dataset.focus = `app-device-${app.id}`;
        const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose a device'; select.append(placeholder);
        for (const item of found) { const option = document.createElement('option'); option.value = `${item.address}/${item.addressType}`; option.textContent = `${item.label || item.name || item.address}${item.liveId == null && !item.streamLive ? ' · history' : ''}`; select.append(option); }
        select.addEventListener('change', () => { const item = found.find(value => `${value.address}/${value.addressType}` === select.value); if (item) { selectAppDevice(app.id, item); NanoWorkspace.openModule(app.id); render(hooks.selected(), hooks.devices()); } });
        label.append(select); card.append(label);
      }
      grid.append(card);
    }
    const fragment = document.createDocumentFragment(); fragment.append(intro, filters, grid);
    if (!visible.length) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = 'No apps match these filters. Try another search or show all apps.'; fragment.append(empty); }
    replacePreservingFocus(root, fragment);
    }
    for (const id of ['tracker', 'sensor']) {
      const panel = document.getElementById(`${id}-panel`); if (active !== id) continue;
      const heading = document.createElement('h2'); heading.textContent = catalog.find(item => item.id === id).title;
      const content = [heading];
      if (device && match.includes(id)) {
        const name = document.createElement('p'); name.className = 'hint'; name.textContent = `${device.label || device.name || device.address} · ${device.address}`;
        content.push(name, NanoInsights.profileCard(profiles.identify(device)), NanoInsights.signalChart(device));
      } else { const hint = document.createElement('p'); hint.textContent = 'Choose a matching device from Apps or Discover.'; content.push(hint); }
      panel.replaceChildren(...content);
    }
  }
  return { catalog, matches, mount, render };
})();
if (typeof module !== 'undefined') module.exports = NanoModules;
