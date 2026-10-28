import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const source = readFileSync(new URL('../web/modules.js', import.meta.url), 'utf8');
const require = createRequire(new URL('../web/modules.js', import.meta.url));
function harness(initial, sharedName) {
  let devices = initial, selected = null, active = '';
  const selections = [], deviceCalls = [];
  const forbidden = (...args) => { deviceCalls.push(args); throw new Error('Unexpected device action'); };
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.classList = { add() {} }; this.textContent = ''; }
    before() {}
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
    addEventListener(type, callback) { this.listeners[type] = callback; }
  }
  const ids = new Map(), get = id => { if (!ids.has(id)) ids.set(id, new Element('div')); return ids.get(id); };
  const reader = { mount: () => ({ render() {} }) };
  const context = { module: { exports: {} }, require,
    NanoLab: { isActing: () => false, getState: () => ({}), action: forbidden },
    NanoWorkspace: { module: () => active, openModule: id => { active = id; } },
    NanoSchlageApp: reader, NanoStandardApp: reader, NanoProtocolApp: reader, NanoBeaconApp: reader, NanoSensorApp: reader,
    NanoDexcom: { mount() {} }, NanoDeviceSupport: { families: {} },
    NanoConnection: { ensure: forbidden, describe: () => ({}), controls: () => new Element('div') },
    replacePreservingFocus: (element, content) => element.replaceChildren(content),
    document: { createElement: tag => new Element(tag), createTextNode: text => Object.assign(new Element('text'), { textContent: text }), createDocumentFragment: () => new Element('fragment'), getElementById: get }
  };
  if (sharedName) context.deviceDisplayName = sharedName;
  vm.runInNewContext(source, context);
  const apps = context.module.exports;
  apps.mount({ selected: () => selected, devices: () => devices, select: (device, restored) => { selected = device; selections.push({ device, restored }); } });
  const render = () => apps.render(selected, devices); render();
  const nodes = (id = 'apps-catalog') => { const result = []; const visit = node => { result.push(node); node.children.forEach(visit); }; visit(get(id)); return result; };
  return { nodes, apps, selections, deviceCalls, select(device) { selected = device; render(); }, scope(value) { const select = nodes().find(node => node.dataset.focus === 'app-scope'); select.value = value; select.listeners.change(); },
    update(next) { devices = next; render(); }, get selected() { return selected; } };
}
const saved = { address: 'AA:BB:CC:DD:EE:01', addressType: 0, services: ['1809'], name: 'Saved thermometer' };
const card = (h, title) => h.nodes().find(node => node.tag === 'article' && node.children[0].children.some(child => child.tag === 'h3' && child.textContent === title));
const badge = node => node.children[0].children.find(child => child.className === 'badge')?.textContent;
test('nearby browsing excludes saved-only apps while all apps labels saved matches', () => {
  const h = harness([saved]);
  assert.equal(badge(card(h, 'Thermometers')), '1 saved');
  h.scope('observed'); assert.equal(card(h, 'Thermometers'), undefined);
  assert.ok(h.nodes().some(node => node.textContent === 'No matching apps'));
  h.scope('all'); assert.ok(card(h, 'Thermometers'));
});
test('nearby browsing counts live matches and opens the live target without saved ambiguity', () => {
  for (const presence of [{ liveId: 0 }, { streamLive: true }]) {
    const live = { ...saved, addressType: 1, ...presence }, h = harness([saved, live]);
    assert.equal(badge(card(h, 'Thermometers')), '1 nearby');
    assert.ok(card(h, 'Thermometers').children.some(node => node.tag === 'label'));
    h.scope('observed');
    assert.equal(card(h, 'Thermometers').children.length, 1);
    card(h, 'Thermometers').children[0].listeners.click();
    assert.equal(h.selected, live); assert.equal(h.apps.appDevice('thermometer'), live);
    h.update([saved]); assert.equal(card(h, 'Thermometers'), undefined);
  }
});


test('learned names refresh the catalog intro, both target pickers and app context', () => {
  for (const shared of [false, true]) {
    const first = { ...saved, name: ' ', gattName: 'Learned thermometer' }, second = { ...first, addressType: 1, gattName: 'Other thermometer' };
    const name = device => `Shared ${device.gattName}`;
    const h = harness([first, second], shared ? name : undefined), shown = value => shared ? `Shared ${value}` : value;
    h.select(first);
    card(h, 'Standard BLE').children[0].listeners.click();
    const check = expected => {
      assert.ok(h.nodes().some(node => node.textContent === `Apps for ${expected} are shown first.`));
      const catalogPicker = h.nodes().find(node => node.dataset.focus === 'app-device-standard');
      assert.equal(catalogPicker.children[1].textContent, `${expected} · history`);
      const appPicker = h.nodes('module-device-picker').find(node => node.dataset.focus === 'module-device-select');
      assert.equal(appPicker.children[1].textContent, `${expected} · ${first.address} · saved`);
      assert.equal(appPicker.value, `${first.address}/0`);
      assert.equal(h.nodes('recorder-context')[0].textContent, expected);
    };
    check(shown('Learned thermometer'));
    const oldButton = card(h, 'Standard BLE').children[0], oldKey = oldButton.dataset.focus;
    first.gattName = 'Updated thermometer'; h.update([first, second]);
    check(shown('Updated thermometer'));
    const refreshed = card(h, 'Standard BLE').children[0];
    assert.notEqual(refreshed, oldButton); assert.equal(oldKey, 'app-card-open-standard'); assert.equal(refreshed.dataset.focus, oldKey);
    const keys = h.nodes().filter(node => node.className === 'app-card-open').map(node => node.dataset.focus);
    assert.equal(new Set(keys).size, keys.length);
    second.gattName = 'Updated other thermometer'; h.update([first, second]);
    const picker = h.nodes().find(node => node.dataset.focus === 'app-device-standard');
    assert.equal(picker.children[2].textContent, `${shown('Updated other thermometer')} · history`);
  }
});

test('selected saved device learned-name changes refresh the intro outside the device list', () => {
  const h = harness([]), selected = { ...saved, name: '', gattName: 'First learned name' };
  h.select(selected); selected.gattName = 'New learned name'; h.select(selected);
  assert.ok(h.nodes().some(node => node.textContent === 'Apps for New learned name are shown first.'));
});


test('explicit restore replaces a previous target without current GATT evidence and keeps it in the picker', () => {
  const previous = { ...saved, addressType: 1 }, target = { ...saved, services: [], name: '', gattName: 'Restored target' };
  const h = harness([previous]);
  assert.equal(h.apps.selectAppDevice('standard', previous), true);
  h.update([previous]);
  card(h, 'Standard BLE').children[0].listeners.click();
  assert.equal(h.apps.selectAppDevice('standard', target), false);
  assert.equal(h.apps.appDevice('standard'), previous);
  assert.equal(h.apps.selectAppDevice('standard', target, true), true);
  assert.equal(h.apps.appDevice('standard'), target);
  assert.equal(h.selected, target);
  assert.deepEqual(h.selections, [{ device: previous, restored: false }, { device: target, restored: true }]);
  h.update([previous]);
  const picker = () => h.nodes('module-device-picker').find(node => node.dataset.focus === 'module-device-select');
  assert.equal(picker().value, `${target.address}/0`);
  assert.ok(picker().children.some(node => node.value === `${previous.address}/1`));
  assert.equal(picker().children.find(node => node.value === `${target.address}/0`).textContent, `Restored target · ${target.address} · saved`);
  h.update([]);
  assert.equal(picker().value, `${target.address}/0`);
  assert.equal(picker().disabled, false);
  picker().listeners.change();
  assert.equal(h.apps.appDevice('standard'), target);
  const live = { ...target, address: target.address.toLowerCase(), services: ['180f'], streamLive: true };
  h.update([live]);
  assert.equal(picker().children.filter(node => node.value).length, 1);
  assert.equal(picker().value, `${live.address}/0`);
  assert.doesNotMatch(picker().children[1].textContent, / · saved$/);
  assert.deepEqual(h.deviceCalls, []);
});

test('restored app targets require a known module and valid address and type', () => {
  const h = harness([]), target = { ...saved, services: [] };
  for (const restored of [false, true]) {
    for (const invalid of [null, { ...target, address: 'invalid' }, { ...target, address: 123 }, { ...target, addressType: undefined }, { ...target, addressType: '0' }, { ...target, addressType: -1 }, { ...target, addressType: 4 }, { ...target, addressType: 0.5 }]) {
      assert.equal(h.apps.selectAppDevice('standard', invalid, restored), false);
      assert.equal(h.apps.rememberTarget('standard', invalid, restored), false);
    }
    assert.equal(h.apps.selectAppDevice('missing', target, restored), false);
    assert.equal(h.apps.rememberTarget('missing', target, restored), false);
  }
  assert.equal(h.apps.rememberTarget('standard', target), false);
  assert.equal(h.apps.selectAppDevice('standard', target, 'true'), false);
  assert.equal(h.apps.appDevice('standard'), null);
  assert.equal(h.apps.rememberTarget('standard', target, true), true);
  assert.equal(h.apps.appDevice('standard'), target);
  assert.deepEqual(h.selections, []); assert.deepEqual(h.deviceCalls, []);
});

test('restoring a passive app target preserves global selection without connecting', () => {
  const h = harness([]), target = { ...saved, services: [] };
  h.select(saved);
  assert.equal(h.apps.selectAppDevice('nespresso', target), false);
  assert.equal(h.apps.selectAppDevice('nespresso', target, true), true);
  assert.equal(h.apps.appDevice('nespresso'), target);
  assert.equal(h.selected, saved);
  assert.deepEqual(h.selections, []); assert.deepEqual(h.deviceCalls, []);
});
