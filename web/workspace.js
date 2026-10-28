'use strict';

const NanoWorkspace = (() => {
  const views = ['discover', 'apps', 'workbench', 'insights', 'settings', 'device'];
  const modules = { plaud: 'PLAUD', pocket: 'Pocket', sleep: 'Sleep Number', tracker: 'Trackers & beacons', bose: 'Bose audio', medical: 'Dexcom G7', sensor: 'Environmental sensors', radiacode: 'RadiaCode', thermometer: 'Thermometers', locks: 'Locks', schlage: 'Schlage', standard: 'Standard BLE', resmed: 'ResMed Air11', ge: 'GE appliances', samsung: 'Samsung devices', apple: 'Apple & AirPods', nespresso: 'Nespresso', vesync: 'Levoit air purifiers', lg: 'LG webOS' };
  const layoutKey = 'nanoscope.workspace.layout.v1';
  let active = 'discover', activeModule = '', tool = 'command', initialized = false, restoring = false;
  let preferences = {}, sessionTabs, tabView, alerts, lastUpdate = {}, lastDevice;
  let layout = { pane: 'auto', density: 'comfortable' }, drawer = false, paneOpen = false;
  const get = id => document.getElementById(id);
  const mobile = () => Boolean(globalThis.matchMedia?.('(max-width: 699px)').matches);
  const selected = () => preferences.getSelected?.() || lastDevice;
  function display(device) {
    if (!device) return device;
    const info = preferences.getDeviceDisplay?.(device) || {};
    const discovered = typeof NanoWorkspaceTabs !== 'undefined' && NanoWorkspaceTabs.connected(device, lastUpdate.state) ? (lastUpdate.state?.services || []).map(item => item.uuid) : [];
    return { ...device, services: [...new Set([...(device.services || []), ...discovered])], label: info.name || preferences.getDeviceLabel?.(device) || device.label,
      manufacturerName: info.manufacturer || device.manufacturerName || '', glyph: info.glyph || device.glyph || '' };
  }
  function connectionLabel(device) { const item = display(device); return item?.label || item?.name || item?.address || 'Device'; }
  function tabs(selector, value, attribute) {
    for (const button of document.querySelectorAll(selector)) {
      const current = button.dataset[attribute] === value;
      button.setAttribute('aria-selected', String(current)); button.tabIndex = current ? 0 : -1;
      if (attribute !== 'view') { const panel = get(button.getAttribute('aria-controls')); if (panel) panel.hidden = !current; }
    }
  }
  function saveLayout() { try { globalThis.localStorage?.setItem(layoutKey, JSON.stringify(layout)); } catch {} }
  function renderPane() {
    const pane = get('workspace-pane'), narrow = mobile();
    paneOpen = narrow ? drawer : layout.pane === 'pinned' || layout.pane === 'open' || layout.pane === 'auto' && active === 'discover';
    if (pane) {
      pane.hidden = !paneOpen; pane.setAttribute('role', narrow ? 'dialog' : 'complementary');
      if (narrow && paneOpen) pane.setAttribute('aria-modal', 'true'); else pane.removeAttribute?.('aria-modal');
    }
    get('workspace-layout')?.setAttribute('data-pane-open', String(paneOpen && !narrow));
    get('workspace-layout')?.setAttribute('data-density', layout.density);
    get('pane-toggle')?.setAttribute('aria-expanded', String(paneOpen));
    get('pane-toggle')?.setAttribute('aria-label', paneOpen ? 'Hide devices' : 'Show devices');
    if (get('pane-toggle-label')) get('pane-toggle-label').textContent = paneOpen ? 'Hide devices' : 'Devices';
    if (get('pane-mode')) get('pane-mode').value = layout.pane;
    if (get('workspace-density')) get('workspace-density').value = layout.density;
    if (get('pane-context')) get('pane-context').textContent = activeModule && active === 'apps' ? `Choose a target for ${modules[activeModule]}` : active === 'discover' ? 'Nearby and saved devices' : 'Switch targets without ending the connection';
    if (get('pane-backdrop')) get('pane-backdrop').hidden = !(narrow && paneOpen);
    for (const id of ['workspace-stage', 'workspace-global', 'workspace-session-bar', 'workspace-status', 'workspace-header']) if (get(id)) get(id).inert = narrow && paneOpen;
    document.body?.classList.toggle('workspace-drawer-open', narrow && paneOpen);
  }
  function setPane(mode) {
    if (!['auto', 'open', 'pinned', 'closed'].includes(mode)) return false;
    const wasOpen = paneOpen;
    layout.pane = mode; drawer = mobile() && ['open', 'pinned'].includes(mode); saveLayout(); renderPane();
    if (wasOpen && !paneOpen) get('pane-toggle')?.focus();
    return true;
  }
  function closeDrawer() { drawer = false; renderPane(); get('pane-toggle')?.focus(); }
  function togglePane() {
    if (mobile()) { drawer = !drawer; renderPane(); if (drawer) get('pane-close')?.focus(); }
    else setPane(paneOpen ? 'closed' : 'open');
  }
  function renderViews() {
    tabs('[data-view]', active === 'device' ? 'discover' : active, 'view');
    for (const view of views) { const panel = get(`view-${view}`); if (panel) panel.hidden = active !== view; }
    get('apps-catalog').hidden = Boolean(activeModule); get('apps-heading').hidden = Boolean(activeModule);
    get('module-content').hidden = !activeModule;
    for (const key of Object.keys(modules)) { const panel = get(`${key}-panel`); if (panel) panel.hidden = key !== activeModule; }
    get('module-title').textContent = modules[activeModule] || 'Apps';
    const current = sessionTabs?.current();
    if (current) get(`view-${current.kind === 'app' ? 'apps' : 'device'}`)?.setAttribute('aria-labelledby', current.id);
    else get('view-apps')?.setAttribute('aria-labelledby', 'tab-apps');
    renderPane(); tabView?.render(lastUpdate);
    document.dispatchEvent(new CustomEvent('nanoscope:workspace', { detail: { view: active, module: activeModule, tab: current?.id || '', target: current?.target || null } }));
  }
  function changed() { preferences.setPreference?.('view', active); preferences.onChange?.(active); }
  function restoreTab(tab) {
    if (!tab) { active = 'discover'; activeModule = ''; renderViews(); changed(); return; }
    active = tab.kind === 'app' ? 'apps' : 'device'; activeModule = tab.module;
    restoring = true;
    try {
      const device = tab.target && (preferences.resolveTarget?.(NanoWorkspaceTabs.key(tab.target)) || tab.target);
      if (device) {
        lastDevice = device;
        if (tab.kind === 'app' && preferences.selectModuleTarget) preferences.selectModuleTarget(tab.module, device);
        else (preferences.selectDevice || preferences.selectTarget)?.(device);
      }
    } finally { restoring = false; }
    if (mobile()) drawer = false;
    renderViews(); changed();
  }
  function activate(view, catalog = true) {
    if (view === 'recordings') view = 'apps';
    if (!views.includes(view)) return false;
    if (view === 'device' && selected()) return openDevice(selected());
    const previous = active; active = view;
    if (view === 'apps' && catalog) activeModule = '';
    sessionTabs?.deactivate();
    if (layout.pane === 'open' && previous !== active) { layout.pane = 'auto'; saveLayout(); }
    drawer = false; renderViews(); changed(); return true;
  }
  function openDevice(device) {
    if (!device?.address) return false;
    lastDevice = device; active = 'device'; activeModule = '';
    sessionTabs?.open('device', '', display(device)); drawer = false; renderViews(); changed(); return true;
  }
  function openModule(value, device) {
    if (!Object.hasOwn(modules, value)) return false;
    if (device === undefined) device = preferences.getModuleTarget ? preferences.getModuleTarget(value) : selected();
    activeModule = value; active = 'apps';
    sessionTabs?.open('app', value, display(device));
    restoring = true;
    try { if (device) preferences.selectModuleTarget?.(value, device); } finally { restoring = false; }
    drawer = false; renderViews(); changed(); return true;
  }
  function selectTarget(device) {
    lastDevice = device;
    if (!restoring && active === 'apps' && activeModule) sessionTabs?.setTarget(display(device));
    if (mobile() && drawer) closeDrawer();
  }
  function retarget(value, device) { if (active === 'apps' && activeModule === value) selectTarget(device); }
  function selectTool(value) {
    if (!['command', 'traffic', 'snapshots', 'recipes', 'guide'].includes(value)) return;
    tool = value; tabs('[data-tool]', tool, 'tool'); preferences.setPreference?.('workbenchTab', value);
  }
  function bind(selector, activateTab, attribute) {
    const buttons = Array.from(document.querySelectorAll(selector));
    for (const button of buttons) {
      button.addEventListener('click', () => activateTab(button.dataset[attribute]));
      button.addEventListener('keydown', event => {
        const index = buttons.indexOf(button);
        const next = event.key === 'ArrowRight' ? (index + 1) % buttons.length : event.key === 'ArrowLeft' ? (index + buttons.length - 1) % buttons.length : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault(); activateTab(buttons[next].dataset[attribute]); buttons[next].focus();
      });
    }
  }
  function bindPane() {
    get('pane-toggle')?.addEventListener('click', togglePane);
    get('pane-close')?.addEventListener('click', () => mobile() ? closeDrawer() : setPane('closed'));
    get('pane-backdrop')?.addEventListener('click', closeDrawer);
    get('pane-mode')?.addEventListener('change', event => setPane(event.target.value));
    get('workspace-density')?.addEventListener('change', event => {
      layout.density = event.target.value === 'compact' ? 'compact' : 'comfortable'; saveLayout(); renderPane();
    });
    document.addEventListener?.('keydown', event => {
      if (mobile() && drawer) {
        if (event.key === 'Escape') { event.preventDefault(); closeDrawer(); }
        if (event.key === 'Tab') {
          const controls = [...get('workspace-pane').querySelectorAll('button, input, select, summary, [tabindex="0"]')].filter(item => !item.disabled && item.getClientRects().length);
          const first = controls[0], last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }
      if (event.altKey && event.key === '[' && !event.ctrlKey && !event.metaKey) { event.preventDefault(); togglePane(); }
    });
    globalThis.matchMedia?.('(max-width: 699px)').addEventListener?.('change', () => { drawer = false; renderPane(); });
  }
  function init(options = {}) {
    preferences = options;
    if (!initialized) {
      bind('[data-view]', view => activate(view), 'view'); bind('[data-tool]', selectTool, 'tool'); bindPane();
      get('device-back').addEventListener('click', () => activate('discover'));
      get('apps-back').addEventListener('click', () => activate('apps'));
      try { const saved = JSON.parse(globalThis.localStorage?.getItem(layoutKey) || 'null'); if (['auto', 'open', 'pinned', 'closed'].includes(saved?.pane)) layout.pane = saved.pane; if (saved?.density === 'compact') layout.density = saved.density; } catch {}
      if (typeof NanoWorkspaceTabs !== 'undefined') {
        sessionTabs = NanoWorkspaceTabs.create({ modules, selected: restoreTab, changed: () => tabView?.render(lastUpdate) });
        if (get('workspace-tabs')) tabView = NanoWorkspaceTabs.mount(get('workspace-tabs'), sessionTabs);
      }
      if (typeof NanoSessionAlerts !== 'undefined') {
        alerts = NanoSessionAlerts.create({ getDeviceLabel: connectionLabel }); if (get('session-alert-settings')) NanoSessionAlerts.mount(get('session-alert-settings'), alerts);
      }
      initialized = true;
    }
    const saved = preferences.getPreference?.('view'), current = sessionTabs?.current();
    active = saved === 'recordings' ? 'apps' : views.includes(saved) ? saved : 'discover';
    if (current) { active = current.kind === 'app' ? 'apps' : 'device'; activeModule = current.module; }
    const savedTool = preferences.getPreference?.('workbenchTab');
    if (['command', 'traffic', 'snapshots', 'recipes', 'guide'].includes(savedTool)) tool = savedTool;
    renderViews(); selectTool(tool);
    if (current) restoreTab(current);
  }
  function status({ device, state = {}, online, pending, error, connected } = {}) {
    const ble = state.ble || {}, known = typeof online === 'boolean';
    const linked = known ? online && ble.connected : connected;
    const operation = { connecting: 'Connecting', discovering: 'Discovering services', reading: 'Reading', writing: 'Writing', subscribing: 'Updating subscription', disconnecting: 'Disconnecting' }[ble.operation];
    const label = error ? 'Needs attention' : known && !online ? 'Board offline' : pending ? 'Sending request' : ble.busy ? operation || 'Working' : linked ? 'Connected' : state.collection?.enabled ? 'Collecting' : ble.scanning ? 'Scanning' : known ? 'Ready' : 'Waiting for board';
    const mode = error ? 'error' : known && !online ? 'offline' : pending || ble.busy ? 'busy' : linked ? 'connected' : ble.scanning || state.collection?.enabled ? 'scanning' : 'idle';
    return { label, mode, linked, device };
  }
  function update(value = {}) {
    lastUpdate = value; if (value.device) lastDevice = value.device;
    const { device, state = {} } = value, summary = status(value);
    const name = String(device?.label || device?.name || device?.address || '');
    const targetConnected = summary.linked && (typeof NanoWorkspaceTabs !== 'undefined' ? NanoWorkspaceTabs.connected(device, state) : value.connected);
    get('recorder-context').textContent = name ? `${name}${targetConnected ? ' · Connected' : ''}` : '';
    if (get('workspace-status')) get('workspace-status').dataset.state = summary.mode;
    if (get('session-status-label')) get('session-status-label').textContent = summary.label;
    const linkedDevice = summary.linked && (state.devices || []).find(item => typeof NanoWorkspaceTabs !== 'undefined' && NanoWorkspaceTabs.connected(item, state));
    if (get('session-status-detail')) get('session-status-detail').textContent = value.error || (summary.linked ? connectionLabel(linkedDevice || { address: state.ble?.address }) : name || 'Select a device to inspect');
    const rssi = typeof device?.rssi === 'number' && Number.isFinite(device.rssi) ? device.rssi : null;
    const measured = value.online !== false && rssi !== null && rssi < 0 && rssi >= -127;
    if (get('session-signal')) {
      get('session-signal').dataset.level = measured ? String(rssi >= -50 ? 4 : rssi >= -65 ? 3 : rssi >= -80 ? 2 : 1) : '0';
      get('session-signal').setAttribute('aria-label', measured ? `Last received signal ${rssi} dBm` : 'Signal unavailable');
    }
    if (get('session-signal-label')) get('session-signal-label').textContent = measured ? `${rssi} dBm · last received` : 'No signal reading';
    const count = state.collection?.enabled ? state.collection.recordCount : state.devices?.length;
    if (get('session-count')) get('session-count').textContent = Number.isFinite(count) ? `${count} ${state.collection?.enabled ? 'records' : 'devices in session'}` : '';
    tabView?.render(value); alerts?.update(value);
  }
  return { init, show: view => activate(view), view: () => active, module: () => activeModule, update, openModule, openDevice, selectTarget, retarget, setPane, status,
    tabState: () => sessionTabs?.list() || [], openTool(value) { activate('workbench'); selectTool(value); }, openRecorder: openModule };
})();
if (typeof module !== 'undefined') module.exports = NanoWorkspace;
