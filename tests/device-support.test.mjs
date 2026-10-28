import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import library from '../web/device-library.js';
import values from '../web/gatt-values.js';
const source = readFileSync(new URL('../web/device-support.js', import.meta.url), 'utf8');
const device = { address: 'AA:BB:CC:DD:EE:01', addressType: 0, services: ['1809'] };
const initial = () => ({ ble: { ...device, connected: true, connectionAttempt: 7 }, services: [{ uuid: '180a', characteristics: [
  { uuid: '2a24', handle: 3, properties: ['read'] }, { uuid: '2a29', handle: 5, properties: ['read'] }
] }] });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function harness(options = {}) {
  let selected = device, state = initial(), online = true, pending = false, onState;
  const calls = [], connections = [], events = {}, started = deferred();
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.classList = { add() {} }; this.ownText = ''; }
    set textContent(value) { this.ownText = String(value); this.children = []; }
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; this.ownText = ''; }
    setAttribute() {}
    addEventListener(type, callback) { this.listeners[type] = callback; }
  }
  const container = new Element('section'), lab = {
    onState(callback) { onState = callback; callback(); },
    async action(path, body) { calls.push({ path, ...body }); started.resolve(); return options.action?.() ?? state; }
  };
  const context = { NanoDeviceLibrary: library, NanoGattValues: values, NanoRecipeLibrary: { get: () => null },
    NanoConnection: { snapshot: () => ({ selected, state, online, pending }), async ensure(target) { connections.push(target); return options.ensure?.() ?? state; } },
    document: { createElement: tag => new Element(tag), addEventListener: (type, callback) => { events[type] = callback; } }
  };
  vm.runInNewContext(source + '\nthis.support = NanoDeviceSupport;', context);
  const app = context.support.mount(container, 'thermometer', lab, { selected: () => selected });
  const nodes = []; const visit = node => { nodes.push(node); node.children.forEach(visit); }; visit(container);
  const read = nodes.find(node => node.tag === 'button' && node.textContent === 'Read device metadata');
  return { container, read, calls, connections, events, started: started.promise, get state() { return state; },
    update(next = state) { state = next; onState(); }, select(next) { selected = next; app.render(); },
    online(value) { online = value; onState(); }, pending(value) { pending = value; events['nanoscope:busy'](); } };
}
test('metadata reads complete on the same connection and accept address casing', async () => {
  const h = harness(); h.update({ ...h.state, ble: { ...h.state.ble, address: device.address.toLowerCase() } });
  await h.read.listeners.click();
  assert.deepEqual(h.calls, [{ path: 'read', handle: 3 }, { path: 'read', handle: 5 }]);
  assert.match(h.container.textContent, /Read 2 metadata values/);
});
test('metadata read stops after reconnect, offline transition or address-type change', async () => {
  for (const change of [
    h => h.update({ ...h.state, ble: { ...h.state.ble, connectionAttempt: 8 } }),
    h => { h.online(false); h.online(true); },
    h => h.update({ ...h.state, ble: { ...h.state.ble, addressType: 1 } })
  ]) {
    const wait = deferred(), h = harness({ action: () => wait.promise }), operation = h.read.listeners.click();
    await h.started;
    assert.equal(h.calls.length, 1); change(h); wait.resolve(); await operation;
    assert.equal(h.calls.length, 1); assert.match(h.container.textContent, /selected connection changed/);
    assert.doesNotMatch(h.container.textContent, /Read \d+ metadata values/);
  }
});
test('metadata completion does not overwrite another target and away-and-back cancels the batch', async () => {
  for (const back of [false, true]) {
    const wait = deferred(), h = harness({ action: () => wait.promise }), operation = h.read.listeners.click();
    await h.started;
    h.select({ ...device, addressType: 1 }); if (back) h.select(device);
    wait.resolve(); await operation;
    assert.equal(h.calls.length, 1); assert.doesNotMatch(h.container.textContent, /Read \d+ metadata values|Connecting and reading/);
  }
});
test('metadata controls reject busy, offline and USB controller state before connecting', async () => {
  for (const change of [h => { h.state.ble.busy = true; h.update(); }, h => h.pending(true), h => h.online(false), h => { h.state.usb = { mode: 'hci' }; h.update(); }]) {
    const h = harness(); change(h); assert.equal(h.read.disabled, true);
    await h.read.listeners.click(); assert.equal(h.connections.length, 0); assert.equal(h.calls.length, 0);
  }
});
test('metadata reads reject a stale ensure result and replaced handles', async () => {
  const wait = deferred(), h = harness({ ensure: () => wait.promise }), old = h.state, operation = h.read.listeners.click();
  h.update({ ...old, ble: { ...old.ble, connectionAttempt: 8 } }); wait.resolve(old); await operation;
  assert.equal(h.calls.length, 0); assert.match(h.container.textContent, /selected connection changed/);
  const readWait = deferred(), changed = harness({ action: () => readWait.promise }), reading = changed.read.listeners.click();
  await changed.started; changed.state.services[0].characteristics.pop(); readWait.resolve(); await reading;
  assert.equal(changed.calls.length, 1); assert.match(changed.container.textContent, /characteristic is no longer available/);
});
test('metadata reads accept an explicitly established connection and reject overlapping clicks', async () => {
  const wait = deferred(), h = harness({ ensure: () => wait.promise }); h.update({ ...h.state, ble: { ...h.state.ble, connected: false } });
  const operation = h.read.listeners.click(); await h.read.listeners.click();
  const connected = initial(); connected.ble.connectionAttempt = 8; h.update(connected); wait.resolve(connected); await operation;
  assert.equal(h.connections.length, 1); assert.equal(h.calls.length, 2); assert.match(h.container.textContent, /Read 2 metadata values/);
});
