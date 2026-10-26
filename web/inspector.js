'use strict';

function renderCharacteristic(characteristic, serviceUuid = '') {
  const section = node('div', 'characteristic');
  const top = node('div', 'characteristic-top');
  const title = node('div');
  title.append(node('p', 'characteristic-name', uuidName(characteristic.uuid, `Characteristic · ${characteristic.handle}`, serviceUuid)), node('span', 'uuid', characteristic.uuid));
  top.append(title);
  if (characteristic.properties.includes('read')) top.append(button('Read', 'secondary', () => mutate('read', { handle: characteristic.handle }), !canRead(state, characteristic, online, pending), `read-${characteristic.handle}`));
  const properties = node('div', 'properties');
  for (const property of characteristic.properties) properties.append(node('span', 'badge', property));
  section.append(top, properties);
  const definition = NanoMetadata.lookup(characteristic.uuid);
  if (definition?.description && !/^(?:0x)?1910$/i.test(serviceUuid)) section.append(node('p', 'hint', definition.description));
  if (characteristic.valueHex !== null && characteristic.valueHex !== undefined) {
    const value = node('div', 'value');
    value.append(node('p', 'value-label', 'Hex'), node('p', 'mono', characteristic.valueHex || '(empty value)'));
    if (characteristic.valueText) value.append(node('p', 'value-label', 'Text'), node('p', 'mono', characteristic.valueText));
    section.append(value);
    const decoded = NanoGattValues.decode(characteristic.uuid, characteristic.valueHex);
    if (decoded.length) { const fields = node('dl', 'metadata'); for (const field of decoded) fields.append(metadata(field.label, String(field.value))); section.append(fields); }
    else if (characteristic.valueHex) section.append(node('p', 'hint', 'No matching value decoder. Raw bytes remain available; supplemental definitions are in Settings > Device metadata.'));
  }
  if (characteristic.readError) section.append(node('p', 'error', characteristic.readError));
  section.append(NanoConsole.characteristicActions(characteristic));
  return section;
}
function renderInspector() {
  const device = selectedDevice();
  const connected = Boolean(device && state.ble.connected && state.ble.address === device.address);
  $('connection-badge').textContent = NanoConnection.describe(device).status;
  $('connection-badge').classList.toggle('connected', connected);
  const signature = JSON.stringify([device, connected ? state.services : [], state.ble, state.security, online, NanoConnection.snapshot().pending]);
  if (signature === detailSignature) return;
  detailSignature = signature;
  replacePreservingFocus($('inspector'), buildDeviceDetail(device));
}
function buildDeviceDetail(device, fullPage = false) {
  if (!device) return empty('Discover something nearby.', 'Select a device to view its advertisement. Connect to inspect services and read values.', 'inspector-empty');
  const live = device.streamLive === true || device.liveId != null || state.devices.some(item => deviceKey(item) === deviceKey(device));
  const connected = Boolean(state.ble.connected && state.ble.address === device.address);
  const detail = node('div', 'detail');
  const top = node('div', 'detail-top');
  const title = node('div');
  if (!fullPage) title.append(node('h3', '', device.label || device.name || 'Unnamed device'));
  title.append(node('p', '', device.address));
  top.append(title);
  const personal = node('div', 'device-personal');
  const label = node('input'); label.value = device.label || ''; label.placeholder = 'Add a local label'; label.maxLength = 80; label.dataset.focus = 'device-label'; label.setAttribute('aria-label', 'Local device label');
  label.addEventListener('input', () => scanStore.annotate(deviceKey(device), { label: label.value }));
  label.addEventListener('change', () => { detailSignature = ''; render(); });
  personal.append(label, button(device.favorite ? 'Unfavorite' : 'Favorite', 'secondary', () => { scanStore.annotate(deviceKey(device), { favorite: !device.favorite }); detailSignature = ''; render(); }, false, 'favorite'));
  const profile = NanoProfiles.identify(device);
  const data = node('dl', 'metadata');
  const vendor = vendorTools.identify(device, vendorDatabase);
  const addressType = metadata('Address type', vendorTools.addressLabel(device.address, device.addressType));
  data.append(metadata('Last signal', `${device.rssi} dBm`), addressType, metadata('Availability', !live ? 'Saved address' : device.connectable ? 'Connectable' : 'Broadcast only'), metadata('Last seen', device.lastSeenMs ? NanoInsights.age(device.lastSeenMs) : lastSeenLabel(device, state.uptime)));
  const recorder = NanoRecorders.identify(device);
  if (recorder) {
    data.append(metadata('Recorder', recorder.product));
  }
  const fallback = vendorStatus === 'loading' ? 'Loading vendor database…' : vendorStatus === 'failed' ? 'Vendor database unavailable' : 'No registered vendor found';
  const company = vendor.manufacturer || (vendor.companyId === null ? 'Not advertised' : `Company ID 0x${vendor.companyId.toString(16).padStart(4, '0').toUpperCase()}`);
  data.append(metadata('BLE manufacturer', company), metadata('Address vendor', vendor.addressNote || vendor.addressVendor || fallback));
  if (device.services?.length) data.append(metadata('Advertised services', device.services.join('\n'), true, true));
  detail.append(top, NanoConnection.controls(device, fullPage ? 'page-connect' : 'inspector-connect'), personal, data);
  if (profile.category !== 'other') {
    const evidence = node('details', 'raw-details'); evidence.dataset.persist = 'identification';
    evidence.append(node('summary', '', 'Identification details'), NanoInsights.profileCard(profile)); detail.append(evidence);
  }
  const actions = node('div', 'inspector-shortcuts');
  if (!fullPage) actions.append(button('Open device page', 'primary', () => NanoDevicePage.open(device), false, 'device-page'));
  if (connected) actions.append(button('Pair / security', 'secondary', () => NanoDevicePage.open(device, true), false, 'pair'));
  actions.append(button('Signal & metadata', 'secondary', () => NanoWorkspace.show('insights'), false, 'insights'));
  for (const id of NanoModules.matches(device)) {
    const app = NanoModules.catalog.find(item => item.id === id);
    actions.append(button(`Open ${app.title} app`, 'secondary', () => NanoWorkspace.openModule(id), false, `app-${id}`));
  }
  if (connected) actions.append(button('Open workbench', 'secondary', () => NanoWorkspace.show('workbench'), false, 'workbench'));
  detail.append(actions);
  const raw = node('details', 'raw-details'); raw.dataset.persist = 'advertisement'; raw.append(node('summary', '', 'Raw advertisement'), NanoConsole.advertisement(device, state, online)); detail.append(raw);
  if (fullPage) return detail;
  appendDeviceServices(detail, connected);
  return detail;
}
function appendDeviceServices(detail, connected) {
  const device = selectedDevice();
  detail.append(node('h3', 'section-label', connected ? `GATT services · ${state.services.length}` : 'GATT services'));
  if (connected) detail.append(node('p', 'hint', `Discovery scope: ${state.ble.discoveryScope || 'all services'}.`));
  if (connected && state.services.length) {
    for (const service of state.services) {
      const section = node('section', 'service');
      const heading = node('h4', 'service-title', uuidName(service.uuid, 'Custom service'));
      heading.append(node('span', 'uuid', service.uuid)); section.append(heading);
      const definition = NanoMetadata.lookup(service.uuid);
      if (definition?.description) section.append(node('p', 'hint', definition.description));
      else if (!definition && uuidName(service.uuid, '') === '') section.append(node('p', 'hint', 'Vendor-defined service. Access properties are discovered; command and packet meanings are not yet decoded.'));
      for (const characteristic of service.characteristics) section.append(renderCharacteristic(characteristic, service.uuid));
      if (!service.characteristics.length) section.append(node('p', 'hint', 'No characteristics found.'));
      detail.append(section);
    }
  } else {
    const message = connected ? (state.ble.busy ? 'Discovering services…' : 'No services were returned by this device.')
      : state.ble.connected ? 'Use Switch and connect to inspect this device.'
      : device?.connectable === false ? 'This device is broadcasting an advertisement and does not accept a connection.'
      : 'Connect to discover services and readable values. Protected values require device authentication.';
    detail.append(node('p', 'hint', message));
  }
  return detail;
}
