import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const ready = { ble: { busy: false, connected: false }, devices: [], services: [] };
const target = { address: 'AA:BB:CC:DD:EE:FF', addressType: 0 };
const busy = { ...ready, ble: { ...target, busy: true, connected: false, operation: 'discovering', connectionAttempt: 42 } };
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const flush = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(respond) {
  const calls = [], events = [], ingested = [], traffic = [], timers = new Map(), handlers = {};
  let nextTimer = 0, captureId = 0;
  const context = vm.createContext({ console, AbortController,
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    NanoPackets: { createCapture() { const id = ++captureId; return {
      snapshot: () => ({ nextSeq: 0 }), ingest(body) { ingested.push({ id, body }); return { events: body.events || [], meta: {} }; },
    }; } },
    NanoConsole: { update() {}, mount() {} }, NanoTraffic: { mount() {}, connection: value => traffic.push(value), refresh() {} },
    document: { hidden: false, getElementById() {}, addEventListener() {}, dispatchEvent: event => events.push(event) },
    addEventListener: (type, callback) => { handlers[type] = callback; },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    NanoAPI: { async fetch(path, options) { calls.push({ path, options }); return await respond(path, options); } },
  });
  vm.runInContext(readFileSync(new URL('../web/lab.js', import.meta.url), 'utf8'), context);
  const lab = context.NanoLab;
  lab.init(); lab.update(ready, true);
  return { lab, calls, events, ingested, traffic, timers, change: () => handlers['nanoscope:api-change'](),
    runTimer(delay) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `Missing ${delay}ms timer`);
      timers.delete(entry[0]); entry[1].callback();
    } };
}

test('transport change stops sleeping actions without clearing a newer action busy state', async () => {
  const write = deferred();
  let reads = 0;
  const f = fixture(path => path === 'write' ? write.promise : path === 'state' ? response(++reads === 1 ? busy : ready) : response({}, path === 'connect' ? 202 : 200));
  const old = f.lab.action('connect', target);
  const rejected = assert.rejects(old, { name: 'AbortError' });
  await flush();
  f.change(); f.lab.update(ready, true);
  const current = f.lab.action('write', { handle: 8, hex: '00' });
  const start = f.calls.length, eventStart = f.events.length;
  f.runTimer(120);
  await rejected;
  assert.equal(f.calls.length, start);
  assert.equal(f.lab.isActing(), true);
  assert.equal(f.events.slice(eventStart).filter(event => event.type === 'nanoscope:busy').length, 0);
  write.resolve(response({}, 202));
  await current;
  assert.equal(f.lab.isActing(), false);
});

test('transport change rejects cancellation waiting for the old connect acceptance', async () => {
  const accepted = deferred();
  const f = fixture(path => path === 'connect' ? accepted.promise : response({}));
  const old = assert.rejects(f.lab.action('connect', target), { name: 'AbortError' });
  const cancel = assert.rejects(f.lab.action('cancel-connect', target), { name: 'AbortError' });
  f.change();
  accepted.resolve(response({ ...target, connectionAttempt: 42 }, 202));
  await Promise.all([old, cancel]);
  assert.equal(f.calls.some(call => call.path === 'cancel-connect' || call.path === 'state'), false);
  assert.equal(f.events.some(event => event.type === 'nanoscope:state'), false);
});

test('old cancellation response cannot query or publish state after transport change', async () => {
  const cancellation = deferred();
  const f = fixture(path => path === 'cancel-connect' ? cancellation.promise : response({}));
  f.lab.update(busy, true);
  const rejected = assert.rejects(f.lab.action('cancel-connect', { ...target, connectionAttempt: 42 }), { name: 'AbortError' });
  f.change();
  cancellation.resolve(response({}, 202));
  await rejected;
  assert.equal(f.calls.some(call => call.path === 'state'), false);
  assert.equal(f.events.some(event => event.type === 'nanoscope:state'), false);
});

test('old event response cannot enter the new capture or release its pending request', async () => {
  const old = deferred(), current = deferred();
  let requests = 0;
  const f = fixture(() => (++requests === 1 ? old.promise : current.promise));
  f.change();
  old.resolve(response({ events: [{ seq: 99 }] }));
  await flush();
  assert.equal(f.ingested.length, 0);
  assert.equal(f.traffic.length, 0);
  f.lab.setFastCapture(true);
  assert.equal([...f.timers.values()].some(timer => timer.delay === 0), false);
  current.resolve(response({ events: [{ seq: 1 }] }));
  await flush();
  assert.equal(f.ingested.length, 1);
  assert.equal(f.ingested[0].id, 2);
  assert.equal(f.ingested[0].body.events[0].seq, 1);
  assert.equal([...f.timers.values()].filter(timer => timer.delay === 100).length, 1);
});

const connected = (ble = {}) => ({ ...ready, ble: { ...target, connected: true, busy: false, connectionAttempt: 42, ...ble } });
const connectionAbort = { name: 'AbortError', message: 'Bluetooth connection changed.', code: 'BLE_CONNECTION_CHANGED' };

for (const [path, boundary, change, available, settlement] of [
  ['read', 'state', { address: '11:22:33:44:55:66' }, true, 'resolve'],
  ['write', 'post', { addressType: 1 }, true, 'reject'],
  ['subscribe', 'post-json', { connectionAttempt: 43 }, true, 'resolve'],
  ['read', 'post-json', {}, false, 'reject'],
  ['write', 'state', { connectionAttempt: 43 }, true, 'reject'],
  ['subscribe', 'state-json', { connected: false }, true, 'resolve'],
  ['read', 'state-json', { addressType: 1 }, true, 'reject'],
  ['write', 'post', { connectionAttempt: 43 }, true, 'resolve'],
  ['subscribe', 'sleep', { connectionAttempt: 43 }, true, 'resolve'],
  ['read', 'sleep', {}, false, 'resolve'],
  ['read', 'state', { connectionAttempt: 43, busy: true }, true, 'resolve'],
]) test(`${path} revokes ownership during ${boundary}: ${settlement}, ${JSON.stringify(change)}, online=${available}`, async () => {
  const pending = deferred(), fresh = deferred(), initial = connected(), next = connected(change), observed = [];
  let replacing = false;
  const f = fixture(request => {
    if (request.startsWith('events?')) return response({});
    if (replacing) return request === 'state' ? response(next) : fresh.promise;
    if (request === 'state') {
      if (boundary === 'state') return pending.promise;
      if (boundary === 'state-json') return { ...response(initial), json: () => pending.promise };
      return response(connected({ busy: true }));
    }
    if (boundary === 'post') return pending.promise;
    if (boundary === 'post-json') return { ...response({}, 202), json: () => pending.promise };
    return response({}, 202);
  });
  f.lab.update(initial, true);
  f.lab.onState((state, online) => observed.push({ state, online }));
  const rejected = assert.rejects(f.lab.action(path, { handle: 8, hex: '00', enabled: true }), connectionAbort);
  await flush();
  assert.equal(f.lab.isActing(), true);
  assert.equal(f.calls.filter(call => call.path === 'state').length, boundary.startsWith('state') || boundary === 'sleep' ? 1 : 0);
  f.lab.update(next, available);
  assert.equal(f.lab.isActing(), false);
  assert.strictEqual(f.lab.getState(), next);
  assert.deepEqual(f.events.filter(event => event.type === 'nanoscope:busy').map(event => event.detail), [true, false]);
  let current;
  if (available && !next.ble.busy) {
    replacing = true;
    current = f.lab.action('read', { handle: 9 });
    assert.equal(f.lab.isActing(), true);
  } else {
    await assert.rejects(f.lab.action('read', { handle: 9 }), {
      message: available ? 'Wait for the current BLE operation to finish.' : 'The board is unavailable.',
    });
  }
  const callStart = f.calls.length, eventStart = f.events.length, stateStart = observed.length;
  if (boundary === 'sleep') f.runTimer(120);
  else if (settlement === 'reject') pending.reject(new Error('Old request failed.'));
  else {
    const body = boundary.startsWith('post') ? {} : initial;
    pending.resolve(boundary.endsWith('json') ? body : response(body, boundary === 'post' ? 202 : 200));
  }
  await rejected;
  assert.equal(f.calls.length, callStart);
  assert.equal(observed.length, stateStart);
  assert.strictEqual(f.lab.getState(), next);
  assert.equal(f.lab.isActing(), Boolean(current));
  assert.equal(f.events.slice(eventStart).filter(event => ['nanoscope:state', 'nanoscope:busy'].includes(event.type)).length, 0);
  if (current) {
    fresh.resolve(response({}, 202));
    assert.strictEqual(await current, next);
    assert.equal(f.lab.isActing(), false);
  }
});

for (const path of ['read', 'write', 'subscribe']) test(`${path} survives MAC casing and value-only refreshes`, async () => {
  const accepted = deferred(), recased = connected({ address: target.address.toLowerCase() });
  const refreshed = { ...recased, services: [{ characteristics: [{ handle: 8, hex: '02' }] }] };
  const f = fixture(request => request === path ? accepted.promise : response(request === 'state' ? refreshed : {}));
  f.lab.update(connected(), true);
  const current = f.lab.action(path, { handle: 8 });
  f.lab.update(recased, true);
  assert.equal(f.lab.isActing(), true);
  f.lab.update(refreshed, true);
  assert.equal(f.lab.isActing(), true);
  assert.deepEqual(f.events.filter(event => event.type === 'nanoscope:busy').map(event => event.detail), [true]);
  accepted.resolve(response({}, 202));
  assert.strictEqual(await current, refreshed);
  assert.strictEqual(f.lab.getState(), refreshed);
  assert.equal(f.lab.isActing(), false);
});

for (const [path, boardBusy] of [['read', false], ['subscribe', true]]) {
  test(`${path} publishes a newly observed connection before rejecting, busy=${boardBusy}`, async () => {
    const next = connected({ addressType: 1, connectionAttempt: 43, busy: boardBusy }), order = [];
    const f = fixture(request => response(request === 'state' ? next : {}, request === path ? 202 : 200));
    f.lab.update(connected(), true);
    f.lab.onState(state => { if (state === next) order.push('state'); });
    const current = f.lab.action(path, { handle: 8 }).catch(error => { order.push('rejected'); throw error; });
    await assert.rejects(current, connectionAbort);
    assert.deepEqual(order, ['state', 'rejected']);
    assert.strictEqual(f.lab.getState(), next);
    assert.equal(f.lab.isActing(), false);
    const states = f.events.filter(event => event.type === 'nanoscope:state');
    assert.equal(states.length, 1);
    assert.strictEqual(states[0].detail, next);
    assert.deepEqual(f.events.filter(event => event.type === 'nanoscope:busy').map(event => event.detail), [true, false]);
    assert.equal(f.calls.filter(call => call.path === 'state').length, 1);
    assert.equal([...f.timers.values()].some(timer => timer.delay === 120), false);
  });
}

for (const path of ['connect', 'disconnect']) test(`${path} allows its intentional connection transitions`, async () => {
  const accepted = deferred(), scope = path === 'connect' ? { addressType: 1, connectionAttempt: 43 } : {};
  const transitioning = connected({ ...scope, connected: path === 'disconnect', busy: true, operation: path === 'connect' ? 'connecting' : 'disconnecting' });
  const final = path === 'connect' ? connected(scope) : ready;
  let reads = 0;
  const f = fixture(request => request === path ? accepted.promise : response(request === 'state' ? ++reads === 1 ? transitioning : final : {}));
  f.lab.update(path === 'connect' ? ready : connected(), true);
  const current = f.lab.action(path, path === 'connect' ? { ...target, ...scope } : {});
  f.lab.update(transitioning, true);
  assert.equal(f.lab.isActing(), true);
  accepted.resolve(response({ ...target, ...scope }, 202));
  await flush();
  f.lab.update(final, true);
  assert.equal(f.lab.isActing(), true);
  f.runTimer(120);
  assert.strictEqual(await current, final);
  assert.strictEqual(f.lab.getState(), final);
  assert.equal(f.lab.isActing(), false);
  assert.deepEqual(f.events.filter(event => event.type === 'nanoscope:busy').map(event => event.detail), [true, false]);
});

test('a state listener starts fresh work without stale update or finally busy events', async () => {
  const oldState = deferred(), accepted = deferred(), initial = connected(), next = connected({ addressType: 1, connectionAttempt: 43 });
  let reads = 0, current;
  const f = fixture(request => request === 'write' ? accepted.promise : request === 'state' ? ++reads === 1 ? oldState.promise : response(next) : response({}, 202));
  f.lab.update(initial, true);
  const rejected = assert.rejects(f.lab.action('read', { handle: 8 }), connectionAbort);
  await flush();
  f.lab.onState(state => { if (state === next && !current) current = f.lab.action('write', { handle: 9, hex: '01' }); });
  const eventStart = f.events.length;
  f.lab.update(next, true);
  assert.ok(current);
  assert.equal(f.lab.isActing(), true);
  assert.deepEqual(f.events.slice(eventStart).filter(event => event.type === 'nanoscope:busy').map(event => event.detail), [true]);
  const callStart = f.calls.length, staleEventStart = f.events.length;
  oldState.resolve(response(initial));
  await rejected;
  assert.equal(f.calls.length, callStart);
  assert.equal(f.events.length, staleEventStart);
  assert.strictEqual(f.lab.getState(), next);
  assert.equal(f.lab.isActing(), true);
  accepted.resolve(response({}, 202));
  assert.strictEqual(await current, next);
  assert.equal(f.lab.isActing(), false);
  assert.deepEqual(f.events.slice(eventStart).filter(event => event.type === 'nanoscope:busy').map(event => event.detail), [true, false]);
});

for (const path of ['read', 'write', 'subscribe']) test(`${path} sends its captured typed peer with the GATT handle`, async () => {
  for (const addressType of [0, 1]) {
    const state = connected({ addressType, connectionAttempt: 0xffffffff });
    const payload = path === 'write' ? { handle: 8, hex: 'ff'.repeat(512), response: true }
      : path === 'subscribe' ? { handle: 8, mode: 'indicate' } : { handle: 8 };
    const f = fixture(request => response(request === 'state' ? state : {}, request === path ? 202 : 200));
    f.lab.update(state, true);
    await f.lab.action(path, { ...payload, address: '11:22:33:44:55:66', addressType: 3, connectionAttempt: 1 });
    const request = f.calls.find(call => call.path === path).options;
    assert.deepEqual(JSON.parse(request.body), { ...payload, address: target.address.toLowerCase(), addressType, connectionAttempt: 0xffffffff });
    assert.ok(Buffer.byteLength(request.body) < 1400);
  }
});

test('GATT requests keep legacy payloads when the board has no connection attempt metadata', async () => {
  const legacy = { ...ready, ble: { ...target, connected: true, busy: false } }, payload = { handle: 8 };
  const f = fixture(request => response(request === 'state' ? legacy : {}, request === 'read' ? 202 : 200));
  f.lab.update(legacy, true);
  await f.lab.action('read', payload);
  assert.deepEqual(JSON.parse(f.calls.find(call => call.path === 'read').options.body), payload);
});
