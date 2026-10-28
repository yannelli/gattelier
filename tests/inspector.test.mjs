import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import values from '../web/gatt-values.js';
import library from '../web/device-library.js';
import profiles from '../web/profiles.js';
import vendors from '../web/vendors.js';
import ui from '../web/app.js';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.ownText = ''; this.open = false; }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute() {}
  addEventListener(name, callback) { this.listeners[name] = callback; }
  click() { if (!this.disabled) return this.listeners.click?.(); }
}
const all = root => [root, ...root.children.flatMap(all)];
const target = { address: 'AA:BB:CC:DD:EE:01', addressType: 0, name: 'Fixture', rssi: -50, connectable: true };
const characteristic = { uuid: '2a19', handle: 3, properties: ['read', 'notify'], valueHex: '53', valueText: 'S', subscription: 'off' };
function harness() {
  const calls = [], node = (tag, cls = '', text) => { const el = new Element(tag); el.className = cls; if (text !== undefined) el.textContent = text; return el; };
  const context = vm.createContext({
    node, console, NanoGattValues: values, NanoDeviceLibrary: library, NanoProfiles: profiles, vendorTools: vendors,
    NanoConsole: { characteristicActions: () => node('div'), advertisement: () => node('div') },
    NanoMetadata: { lookup: () => null }, NanoCatalogs: { match: () => [] },
    NanoConnection: { controls: () => node('div') }, NanoModules: { matches: () => [], catalog: [] }, NanoRecorders: { identify: () => null },
    NanoInsights: { age: () => 'Now', profileCard: profile => node('div', '', profile.title) },
    vendorDatabase: null, vendorStatus: 'ready', online: true, pending: false, notice: '',
    shortUuid: ui.shortUuid, uuidName: ui.uuidName, canRead: ui.canRead, deviceKey: ui.deviceKey, lastSeenLabel: ui.lastSeenLabel,
    selectedDevice: () => target, render() {},
    metadata: (label, value) => node('div', '', `${label}: ${value}`),
    button(label, cls, action, disabled, key) { const el = node('button', cls, label); el.disabled = disabled; el.dataset.focus = key; el.addEventListener('click', action); return el; },
    mutate: (action, body) => calls.push({ action, ...body }),
    state: { devices: [target], ble: { ...target, connected: true }, services: [{ uuid: '180f', characteristics: [structuredClone(characteristic)] }] }
  });
  vm.runInContext(readFileSync(new URL('../web/inspector.js', import.meta.url), 'utf8'), context);
  return { context, calls, run: source => vm.runInContext(source, context) };
}

test('inspection renders decoded fields before collapsed raw data without placeholder hints', () => {
  const h = harness(), tree = h.run('renderCharacteristic(state.services[0].characteristics[0], "180f")');
  const decoded = tree.children.findIndex(item => item.className === 'metadata');
  const raw = tree.children.findIndex(item => item.tag === 'details' && item.className.includes('value'));
  assert.ok(decoded >= 0 && decoded < raw);
  assert.match(tree.children[decoded].textContent, /83%/);
  assert.equal(tree.children[raw].open, false);
  assert.match(tree.children[raw].dataset.persist, /AA:BB:CC:DD:EE:01\/0-3/);
  assert.doesNotMatch(tree.textContent, /No matching value decoder|supplemental definitions|commands are not decoded/);
  assert.deepEqual(h.calls, []);
});

test('GATT results remain above advertisement details and inaccessible for another address type', () => {
  const h = harness(), tree = h.run('buildDeviceDetail(selectedDevice())');
  const service = tree.children.findIndex(item => item.className === 'service');
  const advertisement = tree.children.findIndex(item => item.dataset.persist?.startsWith('advertisement-'));
  assert.ok(service >= 0 && service < advertisement);
  assert.ok(tree.children[service].dataset.collapse.includes('/0-'));
  h.context.state.ble.addressType = 1;
  const other = h.run('buildDeviceDetail(selectedDevice())');
  assert.equal(all(other).some(item => item.className === 'service'), false);
  assert.doesNotMatch(other.textContent, /83%|Available commands/);
  assert.deepEqual(h.calls, []);
});

test('suggested Read and Subscribe use discovered handles and reject stale connection controls', () => {
  const h = harness(), tree = h.run('suggestedActions(selectedDevice())');
  const read = all(tree).find(item => item.tag === 'button' && item.textContent === 'Read battery level');
  const subscribe = all(tree).find(item => item.tag === 'button' && item.textContent.startsWith('Subscribe'));
  read.click(); subscribe.click();
  assert.deepEqual(h.calls, [{ action: 'read', handle: 3 }, { action: 'subscribe', handle: 3, mode: 'notify' }]);
  h.context.state.ble.addressType = 1; read.click(); subscribe.click();
  assert.equal(h.calls.length, 2);
});

test('identity summary omits placeholders and keeps a real zero battery value', () => {
  const h = harness();
  h.context.state.services[0].characteristics.push({ uuid: '2a23', valueHex: '00'.repeat(8) }, { uuid: '2a28', valueHex: Buffer.from('Software Revision').toString('hex') });
  h.context.state.services[0].characteristics[0].valueHex = '00';
  const fields = JSON.parse(JSON.stringify(h.run('identityFields(state.services)')));
  assert.deepEqual(fields, [{ label: 'Battery level', value: '0%' }]);
});

test('bulk reads stop when address type changes and do not initiate pairing', async () => {
  const h = harness();
  h.context.state.services[0].characteristics.push({ uuid: '2a00', handle: 7, properties: ['read'] });
  h.context.NanoLab = { async action(action, body) { h.calls.push({ action, ...body }); h.context.state.ble.addressType = 1; } };
  await h.run('readAllValues()');
  assert.deepEqual(h.calls, [{ action: 'read', handle: 3 }]);
});
