'use strict';

const NanoDevicePage = (() => {
  let signature = '', headerSignature = '', lastDevice = '';
  function showTab(value, focus = false) {
    for (const key of ['overview', 'services', 'security']) {
      const button = $(`device-tab-${key}`), active = key === value;
      button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
      $(`device-pane-${key}`).hidden = !active;
      if (active && focus) button.focus();
    }
  }
  function mount() {
    $('device-content').innerHTML = '<div class="view-heading"><h1 id="device-page-title">Device</h1><div class="subnav" role="tablist" aria-label="Device tools"><button id="device-tab-overview" role="tab" aria-controls="device-pane-overview" aria-selected="true">Overview</button><button id="device-tab-services" role="tab" aria-controls="device-pane-services" aria-selected="false" tabindex="-1">Services</button><button id="device-tab-security" role="tab" aria-controls="device-pane-security" aria-selected="false" tabindex="-1">Security</button></div></div><section id="device-pane-overview" role="tabpanel" aria-labelledby="device-tab-overview" class="panel device-focused"><div id="device-summary"></div><details class="device-signal"><summary>Signal history</summary><div id="device-signal"></div></details></section><section id="device-pane-services" role="tabpanel" aria-labelledby="device-tab-services" hidden><div id="device-services" class="panel detail device-focused"></div></section><section id="device-pane-security" role="tabpanel" aria-labelledby="device-tab-security" hidden><div id="pairing-panel" class="panel device-focused"></div></section>';
    const keys = ['overview', 'services', 'security'];
    keys.forEach((key, index) => {
      $(`device-tab-${key}`).addEventListener('click', () => showTab(key));
      $(`device-tab-${key}`).addEventListener('keydown', event => {
        const next = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : -1;
        if (next >= 0) { event.preventDefault(); showTab(keys[next], true); }
      });
    });
    NanoPairing.mount($('pairing-panel'), { selected: selectedDevice, changed: poll });
  }
  function open(device, pairing = false) {
    if (device) selectDevice(device);
    NanoWorkspace.show('device'); render(); showTab(pairing ? 'security' : 'overview');
  }
  function render() {
    const device = selectedDevice(), connected = Boolean(device && state.ble.connected && device.address === state.ble.address);
    NanoPairing.update(state, online, device); renderHeader();
    if (NanoWorkspace.view() !== 'device') return;
    if (lastDevice !== selected) { lastDevice = selected; showTab('overview'); }
    const next = JSON.stringify([device, connected, state.services, state.ble, online, NanoConnection.snapshot().pending, NanoMetadata.status()]);
    if (next === signature) return; signature = next;
    $('device-page-title').textContent = device?.label || device?.name || 'Device';
    replacePreservingFocus($('device-summary'), buildDeviceDetail(device, true));
    const services = node('div');
    if (device) {
      if (!connected) services.append(NanoConnection.controls(device, 'services-connect'));
      appendDeviceServices(services, connected);
    } else services.append(node('p', 'hint', 'Select a device in Discover.'));
    replacePreservingFocus($('device-services'), services);
    $('device-signal').replaceChildren(...(device ? [NanoInsights.signalChart(device)] : []));
  }
  function renderHeader() {
    const device = NanoConnection.pendingDevice() || NanoConnection.connectedDevice() || selectedDevice(), status = NanoConnection.describe(device);
    const next = JSON.stringify([device?.address, device?.name, device?.label, status.status, status.reason, status.enabled, status.label, state.security?.status]);
    if (next === headerSignature) return; headerSignature = next;
    const menu = node('details', 'header-connection'); menu.open = Boolean($('header-device').querySelector('details')?.open);
    const summary = node('summary'); summary.append(node('span', 'header-device-name', device?.label || device?.name || device?.address || 'No active device'));
    if (device) summary.append(node('span', 'header-device-state', status.status));
    const actions = node('div', 'header-device-menu');
    if (device) {
      actions.append(node('p', 'mono', device.address), NanoConnection.controls(device, 'header-connect'), button('View device', 'secondary', () => { menu.open = false; open(device); }, false, 'header-view'));
      if (status.connected) actions.append(button(state.security?.active ? 'Pairing needs attention' : 'Pair / security', 'secondary', () => { menu.open = false; open(device, true); }, !online, 'header-pair'));
      for (const id of NanoModules.matches(device)) actions.append(button(`Open ${NanoModules.catalog.find(app => app.id === id).title}`, 'secondary', () => { selectDevice(device); menu.open = false; NanoWorkspace.openModule(id); }, false, `header-app-${id}`));
    } else actions.append(button('Discover devices', 'secondary', () => { menu.open = false; NanoWorkspace.show('discover'); }, false, 'header-discover'));
    menu.append(summary, actions); replacePreservingFocus($('header-device'), menu);
  }
  return { mount, render, open, services(device) { open(device); showTab('services'); } };
})();
