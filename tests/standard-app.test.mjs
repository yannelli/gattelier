import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import standard from '../web/standard-app.js';
import gatt from '../web/gatt-values.js';

const source = readFileSync(new URL('../web/standard-app.js', import.meta.url), 'utf8');
const sharedSource = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const focusHelper = sharedSource.slice(sharedSource.indexOf('function replacePreservingFocus('), sharedSource.indexOf('\nfunction empty('));
const device = { address: 'AA:BB:CC:DD:EE:01', addressType: 0, name: 'Fixture sensor', services: ['180d', '180f'] };
const characteristic = (uuid, handle, properties, valueHex = null) => ({ uuid, handle, properties, valueHex, subscription: 'off' });
const initial = () => ({ ble: { ...device, connected: true, busy: false, connectionAttempt: 7 }, services: [
  { uuid: '180d', characteristics: [characteristic('2a37', 3, ['read', 'notify'], '0048')] },
  { uuid: '180f', characteristics: [characteristic('2a19', 8, ['read'], '53')] }
] });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness({ state = initial(), target = device, online = true, action, ensure, displayName } = {}) {
  const calls = [], connections = [], events = new Map(); let onState, onEvents, acting = false;
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.open = false; this.classList = { add() {} }; this.ownText = ''; }
    set textContent(value) { this.ownText = String(value); this.children = []; }
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
    append(...nodes) { this.children.push(...nodes.flatMap(node => node.tag === 'fragment' ? node.children.splice(0) : [node])); }
    replaceChildren(...nodes) { if (this.contains(document.activeElement)) document.activeElement = null; this.ownText = ''; this.children = []; this.append(...nodes); }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    focus() { if (!this.disabled) document.activeElement = this; }
    querySelectorAll(selector) {
      const nodes = [], visit = node => { nodes.push(node); node.children.forEach(visit); }; this.children.forEach(visit);
      return nodes.filter(node => selector === '[data-focus]' ? node.dataset.focus !== undefined
        : selector === 'details[data-persist]' ? node.tag === 'details' && node.dataset.persist !== undefined
        : selector === 'details[open][data-persist]' ? node.tag === 'details' && node.open && node.dataset.persist !== undefined : false);
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    click() { return this.disabled ? undefined : this.listeners.click?.(); }
  }
  const document = { activeElement: null, createElement: tag => new Element(tag), createElementNS: (ns, tag) => new Element(tag), createDocumentFragment: () => new Element('fragment'),
    addEventListener: (type, callback) => events.set(type, callback), removeEventListener: type => events.delete(type) };
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
    document, replacePreservingFocus: vm.runInNewContext(`(${focusHelper})`, { document }) };
  if (displayName) context.deviceDisplayName = displayName;
  vm.runInNewContext(source + '\nthis.app = NanoStandardApp;', context);
  const app = context.app.mount(container, lab, { selected: () => target });
  const all = () => { const nodes = []; const visit = node => { nodes.push(node); node.children.forEach(visit); }; visit(container); return nodes; };
  return { app, container, calls, connections, all, lab, document,
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

test('idle state refresh preserves action and Raw bytes focus and disclosure', () => {
  for (const label of ['Read', 'Subscribe', 'Stop', 'Raw bytes']) {
    const state = initial(); if (label === 'Stop') state.services[0].characteristics[0].subscription = 'notify';
    const h = harness({ state }), raw = h.all().find(node => node.tag === 'details'); raw.open = true;
    const control = label === 'Raw bytes' ? raw.children[0] : h.button(label), focusKey = control.dataset.focus; control.focus();
    for (let poll = 0; poll < 2; poll++) {
      h.update(structuredClone(h.state));
      assert.equal(h.document.activeElement, h.all().find(node => node.dataset.focus === focusKey));
      assert.ok(h.container.contains(h.document.activeElement));
      assert.equal(h.all().find(node => node.tag === 'details').open, true);
      assert.equal(h.all().filter(node => node.tag === 'details')[1].open, false);
    }
    assert.deepEqual(h.calls, []); assert.deepEqual(h.connections, []);
  }
});

test('idle state refresh preserves Connect and Switch and connect focus', () => {
  for (const connected of [false, true]) {
    const state = initial(); state.ble.connected = connected;
    const h = harness({ state, target: connected ? { ...device, addressType: 1 } : device }), label = connected ? 'Switch and connect' : 'Connect';
    h.button(label).focus(); h.update(structuredClone(h.state));
    assert.equal(h.document.activeElement, h.button(label)); assert.ok(h.container.contains(h.document.activeElement));
    assert.deepEqual(h.calls, []); assert.deepEqual(h.connections, []);
  }
});

test('focus and Raw bytes follow characteristic handles through reordering and normalized identities', () => {
  const state = initial(); state.services[0].characteristics.push(characteristic('2a37', 11, ['read', 'notify'], '0050'));
  const h = harness({ state }), raw = h.all().filter(node => node.tag === 'details')[1], read = h.button('Read', 1);
  raw.open = true; read.focus();
  h.select({ ...device, address: device.address.toLowerCase() }, false);
  state.services[0].uuid = '0000180D-0000-1000-8000-00805F9B34FB';
  state.services[0].characteristics[1].uuid = '0x2A37';
  state.services[0].characteristics.reverse(); state.services.reverse(); h.update(structuredClone(state));
  assert.equal(h.document.activeElement, h.all().find(node => node.dataset.focus === read.dataset.focus));
  assert.ok(h.container.contains(h.document.activeElement));
  const details = h.all().filter(node => node.tag === 'details');
  assert.deepEqual(details.filter(node => node.open).map(node => node.dataset.persist), [raw.dataset.persist]);
  const keys = h.all().filter(node => node.dataset.focus !== undefined).map(node => node.dataset.focus);
  assert.equal(new Set(keys).size, keys.length); assert.deepEqual(h.calls, []); assert.deepEqual(h.connections, []);
});

test('focus and Raw bytes do not transfer to another device, service, UUID or handle', () => {
  for (const change of [
    h => { const target = { ...device, addressType: 1 }; h.select(target, false); h.update({ ...h.state, ble: { ...h.state.ble, ...target } }); },
    h => { const target = { ...device, address: 'AA:BB:CC:DD:EE:02' }; h.select(target, false); h.update({ ...h.state, ble: { ...h.state.ble, ...target } }); },
    h => { h.state.services[0].uuid = '181a'; h.update(h.state); },
    h => { h.state.services[0].characteristics[0].uuid = '2a19'; h.update(h.state); },
    h => { h.state.services[0].characteristics[0].handle = 12; h.update(h.state); }
  ]) {
    const h = harness(); h.all().find(node => node.tag === 'details').open = true; h.button('Read').focus(); change(h);
    assert.equal(h.document.activeElement, null);
    assert.ok(h.all().filter(node => node.tag === 'details').every(node => !node.open));
    assert.deepEqual(h.calls, []); assert.deepEqual(h.connections, []);
  }
});

test('context uses trimmed label, advertised name, remembered GATT name and shared display naming', () => {
  for (const [names, expected] of [
    [{ label: ' Local label ', name: 'Advertised', gattName: 'Remembered' }, 'Local label'],
    [{ label: ' ', name: ' Advertised ', gattName: 'Remembered' }, 'Advertised'],
    [{ label: ' ', name: '', gattName: ' Remembered ' }, 'Remembered'],
    [{ label: '', name: ' ', gattName: '' }, device.address]
  ]) {
    const h = harness({ target: { ...device, ...names } });
    assert.equal(h.container.children[1].children[0].textContent, `${expected} (${device.address}, type 0)`);
  }
  const target = { ...device, gattName: 'Learned sensor' }, calls = [];
  const h = harness({ target, displayName: value => { calls.push(value); return `Shared ${value.gattName}`; } });
  assert.equal(h.container.children[1].children[0].textContent, `Shared Learned sensor (${device.address}, type 0)`);
  target.gattName = 'Updated sensor'; h.update(h.state);
  assert.equal(h.container.children[1].children[0].textContent, `Shared Updated sensor (${device.address}, type 0)`);
  assert.ok(calls.length > 0 && calls.every(value => value === target));
  assert.deepEqual(h.calls, []); assert.deepEqual(h.connections, []);
});
