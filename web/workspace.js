'use strict';

const NanoWorkspace = (() => {
  const views = ['discover', 'apps', 'workbench', 'insights', 'settings', 'device'];
  const modules = { plaud: 'PLAUD', pocket: 'Pocket', sleep: 'Sleep Number', tracker: 'BLE trackers', medical: 'Dexcom G7', sensor: 'BLE sensors', radiacode: 'RadiaCode', thermometer: 'Thermometers', locks: 'Locks', resmed: 'ResMed CPAP', ge: 'GE appliances', samsung: 'Samsung TVs' };
  let active = 'discover', activeModule = '', tool = 'command', initialized = false;
  let preferences = {};
  const get = id => document.getElementById(id);
  function tabs(selector, selected, attribute) {
    for (const button of document.querySelectorAll(selector)) {
      const current = button.dataset[attribute] === selected;
      button.setAttribute('aria-selected', String(current)); button.tabIndex = current ? 0 : -1;
      if (attribute !== 'view') {
        const panel = get(button.getAttribute('aria-controls'));
        if (panel) panel.hidden = !current;
      }
    }
  }
  function renderViews() {
    tabs('[data-view]', active, 'view');
    for (const view of views) { const panel = get(`view-${view}`); if (panel) panel.hidden = active !== view; }
    if (active === 'device') get('tab-discover').tabIndex = 0;
    get('apps-catalog').hidden = Boolean(activeModule);
    get('apps-heading').hidden = Boolean(activeModule);
    get('module-content').hidden = !activeModule;
    for (const key of Object.keys(modules)) { const panel = get(`${key}-panel`); if (panel) panel.hidden = key !== activeModule; }
    get('module-title').textContent = modules[activeModule] || 'Apps';
    document.dispatchEvent(new CustomEvent('nanoscope:workspace', { detail: { view: active, module: activeModule } }));
  }
  function activate(view, catalog = true) {
    if (view === 'recordings') view = 'apps';
    if (!views.includes(view)) return false;
    const changed = active !== view || view === 'apps' && catalog && activeModule;
    active = view;
    if (view === 'apps' && catalog) activeModule = '';
    renderViews();
    if (changed) {
      preferences.setPreference?.('view', active);
      preferences.onChange?.(active);
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
    return true;
  }
  function openModule(value) {
    if (!Object.hasOwn(modules, value)) return false;
    activeModule = value; activate('apps', false); renderViews();
    preferences.onChange?.(active);
    return true;
  }
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
        const next = event.key === 'ArrowRight' ? (index + 1) % buttons.length
          : event.key === 'ArrowLeft' ? (index + buttons.length - 1) % buttons.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault(); activateTab(buttons[next].dataset[attribute]); buttons[next].focus();
      });
    }
  }
  function init(options = {}) {
    preferences = options;
    if (!initialized) {
      bind('[data-view]', view => activate(view), 'view');
      bind('[data-tool]', selectTool, 'tool');
      get('device-back').addEventListener('click', () => activate('discover'));
      get('apps-back').addEventListener('click', () => activate('apps'));
      initialized = true;
    }
    const saved = preferences.getPreference?.('view');
    active = saved === 'recordings' ? 'apps' : views.includes(saved) ? saved : 'discover';
    const savedTool = preferences.getPreference?.('workbenchTab');
    if (['command', 'traffic', 'snapshots', 'recipes', 'guide'].includes(savedTool)) tool = savedTool;
    renderViews(); selectTool(tool);
  }
  function update({ device, connected } = {}) {
    const name = String(device?.label || device?.name || device?.address || '');
    get('recorder-context').textContent = name ? `Selected device: ${name}${connected ? ' · connected' : ''}` : 'Choose a matching device from Discover or the app catalog.';
  }
  return { init, show: view => activate(view), view: () => active, module: () => activeModule, update, openModule,
    openTool(value) { activate('workbench'); selectTool(value); }, openRecorder: openModule };
})();
if (typeof module !== 'undefined') module.exports = NanoWorkspace;
