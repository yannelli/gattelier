import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const tabs = require('../web/workspace-tabs.js');
const connection = require('../web/connection.js');
const standard = require('../web/standard-app.js');
const storageKey = 'nanoscope.workspace.tabs.v1';
const modules = { sensor: 'Sensors', schlage: 'Schlage', standard: 'Standard BLE' };
const device = { address: 'AA:BB:CC:DD:EE:01', addressType: 0, name: 'Room sensor', rssi: -50, services: ['181a'] };
const second = { ...device, address: 'AA:BB:CC:DD:EE:02', name: 'Hall sensor' };
function storage() { const values = new Map(); return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }; }

test('device and app tabs preserve separate targets and restore the active tab', () => {
  const store = storage(), model = tabs.create({ storage: store, modules });
  const first = model.open('device', '', device);
  const app = model.open('app', 'sensor', second);
  model.select(first.id);
  const restored = tabs.create({ storage: store, modules });
  assert.equal(restored.list().length, 2);
  assert.equal(restored.current().target.address, device.address);
  assert.equal(restored.list().find(item => item.kind === 'app').target.address, second.address);
  assert.equal(model.open('app', 'sensor', second).id, app.id);
  assert.equal(model.list().length, 2);
});

test('retargeting affects the active app and does not invoke selection callbacks', () => {
  const selected = [], model = tabs.create({ storage: storage(), modules, selected: item => selected.push(item) });
  const first = model.open('device', '', device);
  model.setTarget(second);
  assert.equal(model.current().target.address, device.address);
  model.open('app', 'sensor', device); model.setTarget(second);
  assert.equal(model.current().target.address, second.address);
  assert.equal(model.list().find(item => item.id === first.id).target.address, device.address);
  assert.equal(selected.length, 0);
});

test('closing selects an adjacent tab; closing a background tab preserves selection', () => {
  const selected = [], model = tabs.create({ storage: storage(), modules, selected: item => selected.push(item) });
  const first = model.open('device', '', device), last = model.open('device', '', second);
  model.close(first.id);
  assert.equal(model.current().id, last.id); assert.equal(selected.length, 0);
  model.close(last.id);
  assert.equal(model.current(), null); assert.equal(selected[0], null);
});

test('saved targets reject invalid identities and bound services, labels, and tab count', () => {
  const store = storage();
  store.setItem(storageKey, JSON.stringify({ items: [
    { kind: 'device', target: { ...device, address: 'invalid' } },
    { kind: 'device', target: { ...device, addressType: undefined } },
    { kind: 'device', target: { ...device, addressType: 4 } },
    { kind: 'app', module: 'missing', target: device },
    { kind: 'device', target: { ...device, name: 'x'.repeat(1000), services: [...Array(40).fill('181a'), 'invalid'], manufacturer: '4C000102', serviceData: [{ uuid: '181a', hex: '00' }] } }
  ] }));
  const model = tabs.create({ storage: store, modules });
  assert.equal(model.list().length, 1);
  const saved = model.current() || model.list()[0];
  assert.equal(saved.target.name.length, 128); assert.equal(saved.target.services.length, 32);
  assert.deepEqual(saved.target.serviceData, []); assert.equal(saved.target.payloadHex, '');
  assert.equal(saved.target.manufacturer, ''); assert.equal(saved.target.rssi, null);
  for (let i = 0; i < 30; i++) model.open('device', '', { ...device, address: `AA:BB:CC:DD:EE:${i.toString(16).padStart(2, '0')}` });
  assert.equal(model.list().length, 24);
  assert.equal(tabs.create({ storage: store, modules }).list().length, 24);
});

test('manufacturer glyphs use named metadata and ignore raw advertisement data', () => {
  const model = tabs.create({ storage: storage(), modules });
  const raw = model.open('device', '', { ...device, manufacturer: '4C00AA' });
  assert.equal(tabs.appearance(raw).glyph, 'BT');
  const named = model.open('device', '', { ...second, manufacturerName: 'Apple' });
  assert.equal(tabs.appearance(named).glyph, 'AP');
  assert.notEqual(tabs.appearance(raw).hue, tabs.appearance(named).hue);
});

test('connection identity includes address type and ignores address case', () => {
  const state = { ble: { connected: true, address: device.address.toLowerCase(), addressType: 0 } };
  assert.equal(tabs.connected(device, state), true);
  assert.equal(tabs.connected({ ...device, addressType: 1 }, state), false);
  assert.equal(tabs.connected(device, { ble: { ...state.ble, connected: false } }), false);
});

test('restricted localStorage getter leaves tabs usable', () => {
  const context = { module: { exports: {} } };
  Object.defineProperty(context, 'localStorage', { get() { throw new Error('SecurityError'); } });
  vm.runInNewContext(readFileSync(new URL('../web/workspace-tabs.js', import.meta.url), 'utf8'), context);
  const model = context.module.exports.create({ modules });
  assert.ok(model.open('device', '', device));
});

test('tab keyboard controls select, wrap, and close while preserving focus', () => {
  const elements = new Map();
  const doc = { activeElement: null, getElementById: id => elements.get(id) };
  function element(tag = 'div') {
    return { tag, children: [], dataset: {}, attributes: {}, style: { setProperty() {} }, listeners: {},
      set id(value) { this._id = value; elements.set(value, this); }, get id() { return this._id; },
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(key, value) { this.listeners[key] = value; },
      append(...children) { this.children.push(...children); }, replaceChildren(fragment) { this.children = fragment.children; },
      contains(item) { return this === item || this.children.some(child => child.contains(item)); },
      querySelectorAll(selector) { return this.children.flatMap(child => [...((selector === '[data-close-tab]' ? child.dataset.closeTab : child.attributes.role === 'tab') ? [child] : []), ...child.querySelectorAll(selector)]); },
      querySelector(selector) { return this.querySelectorAll(selector)[0]; }, focus() { doc.activeElement = this; }
    };
  }
  doc.createElement = element; doc.createDocumentFragment = element;
  const context = { document: doc, module: { exports: {} } };
  vm.runInNewContext(readFileSync(new URL('../web/workspace-tabs.js', import.meta.url), 'utf8'), context);
  const api = context.module.exports, root = element(); let view;
  const model = api.create({ storage: storage(), modules, changed: () => view?.render() });
  const first = model.open('device', '', device), last = model.open('app', 'sensor', second);
  view = api.mount(root, model); view.render();
  let prevented = 0;
  const press = (id, key) => elements.get(id).listeners.keydown({ key, preventDefault() { prevented++; } });
  press(last.id, 'ArrowRight');
  assert.equal(model.current().id, first.id); assert.equal(doc.activeElement.id, first.id);
  press(first.id, 'End'); assert.equal(model.current().id, last.id);
  press(last.id, 'Delete'); assert.equal(model.current().id, first.id); assert.equal(doc.activeElement.id, first.id);
  assert.equal(prevented, 3);
});


test('restored targets preserve connectability with an empty live scan', () => {
  for (const kind of ['device', 'app']) for (const connectable of [true, false, undefined, 'false', 0]) {
    const store = storage(), model = tabs.create({ storage: store, modules });
    model.open(kind, kind === 'app' ? 'standard' : '', { ...device, connectable });
    const restored = tabs.create({ storage: store, modules }).current().target;
    assert.equal(restored.connectable, typeof connectable === 'boolean' ? connectable : undefined);
    const status = connection.describe(restored, { state: { ble: { connected: false }, devices: [] }, selected: restored, online: true, pending: false });
    assert.equal(status.enabled, connectable !== false);
    assert.equal(status.status, connectable === false ? 'Broadcast only' : 'Saved device');
    assert.equal(status.label, connectable === false ? 'Connect' : 'Try known address');
  }
});

test('restored service context retains prefixed UUIDs and rejects malformed values', () => {
  const store = storage(), model = tabs.create({ storage: store, modules });
  const valid = ['0x180f', '0X181A', '1809', '12345678', '0x12345678', '0000180d-0000-1000-8000-00805f9b34fb'];
  const invalid = ['0x180', '0x180ff', '0x180g', '0x', '0x123456789', ' 0x180f', '0x180f ', '0x0000180d-0000-1000-8000-00805f9b34fb', '0000180d-0000-1000-8000-00805f9b34fg', null, 6159, { uuid: '180f' }];
  model.open('device', '', { ...device, connectable: true, services: [...invalid, ...valid] });
  const restored = tabs.create({ storage: store, modules }).current().target;
  assert.deepEqual(restored.services, valid);
  assert.deepEqual(standard.matches(restored).map(item => item.uuid), ['180f', '181a', '1809', '180d']);
  assert.equal(connection.describe(restored, { state: { ble: {}, devices: [] }, online: true, pending: false }).enabled, true);
});

test('restored tabs retain bounded learned names with label and advertised-name precedence', () => {
  for (const kind of ['device', 'app']) for (const [names, expected] of [
    [{ name: '', gattName: 'Learned sensor' }, 'Learned sensor'],
    [{ name: '  ', gattName: ' Learned sensor ' }, 'Learned sensor'],
    [{ name: 'Advertised sensor', gattName: 'Learned sensor' }, 'Advertised sensor'],
    [{ label: 'Desk', name: 'Advertised sensor', gattName: 'Learned sensor' }, 'Desk'],
    [{ name: '', gattName: 'x'.repeat(200) }, 'x'.repeat(128)]
  ]) {
    const store = storage(), model = tabs.create({ storage: store, modules });
    model.open(kind, kind === 'app' ? 'standard' : '', { ...device, ...names });
    const restored = tabs.create({ storage: store, modules }).current();
    assert.equal(restored.target.gattName, names.gattName.slice(0, 128));
    assert.equal(tabs.appearance(restored).name, expected);
  }
});
