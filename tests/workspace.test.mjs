import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const tabAPI = createRequire(import.meta.url)('../web/workspace-tabs.js');
const source = readFileSync(new URL('../web/workspace.js', import.meta.url), 'utf8');
function setup(saved = 'discover', options = {}) {
  const events = [], elements = new Map(), viewNames = ['discover', 'apps', 'workbench', 'insights', 'settings'], tools = ['command', 'traffic', 'snapshots', 'recipes', 'guide'];
  function element(id, data = {}) {
    if (!elements.has(id)) elements.set(id, { hidden: false, dataset: data, attributes: {}, listeners: {}, setAttribute(key, value) { this.attributes[key] = value; }, getAttribute(key) { return this.attributes[key]; }, addEventListener(key, action) { this.listeners[key] = action; }, focus() { this.focused = true; } });
    return elements.get(id);
  }
  const buttons = viewNames.map(view => element(`tab-${view}`, { view }));
  for (const button of buttons) button.attributes['aria-controls'] = `view-${button.dataset.view}`;
  const toolButtons = tools.map(tool => element(`tool-${tool}`, { tool }));
  for (const button of toolButtons) button.attributes['aria-controls'] = `${button.dataset.tool}-panel`;
  for (const view of [...viewNames, 'device']) element(`view-${view}`);
  for (const module of ['plaud', 'pocket', 'sleep', 'tracker', 'medical', 'sensor']) element(`${module}-panel`);
  const listeners = {}, storage = options.storage || { getItem() {}, setItem() {} };
  const context = { CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } }, module: { exports: {} }, localStorage: storage, matchMedia: () => ({ matches: Boolean(options.mobile), addEventListener() {} }), window: { scrollTo() {} }, document: { addEventListener: (type, action) => { listeners[type] = action; }, dispatchEvent: event => events.push(event), getElementById: id => element(id), querySelectorAll: selector => selector === '[data-view]' ? buttons : toolButtons } };
  if (options.tabs) context.NanoWorkspaceTabs = { ...tabAPI, create: value => tabAPI.create({ ...value, storage }), mount: () => ({ render() {} }) };
  vm.runInNewContext(source, context);
  const workspace = context.module.exports, prefs = {};
  workspace.init({ getPreference: key => key === 'view' ? saved : undefined, setPreference: (key, value) => { prefs[key] = value; }, ...options.hooks });
  return { workspace, element, prefs, buttons, events, listeners };
}
test('Apps opens the catalog and migrates the old Recordings preference', () => {
  const { workspace, element } = setup('recordings');
  assert.equal(workspace.view(), 'apps');
  assert.equal(element('module-content').hidden, true);
  assert.equal(element('apps-catalog').hidden, false);
  assert.equal(element('plaud-panel').hidden, true);
});
test('one module is visible and All apps returns to the catalog', () => {
  const { workspace, element } = setup();
  assert.equal(workspace.openRecorder('plaud'), true);
  assert.equal(element('plaud-panel').hidden, false);
  assert.equal(element('pocket-panel').hidden, true);
  assert.equal(element('apps-catalog').hidden, true);
  workspace.openModule('medical');
  assert.equal(workspace.module(), 'medical');
  assert.equal(element('medical-panel').hidden, false);
  assert.equal(element('plaud-panel').hidden, true);
  element('apps-back').listeners.click();
  assert.equal(workspace.module(), '');
  assert.equal(element('module-content').hidden, true);
  assert.equal(element('apps-catalog').hidden, false);
  assert.equal(workspace.openModule('unknown'), false);
});
test('contextual device view hides primary panels and has a working return', () => {
  const { workspace, element, buttons } = setup();
  workspace.show('device');
  assert.equal(element('view-device').hidden, false);
  for (const button of buttons) assert.equal(element(`view-${button.dataset.view}`).hidden, true);
  assert.equal(element('tab-discover').tabIndex, 0);
  element('device-back').listeners.click();
  assert.equal(workspace.view(), 'discover');
  assert.equal(element('view-device').hidden, true);
});

test('workspace changes identify the active module for live-reader lifecycle', () => {
  const { workspace, events } = setup();
  workspace.openModule('radiacode');
  assert.equal(events.at(-1).type, 'nanoscope:workspace');
  assert.equal(events.at(-1).detail.module, 'radiacode');
  workspace.show('discover');
  assert.equal(events.at(-1).detail.view, 'discover');
});

const target = { address: 'AA:BB:CC:DD:EE:01', addressType: 0, name: 'Room sensor', services: ['181a'] };
const other = { ...target, address: 'AA:BB:CC:DD:EE:02', name: 'Hall sensor' };
function memoryStorage() { const values = new Map(); return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }; }

test('app opening uses its matched target and restores it after reload', () => {
  const storage = memoryStorage(), selected = [];
  const hooks = { getSelected: () => other, getModuleTarget: () => target, selectModuleTarget: (id, device, restored) => selected.push([id, device.address, restored]) };
  const first = setup('discover', { tabs: true, storage, hooks });
  first.workspace.openModule('sensor');
  assert.equal(first.workspace.tabState()[0].target.address, target.address);
  const second = setup('discover', { tabs: true, storage, hooks });
  assert.equal(second.workspace.module(), 'sensor'); assert.equal(second.workspace.view(), 'apps');
  assert.deepEqual(selected, [['sensor', target.address, undefined], ['sensor', target.address, true]]);
});

test('app restoration leaves global selection to the module selection hook', () => {
  const storage = memoryStorage(); let globalSelections = 0, moduleSelections = 0;
  const first = setup('discover', { tabs: true, storage }); first.workspace.openModule('sensor', target);
  setup('discover', { tabs: true, storage, hooks: { selectDevice: () => globalSelections++, selectModuleTarget: () => moduleSelections++ } });
  assert.equal(globalSelections, 0); assert.equal(moduleSelections, 1);
});

test('selection callbacks during restoration do not replace other saved targets', () => {
  const storage = memoryStorage();
  const first = setup('discover', { tabs: true, storage });
  first.workspace.openModule('sensor', target); first.workspace.openModule('standard', other);
  const second = setup('discover', { tabs: true, storage });
  second.workspace.init({ selectModuleTarget: (id, device) => second.workspace.retarget(id, device) });
  assert.deepEqual(second.workspace.tabState().map(item => item.target.address), [target.address, other.address]);
});

test('Schlage and Standard BLE panels are registered', () => {
  const { workspace, element } = setup();
  workspace.openModule('schlage'); assert.equal(element('module-title').textContent, 'Schlage');
  workspace.openModule('standard'); assert.equal(element('module-title').textContent, 'Standard BLE');
  assert.equal(element('schlage-panel').hidden, true); assert.equal(element('standard-panel').hidden, false);
});

test('pane modes follow navigation and pinned mode remains visible', () => {
  const { workspace, element } = setup();
  assert.equal(element('workspace-pane').hidden, false);
  workspace.show('workbench'); assert.equal(element('workspace-pane').hidden, true);
  workspace.setPane('pinned'); workspace.show('settings'); assert.equal(element('workspace-pane').hidden, false);
  workspace.setPane('closed'); workspace.show('discover'); assert.equal(element('workspace-pane').hidden, true);
  workspace.setPane('open'); workspace.show('workbench'); assert.equal(element('workspace-pane').hidden, true);
  assert.equal(workspace.setPane('invalid'), false);
});

test('mobile drawer makes content inert and Escape restores toggle focus', () => {
  const { element, listeners } = setup('discover', { mobile: true });
  assert.equal(element('workspace-pane').hidden, true);
  element('pane-toggle').listeners.click();
  assert.equal(element('workspace-pane').hidden, false); assert.equal(element('workspace-stage').inert, true);
  assert.equal(element('pane-close').focused, true);
  let prevented = false;
  listeners.keydown({ key: 'Escape', preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(element('workspace-pane').hidden, true);
  assert.equal(element('workspace-stage').inert, false); assert.equal(element('pane-toggle').focused, true);
});

test('opening the device pane refreshes deferred rows on desktop and mobile', () => {
  for (const mobile of [false, true]) {
    let opened = 0;
    const { workspace, element } = setup('workbench', { mobile, hooks: { onPaneOpen: () => opened++ } });
    assert.equal(opened, 0);
    element('pane-toggle').listeners.click(); assert.equal(opened, 1);
    assert.equal(element('workspace-pane').hidden, false);
    if (!mobile) { workspace.setPane('open'); assert.equal(opened, 1); }
    element('pane-toggle').listeners.click(); assert.equal(opened, 1);
    element('pane-toggle').listeners.click(); assert.equal(opened, 2);
  }
});

test('global navigation keyboard selects the requested view', () => {
  const { element, workspace } = setup(); let prevented = false;
  element('tab-discover').listeners.keydown({ key: 'End', preventDefault() { prevented = true; } });
  assert.equal(workspace.view(), 'settings'); assert.equal(element('tab-settings').focused, true); assert.equal(prevented, true);
});

test('live status and signal graphics use reported state and exact connected identity', () => {
  const { workspace, element } = setup('discover', { tabs: true });
  const state = { ble: { connected: true, address: target.address.toLowerCase(), addressType: 0 }, devices: [target] };
  workspace.update({ device: { ...target, rssi: -64 }, online: true, state });
  assert.equal(element('session-status-label').textContent, 'Connected');
  assert.equal(element('session-status-detail').textContent, 'Room sensor');
  assert.equal(element('session-signal').dataset.level, '3');
  assert.match(element('recorder-context').textContent, /Connected/);
  workspace.update({ device: { ...target, addressType: 1 }, online: true, state });
  assert.doesNotMatch(element('recorder-context').textContent, /Connected/);
  assert.equal(element('session-signal').dataset.level, '0');
  workspace.update({ device: { ...target, rssi: -40 }, online: false, state });
  assert.equal(element('session-status-label').textContent, 'Board offline'); assert.equal(element('session-signal').dataset.level, '0');
});

test('selecting another device in its full page activates a separate target tab', () => {
  const { workspace } = setup('discover', { tabs: true });
  workspace.openDevice(target);
  workspace.selectTarget(other);
  assert.deepEqual(workspace.tabState().map(item => item.target.address), [target.address, other.address]);
  assert.equal(workspace.view(), 'device');
  workspace.selectTarget(target);
  assert.equal(workspace.tabState().length, 2);
});

test('closed tabs and global navigation leave panel labels pointing to existing headings', () => {
  const { workspace, element } = setup('discover', { tabs: true });
  workspace.openDevice(target);
  assert.equal(element('view-device').attributes['aria-labelledby'], workspace.tabState()[0].id);
  workspace.show('insights');
  assert.equal(element('view-device').attributes['aria-labelledby'], 'device-page-title');
  workspace.openModule('sensor', target);
  workspace.openDevice(target);
  assert.equal(element('view-apps').attributes['aria-labelledby'], 'tab-apps');
});

test('mobile pane shortcut returns focus to its toggle when closing', () => {
  const { element, listeners } = setup('discover', { mobile: true });
  const event = { key: '[', altKey: true, preventDefault() {} };
  listeners.keydown(event);
  assert.equal(element('pane-close').focused, true);
  listeners.keydown(event);
  assert.equal(element('workspace-pane').hidden, true);
  assert.equal(element('pane-toggle').focused, true);
});
