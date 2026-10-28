'use strict';

const identityUuids = ['2a00', '2a29', '2a24', '2a25', '2a26', '2a27', '2a28', '2a19', '2a01', '2a23', '2a50'];
function userDescription(characteristic) {
  const descriptor = (characteristic.descriptors || []).find(item => shortUuid(item.uuid) === '2901' && item.valueHex);
  return descriptor ? NanoGattValues.decode('2901', descriptor.valueHex)[0]?.value || '' : '';
}
function identityFields(services) {
  const values = new Map(services.flatMap(service => service.characteristics).filter(item => item.valueHex).map(item => [shortUuid(item.uuid), item.valueHex]));
  return identityUuids.flatMap(key => {
    const fields = values.has(key) && !(key === '2a01' && values.get(key) === '0000') ? NanoGattValues.decode(key, values.get(key)).filter(field => !field.placeholder) : [];
    // Without the hosted appearance catalog the name is bare hex, so fall back to the category name.
    if (key === '2a01' && fields.length) return [{ label: 'Appearance', value: /^0x[\dA-F]{4}$/.test(fields[0].value) ? `${fields[1].value} (${fields[0].value})` : fields[0].value }];
    const vendor = key === '2a50' && /Bluetooth SIG/.test(fields[0]?.value) ? vendorDatabase?.company?.[String(parseInt(fields[0].value.slice(2, 6), 16))] : '';
    return vendor ? [{ label: 'Vendor', value: `${vendor} (${fields[0].value.slice(0, 6)})` }, ...fields.slice(1)] : fields;
  });
}
function readableHandles(services) {
  return services.flatMap(service => service.characteristics.flatMap(item => [...(item.properties.includes('read') ? [item.handle] : []), ...(item.descriptors || []).map(descriptor => descriptor.handle)]));
}
async function readAllValues() {
  const device = selectedDevice(), handles = readableHandles(state.services);
  if (!NanoDeviceLibrary.connected(device, state) || pending || !online || state.ble.busy || !handles.length) return;
  pending = true; notice = ''; render();
  let failed = 0;
  try {
    for (const handle of handles) {
      if (!online || !NanoDeviceLibrary.connected(device, state)) break;
      try { await NanoLab.action('read', { handle }); } catch { failed++; }
    }
    if (failed) notice = `${failed} of ${handles.length} reads failed. See the returned errors for each value.`;
  } finally { pending = false; render(); }
}
function renderCharacteristic(characteristic, serviceUuid = '') {
  const section = node('div', 'characteristic');
  const top = node('div', 'characteristic-top');
  const title = node('div');
  const definition = NanoDeviceLibrary.lookup(characteristic.uuid, serviceUuid);
  title.append(node('p', 'characteristic-name', uuidName(characteristic.uuid, '', serviceUuid) || definition?.name || userDescription(characteristic) || `Characteristic · ${characteristic.handle}`), node('span', 'uuid', characteristic.uuid));
  top.append(title);
  const target = { address: state.ble.address, addressType: state.ble.addressType };
  if (characteristic.properties.includes('read')) top.append(button('Read', 'secondary', () => { if (NanoDeviceLibrary.connected(target, state)) mutate('read', { handle: characteristic.handle }); }, !canRead(state, characteristic, online, pending), `read-${characteristic.handle}`));
  const properties = node('div', 'properties');
  for (const property of characteristic.properties) properties.append(node('span', 'badge', property));
  section.append(top, properties);
  if (characteristic.valueHex !== null && characteristic.valueHex !== undefined) {
    const selected = selectedDevice(), device = NanoDeviceLibrary.connected(selected, state) ? selected : undefined;
    const decoded = NanoGattValues.decode(characteristic.uuid, characteristic.valueHex, { serviceUuid, device });
    const rawField = field => /(?:^Raw | HEX$|wire bytes)/i.test(field.label);
    const fields = node('dl', 'metadata');
    for (const field of decoded.filter(field => !rawField(field))) fields.append(metadata(field.label, String(field.value)));
    if (fields.children.length) section.append(fields);
    const value = node('details', 'raw-details value'); value.dataset.persist = `value-${target.address}/${target.addressType}-${characteristic.handle}`;
    value.append(node('summary', '', `Raw value · ${characteristic.valueHex.length / 2} bytes`));
    value.append(node('p', 'value-label', 'Hex'), node('p', 'mono', characteristic.valueHex || '(empty value)'));
    if (characteristic.valueText) value.append(node('p', 'value-label', 'Text'), node('p', 'mono', characteristic.valueText));
    for (const field of decoded.filter(rawField)) value.append(node('p', 'value-label', field.label), node('p', 'mono', String(field.value)));
    section.append(value);
  }
  if (characteristic.readError) section.append(node('p', 'error', characteristic.readError));
  section.append(NanoConsole.characteristicActions(characteristic));
  appendDefinition(section, definition, `characteristic-${characteristic.handle}`);
  return section;
}
function appendDefinition(section, definition, key) {
  if (!definition?.source && !definition?.description) return;
  const details = node('details', 'raw-details'); details.dataset.persist = `definition-${key}`;
  details.append(node('summary', '', 'Definition & source'));
  if (definition.description) details.append(node('p', 'vendor-note', definition.description));
  if (/^https:\/\//.test(definition.source || '')) {
    const link = node('a', 'vendor-note', 'Source'); link.href = definition.source; link.target = '_blank'; link.rel = 'noopener noreferrer'; details.append(link);
  }
  section.append(details);
}
function appendIdentity(detail) {
  const fields = identityFields(state.services);
  if (!fields.length) return;
  const summary = node('dl', 'metadata gatt-identity');
  for (const field of fields) summary.append(metadata(field.label, String(field.value)));
  detail.append(summary);
}
function suggestedActions(device) {
  const section = node('div', 'suggested-actions'), actions = NanoDeviceLibrary.suggestions(device, state);
  if (!actions.length) return section;
  section.append(node('h3', 'section-label', 'Available commands'));
  const primary = node('div', 'inspector-shortcuts'), more = node('details', 'raw-details');
  more.dataset.persist = `commands-${deviceKey(device)}`; more.append(node('summary', '', `More commands · ${Math.max(0, actions.length - 6)}`));
  for (const [index, action] of actions.entries()) {
    const control = button(action.label, 'secondary', () => {
      if (!NanoDeviceLibrary.connected(device, state)) return;
      const current = NanoDeviceLibrary.suggestions(device, state).find(item => item.handle === action.handle && item.uuid === action.uuid && item.action === action.action && item.mode === action.mode);
      if (current) mutate(action.action, { handle: action.handle, ...(action.mode ? { mode: action.mode } : {}) });
    }, pending || !online || state.ble.busy, `suggest-${action.action}-${action.handle}`);
    (index < 6 ? primary : more).append(control);
  }
  section.append(primary); if (actions.length > 6) section.append(more);
  return section;
}
function renderInspector() {
  const device = selectedDevice();
  const connected = NanoDeviceLibrary.connected(device, state);
  $('connection-badge').textContent = device ? NanoConnection.describe(device).status : '';
  $('connection-badge').classList.toggle('connected', connected);
  const signature = JSON.stringify([device, connected ? state.services : [], state.ble, state.security, online, NanoConnection.snapshot().pending]);
  if (signature === detailSignature) return;
  detailSignature = signature;
  replacePreservingFocus($('inspector'), buildDeviceDetail(device));
}
function buildDeviceDetail(device, fullPage = false) {
  if (!device) return empty('Choose a device from the list', '', 'inspector-empty');
  const live = device.streamLive === true || device.liveId != null || state.devices.some(item => deviceKey(item) === deviceKey(device));
  const connected = NanoDeviceLibrary.connected(device, state);
  const detail = node('div', 'detail');
  const top = node('div', 'detail-top');
  const title = node('div');
  const gattName = connected ? identityFields(state.services).find(field => field.label === 'Device name')?.value : '';
  if (!fullPage) title.append(node('h3', '', device.label || device.name || gattName || 'Unnamed device'));
  title.append(node('p', '', device.address));
  top.append(title);
  const personal = node('div', 'device-personal');
  const label = node('input'); label.value = device.label || ''; label.placeholder = 'Add a local label'; label.maxLength = 80; label.dataset.focus = 'device-label'; label.setAttribute('aria-label', 'Local device label');
  label.addEventListener('input', () => scanStore.annotate(deviceKey(device), { label: label.value }));
  label.addEventListener('change', () => { detailSignature = ''; render(); });
  personal.append(label, button(device.favorite ? 'Unfavorite' : 'Favorite', 'secondary', () => { scanStore.annotate(deviceKey(device), { favorite: !device.favorite }); detailSignature = ''; render(); }, false, 'favorite'));
  const profile = NanoProfiles.identify(device, state);
  const data = node('dl', 'metadata');
  const vendor = vendorTools.identify(device, vendorDatabase);
  const addressType = metadata('Address type', vendorTools.addressLabel(device.address, device.addressType));
  data.append(metadata('Last signal', `${device.rssi} dBm`), addressType, metadata('Availability', !live ? 'Saved address' : device.connectable ? 'Connectable' : 'Broadcast only'), metadata('Last seen', device.lastSeenMs ? NanoInsights.age(device.lastSeenMs) : lastSeenLabel(device, state.uptime)));
  const recorder = NanoRecorders.identify(device);
  if (recorder) {
    data.append(metadata('Recorder', recorder.product));
  }
  const fallback = vendorStatus === 'loading' ? 'Loading vendor database…' : vendorStatus === 'failed' ? 'Vendor database unavailable' : 'No registered vendor found';
  const company = vendor.manufacturer || (vendor.companyId === null ? '' : `Company ID 0x${vendor.companyId.toString(16).padStart(4, '0').toUpperCase()}`);
  if (company) data.append(metadata('BLE manufacturer', company));
  data.append(metadata('Address vendor', vendor.addressNote || vendor.addressVendor || fallback));
  if (device.services?.length) data.append(metadata('Advertised services', device.services.join('\n'), true, true));
  detail.append(top, NanoConnection.controls(device, fullPage ? 'page-connect' : 'inspector-connect'), personal);
  if (connected && fullPage) appendIdentity(detail);
  if (connected) detail.append(suggestedActions(device));
  const advertisement = node('details', 'raw-details'); advertisement.dataset.persist = `advertisement-${deviceKey(device)}`;
  advertisement.append(node('summary', '', 'Advertisement & identification'), data);
  if (profile.category !== 'other') {
    const evidence = node('details', 'raw-details'); evidence.dataset.persist = 'identification';
    evidence.append(node('summary', '', 'Identification details'), NanoInsights.profileCard(profile)); advertisement.append(evidence);
  }
  const protocols = NanoCatalogs.match(device, connected ? state.services || [] : []).filter(match => match.id !== profile.id && match.title !== profile.title && match.score >= 3);
  if (protocols.length) {
    const matches = node('details', 'raw-details library-matches'); matches.dataset.persist = 'library-matches';
    matches.append(node('summary', '', `Library matches · ${protocols.length}`));
    for (const match of protocols) matches.append(NanoInsights.profileCard(match));
    advertisement.append(matches);
  }
  const actions = node('div', 'inspector-shortcuts');
  if (!fullPage) actions.append(button('Open device page', 'primary', () => NanoDevicePage.open(device), false, 'device-page'));
  if (connected) actions.append(button('Pair / security', 'secondary', () => NanoDevicePage.open(device, true), false, 'pair'));
  actions.append(button('Signal & metadata', 'secondary', () => NanoWorkspace.show('insights'), false, 'insights'));
  for (const id of NanoModules.matches(device)) {
    const app = NanoModules.catalog.find(item => item.id === id);
    if (!app) continue;
    actions.append(button(`Open ${app.title} app`, 'secondary', () => NanoWorkspace.openModule(id), false, `app-${id}`));
  }
  if (connected) actions.append(button('Open workbench', 'secondary', () => NanoWorkspace.show('workbench'), false, 'workbench'));
  if (fullPage && connected) actions.append(button('Inspect services', 'secondary', () => NanoDevicePage.services(device), false, 'services'));
  detail.append(actions);
  if (!fullPage) appendDeviceServices(detail, connected);
  advertisement.append(NanoConsole.advertisement(device, state, online)); detail.append(advertisement);
  return detail;
}
function appendDeviceServices(detail, connected) {
  const device = selectedDevice();
  connected = connected && NanoDeviceLibrary.connected(device, state);
  const header = node('div', 'gatt-header');
  header.append(node('h3', 'section-label', connected ? `GATT services · ${state.services.length}` : 'GATT services'));
  if (connected && state.services.length) header.append(button('Read all values', 'secondary', readAllValues, pending || !online || state.ble.busy || !readableHandles(state.services).length, 'read-all'));
  detail.append(header);
  if (connected) detail.append(node('p', 'hint', `Discovery scope: ${state.ble.discoveryScope || 'all services'} · MTU ${state.ble.mtu || 23}.`));
  if (connected) appendIdentity(detail);
  if (connected && state.services.length) {
    for (const [index, service] of state.services.entries()) {
      const section = node('details', 'service'); section.open = true; section.dataset.collapse = `service-${deviceKey(device)}-${index}-${service.uuid}`;
      const heading = node('summary', 'service-title'), title = node('div'), count = service.characteristics.length;
      const definition = NanoDeviceLibrary.lookup(service.uuid);
      title.append(node('h4', '', definition?.name || uuidName(service.uuid, 'Custom service')), node('span', 'uuid', `${service.uuid} · ${count} ${count === 1 ? 'characteristic' : 'characteristics'}`));
      heading.append(title); section.append(heading);
      for (const characteristic of service.characteristics) section.append(renderCharacteristic(characteristic, service.uuid));
      appendDefinition(section, definition, `service-${index}-${service.uuid}`);
      if (!service.characteristics.length) section.append(node('p', 'hint', 'No characteristics found.'));
      detail.append(section);
    }
  } else {
    const message = connected ? (state.ble.busy ? 'Discovering services…' : 'No services were returned by this device.')
      : state.ble.connected ? 'Use Switch and connect to inspect this device.'
      : device?.connectable === false ? 'Broadcast only. This device does not accept connections.'
      : 'Connect to see services and values.';
    detail.append(node('p', 'hint', message));
  }
  return detail;
}
