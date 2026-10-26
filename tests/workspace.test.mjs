import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../web/workspace.js', import.meta.url), 'utf8');
function setup(saved = 'discover') {
  const elements = new Map(), viewNames = ['discover', 'apps', 'workbench', 'insights', 'settings'], tools = ['command', 'traffic', 'snapshots', 'recipes', 'guide'];
  function element(id, data = {}) {
    if (!elements.has(id)) elements.set(id, { hidden: false, dataset: data, attributes: {}, listeners: {}, setAttribute(key, value) { this.attributes[key] = value; }, getAttribute(key) { return this.attributes[key]; }, addEventListener(key, action) { this.listeners[key] = action; }, focus() {} });
    return elements.get(id);
  }
  const buttons = viewNames.map(view => element(`tab-${view}`, { view }));
  for (const button of buttons) button.attributes['aria-controls'] = `view-${button.dataset.view}`;
  const toolButtons = tools.map(tool => element(`tool-${tool}`, { tool }));
  for (const button of toolButtons) button.attributes['aria-controls'] = `${button.dataset.tool}-panel`;
  for (const view of [...viewNames, 'device']) element(`view-${view}`);
  for (const module of ['plaud', 'pocket', 'sleep', 'tracker', 'medical', 'sensor']) element(`${module}-panel`);
  const context = { module: { exports: {} }, window: { scrollTo() {} }, document: { getElementById: id => element(id), querySelectorAll: selector => selector === '[data-view]' ? buttons : toolButtons } };
  vm.runInNewContext(source, context);
  const workspace = context.module.exports, prefs = {};
  workspace.init({ getPreference: key => key === 'view' ? saved : undefined, setPreference: (key, value) => { prefs[key] = value; } });
  return { workspace, element, prefs, buttons };
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
