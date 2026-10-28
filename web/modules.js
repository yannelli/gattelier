'use strict';

const NanoModules = (() => {
  const recorders = typeof module !== 'undefined' ? require('./recorders.js') : NanoRecorders;
  const schlage = typeof module !== 'undefined' ? require('./schlage-protocol.js') : NanoSchlage;
  const standard = typeof module !== 'undefined' ? require('./standard-app.js') : NanoStandardApp;
  const library = typeof module !== 'undefined' ? require('./device-library.js') : NanoDeviceLibrary;
  const deviceApps = typeof module !== 'undefined' ? require('./device-apps.js') : NanoDeviceApps;
  const displayName = device => typeof deviceDisplayName === 'function' ? deviceDisplayName(device) : [device.label, device.name, device.gattName].find(value => typeof value === 'string' && value.trim())?.trim() || device.address;
  const catalog = [
    { id: 'plaud', title: 'PLAUD', description: 'Authenticate your Note Pro and download recordings.', category: 'recorder' },
    { id: 'pocket', title: 'Pocket', description: 'Browse recorder storage and retrieve audio.', category: 'recorder' },
    { id: 'sleep', title: 'Sleep Number', description: 'Read supported Fuzion and MCR bed settings.', category: 'sleep' },
    { id: 'radiacode', title: 'RadiaCode', description: 'Read measurements and spectrum, refresh live, and reset accumulated dose.', category: 'sensor' },
    { id: 'thermometer', title: 'Thermometers', description: 'Read or capture standard temperature measurements.', category: 'sensor' },
    { id: 'schlage', title: 'Schlage', description: 'Lock inventory, device identity, and uWeave capture inspection.', category: 'lock' },
    { id: 'standard', title: 'Standard BLE', description: 'Heart rate, cycling, temperature, weight, oxygen, and battery readings.', category: 'sensor' },
    { id: 'locks', title: 'Locks', description: 'Inspect lock services, identity, and security requirements.', category: 'lock' },
    { id: 'ge', title: 'GE appliances', description: 'Inspect BLE metadata and GEA transport requirements.', category: 'appliance' },
    { id: 'medical', title: 'Dexcom G7', description: 'Authenticate G7 sensors and request readings, history, and identity.', category: 'medical' },
    ...deviceApps.entries.map(({ id, title, description, category }) => ({ id, title, description, category }))
  ];
  function matches(device, state = typeof NanoLab === 'undefined' ? {} : NanoLab.getState()) {
    if (!device) return [];
    const recorder = recorders.identify(device);
    if (recorder) return [recorder.product.includes('PLAUD') ? 'plaud' : 'pocket'];
    const found = library.match(device, state);
    const mapping = { 'sleep-fuzion': 'sleep', 'sleep-mcr': 'sleep', radiacode: 'radiacode', 'health-thermometer': 'thermometer', 'environmental-sensor': 'thermometer', 'nuki-lock': 'locks', 'resmed-air11': 'resmed', 'ge-appliance': 'ge', 'samsung-tv': 'samsung', 'samsung-device': 'samsung' };
    const ids = [...deviceApps.matches(device), ...found.map(item => mapping[item.id]).filter(Boolean)];
    if (schlage.identify(device, state)) ids.push('schlage');
    if (standard.matches(device, state).length) ids.push('standard');
    const services = [...(device.services || []), ...(library.connected(device, state) ? (state.services || []).map(item => item.uuid) : [])].map(library.uuid);
    if (services.some(id => ['febc', 'f8083532-849e-531c-c594-30f1f86a4ea5'].includes(id)) || /^(?:DXCM|DX02|Dexcom)[\da-z]{2}$/i.test(device.name || '')) ids.push('medical');
    return [...new Set(ids)];
  }
  let hooks, signature = '', connectionSignature = '', appQuery = '', appScope = 'all';
  const readers = new Map();
  const localTargets = new Map();
  function appDevice(id) {
    const saved = localTargets.get(id), selected = hooks.selected();
    const target = saved ? hooks.devices().find(device => device.address.toLowerCase() === saved.address.toLowerCase() && device.addressType === saved.addressType && matches(device).includes(id)) || saved : matches(selected).includes(id) ? selected : null;
    if (target && !saved) localTargets.set(id, target);
    return target;
  }
  function selectAppDevice(id, device, restored = false) {
    if (!rememberTarget(id, device, restored)) return false;
    if (!deviceApps.get(id)) hooks.select(device, restored);
    NanoWorkspace.retarget?.(id, device);
    return true;
  }
  function rememberTarget(id, device, restored = false) {
    if (!catalog.some(app => app.id === id) || typeof device?.address !== 'string' || !/^(?:[\da-f]{2}:){5}[\da-f]{2}$/i.test(device.address) || !Number.isInteger(device.addressType) || device.addressType < 0 || device.addressType > 3) return false;
    if (restored !== true && !matches(device).includes(id)) return false;
    localTargets.set(id, device); return true;
  }
  function mount(options) {
    hooks = options;
    for (const id of ['schlage', 'standard', 'medical', 'thermometer', 'locks', 'ge', ...deviceApps.entries.map(app => app.id)]) {
      const panel = document.createElement('section'); panel.id = `${id}-panel`; panel.className = 'panel metadata-module'; panel.hidden = true;
      panel.setAttribute('aria-label', catalog.find(item => item.id === id).title);
      document.getElementById('module-content').append(panel);
      if (id === 'schlage') readers.set(id, NanoSchlageApp.mount(panel, NanoLab, { selected: () => appDevice(id) }));
      if (id === 'standard') readers.set(id, NanoStandardApp.mount(panel, NanoLab, { selected: () => appDevice(id) }));
      if (id === 'medical') NanoDexcom.mount(panel, NanoLab, { getDevice: () => appDevice('medical') });
      if (Object.hasOwn(NanoDeviceSupport.families, id) && !deviceApps.get(id)) readers.set(id, NanoDeviceSupport.mount(panel, id, NanoLab, { selected: () => appDevice(id) }));
      if (deviceApps.get(id)) readers.set(id, id === 'tracker' ? NanoBeaconApp.mount(panel, { selected: () => appDevice(id) }) : id === 'sensor' ? NanoSensorApp.mount(panel, { selected: () => appDevice(id) }) : NanoProtocolApp.mount(panel, id, { selected: () => appDevice(id) }));
      if (deviceApps.get(id) && Object.hasOwn(NanoDeviceSupport.families, id)) {
        const details = document.createElement('details'), summary = document.createElement('summary'); details.className = 'protocol-details'; summary.textContent = 'GATT metadata tools'; details.append(summary);
        panel.querySelector('.protocol-body').append(details);
        const broadcast = readers.get(id), gatt = NanoDeviceSupport.mount(details, id, NanoLab, { selected: () => appDevice(id) });
        readers.set(id, { render(device, state) { broadcast.render(device, state); gatt.render(); } });
      }
    }
  }
  let pickerSignature = '';
  function renderPicker(id, devices) {
    let root = document.getElementById('module-device-picker');
    if (!root) {
      root = document.createElement('label'); root.id = 'module-device-picker'; root.className = 'module-device-picker';
      document.getElementById('module-connection').before(root);
    }
    root.hidden = !id;
    if (!id) return;
    const target = appDevice(id), found = devices.filter(device => matches(device).includes(id));
    const savedTarget = target && !found.some(item => item.address.toLowerCase() === target.address.toLowerCase() && item.addressType === target.addressType) ? target : null;
    const choices = savedTarget ? [...found, savedTarget] : found;
    const next = JSON.stringify([id, target?.address, target?.addressType, Boolean(savedTarget), choices.map(item => [item.address, item.addressType, item.name, item.label, item.gattName, item.streamLive, item.liveId]), NanoLab.isActing(), NanoLab.getState().ble?.busy]);
    if (next === pickerSignature) return; pickerSignature = next;
    const select = document.createElement('select'); select.dataset.focus = 'module-device-select'; select.setAttribute('aria-label', 'App device');
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = found.length ? 'Choose a matched device' : 'No matched devices in this scan'; select.append(empty);
    for (const item of choices) {
      const option = document.createElement('option'); option.value = `${item.address}/${item.addressType}`;
      option.textContent = `${displayName(item)} · ${item.address}${item !== savedTarget && (item.streamLive || item.liveId != null) ? '' : ' · saved'}`; select.append(option);
    }
    select.value = target ? `${target.address}/${target.addressType}` : '';
    select.disabled = NanoLab.isActing() || NanoLab.getState().ble?.busy || !choices.length;
    select.addEventListener('change', () => { const item = choices.find(value => `${value.address}/${value.addressType}` === select.value); if (item) selectAppDevice(id, item, item === savedTarget); render(hooks.selected(), hooks.devices()); });
    const fragment = document.createDocumentFragment(); fragment.append(document.createTextNode('Device'), select); replacePreservingFocus(root, fragment);
  }
  function render(device, devices) {
    const active = NanoWorkspace.module(), match = matches(device);
    renderPicker(active, devices);
    document.getElementById('module-connection').hidden = active === 'medical' || Boolean(deviceApps.get(active));
    if (readers.has(active)) {
      const target = appDevice(active); readers.get(active).render(target, NanoLab.getState());
      document.getElementById('recorder-context').textContent = target ? displayName(target) : '';
    }
    const target = active ? appDevice(active) : device;
    const connection = NanoConnection.describe(target), connectionKey = JSON.stringify([target?.address, target?.addressType, connection.status, connection.reason, connection.enabled, connection.label, connection.details]);
    if (connectionKey !== connectionSignature) {
      connectionSignature = connectionKey;
      replacePreservingFocus(document.getElementById('module-connection'), NanoConnection.controls(target, 'module-connect'));
    }
    const next = JSON.stringify([appQuery, appScope, device && [device.address, device.addressType, device.name, device.label, device.gattName, match], devices.map(item => [item.address, item.addressType, item.name, item.label, item.gattName, matches(item), item.liveId != null || item.streamLive === true])]);
    if (next !== signature) {
    signature = next;
    const root = document.getElementById('apps-catalog'), intro = document.createElement('p'); intro.className = 'hint';
    intro.textContent = device && match.length ? `Apps for ${displayName(device)} are shown first.` : '';
    const filters = document.createElement('div'); filters.className = 'app-catalog-filters';
    const searchLabel = document.createElement('label');
    const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search apps'; search.setAttribute('aria-label', 'Search apps'); search.value = appQuery; search.dataset.focus = 'app-search'; searchLabel.append(search);
    const scopeLabel = document.createElement('label');
    const scope = document.createElement('select'); scope.dataset.focus = 'app-scope'; scope.setAttribute('aria-label', 'Show');
    for (const [value, text] of [['all', 'All apps'], ['observed', 'Nearby only']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; scope.append(option); }
    scope.value = appScope; scopeLabel.append(scope); filters.append(searchLabel, scopeLabel);
    search.addEventListener('input', () => { appQuery = search.value; render(hooks.selected(), hooks.devices()); });
    scope.addEventListener('change', () => { appScope = scope.value; render(hooks.selected(), hooks.devices()); });
    const grid = document.createElement('div'); grid.className = 'apps-grid';
    const nearby = devices.filter(item => item.streamLive === true || item.liveId != null);
    const observed = new Set(nearby.flatMap(item => matches(item)));
    const visible = catalog.filter(app => (appScope !== 'observed' || observed.has(app.id)) && `${app.title} ${app.description} ${app.category}`.toLowerCase().includes(appQuery.trim().toLowerCase()));
    for (const app of [...visible].sort((a, b) => Number(match.includes(b.id)) - Number(match.includes(a.id)) || Number(observed.has(b.id)) - Number(observed.has(a.id)))) {
      const card = document.createElement('article'); card.className = `app-card${match.includes(app.id) ? ' matched' : ''}`;
      const heading = document.createElement('h3'); heading.textContent = app.title;
      const description = document.createElement('p'); description.textContent = app.description;
      const found = (appScope === 'observed' ? nearby : devices).filter(item => matches(item).includes(app.id)), nearbyCount = nearby.filter(item => matches(item).includes(app.id)).length, status = document.createElement('span'); status.className = 'badge'; status.textContent = match.includes(app.id) ? 'Matches selection' : nearbyCount ? `${nearbyCount} nearby` : found.length ? `${found.length} saved` : '';
      const open = document.createElement('button'); open.className = 'app-card-open'; open.dataset.focus = `app-card-open-${app.id}`; open.type = 'button'; open.setAttribute('aria-label', `Open ${app.title}`);
      open.addEventListener('click', () => { if (!match.includes(app.id) && found.length === 1) selectAppDevice(app.id, found[0]); NanoWorkspace.openModule(app.id); render(hooks.selected(), hooks.devices()); });
      open.append(heading, description, ...status.textContent ? [status] : []); card.append(open);
      if (found.length > 1) {
        const label = document.createElement('label');
        const select = document.createElement('select'); select.setAttribute('aria-label', `${app.title} device`); select.dataset.focus = `app-device-${app.id}`;
        const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose a device'; select.append(placeholder);
        for (const item of found) { const option = document.createElement('option'); option.value = `${item.address}/${item.addressType}`; option.textContent = `${displayName(item)}${item.liveId == null && !item.streamLive ? ' · history' : ''}`; select.append(option); }
        select.addEventListener('change', () => { const item = found.find(value => `${value.address}/${value.addressType}` === select.value); if (item) { selectAppDevice(app.id, item); NanoWorkspace.openModule(app.id); render(hooks.selected(), hooks.devices()); } });
        label.append(select); card.append(label);
      }
      grid.append(card);
    }
    const fragment = document.createDocumentFragment(); fragment.append(...intro.textContent ? [intro] : [], filters, grid);
    if (!visible.length) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = 'No matching apps'; fragment.append(empty); }
    replacePreservingFocus(root, fragment);
    }

  }
  return { catalog, matches, mount, render, appDevice, selectAppDevice, rememberTarget };
})();
if (typeof module !== 'undefined') module.exports = NanoModules;
