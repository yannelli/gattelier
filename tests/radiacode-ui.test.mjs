import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../web/radiacode.js', import.meta.url), 'utf8');
const device = { address: 'AA:BB:CC:DD:EE:01', addressType: 1, name: 'RadiaCode' };
const ready = (ble = {}) => ({ ble: { ...device, connected: true, connectionAttempt: 1, ...ble } });
const reading = (kind = 'measurements') => ({ kind, fields: [{ label: 'Measurement records', value: 1 }, { label: 'Count rate', value: '12.5 cps' }], records: [{}], counts: [1], energiesKeV: [0.5], totalCounts: 1 });
const flush = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {}; this.text = ''; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(' '); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.text = ''; this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
}
function fixture(t, initial = ready()) {
  const listeners = new Map(), globals = new Map(), states = new Set(), timers = new Map(), reads = [], stops = [];
  let state = initial, selected = device, online = true, active = true, busy = false, timerId = 0;
  let reply = () => reading(), ensure = async () => state, confirm = () => true;
  const add = (map, type, callback) => { if (!map.has(type)) map.set(type, new Set()); map.get(type).add(callback); };
  const emit = (map, type) => { for (const callback of map.get(type) || []) callback(); };
  const document = {
    hidden: false, createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag),
    addEventListener: (type, callback) => add(listeners, type, callback),
    removeEventListener: (type, callback) => listeners.get(type)?.delete(callback),
  };
  const connection = { snapshot: () => ({ state, selected, online, pending: false }), ensure: target => ensure(target) };
  const context = vm.createContext({
    document, NanoRadiaCodeProtocol: {},
    NanoNotifyClient: { create: () => ({
      async run(target) { reads.push(target); busy = true; try { await connection.ensure(target); return await reply(); } finally { busy = false; } },
      busy: () => busy, fail: message => stops.push(message), close: () => {},
    }) },
    addEventListener: (type, callback) => add(globals, type, callback),
    removeEventListener: (type, callback) => globals.get(type)?.delete(callback),
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(source + '\nglobalThis.reader = NanoRadiaCode;', context);
  const root = new Element('div');
  const app = context.reader.mount(root, {
    onState(callback) { states.add(callback); callback(state, online); return () => states.delete(callback); },
  }, { connection, getDevice: () => selected, isActive: () => active, confirm: () => confirm() });
  t.after(() => app.destroy());
  const all = (node = root) => [node, ...node.children.flatMap(child => all(child))];
  const find = cls => all().find(node => node.className?.split(' ').includes(cls));
  const button = label => all().find(node => node.tagName === 'button' && node.textContent === label);
  return {
    app, root, reads, stops, timers, states, globals, find, button, document,
    get state() { return state; },
    update(next, available = true, notify = true) { state = next; online = available; if (notify) for (const callback of states) callback(state, online); },
    select(next, notify = true) { selected = next; if (notify) emit(listeners, 'nanoscope:selection'); },
    leave(hidden = false, notify = true) { if (hidden) document.hidden = true; else active = false; if (notify) emit(listeners, hidden ? 'visibilitychange' : 'nanoscope:workspace'); },
    changeBoard() { emit(globals, 'nanoscope:api-change'); },
    replyWith(callback) { reply = callback; }, ensureWith(callback) { ensure = callback; }, confirmWith(callback) { confirm = callback; },
    async tick() { const [id, callback] = timers.entries().next().value; timers.delete(id); await callback(); },
  };
}
function empty(f) {
  assert.equal(f.find('radiacode-results').children.length, 0);
  assert.equal(f.find('radiacode-empty').hidden, false);
}

test('RadiaCode UI retains readings through normalized selection and ordinary state updates', async t => {
  const f = fixture(t);
  f.replyWith(() => reading('identity')); await f.app.read('identity');
  f.select({ ...device, address: device.address.toLowerCase() });
  f.update(ready({ busy: true, operation: 'read' }));
  assert.ok(f.find('radiacode-result-identity'));
  assert.match(f.find('radiacode-device').textContent, /Connected/);
  assert.deepEqual(f.stops, []);
});

for (const notify of [true, false]) {
  test(`RadiaCode UI clears same-MAC address-type selections with selection event ${notify}`, async t => {
    const f = fixture(t), pending = deferred();
    await f.app.read('measurements');
    f.replyWith(() => pending.promise);
    const operation = f.app.read('measurements'); await flush();
    f.select({ ...device, addressType: 0 }, notify);
    pending.resolve(reading()); await operation;
    empty(f);
    assert.doesNotMatch(f.find('radiacode-device').textContent, /Connected/);
    assert.doesNotMatch(f.find('radiacode-status').textContent, /updated/);
  });
}

const disruptions = [
  ['address type', f => f.update(ready({ addressType: 0 }))],
  ['connection attempt', f => f.update(ready({ connectionAttempt: 2 }))],
  ['disconnect', f => f.update(ready({ connected: false }))],
  ['offline', f => f.update(f.state, false)],
  ['API change with unchanged device and scope', f => f.changeBoard()],
];
for (const [name, disrupt] of disruptions) {
  for (const failed of [false, true]) {
    test(`RadiaCode UI clears readings and discards late ${failed ? 'failure' : 'success'} after ${name}`, async t => {
      const f = fixture(t), pending = deferred();
      await f.app.read('measurements');
      f.replyWith(() => pending.promise);
      const operation = f.app.read('measurements'); await flush();
      disrupt(f); empty(f);
      if (failed) pending.reject(new Error('Old read failed.')); else pending.resolve(reading());
      await operation; empty(f);
      assert.doesNotMatch(f.find('radiacode-status').textContent, /updated|Old read failed/);
      assert.equal(f.stops.length, 1);
    });
  }
}

const liveDisruptions = [
  ['same-MAC selection', f => f.select({ ...device, addressType: 0 })],
  ...disruptions,
  ['leaving app', f => f.leave()],
  ['hiding page', f => f.leave(true)],
  ['silent selection', f => f.select({ ...device, addressType: 0 }, false)],
  ['silent replacement', f => f.update(ready({ connectionAttempt: 2 }), true, false)],
  ['inactive workspace', f => f.leave(false, false)],
  ['hidden document', f => f.leave(true, false)],
];
for (const [name, disrupt] of liveDisruptions) {
  test(`RadiaCode UI live measurements stop before spectrum after ${name}`, async t => {
    const f = fixture(t), pending = deferred();
    f.replyWith(() => pending.promise);
    const operation = f.button('Start live').listeners.click(); await flush();
    assert.equal(f.reads.length, 1);
    disrupt(f); pending.resolve(reading()); await operation;
    empty(f);
    assert.equal(f.reads.length, 1);
    assert.ok(f.button('Start live'));
    assert.equal(f.timers.size, 0);
  });
}

for (const hidden of [false, true]) {
  for (const notify of [false, true]) {
    test(`RadiaCode UI discards late spectrum after leaving hidden=${hidden} event=${notify}`, async t => {
      const f = fixture(t), pending = deferred();
      f.replyWith(() => f.reads.length === 1 ? reading() : pending.promise);
      const operation = f.button('Start live').listeners.click(); await flush();
      assert.equal(f.reads.length, 2);
      assert.ok(f.find('radiacode-result-measurements'));
      f.leave(hidden, notify); pending.resolve(reading('spectrum')); await operation;
      assert.equal(f.find('radiacode-result-spectrum'), undefined);
      assert.equal(f.reads.length, 2);
      assert.ok(f.button('Start live'));
      assert.equal(f.timers.size, 0);
    });
  }
}

test('RadiaCode UI live errors use the current selection', async t => {
  const f = fixture(t), pending = deferred();
  f.replyWith(() => pending.promise);
  const operation = f.button('Start live').listeners.click(); await flush();
  f.select({ ...device, addressType: 0 }, false);
  pending.reject(new Error('Old live read failed.')); await operation;
  assert.equal(f.find('radiacode-status').textContent, '');
  assert.equal(f.reads.length, 1);
  f.replyWith(() => { throw new Error('Current live read failed.'); });
  await f.button('Start live').listeners.click();
  assert.equal(f.find('radiacode-status').textContent, 'Current live read failed.');
});

test('RadiaCode UI live timer stops before reading from an inactive workspace', async t => {
  const f = fixture(t);
  f.replyWith(() => reading(f.reads.length % 2 ? 'measurements' : 'spectrum'));
  await f.button('Start live').listeners.click();
  assert.equal(f.timers.size, 1);
  f.leave(false, false); await f.tick();
  assert.equal(f.reads.length, 2);
  assert.equal(f.timers.size, 0);
  assert.ok(f.button('Start live'));
});

for (const hidden of [false, true]) {
  test(`RadiaCode UI discards a manual read after leaving hidden=${hidden}`, async t => {
    const f = fixture(t), pending = deferred();
    f.replyWith(() => pending.promise);
    const operation = f.app.read('measurements'); await flush();
    f.leave(hidden); pending.resolve(reading()); await operation;
    empty(f);
    assert.doesNotMatch(f.find('radiacode-status').textContent, /updated/);
  });
}

for (const initial of [ready({ connected: false }), ready({ addressType: 0 }), ready({ address: '11:22:33:44:55:66' })]) {
  test(`RadiaCode UI accepts ensure transition from ${JSON.stringify(initial.ble)}`, async t => {
    const f = fixture(t, initial);
    assert.doesNotMatch(f.find('radiacode-device').textContent, /Connected/);
    f.ensureWith(async () => {
      f.select({ ...device, address: device.address.toLowerCase() });
      f.update(ready({ connected: false, busy: true, connectionAttempt: 2 }));
      f.update(ready({ connectionAttempt: 2 }));
      return f.state;
    });
    await f.app.read('measurements');
    assert.ok(f.find('radiacode-result-measurements'));
    assert.equal(f.find('radiacode-status').textContent, 'Measurements updated.');
    assert.deepEqual(f.stops, []);
  });
}

test('RadiaCode UI checks address type again after dose reset confirmation', async t => {
  const f = fixture(t);
  f.confirmWith(() => { f.select({ ...device, addressType: 0 }, false); return true; });
  await f.button('Reset dose').listeners.click();
  assert.equal(f.reads.length, 0);
});

test('RadiaCode UI discards a dose reset reply after a board change', async t => {
  const f = fixture(t), pending = deferred();
  f.replyWith(() => pending.promise);
  const operation = f.button('Reset dose').listeners.click(); await flush();
  f.changeBoard(); pending.resolve(reading('resetDose')); await operation;
  empty(f);
  assert.doesNotMatch(f.find('radiacode-status').textContent, /acknowledged/);
});

test('RadiaCode UI destroy removes listeners and blocks late live replies', async t => {
  const f = fixture(t), pending = deferred();
  f.replyWith(() => pending.promise);
  const operation = f.button('Start live').listeners.click(); await flush();
  f.app.destroy(); pending.resolve(reading()); await operation;
  empty(f);
  assert.equal(f.reads.length, 1);
  assert.equal(f.states.size, 0);
  assert.equal(f.globals.get('nanoscope:api-change').size, 0);
  assert.equal(f.timers.size, 0);
});
