import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import standard from '../web/standard-app.js';
import gatt from '../web/gatt-values.js';

const source = readFileSync(new URL('../web/standard-app.js', import.meta.url), 'utf8');
const device = { address: 'AA:BB:CC:DD:EE:01', addressType: 0, name: 'Fixture sensor', services: ['180d', '180f'] };
const characteristic = (uuid, handle, properties, valueHex = null) => ({ uuid, handle, properties, valueHex, subscription: 'off' });
const initial = () => ({ ble: { ...device, connected: true, busy: false, connectionAttempt: 7 }, services: [
  { uuid: '180d', characteristics: [characteristic('2a37', 3, ['read', 'notify'], '0048')] },
  { uuid: '180f', characteristics: [characteristic('2a19', 8, ['read'], '53')] }
] });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness({ state = initial(), target = device, online = true, action, ensure } = {}) {
  const calls = [], connections = [], events = new Map(); let onState, onEvents, acting = false;
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.classList = { add() {} }; this.ownText = ''; }
    set textContent(value) { this.ownText = String(value); this.children = []; }
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.ownText = ''; this.children = nodes; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    click() { return this.disabled ? undefined : this.listeners.click?.(); }
  }
  const container = new Element('section'), lab = {
    getState: () => state, isActing: () => acting,
    onState(callback) { onState = callback; callback(state, online); return () => { onState = null; }; },
    onEvents(callback) { onEvents = callback; return () => { onEvents = null; }; },
    async action(path, body) {
      calls.push({ path, ...JSON.parse(JSON.stringify(body)) });
      if (action) return action(path, body);
      if (path === 'subscribe') state.services.flatMap(service => service.characteristics).find(item => item.handle === body.handle).subscription = body.mode;
      onState?.(state, online); return state;
    }
  };
  const context = { NanoGattValues: gatt, NanoConnection: { async ensure(value) { connections.push(value); if (ensure) return ensure(value); state.ble = { ...state.ble, ...value, connected: true }; onState?.(state, online); return state; } },
    document: { createElement: tag => new Element(tag), createElementNS: (ns, tag) => new Element(tag),
      addEventListener: (type, callback) => events.set(type, callback), removeEventListener: type => events.delete(type) } };
  vm.runInNewContext(source + '\nthis.app = NanoStandardApp;', context);
  const app = context.app.mount(container, lab, { selected: () => target });
  const all = () => { const nodes = []; const visit = node => { nodes.push(node); node.children.forEach(visit); }; visit(container); return nodes; };
  return { app, container, calls, connections, all, lab,
    button: (label, index = 0) => all().filter(node => node.tag === 'button' && node.ownText === label)[index],
    select(value, render = true) { target = value; if (render) events.get('nanoscope:selection')?.(); },
    update(value, available = online) { state = value; online = available; onState?.(state, online); },
    events: meta => onEvents?.([], meta), acting(value) { acting = value; events.get('nanoscope:busy')?.(); },
    get state() { return state; }
  };
}

test('matches returns exact standard profiles through CommonJS and accepts Bluetooth base UUIDs', () => {
  for (const id of ['180d', '1816', '1818', '1814', '1809', '181a', '181d', '1822', '180f']) {
    for (const uuid of [id, `0x${id.toUpperCase()}`, `0000${id}-0000-1000-8000-00805F9B34FB`]) {
      const matches = standard.matches({ ...device, services: [uuid] });
      assert.equal(matches.length, 1); assert.equal(matches[0].uuid, id); assert.ok(matches[0].title);
    }
  }
  assert.deepEqual(standard.matches(null), []);
  for (const uuid of ['180d-vendor', '0000180d-1234-1000-8000-00805f9b34fb', 'a180d', '1810', 0x180d]) {
    assert.deepEqual(standard.matches({ ...device, name: 'Heart Rate Battery', services: [uuid] }), []);
  }
  assert.equal(standard.matches({ ...device, services: ['180f'], serviceData: [{ uuid: '180f' }] }).length, 1);
  assert.equal(standard.matches({ ...device, services: [], serviceData: [{ uuid: '181a' }] })[0].uuid, '181a');
});

test('discovered profiles require both connected address and address type', () => {
  const selected = { ...device, services: [] }, state = initial();
  assert.equal(standard.matches(selected, state).length, 2);
  assert.equal(standard.matches({ ...selected, address: selected.address.toLowerCase() }, state).length, 2);
  for (const ble of [{ connected: false }, { addressType: 1 }, { address: 'AA:BB:CC:DD:EE:02' }, { addressType: undefined }]) {
    assert.deepEqual(standard.matches(selected, { ...state, ble: { ...state.ble, ...ble } }), []);
  }
});

test('viewing displays decoded measurements and measured visuals without BLE actions', () => {
  const h = harness(); h.app.render(device, h.state);
  assert.match(h.container.textContent, /Heart rate \(0x180d\)/); assert.match(h.container.textContent, /72 bpm/); assert.match(h.container.textContent, /83%/);
  const meter = h.all().find(node => node.tag === 'meter'); assert.equal(meter.value, 83); assert.equal(meter.max, 100);
  assert.equal(h.all().filter(node => node.tag === 'svg').length, 1);
  assert.deepEqual(h.calls, []); assert.deepEqual(h.connections, []);
  h.state.services[0].characteristics[0].valueHex = '0064'; h.update(h.state);
  assert.match(h.container.textContent, /100 bpm/); assert.doesNotMatch(h.container.textContent, /72 bpm/); assert.deepEqual(h.calls, []);
});

test('absent, reserved and malformed readings do not create battery or heart visuals', () => {
  const h = harness();
  for (const valueHex of [null, 'ff', '65', 'zz']) {
    h.state.services[1].characteristics[0].valueHex = valueHex; h.state.services[0].characteristics[0].valueHex = '00'; h.update(h.state);
    assert.equal(h.all().filter(node => ['meter', 'svg'].includes(node.tag)).length, 0);
  }
  h.state.services[1].characteristics[0].valueHex = '00'; h.update(h.state);
  assert.equal(h.all().find(node => node.tag === 'meter').value, 0);
});

test('Read addresses one characteristic and Subscribe and Stop use supported modes explicitly', async () => {
  const h = harness();
  await h.button('Read', 1).click(); assert.deepEqual(h.calls, [{ path: 'read', handle: 8 }]);
  assert.equal(h.button('Stop').disabled, true); await h.button('Subscribe').click();
  assert.equal(h.button('Subscribe').disabled, true); assert.equal(h.button('Stop').disabled, false);
  await h.button('Stop').click();
  h.state.services[0].characteristics[0].properties = ['indicate']; h.update(h.state); await h.button('Subscribe').click();
  assert.deepEqual(h.calls.slice(1), [{ path: 'subscribe', handle: 3, mode: 'notify' }, { path: 'subscribe', handle: 3, mode: 'off' }, { path: 'subscribe', handle: 3, mode: 'indicate' }]);
  assert.equal(h.connections.length, 0); assert.equal(h.button('Read', 1), undefined);
});

test('Connect alone calls ensure for the selected device without reading or subscribing', async () => {
  const state = initial(); state.ble.connected = false; const h = harness({ state });
  assert.deepEqual(h.connections, []); assert.doesNotMatch(h.container.textContent, /72 bpm/);
  await h.button('Connect').click(); assert.equal(h.connections[0], device); assert.deepEqual(h.calls, []);
  assert.match(h.container.textContent, /Connected\./);
});

test('stale read, subscribe, stop and connect handlers cannot act on a new selection', async () => {
  for (const label of ['Read', 'Subscribe', 'Stop', 'Connect']) {
    const state = initial(); state.services[0].characteristics[0].subscription = label === 'Stop' ? 'notify' : 'off'; state.ble.connected = label !== 'Connect';
    const h = harness({ state }), click = h.button(label).listeners.click;
    h.select({ ...device, addressType: 1 }, false); await click();
    assert.deepEqual(h.calls, []); assert.deepEqual(h.connections, []); assert.doesNotMatch(h.container.textContent, /72 bpm/);
  }
});

test('handlers fail after reconnect, offline, reboot and away-and-back selection', async () => {
  for (const change of [
    h => h.update({ ...h.state, ble: { ...h.state.ble, connectionAttempt: 8 } }),
    h => { h.update(h.state, false); h.update(h.state, true); },
    h => { h.events({ bootId: 'old' }); h.events({ bootId: 'new' }); h.update(h.state); },
    h => { h.select({ ...device, address: 'AA:BB:CC:DD:EE:02' }); h.select(device); },
    h => { h.update({ ...h.state, ble: { ...h.state.ble, connected: false } }); h.update(initial()); }
  ]) {
    const h = harness(), click = h.button('Read').listeners.click; change(h); await click();
    assert.deepEqual(h.calls, []); assert.doesNotMatch(h.container.textContent, /Read complete/);
  }
});

test('characteristic replacement, lost properties and invalid handles reject retained handlers', async () => {
  for (const change of [item => { item.uuid = '2a19'; }, item => { item.handle = 12; }, item => { item.properties = []; }]) {
    const h = harness(), click = h.button('Read').listeners.click; change(h.state.services[0].characteristics[0]); await click(); assert.deepEqual(h.calls, []);
  }
  const state = initial(); state.services[0].characteristics[0].handle = 0; const h = harness({ state });
  assert.equal(h.button('Read').disabled, true); await h.button('Read').listeners.click(); assert.deepEqual(h.calls, []);
});

test('unavailable boards and busy operations disable controls and reject retained handlers', async () => {
  for (const change of [h => h.update(h.state, false), h => h.acting(true), h => { h.state.ble.busy = true; h.update(h.state); }]) {
    const h = harness(), click = h.button('Read').listeners.click; change(h); await click(); assert.deepEqual(h.calls, []);
    assert.ok(h.all().filter(node => node.tag === 'button').every(node => node.disabled));
  }
  for (const update of [state => { state.usb = { mode: 'hci' }; }, state => { state.ble.connected = false; }]) {
    const state = initial(); state.ble.connected = false; update(state); const h = harness({ state, target: { ...device, connectable: false } });
    assert.equal(h.button('Connect').disabled, true); await h.button('Connect').listeners.click(); assert.deepEqual(h.connections, []);
  }
});

test('pending actions keep controls busy and discard results after a target change', async () => {
  const pending = deferred(), h = harness({ action: () => pending.promise }), click = h.button('Read').listeners.click;
  const operation = click(); await click(); assert.equal(h.calls.length, 1);
  assert.ok(h.all().filter(node => node.tag === 'button').every(node => node.disabled));
  h.select({ ...device, address: 'AA:BB:CC:DD:EE:02' }); pending.resolve(initial()); await operation;
  assert.equal(h.calls.length, 1); assert.doesNotMatch(h.container.textContent, /Read complete|72 bpm|83%/);
});

test('read failures surface and stale completions fail on a new connection scope', async () => {
  const failure = harness({ action: () => Promise.reject(new Error('Encryption required.')) }); await failure.button('Read').click();
  assert.match(failure.container.textContent, /Encryption required/); assert.equal(failure.button('Read').disabled, false);
  const pending = deferred(), h = harness({ action: () => pending.promise }), operation = h.button('Read').click();
  h.update({ ...h.state, ble: { ...h.state.ble, connectionAttempt: 8 } }); pending.resolve(h.state); await operation;
  assert.match(h.container.textContent, /selected device or connection changed/); assert.doesNotMatch(h.container.textContent, /Read complete/);
});

test('destroy removes listeners and blocks retained handlers', async () => {
  const h = harness(), click = h.button('Read').listeners.click; h.app.destroy(); await click(); assert.deepEqual(h.calls, []);
});

test('undecoded bytes stay collapsed and empty characteristics show actionable controls', () => {
  const state = initial(); state.services[0].characteristics[0].uuid = 'abcd'; state.services[1].characteristics[0].valueHex = null;
  const h = harness({ state }), details = h.all().filter(node => node.tag === 'details');
  assert.equal(details.length, 1); assert.equal(details[0].children[0].textContent, 'Raw bytes'); assert.notEqual(details[0].open, true);
  assert.match(details[0].textContent, /0048/); assert.equal(h.all().filter(node => node.tag === 'dl').length, 0);
  assert.doesNotMatch(h.container.textContent, /No decoded|No reading|No captured|72 bpm/);
  assert.equal(h.button('Read', 1).disabled, false); assert.equal(h.button('Subscribe').disabled, false); assert.deepEqual(h.calls, []);
});
