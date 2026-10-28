import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../web/app.js', import.meta.url));
const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const { create } = require('./scan-store.js');
const devices = [0, 1, 2].map(index => ({ address: `aa:bb:cc:dd:ee:0${index}`, addressType: 0, name: `Device ${index}`, rssi: -50 }));
const key = device => `${device.address}/${device.addressType}`;
function harness() {
  const performed = [], selections = [], events = [], rows = [];
  let focused, reads = 0, status = { enabled: true, connected: false }, pending = null;
  const other = { closest: () => null };
  const inspector = { closest: selector => selector.startsWith('#inspector') ? inspector : null };
  const list = { closest: () => null, contains: target => target === list || rows.includes(target), querySelectorAll: () => rows };
  for (const device of devices) {
    const row = { dataset: { focus: key(device) }, closest: selector => selector === 'button.device' ? row : null, focus: () => { focused = row; } };
    rows.push(row);
  }
  const context = vm.createContext({ module: { exports: {} }, require, console,
    NanoRecorders: { identify: () => null }, NanoProfiles: { identify: () => ({ category: 'other', title: 'BLE metadata' }) },
    NanoConnection: { describe: () => status, pendingDevice: () => pending, perform: device => performed.push(device) },
    NanoWorkspace: { view: () => 'discover', selectTarget: device => selections.push(device) },
    NanoGattValues: require('./gatt-values.js'), readAllValues: () => { reads++; },
    matchMedia: () => ({ matches: false }), CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
  });
  vm.runInContext(source, context);
  context.document = { getElementById: id => id === 'devices' ? list : null, dispatchEvent: event => events.push(event) };
  context.fixtures = devices;
  vm.runInContext('state.devices = fixtures; render = () => {};', context);
  function press(key, target = other, options = {}) {
    const event = { key, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...options };
    context.module.exports.handleDeviceKeyboard(event);
    return event;
  }
  return { context, rows, list, other, inspector, performed, selections, events, press,
    get focused() { return focused; }, get reads() { return reads; },
    set status(value) { status = value; }, set pending(value) { pending = value; } };
}

test('display-name precedence includes recorder, vendor, profile and address fallbacks', () => {
  const { context } = harness(), display = context.module.exports.deviceDisplayName;
  const item = { ...devices[0], label: ' Local ', name: 'Advertised', gattName: 'Remembered', manufacturer: '3412' };
  const database = { company: { 4660: 'Acme' } };
  assert.equal(display(item, database), 'Local');
  item.label = ' '; assert.equal(display(item, database), 'Advertised');
  item.name = ''; assert.equal(display(item, database), 'Remembered');
  item.gattName = '';
  context.NanoRecorders.identify = () => ({ product: 'Recorder profile' });
  assert.equal(display(item, database), 'Recorder profile');
  context.NanoRecorders.identify = () => null;
  assert.equal(display(item, database), 'Acme');
  context.NanoProfiles.identify = () => ({ category: 'sensor', title: 'Temperature sensor' });
  assert.equal(display(item, null), 'Temperature sensor');
  context.NanoProfiles.identify = () => ({ category: 'other', title: 'BLE metadata' });
  assert.equal(display(item, null), item.address);
});

test('list arrows select and focus adjacent rows and stop at boundaries', () => {
  const h = harness();
  assert.equal(h.press('ArrowDown', h.list).defaultPrevented, true);
  assert.equal(h.focused, h.rows[0]);
  h.press('ArrowDown', h.rows[0]); assert.equal(h.focused, h.rows[1]);
  h.press('ArrowDown', h.rows[1]); assert.equal(h.focused, h.rows[2]);
  h.press('ArrowDown', h.rows[2]); assert.equal(h.focused, h.rows[2]);
  h.press('ArrowUp', h.rows[2]); assert.equal(h.focused, h.rows[1]);
  h.press('ArrowUp', h.rows[1]); h.press('ArrowUp', h.rows[0]);
  assert.equal(h.focused, h.rows[0]);
  assert.equal(h.selections.at(-1), devices[0]);
  assert.equal(h.events.at(-1).type, 'nanoscope:selection');
  assert.equal(h.events.at(-1).detail, devices[0]);
  assert.equal(h.press('ArrowDown', h.other).defaultPrevented, false);
});

test('list Enter connects or cancels through perform and leaves ready connections intact', () => {
  const h = harness();
  assert.equal(h.press('Enter', h.rows[1]).defaultPrevented, true);
  assert.deepEqual(h.performed, [devices[1]]);
  h.status = { enabled: true, connected: true };
  h.press('Enter', h.rows[1]); assert.equal(h.performed.length, 1);
  h.status = { enabled: true, connected: true, cancel: true };
  h.press('Enter', h.rows[1]); assert.equal(h.performed.length, 2);
  h.status = { enabled: false, cancel: true };
  h.press('Enter', h.rows[1]); assert.equal(h.performed.length, 2);
  h.status = { enabled: true };
  h.press('Enter', h.rows[1], { repeat: true }); assert.equal(h.performed.length, 2);
  assert.equal(h.press('Enter', h.other).defaultPrevented, false);
  h.press('ArrowDown', h.list); h.press('Enter', h.list);
  assert.equal(h.performed.at(-1), devices[0]);
});

test('Escape cancels an active attempt and R invokes the shared inspector read toggle', () => {
  const h = harness();
  assert.equal(h.press('Escape').defaultPrevented, false);
  h.pending = devices[2]; h.status = { enabled: true, cancel: true };
  assert.equal(h.press('Escape').defaultPrevented, true);
  assert.deepEqual(h.performed, [devices[2]]);
  h.status = { enabled: false, cancel: true };
  h.press('Escape'); assert.equal(h.performed.length, 1);
  h.press('r', h.inspector); h.press('R', h.inspector);
  assert.equal(h.reads, 2);
  h.press('r', h.other); h.press('r', h.inspector, { repeat: true });
  assert.equal(h.reads, 2);
});

test('keyboard shortcuts ignore editable targets, modifiers, composition and handled events', () => {
  const h = harness(); h.pending = devices[0]; h.status = { enabled: true, cancel: true };
  for (const options of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }, { defaultPrevented: true }]) {
    for (const [key, target] of [['Enter', h.rows[0]], ['ArrowDown', h.list], ['Escape', h.other], ['r', h.inspector]]) h.press(key, target, options);
  }
  for (const target of [{ isContentEditable: true }, { closest: selector => selector.startsWith('input,') ? {} : null }]) {
    for (const key of ['Enter', 'ArrowDown', 'Escape', 'r']) h.press(key, target);
  }
  assert.equal(h.performed.length, 0); assert.equal(h.selections.length, 0); assert.equal(h.reads, 0);
});

test('cleared history stays empty when connected state updates learn a fallback name', async () => {
  const storage = { value: null, async load() { return this.value; }, async save(value) { this.value = structuredClone(value); } };
  const store = create({ storage }); await store.init();
  store.ingest({ uptime: 100, devices: [{ ...devices[0], id: 4, lastSeen: 90 }] }, 1000000);
  const fallback = store.devices()[0];
  const { context } = harness(); context.fallback = fallback;
  vm.runInContext('selectedFallback = fallback;', context);
  const state = { ble: { connected: true, address: fallback.address, addressType: 0 }, services: [{ characteristics: [{ uuid: '2a00', valueHex: Buffer.from('Known sensor').toString('hex') }] }] };
  context.module.exports.rememberGattName(state, store);
  await store.flush();
  assert.equal(storage.value.records[0].gattName, 'Known sensor');
  await store.clearHistory();
  state.services[0].characteristics[0].valueHex = Buffer.from('Updated sensor').toString('hex');
  context.module.exports.rememberGattName(state, store);
  context.module.exports.rememberGattName(state, store);
  await store.flush();
  assert.equal(fallback.gattName, 'Updated sensor');
  assert.deepEqual(store.devices(), []);
  assert.deepEqual(storage.value.records, []);
  const restored = create({ storage }); await restored.init();
  assert.deepEqual(restored.devices(), []);
  state.ble.addressType = 1;
  state.services[0].characteristics[0].valueHex = Buffer.from('Other identity').toString('hex');
  context.module.exports.rememberGattName(state, store);
  assert.equal(fallback.gattName, 'Updated sensor');
  assert.deepEqual(store.devices(), []);
});


test('selecting away and back stops a bulk read even before its pending request settles', () => {
  const h = harness();
  h.context.readSession = { key: key(devices[0]), stopped: false };
  vm.runInContext('selectDevice(fixtures[0]);', h.context);
  assert.equal(h.context.readSession.stopped, false);
  vm.runInContext('selectDevice(fixtures[1]); selectDevice(fixtures[0]);', h.context);
  assert.equal(h.context.readSession.stopped, true);
});

test('restored app targets preserve app navigation without requiring a current match', () => {
  const h = harness(); let opened = 0;
  h.context.NanoWorkspace.view = () => 'apps';
  h.context.NanoWorkspace.module = () => 'standard';
  h.context.NanoWorkspace.openDevice = () => opened++;
  h.context.NanoModules = { rememberTarget: () => false };
  vm.runInContext('selectDevice(fixtures[0], true)', h.context);
  assert.equal(opened, 0);
  assert.equal(h.selections.at(-1), devices[0]);
  vm.runInContext('selectDevice(fixtures[1])', h.context);
  assert.equal(opened, 1);
});
