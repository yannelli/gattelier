import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../web/sleep-mcr.js', import.meta.url), 'utf8');
const device = { address: 'aa:bb:cc:dd:ee:ff', addressType: 0 };
const ready = (ble = {}) => ({ ble: { ...device, connected: true, busy: false, connectionAttempt: 7, ...ble }, services: [] });
const result = { kind: 'firmness', fields: [{ label: 'Left firmness value', value: 50 }, { label: 'Right firmness value', value: 60 }] };
const flush = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(initial = ready()) {
  let state = initial, selected = device, online = true, pending = false, running = false, closed = 0;
  let ensure = async () => state, read = async () => result;
  const elements = [], calls = [], stops = [], stateListeners = new Set(), events = new Map(), globalEvents = new Map();
  const add = (listeners, type, callback) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(callback);
  };
  const emit = (listeners, type) => { for (const callback of listeners.get(type) || []) callback(); };
  const createElement = tag => {
    const element = {
      tag, children: [], handlers: {}, textContent: '', disabled: false, hidden: false,
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      insertAdjacentHTML() {}, setAttribute() {},
      addEventListener(type, callback) { this.handlers[type] = callback; },
    };
    elements.push(element); return element;
  };
  const connection = {
    snapshot: () => ({ state, selected, online, pending }),
    ensure: target => ensure(target),
  };
  const context = vm.createContext({
    NanoSleepMcrProtocol: {}, NanoConnection: connection,
    NanoAPI: { scope: () => 'usb' },
    NanoNotifyClient: { create: () => ({
      async run(target) {
        calls.push(target); running = true;
        try { await connection.ensure(target); return await read(target); }
        finally { running = false; }
      },
      busy: () => running,
      fail: message => stops.push(message),
      close() { closed++; },
    }) },
    document: {
      createElement,
      addEventListener: (type, callback) => add(events, type, callback),
      removeEventListener: (type, callback) => events.get(type)?.delete(callback),
    },
    addEventListener: (type, callback) => add(globalEvents, type, callback),
    removeEventListener: (type, callback) => globalEvents.get(type)?.delete(callback),
  });
  vm.runInContext(source + '\nglobalThis.app = NanoSleepMcr;', context);
  const app = context.app.mount(createElement('section'), {
    onState(callback) { stateListeners.add(callback); callback(state, online); return () => stateListeners.delete(callback); },
  });
  return {
    app, calls, stops,
    result: elements.find(element => element.tag === 'dl'),
    status: elements.find(element => element.tag === 'p'),
    button: label => elements.find(element => element.tag === 'button' && element.textContent === label),
    readWith(callback) { read = callback; },
    ensureWith(callback) { ensure = callback; },
    update(next, available = online) {
      state = next; online = available;
      for (const callback of stateListeners) callback(state, online);
    },
    select(target, notify = true) { selected = target; if (notify) emit(events, 'nanoscope:selection'); },
    apiChange() { emit(globalEvents, 'nanoscope:api-change'); },
    busy(value) { pending = value; emit(events, 'nanoscope:busy'); },
    get closed() { return closed; },
    listenerCount: () => stateListeners.size + [...events.values(), ...globalEvents.values()].reduce((count, listeners) => count + listeners.size, 0),
  };
}

const changes = [
  ['selected address type', f => f.select({ ...device, addressType: 1 })],
  ['selection away and back', f => { f.select({ ...device, address: '00:11:22:33:44:55' }); f.select(device); }],
  ['connected address type', f => f.update(ready({ addressType: 1 }))],
  ['connection attempt', f => f.update(ready({ connectionAttempt: 8 }))],
  ['disconnect', f => f.update(ready({ connected: false }))],
  ['offline board', f => f.update(ready(), false)],
  ['API board change within the same USB scope', f => f.apiChange()],
];

test('mounting stays idle and an explicit read displays firmness', async () => {
  const f = fixture();
  assert.equal(f.calls.length, 0);
  assert.equal(f.result.children.length, 0);
  assert.equal(await f.app.read(), result);
  assert.deepEqual(f.result.children.map(row => row.children[1].textContent), [50, 60]);
  assert.match(f.status.textContent, /^Read completed at /);
  assert.equal(f.button('Read firmness').disabled, false);
  assert.equal(f.button('Stop').hidden, true);
  f.app.destroy();
});

for (const [label, change] of changes) {
  test(`completed readings clear after ${label}`, async () => {
    const f = fixture();
    await f.app.read(); change(f);
    assert.equal(f.result.children.length, 0);
    assert.equal(f.status.textContent, '');
    f.app.destroy();
  });
}

for (const stage of ['ensure', 'read']) {
  for (const failed of [false, true]) {
    test(`late ${stage} ${failed ? 'errors' : 'results'} stay cleared after scope changes`, async () => {
      for (const [, change] of changes) {
        const f = fixture(), pending = deferred();
        if (stage === 'ensure') f.ensureWith(() => pending.promise);
        else f.readWith(() => pending.promise);
        const operation = f.app.read(); await flush(); change(f);
        if (failed) pending.reject(new Error('Old MCR read failed.'));
        else pending.resolve(stage === 'ensure' ? ready() : result);
        assert.equal(await operation, undefined);
        assert.equal(f.result.children.length, 0);
        assert.equal(f.status.textContent, '');
        assert.ok(f.stops.includes('MCR read stopped. Reconnect before retrying.'));
        assert.equal(f.button('Stop').hidden, true);
        f.app.destroy();
      }
    });
  }
}

test('a selection changed without an event is checked before publishing the read', async () => {
  const f = fixture(), pending = deferred();
  f.readWith(() => pending.promise);
  const operation = f.app.read(); await flush();
  f.select({ ...device, addressType: 1 }, false); pending.resolve(result);
  assert.equal(await operation, undefined);
  assert.equal(f.result.children.length, 0);
  assert.equal(f.status.textContent, '');
  f.app.destroy();
});

test('ordinary updates and equivalent selected devices preserve pending and completed reads', async () => {
  const f = fixture(), pending = deferred();
  f.readWith(() => pending.promise);
  const operation = f.app.read(); await flush();
  f.select({ ...device, address: device.address.toUpperCase() });
  f.update(ready({ busy: true, operation: 'write' })); f.busy(true);
  assert.equal(f.status.textContent, 'Reading the MCR bed…');
  assert.equal(f.stops.length, 0);
  f.update(ready()); f.busy(false); pending.resolve(result);
  assert.equal(await operation, result);
  const status = f.status.textContent;
  f.update(ready({ mtu: 247 })); f.busy(true); f.busy(false); f.select({ ...device });
  assert.equal(f.result.children.length, 2);
  assert.equal(f.status.textContent, status);
  f.app.destroy();
});

for (const initial of [ready({ connected: false }), ready({ address: '00:11:22:33:44:55' }), ready({ addressType: 1 })]) {
  test(`ensure can establish the selected bed from ${JSON.stringify(initial.ble)}`, async () => {
    const f = fixture(initial);
    f.ensureWith(async target => {
      f.select({ ...target });
      f.update(ready({ ...initial.ble, connected: false }));
      f.update(ready({ connected: false, connectionAttempt: 8, busy: true, operation: 'connecting' }));
      f.update(ready({ connectionAttempt: 8, busy: true, operation: 'discovering' }));
      f.update(ready({ connectionAttempt: 8 }));
      return ready({ connectionAttempt: 8 });
    });
    assert.equal(await f.app.read(), result);
    assert.equal(f.result.children.length, 2);
    assert.match(f.status.textContent, /^Read completed at /);
    assert.equal(f.stops.length, 0);
    f.app.destroy();
  });
}

for (const stage of ['ensure', 'read']) {
  for (const failed of [false, true]) {
    test(`destroy during ${stage} blocks a late ${failed ? 'error' : 'result'} and removes listeners`, async () => {
      const f = fixture(), pending = deferred();
      if (stage === 'ensure') f.ensureWith(() => pending.promise);
      else f.readWith(() => pending.promise);
      const operation = f.app.read(); await flush();
      const before = [f.status.textContent, f.button('Read firmness').disabled, f.button('Stop').hidden];
      f.app.destroy(); f.app.destroy();
      assert.equal(f.listenerCount(), 0);
      f.apiChange(); f.update(ready({ connectionAttempt: 8 })); f.select({ ...device, addressType: 1 });
      if (failed) pending.reject(new Error('Closed MCR read failed.'));
      else pending.resolve(stage === 'ensure' ? ready() : result);
      assert.equal(await operation, undefined);
      assert.deepEqual([f.status.textContent, f.button('Read firmness').disabled, f.button('Stop').hidden], before);
      assert.equal(f.result.children.length, 0);
      assert.equal(await f.app.read(), undefined);
      assert.equal(f.calls.length, 1);
      assert.equal(f.closed, 1);
    });
  }
}

test('Stop keeps the current read error visible', async () => {
  const f = fixture(), pending = deferred();
  f.readWith(() => pending.promise);
  const operation = f.app.read(); await flush();
  f.button('Stop').handlers.click();
  pending.reject(new Error(f.stops.at(-1))); await operation;
  assert.equal(f.status.textContent, 'MCR read stopped. Reconnect before retrying.');
  assert.equal(f.result.children.length, 0);
  assert.equal(f.button('Stop').hidden, true);
  f.app.destroy();
});
