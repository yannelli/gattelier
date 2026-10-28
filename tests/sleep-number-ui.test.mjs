import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const p = createRequire(import.meta.url)('../web/sleep-number-protocol.js');
const source = readFileSync(new URL('../web/sleep-number.js', import.meta.url), 'utf8');
const session = '00112233445566778899aabbccddeeff';
const privacy = '66557a496f4e19000000504153533a616374697665bcd2058b';
const device = { address: 'aa:bb:cc:dd:ee:ff', addressType: 1, services: [p.SERVICE] };
const ready = (ble = {}) => ({
  ble: { ...device, connected: true, connectionAttempt: 1, mtu: 23, ...ble },
  services: [{ uuid: p.SERVICE, characteristics: [
    { uuid: p.AUTH, handle: 10, properties: ['read'] },
    { uuid: p.BAMKEY, handle: 12, properties: ['read', 'notify', 'write-no-response'] },
  ] }],
});
const flush = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(initial = ready()) {
  const elements = [], listeners = new Map(), globalListeners = new Map(), timers = new Map(), calls = [], fast = [];
  let current = initial, selected = device, endpoint = 'A', stateListener, eventListener, seq = 0, timerId = 0;
  let ensure = async () => current, action = async () => {};
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
  const update = (next, available = true) => { current = next; stateListener(next, available); };
  const emit = event => {
    const entry = { address: current.ble.address, addressType: current.ble.addressType, connectionAttempt: current.ble.connectionAttempt, success: true, ...event, seq: ++seq };
    eventListener([entry], { bootId: 1, cursor: seq });
  };
  globalListeners.set('nanoscope:api-change', [() => update({ ble: {}, services: [] }, false)]);
  const context = vm.createContext({
    NanoSleepProtocol: p,
    NanoConnection: { snapshot: () => ({ state: current, selected }), ensure: target => ensure(target) },
    document: { createElement, addEventListener(type, callback) { listeners.set(type, callback); } },
    addEventListener(type, callback) {
      if (!globalListeners.has(type)) globalListeners.set(type, []);
      globalListeners.get(type).push(callback);
    },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(source + '\nglobalThis.sleep = NanoSleep;', context);
  const container = createElement('section');
  context.sleep.mount(container, {
    isActing: () => false,
    setFastCapture(enabled) { fast.push(enabled); },
    onState(callback) { stateListener = callback; callback(current, true); },
    onEvents(callback) { eventListener = callback; },
    async action(path, data) { calls.push({ path, data, endpoint, attempt: current.ble.connectionAttempt }); return action(path, data); },
  });
  const button = label => elements.find(element => element.tag === 'button' && element.textContent === label);
  const result = elements.find(element => element.tag === 'dl');
  const status = elements.find(element => element.tag === 'p');
  return {
    calls, fast, timers, result, status, button, emit, update,
    start() { button('Read privacy state').handlers.click(); },
    stop() { button('Stop query').handlers.click(); },
    ensureWith(callback) { ensure = callback; },
    actionWith(callback) { action = callback; },
    reply(path, data) {
      if (path === 'read') emit({ kind: 'read', handle: data.handle, hex: data.handle === 10 ? session : privacy });
      if (path === 'write') {
        emit({ kind: 'write', handle: data.handle, hex: data.hex });
        emit({ kind: 'notification', handle: data.handle, hex: session });
      }
    },
    change(next = ready(), target = 'B') {
      endpoint = target; seq = 0;
      for (const callback of globalListeners.get('nanoscope:api-change')) callback();
      update(next);
    },
    select(next) { selected = next; listeners.get('nanoscope:selection')(); },
  };
}

test('retained packets from another address type or attempt cannot satisfy or interrupt a Fuzion query', async () => {
  for (const scope of [{ addressType: 0 }, { connectionAttempt: 0 }]) {
    const f = fixture();
    f.actionWith((path, body) => {
      f.emit({ kind: 'disconnect', ...scope });
      f.emit({ kind: 'read', handle: body.handle, hex: '00', success: false, truncated: true, ...scope });
      f.reply(path, body);
    });
    f.start(); await flush();
    assert.match(f.status.textContent, /Metadata verified/); assert.equal(f.result.children.length, 1);
    assert.equal(f.timers.size, 0);
  }
});

for (const replacement of [{ connectionAttempt: 2 }, { addressType: 0 }]) {
  test(`a delayed Auth read stops after same-MAC replacement ${JSON.stringify(replacement)}`, async () => {
    const f = fixture(), pending = deferred();
    f.actionWith(() => pending.promise);
    f.start(); await flush();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].data.handle, 10);
    f.update(ready(replacement));
    f.emit({ kind: 'read', handle: 10, hex: session });
    pending.resolve(); await flush();
    assert.deepEqual(f.calls.map(call => call.path), ['read']);
    assert.equal(f.status.textContent, 'Sleep Number connection changed.');
    assert.equal(f.result.children.length, 0);
    assert.deepEqual(f.fast, [true, false]);
    assert.equal(f.timers.size, 0);
  });
}

test('ordinary state updates preserve the pending query and its reply timeout', async () => {
  const f = fixture();
  f.start(); await flush();
  assert.deepEqual([...f.timers.values()].map(timer => timer.delay), [12000]);
  f.update(ready({ busy: true, operation: 'read' }));
  f.emit({ kind: 'read', handle: 10, hex: session });
  await flush();
  assert.deepEqual(f.calls.map(call => call.path), ['read', 'subscribe', 'write']);
  assert.equal(f.button('Stop query').hidden, false);
  f.stop(); await flush();
  assert.equal(f.status.textContent, 'Metadata query stopped.');
  assert.equal(f.timers.size, 0);
});

for (const failed of [false, true]) {
  test(`an endpoint change blocks late connection setup ${failed ? 'failure' : 'success'}`, async () => {
    const f = fixture(), pending = deferred(), old = ready();
    f.ensureWith(() => pending.promise);
    f.start(); f.change(ready({ connectionAttempt: 7 }));
    if (failed) pending.reject(new Error('Old endpoint failed.')); else pending.resolve(old);
    await flush();
    assert.equal(f.calls.length, 0);
    assert.equal(f.status.textContent, 'Sleep Number connection changed.');
    assert.equal(f.result.children.length, 0);
    assert.equal(f.button('Stop query').hidden, true);
    assert.deepEqual(f.fast, [true, false]);
    assert.equal(f.timers.size, 0);
  });
}

test('an endpoint change cancels a pending reply and resets the capture cursor for the next board', async () => {
  const f = fixture();
  for (let count = 0; count < 20; count++) f.emit({ kind: 'notification', handle: 1, hex: '' });
  f.start(); await flush();
  f.change(); await flush();
  assert.equal(f.timers.size, 0);
  f.actionWith((path, data) => f.reply(path, data));
  f.start(); await flush();
  assert.match(f.status.textContent, /^Metadata verified at /);
  assert.equal(f.result.children[0].children[1].textContent, 'active');
  assert.deepEqual(f.calls.map(call => call.endpoint), ['A', 'B', 'B', 'B', 'B']);
  assert.equal(f.timers.size, 0);
});

for (const kind of ['stop', 'selection', 'replacement']) {
  test(`late connection setup respects ${kind} cancellation`, async () => {
    const f = fixture(), pending = deferred();
    f.ensureWith(() => pending.promise);
    f.start();
    if (kind === 'stop') f.stop();
    else if (kind === 'selection') f.select({ ...device, address: '11:22:33:44:55:66' });
    else f.update(ready({ connectionAttempt: 2 }));
    pending.resolve(ready()); await flush();
    assert.equal(f.calls.length, 0);
    assert.equal(f.button('Stop query').hidden, true);
    assert.equal(f.timers.size, 0);
  });
}

test('connecting the selected bed still completes a metadata query', async () => {
  const f = fixture(ready({ connected: false }));
  f.ensureWith(async () => { f.select({ ...device }); const state = ready({ connectionAttempt: 2 }); f.update(state); return state; });
  f.actionWith((path, data) => f.reply(path, data));
  f.start(); await flush();
  assert.match(f.status.textContent, /^Metadata verified at /);
  assert.equal(f.result.children[0].children[1].textContent, 'active');
  assert.deepEqual(f.calls.map(call => call.path), ['read', 'subscribe', 'write', 'read']);
  assert.deepEqual(f.fast, [true, false]);
  assert.equal(f.timers.size, 0);
});
